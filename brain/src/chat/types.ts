/**
 * Generic conversation provider. Anything that streams chat completions plugs
 * in here: OpenRouter today; OpenAI, Anthropic, Ollama/LM Studio (local) later.
 * Messages and tools follow the OpenAI Chat Completions shape, which most
 * providers speak.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength?: number;
  /** Longest reply the model can give, when the service says. */
  maxOutput?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  /** A tighter cap on the reply (quick checks); the provider's own cap still applies. */
  maxTokens?: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
}

export interface ChatProvider {
  readonly id: string;
  readonly label: string;
  configured(): boolean;
  /** Lists models; `fresh` bypasses the cache. */
  models(fresh?: boolean): Promise<ModelInfo[]>;
  /** Streams text through onDelta and resolves with the full text plus any tool calls. */
  chat(req: ChatRequest): Promise<ChatResult>;
}
