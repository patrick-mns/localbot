/**
 * Suspends devices nobody is using: no bot working on them and the user not
 * in control for IDLE_MS. Suspending keeps everything inside (apps, windows,
 * memory); the device resumes when a bot needs it again (see core.ts) or
 * when the user presses Start.
 */
export const IDLE_MS = 3 * 60_000;

const TICK_MS = 30_000;

export class IdleSuspend {
  /** When each running device was last used. */
  private used = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    /** Devices that can be suspended, with their current state. */
    private devices: () => Promise<{ id: string; state: string }[]>,
    /** Whether something is using the device right now (a bot working on it). */
    private inUse: (id: string) => boolean,
    private suspend: (id: string) => Promise<void>,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick().catch(() => {}), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** The device was just used (a bot acted on it, the user took control, it resumed). */
  touch(id: string, now = Date.now()) {
    this.used.set(id, now);
  }

  async tick(now = Date.now()) {
    for (const d of await this.devices()) {
      if (d.state !== "running") {
        this.used.delete(d.id);
        continue;
      }
      // A running device seen for the first time starts its idle time now.
      const last = this.used.get(d.id);
      if (last === undefined || this.inUse(d.id)) {
        this.touch(d.id, now);
        continue;
      }
      if (now - last < IDLE_MS) continue;
      this.used.delete(d.id);
      await this.suspend(d.id).catch(() => {});
    }
  }
}
