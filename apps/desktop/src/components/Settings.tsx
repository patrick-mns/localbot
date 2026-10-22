import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { brain } from "../brain";
import type { Computer, ProviderStatus } from "../types";
import { Modal } from "./Modal";

/** AI providers (keys), the default model for new bots, devices, and the version. */
export function Settings({ providers, computers, onClose }: { providers: ProviderStatus; computers: Computer[]; onClose: () => void }) {
  const [tab, setTab] = useState<"providers" | "devices" | "about">("providers");
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="tabs">
        {(["providers", "devices", "about"] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? "selected" : ""}`} onClick={() => setTab(t)}>
            {t === "providers" ? "AI providers" : t === "devices" ? "Devices" : "About"}
          </button>
        ))}
      </div>
      {tab === "providers" && <Providers status={providers} />}
      {tab === "devices" && <Devices computers={computers} />}
      {tab === "about" && <About status={providers} />}
    </Modal>
  );
}

function Providers({ status }: { status: ProviderStatus }) {
  const [preset, setPreset] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState(status.defaultModel);
  const [defaultProvider, setDefaultProvider] = useState(status.defaultProvider);
  const [error, setError] = useState<string | null>(null);
  const chosen = status.presets.find((p) => p.id === preset);
  const run = (f: () => Promise<unknown>) => { setError(null); f().catch((e) => setError(e.message)); };

  return (
    <div className="settings-body">
      {status.providers.map((p) => (
        <div key={p.id} className="list-row">
          <div className="row-text">
            <span className="row-title">{p.label}</span>
            <span className="row-sub">{p.configured ? `Key ${p.keyHint ?? "set"}` : "No key"}{p.id === status.defaultProvider ? " · default" : ""}</span>
          </div>
          <button className="pill" onClick={() => run(() => brain.request("providers.remove", { id: p.id }))}>Remove</button>
        </div>
      ))}

      <div className="section-title">Default for new bots</div>
      <div className="row2">
        <select value={defaultProvider} onChange={(e) => setDefaultProvider(e.target.value)}>
          {status.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model id" />
      </div>
      <div className="modal-actions">
        <span className="spacer" />
        <button className="pill" disabled={!model.trim()}
          onClick={() => run(() => brain.request("providers.setDefault", { provider: defaultProvider, model: model.trim() }))}>Save default</button>
      </div>

      <div className="section-title">Add a provider</div>
      <select value={preset} onChange={(e) => setPreset(e.target.value)}>
        <option value="">Choose…</option>
        {status.presets.filter((p) => p.id !== "custom").map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {chosen && !chosen.keyless && (
        <>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" />
          {chosen.keyURL && <a className="link" onClick={() => openUrl(chosen.keyURL!)}>Get a key</a>}
        </>
      )}
      {error && <div className="chat-error">{error}</div>}
      <div className="modal-actions">
        <span className="muted small">Keys are stored encrypted for your user ({status.secretStore}).</span>
        <span className="spacer" />
        <button className="primary" disabled={!chosen || (!chosen.keyless && !key.trim())}
          onClick={() => run(async () => {
            await brain.request("providers.add", { preset, ...(key.trim() ? { apiKey: key.trim() } : {}) });
            setPreset("");
            setKey("");
          })}>Add</button>
      </div>
    </div>
  );
}

function Devices({ computers }: { computers: Computer[] }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="settings-body">
      {computers.length === 0 && <div className="muted">No devices yet.</div>}
      {computers.map((c) => (
        <div key={c.id} className="list-row">
          <div className="row-text">
            <span className="row-title">{c.name}</span>
            <span className="row-sub">{c.os === "linux" ? "Linux" : c.os} · {c.state} · {c.bots.length} bot{c.bots.length === 1 ? "" : "s"}</span>
          </div>
          {confirm === c.id
            ? <button className="pill danger" onClick={() => brain.request("computers.remove", { id: c.id }).catch((e) => setError(e.message)).finally(() => setConfirm(null))}>Delete it and its files</button>
            : <button className="pill" onClick={() => setConfirm(c.id)}>Delete…</button>}
        </div>
      ))}
      {error && <div className="chat-error">{error}</div>}
    </div>
  );
}

function About({ status }: { status: ProviderStatus }) {
  const [version, setVersion] = useState("");
  useEffect(() => {
    brain.request<{ version: string }>("app.info").then((i) => setVersion(i.version)).catch(() => {});
  }, []);
  return (
    <div className="settings-body">
      <div className="list-row"><span className="row-title">Local Bot</span><span className="muted">{version}</span></div>
      <div className="list-row"><span className="row-title">Secret storage</span><span className="muted">{status.secretStore}</span></div>
      <a className="link" onClick={() => openUrl("https://github.com/patrick-mns/localbot")}>github.com/patrick-mns/localbot</a>
    </div>
  );
}
