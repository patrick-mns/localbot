import "./env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memory/store.ts";
import { MemoryService } from "../src/memory/memory.ts";
import type { Bot } from "../src/bots/bots.ts";

const bot = { id: "b1", name: "Memo" } as Bot;

test("store: supersede keeps history; search is accent-insensitive", () => {
  const s = new MemoryStore(":memory:");
  const old = s.add({ botId: "b1", kind: "fact", text: "O cliente Acme assina plano mensal", source: "bot" });
  const now = s.supersede(old.id, "O cliente Acme agora só assina plano anual", "learned");
  assert.deepEqual(s.search("b1", "qual plano a acmé usa").map((m) => m.text), [now.text]);
  const history = s.list("b1", true).find((m) => m.id === old.id)!;
  assert.ok(history.validTo);
  assert.equal(history.supersededBy, now.id);
});

test("store: duplicates are merged, bots are isolated, team is shared", () => {
  const s = new MemoryStore(":memory:");
  const a = s.add({ botId: "b1", kind: "fact", text: "Gosta de café", source: "bot" });
  assert.equal(s.add({ botId: "b1", kind: "fact", text: "gosta de café", source: "bot" }).id, a.id);
  s.add({ botId: "b2", kind: "fact", text: "Segredo do outro bot", source: "bot" });
  s.add({ botId: null, kind: "core", text: "A empresa se chama YVY", source: "user" });
  assert.equal(s.search("b1", "segredo").length, 0);
  assert.equal(s.core("b1")[0].text, "A empresa se chama YVY");
  assert.equal(s.core("b2")[0].text, "A empresa se chama YVY");
});

test("store: forget hides, delete erases, core is capped", () => {
  const s = new MemoryStore(":memory:");
  const m = s.add({ botId: "b1", kind: "fact", text: "Temporário", source: "bot" });
  s.forget(m.id);
  assert.equal(s.search("b1", "temporário").length, 0);
  assert.ok(s.get(m.id));
  s.delete(m.id);
  assert.equal(s.get(m.id), undefined);
  for (let i = 0; i < 20; i++) s.add({ botId: "b1", kind: "core", text: `Regra ${i}`, source: "user" });
  assert.throws(() => s.add({ botId: "b1", kind: "core", text: "Uma a mais", source: "user" }), /full/);
});

test("service: remember / recall / forget tools, and secrets are refused", () => {
  const svc = new MemoryService(async () => "", () => {});
  const saved = svc.tool(bot, "remember", JSON.stringify({ text: "Prefere respostas curtas", kind: "core" }));
  assert.match(saved.result, /Saved as m-/);
  assert.match(svc.tool(bot, "recall", JSON.stringify({ query: "respostas" })).result, /Prefere respostas curtas/);
  assert.match(svc.tool(bot, "remember", JSON.stringify({ text: "senha: hunter2" })).result, /secret/);
  assert.match(svc.tool(bot, "remember", JSON.stringify({ text: "chave sk-or-v1-abcdefghijklmnop" })).result, /secret/);
  const id = /m-[0-9a-f]+/.exec(saved.result)![0];
  assert.match(svc.tool(bot, "forget", JSON.stringify({ id })).result, /Forgot/);
  assert.match(svc.context(bot, "respostas"), /Nothing saved yet/);
});

test("consolidation: adds learned facts, records the episode, ignores same-turn saves", async () => {
  let prompt = "";
  const svc = new MemoryService(async (_b, msgs) => {
    prompt = String(msgs[0].content);
    return 'Sure: {"episode":"Compared plans for the client","ops":[{"op":"add","kind":"fact","text":"Fazenda X fecha só contrato anual"}]}';
  }, () => {});
  const startedAt = new Date(Date.now() - 1000).toISOString();
  svc.tool(bot, "remember", JSON.stringify({ text: "Usuário se chama Patrick", kind: "core" }));
  await svc.consolidate(bot, { request: "compara os planos", steps: [], reply: "Feito", startedAt });
  assert.match(prompt, /Saved by the bot during this exchange[\s\S]*Patrick/);
  const all = svc.store.list("b1");
  assert.ok(all.some((m) => m.kind === "episode" && m.text === "Compared plans for the client"));
  assert.ok(all.some((m) => m.kind === "fact" && m.source === "learned"));
});

