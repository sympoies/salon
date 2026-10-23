import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";
import { aggregateSessions } from "../src/upstream.ts";
import { MachineHealth } from "../src/machineHealth.ts";
import type { MachineConfig } from "../src/config.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const m = (name: string): MachineConfig => ({ name, url: "http://127.0.0.1:8781", token: `${name}-token` });
function envelope(sessions: unknown[]): string {
  return JSON.stringify({ schema_version: "cli.agent-session.serve.v1", ok: true, data: { sessions } });
}

test("a machine whose breaker is open is not fetched again while cooling down", async () => {
  let clock = 0;
  const health = new MachineHealth({ cooldownMs: 1000, now: () => clock });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    clock += 3000; // the probe stalled until its deadline
    throw new Error("This operation was aborted");
  }) as typeof fetch;

  const first = await aggregateSessions([m("mesa")], health);
  assert.equal(calls, 1);
  assert.equal(first.machines[0]?.ok, false);

  clock += 500; // still cooling down
  const second = await aggregateSessions([m("mesa")], health);
  assert.equal(calls, 1, "a breaker-open machine must not be re-fetched");
  assert.equal(second.machines[0]?.ok, false);
  assert.match(second.machines[0]?.error ?? "", /cool/i);
});

test("a healthy machine is not stalled by another machine's open breaker", async () => {
  let clock = 0;
  const health = new MachineHealth({ cooldownMs: 1000, now: () => clock });
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization ?? "";
    if (auth === "Bearer up-token") {
      return new Response(envelope([{ id: "s-up" }]), { status: 200 });
    }
    clock += 3000; // the probe stalled until its deadline
    throw new Error("This operation was aborted");
  }) as typeof fetch;

  await aggregateSessions([m("up"), m("down")], health); // trips down's breaker
  clock += 500;
  const out = await aggregateSessions([m("up"), m("down")], health);
  assert.deepEqual(
    out.sessions.map((s) => s.id),
    ["s-up"],
  );
  assert.equal(out.machines.find((x) => x.name === "up")?.ok, true);
  assert.equal(out.machines.find((x) => x.name === "down")?.ok, false);
});

test("the breaker re-probes after the cooldown and recovers on success", async () => {
  let clock = 0;
  const health = new MachineHealth({ cooldownMs: 1000, now: () => clock });
  let mode: "down" | "up" = "down";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (mode === "down") {
      clock += 3000; // the probe stalled until its deadline
      throw new Error("This operation was aborted");
    }
    return new Response(envelope([{ id: "s1" }]), { status: 200 });
  }) as typeof fetch;

  await aggregateSessions([m("mesa")], health); // stall -> open
  assert.equal(calls, 1);

  clock += 1000; // half-open
  mode = "up";
  const out = await aggregateSessions([m("mesa")], health);
  assert.equal(calls, 2, "half-open should re-probe");
  assert.equal(out.machines[0]?.ok, true);

  // A success cleared the breaker: the next poll probes normally.
  const out2 = await aggregateSessions([m("mesa")], health);
  assert.equal(calls, 3);
  assert.equal(out2.machines[0]?.ok, true);
});

test("a non-200 (reachable) daemon does not open the breaker", async () => {
  let clock = 0;
  const health = new MachineHealth({ cooldownMs: 1000, now: () => clock });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("nope", { status: 503 });
  }) as typeof fetch;

  await aggregateSessions([m("mesa")], health);
  assert.equal(calls, 1);
  clock = 10;
  await aggregateSessions([m("mesa")], health);
  assert.equal(calls, 2, "a fast 503 is reachable and must keep being probed");
});

test("a probe that fails fast keeps the machine probed and recovers at once", async () => {
  let clock = 0;
  const health = new MachineHealth({ cooldownMs: 1000, now: () => clock });
  let mode: "down" | "up" = "down";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (mode === "down") {
      throw new Error("ECONNREFUSED"); // a restarting daemon refuses at once
    }
    return new Response(envelope([{ id: "s1" }]), { status: 200 });
  }) as typeof fetch;

  const first = await aggregateSessions([m("summit")], health);
  assert.equal(first.machines[0]?.ok, false);
  assert.match(first.machines[0]?.error ?? "", /ECONNREFUSED/);

  clock += 10; // well inside what would have been the cooldown
  mode = "up";
  const second = await aggregateSessions([m("summit")], health);
  assert.equal(calls, 2, "a fast refusal must not make the next probe skip the machine");
  assert.equal(second.machines[0]?.ok, true);
});
