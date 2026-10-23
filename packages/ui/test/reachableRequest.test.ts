import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readReachableWithRecovery } from "../src/reachableRequest.ts";

test("a hung transport is bounded, aborted, and exhausted after three attempts", async () => {
  const signals: AbortSignal[] = [];
  await assert.rejects(readReachableWithRecovery((signal) => {
    signals.push(signal);
    return new Promise<never>(() => {});
  }, { timeoutMs: 5, retryDelaysMs: [1, 1] }), /timed out/);
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal.aborted));
});

test("cancellation releases a hung request without retrying", async () => {
  const controller = new AbortController();
  let calls = 0;
  let attemptSignal: AbortSignal | undefined;
  const pending = readReachableWithRecovery((signal) => {
    calls += 1;
    attemptSignal = signal;
    return new Promise<never>(() => {});
  }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
  assert.equal(attemptSignal?.aborted, true);
});

test("cancellation during backoff prevents the next attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = readReachableWithRecovery(async () => {
    calls += 1;
    throw new Error("offline");
  }, { signal: controller.signal, retryDelaysMs: [60_000] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("retryable server responses recover but disabled integrations and invalid responses do not retry", async () => {
  let calls = 0;
  const success = { status: 200, body: { data: { reachable: true } } };
  assert.equal(await readReachableWithRecovery(async () => {
    calls += 1;
    return calls === 1 ? { status: 503, body: {} } : success;
  }, { retryDelaysMs: [0] }), success);
  assert.equal(calls, 2);
  calls = 0;
  const disabled = { status: 200, body: { data: { reachable: false } } };
  assert.equal(await readReachableWithRecovery(async () => { calls += 1; return disabled; }), disabled);
  assert.equal(calls, 1);
  await assert.rejects(readReachableWithRecovery(async () => ({ status: 200, body: {}, malformed: true })), /invalid response/);
});
