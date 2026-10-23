import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createTerminalOutputBatcher,
  type TerminalOutputWrite,
} from "../src/terminalOutputBatcher.ts";

type Timer = { readonly id: number; readonly callback: () => void; readonly delayMs: number };

function createHarness(options: { batching?: boolean; delayMs?: number; maxPendingUnits?: number } = {}) {
  let batching = options.batching ?? false;
  let delayMs = options.delayMs ?? 250;
  let nextTimerId = 0;
  const timers = new Map<number, Timer>();
  const cleared: number[] = [];
  const writes: TerminalOutputWrite[] = [];
  const batcher = createTerminalOutputBatcher<Timer>({
    shouldBatch: () => batching,
    write: (data, delivery) => writes.push({ data, ...delivery }),
    delayMs: () => delayMs,
    maxPendingUnits: options.maxPendingUnits,
    setTimeout: (callback, delayMs) => {
      const timer = { id: ++nextTimerId, callback, delayMs };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout: (timer) => {
      cleared.push(timer.id);
      timers.delete(timer.id);
    },
  });
  return {
    batcher,
    writes,
    timers,
    cleared,
    setBatching(value: boolean) {
      batching = value;
    },
    setDelayMs(value: number) {
      delayMs = value;
    },
    fireOnlyTimer() {
      const [timer] = timers.values();
      assert.ok(timer);
      timers.delete(timer.id);
      timer.callback();
    },
  };
}

test("realtime mode writes every frame immediately", () => {
  const h = createHarness();

  h.batcher.push("one");
  h.batcher.push("two");

  assert.deepEqual(h.writes.map(({ data, reason, frameCount }) => ({ data, reason, frameCount })), [
    { data: "one", reason: "realtime", frameCount: 1 },
    { data: "two", reason: "realtime", frameCount: 1 },
  ]);
  assert.equal(h.timers.size, 0);
});

test("focus-aware mode batches homogeneous frames for at most 250 ms", () => {
  const h = createHarness({ batching: true });

  h.batcher.push("one");
  h.batcher.push("two");

  assert.equal(h.writes.length, 0);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0]?.delayMs, 250);

  h.fireOnlyTimer();
  assert.deepEqual(h.writes, [
    { data: "onetwo", reason: "timer", frameCount: 2, unitCount: 6 },
  ]);
});

test("focus-aware profiles read the live 100/250/500 ms delay without rebuilding the batcher", () => {
  const h = createHarness({ batching: true, delayMs: 100 });

  h.batcher.push("smooth");
  assert.equal([...h.timers.values()][0]?.delayMs, 100);
  h.fireOnlyTimer();

  h.setDelayMs(500);
  h.batcher.push("efficient");
  assert.equal([...h.timers.values()][0]?.delayMs, 500);
});

test("focus flushes pending output immediately without changing byte order", () => {
  const h = createHarness({ batching: true });
  const first = new Uint8Array([0xf0, 0x9f]);
  const second = new Uint8Array([0x98, 0x80]);

  h.batcher.push(first);
  h.batcher.push(second);
  h.setBatching(false);
  h.batcher.flush("focus");

  assert.equal(h.writes.length, 1);
  assert.deepEqual([...h.writes[0]!.data as Uint8Array], [0xf0, 0x9f, 0x98, 0x80]);
  assert.deepEqual({ ...h.writes[0], data: undefined }, {
    data: undefined,
    reason: "focus",
    frameCount: 2,
    unitCount: 4,
  });
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.cleared, [1]);
});

test("an explicit flush applies a newly selected profile to the next batch window", () => {
  const h = createHarness({ batching: true, delayMs: 500 });

  h.batcher.push("efficient");
  assert.equal([...h.timers.values()][0]?.delayMs, 500);

  h.batcher.flush("focus");
  h.setDelayMs(100);
  h.batcher.push("smooth");

  assert.deepEqual(h.writes, [
    { data: "efficient", reason: "focus", frameCount: 1, unitCount: 9 },
  ]);
  assert.equal([...h.timers.values()][0]?.delayMs, 100);
  assert.deepEqual(h.cleared, [1]);
});

test("protocol output flushes older printable output before writing immediately", () => {
  const h = createHarness({ batching: true });

  h.batcher.push("prompt");
  h.batcher.pushImmediate("\u001b[6n");

  assert.deepEqual(h.writes, [
    { data: "prompt", reason: "protocol-boundary", frameCount: 1, unitCount: 6 },
    { data: "\u001b[6n", reason: "protocol", frameCount: 1, unitCount: 4 },
  ]);
  assert.equal(h.timers.size, 0);
});

test("mixed string and binary frames flush at the type boundary", () => {
  const h = createHarness({ batching: true });

  h.batcher.push("text");
  h.batcher.push(new Uint8Array([1, 2]));

  assert.deepEqual(h.writes, [
    { data: "text", reason: "type-change", frameCount: 1, unitCount: 4 },
  ]);
  h.fireOnlyTimer();
  assert.deepEqual([...h.writes[1]!.data as Uint8Array], [1, 2]);
  assert.equal(h.writes[1]!.reason, "timer");
});

test("pending output is bounded and teardown clears its timer and data", () => {
  const h = createHarness({ batching: true, maxPendingUnits: 4 });

  h.batcher.push("abc");
  h.batcher.push("de");
  assert.deepEqual(h.writes, [
    { data: "abc", reason: "capacity", frameCount: 1, unitCount: 3 },
  ]);

  h.batcher.dispose();
  assert.equal(h.timers.size, 0);
  assert.equal(h.writes.length, 1);
});
