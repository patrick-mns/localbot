import "./env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { McpServers } from "../src/mcp/servers.ts";

const ECHO = join(import.meta.dirname, "fixtures/mcp-echo.mjs");

test("a local MCP server: add, test, tools for a bot, call, remove", async () => {
  const mcp = new McpServers();
  const s = await mcp.add({ name: "My Echo", transport: "stdio", command: process.execPath, args: [ECHO], env: { ECHO_PREFIX: "secret-value" } });
  assert.equal(s.state, "idle");
  assert.deepEqual(s.envKeys, ["ECHO_PREFIX"]);

  const tested = await mcp.test(s.id);
  assert.equal(tested.state, "connected");
  assert.deepEqual(tested.tools?.map((t) => t.name), ["echo", "boom"]);

  // Offered only through the servers a bot has on, prefixed by the server.
  assert.deepEqual(await mcp.toolsFor([]), []);
  const specs = await mcp.toolsFor([s.id]);
  assert.deepEqual(specs.map((t) => t.name), ["my_echo__echo", "my_echo__boom"]);

  const ok = await mcp.call([s.id], "my_echo__echo", JSON.stringify({ text: "hi" }));
  assert.equal(ok?.result, "echo: hi (secret-value)");
  const failed = await mcp.call([s.id], "my_echo__boom", "{}");
  assert.match(failed!.result, /^Error: boom/);
  assert.equal(await mcp.call([], "my_echo__echo", "{}"), null);

  await mcp.remove(s.id);
  assert.deepEqual(mcp.list(), []);
});

test("a server with a huge tool list is searched instead of listed", async () => {
  const mcp = new McpServers();
  const s = await mcp.add({ name: "Big", transport: "stdio", command: process.execPath, args: [ECHO], env: { ECHO_MANY: "100" } });
  // Two small tools stand in for all of them on every step.
  const specs = await mcp.toolsFor([s.id]);
  assert.deepEqual(specs.map((t) => t.name), ["find_app_tools", "use_app_tool"]);
  assert.ok(JSON.stringify(specs).length < 2000);

  const found = await mcp.call([s.id], "find_app_tools", JSON.stringify({ query: "repeat some text" }));
  assert.match(found!.result, /^big__echo$/m);
  assert.match(found!.result, /"text"/);
  const ran = await mcp.call([s.id], "use_app_tool", JSON.stringify({ tool: "big__echo", arguments: { text: "hi" } }));
  assert.match(ran!.result, /^echo: hi/);
  const unknown = await mcp.call([s.id], "use_app_tool", JSON.stringify({ tool: "nope" }));
  assert.match(unknown!.result, /no tool named/);

  await mcp.remove(s.id);
});

test("bad input is refused with a plain reason", async () => {
  const mcp = new McpServers();
  await assert.rejects(mcp.add({ name: "", transport: "stdio", command: "x" }), /name/);
  await assert.rejects(mcp.add({ name: "Web", transport: "http", url: "http://example.com/mcp" }), /https/);
  await assert.rejects(mcp.add({ name: "Local", transport: "stdio" }), /command/);
  await assert.rejects(mcp.add({ name: "Env", transport: "stdio", command: "x", env: { "BAD-NAME": "1" } }), /variable name/);
});

test("a server that can't start reports the error", async () => {
  const mcp = new McpServers();
  const s = await mcp.add({ name: "Broken", transport: "stdio", command: "/nonexistent/server" });
  await assert.rejects(mcp.test(s.id));
  const view = mcp.list().find((x) => x.id === s.id)!;
  assert.equal(view.state, "error");
  assert.match(view.errors[0].message, /Couldn’t start|stopped/);
  await mcp.remove(s.id);
});
