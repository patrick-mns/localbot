import { useEffect, useState } from "react";
import { brain } from "../brain";
import type { Bot, Computer, ProviderStatus } from "../types";
import { Modal } from "./Modal";

/** A bot's settings: who it is, its model and its own device; or delete it. */
export function BotEditor({ bot, computers, providers, onClose, onDeleted }: {
  bot: Bot; computers: Computer[]; providers: ProviderStatus; onClose: () => void; onDeleted: () => void;
}) {
  const own = bot.computers?.find((a) => a.role === "owner")?.computerId ?? "";
  const [name, setName] = useState(bot.name);
  const [role, setRole] = useState(bot.role);
  const [instructions, setInstructions] = useState(bot.instructions ?? "");
  const [provider, setProvider] = useState(bot.provider);
  const [model, setModel] = useState(bot.model);
  const [device, setDevice] = useState(own);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    brain.request<{ id: string; name: string }[]>("providers.models", { provider }).then(setModels).catch(() => setModels([]));
  }, [provider]);

  const save = async () => {
    setError(null);
    try {
      await brain.request("bots.update", { id: bot.id, name: name.trim(), role: role.trim(), instructions, provider, model: model.trim() });
      if (device !== own) {
        if (own) await brain.request("access.revoke", { botId: bot.id, computerId: own });
        if (device) await brain.request("access.grant", { botId: bot.id, computerId: device, role: "owner" });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    try {
      await brain.request("bots.delete", { id: bot.id });
      onDeleted();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={`${bot.name} settings`} onClose={onClose} wide>
      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <label>Role</label>
      <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="What it does, in a few words" />
      <label>Instructions</label>
      <textarea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="How it should work, what to avoid…" />
      <div className="row2">
        <div>
          <label>Provider</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {providers.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label>Model</label>
          <input list="models" value={model} onChange={(e) => setModel(e.target.value)} />
          <datalist id="models">{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
        </div>
      </div>
      <label>Device</label>
      <select value={device} onChange={(e) => setDevice(e.target.value)}>
        <option value="">None</option>
        {computers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {error && <div className="chat-error">{error}</div>}
      <div className="modal-actions">
        {confirming
          ? <button className="pill danger" onClick={remove}>Delete {bot.name}, its chat and memory</button>
          : <button className="pill" onClick={() => setConfirming(true)}>Delete bot…</button>}
        <span className="spacer" />
        <button className="primary" disabled={!name.trim() || !model.trim()} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
