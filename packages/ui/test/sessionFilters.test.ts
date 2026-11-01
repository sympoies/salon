import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CLEAR_SESSION_FILTERS, filterRecords, hasActiveSessionFilters, sessionRoleOptions } from "../src/sessionFilters.ts";





test("Working and Waiting filters apply within the existing scope and can be cleared", () => {
  const records = [
    { machine: "host-a", session_id: "running", created_at: "2030-01-01T00:00:00Z", provider: "codex", status: "running", turn_state: { phase: "working" } },
    { machine: "host-a", session_id: "attention", created_at: "2030-01-01T00:00:00Z", provider: "codex", status: "running", turn_state: { phase: "needs_input" } },
    { machine: "host-b", session_id: "stopped", created_at: "2030-01-01T00:00:00Z", provider: "codex", status: "stopped" },
  ];
  assert.deepEqual(filterRecords(records, { ...CLEAR_SESSION_FILTERS, hosts: ["host-a"], statusGroup: "working" }).map(row => row.session_id), ["running"]);
  assert.deepEqual(filterRecords(records, { ...CLEAR_SESSION_FILTERS, hosts: ["host-a"], statusGroup: "waiting" }).map(row => row.session_id), []);
  assert.deepEqual(filterRecords(records, { ...CLEAR_SESSION_FILTERS, hosts: ["host-a"], statusGroup: "attention" }).map(row => row.session_id), ["attention"],
    "a pending input request filters as Needs attention (#873)");
  assert.deepEqual(filterRecords(records, { ...CLEAR_SESSION_FILTERS, hosts: ["host-a"], statusGroup: null }).map(row => row.session_id), ["running", "attention"]);
});

test("failed waiting turns filter as Attention rather than Waiting", () => {
  const failed = {
    machine: "host-a", session_id: "failed", created_at: "2030-01-01T00:00:00Z", provider: "codex", status: "running",
    turn_state: { phase: "waiting", last_turn: { outcome: "failed" } },
  };
  assert.deepEqual(filterRecords([failed], { ...CLEAR_SESSION_FILTERS, statusGroup: "waiting" }), []);
  assert.deepEqual(filterRecords([failed], { ...CLEAR_SESSION_FILTERS, statusGroup: "attention" }), [failed]);
});

test("role options come from session tags and include sessions with no role", () => {
  const records = [
    { machine: "host-a", session_id: "review", created_at: "2030-01-01T00:00:00Z", provider: "codex", role: "reviewer" as const },
    { machine: "host-b", session_id: "plain", created_at: "2030-01-01T00:00:00Z", provider: "claude" },
    { machine: "host-c", session_id: "steward", created_at: "2030-01-01T00:00:00Z", provider: "codex", role: "steward" as const },
  ];
  assert.deepEqual(sessionRoleOptions(records), ["reviewer", "steward"]);
});



test("role filtering combines named roles and no-role while null means all", () => {
  const records = [
    { machine: "host-a", session_id: "review", created_at: "2030-01-01T00:00:00Z", provider: "codex", role: "reviewer" as const },
    { machine: "host-b", session_id: "plain", created_at: "2030-01-01T00:00:00Z", provider: "claude" },
    { machine: "host-c", session_id: "steward", created_at: "2030-01-01T00:00:00Z", provider: "codex", role: "steward" as const },
  ];
  assert.deepEqual(filterRecords(records, { ...CLEAR_SESSION_FILTERS, roles: ["reviewer", null] }).map(row => row.session_id), ["review", "plain"]);
  assert.deepEqual(filterRecords(records, { ...CLEAR_SESSION_FILTERS, roles: ["reviewer", null, "steward"] }), records);
  assert.deepEqual(filterRecords(records, { ...CLEAR_SESSION_FILTERS, roles: null }), records);
});

test("a roles-only restriction counts as an active session filter", () => {
  assert.equal(hasActiveSessionFilters({ ...CLEAR_SESSION_FILTERS, roles: ["reviewer"] }), true);
  assert.equal(hasActiveSessionFilters({ ...CLEAR_SESSION_FILTERS, roles: null }), false);
});

