import { randomUUID } from "node:crypto";
import type { Bot } from "../bots/bots.ts";
import { ASK_BOT_TOOL, COMPUTER_TOOLS, ROUTINE_TOOLS, SHARE_FILE_TOOL, runTool, suggestConnectionTool } from "../agent/tools.ts";
import { FileStore, readDeviceFile, writeDeviceFile, type Attachment } from "./files.ts";
import type { McpServers } from "../mcp/servers.ts";
import { MessageStore } from "./messages.ts";
import type { Routines } from "../routines/routines.ts";
import { MEMORY_TOOLS, VERBATIM_MESSAGES, type MemoryService } from "../memory/memory.ts";
import type { Hands } from "../hands/types.ts";
import type { RunOutcome } from "../routines/routines.ts";
import { provider } from "./providers.ts";
import type { ChatMessage, ChatProvider, ContentPart } from "./types.ts";

export interface Message {
  id: string;
  botId: string;
  /** "activity" lines record what the bot did on its computer. */
  role: "user" | "assistant" | "activity";
  text: string;
  at: string;
  /** Human-readable problem (assistant replies) or a failed step (activity). */
  error?: string;
  /** Technical detail behind an error, shown only on request. */
  detail?: string;
  /** Set on the prompt a routine posted, so the chat can label it. */
  routine?: { id: string; name: string };
  /** Set on a prompt another bot sent through ask_bot. */
  from?: { botId: string; name: string };
  /** Files the bot handed over (share_file), downloadable from the chat. */
  files?: Attachment[];
  /** A card asking the user to connect (or allow) an app the bot needs. */
  connect?: ConnectRequest;
  /** A note from Local Bot itself (e.g. "Notion is connected"), not the user. */
  notice?: boolean;
}

export interface ConnectRequest {
  connector: string;
  name: string;
  description: string;
  /** "connect": sign in first; "allow": signed in, not on for this bot yet. */
  mode: "connect" | "allow";
  reason?: string;
  state: "pending" | "connected" | "dismissed";
}

export interface Workplace {
  hands: Hands;
  computerName: string;
}

type Emit = (event: string, data: unknown) => void;
type FindWorkplace = (bot: Bot) => Promise<Workplace | null>;
/** All bots, for delegation. */
type Team = () => Bot[];

interface TurnOptions {
  routine?: Message["routine"];
  from?: Message["from"];
  /** Posted by Local Bot itself (an app got connected). */
  notice?: boolean;
  /** Files the user sent with the message. */
  files?: Attachment[];
  /** Bots already working on this request, outermost first (prevents loops). */
  chain?: string[];
}

/** How many past messages go back verbatim; older ones live in the chat summary. */
const HISTORY_LIMIT = VERBATIM_MESSAGES;
/**
 * There is no step limit: a bot works until it answers, the user presses Stop,
 * or the device goes off. To keep long runs inside the model's context, only
 * the latest tool outputs stay verbatim; older ones are shortened.
 */
const RECENT_TOOL_OUTPUTS = 20;
const OLD_TOOL_OUTPUT_CHARS = 300;
/** How many hops a request may travel: A → B → C, no further. */
const MAX_DELEGATION_HOPS = 2;
/** How long to wait for a busy teammate, and for a teammate's answer. */
const BUSY_WAIT_MS = 90_000;
const DELEGATION_TIMEOUT_MS = 10 * 60_000;

export class Conversations {
  private messages = new MessageStore();
  private running = new Map<string, AbortController>();

  private routines?: Routines;
  private memory?: MemoryService;
  private mcp?: McpServers;

  constructor(
    private emit: Emit,
    private workplace: FindWorkplace,
    private team: Team = () => [],
    /** Which model client a bot talks to; injectable so tests can use a scripted fake. */
    private chatWith: (bot: Bot) => ChatProvider = (bot) => provider(bot.provider),
    readonly files = new FileStore(),
  ) {}

  /** Routines are built on top of conversations, so they're attached afterwards. */
  attachRoutines(routines: Routines) {
    this.routines = routines;
  }

  attachMemory(memory: MemoryService) {
    this.memory = memory;
  }

  /** Tools from MCP servers, for bots that have them switched on. */
  attachMcp(mcp: McpServers) {
    this.mcp = mcp;
  }

