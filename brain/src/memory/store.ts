import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOME } from "../store.ts";

/**
 * Long-term memory, local to this Mac (~/.local-bot/memory.db).
 *
 * - core:      always in context (who the user is, standing preferences)
 * - fact:      things that are true; a newer fact supersedes an older one
 *              (valid_to is set, history is kept) instead of overwriting it
 * - procedure: how to do something in an app or site (topic = app/site)
 * - episode:   what happened in a past task, one line per run
 *
 * Scope: a memory belongs to one bot (bot_id) or to the whole team (bot_id NULL).
 * Search is full-text (FTS5/BM25, accent-insensitive) blended with importance
 * and recency.
 */
export type MemoryKind = "core" | "fact" | "procedure" | "episode";
export type MemorySource = "bot" | "user" | "learned";

export interface Memory {
  id: string;
  botId: string | null;
  kind: MemoryKind;
  text: string;
  topic: string | null;
  source: MemorySource;
  importance: number; // 1–5
  createdAt: string;
  updatedAt: string;
  validTo: string | null; // set when superseded or forgotten
  supersededBy: string | null;
  useCount: number;
  lastUsedAt: string | null;
}

const KINDS: MemoryKind[] = ["core", "fact", "procedure", "episode"];
/** Keeps the always-on part of the context small. */
const MAX_CORE = 20;

export class MemoryStore {
  private db: DatabaseSync;

