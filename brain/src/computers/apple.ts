import { randomBytes } from "node:crypto";
import { readFileSync, statfsSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { join } from "node:path";
import { CuaHands, type DeviceExec } from "../hands/docker-cua.ts";
import { RuntimeClient } from "./runtime-client.ts";
import type { Computer, ComputerProvider, SetupProgress } from "./types.ts";
import { vncPassword } from "./vnc-password.ts";

const IMAGE = "docker.io/trycua/xfce-cua:latest";
const LABEL = "localbot.device";

interface RuntimeDevice {
  id: string;
  state: "running" | "stopped";
  ip: string;
  labels: Record<string, string>;
  cpus: number;
  memoryMiB: number;
}

interface ExecResult {
  code: number;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Linux desktops without Docker: the same image as DockerProvider
 * (trycua/xfce-cua with Cua Driver and noVNC), run by Local Bot's own runtime
 * on Apple's Containerization, a lightweight VM per device. Apple silicon and
 * macOS 26 or later. The screen is reached at the device's own IP.
 */
export class AppleProvider implements ComputerProvider {
  readonly name = "apple";
  private home = process.env.LOCALBOT_HOME ?? join(homedir(), ".local-bot");

  constructor(private runtime = new RuntimeClient()) {}

  /** macOS 26 is Darwin 25. */
  static supported() {
    return platform() === "darwin" && process.arch === "arm64" && Number(release().split(".")[0]) >= 25;
  }

  async available() {
    return AppleProvider.supported() && RuntimeClient.executable() !== null;
  }

  async list(): Promise<Computer[]> {
    return (await this.devices()).map((d) => ({
      id: `apple:${d.id}`,
      name: d.labels["localbot.name"] || d.id,
      provider: this.name,
      os: "linux",
      state: d.state,
      cpu: d.cpus,
      memoryGB: Math.round(d.memoryMiB / 1024),
      display: d.state === "running" && d.ip
        ? { kind: "vnc", url: `http://${d.ip}:6901/vnc_lite.html`, password: vncPassword(this.home) }
        : { kind: "none" },
    }));
  }

  /** What a Linux device needs here: the image (downloaded once) and some free disk. */
  async requirements() {
    const imageReady = await this.runtime.call<boolean>("images.has", { image: IMAGE }).catch(() => false);
    let freeGB: number | null = null;
    try {
      const fs = statfsSync(homedir());
      freeGB = Math.round(((fs.bavail * fs.bsize) / 1e9) * 10) / 10;
    } catch {}
    return { imageReady, freeGB, needGB: 5 };
  }

  async create(label: string, _options?: Record<string, string>, progress?: SetupProgress) {
    const id = `localbot-${slug(label)}-${randomBytes(2).toString("hex")}`;
    const step = async (name: Parameters<SetupProgress>[0], run: () => Promise<unknown>) => {
      progress?.(name, "active");
      try {
        await run();
        progress?.(name, "done");
      } catch (err) {
        progress?.(name, "failed", { error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    };
    if (await this.runtime.call<boolean>("images.has", { image: IMAGE })) progress?.("download", "skipped");
    else await step("download", () => this.runtime.call("images.pull", { image: IMAGE }, (event, data) => {
      if (event === "progress" && typeof data?.fraction === "number") progress?.("download", "active", { fraction: data.fraction });
    }));
    await step("start", () => this.runtime.call("create", {
      id,
      image: IMAGE,
      env: [`VNC_PW=${vncPassword(this.home)}`],
      labels: { [LABEL]: "1", "localbot.name": label },
      cpus: 4,
      memoryMiB: 4096,
    }));
    // Finish setup in the background so the device shows up right away; the
    // progress list follows it to the end.
    void (async () => {
      try {
        await step("controls", () => this.upgradeDriver(id));
        await step("screen", () => this.startHands(id));
      } catch {}
    })();
    return `apple:${id}`;
  }

  async remove(id: string) {
    await this.runtime.call("rm", { id: this.device(id) });
  }

  async start(id: string) {
    await this.runtime.call("start", { id: this.device(id) });
    await this.startHands(this.device(id));
  }

  async stop(id: string) {
    await this.runtime.call("stop", { id: this.device(id) });
  }

  async hands(id: string, session: string) {
    const name = this.device(id);
    const d = (await this.devices()).find((x) => x.id === name);
    if (d?.state !== "running") return null;
    await this.startHands(name);
    return new CuaHands(this.exec(name), session);
  }

  private device(id: string) {
    return id.replace(/^apple:/, "");
  }

  /**
   * The runtime's devices. Listing doesn't start the helper: when it isn't
   * running, its devices file says what exists, all of them off.
   */
  private async devices(): Promise<RuntimeDevice[]> {
    const all = (await this.runtime.running())
      ? await this.runtime.call<RuntimeDevice[]>("ls")
      : this.saved();
    return all.filter((d) => d.labels?.[LABEL] === "1");
  }

  private saved(): RuntimeDevice[] {
    try {
      const list = JSON.parse(readFileSync(join(this.home, "runtime", "devices.json"), "utf8")) as any[];
      return list.map((d) => ({ id: d.id, state: "stopped", ip: "", labels: d.labels ?? {}, cpus: d.cpus, memoryMiB: d.memoryMiB }));
    } catch {
      return [];
    }
  }

  /** `docker exec -u cua -e DISPLAY=:1 <device> …`, through the runtime. */
  private exec(device: string): DeviceExec {
    return async (args, opts = {}) => {
      const r = await this.runtime.call<ExecResult>("exec", {
        id: device, user: "cua", env: ["DISPLAY=:1"], args, timeoutMs: opts.timeout ?? 60_000,
      });
      const out = Buffer.from(r.stdout, "base64");
      const err = Buffer.from(r.stderr, "base64");
      const stdout = opts.binary ? out : out.toString("utf8");
      const stderr = opts.binary ? err : err.toString("utf8");
      if (r.code !== 0) {
        throw Object.assign(new Error(`Command failed (${r.code}): ${err.toString("utf8").trim().slice(0, 300)}`), {
          stdout, stderr, code: r.code, killed: !!r.timedOut,
        });
      }
      return { stdout, stderr };
    };
  }

  private async sh(device: string, script: string, opts: { detach?: boolean; timeout?: number } = {}) {
    const r = await this.runtime.call<ExecResult>("exec", {
      id: device, user: "cua", env: ["DISPLAY=:1"], args: ["sh", "-c", script],
      detach: !!opts.detach, timeoutMs: opts.timeout ?? 60_000,
    });
    if (r.code !== 0) throw new Error(Buffer.from(r.stderr, "base64").toString("utf8").trim() || `exit ${r.code}`);
    return Buffer.from(r.stdout, "base64").toString("utf8");
  }

  /**
   * Keeps Cua Driver's daemon running inside the desktop session. Prefers a
   * user-updated driver in ~/.local/bin over the one baked into the image.
   */
  private async startHands(device: string) {
    const driver = (cmd: string) => `D="$HOME/.local/bin/cua-driver"; [ -x "$D" ] || D=cua-driver; ${cmd}`;
    for (let i = 0; i < 40; i++) {
      try {
        await this.sh(device, driver(`"$D" status | grep -q 'is running'`));
        return;
      } catch {
        if (i % 10 === 0) await this.sh(device, driver(`exec "$D" serve`), { detach: true }).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /** The image ships an older Cua Driver; install the current release for the desktop user. */
  private async upgradeDriver(device: string) {
    const script = [
      'if [ ! -x "$HOME/.local/bin/cua-driver" ]; then',
      "curl -fsSL https://cua.ai/driver/install.sh -o /tmp/cua-driver-install.sh &&",
      "bash /tmp/cua-driver-install.sh --no-modify-path || exit 1;",
      "fi;",
      '"$HOME/.local/bin/cua-driver" telemetry disable',
    ].join(" ");
    await this.sh(device, script, { timeout: 5 * 60_000 })
      .catch((err) => console.error("[brain] driver upgrade failed:", err.message));
  }
}

function slug(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "device";
}