  history(botId: string) {
    return this.messages.forBot(botId);
  }

  /** A page of a chat, newest last: the last `limit` before `before` (an id). */
  page(botId: string, limit = 100, before?: string) {
    return this.messages.page(botId, Math.max(1, Math.min(limit, 500)), before);
  }

  /** Takes a chat moved from another brain. */
  importHistory(botId: string, messages: Message[]) {
    this.messages.removeBot(botId);
    for (const m of messages) this.messages.upsert({ ...m, botId });
  }

  isBusy(botId: string) {
    return this.running.has(botId);
  }

  /** Factory reset: stops everything and drops every chat. */
  reset() {
    for (const [, run] of this.running) run.abort();
    this.messages.clear();
    this.files.clearAll();
  }

  clear(botId: string) {
    this.stop(botId);
    this.messages.removeBot(botId);
    this.files.clear(botId);
    // Clearing the chat drops its summary too; long-term memories stay.
    this.memory?.store.clearChatSummary(botId);
  }

  stop(botId: string) {
    this.running.get(botId)?.abort();
  }

  /** Records the user's message and runs the bot in the background; progress arrives as events. */
  async send(bot: Bot, text: string, files: Attachment[] = []) {
    const { userId } = this.start(bot, text || (files.length ? "(sent files)" : ""), { files });
    return { userId };
  }

  /** Runs a routine's task as a turn in the bot's chat and resolves when it ends. */
  runRoutine(bot: Bot, routine: { id: string; name: string; task: string }): Promise<RunOutcome> {
    return this.start(bot, routine.task, { routine: { id: routine.id, name: routine.name } }).done;
  }

