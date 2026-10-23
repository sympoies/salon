import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createTurnTitleIdleScheduler } from "../src/turnTitleIdle.ts";

test("turn title idle scheduler runs after prompt output goes idle", () => {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const runs: Array<{ key: string; value: string }> = [];
  const scheduler = createTurnTitleIdleScheduler<string, number>({
    idleMs: 12_000,
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = ++nextId;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    run: (key, value) => runs.push({ key, value }),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of Array.from(timers.entries()).sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };

  scheduler.set("maple/s1", "first prompt");
  assert.equal(timers.size, 1);
  assert.equal(scheduler.take("missing"), undefined);
  advance(8_000);
  scheduler.bump("maple/s1");
  assert.equal(timers.size, 1);
  advance(4_000);
  assert.deepEqual(runs, []);
  assert.equal(timers.size, 1);
  advance(8_000);
  assert.deepEqual(runs, [{ key: "maple/s1", value: "first prompt" }]);
  assert.equal(timers.size, 0);
});

test("turn title idle scheduler can atomically migrate pending work", () => {
  let nextId = 0;
  const timers = new Map<number, () => void>();
  const scheduler = createTurnTitleIdleScheduler<string, number>({
    idleMs: 12_000,
    setTimeout: (callback) => {
      const id = ++nextId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    run: () => assert.fail("taken work must not run"),
  });

  scheduler.set("maple/s1", "old runtime work");
  assert.equal(scheduler.take("maple/s1"), "old runtime work");
  assert.equal(scheduler.take("maple/s1"), undefined);
  assert.equal(timers.size, 0);
});
