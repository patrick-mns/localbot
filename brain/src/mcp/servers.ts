import { randomUUID } from "node:crypto";
import { McpClient, type TokenSource, type ToolResult } from "../hands/mcp.ts";
import { refresh as refreshTokens, startSignIn, type OAuthTokens, type SignIn } from "./oauth.ts";
import { secrets } from "../secrets.ts";
import { Collection } from "../store.ts";
import type { ToolSpec } from "../chat/types.ts";
import { StdioMcpClient } from "./stdio.ts";
import { CONNECTORS, type Connector } from "./connectors.ts";

/**
 * MCP servers the user adds in Settings: remote ones over HTTP, local ones
 * started from a command. Their tools are offered to the bots that have the
 * server switched on, named `<server>__<tool>`. Secrets (the token, env
 * values) live in the Keychain; mcp.json keeps only their names.
 */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  /** Names of environment variables; values are in the Keychain. */
  envKeys?: string[];
  /** Signs in with OAuth (connectors); tokens are in the Keychain. */
  auth?: "oauth";
  /** The catalog entry it was added from (Connectors). */
  connector?: string;
  /** Offered to every bot, not just the ones that switch it on. */
  allBots?: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Runtime {
  client: McpClient | StdioMcpClient;
  tools?: McpTool[];
  state: "idle" | "connecting" | "connected" | "error";
  errors: { at: string; message: string }[];
}

export interface McpServerInput {
  name?: string;
  transport?: "http" | "stdio";
  url?: string;
  /** null clears it; undefined keeps it. */
  token?: string | null;
  command?: string;
  args?: string[];
  /** Replaces all variables when given. */
  env?: Record<string, string>;
  enabled?: boolean;
  allBots?: boolean;
}

const MAX_OUTPUT = 8000;
/**
 * Tool descriptions go to the model on every step of every run, so a server
 * with many tools costs more than the work itself (ElevenLabs lists 160 tools,
 * over a million characters: ~300k tokens a step). A server whose tools fit
 * in this many characters sends them as they are; bigger ones are searched
 * with find_app_tools and run with use_app_tool.
 */
const INLINE_TOOLS_CHARS = 20_000;
const FIND_TOOL = "find_app_tools";
const USE_TOOL = "use_app_tool";
/** How much of the found tools' descriptions goes back to the model. */
const FOUND_MAX = 5;
const FOUND_CHARS = 24_000;
const tokenAccount = (id: string) => `mcp:${id}:token`;
const oauthAccount = (id: string) => `mcp:${id}:oauth`;
const envAccount = (id: string, key: string) => `mcp:${id}:env:${key}`;