test("store: reset erases everything", () => {
  const s = new MemoryStore(":memory:");
  s.add({ botId: "b1", kind: "fact", text: "Algo para esquecer", source: "bot" });
  s.setChatSummary("b1", "resumo", new Date().toISOString());
  s.reset();
  assert.equal(s.list("b1", true).length, 0);
  assert.equal(s.search("b1", "esquecer").length, 0);
  assert.equal(s.chatSummary("b1"), undefined);
});

test("consolidation keeps what a bot learned to itself, even when the model says team", async () => {
  const other = { id: "b-other", name: "Outro" } as Bot;
  const svc = new MemoryService(async () =>
    '{"episode":"Publicou o vídeo do canal infantil","ops":[{"op":"add","kind":"procedure","topic":"YouTube Studio","text":"Marcar Feito para crianças no canal Turma da Clareira","scope":"team"}]}', () => {});
  await svc.consolidate(bot, { request: "publica o vídeo", steps: [], reply: "Publicado", startedAt: new Date().toISOString() });
  const learned = svc.store.list(bot.id).find((m) => m.kind === "procedure")!;
  assert.equal(learned.botId, bot.id);
  assert.equal(svc.store.search(other.id, "canal turma clareira").length, 0);
  assert.doesNotMatch(svc.context(other, "canal turma clareira"), /Clareira/);
});

test("consolidation can't rewrite the team's or another bot's memories", async () => {
  const svc = new MemoryService(async () => "", () => {});
  const team = svc.store.add({ botId: null, kind: "fact", text: "A empresa usa Notion para projetos", source: "user" });
  const theirs = svc.store.add({ botId: "b-other", kind: "fact", text: "Projeto Atlas entrega em março", source: "bot" });
  const ask = async () => JSON.stringify({ episode: null, ops: [
    { op: "update", id: team.id, text: "A empresa usa Linear para projetos" },
    { op: "forget", id: theirs.id },
  ] });
  await new MemoryService(ask, () => {}).consolidate(bot, { request: "x", steps: [], reply: "y", startedAt: new Date().toISOString() });
  assert.equal(svc.store.get(team.id)?.validTo, null);
  assert.equal(svc.store.get(theirs.id)?.validTo, null);
});

test("store: a memory can be shared with the team or kept to one bot", () => {
  const s = new MemoryStore(":memory:");
  const m = s.add({ botId: "b1", kind: "fact", text: "O usuário fala português", source: "bot" });
  s.setScope(m.id, null);
  assert.equal(s.search("b2", "português").length, 1);
  s.setScope(m.id, "b1");
  assert.equal(s.search("b2", "português").length, 0);
});

test("store: memories learned under the team before go back to the bot that learned them", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "mem-")), "memory.db");
  new MemoryStore(file);
  const db = new DatabaseSync(file);
  const row = db.prepare(`INSERT INTO memories (id, bot_id, kind, text, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const t1 = "2026-10-20T10:00:00.100Z", t2 = "2026-10-21T10:00:00.100Z", t3 = "2026-10-22T10:00:00.100Z";
  row.run("ep-a", "alice", "episode", "Publicou o vídeo", "learned", "2026-10-20T10:00:00.050Z", t1);
  row.run("m-a", null, "procedure", "Canal infantil: marcar Feito para crianças", "learned", t1, t1);
  // Two bots finished at the same moment: can't tell, so it stays shared.
  row.run("ep-b", "bob", "episode", "Fez a música", "learned", t2, t2);
  row.run("ep-c", "carol", "episode", "Fez o clipe", "learned", t2, t2);
  row.run("m-b", null, "fact", "Rotina de música às 9h", "learned", t2, t2);
  // Saved on purpose (by the user or with scope team): untouched.
  row.run("m-c", null, "core", "O usuário se chama Patrick", "user", t3, t3);
  db.exec("PRAGMA user_version = 0");
  db.close();

  const s = new MemoryStore(file);
  assert.equal(s.get("m-a")?.botId, "alice");
  assert.equal(s.get("m-b")?.botId, null);
  assert.equal(s.get("m-c")?.botId, null);
  assert.equal(s.search("bob", "canal infantil").length, 0);
});
