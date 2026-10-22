import "./env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Conversations, type Workplace } from "../src/chat/conversations.ts";
import { Routines } from "../src/routines/routines.ts";
import { MemoryService } from "../src/memory/memory.ts";
import type { Bot } from "../src/bots/bots.ts";
import type { Hands } from "../src/hands/types.ts";
import { FakeProvider, sleep, type Step } from "./fake.ts";

// Tests in this file share one data dir, so every test gets fresh bot ids.
let run = 0;
const ids = () => { run++; return { a: `a${run}`, b: `b${run}` }; };
const mkBot = (id: string, name: string, role = ""): Bot =>
  ({ id, name, role, instructions: "", provider: "fake", model: "fake-1", avatarSeed: "s", createdAt: new Date().toISOString() });

/** A device that records actions and returns a 1×1 PNG as its screen. */
class FakeHands implements Hands {
  actions: string[] = [];
  describe() { return "Fake device"; }
  async screenshot() {
    return { png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", width: 1, height: 1 };
  }
  async act(tool: string, args: Record<string, unknown>) { this.actions.push(`${tool} ${JSON.stringify(args)}`); return { effect: "ok" }; }
  async shell(command: string) { this.actions.push(`shell ${command}`); return { code: 0, output: "hello\n" }; }
}

/** Scripts are keyed "a"/"b"; they map to this test's fresh bot ids. */
function setup(scripts: Record<string, Step[]>, opts: { hands?: Hands; names?: [string, string?]; roles?: [string, string?] } = {}) {
  const events: { event: string; data: any }[] = [];
  const id = ids();
  const [na, nb] = opts.names ?? ["Alice", "Bob"];
  const [ra, rb] = opts.roles ?? ["", ""];
  const bots = [mkBot(id.a, na, ra), ...(nb ? [mkBot(id.b, nb, rb)] : [])];
  const fakes: Record<string, FakeProvider> = Object.fromEntries(
    Object.entries(scripts).map(([k, s]) => [k === "a" ? id.a : id.b, new FakeProvider(s)]),
  );
  const workplace = async (): Promise<Workplace | null> => (opts.hands ? { hands: opts.hands, computerName: "Linux" } : null);
  const conv = new Conversations((event, data) => events.push({ event, data }), workplace, () => bots, (bot) => fakes[bot.id]);
  return { conv, events, fakes: { a: fakes[id.a], b: fakes[id.b] }, bots, id };
}

/** Resolves once every bot is idle again. */
async function settle(conv: Conversations, bots: Bot[]) {
  await sleep(20);
  for (let i = 0; i < 500 && bots.some((b) => conv.isBusy(b.id)); i++) await sleep(10);
}

test("a plain reply is streamed and saved", async () => {
  const { conv, events, bots, id } = setup({ a: [{ text: "Olá!" }] });
  await conv.send(bots[0], "oi");
  await settle(conv, bots);
  const saved = conv.history(id.a);
  assert.deepEqual(saved.map((m) => [m.role, m.text]), [["user", "oi"], ["assistant", "Olá!"]]);
  assert.ok(events.some((e) => e.event === "message.delta" && e.data.delta === "Olá!"));
  assert.ok(events.some((e) => e.event === "bot.status" && e.data.status === "idle"));
});

test("device tools act on the device and a fresh screenshot follows", async () => {
  const hands = new FakeHands();
  const { conv, fakes, bots, id } = setup({
    a: [{ tools: [{ name: "click", args: { x: 10, y: 20 } }] }, { text: "Cliquei." }],
  }, { hands });
  await conv.send(bots[0], "clica ali");
  await settle(conv, bots);
  assert.equal(hands.actions.length, 1);
  assert.match(hands.actions[0], /^click /);
  assert.ok(conv.history(id.a).some((m) => m.role === "activity" && m.text === "Clicked at (10, 20)"));
  const second = fakes.a.requests[1].messages;
  assert.ok(second.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")));
});

test("without a device, device tools aren't offered", async () => {
  const { conv, fakes, bots } = setup({ a: [{ text: "ok" }] });
  await conv.send(bots[0], "oi");
  await settle(conv, bots);
  const names = (fakes.a.requests[0].tools ?? []).map((t) => t.name);
  assert.ok(!names.includes("click"));
});

test("provider errors become plain-language messages with details kept", async () => {
  const { conv, fakes, bots, id } = setup({ a: [] });
  fakes.a.chat = async () => { throw new Error("OpenRouter returned 401: invalid api key"); };
  await conv.send(bots[0], "oi");
  await settle(conv, bots);
  const reply = conv.history(id.a).find((m) => m.role === "assistant")!;
  assert.match(reply.error!, /rejected the API key/);
  assert.match(reply.detail!, /401/);
});

test("ask_bot runs in the teammate's chat and returns its answer", async () => {
  const { conv, fakes, bots, id } = setup({
    a: [{ tools: [{ name: "ask_bot", args: { bot: "Matemático", message: "17 x 23?" } }] }, { text: "Deu 391." }],
    b: [{ text: "391" }],
  }, { names: ["Chefe", "Matemático"], roles: ["Coordena", "Contas"] });
  await conv.send(bots[0], "pergunta pro matemático");
  await settle(conv, bots);
  assert.deepEqual(conv.history(id.b).map((m) => [m.role, m.text, m.from?.name]), [["user", "17 x 23?", "Chefe"], ["assistant", "391", undefined]]);
  const toolResult = fakes.a.requests[1].messages.find((m) => m.role === "tool")!;
  assert.match(String(toolResult.content), /Matemático replied:\n391/);
  assert.ok(conv.history(id.a).some((m) => m.text.startsWith("Asked Matemático")));
});

test("ask_bot can't loop back to someone already in the chain", async () => {
  const { conv, fakes, bots, id } = setup({
    a: [{ tools: [{ name: "ask_bot", args: { bot: "Matemático", message: "pergunte ao Chefe" } }] }, { text: "fim" }],
    b: [(req) => ({ text: (req.tools ?? []).some((t) => t.name === "ask_bot") ? "tenho ask_bot" : "sem ask_bot" })],
  }, { names: ["Chefe", "Matemático"] });
  await conv.send(bots[0], "teste");
  await settle(conv, bots);
  assert.equal(conv.history(id.b).find((m) => m.role === "assistant")!.text, "sem ask_bot");
  assert.ok(fakes.b.requests.length === 1);
});

test("bots create, list and delete their own routines", async () => {
  const { conv, fakes, bots, id } = setup({
    a: [
      { tools: [{ name: "create_routine", args: { name: "Resumo", task: "Resuma as notícias", schedule: { kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] } } }] },
      { text: "Criada." },
      { tools: [{ name: "delete_routine", args: { name: "resumo" } }] },
      { text: "Apagada." },
    ],
  });
  const routines = new Routines(async () => ({ ok: true }), () => false, () => {});
  conv.attachRoutines(routines);
  await conv.send(bots[0], "todo dia útil às 8h, resume as notícias");
  await settle(conv, bots);
  assert.equal(routines.list(id.a)[0].scheduleText, "Weekdays at 08:00");
  assert.match(String(fakes.a.requests[1].messages.find((m) => m.role === "tool")!.content), /Created routine "Resumo"/);
  await conv.send(bots[0], "cancela");
  await settle(conv, bots);
  assert.equal(routines.list(id.a).length, 0);
});

test("memory tools are offered and remember saves", async () => {
  const { conv, bots, id } = setup({ a: [{ tools: [{ name: "remember", args: { text: "Usuário prefere português" } }] }, { text: "Anotado." }] });
  const memory = new MemoryService(async () => '{"episode":null,"ops":[]}', () => {});
  conv.attachMemory(memory);
  await conv.send(bots[0], "fala comigo em português");
  await settle(conv, bots);
  assert.ok(memory.store.list(id.a).some((m) => m.text === "Usuário prefere português"));
  assert.ok(conv.history(id.a).some((m) => m.role === "activity" && m.text.startsWith("Remembered:")));
});

test("stop aborts a running bot", async () => {
  const { conv, fakes, bots, id } = setup({ a: [] });
  fakes.a.chat = (req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  await conv.send(bots[0], "demora");
  await sleep(30);
  assert.ok(conv.isBusy(id.a));
  conv.stop(id.a);
  await settle(conv, bots);
  assert.ok(!conv.isBusy(id.a));
});

test("a bot keeps working past many steps, and old tool outputs are shortened", async () => {
  class LongOutput extends FakeHands {
    override async shell(command: string) { this.actions.push(`shell ${command}`); return { code: 0, output: "x".repeat(2000) }; }
  }
  const hands = new LongOutput();
  const steps: Step[] = Array.from({ length: 45 }, (_, i) => ({ tools: [{ name: "shell", args: { command: `echo ${i}` } }] }));
  const { conv, fakes, bots, id } = setup({ a: [...steps, { text: "Pronto." }] }, { hands });
  await conv.send(bots[0], "faz tudo");
  await settle(conv, bots);
  assert.equal(hands.actions.length, 45);
  assert.equal(conv.history(id.a).at(-1)?.text, "Pronto.");
  const outputs = fakes.a.requests.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
  assert.equal(outputs.length, 45);
  assert.ok(outputs.slice(0, -20).every((o) => o.length < 400 && o.endsWith("(older output shortened)")));
  assert.ok(outputs.slice(-20).every((o) => o.length > 2000));
});

test("share_file copies files off the device into the chat, downloadable", async () => {
  const pdf = Buffer.alloc(9 * 1024 * 1024, 7); // spans several read chunks
  pdf.write("%PDF-1.7", 0);
  class FileHands extends FakeHands {
    override async shell(command: string) {
      if (command.includes("/home/cua/missing.pdf")) return { code: 1, output: "" };
      if (command.startsWith("test -f")) return { code: 0, output: `${pdf.length}\n` };
      const skip = Number(/skip=(\d+)/.exec(command)![1]), bs = Number(/bs=(\d+)/.exec(command)![1]);
      return { code: 0, output: pdf.subarray(skip * bs, (skip + 1) * bs).toString("base64") };
    }
  }
  const { conv, bots, id } = setup({
    a: [{ tools: [{ name: "share_file", args: { paths: ["/home/cua/report.pdf", "/home/cua/missing.pdf"] } }] }, { text: "Aqui está." }],
  }, { hands: new FileHands() });
  await conv.send(bots[0], "gera o pdf");
  await settle(conv, bots);
  const shared = conv.history(id.a).find((m) => m.files?.length);
  assert.equal(shared?.files?.length, 1);
  assert.equal(shared!.files![0].name, "report.pdf");
  assert.equal(shared!.files![0].mime, "application/pdf");
  assert.equal(shared!.files![0].size, pdf.length);
  assert.ok(conv.history(id.a).some((m) => m.role === "activity" && m.text === "Couldn’t share a file"));
  const file = conv.readFile(id.a, shared!.files![0].id) as { data: string };
  assert.ok(Buffer.from(file.data, "base64").equals(pdf));
  // On the same Mac the app reads it from disk instead.
  const { path } = conv.readFile(id.a, shared!.files![0].id, false) as { path: string };
  const { readFileSync } = await import("node:fs");
  assert.ok(readFileSync(path).equals(pdf));
  conv.clear(id.a);
  assert.throws(() => conv.readFile(id.a, shared!.files![0].id));
});

test("a bot uses tools from the MCP servers it has on", async () => {
  const { McpServers } = await import("../src/mcp/servers.ts");
  const { join } = await import("node:path");
  const mcp = new McpServers();
  const server = await mcp.add({ name: "Echo", transport: "stdio", command: process.execPath, args: [join(import.meta.dirname, "fixtures/mcp-echo.mjs")] });
  const { conv, fakes, bots, id } = setup({ a: [{ tools: [{ name: "echo__echo", args: { text: "from the bot" } }] }, { text: "Feito." }] });
  conv.attachMcp(mcp);
  bots[0].mcpServers = [server.id];
  await conv.send(bots[0], "usa o echo");
  await settle(conv, bots);
  const offered = fakes.a.requests[0].tools?.map((t) => t.name) ?? [];
  assert.ok(offered.includes("echo__echo"));
  const toolMsg = fakes.a.requests[1].messages.find((m) => m.role === "tool");
  assert.equal(toolMsg?.content, "echo: from the bot ()");
  assert.ok(conv.history(id.a).some((m) => m.role === "activity" && m.text === "Used Echo: echo"));
  await mcp.remove(server.id);
});

test("a bot asks to connect an app; once connected it continues on its own", async () => {
  const { McpServers } = await import("../src/mcp/servers.ts");
  const mcp = new McpServers();
  const { conv, fakes, bots, id } = setup({
    a: [
      { tools: [{ name: "suggest_connection", args: { connector: "notion", reason: "To save the notes" } }] },
      { text: "Conecta o Notion e eu continuo." },
      { text: "Salvei no Notion." },
    ],
  });
  conv.attachMcp(mcp);
  await conv.send(bots[0], "salva isso no Notion");
  await settle(conv, bots);

  // The bot was offered the catalog, and posted a Connect card.
  const offered = fakes.a.requests[0].tools?.find((t) => t.name === "suggest_connection");
  assert.ok((offered?.parameters as any).properties.connector.enum.includes("notion"));
  const card = conv.history(id.a).find((m) => m.connect)!;
  assert.deepEqual({ ...card.connect }, { connector: "notion", name: "Notion", description: "Search, read and write pages", mode: "connect", reason: "To save the notes", state: "pending" });

  // Signed in: the card flips and the bot picks the task back up.
  conv.connectorReady("notion");
  await settle(conv, bots);
  const after = conv.history(id.a);
  assert.equal(after.find((m) => m.id === card.id)?.connect?.state, "connected");
  const notice = after.find((m) => m.notice);
  assert.match(notice!.text, /Notion is connected/);
  assert.equal(after.at(-1)?.text, "Salvei no Notion.");
  // It saw its earlier ask and the notice in the history.
  const last = fakes.a.requests.at(-1)!.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  assert.match(last, /Asked the user to connect Notion: connected/);
  assert.match(last, /\[Local Bot\] Notion is connected now/);
});

test("files the user sends reach the device and the model sees images and text", async () => {
  const written = new Map<string, Buffer>();
  class DeviceDisk extends FakeHands {
    override async shell(command: string) {
      const pick = /n='([^']+)'; i=2/.exec(command);
      if (pick) { written.set(`/home/cua/Downloads/${pick[1]}`, Buffer.alloc(0)); return { code: 0, output: `/home/cua/Downloads/${pick[1]}` }; }
      const append = /printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d >> '([^']+)'/.exec(command);
      if (append) { written.set(append[2], Buffer.concat([written.get(append[2]) ?? Buffer.alloc(0), Buffer.from(append[1], "base64")])); return { code: 0, output: "" }; }
      return { code: 0, output: "" };
    }
  }
  const { conv, fakes, bots, id } = setup({ a: [{ text: "Vi a imagem." }] }, { hands: new DeviceDisk() });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  const files = [conv.files.save(id.a, "print.png", png), conv.files.save(id.a, "notes.txt", Buffer.from("comprar pão"))];
  await conv.send(bots[0], "o que tem aqui?", files);
  await settle(conv, bots);

  // On the device, byte for byte.
  assert.ok(written.get("/home/cua/Downloads/print.png")?.equals(png));
  assert.equal(written.get("/home/cua/Downloads/notes.txt")?.toString(), "comprar pão");
  // Stored with where they went.
  const sent = conv.history(id.a).find((m) => m.role === "user")!;
  assert.deepEqual(sent.files?.map((f) => f.devicePath), ["/home/cua/Downloads/print.png", "/home/cua/Downloads/notes.txt"]);
  // The model got the text, where the files are, the text file inline and the image.
  const user = fakes.a.requests[0].messages.filter((m) => m.role === "user").find((m) => Array.isArray(m.content) && (m.content as any[])[0]?.text?.includes("o que tem aqui?"))!;
  const parts = user.content as any[];
  assert.match(parts[0].text, /on your device at \/home\/cua\/Downloads\/print\.png/);
  assert.match(parts[0].text, /--- notes\.txt ---\ncomprar pão/);
  assert.ok(parts.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/png;base64,")));
});

