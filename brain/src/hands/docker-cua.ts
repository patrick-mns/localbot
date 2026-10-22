import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Hands, Screenshot } from "./types.ts";

const run = promisify(execFile);

/**
 * Runs a command in the device as `cua` with DISPLAY=:1. Like execFile: it
 * resolves with the output, or rejects with `stdout`, `stderr`, `code` (and
 * `killed` when it ran out of time) on the error.
 */
export type DeviceExec = (args: string[], opts?: { timeout?: number; binary?: boolean }) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/**
 * Cua Driver inside a Linux desktop container. Every action goes to the whole
 * desktop in the foreground: nobody else uses this screen, so there is no
 * focus to protect and foreground input is the most reliable on X11. How the
 * commands reach the container (Docker, Local Bot's runtime) is `exec`.
 */
export class CuaHands implements Hands {
  private driver?: string;

  constructor(private run: DeviceExec, private session: string) {}

  describe() {
    return [
      "Device: Debian Linux with an XFCE desktop, 1280x900 screen, user `cua`.",
      "Apps: Firefox ESR (`firefox-esr`), terminal, file manager. No sudo password.",
    ].join("\n");
  }

  private exec(args: string[], opts: { timeout?: number; binary?: boolean } = {}) {
    return this.run(args, opts);
  }

  /** Prefers a user-updated driver in ~/.local/bin over the one baked into the image. */
  private async driverPath() {
    if (!this.driver) {
      const updated = "/home/cua/.local/bin/cua-driver";
      this.driver = await this.exec(["test", "-x", updated]).then(() => updated, () => "cua-driver");
    }
    return this.driver;
  }

  /**
   * Cua Driver ends idle sessions after a few minutes and then rejects calls
   * that name them; reopen the session and retry once.
   */
  private async call(tool: string, args: Record<string, unknown>): Promise<any> {
    try {
      return await this.callOnce(tool, args);
    } catch (err) {
      if (!/session has ended|session_ended/i.test(err instanceof Error ? err.message : String(err))) throw err;
      await this.callOnce("start_session", {});
      return this.callOnce(tool, args);
    }
  }

  private async callOnce(tool: string, args: Record<string, unknown>) {
    const { stdout } = await this.exec([await this.driverPath(), "call", tool, JSON.stringify({ session: this.session, ...args })]);
    const out = String(stdout).trim();
    let result: any;
    try {
      result = JSON.parse(out);
    } catch {
      result = { message: out };
    }
    const refusal = result?.refusal?.message ?? (result?.status === "refused" ? result?.message : undefined);
    if (refusal) throw new Error(refusal);
    return result;
  }

  async screenshot(): Promise<Screenshot> {
    const file = `/tmp/localbot-${this.session}.png`;
    const meta = await this.call("get_desktop_state", { screenshot_out_file: file });
    const { stdout } = await this.exec(["cat", file], { binary: true });
    return {
      png: (stdout as unknown as Buffer).toString("base64"),
      width: meta.screenshot_width ?? 1280,
      height: meta.screenshot_height ?? 900,
    };
  }

  async act(tool: string, args: Record<string, unknown>) {
    const desktop = tool === "launch_app" ? {} : { scope: "desktop", delivery_mode: "foreground" };
    return this.call(tool, { ...desktop, ...args });
  }

  async shell(command: string, timeoutMs = 60_000) {
    try {
      const { stdout, stderr } = await this.exec(["bash", "-lc", command], { timeout: timeoutMs });
      return { code: 0, output: `${stdout}${stderr}` };
    } catch (err: any) {
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}` || err.message;
      return { code: typeof err.code === "number" ? err.code : 1, output: err.killed ? `${output}\n(timed out)` : output };
    }
  }
}

/** Cua Driver in a Docker container (`docker exec`). */
export class DockerCuaHands extends CuaHands {
  constructor(container: string, session: string) {
    super((args, opts = {}) => run("docker", ["exec", "-u", "cua", "-e", "DISPLAY=:1", container, ...args], {
      timeout: opts.timeout ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: opts.binary ? "buffer" : "utf8",
    }), session);
  }
}
