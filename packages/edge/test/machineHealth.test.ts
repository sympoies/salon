import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MachineHealth } from "../src/machineHealth.ts";

// A probe that ran into its deadline, as a black-holed spoke produces.
const STALLED_MS = 3000;

test("a fresh machine is probed", () => {
  const health = new MachineHealth({ cooldownMs: 1000, now: () => 0 });
  assert.equal(health.shouldProbe("mesa"), true);
});

test("a stalled probe opens the breaker for the cooldown window", () => {
  let clock = 0;
  const health = new MachineHealth({ cooldownMs: 1000, now: () => clock });
  health.recordFailure("mesa", STALLED_MS);
  // Still cooling down: no probe.
  clock = 999;
  assert.equal(health.shouldProbe("mesa"), false);
  // A second, healthy machine is unaffected.
  assert.equal(health.shouldProbe("summit"), true);
});

test("the breaker goes half-open once the cooldown elapses", () => {
  let clock = 0;
  const health = new MachineHealth({ cooldownMs: 1000, now: () => clock });
  health.recordFailure("mesa", STALLED_MS);
  clock = 1000;
  assert.equal(health.shouldProbe("mesa"), true);
});

test("a success clears the breaker immediately", () => {
  let clock = 0;
  const health = new MachineHealth({ cooldownMs: 1000, now: () => clock });
  health.recordFailure("mesa", STALLED_MS);
  clock = 100;
  assert.equal(health.shouldProbe("mesa"), false);
  health.recordSuccess("mesa");
  assert.equal(health.shouldProbe("mesa"), true);
});

test("a half-open probe that fails again re-opens the breaker", () => {
  let clock = 0;
  const health = new MachineHealth({ cooldownMs: 1000, now: () => clock });
  health.recordFailure("mesa", STALLED_MS);
  clock = 1000; // half-open
  assert.equal(health.shouldProbe("mesa"), true);
  health.recordFailure("mesa", STALLED_MS); // probe failed again
  clock = 1500;
  assert.equal(health.shouldProbe("mesa"), false);
  clock = 2000;
  assert.equal(health.shouldProbe("mesa"), true);
});

test("a probe that failed fast leaves the machine probed", () => {
  const health = new MachineHealth({ cooldownMs: 1000, now: () => 0 });
  health.recordFailure("summit", 5);
  assert.equal(health.shouldProbe("summit"), true);
});

test("a fast failure while half-open does not re-open the breaker", () => {
  let clock = 0;
  const health = new MachineHealth({ cooldownMs: 1000, now: () => clock });
  health.recordFailure("mesa", STALLED_MS);
  clock = 1000; // half-open
  health.recordFailure("mesa", 5);
  assert.equal(health.shouldProbe("mesa"), true);
});

test("the default stall threshold is one second, inclusive", () => {
  const health = new MachineHealth({ now: () => 0 });
  health.recordFailure("mesa", 999);
  assert.equal(health.shouldProbe("mesa"), true);
  health.recordFailure("mesa", 1000);
  assert.equal(health.shouldProbe("mesa"), false);
});
