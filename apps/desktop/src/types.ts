export interface Bot {
  id: string;
  name: string;
  role: string;
  instructions?: string;
  provider: string;
  model: string;
  status?: "thinking" | "idle";
  /** Devices it can use: "owner" is its own. */
  computers?: { computerId: string; role: "owner" | "guest" }[];
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

export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  devicePath?: string;
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
  /** Files the user sent, or the bot shared. */
  files?: Attachment[];
  /** Sent while the bot was working; it reads it at its next step. */
  queued?: boolean;
  /** The bot asks to connect (or allow) an app. */
  connect?: { connector: string; name: string; description: string; mode: "connect" | "allow"; reason?: string; state: "pending" | "connected" | "dismissed" };
}

export interface ProviderStatus {
  defaultProvider: string;
  defaultModel: string;
  secretStore: string;
  presets: { id: string; label: string; keyURL?: string; suggestedModel?: string; local?: boolean; keyless?: boolean }[];
  providers: { id: string; preset: string; label: string; configured: boolean; keyHint: string | null }[];
}
