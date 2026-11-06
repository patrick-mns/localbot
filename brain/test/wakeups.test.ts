import "./env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Conversations, isConnectionFailure } from "../src/chat/conversations.ts";
import { OpenAICompatibleProvider } from "../src/chat/openai-compatible.ts";
import { MAX_CHECKS, MAX_RECONNECTS, RECONNECT_MINUTES, Wakeups } from "../src/routines/wakeups.ts";
import type { Bot } from "../src/bots/bots.ts";
import type { Hands } from "../src/hands/types.ts";
import { FakeProvider, sleep, type Step } from "./fake.ts";

let run = 0;
const mkBot = (): Bot =>
  ({ id: `w${++run}`, name: "Alice", role: "", instructions: "", provider: "fake", model: "fake-1", avatarSeed: "s", createdAt: new Date().toISOString() });

function setup(script: Step[]) {
  const bot = mkBot();
  const fake = new FakeProvider(script);
  const conv = new Conversations(() => {}, async () => null, () => [bot], () => fake);
  const wakeups = new Wakeups((w) => conv.wake(bot, w), (id) => conv.isBusy(id), () => {});
  wakeups.reset(); // tests share one data dir
  conv.attachWakeups(wakeups);
  /** Fires the bot's wake-up as if its time had come. */
  const due = () => wakeups.tick(new Date(Date.now() + 25 * 60 * 60_000));
  return { bot, fake, conv, wakeups, due };
}

async function settle(conv: Conversations, bot: Bot) {
  await sleep(20);
  for (let i = 0; i < 500 && conv.isBusy(bot.id); i++) await sleep(10);
}

test("a bot sets a wake-up for itself mid-task", async () => {
  const { bot, conv, wakeups } = setup([
    { tools: [{ name: "schedule_wakeup", args: { minutes: 20, reason: "ver se o download terminou" } }] },
    { text: "Download começou; volto em 20 min." },
  ]);
  await conv.send(bot, "baixa o relatório");
  await settle(conv, bot);
  const w = wakeups.forBot(bot.id);
  assert.equal(w?.note, "ver se o download terminou");
  assert.ok(Math.abs(new Date(w!.at).getTime() - Date.now() - 20 * 60_000) < 5000);
  assert.ok(conv.history(bot.id).some((m) => m.role === "activity" && m.text.startsWith("Will wake up at")));
});

test("the quick look is cheap and can go back to sleep without a turn", async () => {
  const { bot, fake, conv, wakeups, due } = setup([{ tools: [{ name: "wake_sleep", args: { minutes: 15, reason: "ainda baixando" } }] }]);
  wakeups.set(bot.id, 20, "ver se o download terminou");
  await due();
  await settle(conv, bot);
  assert.equal(fake.requests.length, 1);
  const req = fake.requests[0];
  assert.equal(req.maxTokens, 300);
  assert.deepEqual(req.tools?.map((t) => t.name), ["wake_continue", "wake_sleep", "wake_done"]);
  assert.ok(req.messages.every((m) => typeof m.content === "string"), "no screenshots in the quick look");
  const next = wakeups.forBot(bot.id)!;
  assert.equal(next.note, "ainda baixando");
  assert.equal(next.checks, 1);
  assert.ok(!conv.history(bot.id).some((m) => m.role === "user"), "no turn started");
  assert.ok(conv.history(bot.id).some((m) => m.text.startsWith("Checked: not yet")));
});

test("when there's work, the wake-up starts a full turn labelled as a wake-up", async () => {
  const { bot, fake, conv, wakeups, due } = setup([
    { tools: [{ name: "wake_continue", args: { instructions: "abrir o relatório baixado e resumir" } }] },
    { text: "Resumo pronto." },
  ]);
  wakeups.set(bot.id, 20, "ver se o download terminou");
  await due();
  await settle(conv, bot);
  const prompt = conv.history(bot.id).find((m) => m.role === "user");
  assert.equal(prompt?.text, "abrir o relatório baixado e resumir");
  assert.deepEqual(prompt?.wakeup, { note: "ver se o download terminou" });
  assert.equal(fake.requests[1].maxTokens, undefined);
  assert.ok(fake.requests[1].tools?.some((t) => t.name === "schedule_wakeup"));
  assert.equal(conv.history(bot.id).at(-1)?.text, "Resumo pronto.");
  assert.equal(wakeups.forBot(bot.id), undefined);
});