  private start(bot: Bot, text: string, opts: TurnOptions = {}) {
    const { routine, from, notice, files } = opts;
    const chain = opts.chain ?? [bot.id];
    if (this.running.has(bot.id)) throw new Error(`${bot.name} is still working`);
    const prompt = text.trim();
    if (!prompt) throw new Error("Empty message");

    const user = this.add({ botId: bot.id, role: "user", text: prompt, ...(routine ? { routine } : {}), ...(from ? { from } : {}), ...(notice ? { notice } : {}), ...(files?.length ? { files } : {}) });
    this.emit("message", user);

    const abort = new AbortController();
    this.running.set(bot.id, abort);
    this.emit("bot.status", { botId: bot.id, status: "thinking" });

    const done = this.run(bot, abort.signal, chain, !!routine)
      .catch((err): RunOutcome => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      .then((outcome) => {
        this.learn(bot, user, outcome);
        return outcome;
      })
      .finally(() => {
        this.running.delete(bot.id);
        this.emit("bot.status", { botId: bot.id, status: "idle" });
      });
    return { userId: user.id, done };
  }

  private async run(bot: Bot, signal: AbortSignal, chain: string[], inRoutine = false): Promise<RunOutcome> {
    const teammates = chain.length <= MAX_DELEGATION_HOPS ? this.teammates(chain) : [];
    // A routine run may look at routines but not create more (no runaway chains).
    const routineTools = !this.routines ? [] : inRoutine ? ROUTINE_TOOLS.filter((t) => t.name === "list_routines") : ROUTINE_TOOLS;
    const servers = bot.mcpServers ?? [];
    const mcpTools = this.mcp ? await this.mcp.toolsFor(servers) : [];
    // Apps it could ask the user to connect (or to allow for this bot).
    const offers = this.mcp ? this.mcp.connectorsFor(servers).filter((c) => c.status !== "ready") : [];
    const connectTool = offers.length ? [suggestConnectionTool(offers.map((c) => c.id))] : [];
    const tools = [...(teammates.length ? [ASK_BOT_TOOL] : []), ...routineTools, ...(this.memory ? MEMORY_TOOLS : []), ...mcpTools, ...connectTool];
    let lastReply: string | undefined;
    let place: Workplace | null = null;
    try {
      place = await this.workplace(bot);
    } catch (err) {
      this.failure(bot, "Couldn’t reach the device", err);
    }
    // Files the user just sent go to the device first, so the bot is told where.
    if (place) await this.deliverFiles(bot, place);
    const transcript: ChatMessage[] = [
      { role: "system", content: this.system(bot, place, teammates) },
      ...(offers.length
        ? [{
            role: "system" as const,
            content: "Apps the user can connect for you (use suggest_connection when a task needs one you don't have):\n" +
              offers.map((c) => `- ${c.id}: ${c.name} (${c.description})${c.status === "allow" ? " — already connected, needs the user's OK for you" : ""}`).join("\n"),
          }]
        : []),
      ...(this.memory ? [{ role: "system" as const, content: this.memory.context(bot, this.lastPrompt(bot)) }] : []),
      ...this.summary(bot),
      ...this.past(bot),
      // Restated after the history so earlier turns can't override the current state.
      {
        role: "system",
        content: place
          ? `Current state: you have the device "${place.computerName}" and can use it now.`
          : "Current state: you have NO device right now. Earlier messages may mention one you no longer have; don't claim to see or use a screen.",
      },
    ];

    if (place) {
      try {
        transcript.push(await this.look(place.hands, "Current screen of your device:"));
      } catch (err) {
        this.failure(bot, "Couldn’t see the screen", err);
      }
    }

    while (!signal.aborted) {
      const reply = this.draft(bot);
      let result;
      try {
        result = await this.chatWith(bot).chat({
          model: bot.model,
          messages: transcript,
          tools: place ? [...COMPUTER_TOOLS, SHARE_FILE_TOOL, ...tools] : tools.length ? tools : undefined,
          signal,
          onDelta: (delta) => {
            reply.text += delta;
            this.emit("message.delta", { id: reply.id, botId: bot.id, delta });
          },
        });
      } catch (err) {
        if (!signal.aborted) {
          reply.error = friendlyProviderError(err);
          reply.detail = err instanceof Error ? err.message : String(err);
        }
        this.finish(reply);
        return signal.aborted ? { ok: false, error: "Stopped" } : { ok: false, error: reply.error };
      }
      this.finish(reply);
      if (reply.text.trim()) lastReply = reply.text.trim();
      if (!result.toolCalls.length) return { ok: true, reply: lastReply };

      transcript.push({
        role: "assistant",
        content: result.text,
        tool_calls: result.toolCalls.map((c) => ({
          id: c.id || randomUUID(),
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments || "{}" },
        })),
      });

      let visual = false;
      for (const call of (transcript.at(-1) as Extract<ChatMessage, { role: "assistant" }>).tool_calls!) {
        if (signal.aborted) return { ok: false, error: "Stopped" };
        let content: string;
        if (this.memory && MEMORY_TOOLS.some((t) => t.name === call.function.name)) {
          const out = this.memory.tool(bot, call.function.name, call.function.arguments);
          if (out.activity) this.activity(bot, out.activity);
          transcript.push({ role: "tool", tool_call_id: call.id, content: out.result });
          continue;
        }
        if (ROUTINE_TOOLS.some((t) => t.name === call.function.name)) {
          content = this.routineTool(bot, call.function.name, call.function.arguments);
          transcript.push({ role: "tool", tool_call_id: call.id, content });
          continue;
        }
        if (call.function.name === ASK_BOT_TOOL.name) {
          content = await this.delegate(bot, chain, call.function.arguments, signal);
          transcript.push({ role: "tool", tool_call_id: call.id, content });
          continue;
        }
        if (call.function.name === "suggest_connection") {
          content = this.suggestConnection(bot, offers, call.function.arguments);
          transcript.push({ role: "tool", tool_call_id: call.id, content });
          continue;
        }
        if (this.mcp && mcpTools.some((t) => t.name === call.function.name)) {
          const out = await this.mcp.call(servers, call.function.name, call.function.arguments);
          if (out) {
            this.activity(bot, out.activity);
            transcript.push({ role: "tool", tool_call_id: call.id, content: out.result });
            continue;
          }
        }
        if (!place) {
          transcript.push({ role: "tool", tool_call_id: call.id, content: "Error: you have no device to do that." });
          continue;
        }
        if (call.function.name === SHARE_FILE_TOOL.name) {
          content = await this.shareFiles(bot, place.hands, call.function.arguments);
          transcript.push({ role: "tool", tool_call_id: call.id, content });
          continue;
        }
        try {
          const outcome = await runTool(place.hands, call.function.name, call.function.arguments);
          this.activity(bot, outcome.activity);
          visual ||= outcome.visual;
          content = outcome.result;
        } catch (err) {
          if (deviceOff(err)) {
            this.failure(bot, "The device was turned off, so I stopped", err);
            return { ok: false, error: "The device is off." };
          }
          content = `Error: ${err instanceof Error ? err.message : err}`;
          this.failure(bot, `Couldn’t ${stepVerb(call.function.name)}`, err);
        }
        transcript.push({ role: "tool", tool_call_id: call.id, content });
      }
      shortenOldToolOutputs(transcript);

      if (visual && place) {
        await new Promise((r) => setTimeout(r, 600));
        try {
          dropOldScreens(transcript);
          transcript.push(await this.look(place.hands, "Screen after the actions:"));
        } catch (err) {
          if (deviceOff(err)) {
            this.failure(bot, "The device was turned off, so I stopped", err);
            return { ok: false, error: "The device is off." };
          }
          this.failure(bot, "Couldn’t see the screen", err);
        }
      }
    }
    return { ok: false, error: "Stopped" };
  }

