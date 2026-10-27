import type { ToolSpec } from "../chat/types.ts";
import type { Hands } from "../hands/types.ts";

/**
 * Computer tools offered to the model. Coordinates are pixels of the latest
 * screenshot. After any GUI action the loop attaches a fresh screenshot, so
 * the model always sees the result of what it did.
 */
const point = {
  x: { type: "number", description: "X coordinate in screenshot pixels" },
  y: { type: "number", description: "Y coordinate in screenshot pixels" },
};

export const COMPUTER_TOOLS: ToolSpec[] = [
  {
    name: "screenshot",
    description: "Captures the whole device screen.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "click",
    description: "Clicks a point on the screen.",
    parameters: {
      type: "object",
      properties: {
        ...point,
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: { type: "boolean", description: "Double click" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "type_text",
    description: "Types text into the focused element (click the field first).",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "press_key",
    description: "Presses one key, e.g. Return, Tab, Escape, BackSpace, Down, Page_Down.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "hotkey",
    description: "Presses a key combination, e.g. [\"ctrl\",\"l\"] (address bar) or [\"ctrl\",\"t\"] (new tab).",
    parameters: {
      type: "object",
      properties: { keys: { type: "array", items: { type: "string" } } },
      required: ["keys"],
    },
  },
  {
    name: "scroll",
    description: "Scrolls at a point on the screen.",
    parameters: {
      type: "object",
      properties: {
        ...point,
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["x", "y", "direction"],
    },
  },
  {
    name: "open_app",
    description: "Opens an app, optionally with URLs or files. E.g. name=\"firefox-esr\", urls=[\"https://google.com\"].",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, urls: { type: "array", items: { type: "string" } } },
      required: ["name"],
    },
  },
  {
    name: "shell",
    description: "Runs a bash command on the device and returns its output. Use it for files, downloads and scripts, not to open GUI apps.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "wait",
    description: "Waits a few seconds (page loading, etc.).",
    parameters: { type: "object", properties: { seconds: { type: "number", minimum: 1, maximum: 15 } }, required: ["seconds"] },
  },
];

/** Hands files from the device to the user as downloadable cards in the chat. */
export const SHARE_FILE_TOOL: ToolSpec = {
  name: "share_file",
  description:
    "Sends files from your device to the user's chat, where they can preview and download them. " +
    "Use it whenever you made or downloaded a file the user asked for (a PDF, spreadsheet, image…). Absolute paths; up to 10 files, 50 MB each.",
  parameters: {
    type: "object",
    properties: { paths: { type: "array", items: { type: "string" }, description: "Absolute paths on the device" } },
    required: ["paths"],
  },
};

/**
 * Asks the user to connect an app (Settings → Connectors) when a task needs
 * it and the bot doesn't have it. The chat shows a Connect card; the bot is
 * told to continue once it's connected. `ids` are the connectors it may ask for.
 */
export function suggestConnectionTool(ids: string[]): ToolSpec {
  return {
    name: "suggest_connection",
    description:
      "Asks the user to connect one of their apps so you can use it. Use it when the task needs that app and you don't have its tools. " +
      "Then stop and say briefly that you'll continue once it's connected; you'll be told when it is.",
    parameters: {
      type: "object",
      properties: {
        connector: { type: "string", enum: ids },
        reason: { type: "string", description: "One short sentence: what you need it for" },
      },
      required: ["connector"],
    },
  };
}

/** Delegation between bots; offered whenever the bot has teammates. */
export const ASK_BOT_TOOL: ToolSpec = {
  name: "ask_bot",
  description:
    "Ask a teammate bot to do something and wait for its answer. Use it when the task fits a teammate's role better, " +
    "or needs their device or logins. Give them a complete, self-contained request; you get their final reply back.",
  parameters: {
    type: "object",
    properties: {
      bot: { type: "string", description: "The teammate's name" },
      message: { type: "string", description: "What you need from them, with all the context they need" },
    },
    required: ["bot", "message"],
  },
};

/** The bot managing its own routines when the user asks ("every morning, do X"). */
export const ROUTINE_TOOLS: ToolSpec[] = [
  {
    name: "create_routine",
    description:
      "Create a routine: a task you will do on your own on a schedule. Use it when the user asks for something " +
      "recurring or at a later time. Times are the user's local time.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name, e.g. 'Morning inbox summary'" },
        task: { type: "string", description: "Complete, self-contained instructions for each run" },
        schedule: {
          type: "object",
          description:
            "One of: {kind:'daily', time:'HH:MM', days:[0-6] (0=Sunday; [] = every day)} | " +
            "{kind:'interval', every:N, unit:'minutes'|'hours'} (minimum 5 minutes) | " +
            "{kind:'once', at:'YYYY-MM-DDTHH:MM'} (local time, no timezone)",
          properties: {
            kind: { type: "string", enum: ["daily", "interval", "once"] },
            time: { type: "string" },
            days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
            every: { type: "integer", minimum: 1 },
            unit: { type: "string", enum: ["minutes", "hours"] },
            at: { type: "string" },
          },
          required: ["kind"],
        },
      },
      required: ["name", "task", "schedule"],
    },
  },
  {
    name: "list_routines",
    description: "List your routines with their schedule, status and next run.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "delete_routine",
    description: "Delete one of your routines by name (when the user asks to cancel or remove it).",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

export const WAKEUP_TOOLS: ToolSpec[] = [
  {
    name: "schedule_wakeup",
    description:
      "Wake yourself up later to continue the current task, when something takes time (a download, a build, a reply, a page " +
      "that updates). When it's due you'll take a quick look and decide whether to work, sleep again, or stop. One at a time: " +
      "a new one replaces the previous. Not for recurring tasks the user asked for; those are routines.",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "integer", minimum: 1, maximum: 1440, description: "How long from now" },
        reason: { type: "string", description: "What to check and do when you wake up, self-contained" },
      },
      required: ["minutes", "reason"],
    },
  },
  {
    name: "cancel_wakeup",
    description: "Cancel your scheduled wake-up (the task is done or no longer needed).",
    parameters: { type: "object", properties: {} },
  },
];

