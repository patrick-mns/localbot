import { useCallback, useEffect, useMemo, useState } from "react";
import { brain } from "./brain";
import type { Bot, Computer, ProviderStatus } from "./types";
import { Sidebar, type Selection } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Screen } from "./components/Screen";
import { Setup } from "./components/Setup";
import { Modal } from "./components/Modal";
import { BotEditor } from "./components/BotEditor";
import { Settings } from "./components/Settings";

export function App() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [computers, setComputers] = useState<Computer[]>([]);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [thinking, setThinking] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection>(null);
  const [controlling, setControlling] = useState(false);
  const [dialog, setDialog] = useState<"bot" | "device" | "editBot" | "settings" | null>(null);
  const [brainError, setBrainError] = useState<string | null>(null);

  const refreshBots = useCallback(async () => {
    const list = await brain.request<Bot[]>("bots.list");
    setBots(list);
    setThinking(new Set(list.filter((b) => b.status === "thinking").map((b) => b.id)));
  }, []);
  const refreshComputers = useCallback(async () => setComputers(await brain.request<Computer[]>("computers.list")), []);
  const refreshProviders = useCallback(async () => setProviders(await brain.request<ProviderStatus>("providers.status")), []);

  const load = useCallback(() =>
    Promise.all([refreshBots(), refreshComputers(), refreshProviders()]).catch((e) => setBrainError(String(e.message ?? e))),
  [refreshBots, refreshComputers, refreshProviders]);

  useEffect(() => {
    void load();
    const offs = [
      brain.on("bots", () => void refreshBots()),
      brain.on("computers", () => void refreshComputers()),
      brain.on("providers", () => void refreshProviders()),
      brain.on("bot.status", ({ botId, status }: { botId: string; status: string }) =>
        setThinking((s) => {
          const next = new Set(s);
          if (status === "thinking") next.add(botId);
          else next.delete(botId);
          return next;
        })),
      brain.on("brain.exit", (code: number | null) =>
        setBrainError(brain.startError ? `The brain couldn’t start: ${brain.startError}` : `The brain stopped (exit code ${code ?? "unknown"}).`)),
    ];
    // Devices change outside the app too (docker): poll their state.
    const poll = setInterval(() => void refreshComputers().catch(() => {}), 5000);
    return () => {
      offs.forEach((off) => off());
      clearInterval(poll);
    };
  }, [load, refreshBots, refreshComputers, refreshProviders]);

  // Select the first bot once there is one.
  useEffect(() => {
    if (!selection && bots[0]) setSelection({ kind: "bot", id: bots[0].id });
  }, [bots, selection]);

  const bot = selection?.kind === "bot" ? bots.find((b) => b.id === selection.id) : undefined;
  const device = useMemo(() => {
    if (selection?.kind === "device") return computers.find((c) => c.id === selection.id);
    if (bot) return computers.find((c) => c.bots.includes(bot.id));
    return undefined;
  }, [selection, computers, bot]);

  if (brainError) return <BrainError message={brainError} onRetry={() => { setBrainError(null); void brain.restart().then(load); }} />;
  if (!providers) return <div className="setup"><div className="muted">Starting…</div></div>;
  if (!providers.providers.some((p) => p.configured)) return <Setup status={providers} onDone={() => void refreshProviders()} />;

  return (
    <div className={`layout ${bot ? "" : "no-chat"}`}>
      <Sidebar bots={bots} computers={computers} thinking={thinking} selection={selection}
        onSelect={(s) => { setSelection(s); setControlling(false); }}
        onNewBot={() => setDialog("bot")} onNewDevice={() => setDialog("device")} onSettings={() => setDialog("settings")} />
      <main className="stage">
        <header className="stage-head">
          <div>
            <div className="title">{device ? device.name : bot ? `${bot.name}’s device` : "Local Bot"}</div>
            <div className="subtitle">{device ? `${device.os === "linux" ? "Linux" : device.os} · ${device.state}` : bot ? "No device yet" : ""}</div>
          </div>
          {device && (
            <div className="actions">
              {device.state === "running" && (
                <button className={`pill ${controlling ? "active" : ""}`} onClick={() => setControlling((c) => !c)}>
                  {controlling ? "Give back control" : "Take control"}
                </button>
              )}
              {device.state === "running"
                ? <button className="pill" onClick={() => brain.request("computers.stop", { id: device.id })}>Shut down</button>
                : device.state === "stopped" && <button className="pill" onClick={() => brain.request("computers.start", { id: device.id })}>Start</button>}
            </div>
          )}
        </header>
        <div className="stage-body">
          {device ? <Screen computer={device} controlling={controlling} />
            : <div className="screen-empty">{bot ? "This bot has no device. Add one in Devices and give the bot access." : "Create a bot to get started."}</div>}
        </div>
      </main>
      {bot && <Chat bot={bot} thinking={thinking.has(bot.id)} onEdit={() => setDialog("editBot")} />}
      {dialog === "bot" && <NewBot computers={computers} onClose={() => setDialog(null)} onCreated={(id) => setSelection({ kind: "bot", id })} />}
      {dialog === "device" && <NewDevice onClose={() => setDialog(null)} onCreated={(id) => setSelection({ kind: "device", id })} />}
      {dialog === "editBot" && bot && (
        <BotEditor bot={bot} computers={computers} providers={providers} onClose={() => setDialog(null)} onDeleted={() => setSelection(null)} />
      )}
      {dialog === "settings" && <Settings providers={providers} computers={computers} onClose={() => setDialog(null)} />}
    </div>
  );
}