  /** The latest prompt in this bot's chat: what the memory search is about. */
  private lastPrompt(bot: Bot) {
    const prompts = this.history(bot.id).filter((m) => m.role === "user");
    return prompts[prompts.length - 1]?.text ?? "";
  }

  /** The gist of the chat beyond the verbatim window, if any. */
  private summary(bot: Bot): ChatMessage[] {
    const s = this.memory?.store.chatSummary(bot.id);
    return s ? [{ role: "system", content: `Summary of the earlier part of this chat:\n${s.text}` }] : [];
  }

  /**
   * After a finished turn: consolidate what was learned into long-term memory
   * and fold old chat into the summary. Background work; never blocks the chat.
   */
  private learn(bot: Bot, prompt: Message, outcome: RunOutcome) {
    if (!this.memory || !outcome.reply) return;
    const current = this.team().find((b) => b.id === bot.id) ?? bot;
    const history = this.history(bot.id);
    if ((current as Bot & { memoryAuto?: boolean }).memoryAuto !== false) {
      const steps = history.filter((m) => m.role === "activity" && m.at >= prompt.at).map((m) => m.text);
      void this.memory.consolidate(current, { request: prompt.text, steps, reply: outcome.reply, startedAt: prompt.at }).catch(() => {});
    }
    void this.memory.compact(current, history).catch(() => {});
  }

