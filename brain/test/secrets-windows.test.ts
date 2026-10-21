import "./env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { WindowsDpapi } from "../src/secrets.ts";

test("Windows: secrets are stored encrypted with DPAPI and read back", { skip: platform() !== "win32" }, async () => {
  const store = new WindowsDpapi();
  await store.set("provider:test", "sk-test-value 'with' \"quotes\" é");
  const file = join(process.env.LOCALBOT_HOME!, "secrets.dpapi.json");
  assert.ok(existsSync(file));
  assert.ok(!readFileSync(file, "utf8").includes("sk-test-value"), "stored encrypted");

  // A fresh instance decrypts what's on disk.
  const again = new WindowsDpapi();
  assert.equal(await again.get("provider:test"), "sk-test-value 'with' \"quotes\" é");
  await again.delete("provider:test");
  assert.equal(await new WindowsDpapi().get("provider:test"), undefined);
});
