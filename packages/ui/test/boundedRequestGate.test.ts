import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createBoundedRequestGate } from "../src/boundedRequestGate.ts";

test("concurrent admitted calls receive separate one-time results", async () => {
  let calls = 0;
  const read = createBoundedRequestGate(async () => `ticket-${++calls}`);
  const [first, second] = await Promise.all([read("maple/s1", 50), read("maple/s1", 50)]);
  assert.deepEqual([first, second], ["ticket-1", "ticket-2"]);
});

test("ignored native aborts cap ticket requests and reserve one online recovery", async () => {
  let calls = 0;
  const read = createBoundedRequestGate<string, string>(async () => {
    calls += 1;
    return new Promise<string>(() => undefined);
  });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await assert.rejects(read("maple/s1", 5), { name: "TimeoutError" });
  }
  assert.equal(calls, 2);
  await assert.rejects(read("maple/s1", 5, true), { name: "TimeoutError" });
  await assert.rejects(read("maple/s1", 5, true), { name: "TimeoutError" });
  assert.equal(calls, 3);
});

test("successful online ticket recovery keeps the third slot available for later attaches", async () => {
  let calls = 0;
  const read = createBoundedRequestGate<string, string>(async () => {
    calls += 1;
    if (calls <= 2) return new Promise<string>(() => undefined);
    return `ticket-${calls}`;
  });
  await assert.rejects(read("maple/s1", 5), { name: "TimeoutError" });
  await assert.rejects(read("maple/s1", 5), { name: "TimeoutError" });
  assert.equal(await read("maple/s1", 50, true), "ticket-3");
  assert.equal(await read("maple/s1", 50), "ticket-4");
  assert.equal(calls, 4);
});

test("ticket timeout aborts the physical native request and releases its slot", async () => {
  const signals: AbortSignal[] = [];
  const read = createBoundedRequestGate<string, string>(async (_key, signal) => {
    signals.push(signal);
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
  });
  await assert.rejects(read("maple/s1", 5), { name: "TimeoutError" });
  assert.equal(signals[0]?.aborted, true);
  await assert.rejects(read("maple/s1", 5), { name: "TimeoutError" });
  assert.equal(signals.length, 2);
});

test("a second online transition replaces a hung promoted ticket within the cap", async () => {
  let calls = 0;
  const read = createBoundedRequestGate<string, string>(async () => {
    calls += 1;
    if (calls === 2) return new Promise<string>(() => undefined);
    return `ticket-${calls}`;
  });
  assert.equal(await read("maple/s1", 50, true), "ticket-1");
  await assert.rejects(read("maple/s1", 5), { name: "TimeoutError" });
  assert.equal(await read("maple/s1", 50, true), "ticket-3");
  assert.equal(await read("maple/s1", 50), "ticket-4");
  assert.equal(calls, 4);
});
