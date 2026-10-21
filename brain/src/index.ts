import { createInterface } from "node:readline";
import { connect, createServer, type Socket } from "node:net";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * Brain entry point. Protocol: one JSON object per line.
 *   request  {id, method, params}  ->  {id, result} | {id, error}
 *   event    {event, data}          (brain -> app, unsolicited)
 * stdout is reserved for the protocol; logs go to stderr.
 *
 * Only one brain may own the data at a time. The owner also listens on
 * ~/.local-bot/brain.sock; any other brain that finds it there just bridges
 * its stdio to the owner. That's how the app talks to the background service
 * (`--service`, run by launchd) when it's on, and how the service waits while
 * the app's own brain runs, taking over when the app quits.
 */
const HOME = process.env.LOCALBOT_HOME ?? join(homedir(), ".local-bot");
/** Windows has no Unix sockets in the data folder: a named pipe per data folder. */
const WINDOWS = platform() === "win32";
const SOCKET = WINDOWS
  ? `\\\\.\\pipe\\localbot-brain-${createHash("sha256").update(HOME.toLowerCase()).digest("hex").slice(0, 16)}`
  : join(HOME, "brain.sock");
const service = process.argv.includes("--service");
/** How often a waiting service checks whether the app's brain is gone. */
const TAKEOVER_MS = Number(process.env.LOCALBOT_TAKEOVER_MS ?? 15_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (...args: unknown[]) => process.stderr.write(`[brain] ${args.join(" ")}\n`);

/** A live owner's socket, or null. */
function probe(): Promise<Socket | null> {
  return new Promise((resolve) => {
    const sock = connect(SOCKET);
    const timer = setTimeout(() => { sock.destroy(); resolve(null); }, 1500);
    sock.once("connect", () => { clearTimeout(timer); resolve(sock); });
    sock.once("error", () => { clearTimeout(timer); resolve(null); });
  });
}

/** Bridges this process's stdio to the owner. */
function bridge(sock: Socket) {
  say("attached to the running brain");
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);
  process.stdin.on("end", () => sock.end());
  // The owner went away (quit, update): exit so the app starts a fresh brain.
  sock.on("close", () => process.exit(0));
  sock.on("error", () => process.exit(1));
}

/** Runs the brain here: serves stdio (for the app) and the socket. */
async function own() {
  const core = await import("./core.ts");
  core.presence.service = service;
  const writers = new Set<(line: string) => void>();
  core.events.on("event", (event: string, data: unknown) => {
    const line = JSON.stringify({ event, data }) + "\n";
    for (const write of writers) write(line);
  });

  /** One client: requests in, replies and events out. */
  function serve(input: Readable, write: (line: string) => void, onClose: () => void) {
    writers.add(write);
    core.presence.clients++;
    const inFlight = new Set<Promise<void>>();
    const rl = createInterface({ input });
    rl.on("line", (line) => {
      const task = handle(line, write);
      inFlight.add(task);
      task.finally(() => inFlight.delete(task));
    });
    rl.on("close", async () => {
      await Promise.allSettled(inFlight);
      writers.delete(write);
      core.presence.clients--;
      onClose();
    });
  }

  async function handle(line: string, write: (line: string) => void) {
    if (!line.trim()) return;
    let req: { id: number; method: string; params?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return core.log("invalid line:", line);
    }
    const reply = (body: object) => write(JSON.stringify({ id: req.id, ...body }) + "\n");
    try {
      reply({ result: await core.invoke(req.method, req.params) });
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  mkdirSync(HOME, { recursive: true });
  if (!WINDOWS) try { unlinkSync(SOCKET); } catch {}
  const server = createServer((sock) => {
    sock.on("error", () => {});
    serve(sock, (line) => { if (!sock.destroyed) sock.write(line); }, () => sock.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET, () => { if (!WINDOWS) chmodSync(SOCKET, 0o600); resolve(); });
  });

  if (!service) {
    // The app closing stdin means it quit: this brain goes with it, and a
    // background service (if any) takes over.
    serve(process.stdin, (line) => process.stdout.write(line), () => {
      server.close();
      if (!WINDOWS) try { unlinkSync(SOCKET); } catch {}
      process.exit(0);
    });
  }
  core.log(service ? "ready (background service)" : "ready");
}

async function main() {
  if (!service) {
    const owner = await probe();
    if (owner) return bridge(owner);
    return own();
  }
  // The service waits while another brain (the app's) owns the data.
  for (;;) {
    const owner = await probe();
    if (!owner) break;
    owner.destroy();
    await sleep(TAKEOVER_MS);
  }
  return own();
}

void main();
