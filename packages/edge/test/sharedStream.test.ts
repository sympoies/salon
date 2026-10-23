import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SharedStreamRegistry } from "../src/sharedStream.ts";
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

test("shared producers survive one subscriber leaving and stop after the last", async () => {
  const registry = new SharedStreamRegistry();
  let starts = 0;
  let emit!: (chunk: string) => void;
  let sourceSignal!: AbortSignal;
  const start = async (signal: AbortSignal, send: (chunk: string) => void) => {
    starts += 1; emit = send; sourceSignal = signal;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const a = new AbortController(); const b = new AbortController();
  const first = registry.subscribe("machine", start, a.signal);
  const second = registry.subscribe("machine", start, b.signal);
  const nextA = first.next(); const nextB = second.next();
  await flush(); assert.equal(starts, 1);
  emit("safe-metadata");
  assert.equal((await nextA).value, "safe-metadata");
  assert.equal((await nextB).value, "safe-metadata");
  a.abort(); await first.return(undefined);
  assert.equal(sourceSignal.aborted, false);
  const another = second.next(); emit("next"); assert.equal((await another).value, "next");
  b.abort(); await second.return(undefined);
  assert.equal(sourceSignal.aborted, true);
});

test("a slow activity subscriber is bounded independently of a healthy subscriber", async () => {
  const registry = new SharedStreamRegistry();
  let emit!: (chunk: string) => void;
  const start = async (signal: AbortSignal, send: (chunk: string) => void) => {
    emit = send;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  const slowControl = new AbortController(); const fastControl = new AbortController();
  let disconnected = false;
  const slow = registry.subscribe("machine", start, slowControl.signal, () => { disconnected = true; });
  const fast = registry.subscribe("machine", start, fastControl.signal);
  const initialSlow = slow.next(); const initialFast = fast.next(); await flush();
  emit("initial"); await initialSlow; await initialFast;
  for (let i = 0; i < 66; i += 1) {
    const next = fast.next(); emit(String(i)); assert.equal((await next).value, String(i));
  }
  assert.equal(disconnected, true, "disconnect fires even while the consumer is not reading its queue");
  await assert.rejects(slow.next(), /subscriber capacity/);
  const stillHealthy = fast.next(); emit("after-overflow");
  assert.equal((await stillHealthy).value, "after-overflow");
  fastControl.abort(); await fast.return(undefined);
});

test("producer failure rejects subscribers and signals their HTTP disconnect", async () => {
  const registry = new SharedStreamRegistry(); let disconnected = false;
  const iterator = registry.subscribe("failed", async () => { throw new Error("upstream fixture"); },
    new AbortController().signal, () => { disconnected = true; });
  await assert.rejects(iterator.next(), /producer failed/);
  assert.equal(disconnected, true);
  registry.close();
});
