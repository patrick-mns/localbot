import "./env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAvatar, parseAvatar } from "../src/bots/avatar.ts";
import { Bots } from "../src/bots/bots.ts";
import { libraryBots } from "../src/bots/library.ts";

test("library entries have unique ids and everything the new-bot form needs", () => {
  const entries = libraryBots();
  assert.ok(entries.length > 0);
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
  for (const e of entries) {
    for (const field of [e.name, e.role, e.summary, e.instructions]) assert.ok(field.trim(), e.id);
  }
});

test("library faces are catalog specs, not seeds that turn into a random face", () => {
  for (const e of libraryBots()) {
    assert.equal(formatAvatar(parseAvatar(e.avatarSeed)), e.avatarSeed);
    assert.match(e.face.fill, /^#[0-9a-f]{6}$/);
  }
});

test("a bot made from a library entry is an ordinary bot", () => {
  const [entry] = libraryBots();
  const bot = new Bots().create({ ...entry, provider: "p", model: "m" });
  assert.notEqual(bot.id, entry.id);
  assert.equal(bot.instructions, entry.instructions);
  assert.equal(bot.avatarSeed, entry.avatarSeed);
  assert.ok(!("summary" in bot));
});
