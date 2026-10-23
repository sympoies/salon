import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifySessionStatus, countSessionStatuses } from "../src/sessionStatusGroups.ts";

test("each runtime status maps to its status group", () => {
  assert.equal(classifySessionStatus({ runtimeStatus: "running", turnPhase: "working" }), "working");
  assert.equal(classifySessionStatus({ runtimeStatus: "stopped" }), "stopped");
  assert.equal(classifySessionStatus({ runtimeStatus: "missing" }), "attention");
  assert.equal(classifySessionStatus({ runtimeStatus: "unknown" }), "attention");
  assert.equal(classifySessionStatus({ runtimeStatus: "error" }), "attention");
  assert.equal(classifySessionStatus({ runtimeStatus: null }), "attention");
});

test("turn phases map to Working, Waiting, Attention, State unknown, and Stop (#873)", () => {
  assert.equal(classifySessionStatus({ runtimeStatus: "running", turnPhase: "working" }), "working");
  for (const turnPhase of ["idle", "waiting"]) {
    assert.equal(classifySessionStatus({ runtimeStatus: "running", turnPhase }), "waiting", turnPhase);
  }
  assert.equal(classifySessionStatus({ runtimeStatus: "running", turnPhase: "needs_input" }), "attention",
    "a pending input request needs the human");
  assert.equal(classifySessionStatus({ runtimeStatus: "running", turnPhase: "starting" }), "attention");
  assert.equal(classifySessionStatus({ runtimeStatus: "running", turnPhase: "unknown" }), "unknown",
    "an unobservable state is not an attention request");
  assert.equal(classifySessionStatus({ runtimeStatus: "running", turnPhase: "future-phase" }), "unknown");
  assert.equal(classifySessionStatus({ runtimeStatus: "running" }), "unknown", "a missing phase is unobservable");
});

test("failed waiting turns remain Attention", () => {
  const evidence = {
    runtimeStatus: "running",
    turnPhase: "waiting",
    lastTurnOutcome: "failed",
  };
  assert.equal(classifySessionStatus(evidence), "attention");
});

test("runtime errors and non-running input requests retain Attention precedence", () => {
  assert.equal(classifySessionStatus({ runtimeStatus: "stopped", turnPhase: "needs_input" }), "attention");
  assert.equal(classifySessionStatus({ runtimeStatus: "missing" }), "attention");
  assert.equal(classifySessionStatus({ runtimeStatus: "stopped", turnPhase: "unknown" }), "attention");
  assert.equal(classifySessionStatus({ runtimeStatus: "running", turnPhase: "needs_input" }), "attention");
});

test("status counts keep each of the five groups separate", () => {
  const counts = countSessionStatuses([
    { runtimeStatus: "running", turnPhase: "working" },
    { runtimeStatus: "running", turnPhase: "idle" },
    { runtimeStatus: "running", turnPhase: "waiting", lastTurnOutcome: "failed" },
    { runtimeStatus: "running", turnPhase: "starting" },
    { runtimeStatus: "running", turnPhase: "needs_input" },
    { runtimeStatus: "running", turnPhase: "unknown" },
    { runtimeStatus: "stopped" },
  ], record => record);
  assert.deepEqual(counts, { working: 1, waiting: 1, attention: 3, unknown: 1, stopped: 1 });
});