/** "My GitHub" → "my_github"; tool names must be short and plain. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "mcp";

export class McpServers {
  private items = new Collection<McpServerConfig>("mcp.json", 0o600);
  private runtime = new Map<string, Runtime>();
  private signIns = new Map<string, SignIn>();

  constructor(
    private changed: () => void = () => {},
    /** A connector finished signing in (the chat continues waiting tasks). */
    private connected: (connectorId: string) => void = () => {},
  ) {}

  /**
   * Where each catalog connector stands for a bot: "ready" (it can use it),
   * "allow" (signed in, but not on for this bot) or "connect".
   */
  connectorsFor(serverIds: string[], catalog: Connector[] = CONNECTORS) {
    const usable = new Set(this.forBot(serverIds).map((s) => s.connector).filter(Boolean));
    return catalog.map((c) => {
      const server = this.items.where((x) => x.connector === c.id)[0];
      const signedIn = !!server && !!secrets.get(oauthAccount(server.id)) && server.enabled;
      return { ...c, serverId: server?.id, status: usable.has(c.id) ? "ready" : signedIn ? "allow" : "connect" } as const;
    });
  }

  /** Loads the servers' secrets so clients can be built synchronously. */
  async init() {
    await secrets.load(this.items.all().flatMap((s) => [tokenAccount(s.id), oauthAccount(s.id), ...(s.envKeys ?? []).map((k) => envAccount(s.id, k))]));
  }

  list() {
    return this.items.all().map((s) => this.view(s));
  }

  private view(s: McpServerConfig) {
    const rt = this.runtime.get(s.id);
    return {
      ...s,
      hasToken: !!secrets.get(tokenAccount(s.id)),
      signingIn: this.signIns.has(s.id),
      state: !s.enabled ? "off" : s.auth === "oauth" && !secrets.get(oauthAccount(s.id)) ? "signin" : rt?.state ?? "idle",
      tools: rt?.tools ?? null,
      errors: rt?.errors ?? [],
    };
  }

  get(id: string) {
    const s = this.items.get(id);
    if (!s) throw new Error("That MCP server no longer exists");
    return s;
  }

  async add(input: McpServerInput) {
    const config = validate({ id: randomUUID(), enabled: true, createdAt: new Date().toISOString() } as McpServerConfig, input);
    await this.saveSecrets(config, input);
    this.items.upsert(config);
    this.changed();
    return this.view(config);
  }

  /** A connector from the catalog: a remote server with a sign-in, for all bots. */
  connector(entry: { id: string; name: string; url: string }) {
    const existing = this.items.where((x) => x.connector === entry.id)[0];
    if (existing) return existing;
    const config: McpServerConfig = {
      id: randomUUID(), name: entry.name, transport: "http", url: entry.url,
      auth: "oauth", connector: entry.id, allBots: true, enabled: true, createdAt: new Date().toISOString(),
    };
    this.items.upsert(config);
    this.changed();
    return config;
  }

  async update(id: string, input: McpServerInput) {
    const config = validate({ ...this.get(id) }, input);
    await this.saveSecrets(config, input);
    this.items.upsert(config);
    this.reset(id);
    this.changed();
    return this.view(config);
  }

  async remove(id: string) {
    const s = this.get(id);
    this.reset(id);
    this.signIns.get(id)?.cancel();
    await secrets.delete(tokenAccount(id)).catch(() => {});
    await secrets.delete(oauthAccount(id)).catch(() => {});
    for (const k of s.envKeys ?? []) await secrets.delete(envAccount(id, k)).catch(() => {});
    this.items.remove((x) => x.id === id);
    this.changed();
  }

  /** Connects and lists the tools; the result is cached for the bots. */
  async test(id: string) {
    const s = this.get(id);
    const rt = this.runtimeFor(s);
    rt.state = "connecting";
    this.changed();
    try {
      rt.tools = (await rt.client.listTools()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      rt.state = "connected";
      return this.view(s);
    } catch (err) {
      this.fail(rt, err);
      throw err;
    } finally {
      this.changed();
    }
  }

  /** Tools for a bot, from its enabled servers (connecting on first use). */
  async toolsFor(serverIds: string[]): Promise<ToolSpec[]> {
    const { inline, searchable } = await this.catalog(serverIds);
    if (!searchable.length) return inline;
    const apps = [...new Set(searchable.map((t) => t.app))].join(", ");
    return [
      ...inline,
      {
        name: FIND_TOOL,
        description: `Find tools of connected apps that have too many to list here (${apps}). ` +
          `Describe what you want to do in English; returns the matching tools and their parameters. Then run one with ${USE_TOOL}.`,
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "What you want to do, e.g. \"turn text into speech\"" } },
          required: ["query"],
        },
      },
      {
        name: USE_TOOL,
        description: `Run a tool found with ${FIND_TOOL}.`,
        parameters: {
          type: "object",
          properties: {
            tool: { type: "string", description: `The tool's exact name, as ${FIND_TOOL} gave it` },
            arguments: { type: "object", description: "The tool's parameters" },
          },
          required: ["tool"],
        },
      },
    ];
  }

  /** A bot's MCP tools: those of small servers as they are, the rest to search. */
  private async catalog(serverIds: string[]) {
    const inline: ToolSpec[] = [];
    const searchable: (ToolSpec & { app: string })[] = [];
    for (const s of this.forBot(serverIds)) {
      const rt = this.runtimeFor(s);
      if (!rt.tools) await this.test(s.id).catch(() => {});
      const specs: ToolSpec[] = (rt.tools ?? []).map((t) => ({
        name: `${slug(s.name)}__${t.name}`.slice(0, 64),
        description: `[${s.name}] ${t.description ?? t.name}`.slice(0, 1000),
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      }));
      if (JSON.stringify(specs).length <= INLINE_TOOLS_CHARS) inline.push(...specs);
      else searchable.push(...specs.map((t) => ({ ...t, app: s.name })));
    }
    return { inline, searchable };
  }

  /** The searchable tools that best match `query`, with their parameters. */
  private async find(serverIds: string[], rawArgs: string) {
    const { searchable } = await this.catalog(serverIds);
    let query = "";
    try { query = String(JSON.parse(rawArgs || "{}").query ?? ""); } catch {}
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    const scored = searchable
      .map((t) => {
        const name = t.name.toLowerCase(), text = (t.description ?? "").toLowerCase();
        return { t, score: words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0), 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, FOUND_MAX);
    const apps = [...new Set(searchable.map((t) => t.app))].join(", ");
    const activity = `Looked for ${apps} tools: “${query.slice(0, 60)}”`;
    if (!scored.length) {
      const names = searchable.map((t) => `- ${t.name}: ${(t.description ?? "").replace(/^\[[^\]]*\] /, "").slice(0, 80)}`).join("\n");
      return { result: `No tool matched. All of them:\n${names}`.slice(0, FOUND_CHARS), activity };
    }
    const result = scored
      .map(({ t }) => `${t.name}\n${t.description}\nParameters: ${JSON.stringify(t.parameters)}`.slice(0, FOUND_CHARS / FOUND_MAX))
      .join("\n\n");
    return { result: `Run one with ${USE_TOOL}.\n\n${result}`, activity };
  }

  /** Runs a `<server>__<tool>` call for a bot; returns text for the model. */
  async call(serverIds: string[], name: string, rawArgs: string): Promise<{ result: string; activity: string } | null> {
    if (name === FIND_TOOL) return this.find(serverIds, rawArgs);
    if (name === USE_TOOL) {
      let picked: { tool?: unknown; arguments?: unknown } = {};
      try { picked = JSON.parse(rawArgs || "{}"); } catch {}
      const tool = String(picked.tool ?? "");
      const out = tool === FIND_TOOL || tool === USE_TOOL ? null : await this.call(serverIds, tool, JSON.stringify(picked.arguments ?? {}));
      return out ?? { result: `Error: no tool named “${picked.tool}”. Use ${FIND_TOOL} to find it.`, activity: "Couldn’t find an app tool" };
    }
    const s = this.forBot(serverIds).find((x) => name.startsWith(`${slug(x.name)}__`));
    if (!s) return null;
    const tool = name.slice(slug(s.name).length + 2);
    const rt = this.runtimeFor(s);
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return { result: "Error: invalid arguments (not JSON).", activity: `Used ${s.name}: ${tool}` };
    }
    try {
      const r = await rt.client.callTool(tool, args);
      return { result: render(r), activity: `Used ${s.name}: ${tool}${r.isError ? " (failed)" : ""}` };
    } catch (err) {
      this.fail(rt, err);
      this.changed();
      return { result: `Error: ${err instanceof Error ? err.message : String(err)}`, activity: `Couldn’t use ${s.name}: ${tool}` };
    }
  }

  /** The servers a bot can use: the ones it switched on, plus "all bots" ones. */
  private forBot(serverIds: string[]) {
    return this.items.where((x) => x.enabled && (x.allBots || serverIds.includes(x.id))
      && (x.auth !== "oauth" || !!secrets.get(oauthAccount(x.id))));
  }

  /**
   * Starts signing in to an OAuth server: returns the page to open in the
   * browser. When the user finishes, the tokens are saved and the tools listed.
   */
  async signIn(id: string): Promise<string> {
    const s = this.get(id);
    if (s.auth !== "oauth" || !s.url) throw new Error("This server doesn’t use a sign-in");
    this.signIns.get(id)?.cancel();
    const signIn = await startSignIn(s.url);
    this.signIns.set(id, signIn);
    this.changed();
    signIn.done
      .then(async (tokens) => {
        await secrets.set(oauthAccount(id), JSON.stringify(tokens));
        this.reset(id);
        await this.test(id).catch(() => {});
        if (s.connector) this.connected(s.connector);
      })
      .catch((err) => {
        if (this.signIns.get(id) !== signIn) return;
        const rt = this.runtimeFor(s);
        this.fail(rt, err);
      })
      .finally(() => {
        if (this.signIns.get(id) === signIn) this.signIns.delete(id);
        this.changed();
      });
    return signIn.url;
  }

  /** OAuth tokens for a server, refreshed shortly before they expire. */
  private tokenSource(id: string): TokenSource {
    const load = (): OAuthTokens | undefined => {
      const raw = secrets.get(oauthAccount(id));
      try { return raw ? JSON.parse(raw) : undefined; } catch { return undefined; }
    };
    const renew = async () => {
      const current = load();
      if (!current?.refreshToken) return false;
      try {
        await secrets.set(oauthAccount(id), JSON.stringify(await refreshTokens(current)));
        return true;
      } catch {
        // The sign-in is no longer valid: ask to connect again.
        await secrets.delete(oauthAccount(id)).catch(() => {});
        this.changed();
        return false;
      }
    };
    return {
      get: async () => {
        const t = load();
        if (t?.expiresAt && t.expiresAt - 60_000 < Date.now()) await renew();
        return load()?.accessToken;
      },
      refresh: renew,
    };
  }

  /** Stops every local server (shutdown, reset). */
  stopAll() {
    for (const id of this.runtime.keys()) this.reset(id);
  }

  async clear() {
    for (const s of this.items.all()) await this.remove(s.id);
  }

  private runtimeFor(s: McpServerConfig): Runtime {
    let rt = this.runtime.get(s.id);
    if (!rt) {
      const client = s.transport === "http"
        ? new McpClient(s.url!, s.auth === "oauth" ? this.tokenSource(s.id) : secrets.get(tokenAccount(s.id)), 90_000, s.name)
        : new StdioMcpClient(s.command!, s.args ?? [],
            Object.fromEntries((s.envKeys ?? []).map((k) => [k, secrets.get(envAccount(s.id, k)) ?? ""])));
      rt = { client, state: "idle", errors: [] };
      this.runtime.set(s.id, rt);
    }
    return rt;
  }

  private reset(id: string) {
    const rt = this.runtime.get(id);
    if (rt?.client instanceof StdioMcpClient) rt.client.stop();
    this.runtime.delete(id);
  }

  private fail(rt: Runtime, err: unknown) {
    rt.state = "error";
    const stderr = rt.client instanceof StdioMcpClient ? rt.client.stderr.slice(-3).join("\n") : "";
    const message = (err instanceof Error ? err.message : String(err)) + (stderr && !String(err).includes(stderr) ? `\n${stderr}` : "");
    rt.errors.unshift({ at: new Date().toISOString(), message });
    rt.errors.splice(5);
  }

  private async saveSecrets(config: McpServerConfig, input: McpServerInput) {
    if (input.token === null) await secrets.delete(tokenAccount(config.id)).catch(() => {});
    else if (input.token) await secrets.set(tokenAccount(config.id), input.token);
    if (input.env) {
      const old = this.items.get(config.id)?.envKeys ?? [];
      for (const k of old) if (!(k in input.env)) await secrets.delete(envAccount(config.id, k)).catch(() => {});
      for (const [k, v] of Object.entries(input.env)) await secrets.set(envAccount(config.id, k), v);
    }
  }
}