  /** create_routine / list_routines / delete_routine, always scoped to this bot. */
  private routineTool(bot: Bot, name: string, rawArgs: string): string {
    if (!this.routines) return "Error: routines aren't available.";
    let a: any;
    try {
      a = JSON.parse(rawArgs || "{}");
    } catch {
      return "Error: invalid arguments.";
    }
    const mine = () => this.routines!.list(bot.id);
    try {
      switch (name) {
        case "create_routine": {
          const r = this.routines.create({ botId: bot.id, name: String(a.name ?? ""), task: String(a.task ?? ""), schedule: a.schedule });
          const next = r.nextRunAt ? new Date(r.nextRunAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "not scheduled";
          this.activity(bot, `Created routine “${r.name}” · ${r.scheduleText}`);
          return `Created routine "${r.name}" (${r.scheduleText}). Next run: ${next}.`;
        }
        case "list_routines": {
          const list = mine();
          if (!list.length) return "You have no routines.";
          return list.map((r) =>
            `- ${r.name}: ${r.scheduleText}; ${r.enabled ? "on" : "off"}; last: ${r.lastStatus ?? "never ran"}` +
            `${r.nextRunAt && r.enabled ? `; next: ${new Date(r.nextRunAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}` : ""}` +
            `\n  task: ${r.task}`).join("\n");
        }
        case "delete_routine": {
          const wanted = String(a.name ?? "").trim().toLowerCase();
          const r = mine().find((x) => x.name.toLowerCase() === wanted) ?? mine().find((x) => x.name.toLowerCase().includes(wanted) && wanted.length >= 3);
          if (!r) return `Error: no routine called "${a.name}". Your routines: ${mine().map((x) => x.name).join(", ") || "none"}.`;
          this.routines.delete(r.id);
          this.activity(bot, `Deleted routine “${r.name}”`);
          return `Deleted routine "${r.name}".`;
        }
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
    return "Error: unknown routine tool.";
  }

  /** Bots that can be asked from this request: everyone not already in the chain. */
  private teammates(chain: string[]) {
    return this.team().filter((b) => !chain.includes(b.id));
  }

  /**
   * ask_bot: runs the request as a turn in the teammate's own chat (on their
   * device, with their tools) and returns their final reply as the tool result.
   */
  private async delegate(from: Bot, chain: string[], rawArgs: string, signal: AbortSignal): Promise<string> {
    let args: { bot?: string; message?: string };
    try {
      args = JSON.parse(rawArgs || "{}");
    } catch {
      return "Error: invalid arguments for ask_bot.";
    }
    const message = String(args.message ?? "").trim();
    if (!message) return "Error: the message is empty.";

    const others = this.team().filter((b) => b.id !== from.id);
    const wanted = String(args.bot ?? "").trim().toLowerCase();
    const target =
      others.find((b) => b.name.toLowerCase() === wanted) ??
      others.find((b) => b.name.toLowerCase().startsWith(wanted) && wanted.length >= 2);
    if (!target) {
      return `Error: no teammate called "${args.bot}". Teammates: ${others.map((b) => b.name).join(", ") || "none"}.`;
    }
    if (chain.includes(target.id)) {
      return `Error: ${target.name} is already part of this request; asking them would create a loop.`;
    }
    if (chain.length > MAX_DELEGATION_HOPS) {
      return "Error: this request has been passed along too many times; finish it yourself.";
    }

    this.activity(from, `Asked ${target.name}: “${message.length > 90 ? `${message.slice(0, 90)}…` : message}”`);

    // Wait for a busy teammate a little, then give up.
    const waitUntil = Date.now() + BUSY_WAIT_MS;
    while (this.isBusy(target.id)) {
      if (signal.aborted) return "Error: stopped.";
      if (Date.now() > waitUntil) {
        this.failure(from, `${target.name} was busy`, new Error(`${target.name} was busy for over ${BUSY_WAIT_MS / 1000}s`));
        return `Error: ${target.name} is busy with another task right now.`;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }

    const turn = this.start(target, message, { from: { botId: from.id, name: from.name }, chain: [...chain, target.id] });
    // Stopping the asker stops the teammate too.
    const stopTarget = () => this.stop(target.id);
    signal.addEventListener("abort", stopTarget, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<RunOutcome>((resolve) => {
      timer = setTimeout(() => {
        this.stop(target.id);
        resolve({ ok: false, error: `No answer within ${DELEGATION_TIMEOUT_MS / 60_000} minutes` });
      }, DELEGATION_TIMEOUT_MS);
    });
    const outcome = await Promise.race([turn.done, timeout]);
    clearTimeout(timer);
    signal.removeEventListener("abort", stopTarget);

    if (!outcome.ok) {
      this.failure(from, `${target.name} couldn’t finish`, new Error(outcome.error ?? "unknown error"));
      return `Error: ${target.name} couldn’t finish: ${outcome.error ?? "unknown error"}.`;
    }
    const reply = outcome.reply ?? "(no text reply)";
    this.activity(from, `${target.name} replied: “${reply.length > 120 ? `${reply.slice(0, 120)}…` : reply}”`);
    return `${target.name} replied:\n${reply}`;
  }

  private async look(hands: Hands, caption: string): Promise<ChatMessage> {
    const shot = await hands.screenshot();
    return {
      role: "user",
      content: [
        { type: "text", text: `${caption} (${shot.width}x${shot.height})` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${shot.png}` } },
      ],
    };
  }

  /** Copies files off the device and posts them in the chat as one message. */
  private async shareFiles(bot: Bot, hands: Hands, rawArgs: string): Promise<string> {
    let paths: string[];
    try {
      paths = (JSON.parse(rawArgs || "{}").paths ?? []).map(String).filter(Boolean).slice(0, 10);
    } catch {
      return "Error: invalid arguments.";
    }
    if (!paths.length) return "Error: give the absolute paths of the files.";
    const shared: Attachment[] = [];
    const problems: string[] = [];
    for (const path of paths) {
      try {
        shared.push(this.files.save(bot.id, path.split("/").pop() || "file", await readDeviceFile(hands, path)));
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (shared.length) this.emit("message", this.add({ botId: bot.id, role: "assistant", text: "", files: shared }));
    for (const p of problems) this.failure(bot, "Couldn’t share a file", new Error(p));
    return [
      shared.length && `Shared with the user: ${shared.map((f) => f.name).join(", ")}. They can download them from the chat.`,
      ...problems.map((p) => `Error: ${p}`),
    ].filter(Boolean).join("\n");
  }

  /** Posts a Connect (or Allow) card in the chat for an app the bot needs. */
  private suggestConnection(bot: Bot, offers: { id: string; name: string; description: string; status: string }[], rawArgs: string) {
    let args: { connector?: string; reason?: string } = {};
    try { args = JSON.parse(rawArgs || "{}"); } catch {}
    const c = offers.find((o) => o.id === args.connector);
    if (!c) return "Error: that app isn't one the user can connect.";
    const request: ConnectRequest = {
      connector: c.id, name: c.name, description: c.description,
      mode: c.status === "allow" ? "allow" : "connect",
      reason: args.reason?.slice(0, 200), state: "pending",
    };
    this.emit("message", this.add({ botId: bot.id, role: "assistant", text: "", connect: request }));
    return `Asked the user to ${request.mode === "allow" ? "allow" : "connect"} ${c.name}. Don't go on with the task now: ` +
      "tell them in one short sentence that you'll continue once it's done. You'll get a message when it is.";
  }

  /**
   * An app got connected (or allowed for one bot): mark the waiting cards and
   * let those bots continue where they stopped.
   */
  connectorReady(connector: string, onlyBot?: string) {
    const waiting = this.messages.where((m) => m.connect?.connector === connector && m.connect.state === "pending"
      && (!onlyBot || m.botId === onlyBot));
    const bots = new Set<string>();
    for (const m of waiting) {
      this.emit("message", this.messages.upsert({ ...m, connect: { ...m.connect!, state: "connected" } }));
      bots.add(m.botId);
    }
    for (const id of bots) {
      const bot = this.team().find((b) => b.id === id);
      const name = waiting.find((m) => m.botId === id)!.connect!.name;
      if (!bot || this.running.has(id)) continue;
      try {
        this.start(bot, `${name} is connected now. Continue the task you were working on.`, { notice: true });
      } catch (err) {
        process.stderr.write(`[brain] couldn’t continue after connecting: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  /** "Not now" on a Connect card. */
  dismissConnect(messageId: string) {
    const m = this.messages.get(messageId);
    if (!m?.connect) return;
    this.emit("message", this.messages.upsert({ ...m, connect: { ...m.connect, state: "dismissed" } }));
  }

  /** A shared file's contents, for the app to save or preview. */
  /**
   * A shared file for the app: its path when the app can read this disk
   * (`inline: false`), else its bytes in base64 (a brain in the cloud).
   */
  readFile(botId: string, fileId: string, inline = true) {
    const file = this.history(botId).flatMap((m) => m.files ?? []).find((f) => f.id === fileId);
    if (!file) throw new Error("That file is no longer in the chat");
    if (!inline) return { ...file, path: this.files.path(botId, file) };
    return { ...file, data: this.files.read(botId, file).toString("base64") };
  }

  private system(bot: Bot, place: Workplace | null, teammates: Bot[]) {
    return [
      `You are ${bot.name}, a bot in Local Bot.`,
      `Now: ${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`,
      bot.role && `Your role: ${bot.role}.`,
      bot.instructions,
      place
        ? [
            `You work on the device "${place.computerName}" and can operate it with the tools.`,
            place.hands.describe(),
            "How to work:",
            "- Look at the screenshot before acting; coordinates are pixels of the latest screenshot.",
            "- Prefer keyboard shortcuts (ctrl+l for the address bar, Return to confirm).",
            "- To open websites, use open_app with firefox-esr and the URL.",
            "- After every action you get a fresh screenshot; check the result before moving on.",
            "- When you create or download a file the user wants (report, PDF, spreadsheet, image), send it with share_file so they can download it; don't just say where it is on the device.",
            "- Never make purchases, send messages or delete things irreversibly without asking the user first.",
            "- When you are done, reply to the user with a short summary of what you did.",
          ].join("\n")
        : "You don't have a running device yet. If the task needs one, tell the user to start or assign a device.",
      teammates.length
        ? [
            "Your teammates (other bots). Use ask_bot to hand them work that fits their role or needs their device:",
            ...teammates.map((t) => `- ${t.name}${t.role ? `: ${t.role}` : ""}`),
          ].join("\n")
        : "",
      "When the user asks for something recurring or for later (\"every morning…\", \"tomorrow at 9…\"), create a routine with create_routine instead of only promising to do it. Confirm the name and schedule back to them.",
      "Messages marked [Scheduled routine] run on a schedule while the user may be away: do the whole task without asking questions, then end with a short report of what you did and found.",
      "Messages marked [From bot …] come from a teammate, not the user: do what they ask and end with a clear, self-contained answer; that answer is sent back to them. Ask them questions only if you truly can't proceed.",
      "Reply in the same language the user writes in, and be direct.",
    ].filter(Boolean).join("\n\n");
  }

  /** Copies the files of the user's latest message to the device (once). */
  private async deliverFiles(bot: Bot, place: Workplace) {
    const last = this.history(bot.id).filter((m) => m.role === "user").at(-1);
    const pending = last?.files?.filter((f) => !f.devicePath) ?? [];
    if (!last || !pending.length) return;
    const files = [...last.files!];
    for (const f of pending) {
      try {
        const path = await writeDeviceFile(place.hands, "~/Downloads", f.name, this.files.read(bot.id, f));
        files[files.indexOf(f)] = { ...f, devicePath: path };
      } catch (err) {
        this.failure(bot, `Couldn’t put ${f.name} on the device`, err);
      }
    }
    this.emit("message", this.messages.upsert({ ...last, files }));
  }

  /**
   * The user's message as the model sees it: the text, where the files are on
   * the device, small text files inline and, for the latest message, the
   * images themselves (the model can look at them).
   */
  private userContent(bot: Bot, m: Message, latest: boolean): ChatMessage["content"] {
    const files = m.files ?? [];
    const notes = files.map((f) => `- ${f.name} (${f.mime}, ${f.size} bytes)${f.devicePath ? ` — on your device at ${f.devicePath}` : ""}`);
    let text = m.text === "(sent files)" ? "" : m.text;
    if (notes.length) text += `${text ? "\n\n" : ""}[The user sent ${files.length === 1 ? "a file" : "files"}:\n${notes.join("\n")}]`;
    if (!latest) return text;
    const parts: ContentPart[] = [];
    for (const f of files) {
      if (/^(text\/|application\/json)/.test(f.mime) && f.size <= 40_000) {
        try { text += `\n\n--- ${f.name} ---\n${this.files.read(bot.id, f).toString("utf8")}`; } catch {}
      }
    }
    parts.push({ type: "text", text });
    for (const f of files.filter((x) => /^image\/(png|jpeg|gif|webp)$/.test(x.mime) && x.size <= 5_000_000).slice(0, 4)) {
      try {
        parts.push({ type: "image_url", image_url: { url: `data:${f.mime};base64,${this.files.read(bot.id, f).toString("base64")}` } });
      } catch {}
    }
    return parts.length > 1 ? parts : text;
  }

  private past(bot: Bot): ChatMessage[] {
    const list = this.history(bot.id)
      .filter((m) => (m.role === "user" || m.role === "assistant") && !m.error && (m.text || m.files?.length || m.connect))
      .slice(-HISTORY_LIMIT);
    const lastUser = list.filter((m) => m.role === "user").at(-1);
    return list
      .map((m): ChatMessage => m.role === "user" && m.files?.length
        ? { role: "user" as const, content: this.userContent(bot, m, m === lastUser) as any }
        : {
        role: m.role as "user" | "assistant",
        content: m.files?.length && !m.text
          ? `(Shared files: ${m.files.map((f) => f.name).join(", ")})`
          : m.routine
          ? `[Scheduled routine “${m.routine.name}”] ${m.text}`
          : m.from
            ? `[From bot “${m.from.name}”] ${m.text}`
            : m.notice
              ? `[Local Bot] ${m.text}`
              : m.connect
                ? `(Asked the user to ${m.connect.mode} ${m.connect.name}: ${m.connect.state})`
                : m.text,
      });
  }

  private draft(bot: Bot): Message {
    const msg: Message = { id: randomUUID(), botId: bot.id, role: "assistant", text: "", at: new Date().toISOString() };
    this.emit("message", msg);
    return msg;
  }

  /** Persists a streamed reply; empty ones (pure tool calls) are dropped from the chat. */
  private finish(msg: Message) {
    if (msg.text.trim() || msg.error) this.messages.upsert(msg);
    this.emit("message.done", { ...msg, empty: !msg.text.trim() && !msg.error });
  }

  /** A failed step: a short human title, plus why, plus the raw error for "Details". */
  private failure(bot: Bot, title: string, err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    this.emit("message", this.add({ botId: bot.id, role: "activity", text: title, error: friendlyDeviceError(raw), detail: raw }));
  }

  private activity(bot: Bot, text: string) {
    this.emit("message", this.add({ botId: bot.id, role: "activity", text }));
  }

  private add(m: Omit<Message, "id" | "at">): Message {
    return this.messages.upsert({ ...m, id: randomUUID(), at: new Date().toISOString() });
  }
}

/** Plain-language reason for a device-side failure. */
function friendlyDeviceError(raw: string): string {
  if (/is not running|No such container/i.test(raw)) return "The device is off.";
  if (/session has ended|session_ended/i.test(raw)) return "Lost the session with the device’s controls.";
  if (/daemon is not running|cua-driver\.sock|ECONNREFUSED/i.test(raw)) return "The device’s controls aren’t running.";
  if (/timed out|ETIMEDOUT|killed/i.test(raw)) return "The device took too long to respond.";
  if (/permission|not permitted|refused/i.test(raw)) return "The device didn’t allow that action.";
  return "Something went wrong on the device.";
}

/** Plain-language reason for a model/provider failure. */
function friendlyProviderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/no api key|has no API key/i.test(raw)) return "This bot’s AI provider has no API key. Add one in Settings.";
  if (/\b401\b|unauthori[sz]ed|invalid api key/i.test(raw)) return "The AI provider rejected the API key. Check it in Settings.";
  if (/\b402\b|credits|insufficient/i.test(raw)) return "The AI provider account is out of credits.";
  if (/\b429\b|rate limit/i.test(raw)) return "The AI provider is rate limiting. Try again in a moment.";
  if (/\b404\b|model.*not found|no endpoints/i.test(raw)) return "This model isn’t available. Pick another in the bot settings.";
  if (/not set up|Unknown provider/i.test(raw)) return "This bot’s AI provider was removed. Pick another in the bot settings.";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(raw)) return "Couldn’t reach the AI provider. Check your connection.";
  if (/\b5\d\d\b/.test(raw)) return "The AI provider had a problem. Try again.";
  return "The AI provider returned an error.";
}

const stepVerb = (tool: string) =>
  ({ click: "click", type_text: "type", press_key: "press the key", hotkey: "use the shortcut", scroll: "scroll",
     open_app: "open the app", shell: "run the command", screenshot: "see the screen", wait: "wait",
     ask_bot: "ask the teammate", create_routine: "create the routine", delete_routine: "delete the routine",
     list_routines: "list routines", remember: "save the memory", recall: "search memory", forget: "forget the memory" } as Record<string, string>)[tool] ?? tool;

/** Docker reports a stopped container this way; there is no point retrying. */
function deviceOff(err: unknown) {
  return /is not running|No such container/i.test(err instanceof Error ? err.message : String(err));
}

/** Keeps only the newest screenshot in context; older ones become a short note. */
/** Keeps the latest tool outputs whole and trims older ones, so a long run fits the context. */
export function shortenOldToolOutputs(transcript: ChatMessage[]) {
  const tools = transcript.filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool");
  for (const m of tools.slice(0, -RECENT_TOOL_OUTPUTS)) {
    if (typeof m.content === "string" && m.content.length > OLD_TOOL_OUTPUT_CHARS) {
      m.content = `${m.content.slice(0, OLD_TOOL_OUTPUT_CHARS)}\n…(older output shortened)`;
    }
  }
}

function dropOldScreens(transcript: ChatMessage[]) {
  for (const m of transcript) {
    if (m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) {
      m.content = m.content.map((p): ContentPart => (p.type === "image_url" ? { type: "text", text: "(older screenshot omitted)" } : p));
    }
  }
}