test("done ends the chain quietly", async () => {
  const { bot, conv, wakeups, due } = setup([{ tools: [{ name: "wake_done", args: { note: "usuário já resolveu" } }] }]);
  wakeups.set(bot.id, 5, "lembrar o usuário");
  await due();
  await settle(conv, bot);
  assert.equal(wakeups.forBot(bot.id), undefined);
  assert.ok(!conv.history(bot.id).some((m) => m.role === "user"));
});

test("after too many looks in a row the bot works on it instead of sleeping again", async () => {
  const { bot, conv, wakeups, due } = setup([
    { tools: [{ name: "wake_sleep", args: { minutes: 10, reason: "ainda esperando" } }] },
    { text: "Ainda não chegou; aviso o usuário." },
  ]);
  wakeups.set(bot.id, 10, "esperar o e-mail", MAX_CHECKS - 1);
  await due();
  await settle(conv, bot);
  assert.equal(conv.history(bot.id).find((m) => m.role === "user")?.wakeup?.note, "esperar o e-mail");
});

test("stop cancels the wake-up; odd times or an empty reason are refused", async () => {
  const { bot, conv, wakeups } = setup([]);
  wakeups.set(bot.id, 10, "checar");
  conv.stop(bot.id);
  assert.equal(wakeups.forBot(bot.id), undefined);
  assert.throws(() => wakeups.set(bot.id, 0, "x"), /between/);
  assert.throws(() => wakeups.set(bot.id, 5, " "), /what to check/);
});

const offline = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND openrouter.ai"), { code: "ENOTFOUND" }) });
const cutOff: Step = () => { throw offline(); };

/** A model whose network can be pulled; the free check fails while it's out. */
class FlakyProvider extends FakeProvider {
  online = false;
  checks = 0;
  async models() {
    this.checks++;
    if (!this.online) throw offline();
    return super.models();
  }
}

class CountingHands implements Hands {
  actions: string[] = [];
  describe() { return "Fake device"; }
  async screenshot() { return { png: "AAAA", width: 1, height: 1 }; }
  async act(tool: string) { this.actions.push(tool); return { effect: "ok" }; }
  async shell() { return { code: 0, output: "" }; }
}

function flaky(script: Step[], hands?: Hands) {
  const bot = mkBot();
  const fake = new FlakyProvider(script);
  const place = hands ? { hands, computerName: "Linux" } : null;
  const conv = new Conversations(() => {}, async () => place, () => [bot], () => fake);
  const wakeups = new Wakeups((w) => conv.wake(bot, w), (id) => conv.isBusy(id), () => {});
  wakeups.reset();
  conv.attachWakeups(wakeups);
  const due = () => wakeups.tick(new Date(Date.now() + 25 * 60 * 60_000));
  return { bot, fake, conv, wakeups, due };
}

/** Waits until the turn stopped at the connection. */
async function untilWaiting(wakeups: Wakeups, bot: Bot) {
  for (let i = 0; i < 500 && !wakeups.forBot(bot.id)?.reconnect; i++) await sleep(5);
  assert.ok(wakeups.forBot(bot.id)?.reconnect, "waiting for the connection");
}

