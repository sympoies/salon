import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchApiRoute } from "../src/apiRoutes.ts";

test("history and archive routes are explicit and method fenced", () => {
  assert.deepEqual(matchApiRoute("/api/history/sessions", "GET")?.id, "history-sessions");
  assert.deepEqual(
    matchApiRoute("/api/history/sessions/summit/h-123/messages", "GET")?.id,
    "history-messages",
  );
  assert.deepEqual(
    matchApiRoute("/api/sessions/summit/live-1/archive", "POST")?.id,
    "archive-session",
  );
  assert.equal(matchApiRoute("/api/history/sessions", "POST")?.methodAllowed, false);
});

test("the history star route is machine scoped and POST only", () => {
  assert.equal(
    matchApiRoute("/api/history/sessions/summit/h-123/star", "POST")?.id,
    "history-star",
  );
  assert.equal(
    matchApiRoute("/api/history/sessions/summit/h-123/star", "GET")?.methodAllowed,
    false,
  );
});

test("the history resume route is machine scoped and POST only", () => {
  assert.equal(
    matchApiRoute("/api/history/sessions/summit/h-123/resume", "POST")?.id,
    "history-resume",
  );
  assert.equal(
    matchApiRoute("/api/history/sessions/summit/h-123/resume", "GET")?.methodAllowed,
    false,
  );
});