function validate(config: McpServerConfig, input: McpServerInput): McpServerConfig {
  const next = { ...config };
  if (input.name !== undefined) next.name = String(input.name).trim();
  if (input.transport !== undefined) next.transport = input.transport;
  if (input.enabled !== undefined) next.enabled = !!input.enabled;
  if (input.allBots !== undefined) next.allBots = !!input.allBots;
  if (input.url !== undefined) next.url = String(input.url).trim();
  if (input.command !== undefined) next.command = String(input.command).trim();
  if (input.args !== undefined) next.args = input.args.map(String);
  if (input.env !== undefined) {
    for (const k of Object.keys(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`“${k}” isn’t a valid variable name`);
    }
    next.envKeys = Object.keys(input.env);
  }
  if (!next.name) throw new Error("Give the server a name");
  if (next.name.length > 40) throw new Error("Keep the name under 40 characters");
  if (next.transport !== "http" && next.transport !== "stdio") throw new Error("Choose Remote or Local");
  if (next.transport === "http") {
    let u: URL;
    try { u = new URL(next.url ?? ""); } catch { throw new Error("Enter the server’s URL"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("Use an https:// URL (http only for localhost)");
    delete next.command; delete next.args; delete next.envKeys;
  } else {
    if (!next.command) throw new Error("Enter the command that starts the server");
    delete next.url;
  }
  return next;
}

/** Tool output as text for the model; images are noted, not sent. */
function render(r: ToolResult) {
  const parts = (r.content ?? []).map((c) => (c.type === "text" ? c.text : `(${c.type} omitted)`));
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  const text = (r.isError ? "Error: " : "") + (parts.join("\n") || "(no output)");
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…(output truncated)` : text;
}
