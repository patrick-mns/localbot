export interface Bot {
  id: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  status?: "thinking" | "idle";
}

export interface Computer {
  id: string;
  name: string;
  provider: string;
  os: string;
  state: "running" | "stopped" | "creating" | "error" | string;
  display: { kind: "vnc"; url: string; password?: string } | { kind: string; [k: string]: unknown };
  bots: string[];
}

export interface Message {
  id: string;
  botId: string;
  role: "user" | "assistant" | "activity";
  text: string;
  at: string;
  error?: string;
  detail?: string;
  routine?: { id: string; name: string };
  from?: { botId: string; name: string };
  notice?: boolean;
}

export interface ProviderStatus {
  defaultProvider: string;
  defaultModel: string;
  secretStore: string;
  presets: { id: string; label: string; keyURL?: string; suggestedModel?: string; local?: boolean; keyless?: boolean }[];
  providers: { id: string; preset: string; label: string; configured: boolean; keyHint: string | null }[];
}
