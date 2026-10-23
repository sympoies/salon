import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CLEAR_SESSION_FILTERS, filterRecords, hasActiveSessionFilters, sessionFacetCount, sessionWorkspaceOptions, toggleFacetSelection, workspaceLabel } from "../src/sessionFilters.ts";
import { loadWorkspacePreferences, saveWorkspacePreferences } from "../src/workspacePreferences.ts";
import { setPrincipalStorageNamespace } from "../src/storage.ts";

const rows = [
  { session_id: "root", workspace: "team-a" },
  { session_id: "worker", workspace: "team-a", origin: { parent: { session_id: "root", machine: "host-a" } } },
  { session_id: "ideas", workspace: "team-a" },
  { session_id: "other", workspace: "team-b" },
  { session_id: "manual", workspace: null },
  { session_id: "legacy" },
].map(row => ({ machine: "host-a", provider: "codex", created_at: "2030-01-01T00:00:00Z", ...row }));
// Labels a distribution registers through the UI extension registry.
const LABELS: ReadonlyMap<string, string> = new Map([["lead", "Lead"], ["team-b", "Team B"], ["team-a", "Team A"]]);

for (const [excluded, partial] of [
  [["team-a", "team-b", null], false],
  [["team-b"], true],
] as const) test(`reviewer990 migration preserves ${partial ? "offline exclusion" : "legacy hide-all"}`, () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map([["agent-console.excluded-workspaces.v1", JSON.stringify(excluded)]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    const all = ["team-a", "team-b", null].map((workspace, index) => ({
      workspace, machine: "fixture", provider: "codex", session_id: String(index), created_at: "2030-01-01T00:00:00Z",
    }));
    const first = partial ? [all[0]!, all[2]!] : all;
    const preference = loadWorkspacePreferences(sessionWorkspaceOptions(first), !partial);
    assert.equal(values.get("agent-console.excluded-workspaces.v1"), JSON.stringify(excluded));
    assert.deepEqual(filterRecords(all, { ...CLEAR_SESSION_FILTERS, ...preference }).map(row => row.workspace),
      partial ? ["team-a", null] : [], "migration must preserve the old restriction across recovery");
    assert.equal(values.has("agent-console.workspaces.v2"), false, "unresolved restriction is not overwritten");
    saveWorkspacePreferences(preference);
    assert.equal(values.has("agent-console.workspaces.v2"), false, "applying another facet retains the legacy restriction");
    if (partial) {
      const complete = loadWorkspacePreferences(sessionWorkspaceOptions(all), true);
      assert.deepEqual(filterRecords(all, { ...CLEAR_SESSION_FILTERS, ...complete }).map(row => row.workspace), ["team-a", null]);
    } else {
      saveWorkspacePreferences({ workspaces: ["team-a"], excludedWorkspaces: null });
      assert.deepEqual(filterRecords(all, { ...CLEAR_SESSION_FILTERS, ...loadWorkspacePreferences() }).map(row => row.workspace), ["team-a"], "an explicit choice replaces hide-all");
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("Workspace defaults to all; selecting one includes its root, workers and ideas only", () => {
  assert.deepEqual(filterRecords(rows, CLEAR_SESSION_FILTERS), rows);
  const filters = { ...CLEAR_SESSION_FILTERS, workspaces: ["team-a"] };
  assert.deepEqual(filterRecords(rows, filters).map(row => row.session_id), ["root", "worker", "ideas"]);
  assert.equal(hasActiveSessionFilters(filters), true);
  const onlyTeamA = { workspaces: ["team-a"] };
  assert.equal(sessionFacetCount(rows, filters, onlyTeamA), 3);
  assert.equal(sessionFacetCount(rows, { ...filters, hosts: ["host-b"] }, onlyTeamA), 0);
});
test("missing and null workspace share Unassigned; no checked workspace means all", () => {
  assert.deepEqual(filterRecords(rows, { ...CLEAR_SESSION_FILTERS, workspaces: [null] }).map(row => row.session_id), ["manual", "legacy"]);
  assert.deepEqual(filterRecords(rows, { ...CLEAR_SESSION_FILTERS, workspaces: [] }), rows);
  assert.equal(hasActiveSessionFilters({ ...CLEAR_SESSION_FILTERS, workspaces: [] }), false);
  assert.deepEqual(filterRecords([rows[5]!], CLEAR_SESSION_FILTERS), [rows[5]!]);
});
test("workspace options retain known, unknown and selected slugs; toggling follows inclusive facets", () => {
  const universe = sessionWorkspaceOptions([{ ...rows[0]!, workspace: "future-team" }], ["offline-team"], LABELS.keys());
  assert.deepEqual(universe, ["lead", "team-b", "team-a", "future-team", "offline-team", null]);
  assert.equal(workspaceLabel("future-team", LABELS), "future-team");
  assert.equal(workspaceLabel("constructor", LABELS), "constructor");
  assert.equal(workspaceLabel("team-a", LABELS), "Team A");
  assert.equal(workspaceLabel(null, LABELS), "Unassigned");
  assert.deepEqual(toggleFacetSelection(null, universe, "team-a"), ["team-a"]);
  assert.equal(toggleFacetSelection(["team-a"], universe, "team-a"), null);
  assert.equal(toggleFacetSelection(universe.filter(value => value !== "team-a"), universe, "team-a"), null);
});
test("core alone names no workspace: labels and the fixed list come only from extensions (#895)", () => {
  assert.equal(workspaceLabel("team-a"), "team-a");
  assert.deepEqual(sessionWorkspaceOptions(rows), ["team-a", "team-b", null]);
  assert.deepEqual(sessionWorkspaceOptions([]), [null]);
});
test("workspace selections persist per principal, normalize saved all and migrate legacy exclusions", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  try {
    setPrincipalStorageNamespace("first");
    const all = { workspaces: null, excludedWorkspaces: null };
    assert.deepEqual(loadWorkspacePreferences(), all);
    saveWorkspacePreferences({ workspaces: ["team-a"] });
    const preference = loadWorkspacePreferences();
    const future = { ...rows[0]!, session_id: "future", workspace: "future-team" };
    assert.deepEqual(filterRecords([...rows, future], { ...CLEAR_SESSION_FILTERS, ...preference }).map(row => row.session_id), ["root", "worker", "ideas"]);
    setPrincipalStorageNamespace("second"); assert.deepEqual(loadWorkspacePreferences(), all);
    saveWorkspacePreferences({ workspaces: [null] }); assert.deepEqual(loadWorkspacePreferences(), { workspaces: [null], excludedWorkspaces: null });
    saveWorkspacePreferences({ workspaces: sessionWorkspaceOptions(rows) });
    assert.deepEqual(loadWorkspacePreferences(sessionWorkspaceOptions(rows), true), all, "saved all-checked becomes canonical all after complete discovery");
    assert.deepEqual(loadWorkspacePreferences(), all);
    assert.equal(filterRecords([...rows, future], { ...CLEAR_SESSION_FILTERS, ...loadWorkspacePreferences() }).length, 7);
    setPrincipalStorageNamespace("legacy");
    values.set("agent-console.principal.legacy.agent-console.excluded-workspaces.v1", '["team-a"]');
    assert.deepEqual(loadWorkspacePreferences(), { workspaces: null, excludedWorkspaces: ["team-a"] }, "retain the restriction before discovery");
    const migrated = loadWorkspacePreferences(sessionWorkspaceOptions(rows), true);
    assert.deepEqual(migrated, { workspaces: ["team-b", null], excludedWorkspaces: null });
    assert.deepEqual(filterRecords(rows, { ...CLEAR_SESSION_FILTERS, ...migrated }).map(row => row.session_id), ["other", "manual", "legacy"]);
    saveWorkspacePreferences({ workspaces: ["team-a"] });
    assert.deepEqual(loadWorkspacePreferences(sessionWorkspaceOptions(rows), true), { workspaces: ["team-a"], excludedWorkspaces: null }, "new preference wins over the old exclusion");
    assert.equal(values.get("agent-console.principal.legacy.agent-console.excluded-workspaces.v1"), '["team-a"]', "migration preserves the old storage entry");
    setPrincipalStorageNamespace("legacy-all");
    values.set("agent-console.principal.legacy-all.agent-console.excluded-workspaces.v1", "[]");
    assert.deepEqual(loadWorkspacePreferences(sessionWorkspaceOptions(rows), true), all, "legacy all-checked stays all");
    for (const malformed of ['["INVALID"]', '{', '[42]']) {
      for (const key of values.keys()) values.set(key, malformed);
      assert.deepEqual(loadWorkspacePreferences(), all);
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    assert.doesNotThrow(() => saveWorkspacePreferences({ workspaces: ["team-a"] })); assert.deepEqual(loadWorkspacePreferences(), all);
  } finally {
    setPrincipalStorageNamespace(null);
    if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
