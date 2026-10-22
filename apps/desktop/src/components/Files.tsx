import { useEffect, useState } from "react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { brain } from "../brain";
import type { Attachment } from "../types";

const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

/** Where a chat file is on this machine (the brain keeps it in ~/.local-bot/files). */
async function localPath(botId: string, file: Attachment) {
  const r = await brain.request<{ path: string }>("chat.file", { botId, fileId: file.id, inline: false });
  return r.path;
}

/** Files in a message: images as thumbnails, the rest as cards; click opens, ⋯ shows in the folder. */
export function Files({ botId, files }: { botId: string; files: Attachment[] }) {
  return (
    <div className="files">
      {files.map((f) => (f.mime.startsWith("image/") && f.size <= 5_000_000
        ? <ImageFile key={f.id} botId={botId} file={f} />
        : <FileCard key={f.id} botId={botId} file={f} />))}
    </div>
  );
}

function FileCard({ botId, file }: { botId: string; file: Attachment }) {
  const [error, setError] = useState<string | null>(null);
  const run = (f: (path: string) => Promise<void>) => localPath(botId, file).then(f).catch((e) => setError(String(e.message ?? e)));
  return (
    <div className="file-card" title={error ?? file.name}>
      <button className="file-open" onClick={() => run(openPath)}>
        <span className="file-ext">{(file.name.split(".").pop() ?? "").slice(0, 4).toUpperCase() || "FILE"}</span>
        <span className="file-text">
          <span className="file-name">{file.name}</span>
          <span className="file-size">{error ?? size(file.size)}</span>
        </span>
      </button>
      <button className="icon" title="Show in folder" onClick={() => run(revealItemInDir)}>⋯</button>
    </div>
  );
}

function ImageFile({ botId, file }: { botId: string; file: Attachment }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    brain.request<{ data: string; mime: string }>("chat.file", { botId, fileId: file.id })
      .then((r) => live && setSrc(`data:${r.mime ?? file.mime};base64,${r.data}`))
      .catch(() => {});
    return () => { live = false; };
  }, [botId, file.id]);
  return (
    <button className="image-file" title={file.name} onClick={() => localPath(botId, file).then(openPath).catch(() => {})}>
      {src ? <img src={src} alt={file.name} /> : <span className="file-size">{file.name}</span>}
    </button>
  );
}
