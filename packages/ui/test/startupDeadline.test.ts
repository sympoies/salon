import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runStartupAuthCheck } from "../src/startupDeadline.ts";

type AuthStatus = {
  readonly authenticated: boolean;
  readonly startupFailure?: "timeout" | "transport";
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("App startup auth uses the Activity-relative six-second budget and discards a late success", async () => {
  let timerCallback: (() => void) | undefined;
  let timerDelay = -1;
  let timeoutCount = 0;
  const result = deferred<AuthStatus>();
  const request = runStartupAuthCheck({
    initialStartup: true,
    deadlineMs: 6_000,
    elapsedMs: 2_500,
    schedule: (callback, delay) => {
      timerCallback = callback;
      timerDelay = delay;
      return 1;
    },
    cancel: () => undefined,
    read: () => result.promise,
    onTimeout: () => { timeoutCount += 1; },
  });

  assert.equal(timerDelay, 3_500);
  timerCallback?.();
  assert.equal(timeoutCount, 1, "the timeout callback immediately exposes the recovery state");
  result.resolve({ authenticated: true });
  assert.equal(await request, null, "the initial auth success arriving after timeout is discarded");
});

test("App startup auth clears the deadline when authentication succeeds early", async () => {
  let timerCallback: (() => void) | undefined;
  let cancelled = false;
  let timeoutCount = 0;
  const expected: AuthStatus = { authenticated: true };
  const actual = await runStartupAuthCheck({
    initialStartup: true,
    deadlineMs: 6_000,
    elapsedMs: 500,
    schedule: callback => { timerCallback = callback; return 2; },
    cancel: handle => { assert.equal(handle, 2); cancelled = true; },
    read: async () => expected,
    onTimeout: () => { timeoutCount += 1; },
  });

  assert.equal(actual, expected);
  assert.equal(cancelled, true);
  if (!cancelled) timerCallback?.();
  assert.equal(timeoutCount, 0, "a cleared deadline cannot replace a successful auth result");
});

test("App startup auth retries skip the Activity deadline and keep their fresh request result", async () => {
  let scheduled = false;
  const expected: AuthStatus = { authenticated: true };
  const actual = await runStartupAuthCheck({
    initialStartup: false,
    deadlineMs: 6_000,
    elapsedMs: 60_000,
    schedule: () => { scheduled = true; return 3; },
    cancel: () => undefined,
    read: async () => expected,
    onTimeout: () => assert.fail("a retry does not use the initial Activity deadline"),
  });

  assert.equal(actual, expected);
  assert.equal(scheduled, false);
});
