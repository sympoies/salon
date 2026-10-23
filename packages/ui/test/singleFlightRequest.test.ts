import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createBoundedSingleFlight } from "../src/singleFlightRequest.ts";

test("hung transports stay capped after wake-up events", async () => {
  let calls = 0;
  const read = createBoundedSingleFlight<string, string>(async () => {
    calls += 1;
    return new Promise<string>(() => undefined);
  });

  await assert.rejects(read("sessions:maple", 5), { name: "TimeoutError" });
  await assert.rejects(read("sessions:maple", 5), { name: "TimeoutError" });
  assert.equal(calls, 2, "a retry may bypass the first hung request");
  await assert.rejects(read("sessions:maple", 5), { name: "TimeoutError" });
  assert.equal(calls, 2, "polling reuses the pending request at the cap");
  read.reset();
  await assert.rejects(read("sessions:maple", 5), { name: "TimeoutError" });
  assert.equal(calls, 2, "wake-up does not release unresolved native requests from the cap");
  await assert.rejects(read.recover("sessions:maple", 5), { name: "TimeoutError" });
  assert.equal(calls, 3, "an online transition gets one reserved recovery attempt");
  await assert.rejects(read.recover("sessions:maple", 5), { name: "TimeoutError" });
  assert.equal(calls, 3, "flapping online events cannot allocate another unresolved recovery");
});

test("the reserved recovery request can succeed after two hung polls", async () => {
  let calls = 0;
  const read = createBoundedSingleFlight<string, string>(async () => {
    calls += 1;
    if (calls < 3) return new Promise<string>(() => undefined);
    return "online";
  });
  await assert.rejects(read("sessions:maple", 5), { name: "TimeoutError" });
  await assert.rejects(read("sessions:maple", 5), { name: "TimeoutError" });
  assert.equal(await read.recover("sessions:maple", 50), "online");
  assert.equal(await read("sessions:maple", 50), "online");
  assert.equal(await read("sessions:maple", 50), "online");
  assert.equal(calls, 5, "successful recovery restores regular polls in the reserved slot");
});

test("a second online transition can replace a hung promoted poll within the hard cap", async () => {
  let calls = 0;
  const read = createBoundedSingleFlight<string, string>(async () => {
    calls += 1;
    if (calls === 1 || calls === 3) return new Promise<string>(() => undefined);
    return `ready-${calls}`;
  });
  await assert.rejects(read("sessions:maple", 5), { name: "TimeoutError" });
  assert.equal(await read.recover("sessions:maple", 50), "ready-2");
  await assert.rejects(read("sessions:maple", 5), { name: "TimeoutError" });
  read.reset();
  assert.equal(await read.recover("sessions:maple", 50), "ready-4");
  assert.equal(await read("sessions:maple", 50), "ready-5");
  assert.equal(calls, 5);
});

test("a cancelled caller does not abort a shared request still used by another caller", async () => {
  let calls = 0;
  let physicalSignal: AbortSignal | undefined;
  let release!: (value: string) => void;
  const read = createBoundedSingleFlight<string, string>(async (_key, signal) => {
    calls += 1;
    physicalSignal = signal;
    return new Promise<string>((resolve) => { release = resolve; });
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = read("sessions:maple", 1_000, firstController.signal);
  const second = read("sessions:maple", 1_000, secondController.signal);
  assert.equal(calls, 1);
  firstController.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(physicalSignal?.aborted, false);
  release("ready");
  assert.equal(await second, "ready");
  assert.equal(physicalSignal?.aborted, false, "a completed transport is not aborted");
});

test("a second physical request can recover after the first ignores abort", async () => {
  let calls = 0;
  const read = createBoundedSingleFlight<string, string>(async () => {
    calls += 1;
    if (calls === 1) return new Promise<string>(() => undefined);
    return "recovered";
  });
  await assert.rejects(read("ticket:maple/s1", 5), { name: "TimeoutError" });
  assert.equal(await read("ticket:maple/s1", 50), "recovered");
  assert.equal(calls, 2);
});

test("cancelling the final waiter aborts the physical transport", async () => {
  let physicalSignal: AbortSignal | undefined;
  const read = createBoundedSingleFlight<string, string>(async (_key, signal) => {
    physicalSignal = signal;
    return new Promise<string>(() => undefined);
  });
  const caller = new AbortController();
  const pending = read("sessions:maple", 1_000, caller.signal);
  caller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(physicalSignal?.aborted, true);
});