  constructor(file = join(HOME, "memory.db")) {
    mkdirSync(HOME, { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        bot_id TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        topic TEXT,
        source TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        valid_to TEXT,
        superseded_by TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS memories_bot ON memories(bot_id, kind, valid_to);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, topic, content='memories', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text, topic) VALUES (new.rowid, new.text, coalesce(new.topic, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, topic) VALUES ('delete', old.rowid, old.text, coalesce(old.topic, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text, topic ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, topic) VALUES ('delete', old.rowid, old.text, coalesce(old.topic, ''));
        INSERT INTO memories_fts(rowid, text, topic) VALUES (new.rowid, new.text, coalesce(new.topic, ''));
      END;
      CREATE TABLE IF NOT EXISTS chat_summaries (
        bot_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        covers_until TEXT NOT NULL
      );
    `);
    this.migrate();
  }

  /**
   * Version 1: what a bot learned after a task used to be filed under the
   * team, so one bot's projects showed up for every bot. Each such memory goes
   * back to the bot that learned it: the one whose episode was written in the
   * same pass (within seconds). Unmatched or ambiguous ones stay with the team.
   */
  private migrate() {
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version >= 1) return;
    const learners = this.db.prepare(
      `SELECT DISTINCT bot_id FROM memories WHERE kind = 'episode' AND bot_id IS NOT NULL
       AND abs(julianday(created_at) - julianday(?)) * 86400 < 5`,
    );
    const move = this.db.prepare(`UPDATE memories SET bot_id = ? WHERE id = ?`);
    this.db.exec("BEGIN");
    try {
      for (const row of this.db.prepare(`SELECT id, created_at FROM memories WHERE bot_id IS NULL AND source = 'learned'`).all() as any[]) {
        const bots = learners.all(row.created_at) as { bot_id: string }[];
        if (bots.length === 1) move.run(bots[0].bot_id, row.id);
      }
      this.db.exec("PRAGMA user_version = 1; COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  add(input: { botId: string | null; kind: MemoryKind; text: string; topic?: string | null; source: MemorySource; importance?: number }): Memory {
    const text = input.text.trim();
    if (!text) throw new Error("Empty memory");
    if (!KINDS.includes(input.kind)) throw new Error(`Unknown memory kind: ${input.kind}`);
    if (input.kind === "core" && this.core(input.botId).length >= MAX_CORE) {
      throw new Error(`Core memory is full (${MAX_CORE}); save it as a fact or forget something first`);
    }
    // Same text already known and current: just touch it.
    const dup = this.db.prepare(
      `SELECT id FROM memories WHERE valid_to IS NULL AND kind = ? AND lower(text) = lower(?) AND bot_id IS ?`,
    ).get(input.kind, text, input.botId) as { id: string } | undefined;
    if (dup) return this.get(dup.id)!;

    const now = new Date().toISOString();
    const id = `m-${randomBytes(4).toString("hex")}`;
    this.db.prepare(
      `INSERT INTO memories (id, bot_id, kind, text, topic, source, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.botId, input.kind, text, input.topic?.trim() || null, input.source,
      clamp(input.importance ?? 3), now, now);
    return this.get(id)!;
  }

  /** Replaces a memory with a corrected version, keeping the old one as history. */
  supersede(id: string, text: string, source: MemorySource): Memory {
    const old = this.get(id);
    if (!old || old.validTo) throw new Error(`No current memory ${id}`);
    const now = new Date().toISOString();
    const next = this.add({ botId: old.botId, kind: old.kind, text, topic: old.topic, source, importance: old.importance });
    if (next.id !== old.id) {
      this.db.prepare(`UPDATE memories SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ?`).run(now, next.id, now, id);
    }
    return next;
  }

  /** In-place edit (the user correcting wording); no history entry. */
  edit(id: string, patch: { text?: string; kind?: MemoryKind; topic?: string | null; importance?: number }) {
    const m = this.get(id);
    if (!m) throw new Error(`No memory ${id}`);
    if (patch.kind && patch.kind === "core" && m.kind !== "core" && this.core(m.botId).length >= MAX_CORE) {
      throw new Error(`Core memory is full (${MAX_CORE})`);
    }
    this.db.prepare(`UPDATE memories SET text = ?, kind = ?, topic = ?, importance = ?, updated_at = ? WHERE id = ?`).run(
      patch.text?.trim() || m.text, patch.kind ?? m.kind,
      patch.topic === undefined ? m.topic : patch.topic?.trim() || null,
      clamp(patch.importance ?? m.importance), new Date().toISOString(), id,
    );
    return this.get(id)!;
  }

  /** Shares a memory with every bot (null) or keeps it to one. */
  setScope(id: string, botId: string | null) {
    const m = this.get(id);
    if (!m) throw new Error(`No memory ${id}`);
    if (m.botId === botId) return m;
    if (m.kind === "core" && this.core(botId).length >= MAX_CORE) throw new Error(`Core memory is full (${MAX_CORE})`);
    this.db.prepare(`UPDATE memories SET bot_id = ?, updated_at = ? WHERE id = ?`).run(botId, new Date().toISOString(), id);
    return this.get(id)!;
  }

  /** Stops using a memory but keeps it as history. */
  forget(id: string) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE memories SET valid_to = ?, updated_at = ? WHERE id = ? AND valid_to IS NULL`).run(now, now, id);
  }

  /** Erases a memory for good (from the Memory tab). */
  delete(id: string) {
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  }

  /** Factory reset: every memory and chat summary. */
  reset() {
    this.db.exec(`DELETE FROM memories; DELETE FROM chat_summaries; INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');`);
  }

  deleteForBot(botId: string) {
    this.db.prepare(`DELETE FROM memories WHERE bot_id = ?`).run(botId);
    this.db.prepare(`DELETE FROM chat_summaries WHERE bot_id = ?`).run(botId);
  }

  /** A bot's own memories (history included) and chat summary, to move it to another brain. */
  exportForBot(botId: string) {
    return {
      rows: this.db.prepare(`SELECT * FROM memories WHERE bot_id = ?`).all(botId) as Record<string, unknown>[],
      summary: this.chatSummary(botId) ?? null,
    };
  }

  importForBot(botId: string, data: { rows: Record<string, any>[]; summary: { text: string; coversUntil: string } | null }) {
    this.deleteForBot(botId);
    const insert = this.db.prepare(
      `INSERT INTO memories (id, bot_id, kind, text, topic, source, importance, created_at, updated_at, valid_to, superseded_by, use_count, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of data.rows) {
      insert.run(r.id, botId, r.kind, r.text, r.topic ?? null, r.source, r.importance ?? 3, r.created_at, r.updated_at,
        r.valid_to ?? null, r.superseded_by ?? null, r.use_count ?? 0, r.last_used_at ?? null);
    }
    if (data.summary) this.setChatSummary(botId, data.summary.text, data.summary.coversUntil);
  }

  get(id: string): Memory | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
    return row ? toMemory(row) : undefined;
  }

  /** Always-on memories for a bot: its own core plus the team's. */
  core(botId: string | null): Memory[] {
    return (this.db.prepare(
      `SELECT * FROM memories WHERE kind = 'core' AND valid_to IS NULL AND (bot_id IS ? OR bot_id IS NULL)
       ORDER BY importance DESC, updated_at DESC`,
    ).all(botId) as any[]).map(toMemory);
  }

  /**
   * Current memories relevant to `query` for a bot (own + team), best first.
   * Score = BM25 relevance, nudged by importance and recency.
   */
  search(botId: string | null, query: string, opts: { limit?: number; kinds?: MemoryKind[] } = {}): Memory[] {
    const limit = opts.limit ?? 8;
    const kinds = opts.kinds ?? ["fact", "procedure", "episode"];
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.db.prepare(
      `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.valid_to IS NULL AND (m.bot_id IS ? OR m.bot_id IS NULL)
         AND m.kind IN (${kinds.map(() => "?").join(",")})
       ORDER BY rank LIMIT ?`,
    ).all(match, botId, ...kinds, limit * 4) as any[];
    const now = Date.now();
    return rows
      .map((r) => {
        const ageDays = (now - Date.parse(r.updated_at)) / 86_400_000;
        // bm25 is negative-is-better; flip it and add small boosts.
        const score = -r.rank + 0.15 * r.importance + 0.3 / (1 + ageDays / 30);
        return { m: toMemory(r), score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.m);
  }

  /** Recent episodes, newest first (what the bot did lately). */
  recentEpisodes(botId: string, limit = 5): Memory[] {
    return (this.db.prepare(
      `SELECT * FROM memories WHERE kind = 'episode' AND valid_to IS NULL AND bot_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(botId, limit) as any[]).map(toMemory);
  }

  /** Everything a bot can see (own + team), for the Memory tab. */
  list(botId: string, includeHistory = false): Memory[] {
    return (this.db.prepare(
      `SELECT * FROM memories WHERE (bot_id = ? OR bot_id IS NULL) ${includeHistory ? "" : "AND valid_to IS NULL"}
       ORDER BY CASE kind WHEN 'core' THEN 0 WHEN 'fact' THEN 1 WHEN 'procedure' THEN 2 ELSE 3 END, updated_at DESC`,
    ).all(botId) as any[]).map(toMemory);
  }

  markUsed(ids: string[]) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`);
    for (const id of ids) stmt.run(now, id);
  }

  chatSummary(botId: string): { text: string; coversUntil: string } | undefined {
    const row = this.db.prepare(`SELECT text, covers_until FROM chat_summaries WHERE bot_id = ?`).get(botId) as any;
    return row ? { text: row.text, coversUntil: row.covers_until } : undefined;
  }

  setChatSummary(botId: string, text: string, coversUntil: string) {
    this.db.prepare(
      `INSERT INTO chat_summaries (bot_id, text, covers_until) VALUES (?, ?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET text = excluded.text, covers_until = excluded.covers_until`,
    ).run(botId, text, coversUntil);
  }

  clearChatSummary(botId: string) {
    this.db.prepare(`DELETE FROM chat_summaries WHERE bot_id = ?`).run(botId);
  }
}

const clamp = (n: number) => Math.min(5, Math.max(1, Math.round(Number(n) || 3)));

/** Free text → a forgiving FTS5 query: any significant word, prefix-matched. */
function ftsQuery(text: string): string {
  const words = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const unique = [...new Set(words)].filter((w) => !STOP.has(w)).slice(0, 24);
  return unique.map((w) => `"${w}"*`).join(" OR ");
}

const STOP = new Set([
  "the", "and", "for", "you", "that", "this", "with", "are", "was", "what", "can", "please", "from", "have",
  "que", "para", "com", "uma", "por", "como", "mais", "voce", "esse", "essa", "isso", "dos", "das", "nos", "nas", "pra",
]);

function toMemory(r: any): Memory {
  return {
    id: r.id, botId: r.bot_id, kind: r.kind, text: r.text, topic: r.topic, source: r.source,
    importance: r.importance, createdAt: r.created_at, updatedAt: r.updated_at, validTo: r.valid_to,
    supersededBy: r.superseded_by, useCount: r.use_count, lastUsedAt: r.last_used_at,
  };
}
