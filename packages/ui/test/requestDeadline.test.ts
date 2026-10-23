import { strict as assert } from "node:assert";
import { test } from "node:test";
import { withRequestDeadline } from "../src/requestDeadline.ts";

test("request deadline settles a stalled native read and aborts its transport", async () => {
  let requestSignal: AbortSignal | undefined;
  await assert.rejects(
    withRequestDeadline((signal) => {
      requestSignal = signal;
      return new Promise<never>(() => undefined);
    }, 5),
    (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
  );
  assert.equal(requestSignal?.aborted, true);
});

test("request deadline forwards caller cancellation and settles even if transport ignores abort", async () => {
  const caller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const pending = withRequestDeadline((signal) => {
    requestSignal = signal;
    return new Promise<never>(() => undefined);
  }, 60_000, caller.signal);
  caller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(requestSignal?.aborted, true);
});
