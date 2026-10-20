import "./env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleProvider } from "../src/chat/openai-compatible.ts";

/** A tiny OpenAI-style server that streams the given SSE events. */
async function serve(events: unknown[], status = 200) {
  let lastBody: any;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastBody = body ? JSON.parse(body) : undefined;
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model", name: "A", top_provider: { max_completion_tokens: 4096 } }] }));
      }
      res.writeHead(status, { "content-type": "text/event-stream" });
      if (status !== 200) return res.end('{"error":"nope"}');
      res.write(": PROCESSING\n\n");
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, close: () => server.close(), body: () => lastBody };
}

test("streams text and assembles fragmented tool calls", async () => {
  const s = await serve([
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "cli", arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ck", arguments: "1}" } }] } }] },
  ]);
  const p = new OpenAICompatibleProvider({ id: "t", label: "Test", baseURL: s.url, apiKey: () => "k" });
  const deltas: string[] = [];
  const out = await p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [{ name: "click", description: "", parameters: {} }], onDelta: (d) => deltas.push(d) });
  assert.equal(out.text, "Hello");
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.deepEqual(out.toolCalls, [{ id: "c1", name: "click", arguments: '{"x":1}' }]);
  assert.equal(s.body().tools[0].function.name, "click");
  s.close();
});

test("HTTP errors and in-stream errors throw", async () => {
  const bad = await serve([], 401);
  const p = new OpenAICompatibleProvider({ id: "t", label: "Test", baseURL: bad.url, apiKey: () => "k" });
  await assert.rejects(p.chat({ model: "m", messages: [], onDelta: () => {} }), /returned 401/);
  bad.close();
  const s = await serve([{ error: { message: "model overloaded" } }]);
  const q = new OpenAICompatibleProvider({ id: "t", label: "Test", baseURL: s.url, apiKey: () => "k" });
  await assert.rejects(q.chat({ model: "m", messages: [], onDelta: () => {} }), /overloaded/);
  s.close();
});

test("lists models sorted, and refuses without a key", async () => {
  const s = await serve([]);
  const p = new OpenAICompatibleProvider({ id: "t", label: "Test", baseURL: s.url, apiKey: () => "k" });
  assert.deepEqual((await p.models()).map((m) => m.id), ["a-model", "b-model"]);
  const none = new OpenAICompatibleProvider({ id: "t", label: "Test", baseURL: s.url, apiKey: () => undefined });
  await assert.rejects(none.models(), /no API key/);
  s.close();
});

test("caps a reply at the configured length, or the model's own lower limit", async () => {
  const s = await serve([]);
  const p = new OpenAICompatibleProvider({ id: "t", label: "Test", baseURL: s.url, apiKey: () => "k", maxTokens: 16_384 });
  await p.chat({ model: "b-model", messages: [], onDelta: () => {} });
  assert.equal(s.body().max_tokens, 16_384);
  await p.chat({ model: "a-model", messages: [], onDelta: () => {} });
  assert.equal(s.body().max_tokens, 4096);
  const uncapped = new OpenAICompatibleProvider({ id: "t", label: "Test", baseURL: s.url, apiKey: () => "k" });
  await uncapped.chat({ model: "a-model", messages: [], onDelta: () => {} });
  assert.equal(s.body().max_tokens, undefined);
  s.close();
});

test("out of credits (402) says so in words", async () => {
  const s = await serve([], 402);
  const p = new OpenAICompatibleProvider({ id: "t", label: "OpenRouter", baseURL: s.url, apiKey: () => "k" });
  await assert.rejects(p.chat({ model: "m", messages: [], onDelta: () => {} }), /OpenRouter doesn’t have enough credits/);
  s.close();
});
