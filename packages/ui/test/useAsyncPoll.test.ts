import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createAsyncPoller, type AsyncPollTick } from "../src/useAsyncPoll.ts";

interface Deferred {
  readonly promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("async poller starts immediately and schedules the next tick after completion", async () => {
  const releases = [deferred(), deferred()];
  const delays: number[] = [];
  const callbacks: Array<() => void> = [];
  const ticks: AsyncPollTick[] = [];

  const poller = createAsyncPoller({
    delayMs: 42,
    task: async (tick) => {
      ticks.push(tick);
      await releases[ticks.length - 1]?.promise;
    },
    setTimeout: (callback, delayMs) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return callbacks.length;
    },
    clearTimeout: () => {},
  });

  poller.start();
  assert.equal(ticks.length, 1);
  assert.deepEqual(delays, []);

  releases[0]?.resolve();
  await flushPromises();
  assert.deepEqual(delays, [42]);

  callbacks[0]?.();
  assert.equal(ticks.length, 2);
});

test("async poller cancels in-flight and queued work on stop", async () => {
  const release = deferred();
  const cleared: number[] = [];
  let queued: (() => void) | null = null;
  let lateUpdates = 0;
  let tick: AsyncPollTick | null = null;

  const poller = createAsyncPoller({
    delayMs: 10,
    task: async (currentTick) => {
      tick = currentTick;
      await release.promise;
      if (currentTick.isCurrent()) {
        lateUpdates += 1;
      }
    },
    setTimeout: (callback) => {
      queued = callback;
      return 7;
    },
    clearTimeout: (handle) => {
      cleared.push(handle);
    },
  });

  poller.start();
  assert.equal(tick?.signal.aborted, false);

  poller.stop();
  assert.equal(tick?.signal.aborted, true);

  release.resolve();
  await flushPromises();
  assert.equal(lateUpdates, 0);
  assert.equal(queued, null);

  poller.start();
  release.resolve();
  await flushPromises();
  assert.equal(queued !== null, true);

  poller.stop();
  assert.deepEqual(cleared, [7]);
});
