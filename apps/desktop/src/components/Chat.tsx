import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { brain } from "../brain";
import type { Bot, Message } from "../types";
import { Markdown } from "./Markdown";
import { Files } from "./Files";

const fileName = (path: string) => path.split(/[\\/]/).pop() || "file";

/**
 * A bot's chat: history a page at a time, live replies, send and stop. While
 * the bot works you can still write: the message waits ("queued") and the bot
 * reads it at its next step.
 */
export function Chat({ bot, thinking, onEdit }: { bot: Bot; thinking: boolean; onEdit: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setMessages([]);
    brain.request<{ messages: Message[] }>("chat.page", { botId: bot.id, limit: 60 })
      .then((page) => live && setMessages(page.messages))
      .catch((e) => live && setError(e.message));
    const upsert = (m: Message) => {
      if (m.botId !== bot.id) return;
      setMessages((list) => {
        const i = list.findIndex((x) => x.id === m.id);
        if (i < 0) return [...list, m];
        // A queued message, now read, moves to where the bot read it.
        if (list[i].queued && !m.queued) return [...list.slice(0, i), ...list.slice(i + 1), m];
        const copy = list.slice();
        // The final message carries the full text; keep the streamed text if it's empty.
        copy[i] = m.text || m.error || m.files || m.connect ? m : { ...copy[i], ...m, text: copy[i].text };
        return copy;
      });
    };
    const offs = [
      brain.on("message", upsert),
      brain.on("message.delta", ({ id, botId, delta }: { id: string; botId: string; delta: string }) => {
        if (botId !== bot.id) return;
        setMessages((list) => list.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m)));
      }),
      brain.on("message.done", (m: Message & { empty?: boolean }) => {
        if (m.botId !== bot.id) return;
        // Pure tool calls leave an empty reply: drop it.
        if (m.empty) setMessages((list) => list.filter((x) => x.id !== m.id));
        else upsert(m);
      }),
    ];
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, [bot.id]);

  // Files dropped anywhere on the window go with the next message.
  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "over" || e.payload.type === "enter") setDropping(true);
      else if (e.payload.type === "leave") setDropping(false);
      else if (e.payload.type === "drop") {
        setDropping(false);
        add(e.payload.paths);
      }
    });
    return () => { void off.then((f) => f()); };
  }, []);

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages]);

  const add = (paths: string[]) => setPending((p) => [...p, ...paths.filter((x) => !p.includes(x))].slice(0, 10));

  const pick = async () => {
    const chosen = await open({ multiple: true, directory: false });
    if (chosen) add(Array.isArray(chosen) ? chosen : [chosen]);
  };

  const canSend = !!draft.trim() || pending.length > 0;
  const send = async () => {
    if (!canSend) return;
    const text = draft.trim(), files = pending;
    setDraft("");
    setPending([]);
    setError(null);
    try {
      await brain.request("chat.send", { botId: bot.id, text, files: files.map((path) => ({ name: fileName(path), path })) });
    } catch (e) {
      setError((e as Error).message);
      setDraft(text);
      setPending(files);
    }
  };
  const stop = () => brain.request("chat.stop", { botId: bot.id });
  // While the bot works: with something typed the button sends, empty it stops.
  const stops = thinking && !canSend;

  return (
    <section className={`chat ${dropping ? "dropping" : ""}`}>
      <header className="chat-head">
        <div>
          <div className="title">{bot.name}</div>
          <div className="subtitle">{bot.model}</div>
        </div>
        <div className="actions">
          {thinking && <button className="pill" onClick={stop}>Stop</button>}
          <button className="icon" onClick={onEdit} title={`${bot.name} settings`}>⚙</button>
        </div>
      </header>
      <div className="messages">
        {messages.map((m) => <Bubble key={m.id} m={m} bot={bot} />)}
        {thinking && <div className="typing">Working…</div>}
        <div ref={end} />
      </div>
      {error && <div className="chat-error">{error}</div>}
      <div className="composer">
        {pending.length > 0 && (
          <div className="pending">
            {pending.map((p) => (
              <span key={p} className="chip" title={p}>
                {fileName(p)}
                <button className="icon" onClick={() => setPending((list) => list.filter((x) => x !== p))} aria-label="Remove">×</button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button className="icon add" onClick={pick} title="Add files or images">+</button>
          <textarea
            value={draft}
            placeholder={`Message ${bot.name}…`}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="send" disabled={!canSend && !thinking} onClick={stops ? stop : send}
            title={stops ? "Stop the current task" : thinking ? `Send now; ${bot.name} reads it at its next step` : "Send"}>
            {stops ? "■" : "↑"}
          </button>
        </div>
      </div>
    </section>
  );
}

function Bubble({ m, bot }: { m: Message; bot: Bot }) {
  const [details, setDetails] = useState(false);
  if (m.role === "activity") {
    return (
      <div className={`activity ${m.error ? "failed" : ""}`} onClick={() => m.detail && setDetails((d) => !d)}>
        {m.error ? `${m.text} — ${m.error}` : m.text}
        {details && m.detail && <pre className="detail">{m.detail}</pre>}
      </div>
    );
  }
  if (m.connect) return <ConnectCard m={m} bot={bot} />;
  if (m.role === "user") {
    const label = m.routine ? `Routine · ${m.routine.name}` : m.from ? `From ${m.from.name}` : m.notice ? "Local Bot" : null;
    return (
      <div className="user-msg">
        {label && <div className="label">{label}</div>}
        {m.files?.length ? <Files botId={m.botId} files={m.files} /> : null}
        {m.text !== "(sent files)" && <div className={`bubble user ${m.queued ? "queued" : ""}`}>{m.text}</div>}
        {m.queued && <div className="label">Queued · {bot.name} reads it at the next step</div>}
      </div>
    );
  }
  return (
    <div className={`bubble bot ${m.error ? "failed" : ""}`}>
      {m.text ? <Markdown text={m.text} /> : !m.error && !m.files?.length ? "…" : null}
      {m.files?.length ? <Files botId={m.botId} files={m.files} /> : null}
      {m.error && (
        <div className="error" onClick={() => setDetails((d) => !d)}>
          {m.error}{m.detail ? (details ? " ▾" : " ▸") : ""}
          {details && m.detail && <pre className="detail">{m.detail}</pre>}
        </div>
      )}
    </div>
  );
}

/** The bot asks to connect (or allow) an app it needs. */
function ConnectCard({ m, bot }: { m: Message; bot: Bot }) {
  const c = m.connect!;
  const [error, setError] = useState<string | null>(null);
  const act = async () => {
    setError(null);
    try {
      if (c.mode === "allow") await brain.request("connectors.allow", { botId: bot.id, id: c.connector });
      else {
        const { url } = await brain.request<{ url: string }>("connectors.connect", { id: c.connector });
        await openUrl(url);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="connect-card">
      <div className="title">{c.mode === "allow" ? `Let ${bot.name} use ${c.name}?` : `Connect ${c.name}`}</div>
      <div className="subtitle">{c.reason || c.description}</div>
      {error && <div className="chat-error">{error}</div>}
      {c.state === "pending" ? (
        <div className="actions">
          <button className="pill" onClick={() => brain.request("connectors.dismiss", { messageId: m.id })}>Not now</button>
          <button className="pill active" onClick={act}>{c.mode === "allow" ? "Allow" : "Connect"}</button>
        </div>
      ) : (
        <div className="subtitle">{c.state === "connected" ? "Connected ✓" : "Dismissed"}</div>
      )}
    </div>
  );
}
