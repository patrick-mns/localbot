import { useEffect, useRef, useState } from "react";
import { brain } from "../brain";
import type { Bot, Message } from "../types";

/** A bot's chat: history a page at a time, live replies, send and stop. */
export function Chat({ bot, thinking }: { bot: Bot; thinking: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
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
        const copy = list.slice();
        copy[i] = { ...copy[i], ...m };
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

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setError(null);
    try {
      await brain.request("chat.send", { botId: bot.id, text });
    } catch (e) {
      setError((e as Error).message);
      setDraft(text);
    }
  };

  return (
    <section className="chat">
      <header className="chat-head">
        <div>
          <div className="title">{bot.name}</div>
          <div className="subtitle">{bot.model}</div>
        </div>
        {thinking && <button className="pill" onClick={() => brain.request("chat.stop", { botId: bot.id })}>Stop</button>}
      </header>
      <div className="messages">
        {messages.map((m) => <Bubble key={m.id} m={m} />)}
        {thinking && <div className="typing">Working…</div>}
        <div ref={end} />
      </div>
      {error && <div className="chat-error">{error}</div>}
      <div className="composer">
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
        <button className="send" disabled={!draft.trim()} onClick={send} aria-label="Send">↑</button>
      </div>
    </section>
  );
}

function Bubble({ m }: { m: Message }) {
  if (m.role === "activity") {
    return <div className={`activity ${m.error ? "failed" : ""}`} title={m.detail}>{m.error ? `${m.text} — ${m.error}` : m.text}</div>;
  }
  if (m.role === "user") {
    const label = m.routine ? `Routine · ${m.routine.name}` : m.from ? `From ${m.from.name}` : m.notice ? "Local Bot" : null;
    return (
      <div className="bubble user">
        {label && <div className="label">{label}</div>}
        {m.text}
      </div>
    );
  }
  return (
    <div className={`bubble bot ${m.error ? "failed" : ""}`} title={m.detail}>
      {m.text || (m.error ? "" : "…")}
      {m.error && <div className="error">{m.error}</div>}
    </div>
  );
}
