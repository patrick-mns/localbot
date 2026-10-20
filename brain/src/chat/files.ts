import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { HOME } from "../store.ts";
import type { Hands } from "../hands/types.ts";

/** A file a bot handed over in the chat: copied off its device, kept here. */
export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** Where it was copied on the bot's device (files the user sent). */
  devicePath?: string;
}

/** Larger files stay on the device; the bot says where they are instead. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".txt": "text/plain",
  ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".html": "text/html",
  ".zip": "application/zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".flac": "audio/flac", ".ogg": "audio/ogg", ".aiff": "audio/aiff",
};

export const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

/** Files live in ~/.local-bot/files/<bot>/<file id>/<name>. */
export class FileStore {
  constructor(private root = join(HOME, "files")) {}

  save(botId: string, name: string, data: Buffer): Attachment {
    const id = randomUUID();
    const safe = basename(name).replace(/[\0/\\]/g, "_") || "file";
    const dir = join(this.root, safe_(botId), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, safe), data, { mode: 0o600 });
    return { id, name: safe, size: data.length, mime: mimeOf(safe) };
  }

  read(botId: string, file: Attachment): Buffer {
    return readFileSync(this.path(botId, file));
  }

  /** Where it is on this machine (the app on the same Mac copies it directly). */
  path(botId: string, file: Attachment) {
    return join(this.root, safe_(botId), safe_(file.id), basename(file.name));
  }

  clearAll() {
    rmSync(this.root, { recursive: true, force: true });
  }

  clear(botId: string) {
    rmSync(join(this.root, safe_(botId)), { recursive: true, force: true });
  }
}

const safe_ = (part: string) => {
  if (!/^[\w-]+$/.test(part)) throw new Error("Invalid id");
  return part;
};

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Copies a file off a device using only its shell, so it works the same on a
 * local container and a remote device. Read in base64 chunks to stay under
 * the shell's output limits.
 */
export async function readDeviceFile(hands: Hands, path: string): Promise<Buffer> {
  const q = quote(path);
  const stat = await hands.shell(`test -f ${q} && stat -c %s -- ${q}`);
  const size = Number(stat.output.trim());
  if (stat.code !== 0 || !Number.isFinite(size)) throw new Error(`No file at ${path}`);
  if (size > MAX_FILE_BYTES) throw new Error(`${basename(path)} is ${Math.round(size / 1024 / 1024)} MB; the limit is ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < size || offset === 0; offset += CHUNK_BYTES) {
    const r = await hands.shell(`dd if=${q} bs=${CHUNK_BYTES} skip=${offset / CHUNK_BYTES} count=1 2>/dev/null | base64 -w0`, 120_000);
    if (r.code !== 0) throw new Error(`Couldn’t read ${path}`);
    parts.push(Buffer.from(r.output.trim(), "base64"));
    if (size === 0) break;
  }
  const data = Buffer.concat(parts);
  if (data.length !== size) throw new Error(`Read ${data.length} of ${size} bytes of ${path}`);
  return data;
}

/**
 * Copies a file to a device through its shell, in base64 chunks small enough
 * for a command line. Returns the path it ended up at (a free name in `dir`).
 */
export async function writeDeviceFile(hands: Hands, dir: string, name: string, data: Buffer): Promise<string> {
  const safe = basename(name).replace(/[^\w.\- ]/g, "_") || "file";
  const ext = extname(safe), stem = safe.slice(0, safe.length - ext.length);
  // "~/x" means the device user's home (a quoted ~ wouldn't expand).
  const target = dir.startsWith("~/") ? `"$HOME"/${quote(dir.slice(2))}` : quote(dir);
  const pick = await hands.shell(
    `mkdir -p ${target} && cd ${target} && n=${quote(safe)}; i=2; ` +
    `while [ -e "$n" ]; do n=${quote(stem)}" $i"${quote(ext)}; i=$((i+1)); done; : > "$n" && printf '%s/%s' "$PWD" "$n"`,
  );
  const path = pick.output.trim().split("\n").pop() ?? "";
  if (pick.code !== 0 || !path.startsWith("/")) throw new Error(`Couldn’t create ${safe} on the device`);
  // Linux caps one command-line argument at 128 KB: 64 KB of bytes is ~87 KB of base64.
  const CHUNK = 64 * 1024;
  for (let at = 0; at < data.length; at += CHUNK) {
    const b64 = data.subarray(at, at + CHUNK).toString("base64");
    const r = await hands.shell(`printf '%s' '${b64}' | base64 -d >> ${quote(path)}`, 120_000);
    if (r.code !== 0) throw new Error(`Couldn’t copy ${safe} to the device`);
  }
  return path;
}