test("only network failures count as connection failures", () => {
  const code = (c: string) => Object.assign(new Error("x"), { code: c });
  const wrapped = (cause: Error) => new TypeError("fetch failed", { cause });
  for (const err of [
    new TypeError("fetch failed"), wrapped(code("ECONNREFUSED")), wrapped(code("ENOTFOUND")), wrapped(code("EAI_AGAIN")), wrapped(code("ECONNRESET")),
    wrapped(code("UND_ERR_CONNECT_TIMEOUT")), new TypeError("terminated", { cause: code("UND_ERR_SOCKET") }), code("ETIMEDOUT"),
    new Error("connect ECONNREFUSED 127.0.0.1:11434"), Object.assign(new Error("aborted due to timeout"), { name: "TimeoutError" }),
  ]) assert.equal(isConnectionFailure(err), true, String(err));
  for (const err of [
    new Error("OpenRouter returned 401: invalid api key"), new Error("OpenRouter returned 404: model not found"),
    new Error("OpenRouter doesn’t have enough credits for this right now."), new Error("OpenRouter returned 400: connection timeout in tool schema"),
    new Error("The model refused: network security topic"), new Error("Provider returned error"), new Error("Stopped"),
    Object.assign(new Error("aborted"), { name: "AbortError", code: 20 }),
    wrapped(new Error("unknown scheme")), wrapped(new Error("bad port")), wrapped(code("DEPTH_ZERO_SELF_SIGNED_CERT")),
  ]) assert.equal(isConnectionFailure(err), false, String(err));
});

test("a lost connection pauses the turn and it continues where it stopped", async () => {
  const hands = new CountingHands();
  const { bot, fake, conv, wakeups, due } = flaky([
    { tools: [{ name: "click", args: { x: 1, y: 2 } }] },
    (req) => { req.onDelta("Agora vou"); throw offline(); },
    { text: "Pronto." },
  ], hands);
  await conv.send(bot, "clica no botão");
  await untilWaiting(wakeups, bot);

  const waiting = wakeups.forBot(bot.id)!;
  assert.deepEqual(waiting.reconnect, { attempt: 1, turn: true });
  assert.match(waiting.note, /Waiting for the connection \(try 1 of 30\)/);
  assert.ok(Math.abs(new Date(waiting.at).getTime() - Date.now() - RECONNECT_MINUTES * 60_000) < 5000);
  assert.ok(conv.isBusy(bot.id), "the turn stays open, so Stop still applies");
  assert.ok(conv.history(bot.id).some((m) => m.role === "activity" && m.text.startsWith("Lost the connection")));

  // Still out: another look later, no model call and no second chat line.
  const asked = fake.requests.length;
  await due();
  assert.equal(wakeups.forBot(bot.id)?.reconnect?.attempt, 2);
  assert.equal(fake.requests.length, asked);
  assert.equal(conv.history(bot.id).filter((m) => m.text.startsWith("Lost the connection")).length, 1);

  fake.online = true;
  await due();
  await settle(conv, bot);
  assert.equal(wakeups.forBot(bot.id), undefined);
  assert.equal(hands.actions.length, 1, "the click isn't repeated");
  const last = fake.requests.at(-1)!.messages;
  assert.ok(last.some((m) => m.role === "tool"), "the tool result is still in the context");
  assert.ok(last.some((m) => m.role === "user" && JSON.stringify(m.content).includes("the connection is back")), "looks at the screen again");
  const chat = conv.history(bot.id);
  assert.equal(chat.at(-1)?.text, "Pronto.");
  assert.ok(!chat.some((m) => m.text.includes("Agora vou")), "the cut-off reply is dropped");
  assert.ok(!chat.some((m) => m.error), "no error in the chat");
  assert.ok(chat.some((m) => m.text.startsWith("The connection is back")));
});

test("Stop ends the wait, and so does Cancel on the wake-up bar", async () => {
  for (const cancel of [(c: Conversations, id: string) => c.stop(id), (c: Conversations, id: string) => c.cancelWakeup(id)]) {
    const { bot, fake, conv, wakeups, due } = flaky([cutOff, { text: "não devia rodar" }]);
    await conv.send(bot, "faz algo");
    await untilWaiting(wakeups, bot);
    cancel(conv, bot.id);
    await settle(conv, bot);
    assert.equal(conv.isBusy(bot.id), false);
    assert.equal(wakeups.forBot(bot.id), undefined);
    fake.online = true;
    await due();
    await sleep(20);
    assert.equal(fake.requests.length, 1, "no more model calls");
  }
});

