import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyHistoryStar, sortHistorySessions } from "../src/historyStars.ts";
import type { HistorySession } from "../src/types.ts";

function session(id: string, updatedAt: string, starredAt?: string): HistorySession {
  return {
    id,
    machine: "summit",
    provider: "codex",
    provider_session_id: id,
    cwd: "/work/example",
    created_at: updatedAt,
    updated_at: updatedAt,
    resumable: false,
    ...(starredAt ? { starred_at: starredAt } : {}),
  };
}

test("starred history sessions lead the list newest star first", () => {
  const sorted = sortHistorySessions([
    session("recent", "2026-08-31T00:00:00Z"),
    session("older-star", "2026-08-01T00:00:00Z", "2026-08-10T00:00:00Z"),
    session("newer-star", "2026-08-02T00:00:00Z", "2026-08-11T00:00:00Z"),
    session("older", "2026-07-01T00:00:00Z"),
  ]);

  assert.deepEqual(sorted.map((entry) => entry.id), ["newer-star", "older-star", "recent", "older"]);
});

test("starring a row moves it to the front and unstarring returns it to recency order", () => {
  const sessions = [
    session("recent", "2026-08-31T00:00:00Z"),
    session("older", "2026-07-01T00:00:00Z"),
  ];

  const starred = applyHistoryStar(sessions, "older", "2026-09-01T00:00:00Z");
  assert.deepEqual(starred.map((entry) => entry.id), ["older", "recent"]);
  assert.equal(starred[0]?.starred_at, "2026-09-01T00:00:00Z");

  const cleared = applyHistoryStar(starred, "older", undefined);
  assert.deepEqual(cleared.map((entry) => entry.id), ["recent", "older"]);
  assert.equal(cleared[1]?.starred_at, undefined);
  assert.equal("starred_at" in cleared[1]!, false, "an unstarred row carries no star field");
});

test("applying a star to an unknown history id leaves the list untouched", () => {
  const sessions = [session("recent", "2026-08-31T00:00:00Z")];

  assert.deepEqual(applyHistoryStar(sessions, "missing", "2026-09-01T00:00:00Z"), sessions);
});
