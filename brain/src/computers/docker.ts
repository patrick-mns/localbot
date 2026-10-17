import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DockerCuaHands } from "../hands/docker-cua.ts";
import type { Computer, ComputerProvider, SetupProgress } from "./types.ts";

const run = promisify(execFile);

const IMAGE = "trycua/xfce-cua:latest";
const LABEL = "localbot.device";
/** The first device predates labels; keep recognizing it. */
const LEGACY = "localbot-computer";

interface Container {
  name: string;
  running: boolean;
  label: string;
  port: number;
}

/**
 * Linux desktops in Docker containers, based on Cua's xfce-cua image
 * (Debian + XFCE + Firefox + Cua Driver + noVNC). Each device is one
 * container; the same image runs on macOS, Windows and Linux hosts.
 */
export class DockerProvider implements ComputerProvider {
  readonly name = "docker";
  private home = process.env.LOCALBOT_HOME ?? join(homedir(), ".local-bot");

  async available() {
    try {
      await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<Computer[]> {
    return (await this.containers()).map((c) => ({
      id: `docker:${c.name}`,
      name: c.label,
      provider: this.name,
      os: "linux",
      state: c.running ? "running" : "stopped",
      display: { kind: "vnc", url: `http://127.0.0.1:${c.port}/vnc_lite.html`, password: this.password() },
    }));
  }

  /**
   * What a Linux device needs on this Mac: Docker installed and running, the
   * image (downloaded once, ~1–2 GB) and some free disk.
   */
  async requirements() {
    let docker: "running" | "stopped" | "missing" = "missing";
    if (await this.available()) docker = "running";
    else if (existsSync("/Applications/Docker.app") || (await run("sh", ["-c", "command -v docker"]).then(() => true, () => false))) docker = "stopped";
    const imageReady = docker === "running" && (await run("docker", ["image", "inspect", IMAGE]).then(() => true, () => false));
    let freeGB: number | null = null;
    try {
      const fs = statfsSync(homedir());
      freeGB = Math.round(((fs.bavail * fs.bsize) / 1e9) * 10) / 10;
    } catch {}
    return { docker, imageReady, freeGB, needGB: 5 };
  }

  /** Downloads the image, reporting the share of layers done. */
  private pull(progress?: SetupProgress) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["pull", IMAGE]);
      // Each layer's share: waiting 0, downloading 0.2, downloaded 0.8, unpacked 1.
      const layers = new Map<string, number>();
      const onLine = (line: string) => {
        const m = /^([0-9a-f]{12}): (.+)$/.exec(line.trim());
        if (!m) return;
        const [, id, state] = m;
        const share = /Pull complete|Already exists/.test(state) ? 1 : /Download complete|Extracting/.test(state) ? 0.8
          : /Downloading|Verifying/.test(state) ? 0.2 : 0;
        layers.set(id, Math.max(layers.get(id) ?? 0, share));
        const total = [...layers.values()].reduce((a, b) => a + b, 0);
        progress?.("download", "active", { fraction: total / layers.size });
      };
      let rest = "";
      child.stdout.on("data", (chunk) => {
        const lines = (rest + chunk.toString()).split("\n");
        rest = lines.pop() ?? "";
        lines.forEach(onLine);
      });
      let err = "";
      child.stderr.on("data", (c) => (err += c.toString()));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || `docker pull failed (${code})`))));
    });
  }

  /** Creates and starts a new desktop; returns its id. */
  async create(label: string, _options?: Record<string, string>, progress?: SetupProgress): Promise<string> {
    const step = async <T>(name: Parameters<SetupProgress>[0], work: () => Promise<T>): Promise<T> => {
      progress?.(name, "active");
      try {
        const out = await work();
        progress?.(name, "done");
        return out;
      } catch (err) {
        progress?.(name, "failed", { error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    };
    const name = `localbot-${slug(label)}-${randomBytes(2).toString("hex")}`;
    const used = new Set((await this.containers()).map((c) => c.port));
    const port = await freePort(6902, used);
    if (await run("docker", ["image", "inspect", IMAGE]).then(() => true, () => false)) progress?.("download", "skipped");
    else await step("download", () => this.pull(progress));
    await step("start", () => run("docker", [
      "run", "-d", "--name", name,
      // Bound to localhost only: the desktop is never exposed to the network.
      "-p", `127.0.0.1:${port}:6901`,
      "-e", `VNC_PW=${this.password()}`,
      "--shm-size=1g",
      "--label", `${LABEL}=1`,
      "--label", `localbot.name=${label}`,
      IMAGE,
    ], { timeout: 10 * 60_000 }));
    // Finish setup in the background so the device shows up right away; the
    // progress list follows it to the end.
    void (async () => {
      try {
        await step("controls", () => this.upgradeDriver(name));
        await step("screen", () => this.startHands(name));
      } catch {}
    })();
    return `docker:${name}`;
  }

  async remove(id: string) {
    await run("docker", ["rm", "-f", this.container(id)]);
  }

  async start(id: string) {
    const name = this.container(id);
    await run("docker", ["start", name]);
    await this.startHands(name);
  }

  async stop(id: string) {
    await run("docker", ["stop", this.container(id)]);
  }

  async hands(id: string, session: string) {
    const name = this.container(id);
    const c = (await this.containers()).find((x) => x.name === name);
    if (!c?.running) return null;
    await this.startHands(name);
    return new DockerCuaHands(name, session);
  }

  private container(id: string) {
    return id.replace(/^docker:/, "");
  }

  private async containers(): Promise<Container[]> {
    const { stdout } = await run("docker", [
      "ps", "-a", "--format", "{{json .}}",
      "--filter", `label=${LABEL}`,
    ]);
    const labeled = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const legacy = await run("docker", ["ps", "-a", "--format", "{{json .}}", "--filter", `name=^${LEGACY}$`])
      .then((r) => r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)))
      .catch(() => []);
    return [...legacy, ...labeled].map((c: any) => ({
      name: c.Names,
      running: c.State === "running",
      label: labelOf(c.Labels) ?? (c.Names === LEGACY ? "Linux" : c.Names),
      port: Number(/127\.0\.0\.1:(\d+)->6901/.exec(c.Ports)?.[1] ?? 6901),
    }));
  }

  /**
   * Keeps Cua Driver's daemon running inside the desktop session. Prefers a
   * user-updated driver in ~/.local/bin over the one baked into the image.
   */
  private async startHands(container: string) {
    const driver = (cmd: string) =>
      `D="$HOME/.local/bin/cua-driver"; [ -x "$D" ] || D=cua-driver; ${cmd}`;
    const exec = (detach: boolean, cmd: string) =>
      run("docker", [
        "exec", ...(detach ? ["-d"] : []), "-u", "cua", "-e", "DISPLAY=:1",
        container, "sh", "-c", driver(cmd),
      ]);
    for (let i = 0; i < 40; i++) {
      try {
        await exec(false, `"$D" status | grep -q 'is running'`);
        return;
      } catch {
        if (i % 10 === 0) await exec(true, `exec "$D" serve`).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /**
   * The image ships an older Cua Driver; install the current release for the
   * desktop user (into ~/.local/bin, which startHands prefers).
   */
  private async upgradeDriver(container: string) {
    const script = [
      'if [ ! -x "$HOME/.local/bin/cua-driver" ]; then',
      "curl -fsSL https://cua.ai/driver/install.sh -o /tmp/cua-driver-install.sh &&",
      "bash /tmp/cua-driver-install.sh --no-modify-path || exit 1;",
      "fi;",
      '"$HOME/.local/bin/cua-driver" telemetry disable',
    ].join(" ");
    await run("docker", ["exec", "-u", "cua", container, "sh", "-c", script], { timeout: 5 * 60_000 })
      .catch((err) => console.error("[brain] driver upgrade failed:", err.message));
  }

  /** VNC password, generated once and kept in ~/.local-bot (0600). */
  private password() {
    const file = join(this.home, "vnc-password");
    if (!existsSync(file)) {
      mkdirSync(this.home, { recursive: true });
      writeFileSync(file, randomBytes(8).toString("hex"), { mode: 0o600 });
    }
    return readFileSync(file, "utf8").trim();
  }
}

function labelOf(labels: string): string | undefined {
  // `docker ps` renders labels as "k=v,k=v"; names may contain commas, so match the key.
  const m = /(?:^|,)localbot\.name=(.*?)(?:,[\w.-]+=|$)/.exec(labels ?? "");
  return m?.[1];
}

function slug(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "device";
}

/** First localhost TCP port at or above `from` that is free and not reserved by a stopped device. */
async function freePort(from: number, taken: Set<number>): Promise<number> {
  for (let port = from; port < from + 200; port++) {
    if (taken.has(port)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer().once("error", () => resolve(false)).once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error("No free port for the device screen");
}
