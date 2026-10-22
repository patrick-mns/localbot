import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";

/**
 * Talks to localbot-runtime (apps/runtime), the helper that runs Linux
 * devices on Apple's Containerization: JSON lines over
 * ~/.local-bot/runtime.sock. The helper keeps the devices' VMs alive, so it
 * outlives the brain; it's started here the first time it's needed.
 */
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onEvent?: (event: string, data: any) => void };

export class RuntimeClient {
  private home = process.env.LOCALBOT_HOME ?? join(homedir(), ".local-bot");
  private socketPath = join(this.home, "runtime.sock");
  private sock?: Socket;
  private connecting?: Promise<Socket>;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();

  /**
   * The helper's executable: set by the app (inside Local Bot.app), else a
   * development build next to the brain in this checkout.
   */
  static executable(): string | null {
    const candidates = [
      process.env.LOCALBOT_RUNTIME,
      resolve(process.cwd(), "../apps/runtime/.build/release/LocalBotRuntime"),
      resolve(process.cwd(), "../apps/runtime/.build/debug/LocalBotRuntime"),
    ].filter((p): p is string => !!p);
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  /** Whether the helper is running (without starting it). */
  async running() {
    if (this.sock && !this.sock.destroyed) return true;
    const s = await this.tryConnect();
    s?.destroy();
    return !!s;
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}, onEvent?: Pending["onEvent"]): Promise<T> {
    const sock = await this.socket();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private socket(): Promise<Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async open(): Promise<Socket> {
    let sock = await this.tryConnect();
    if (!sock) {
      this.launch();
      for (let i = 0; i < 100 && !sock; i++) {
        await new Promise((r) => setTimeout(r, 200));
        sock = await this.tryConnect();
      }
    }
    if (!sock) throw new Error("Couldn’t start Local Bot’s device runtime");
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => this.receive(d));
    sock.on("close", () => {
      this.sock = undefined;
      for (const p of this.pending.values()) p.reject(new Error("The device runtime stopped"));
      this.pending.clear();
    });
    sock.on("error", () => {});
    return sock;
  }

  private tryConnect(): Promise<Socket | null> {
    return new Promise((resolve) => {
      if (!existsSync(this.socketPath)) return resolve(null);
      const s = connect(this.socketPath);
      s.once("connect", () => resolve(s));
      s.once("error", () => resolve(null));
    });
  }

  /** Starts the helper on its own (it keeps running after the brain quits). */
  private launch() {
    const exe = RuntimeClient.executable();
    if (!exe) throw new Error("Local Bot’s device runtime isn’t installed");
    mkdirSync(this.home, { recursive: true });
    const log = openSync(join(this.home, "runtime.log"), "a");
    const child = spawn(exe, [], { detached: true, stdio: ["ignore", log, log], env: process.env });
    child.unref();
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      if (msg.event) {
        p.onEvent?.(msg.event, msg.data);
      } else {
        this.pending.delete(msg.id);
        if ("error" in msg) p.reject(new Error(String(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }
}