// Facets reuse the list predicate, replacing only the option's own dimension.
import * as sessionFilters from "../src/sessionFilters.ts";
const facetRows = [
  { machine: "host-a", session_id: "review", created_at: "2030-01-01T00:00:00Z", provider: "codex", role: "reviewer" as const, repo_name: "console", status: "running" },
  { machine: "host-b", session_id: "plain", created_at: "2030-01-01T00:00:00Z", provider: "claude", repo_name: "console", status: "stopped" },
  { machine: "host-b", session_id: "worker", created_at: "2030-01-01T00:00:00Z", provider: "codex", role: "worker" as const, repo_name: "console", status: "running" },
  { machine: "host-a", session_id: "elsewhere", created_at: "2030-01-01T00:00:00Z", provider: "other-provider", repo_name: "other", status: "running" },
];
test("facet options replace their dimension and respect all other selected dimensions", () => {
  const filters = { ...CLEAR_SESSION_FILTERS, hosts: ["host-a"], harness: "claude", repo: "console" };
  assert.equal(sessionFilters.sessionFacetCount(facetRows, filters, { harness: "codex" }), 1);
  assert.equal(sessionFilters.sessionFacetCount(facetRows, filters, { hosts: ["host-b"] }), 1);
  assert.equal(sessionFilters.sessionFacetCount(facetRows, filters, { roles: ["reviewer"] }), 0);
  assert.equal(sessionFilters.sessionFacetCount(facetRows, { ...filters, harness: "codex" }, { roles: ["reviewer"] }), 1);
});
test("zero-count facets and each all option agree with the corresponding list", () => {
  for (const option of [{ hosts: null }, { roles: null }, { harness: null }, { statusGroup: null }] as const) {
    assert.equal(sessionFilters.sessionFacetCount(facetRows, CLEAR_SESSION_FILTERS, option), filterRecords(facetRows, CLEAR_SESSION_FILTERS).length);
  }
  assert.equal(sessionFilters.sessionFacetCount(facetRows, CLEAR_SESSION_FILTERS, { hosts: ["empty-host"] }), 0);
  assert.equal(sessionFilters.sessionFacetCount(facetRows, CLEAR_SESSION_FILTERS, { harness: "other-provider" }), 1);
  assert.equal(sessionFilters.sessionFacetCount(facetRows, CLEAR_SESSION_FILTERS, { roles: [null] }), 2);
});
test("the first host pick isolates that value; the all state is null", () => {
  const hosts = ["host-a", "host-b", "host-c"];
  assert.deepEqual(sessionFilters.toggleFacetSelection(null, hosts, "host-b"), ["host-b"]);
});

test("further picks add to the selection in universe order and removing the last value returns to all", () => {
  const hosts = ["host-a", "host-b", "host-c"];
  const added = sessionFilters.toggleFacetSelection(["host-c"], hosts, "host-a");
  assert.deepEqual(added, ["host-a", "host-c"]);
  assert.equal(sessionFilters.toggleFacetSelection(["host-b"], hosts, "host-b"), null);
  assert.deepEqual(sessionFilters.toggleFacetSelection(["host-a", "host-c"], hosts, "host-c"), ["host-a"]);
});

test("an empty selection is never produced: the last removal yields all", () => {
  assert.equal(sessionFilters.toggleFacetSelection(["host-a"], ["host-a", "host-b"], "host-a"), null);
  assert.equal(sessionFilters.normalizeFacetSelection([], ["host-a", "host-b"]), null);
});

test("a selection that covers every value normalizes to all, so later hosts appear as all does", () => {
  assert.equal(sessionFilters.normalizeFacetSelection(["host-a", "host-b"], ["host-a", "host-b"]), null);
  assert.equal(sessionFilters.toggleFacetSelection(["host-a"], ["host-a", "host-b"], "host-b"), null);
  assert.deepEqual(sessionFilters.normalizeFacetSelection(["host-a"], ["host-a", "host-b"]), ["host-a"]);
});

test("role selections keep the no-role value in universe order and normalize like hosts", () => {
  const roles = [null, "analyst", "reviewer"];
  assert.deepEqual(sessionFilters.toggleFacetSelection(["reviewer"], roles, null), [null, "reviewer"]);
  assert.equal(sessionFilters.toggleFacetSelection([null], roles, null), null);
});

test("an unknown host inventory never collapses a selection to all", () => {
  assert.deepEqual(sessionFilters.normalizeFacetSelection(["a"], []), ["a"]);
});

test("a scope value saved by an earlier version never hides sessions or counts as an active filter", () => {
  const saved = { ...CLEAR_SESSION_FILTERS, scope: "center:control" } as typeof CLEAR_SESSION_FILTERS;
  assert.equal(filterRecords(facetRows, saved).length, facetRows.length);
  assert.equal(sessionFilters.sessionFacetCount(facetRows, saved, { statusGroup: null }), facetRows.length);
  assert.equal(hasActiveSessionFilters(saved), false);
});

test("a host role resolver names roles for the Roles facet and its filter", () => {
  const roleOf = (row: { session_id: string }) => row.session_id === "plain" ? "lead" : null;
  assert.deepEqual(sessionRoleOptions(facetRows, roleOf), ["lead", "reviewer", "worker"]);
  assert.deepEqual(filterRecords(facetRows, { ...CLEAR_SESSION_FILTERS, roles: ["lead"] }, roleOf).map(row => row.session_id), ["plain"]);
});

test("the scope-named lineage aliases are gone and the lineage names remain", () => {
  assert.equal("scopeRecordKey" in sessionFilters, false);
  assert.equal("scopeParents" in sessionFilters, false);
  assert.equal(typeof sessionFilters.lineageRecordKey, "function");
  assert.equal(typeof sessionFilters.lineageParents, "function");
});
