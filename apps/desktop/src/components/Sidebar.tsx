import type { Bot, Computer } from "../types";

export type Selection = { kind: "bot"; id: string } | { kind: "device"; id: string } | null;

/** Bots and devices, as in the macOS app's sidebar. */
export function Sidebar({ bots, computers, thinking, selection, onSelect, onNewBot, onNewDevice, onSettings }: {
  bots: Bot[];
  computers: Computer[];
  thinking: Set<string>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onNewBot: () => void;
  onNewDevice: () => void;
  onSettings: () => void;
}) {
  return (
    <nav className="sidebar">
      <div className="section-head">
        <span>BOTS</span>
        <button className="icon" onClick={onNewBot} title="New bot">+</button>
      </div>
      {bots.length === 0 && <div className="empty">No bots yet</div>}
      {bots.map((b) => (
        <button key={b.id} className={`row ${selection?.kind === "bot" && selection.id === b.id ? "selected" : ""}`}
          onClick={() => onSelect({ kind: "bot", id: b.id })}>
          <span className={`avatar ${thinking.has(b.id) ? "working" : ""}`}>{b.name.slice(0, 1)}</span>
          <span className="row-text">
            <span className="row-title">{b.name}</span>
            <span className="row-sub">{thinking.has(b.id) ? "Working…" : b.role || "Bot"}</span>
          </span>
        </button>
      ))}
      <div className="section-head">
        <span>DEVICES</span>
        <button className="icon" onClick={onNewDevice} title="Add device">+</button>
      </div>
      {computers.length === 0 && <div className="empty">No devices yet</div>}
      {computers.map((c) => (
        <button key={c.id} className={`row ${selection?.kind === "device" && selection.id === c.id ? "selected" : ""}`}
          onClick={() => onSelect({ kind: "device", id: c.id })}>
          <span className={`dot ${c.state}`} />
          <span className="row-text">
            <span className="row-title">{c.name}</span>
            <span className="row-sub">{c.os === "linux" ? "Linux" : c.os} · {c.state}</span>
          </span>
        </button>
      ))}
      <button className="settings-button" onClick={onSettings} title="Settings">⚙ Settings</button>
    </nav>
  );
}
