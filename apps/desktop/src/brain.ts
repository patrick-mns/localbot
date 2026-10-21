import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The brain's protocol, as in the macOS app: one JSON object per line.
 *   request  {id, method, params}  ->  {id, result} | {id, error}
 *   event    {event, data}
 * The Rust side only moves lines; everything is decided here and in the brain.
 */
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
type Handler = (data: any) => void;

class BrainClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<Handler>>();
  private started?: Promise<void>;

  start() {
    this.started ??= (async () => {
      await listen<string>("brain-line", ({ payload }) => this.receive(payload));
      await listen<number | null>("brain-exit", ({ payload }) => {
        for (const p of this.pending.values()) p.reject(new Error("The brain stopped"));
        this.pending.clear();
        this.emit("brain.exit", payload);
      });
      await invoke("brain_start");
    })();
    return this.started;
  }

  async request<T = any>(method: string, params?: unknown): Promise<T> {
    await this.start();
    const id = this.nextId++;
    const done = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    await invoke("brain_send", { line: JSON.stringify({ id, method, params }) });
    return done;
  }

  on(event: string, handler: Handler) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  private emit(event: string, data: unknown) {
    for (const h of this.handlers.get(event) ?? []) h(data);
  }

  private receive(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if ("error" in msg) p.reject(new Error(String(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.event) {
      this.emit(msg.event, msg.data);
    }
  }
}

export const brain = new BrainClient();
