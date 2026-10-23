import { strict as assert } from "node:assert";
import { test } from "node:test";
import { historyMarkerItem, coordinatorTreeRole, isCoordinatorTreeMember } from "../src/coordinatorTree.ts";
import type { HistorySession } from "../src/types.ts";
import { makeSession } from "./support/fixtures.ts";

test("history rows use the live session's role badge instead of lineage depth", () => {
  const history = {
    id: "h1", machine: "cedar", provider: "claude", provider_session_id: "p-1", cwd: "/w", created_at: "", updated_at: "",
    resumable: true, coordinator_tree: { depth: 2 },
  } satisfies HistorySession;
  const live = makeSession({ id: "s1", machine: "cedar", role: "steward", coordinator_tree: { depth: 2 },
    provider_resume: { provider: "claude", session_id: "p-1" } });
  const other = makeSession({ id: "s2", machine: "moss", role: "tester", provider_resume: { provider: "claude", session_id: "p-1" } });
  assert.equal(historyMarkerItem(history, [other, live]), live);
  const opsLive = makeSession({ id: "ops", machine: "cedar", role: "ops", provider_resume: { provider: "claude", session_id: "p-1" } });
  assert.equal(historyMarkerItem(history, [opsLive]), opsLive, "history rows use the current ops role from the matching live session");
  assert.equal(historyMarkerItem(history, [other]), history, "without a live match the history row keeps its own marks");
  assert.equal(historyMarkerItem({ ...history, provider: "codex" }, [live]).role, undefined);

  const stopped = makeSession({ id: "s0", machine: "cedar", role: "reviewer", status: "stopped",
    provider_resume: { provider: "claude", session_id: "p-1" } });
  assert.equal(historyMarkerItem(history, [stopped, live]), live, "a stopped predecessor never supplies the badge");
  assert.equal(historyMarkerItem(history, [live, stopped]), live);
  assert.equal(historyMarkerItem(history, [stopped]), history);
  const twin = makeSession({ id: "s3", machine: "cedar", role: "tester", provider_resume: { provider: "claude", session_id: "p-1" } });
  assert.equal(historyMarkerItem(history, [live, twin]), history, "ambiguous running matches keep the history marks");
});

test("coordinator tree depth and public role semantics never infer membership from a repository", () => {
  for (const [depth, role] of [[0,"coordinator"],[1,"dispatched"],[2,"descendant"],[3,"descendant"]] as const) {
    assert.equal(coordinatorTreeRole({ coordinator_tree: { depth } }), role);
    assert.equal(isCoordinatorTreeMember({ coordinator_tree: { depth } }), true);
  }
  assert.equal(coordinatorTreeRole({ role: "domain-coordinator" }), "coordinator");
  assert.equal(coordinatorTreeRole({ role: "coordinator" }), "coordinator");
  assert.equal(coordinatorTreeRole(makeSession({ repo_name: "control" })), null);
  assert.equal(coordinatorTreeRole({ dispatched_by: { machine: "host-a", session_id: "other" } }), null);
});
