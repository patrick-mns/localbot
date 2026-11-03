import { test } from "node:test";
import assert from "node:assert/strict";
import { IDLE_MS, IdleSuspend } from "../src/computers/idle.ts";

function setup(state = "running") {
  const devices = [{ id: "docker:a", state }];
  const suspended: string[] = [];
  let busy = false;
  const idle = new IdleSuspend(async () => devices, () => busy, async (id) => {
    suspended.push(id);
    devices[0].state = "suspended";
  });
  return { idle, devices, suspended, setBusy: (b: boolean) => (busy = b) };
}

test("a running device nobody uses is suspended after the idle time", async () => {
  const { idle, suspended } = setup();
  await idle.tick(0); // first seen
  await idle.tick(IDLE_MS - 1);
  assert.deepEqual(suspended, []);
  await idle.tick(IDLE_MS);
  assert.deepEqual(suspended, ["docker:a"]);
});

test("using the device restarts its idle time", async () => {
  const { idle, suspended } = setup();
  await idle.tick(0);
  idle.touch("docker:a", IDLE_MS - 1000);
  await idle.tick(IDLE_MS);
  assert.deepEqual(suspended, []);
  await idle.tick(2 * IDLE_MS);
  assert.deepEqual(suspended, ["docker:a"]);
});

test("a bot working on the device keeps it awake", async () => {
  const { idle, suspended, setBusy } = setup();
  await idle.tick(0);
  setBusy(true);
  await idle.tick(IDLE_MS * 3);
  setBusy(false);
  await idle.tick(IDLE_MS * 3 + 1000);
  assert.deepEqual(suspended, []);
});

test("devices that are off or already suspended are left alone", async () => {
  for (const state of ["stopped", "suspended"]) {
    const { idle, suspended } = setup(state);
    await idle.tick(0);
    await idle.tick(IDLE_MS * 2);
    assert.deepEqual(suspended, []);
  }
});