/** The quick look when a wake-up is due: exactly one of these. */
export const WAKE_CHECK_TOOLS: ToolSpec[] = [
  {
    name: "wake_continue",
    description: "There's work to do now (or you can't tell without looking at the device): start working.",
    parameters: {
      type: "object",
      properties: { instructions: { type: "string", description: "What to do now, for yourself" } },
      required: ["instructions"],
    },
  },
  {
    name: "wake_sleep",
    description: "It's too early (still waiting on something): sleep again and look later.",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "integer", minimum: 1, maximum: 1440 },
        reason: { type: "string", description: "What to check next time" },
      },
      required: ["minutes", "reason"],
    },
  },
  {
    name: "wake_done",
    description: "Nothing left to do for this: stop.",
    parameters: { type: "object", properties: { note: { type: "string", description: "One short line on why" } } },
  },
];

export interface ToolOutcome {
  /** Text sent back to the model as the tool result. */
  result: string;
  /** Human-readable line shown in the chat. */
  activity: string;
  /** Whether the screen probably changed (attach a fresh screenshot). */
  visual: boolean;
}

const MAX_SHELL_OUTPUT = 6000;

export async function runTool(hands: Hands, name: string, rawArgs: string): Promise<ToolOutcome> {
  let a: any;
  try {
    a = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return { result: `Invalid arguments: ${rawArgs}`, activity: `Invalid arguments for ${name}`, visual: false };
  }
  const done = (activity: string) => ({ result: "ok", activity, visual: true });

  switch (name) {
    case "screenshot":
      return { result: "Screenshot attached.", activity: "Looked at the screen", visual: true };
    case "click":
      await hands.act("click", { x: a.x, y: a.y, button: a.button ?? "left", ...(a.double ? { count: 2 } : {}) });
      return done(`${a.double ? "Double-clicked" : "Clicked"} at (${Math.round(a.x)}, ${Math.round(a.y)})`);
    case "type_text":
      await hands.act("type_text", { text: String(a.text) });
      return done(`Typed “${String(a.text).slice(0, 60)}”`);
    case "press_key":
      await hands.act("press_key", { key: String(a.key) });
      return done(`Pressed ${a.key}`);
    case "hotkey":
      await hands.act("hotkey", { keys: a.keys });
      return done(`Pressed ${(a.keys ?? []).join("+")}`);
    case "scroll":
      await hands.act("scroll", { x: a.x, y: a.y, direction: a.direction, amount: a.amount ?? 5 });
      return done(`Scrolled ${a.direction}`);
    case "open_app":
      await hands.act("launch_app", { name: String(a.name), ...(a.urls?.length ? { urls: a.urls } : {}) });
      await new Promise((r) => setTimeout(r, 2500));
      return done(`Opened ${a.name}${a.urls?.length ? ` at ${a.urls[0]}` : ""}`);
    case "shell": {
      const { code, output } = await hands.shell(String(a.command));
      const trimmed = output.length > MAX_SHELL_OUTPUT ? `${output.slice(0, MAX_SHELL_OUTPUT)}\n…(output truncated)` : output;
      return {
        result: `exit ${code}\n${trimmed || "(no output)"}`,
        activity: `Ran: ${String(a.command).slice(0, 80)}`,
        visual: false,
      };
    }
    case "wait":
      await new Promise((r) => setTimeout(r, Math.min(15, Math.max(1, Number(a.seconds) || 2)) * 1000));
      return done(`Waited ${a.seconds}s`);
    default:
      return { result: `Unknown tool: ${name}`, activity: `Unknown tool: ${name}`, visual: false };
  }
}
