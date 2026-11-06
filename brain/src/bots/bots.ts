import { randomUUID } from "node:crypto";
import { Collection } from "../store.ts";
import { avatarSVG, faceOf, randomAvatar } from "./avatar.ts";

export interface Bot {
  id: string;
  name: string;
  role: string;
  instructions: string;
  provider: string;
  model: string;
  avatarSeed: string;
  createdAt: string;
  /** Learn from finished tasks in the background (default on). */
  memoryAuto?: boolean;
  /** MCP servers whose tools this bot may use (Settings → MCP Servers). */
  mcpServers?: string[];
}

/**
 * Bots and computers are independent. An Access links them:
 *   owner — the bot's own computer (its logins, its files)
 *   guest — borrowed access, granted by the user or the owning bot, optionally expiring
 */
export interface Access {
  id: string;
  botId: string;
  computerId: string;
  role: "owner" | "guest";
  grantedBy: "user" | string;
  expiresAt?: string;
  createdAt: string;
}

export type Face = ReturnType<typeof faceOf>;
export type BotView = Bot & { avatar: string; face: Face; computers: Access[] };

export class Bots {
  private bots = new Collection<Bot>("bots.json");
  private accesses = new Collection<Access>("accesses.json");

  list(): BotView[] {
    return this.bots.all().map((b) => this.view(b));
  }

  get(id: string): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot not found: ${id}`);
    return bot;
  }

  create(input: { name: string; role?: string; instructions?: string; provider: string; model: string; computerId?: string; avatarSeed?: string }): BotView {
    const name = input.name?.trim();
    if (!name) throw new Error("The bot needs a name");
    const bot: Bot = {
      id: randomUUID(),
      name,
      role: input.role?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      provider: input.provider,
      model: input.model,
      avatarSeed: input.avatarSeed || randomAvatar(),
      createdAt: new Date().toISOString(),
    };
    this.bots.upsert(bot);
    if (input.computerId) this.grant({ botId: bot.id, computerId: input.computerId, role: "owner", grantedBy: "user" });
    return this.view(bot);
  }

  update(id: string, patch: Partial<Pick<Bot, "name" | "role" | "instructions" | "provider" | "model" | "avatarSeed" | "memoryAuto" | "mcpServers">>): BotView {
    const bot = { ...this.get(id), ...patch };
    if (bot.mcpServers) bot.mcpServers = [...new Set(bot.mcpServers.map(String))];
    if (!bot.name.trim()) throw new Error("The bot needs a name");
    this.bots.upsert(bot);
    return this.view(bot);
  }

  /** The bot and its device grants, to move it to another brain. */
  exportBot(id: string) {
    return { bot: this.get(id), accesses: this.accesses.where((a) => a.botId === id) };
  }

  /** Takes a bot moved from another brain, keeping its id. */
  importBot(bot: Bot, accesses: Access[]): BotView {
    this.bots.upsert(bot);
    this.accesses.remove((a) => a.botId === bot.id);
    for (const a of accesses) this.accesses.upsert({ ...a, botId: bot.id });
    return this.view(bot);
  }

  regenerateAvatar(id: string): BotView {
    return this.view(this.bots.upsert({ ...this.get(id), avatarSeed: randomAvatar() }));
  }

  /** Factory reset: no bots, no access grants. */
  reset() {
    this.bots.remove(() => true);
    this.accesses.remove(() => true);
  }

  delete(id: string) {
    this.bots.remove((b) => b.id === id);
    this.accesses.remove((a) => a.botId === id);
  }

  /** A bot has at most one owned computer; granting a new owner access replaces it. */
  grant(input: Omit<Access, "id" | "createdAt">): Access {
    this.get(input.botId);
    this.accesses.remove(
      (a) => a.botId === input.botId && (a.computerId === input.computerId || (input.role === "owner" && a.role === "owner")),
    );
    return this.accesses.upsert({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
  }

  revoke(botId: string, computerId: string) {
    this.accesses.remove((a) => a.botId === botId && a.computerId === computerId);
  }

  /** Bots that can use a computer right now (expired guest access is ignored). */
  botsOn(computerId: string): string[] {
    return this.live().filter((a) => a.computerId === computerId).map((a) => a.botId);
  }

  private live() {
    const now = Date.now();
    return this.accesses.where((a) => !a.expiresAt || Date.parse(a.expiresAt) > now);
  }

  private view(bot: Bot): BotView {
    return {
      ...bot,
      avatar: avatarSVG(bot.avatarSeed),
      face: faceOf(bot.avatarSeed),
      computers: this.live().filter((a) => a.botId === bot.id),
    };
  }
}
