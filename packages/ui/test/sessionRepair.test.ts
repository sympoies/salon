import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  applySessionRepairResult,
  executeSessionRepairPlan,
  executeSessionRepairs,
  incrementReconnectTokens,
  planSessionRepairs,
  sessionRepairPlanHasWork,
  sessionRepairSummary,
} from "../src/sessionRepair.ts";
import { sessionKey } from "../src/layout.ts";
import { makeSession } from "./support/fixtures.ts";

function session(id: string, status: string, resumable = false) {
  return makeSession({
    id,
    machine: "maple",
    status,
    resumable,
    title: null,
    cwd: undefined,
    repo_name: null,
    updated_at: undefined,
  });
}

test("planSessionRepairs repairs every session the console lists", () => {
  const open = session("open", "running");
  const closed = session("closed", "running");
  const resumable = session("resumable", "stopped", true);
  const stopped = session("stopped", "stopped", false);
  const offPage = session("off-page", "running");
  const offPageResumable = session("off-page-resumable", "stopped", true);

  const plan = planSessionRepairs({
    sessions: [open, closed, resumable, stopped, offPage, offPageResumable],
  });

  assert.equal(plan.checked, 6);
  assert.deepEqual(plan.resume.map(sessionKey), [sessionKey(resumable), sessionKey(offPageResumable)]);
  assert.deepEqual(plan.reconnectKeys, [sessionKey(open), sessionKey(closed), sessionKey(offPage)]);
});

// Regression: overview pagination and the Main Agent group filter mount a
// different set of panes than the layout slot array, so a slot-membership gate
// silently skipped sessions that were on screen while still counting them.
test("planSessionRepairs repairs sessions that hold no layout slot", () => {
  const worker = session("worker", "running");
  const standalone = session("standalone", "running");
  const standaloneResumable = session("standalone-resumable", "stopped", true);

  const plan = planSessionRepairs({
    sessions: [worker, standalone, standaloneResumable],
  });

  assert.deepEqual(plan.reconnectKeys, [sessionKey(worker), sessionKey(standalone)]);
  assert.deepEqual(plan.resume.map(sessionKey), [sessionKey(standaloneResumable)]);
});

// Regression: a pane wedged in "connecting", or one still reporting "open" over
// a socket the daemon already dropped, never reported "closed" and so never got
// reconnected. The single-session Cmd-R path always bumped its token.
test("planSessionRepairs reconnects running sessions whatever the pane reports", () => {
  const wedged = session("wedged", "running");

  const plan = planSessionRepairs({ sessions: [wedged] });

  assert.deepEqual(plan.reconnectKeys, [sessionKey(wedged)]);
});

test("session repair plans report repairable work", () => {
  const closed = session("closed", "running");
  const resumable = session("resumable", "stopped", true);
  const plan = planSessionRepairs({ sessions: [closed, resumable] });

  assert.equal(sessionRepairPlanHasWork(plan), true);
});

test("planSessionRepairs leaves stopped sessions that cannot resume alone", () => {
  const stopped = session("stopped", "stopped", false);

  const plan = planSessionRepairs({ sessions: [stopped] });

  assert.equal(sessionRepairPlanHasWork(plan), false);
  assert.equal(plan.checked, 1);
});

test("planSessionRepairs deduplicates duplicate backend rows by session key", () => {
  const resumable = session("dup-resume", "stopped", true);
  const running = session("dup-running", "running");

  const plan = planSessionRepairs({
    sessions: [resumable, { ...resumable, title: "duplicate" }, running, { ...running, title: "duplicate" }],
  });

  assert.deepEqual(plan.resume.map(sessionKey), [sessionKey(resumable)]);
  assert.deepEqual(plan.reconnectKeys, [sessionKey(running)]);
});

test("planSessionRepairs plans one action for conflicting same-key rows", () => {
  const resumable = session("dup", "stopped", true);
  const running = session("dup", "running");

  const plan = planSessionRepairs({ sessions: [running, resumable] });

  assert.deepEqual(plan.resume.map(sessionKey), [sessionKey(resumable)]);
  assert.deepEqual(plan.reconnectKeys, []);
});