function NewBot({ computers, onClose, onCreated }: { computers: Computer[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [device, setDevice] = useState(computers[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    try {
      const bot = await brain.request<{ id: string }>("bots.create", { name: name.trim(), role: role.trim(), instructions: "" });
      if (device) await brain.request("access.grant", { botId: bot.id, computerId: device, role: "owner" });
      onCreated(bot.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="New bot" onClose={onClose}>
      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Ninja" />
      <label>Role</label>
      <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="What it does, in a few words" />
      <label>Device</label>
      <select value={device} onChange={(e) => setDevice(e.target.value)}>
        <option value="">None for now</option>
        {computers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {error && <div className="chat-error">{error}</div>}
      <button className="primary" disabled={!name.trim()} onClick={create}>Create bot</button>
    </Modal>
  );
}

/** A Linux device in Docker, with the setup steps as they happen. */
function NewDevice({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("Linux");
  const [req, setReq] = useState<{ docker: string; imageReady: boolean; freeGB: number | null; needGB: number } | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    brain.request("computers.requirements").then(setReq).catch((e) => setError(e.message));
  }, []);

  const create = async () => {
    const setupId = crypto.randomUUID();
    const steps: Record<string, string> = { download: "Downloading the image", start: "Starting", controls: "Installing controls", screen: "Opening the screen" };
    const off = brain.on("device.setup", (e: { setupId: string; step: string; status: string; fraction?: number }) => {
      if (e.setupId !== setupId || e.status !== "active") return;
      setStep(`${steps[e.step] ?? e.step}…${e.fraction != null ? ` ${Math.round(e.fraction * 100)}%` : ""}`);
    });
    setError(null);
    setStep("Starting…");
    try {
      const { id } = await brain.request<{ id: string }>("computers.create", { kind: "docker", name: name.trim(), setupId });
      onCreated(id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setStep(null);
    } finally {
      off();
    }
  };

  return (
    <Modal title="New Linux device" onClose={onClose}>
      <p className="muted">A Linux desktop in Docker that your bots can use. The first one downloads its image (~1–2 GB).</p>
      {req?.docker === "missing" && <div className="chat-error">Docker Desktop isn’t installed. Install it from docker.com, then come back.</div>}
      {req?.docker === "stopped" && <div className="chat-error">Docker Desktop isn’t running. Open it and try again.</div>}
      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} />
      {step && <div className="muted">{step}</div>}
      {error && <div className="chat-error">{error}</div>}
      <button className="primary" disabled={!name.trim() || !!step || req?.docker !== "running"} onClick={create}>
        {step ? "Creating…" : "Create device"}
      </button>
    </Modal>
  );
}

/** The brain didn't start or stopped: say why (its log) and offer to try again. */
function BrainError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [details, setDetails] = useState("");
  useEffect(() => {
    brain.diagnostics().then(setDetails).catch(() => {});
  }, [message]);
  return (
    <div className="setup">
      <div className="setup-card wide">
        <h1>Something went wrong</h1>
        <p className="muted">{message}</p>
        {details && <pre className="detail selectable">{details}</pre>}
        <div className="modal-actions">
          <button className="pill" onClick={() => navigator.clipboard.writeText(`${message}\n\n${details}`)}>Copy details</button>
          <span className="spacer" />
          <button className="primary" onClick={onRetry}>Try again</button>
        </div>
      </div>
    </div>
  );
}
