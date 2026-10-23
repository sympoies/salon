import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DebugEvent } from "@agent-console/shared/api";
import {
  DEBUG_FILTER_ALL,
  EMPTY_DEBUG_FILTER,
  debugRouteFamilies,
  debugSessionKey,
  debugSessionKeys,
  describeDebugFilter,
  filterDebugEvents,
  isDebugFilterActive,
  splitDebugSessionKey,
} from "../src/debugFilter.ts";

function event(overrides: Partial<DebugEvent> = {}): DebugEvent {
  return {
    seq: 1,
    at: "2026-09-21T12:00:00.000Z",
    source: "client",
    request_id: null,
    method: "GET",
    route: "/api/sessions",
    status: 200,
    ok: true,
    duration_ms: 3,
    machine: null,
    session_id: null,
    error: null,
    ...overrides,
  };
}

const poll = event({ seq: 1, route: "/api/sessions", machine: null, session_id: null });
const failure = event({
  seq: 2,
  route: "/api/sessions/:machine/:id/retitle-v3",
  method: "POST",
  status: 200,
  ok: false,
  machine: "summit",
  session_id: "hs-codex-1",
  code: "retitle-v3-history-conflict",
});
const lifecycle = event({
  seq: 3,
  source: "edge",
  route: "/title-lifecycle",
  status: null,
  ok: null,
  machine: "summit",
  session_id: "hs-codex-1",
  operation: "title",
  outcome: "daemon_v3_committed",
});
const other = event({ seq: 4, route: "/api/usage", machine: null });

const all = [poll, failure, lifecycle, other];

test("route families and session keys are derived from the rows actually present", () => {
  assert.deepEqual(debugRouteFamilies(all), ["lifecycle", "sessions", "sessions/retitle-v3", "usage"]);
  assert.deepEqual(debugSessionKeys(all), ["summit/hs-codex-1"]);
  assert.equal(debugSessionKey(poll), null);
  assert.deepEqual(splitDebugSessionKey("summit/hs-codex-1"), {
    machine: "summit",
    sessionId: "hs-codex-1",
  });
  assert.equal(splitDebugSessionKey("hs-codex-1"), null);
});

test("the outcome filter separates failures, lifecycle rows, and both together", () => {
  const seqs = (outcome: "all" | "signal" | "failures" | "lifecycle") =>
    filterDebugEvents(all, { ...EMPTY_DEBUG_FILTER, outcome }).map((e) => e.seq);
  assert.deepEqual(seqs("all"), [1, 2, 3, 4]);
  assert.deepEqual(seqs("failures"), [2]);
  assert.deepEqual(seqs("lifecycle"), [3]);
  assert.deepEqual(seqs("signal"), [2, 3]);
});

test("route, session, source, and free text narrow the list together", () => {
  assert.deepEqual(
    filterDebugEvents(all, { ...EMPTY_DEBUG_FILTER, family: "sessions/retitle-v3" }).map((e) => e.seq),
    [2],
  );
  assert.deepEqual(
    filterDebugEvents(all, { ...EMPTY_DEBUG_FILTER, session: "summit/hs-codex-1" }).map((e) => e.seq),
    [2, 3],
  );
  assert.deepEqual(
    filterDebugEvents(all, { ...EMPTY_DEBUG_FILTER, source: "edge" }).map((e) => e.seq),
    [3],
  );
  // Free text reaches the projected diagnosis, which is the field an operator
  // actually knows when they come to the panel with a reported failure class.
  assert.deepEqual(
    filterDebugEvents(all, { ...EMPTY_DEBUG_FILTER, text: "history-conflict" }).map((e) => e.seq),
    [2],
  );
  assert.deepEqual(
    filterDebugEvents(all, {
      ...EMPTY_DEBUG_FILTER,
      session: "summit/hs-codex-1",
      outcome: "failures",
    }).map((e) => e.seq),
    [2],
  );
});

test("an active filter is reported so a copied bundle can say what it excluded", () => {
  assert.equal(isDebugFilterActive(EMPTY_DEBUG_FILTER), false);
  assert.equal(describeDebugFilter(EMPTY_DEBUG_FILTER), undefined);
  const filter = {
    source: "edge" as const,
    family: "sessions/retitle-v3",
    outcome: "failures" as const,
    session: "summit/hs-codex-1",
    text: " conflict ",
  };
  assert.equal(isDebugFilterActive(filter), true);
  assert.equal(
    describeDebugFilter(filter),
    "source=edge route=sessions/retitle-v3 outcome=failures session=summit/hs-codex-1 text=conflict",
  );
  assert.equal(EMPTY_DEBUG_FILTER.family, DEBUG_FILTER_ALL);
});
