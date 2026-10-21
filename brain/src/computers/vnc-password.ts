import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The devices' screen (VNC) password, generated once and kept in ~/.local-bot (0600). */
export function vncPassword(home: string) {
  const file = join(home, "vnc-password");
  if (!existsSync(file)) {
    mkdirSync(home, { recursive: true });
    writeFileSync(file, randomBytes(8).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(file, "utf8").trim();
}
