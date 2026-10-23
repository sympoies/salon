import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createWindowScheduler, defaultScheduler } from "../src/scheduler.ts";

test("defaultScheduler exposes one shared timer and animation-frame shape", () => {
  assert.equal(typeof defaultScheduler.setTimeout, "function");
  assert.equal(typeof defaultScheduler.clearTimeout, "function");
  assert.equal(typeof defaultScheduler.setInterval, "function");
  assert.equal(typeof defaultScheduler.clearInterval, "function");
  assert.equal(typeof defaultScheduler.requestAnimationFrame, "function");
  assert.equal(typeof defaultScheduler.cancelAnimationFrame, "function");
});

test("createWindowScheduler binds timer operations to the provided window", () => {
  const calls: string[] = [];
  const target = {
    setTimeout: (_callback: () => void, delayMs: number) => {
      calls.push(`setTimeout:${delayMs}`);
      return 1;
    },
    clearTimeout: (handle: number) => {
      calls.push(`clearTimeout:${handle}`);
    },
    setInterval: (_callback: () => void, delayMs: number) => {
      calls.push(`setInterval:${delayMs}`);
      return 2;
    },
    clearInterval: (handle: number) => {
      calls.push(`clearInterval:${handle}`);
    },
    requestAnimationFrame: (_callback: FrameRequestCallback) => {
      calls.push("requestAnimationFrame");
      return 3;
    },
    cancelAnimationFrame: (handle: number) => {
      calls.push(`cancelAnimationFrame:${handle}`);
    },
  };

  const scheduler = createWindowScheduler(target);
  scheduler.clearTimeout(scheduler.setTimeout(() => {}, 12));
  scheduler.clearInterval(scheduler.setInterval(() => {}, 34));
  scheduler.cancelAnimationFrame(scheduler.requestAnimationFrame(() => {}));

  assert.deepEqual(calls, [
    "setTimeout:12",
    "clearTimeout:1",
    "setInterval:34",
    "clearInterval:2",
    "requestAnimationFrame",
    "cancelAnimationFrame:3",
  ]);
});