test("Stop during the check doesn't let the turn go on", async () => {
  const { bot, fake, conv, wakeups, due } = flaky([cutOff, { text: "não devia rodar" }]);
  await conv.send(bot, "faz algo");
  await untilWaiting(wakeups, bot);
  fake.online = true;
  const checking = due();
  conv.stop(bot.id);
  await checking;
  await settle(conv, bot);
  assert.equal(fake.requests.length, 1);
  assert.equal(wakeups.forBot(bot.id), undefined);
});

test("errors that retrying can't fix end the turn as before", async () => {
  for (const [message, friendly] of [
    ["OpenRouter returned 401: invalid api key", /rejected the API key/],
    ["OpenRouter returned 404: model not found", /isn’t available/],
    ["OpenRouter doesn’t have enough credits for this right now.", /out of credits/],
    ["The model refused to answer this", /returned an error/],
  ] as const) {
    const { bot, fake, conv, wakeups } = flaky([() => { throw new Error(message); }]);
    await conv.send(bot, "oi");
    await settle(conv, bot);
    assert.equal(wakeups.forBot(bot.id), undefined, message);
    assert.equal(fake.requests.length, 1);
    assert.match(conv.history(bot.id).at(-1)?.error ?? "", friendly);
  }
});

test("after the limit of tries the turn ends with an error", async () => {
  const { bot, fake, conv, wakeups, due } = flaky(Array.from({ length: 5 }, () => cutOff));
  await conv.send(bot, "oi");
  await untilWaiting(wakeups, bot);
  for (let i = 0; i < MAX_RECONNECTS; i++) await due();
  await settle(conv, bot);
  assert.equal(wakeups.forBot(bot.id), undefined);
  assert.equal(fake.checks, MAX_RECONNECTS);
  assert.equal(fake.requests.length, 2, "one last try before giving up");
  assert.match(conv.history(bot.id).at(-1)?.error ?? "", /after 30 tries/);
});

test("a step that works starts the count over", async () => {
  const { bot, fake, conv, wakeups, due } = flaky([cutOff, { tools: [{ name: "list_routines", args: {} }] }, cutOff, { text: "Pronto." }]);
  await conv.send(bot, "oi");
  await untilWaiting(wakeups, bot);
  fake.online = true;
  await due();
  await untilWaiting(wakeups, bot);
  assert.equal(wakeups.forBot(bot.id)?.reconnect?.attempt, 1);
  await due();
  await settle(conv, bot);
  assert.equal(conv.history(bot.id).at(-1)?.text, "Pronto.");
});

test("the wake-up the bot had set comes back after the wait", async () => {
  const { bot, fake, conv, wakeups, due } = flaky([
    { tools: [{ name: "schedule_wakeup", args: { minutes: 20, reason: "ver o download" } }] },
    cutOff,
    { text: "Volto em 20 min." },
  ]);
  await conv.send(bot, "baixa");
  await untilWaiting(wakeups, bot);
  assert.equal(wakeups.forBot(bot.id)?.reconnect?.previous?.note, "ver o download");
  fake.online = true;
  await due();
  await settle(conv, bot);
  const back = wakeups.forBot(bot.id)!;
  assert.equal(back.note, "ver o download");
  assert.equal(back.reconnect, undefined);
});

test("a quick look with no connection tries again instead of dropping the wake-up", async () => {
  const { bot, fake, conv, wakeups, due } = flaky([cutOff, { tools: [{ name: "wake_sleep", args: { minutes: 15, reason: "ainda baixando" } }] }]);
  wakeups.set(bot.id, 20, "ver o download", 3);
  await due();
  assert.deepEqual(wakeups.forBot(bot.id)?.reconnect?.attempt, 1);
  assert.equal(wakeups.forBot(bot.id)?.reconnect?.turn, false);
  fake.online = true;
  await due(); // the connection is back: the original wake-up returns
  assert.equal(wakeups.forBot(bot.id)?.note, "ver o download");
  assert.equal(wakeups.forBot(bot.id)?.checks, 3);
  await due(); // and it takes its look
  assert.equal(wakeups.forBot(bot.id)?.note, "ainda baixando");
  assert.equal(wakeups.forBot(bot.id)?.checks, 4);
  assert.ok(!conv.history(bot.id).some((m) => m.role === "user"));
});

