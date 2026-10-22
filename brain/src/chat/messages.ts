import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOME } from "../store.ts";
import type { Message } from "./conversations.ts";

/**
 * Chat messages in SQLite (~/.local-bot/chats.db): one row per message, so a
 * new message is one insert instead of rewriting every chat, and a chat can
 * be read a page at a time. Older installs kept them in messages.json; it is
 * copied in once and left as it was (an older app version can still read it).
 */
export class MessageStore {
  private db: DatabaseSync;

  constructor(dir = HOME) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, "chats.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        at TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_bot ON messages (bot_id, seq);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    this.migrate(join(dir, "messages.json"));
  }

  /** Insert or replace; a replaced message keeps its place in the chat unless `toEnd`. */
  upsert(m: Message, toEnd = false): Message {
    const existing = this.db.prepare("SELECT seq FROM messages WHERE id = ?").get(m.id) as { seq: number } | undefined;
    const seq = (!toEnd && existing?.seq) || this.nextSeq();
    this.db.prepare("INSERT OR REPLACE INTO messages (id, bot_id, at, seq, data) VALUES (?, ?, ?, ?, ?)")
      .run(m.id, m.botId, m.at, seq, JSON.stringify(m));
    return m;
  }

  get(id: string): Message | undefined {
    const row = this.db.prepare("SELECT data FROM messages WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  /** A whole chat, oldest first. */
  forBot(botId: string): Message[] {
    return this.rows(this.db.prepare("SELECT data FROM messages WHERE bot_id = ? ORDER BY seq").all(botId));
  }

  /** The last `limit` messages before `before` (a message id), oldest first. */
  page(botId: string, limit: number, before?: string): { messages: Message[]; more: boolean } {
    const cutoff = before
      ? (this.db.prepare("SELECT seq FROM messages WHERE id = ?").get(before) as { seq: number } | undefined)?.seq
      : undefined;
    const rows = this.db.prepare(
      `SELECT data FROM messages WHERE bot_id = ? ${cutoff !== undefined ? "AND seq < ?" : ""} ORDER BY seq DESC LIMIT ?`,
    ).all(...(cutoff !== undefined ? [botId, cutoff, limit + 1] : [botId, limit + 1]));
    const more = rows.length > limit;
    return { messages: this.rows(rows.slice(0, limit)).reverse(), more };
  }

  /** Messages matching `pred` across every chat (rare: e.g. pending connect cards). */
  where(pred: (m: Message) => boolean): Message[] {
    return this.rows(this.db.prepare("SELECT data FROM messages ORDER BY seq").all()).filter(pred);
  }

  removeBot(botId: string) {
    this.db.prepare("DELETE FROM messages WHERE bot_id = ?").run(botId);
  }

  clear() {
    this.db.exec("DELETE FROM messages");
  }

  private nextSeq() {
    return ((this.db.prepare("SELECT MAX(seq) AS s FROM messages").get() as { s: number | null }).s ?? 0) + 1;
  }

  private rows(rows: unknown[]): Message[] {
    return (rows as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  /** Copies the old messages.json in once, in order. */
  private migrate(file: string) {
    const done = this.db.prepare("SELECT value FROM meta WHERE key = 'imported-json'").get();
    if (done || !existsSync(file)) return;
    let old: Message[] = [];
    try { old = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
    this.db.exec("BEGIN");
    try {
      for (const m of old) this.upsert(m);
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('imported-json', ?)").run(new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
