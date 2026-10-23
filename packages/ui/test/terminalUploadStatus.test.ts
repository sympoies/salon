import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  UPLOAD_ERROR_STATUS_MS,
  UPLOAD_OK_STATUS_MS,
  createTerminalStatusController,
  type TerminalUploadStatus,
} from "../src/terminalUploadStatus.ts";

// A deterministic fake scheduler: one pending timer at a time (the controller
// only ever keeps one), runnable on demand so tests drive the auto-clear.
function makeController(overrides: { okDelayMs?: number; errorDelayMs?: number } = {}) {
  const statuses: TerminalUploadStatus[] = [];
  type Timer = { id: number; callback: () => void; delayMs: number };
  let pending: Timer | null = null;
  let nextId = 0;
  const controller = createTerminalStatusController<Timer>({
    setStatus: (status) => statuses.push(status),
    setTimeout: (callback, delayMs) => {
      const timer = { id: ++nextId, callback, delayMs };
      pending = timer;
      return timer;
    },
    clearTimeout: (timer) => {
      if (pending && pending.id === timer.id) {
        pending = null;
      }
    },
    ...overrides,
  });
  return {
    controller,
    statuses,
    // Fire the pending auto-clear timer (if any), like the delay elapsing.
    runPending: () => {
      const timer = pending;
      if (timer) {
        pending = null;
        timer.callback();
      }
      return timer;
    },
    pendingDelay: () => pending?.delayMs ?? null,
    hasPending: () => pending !== null,
  };
}

test("begin shows a busy status and returns an incrementing attempt id", () => {
  const { controller, statuses } = makeController();
  const a = controller.begin("Uploading file");
  const b = controller.begin("Uploading 2 files");
  assert.notEqual(a, b);
  assert.deepEqual(statuses, [
    { kind: "busy", message: "Uploading file" },
    { kind: "busy", message: "Uploading 2 files" },
  ]);
});

test("succeed shows ok then auto-clears after the ok delay", () => {
  const h = makeController();
  const attempt = h.controller.begin("Uploading file");
  h.controller.succeed(attempt, "Uploaded file");
  assert.deepEqual(h.statuses.at(-1), { kind: "ok", message: "Uploaded file" });
  assert.equal(h.pendingDelay(), UPLOAD_OK_STATUS_MS);
  h.runPending();
  assert.equal(h.statuses.at(-1), null); // dismissed
});

test("fail shows error then auto-clears after the (longer) error delay", () => {
  const h = makeController();
  const attempt = h.controller.begin("Uploading file");
  h.controller.fail(attempt, "Upload failed");
  assert.deepEqual(h.statuses.at(-1), { kind: "error", message: "Upload failed" });
  // The whole point of the fix: errors auto-dismiss too, on a longer window.
  assert.equal(h.pendingDelay(), UPLOAD_ERROR_STATUS_MS);
  assert.ok(UPLOAD_ERROR_STATUS_MS > UPLOAD_OK_STATUS_MS, "errors linger longer than success");
  h.runPending();
  assert.equal(h.statuses.at(-1), null); // dismissed, not sticky
});

test("a stale succeed/fail from a superseded attempt is ignored", () => {
  const h = makeController();
  const stale = h.controller.begin("Uploading file");
  const fresh = h.controller.begin("Uploading file"); // supersedes `stale`
  const before = h.statuses.length;
  h.controller.succeed(stale, "Uploaded file");
  h.controller.fail(stale, "Upload failed");
  assert.equal(h.statuses.length, before, "superseded attempt cannot paint status");
  // The current attempt still works.
  h.controller.succeed(fresh, "Uploaded file");
  assert.deepEqual(h.statuses.at(-1), { kind: "ok", message: "Uploaded file" });
});

test("failStandalone shows an error, supersedes any in-flight attempt, and auto-clears", () => {
  const h = makeController();
  const inFlight = h.controller.begin("Uploading file");
  h.controller.failStandalone("File upload unavailable");
  assert.deepEqual(h.statuses.at(-1), { kind: "error", message: "File upload unavailable" });
  assert.equal(h.pendingDelay(), UPLOAD_ERROR_STATUS_MS);
  // The in-flight attempt is now stale: its later completion is ignored.
  assert.equal(h.controller.isCurrent(inFlight), false);
  const before = h.statuses.length;
  h.controller.succeed(inFlight, "Uploaded file");
  assert.equal(h.statuses.length, before);
  h.runPending();
  assert.equal(h.statuses.at(-1), null);
});

test("dispose cancels a pending auto-clear and invalidates the attempt", () => {
  const h = makeController();
  const attempt = h.controller.begin("Uploading file");
  h.controller.succeed(attempt, "Uploaded file");
  assert.ok(h.hasPending());
  h.controller.dispose();
  assert.equal(h.hasPending(), false, "pending clear cancelled on dispose");
  assert.equal(h.controller.isCurrent(attempt), false);
});

test("delays are configurable", () => {
  const h = makeController({ okDelayMs: 10, errorDelayMs: 99 });
  const a = h.controller.begin("Uploading file");
  h.controller.succeed(a, "Uploaded file");
  assert.equal(h.pendingDelay(), 10);
  const b = h.controller.begin("Uploading file");
  h.controller.fail(b, "Upload failed");
  assert.equal(h.pendingDelay(), 99);
});
