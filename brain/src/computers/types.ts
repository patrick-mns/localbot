import type { Hands } from "../hands/types.ts";

/**
 * A "computer" is the machine bots work on. Each platform plugs in its own
 * provider behind this interface:
 *   - Docker: a Linux desktop container — runs on macOS, Windows and Linux
 *   - Lume: macOS VMs on Apple silicon (Virtualization.framework)
 *   - Remote: any machine serving the device agent over MCP (remote.ts),
 *     and cloud providers that create one (Railway)
 *   - later: QEMU/KVM on Linux, Hyper-V on Windows
 *
 * Displaying the screen is the shell's job (VNC in a web view, or a native
 * VZVirtualMachineView on macOS); `display` tells the shell how to attach.
 */
export type ComputerState = "creating" | "stopped" | "starting" | "running" | "stopping" | "error";

export interface Computer {
  id: string;
  name: string;
  provider: string;
  os: "macos" | "linux" | "windows";
  state: ComputerState;
  cpu?: number;
  memoryGB?: number;
  /** How a shell shows this computer's screen. */
  display:
    | { kind: "vnc"; url: string; password?: string }
    | { kind: "native-vz"; bundlePath: string } // macOS shell boots it in-process
    | { kind: "none" };
}

export interface ComputerProvider {
  readonly name: string;
  /** Whether this provider can run on the current host. */
  available(): Promise<boolean>;
  list(): Promise<Computer[]>;
  /** Providers whose computers the shell boots itself (native-vz) leave these out. */
  start?(id: string): Promise<void>;
  stop?(id: string): Promise<void>;
  /**
   * Creates a new device and returns its id (may keep provisioning in the
   * background). `options` carries the kind's extra fields (see computers.kinds).
   */
  /** Creates a device; `progress` follows the setup steps (see SetupProgress). */
  create?(name: string, options?: Record<string, string>, progress?: SetupProgress): Promise<string>;
  remove?(id: string): Promise<void>;
  /** A share code another Local Bot can paste to connect to this device (see share.ts). */
  share?(id: string): Promise<string>;
  /** Hands for a running computer, or null when it can't be driven right now. */
  hands?(id: string, session: string): Promise<Hands | null>;
}

/** Setup steps of a new device, for the app's progress list. */
export type SetupStep = "download" | "start" | "controls" | "screen";
export type SetupProgress = (step: SetupStep, status: "active" | "done" | "skipped" | "failed", detail?: { fraction?: number; error?: string }) => void;
