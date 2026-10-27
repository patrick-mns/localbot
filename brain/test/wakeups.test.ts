import "./env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Conversations } from "../src/chat/conversations.ts";
import { MAX_CHECKS, Wakeups } from "../src/routines/wakeups.ts";
import type { Bot } from "../src/bots/bots.ts";
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