test("a routine isn't reported until the task really ends", async () => {
  const { bot, fake, conv, wakeups, due } = flaky([cutOff, { text: "Relatório pronto." }]);
  let outcome: { ok: boolean; reply?: string } | undefined;
  void conv.runRoutine(bot, { id: "r1", name: "Relatório", task: "faz o relatório" }).then((o) => (outcome = o));
  await untilWaiting(wakeups, bot);
  await sleep(20);
  assert.equal(outcome, undefined);
  fake.online = true;
  await due();
  await settle(conv, bot);
  assert.deepEqual(outcome, { ok: true, reply: "Relatório pronto." });
});

test("a message sent during the wait joins when the connection is back", async () => {
  const { bot, fake, conv, wakeups, due } = flaky([cutOff, { text: "Ok." }]);
  await conv.send(bot, "primeira");
  await untilWaiting(wakeups, bot);
  assert.equal((await conv.send(bot, "segunda")).queued, true);
  fake.online = true;
  await due();
  await settle(conv, bot);
  assert.ok(JSON.stringify(fake.requests.at(-1)!.messages).includes("segunda"));
});

test("after a restart the wait is picked up by a new turn told what was done", async () => {
  const { bot, fake, conv, wakeups, due } = flaky([{ text: "Continuando." }]);
  conv.importHistory(bot.id, [
    { id: "1", botId: bot.id, role: "user", text: "baixa o relatório", at: new Date(Date.now() - 2000).toISOString() },
    { id: "2", botId: bot.id, role: "activity", text: "Abriu o Firefox", at: new Date(Date.now() - 1000).toISOString() },
  ]);
  wakeups.set(bot.id, 2, "Waiting for the connection (try 4 of 30)", 0, { attempt: 4, turn: true });
  await due();
  assert.equal(wakeups.forBot(bot.id)?.reconnect?.attempt, 5, "still out: keeps waiting");
  assert.equal(fake.requests.length, 0);
  fake.online = true;
  await due();
  await settle(conv, bot);
  const prompt = conv.history(bot.id).filter((m) => m.role === "user").at(-1)!;
  assert.deepEqual(prompt.wakeup, { note: "The connection came back" });
  assert.match(prompt.text, /Abriu o Firefox/);
  assert.equal(conv.history(bot.id).at(-1)?.text, "Continuando.");
});

test("after a restart, a limit reached without connection ends quietly with a note", async () => {
  const { bot, fake, conv, wakeups, due } = flaky([]);
  wakeups.set(bot.id, 2, "Waiting for the connection", 0, { attempt: MAX_RECONNECTS, turn: true });
  await due();
  assert.equal(wakeups.forBot(bot.id), undefined);
  assert.equal(fake.requests.length, 0);
  assert.match(conv.history(bot.id).at(-1)?.text ?? "", /Still no connection after 30 tries/);
});

test("what fetch really throws is recognized: nobody listening, and a reply cut off midway", async () => {
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) return void res.end(JSON.stringify({ data: [] }));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Agora" } }] })}\n\n`, () => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const client = (p: number) => new OpenAICompatibleProvider({ id: "t", label: "Test", baseURL: `http://127.0.0.1:${p}`, apiKey: () => undefined, keyless: true });
  const request = { model: "m", messages: [], onDelta: () => {} };
  const cut = await client(port).chat(request).catch((e) => e);
  server.close();
  server.closeAllConnections();
  await new Promise((r) => server.once("close", r));
  const refused = await client(port).chat(request).catch((e) => e);
  const check = await client(port).models(true).catch((e) => e);
  for (const err of [cut, refused, check]) assert.equal(isConnectionFailure(err), true, String(err));
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(isConnectionFailure(await client(port).chat({ ...request, signal: stopped.signal }).catch((e) => e)), false);
});
