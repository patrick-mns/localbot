import type { ChatProvider, ChatRequest, ChatResult, ModelInfo, ToolCall } from "./types.ts";

export interface OpenAICompatibleOptions {
  id: string;
  label: string;
  baseURL: string;
  apiKey: () => string | undefined;
  /** Extra headers, e.g. OpenRouter's app attribution. */
  headers?: Record<string, string>;
  /** Local servers (Ollama, LM Studio) need no key. */
  keyless?: boolean;
  /**
   * Cap on a reply's length (lowered to the model's own limit). OpenRouter
   * holds back a request's worst-case cost from the balance while it runs;
   * without a cap that is the model's whole output limit, so a few bots
   * working at once could use up the credits and get refused (402).
   */
  maxTokens?: number;
  /**
   * Models (by id) whose prompts the service caches when asked. Each step of
   * a run sends the whole conversation again; cached, the repeated part costs
   * a tenth (OpenRouter's automatic caching for Claude: it moves the cache
   * point to the end as the conversation grows).
   */
  promptCache?: RegExp;
}

/**
 * Any server speaking the OpenAI Chat Completions API: OpenRouter, OpenAI,
 * Groq, Ollama, LM Studio, vLLM… One implementation, many providers.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly id: string;
  readonly label: string;
  private modelCache?: { at: number; list: ModelInfo[] };

  constructor(private opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.label = opts.label;
  }

  configured() {
    return this.opts.keyless || !!this.opts.apiKey();
  }

  private headers() {
    const key = this.opts.apiKey();
    return {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...this.opts.headers,
    };
  }

  async models(fresh = false): Promise<ModelInfo[]> {
    if (!fresh && this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.list;
    if (!this.configured()) throw new Error(`${this.label} has no API key`);
    const res = await fetch(`${this.opts.baseURL}/models`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${this.label}: listing models failed (${res.status})`);
    const body = (await res.json()) as {
      data?: { id: string; name?: string; display_name?: string; context_length?: number; top_provider?: { max_completion_tokens?: number | null } }[];
    };
    const list = (body.data ?? [])
      .map((m) => ({
        id: m.id, name: m.name ?? m.display_name ?? m.id, contextLength: m.context_length,
        maxOutput: m.top_provider?.max_completion_tokens ?? undefined,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    this.modelCache = { at: Date.now(), list };
    return list;
  }

  async chat({ model, messages, tools, signal, onDelta }: ChatRequest): Promise<ChatResult> {
    if (!this.configured()) throw new Error(`${this.label} has no API key`);
    const maxTokens = await this.maxTokens(model);
    const res = await fetch(`${this.opts.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(this.opts.promptCache?.test(model) ? { cache_control: { type: "ephemeral" } } : {}),
        ...(tools?.length
          ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }
          : {}),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      if (res.status === 402) {
        throw new Error(`${this.label} doesn’t have enough credits for this right now. Add credits, or try again when other bots finish.`);
      }
      throw new Error(`${this.label} returned ${res.status}: ${detail.slice(0, 300)}`);
    }

    // Server-sent events: lines of `data: {json}`, ending with `data: [DONE]`.
    // Tool calls arrive in fragments keyed by index; arguments are concatenated.
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const calls: ToolCall[] = [];
    const done = () => ({ text, toolCalls: calls.filter((c) => c.name) });

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // comments like ": OPENROUTER PROCESSING"
        const data = line.slice(5).trim();
        if (data === "[DONE]") return done();
        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.error) throw new Error(event.error.message ?? JSON.stringify(event.error));
        const delta = event.choices?.[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          onDelta(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const i = tc.index ?? calls.length;
          calls[i] ??= { id: "", name: "", arguments: "" };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
        }
      }
    }
    return done();
  }

  /** The reply cap for `model`: the configured one, or less if the model's limit is lower. */
  private async maxTokens(model: string) {
    if (!this.opts.maxTokens) return undefined;
    const limit = await this.models().then((list) => list.find((m) => m.id === model)?.maxOutput, () => undefined);
    return limit ? Math.min(limit, this.opts.maxTokens) : this.opts.maxTokens;
  }
}