/** A model whose first step waits until `release()`; later steps follow `script`. */
function gated(fake: FakeProvider, first: Step, script: Step[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen: string[] = [];
  let n = 0;
  fake.chat = async (req) => {
    seen.push(JSON.stringify(req.messages));
    const step = n++ === 0 ? (await gate, first) : script.shift() ?? { text: "(end)" };
    const turn = typeof step === "function" ? step(req) : step;
    if (turn.text) req.onDelta(turn.text);
    return { text: turn.text ?? "", toolCalls: (turn.tools ?? []).map((t, i) => ({ id: `c${n}-${i}`, name: t.name, arguments: JSON.stringify(t.args) })) };
  };
  return { release, seen };
}

test("a message sent while the bot works joins at its next step", async () => {
  const hands = new FakeHands();
  const { conv, fakes, bots, id, events } = setup({ a: [] }, { hands });
  const { release, seen } = gated(fakes.a, { tools: [{ name: "click", args: { x: 1, y: 2 } }] }, [{ text: "Feito, e pintei de azul." }]);
  await conv.send(bots[0], "abre o editor");
  await sleep(30);
  const sent = await conv.send(bots[0], "e pinta de azul");
  assert.equal((sent as any).queued, true);
  assert.equal(conv.history(id.a).find((m) => m.text === "e pinta de azul")?.queued, true);
  release();
  await settle(conv, bots);
  // The second step saw the new message, marked as sent mid-task.
  assert.match(seen[1], /while you were working[^"]*\\n?e pinta de azul/);
  assert.ok(!seen[0].includes("e pinta de azul"));
  // It's no longer waiting, and the turn ended once.
  assert.equal(conv.history(id.a).find((m) => m.text === "e pinta de azul")?.queued, undefined);
  assert.equal(events.filter((e) => e.event === "bot.status" && e.data.status === "idle").length, 1);
});

test("a message sent as the bot is answering makes it keep going", async () => {
  const { conv, fakes, bots, id } = setup({ a: [] });
  const { release, seen } = gated(fakes.a, { text: "Pronto." }, [{ text: "Também troquei o título." }]);
  await conv.send(bots[0], "arruma o texto");
  await sleep(30);
  await conv.send(bots[0], "e o título");
  release();
  await settle(conv, bots);
  assert.equal(seen.length, 2);
  assert.match(seen[1], /e o título/);
  assert.deepEqual(conv.history(id.a).map((m) => [m.role, m.text]), [
    ["user", "arruma o texto"], ["assistant", "Pronto."], ["user", "e o título"], ["assistant", "Também troquei o título."],
  ]);
});

test("a message queued when the turn is stopped starts the next turn", async () => {
  const { conv, fakes, bots, id } = setup({ a: [] });
  let calls = 0;
  fakes.a.chat = (req) => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    req.onDelta("Ok, outra coisa.");
    return Promise.resolve({ text: "Ok, outra coisa.", toolCalls: [] });
  };
  await conv.send(bots[0], "tarefa longa");
  await sleep(30);
  await conv.send(bots[0], "esquece, faz outra coisa");
  conv.stop(id.a);
  await settle(conv, bots);
  await sleep(30);
  await settle(conv, bots);
  assert.equal(calls, 2);
  assert.equal(conv.history(id.a).at(-1)?.text, "Ok, outra coisa.");
});
