import { randomUUID } from "node:crypto";
import { Collection } from "../store.ts";

/**
 * A wake-up a bot set for itself in the middle of a task ("check the download
 * in 20 minutes"), so the task isn't lost when the bot goes quiet. One per
 * bot; a new one replaces it. When it's due, the bot first takes a short,
 * cheap look (Conversations.wake) and only works if there's something to do.
 */
export interface Wakeup {
  id: string;
  botId: string;
  /** When it's due (ISO). */
  at: string;
  /** What to check, in the bot's words. */
  note: string;
  createdAt: string;
  /** Short looks in a row that went back to sleep (capped by MAX_CHECKS). */
  checks: number;
}

/** Sleeping again this many times in a row ends the chain. */
export const MAX_CHECKS = 12;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 24 * 60;

const TICK_MS = 15_000;

export class Wakeups {
  private items = new Collection<Wakeup>("wakeups.json");
  private timer?: NodeJS.Timeout;

  constructor(
    private fire: (wakeup: Wakeup) => Promise<void>,
    private busy: (botId: string) => boolean,
    private changed: (botId: string) => void,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 3_000);
  }

  stop() {
    clearInterval(this.timer);
  }

  forBot(botId: string): Wakeup | undefined {
    return this.items.where((w) => w.botId === botId)[0];
  }

  list(botId?: string): Wakeup[] {
    return this.items.where((w) => !botId || w.botId === botId);
  }

  set(botId: string, minutes: number, note: string, checks = 0): Wakeup {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < MIN_MINUTES || m > MAX_MINUTES) {
      throw new Error(`Wake-ups are between ${MIN_MINUTES} minute and ${MAX_MINUTES / 60} hours away`);
    }
    const text = String(note ?? "").trim();
    if (!text) throw new Error("Say what to check when you wake up");
    this.items.remove((w) => w.botId === botId);
    const wakeup: Wakeup = {
      id: randomUUID(),
      botId,
      at: new Date(Date.now() + m * 60_000).toISOString(),
      note: text.slice(0, 500),
      createdAt: new Date().toISOString(),
      checks,
    };
    this.items.upsert(wakeup);
    this.changed(botId);
    return wakeup;
  }

  cancel(botId: string) {
    if (!this.forBot(botId)) return false;
    this.items.remove((w) => w.botId === botId);
    this.changed(botId);
    return true;
  }

  deleteForBot(botId: string) {
    this.cancel(botId);
  }

  reset() {
    for (const w of this.items.all()) this.cancel(w.botId);
  }

  /** Takes a wake-up moved from another brain. */
  importForBot(botId: string, wakeup?: Wakeup | null) {
    this.items.remove((w) => w.botId === botId);
    if (wakeup) this.items.upsert({ ...wakeup, botId });
    this.changed(botId);
  }

  /** Fires what's due (a busy bot's wake-up waits for the next tick). */
  async tick(now = new Date()) {
    for (const w of this.items.all()) {
      if (new Date(w.at) > now || this.busy(w.botId)) continue;
      this.items.remove((x) => x.id === w.id);
      this.changed(w.botId);
      await this.fire(w).catch(() => {});
    }
  }
}
