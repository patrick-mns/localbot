import { useState } from "react";
import { brain } from "../brain";
import type { ProviderStatus } from "../types";

/** First run: bots need a model provider. OpenRouter covers most models with one key. */
export function Setup({ status, onDone }: { status: ProviderStatus; onDone: () => void }) {
  const [preset, setPreset] = useState("openrouter");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = status.presets.find((p) => p.id === preset);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await brain.request("providers.add", { preset, ...(key.trim() ? { apiKey: key.trim() } : {}) });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <div className="setup-card">
        <h1>Welcome to Local Bot</h1>
        <p className="muted">Bots think with an AI model. Pick a provider and paste its API key; it’s stored encrypted for your Windows user ({status.secretStore}).</p>
        <label>Provider</label>
        <select value={preset} onChange={(e) => setPreset(e.target.value)}>
          {status.presets.filter((p) => p.id !== "custom").map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {!chosen?.keyless && (
          <>
            <label>API key</label>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key" autoFocus />
            {chosen?.keyURL && <a className="link" href={chosen.keyURL} target="_blank" rel="noreferrer">Get a key</a>}
          </>
        )}
        {error && <div className="chat-error">{error}</div>}
        <button className="primary" disabled={busy || (!chosen?.keyless && !key.trim())} onClick={save}>
          {busy ? "Saving…" : "Continue"}
        </button>
      </div>
    </div>
  );
}