test("executeSessionRepairs runs resume and reconnect work in one repair action", async () => {
  const closed = session("closed", "running");
  const resumable = session("resumable", "stopped", true);
  const failing = session("failing", "stopped", true);
  const resumed: string[] = [];

  const result = await executeSessionRepairs({
    sessions: [closed, resumable, failing],
    resumeSession: async (candidate) => {
      resumed.push(sessionKey(candidate));
      return candidate.id === "failing" ? { ok: false, error: "daemon refused" } : { ok: true };
    },
  });

  assert.deepEqual(resumed, [sessionKey(resumable), sessionKey(failing)]);
  assert.deepEqual(result, {
    checked: 3,
    resumed: 1,
    reconnected: 1,
    resumeKeys: [sessionKey(resumable)],
    reconnectKeys: [sessionKey(closed)],
    failed: 1,
    failures: [{
      sessionKey: sessionKey(failing),
      label: "failing",
      operation: "resume",
      message: "daemon refused",
    }],
  });
});

test("executeSessionRepairs resumes duplicate same-key rows once", async () => {
  const resumable = session("dup-resume", "stopped", true);
  const resumed: string[] = [];

  const result = await executeSessionRepairs({
    sessions: [resumable, { ...resumable, title: "duplicate" }],
    resumeSession: async (candidate) => {
      resumed.push(sessionKey(candidate));
      return { ok: true };
    },
  });

  assert.deepEqual(resumed, [sessionKey(resumable)]);
  assert.deepEqual(result.resumeKeys, [sessionKey(resumable)]);
  assert.equal(result.resumed, 1);
});

test("executeSessionRepairPlan executes only the provided repair plan", async () => {
  const planned = session("planned", "stopped", true);
  const unplanned = session("unplanned", "stopped", true);
  const plan = {
    checked: 2,
    resume: [planned],
    reconnectKeys: [sessionKey(unplanned)],
  };
  const resumed: string[] = [];

  const result = await executeSessionRepairPlan({
    plan,
    resumeSession: async (candidate) => {
      resumed.push(sessionKey(candidate));
      return { ok: true };
    },
  });

  assert.deepEqual(resumed, [sessionKey(planned)]);
  assert.deepEqual(result, {
    checked: 2,
    resumed: 1,
    reconnected: 1,
    resumeKeys: [sessionKey(planned)],
    reconnectKeys: [sessionKey(unplanned)],
    failed: 0,
    failures: [],
  });
});

test("executeSessionRepairPlan records rejected resume attempts", async () => {
  const failing = session("failing", "stopped", true);
  const result = await executeSessionRepairPlan({
    plan: { checked: 1, resume: [failing], reconnectKeys: [] },
    resumeSession: async () => {
      throw new Error("network down");
    },
  });

  assert.deepEqual(result, {
    checked: 1,
    resumed: 0,
    reconnected: 0,
    resumeKeys: [],
    reconnectKeys: [],
    failed: 1,
    failures: [{
      sessionKey: sessionKey(failing),
      label: "failing",
      operation: "resume",
      message: "network down",
    }],
  });
});

test("applySessionRepairResult marks successful resumes running locally", () => {
  const resumed = session("resumed", "stopped", true);
  const untouched = session("untouched", "stopped", true);

  assert.deepEqual(
    applySessionRepairResult([resumed, untouched], {
      checked: 2,
      resumed: 1,
      reconnected: 0,
      resumeKeys: [sessionKey(resumed)],
      reconnectKeys: [],
      failed: 0,
      failures: [],
    }),
    [{ ...resumed, status: "running", resumable: false }, untouched],
  );
});

test("incrementReconnectTokens bumps only repaired pane tokens", () => {
  assert.deepEqual(incrementReconnectTokens({ a: 1, b: 2 }, ["a", "c"]), { a: 2, b: 2, c: 1 });
});

test("sessionRepairSummary reports checked, repaired, and failed counts", () => {
  assert.equal(
    sessionRepairSummary({ checked: 4, resumed: 1, reconnected: 2, failed: 0 }),
    "Checked 4 sessions; resumed 1; reconnected 2.",
  );
  assert.equal(
    sessionRepairSummary({ checked: 2, resumed: 0, reconnected: 0, failed: 1 }),
    "Checked 2 sessions; 1 failed.",
  );
  assert.equal(
    sessionRepairSummary({ checked: 1, resumed: 0, reconnected: 0, failed: 0 }),
    "Checked 1 session; nothing to repair.",
  );
});
