import type { Bot } from "../bots/bots.ts";
import type { ChatMessage, ToolSpec } from "../chat/types.ts";
import { MemoryStore, type Memory, type MemoryKind } from "./store.ts";

/** Asks the bot's own model a one-off question (no tools, no streaming UI). */
export type Ask = (bot: Bot, messages: ChatMessage[]) => Promise<string>;

export const MEMORY_TOOLS: ToolSpec[] = [
  {
    name: "remember",
    description:
      "Save something worth knowing later: a fact about the user or their work, a preference, or how to do " +
      "something in an app/site. Don't save secrets (passwords, keys, card numbers).",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "One self-contained statement" },
        kind: {
          type: "string", enum: ["fact", "procedure", "core"],
          description: "fact (default) · procedure: how to do something (set topic) · core: always-relevant (who the user is, standing preferences)",
        },
        topic: { type: "string", description: "For procedures: the app or site, e.g. 'Gmail'" },
        scope: {
          type: "string", enum: ["me", "team"],
          description: "me (default): yours only. team: only facts about the user themselves that every bot needs " +
            "(their name, language, how they like to work). Never projects, channels, clients, files or tasks: those stay yours.",
        },
        replaces: { type: "string", description: "Id of a memory this corrects or updates (e.g. m-1a2b3c4d)" },
      },
      required: ["text"],
    },
  },
  {
    name: "recall",
    description: "Search your long-term memory (facts, procedures, past tasks) beyond what's already shown to you.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "forget",
    description: "Stop using a memory that's wrong or outdated (by id). It stays in history.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const line = (m: Memory) =>
  `- [${m.id}] ${m.topic ? `${m.topic}: ` : ""}${m.text}${m.botId === null ? " (team)" : ""} (${fmtDate(m.updatedAt)})`;

/** Messages kept verbatim; older ones are folded into a running summary. */
export const VERBATIM_MESSAGES = 40;
/** Fold once this many messages sit beyond the verbatim window. */
const COMPACT_AFTER = 20;

export class MemoryService {
  readonly store = new MemoryStore();

  constructor(private ask: Ask, private changed: (botId: string) => void) {}

  /** The memory block for a turn: core, what's relevant to `query`, recent work. */
  context(bot: Bot, query: string): string {
    const core = this.store.core(bot.id);
    const relevant = this.store.search(bot.id, query, { limit: 8 });
    const shown = new Set(relevant.map((m) => m.id));
    const recent = this.store.recentEpisodes(bot.id, 3).filter((m) => !shown.has(m.id));
    this.store.markUsed([...core, ...relevant].map((m) => m.id));
    const parts = [
      core.length ? `What you always know:\n${core.map(line).join("\n")}` : "",
      relevant.length ? `Memories that may be relevant now:\n${relevant.map(line).join("\n")}` : "",
      recent.length ? `What you did recently:\n${recent.map(line).join("\n")}` : "",
    ].filter(Boolean);
    return [
      "Long-term memory. Ids in brackets let you update (remember with replaces) or forget a memory.",
      parts.length ? parts.join("\n\n") : "(Nothing saved yet.)",
      "Use remember for things worth keeping: user facts and preferences, decisions, and how-tos for apps you used. Prefer updating over duplicating.",
    ].join("\n\n");
  }

  /** remember / recall / forget. Returns the tool result and a chat activity line. */
  tool(bot: Bot, name: string, rawArgs: string): { result: string; activity?: string } {
    let a: any;
    try {
      a = JSON.parse(rawArgs || "{}");
    } catch {
      return { result: "Error: invalid arguments." };
    }
    try {
      switch (name) {
        case "remember": {
          const text = String(a.text ?? "").trim();
          if (looksSecret(text)) return { result: "Error: that looks like a secret; don't store passwords or keys in memory." };
          const kind: MemoryKind = ["fact", "procedure", "core"].includes(a.kind) ? a.kind : "fact";
          const m = a.replaces && this.store.get(String(a.replaces))?.validTo === null
            ? this.store.supersede(String(a.replaces), text, "bot")
            : this.store.add({ botId: a.scope === "team" ? null : bot.id, kind, text, topic: a.topic, source: "bot" });
          this.changed(bot.id);
          return { result: `Saved as ${m.id}.`, activity: `Remembered: ${m.text}` };
        }
        case "recall": {
          const found = this.store.search(bot.id, String(a.query ?? ""), { limit: 10, kinds: ["core", "fact", "procedure", "episode"] });
          return { result: found.length ? found.map(line).join("\n") : "Nothing in memory about that." };
        }
        case "forget": {
          const m = this.store.get(String(a.id ?? ""));
          if (!m || (m.botId !== null && m.botId !== bot.id)) return { result: `Error: no memory ${a.id}.` };
          this.store.forget(m.id);
          this.changed(bot.id);
          return { result: `Forgot ${m.id}.`, activity: `Forgot: ${m.text}` };
        }
      }
    } catch (err) {
      return { result: `Error: ${err instanceof Error ? err.message : err}` };
    }
    return { result: "Error: unknown memory tool." };
  }

  /**
   * After a turn: write a one-line episode and extract durable facts/how-tos
   * the bot didn't save itself (Mem0-style add / update / forget against
   * what's already stored). Runs in the background; failures are ignored.
   */
  async consolidate(bot: Bot, turn: { request: string; steps: string[]; reply: string; startedAt: string }) {
    const related = this.store.search(bot.id, `${turn.request} ${turn.reply}`, { limit: 15, kinds: ["core", "fact", "procedure"] });
    // The bot may have saved things itself during this exchange; those are not
    // "already known", they're this exchange's own work. Keep them apart so
    // the consolidator neither duplicates them nor reports them as pre-existing.
    const before = related.filter((m) => m.createdAt < turn.startedAt);
    const savedNow = this.store.list(bot.id).filter((m) => m.kind !== "episode" && m.createdAt >= turn.startedAt);
    const prompt = [
      "You maintain the long-term memory of an AI teammate. From the exchange below, decide what to keep.",
      "Return ONLY JSON: {\"episode\": string|null, \"ops\": [{\"op\": \"add\"|\"update\"|\"forget\", \"id\"?: string, \"kind\"?: \"fact\"|\"procedure\"|\"core\", \"text\"?: string, \"topic\"?: string}]}",
      "- episode: one line, past tense, the task that was done and its outcome. Use null when the exchange was only conversation, a question answered from knowledge, or only telling the bot something to remember. Never mention memory itself (no \"was saved\", \"already stored\", \"confirmed\").",
      "- add only durable, reusable knowledge the bot did NOT already save during this exchange: facts about the user/their work, preferences, decisions, how-tos for apps/sites. Not transient details, not secrets.",
      "- update (with id) when the exchange changes a memory from before it; forget (with id) when one is now wrong.",
      "- Prefer no ops over weak ones. Write memories in the language the user used.",
      "",
      `Memories from before this exchange:\n${before.length ? before.map(line).join("\n") : "(none)"}`,
      "",
      `Saved by the bot during this exchange (already handled, don't repeat):\n${savedNow.length ? savedNow.map(line).join("\n") : "(none)"}`,
      "",
      `User/teammate request:\n${turn.request}`,
      turn.steps.length ? `\nSteps taken:\n${turn.steps.map((s) => `- ${s}`).join("\n")}` : "",
      `\nFinal reply:\n${turn.reply}`,
    ].join("\n");

    let parsed: { episode?: string | null; ops?: any[] };
    try {
      parsed = parseJSON(await this.ask(bot, [{ role: "user", content: prompt }]));
    } catch {
      return;
    }

    if (parsed.episode && typeof parsed.episode === "string") {
      this.store.add({ botId: bot.id, kind: "episode", text: parsed.episode, source: "learned", importance: 2 });
    }
    for (const op of (parsed.ops ?? []).slice(0, 8)) {
      try {
        const text = String(op.text ?? "").trim();
        if (op.op === "add" && text && !looksSecret(text)) {
          // Learned memories stay with the bot that learned them: a project one
          // bot works on shouldn't leak into another's. Sharing is a choice
          // (the remember tool, or the user in the Memory tab).
          this.store.add({
            botId: bot.id,
            kind: ["fact", "procedure", "core"].includes(op.kind) ? op.kind : "fact",
            text, topic: op.topic, source: "learned",
          });
        } else if (op.op === "update" && op.id && text && !looksSecret(text) && this.owns(bot, op.id)) {
          this.store.supersede(op.id, text, "learned");
        } else if (op.op === "forget" && op.id && this.owns(bot, op.id)) {
          this.store.forget(op.id);
        }
      } catch {
        // One bad op shouldn't drop the rest.
      }
    }
    this.changed(bot.id);
  }

  /**
   * Folds chat messages older than the verbatim window into a running summary,
   * so long chats keep their gist instead of silently losing it.
   */
  async compact(bot: Bot, messages: { role: string; text: string; at: string }[]) {
    const chat = messages.filter((m) => m.role === "user" || m.role === "assistant");
    const older = chat.slice(0, Math.max(0, chat.length - VERBATIM_MESSAGES));
    const previous = this.store.chatSummary(bot.id);
    const pending = older.filter((m) => !previous || m.at > previous.coversUntil);
    if (pending.length < COMPACT_AFTER) return;

    const text = await this.ask(bot, [{
      role: "user",
      content: [
        "Update the running summary of an older part of a chat between a user and an AI teammate.",
        "Keep decisions, facts, open tasks and preferences; drop small talk. At most 200 words. Reply with the summary only.",
        "",
        `Current summary:\n${previous?.text ?? "(none)"}`,
        "",
        `Messages to fold in:\n${pending.map((m) => `${m.role}: ${m.text}`).join("\n").slice(0, 24_000)}`,
      ].join("\n"),
    }]).catch(() => "");
    if (text.trim()) this.store.setChatSummary(bot.id, text.trim(), pending[pending.length - 1].at);
  }

  private owns(bot: Bot, id: string) {
    return this.store.get(id)?.botId === bot.id;
  }
}

/** Models sometimes wrap JSON in prose or code fences. */
function parseJSON(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

/** Cheap guard against storing credentials. */
function looksSecret(text: string) {
  return /\b(sk-[a-z0-9-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/i.test(text)
    || /\b(password|senha|passcode)\s*[:=]\s*\S+/i.test(text)
    || /\b(?:\d[ -]?){13,19}\b/.test(text);
}
