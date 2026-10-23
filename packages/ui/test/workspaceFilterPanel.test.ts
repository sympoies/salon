import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { CLEAR_SESSION_FILTERS, filterRecords, type SessionFilters } from "../src/sessionFilters.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

for (const mobile of [false, true]) for (const mode of ["default", "saved all", "legacy hide-all"] as const) test(`#987 Workspace panel uses inclusive selection (${mobile ? "phone" : "desktop"}, ${mode})`, async () => {
  const window = new Window({ url: "http://localhost", width: mobile ? 384 : 1500 });
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container), harness = createUiSsrHarness();
  const records = ["team-a", "team-a", "team-a", "team-b", null, undefined, "future-team"].map((workspace, index) => ({
    machine: "host-a", session_id: String(index), created_at: "2030-01-01T00:00:00Z", provider: "codex", workspace,
  }));
  try {
    const { SessionFiltersBar } = await harness.loadModule<typeof import("../src/SessionFiltersBar.tsx")>("/src/SessionFiltersBar.tsx");
    // Workspace names come from a distribution's UI extension (#895); these are neutral.
    const { createUiExtensionRegistry, UiExtensionsProvider } = await harness.loadModule<typeof import("../src/extensions.tsx")>("/src/extensions.tsx");
    const registry = createUiExtensionRegistry([{ id: "teams", workspaceLabels: { lead: "Lead", "team-b": "Team B", "team-a": "Team A" } }]);
    const legacy = mode === "legacy hide-all";
    const allWorkspaces = ["lead", "team-b", "team-a", "future-team", null];
    let filters: SessionFilters = { ...CLEAR_SESSION_FILTERS, workspaces: mode === "saved all" ? allWorkspaces : null,
      excludedWorkspaces: legacy ? allWorkspaces : null }, open = true;
    const render = () => root.render(createElement(UiExtensionsProvider, { registry }, createElement(SessionFiltersBar, { filters, mobile, compactHeader: true, open, records,
      machines: ["host-a"], roles: [], harnesses: [], resultCount: filterRecords(records, filters).length,
      onOpenChange(value) { open = value; render(); }, onChange(next) { filters = next; render(); } })));
    await act(render);
    const choices = () => [...container.querySelectorAll<HTMLInputElement>('[data-filter-dimension="workspaces"] input')];
    assert.equal(choices().length, 5);
    assert.ok(choices().every(input => !input.checked), "no checked workspace means all, including saved all-checked filters");
    const all = () => container.querySelector<HTMLButtonElement>('[data-filter-dimension="workspaces"] button')!;
    assert.equal(all().disabled, !legacy, "legacy hide-all is not silently displayed as All workspaces");
    if (legacy) {
      assert.equal(filterRecords(records, filters).length, 0);
      assert.ok(container.querySelector('[aria-label^="Remove Workspace: All except"]'));
    }
    assert.match(choices().find(input => input.value === "team-a")!.parentElement!.textContent!, /Team A \(3\)/);
    assert.match(choices().find(input => input.value === "")!.parentElement!.textContent!, /Unassigned \(2\)/);
    assert.match(choices().find(input => input.value === "future-team")!.parentElement!.textContent!, /future-team \(1\)/);
    await act(() => choices().find(input => input.value === "team-a")!.click());
    assert.equal(filterRecords(records, filters).length, legacy ? 0 : 7, "selection remains staged");
    await act(() => { filters = { ...filters }; render(); });
    assert.equal(choices().find(input => input.value === "team-a")!.checked, true, "poll preserves staged workspace");
    assert.equal(choices().filter(input => input.checked).length, 1, "first choice isolates that workspace");
    assert.equal(all().disabled, false);
    await act(() => container.querySelector<HTMLButtonElement>('.session-filter-panel-actions .primary')!.click());
    assert.equal(filterRecords(records, filters).length, 3);
    assert.equal(filters.excludedWorkspaces, null, "a deliberate workspace choice exits legacy mode");
    assert.equal(open, false);
    assert.ok(container.querySelector('[aria-label^="Remove Workspace:"]'));
    records.push({ ...records[0]!, session_id: "later", workspace: "later-team" });
    await act(render);
    assert.equal(filterRecords(records, filters).length, 3, "an explicit subset does not include a newly discovered workspace");
    await act(() => container.querySelector<HTMLButtonElement>('.session-filters-trigger')!.click());
    assert.equal(choices().find(input => input.value === "later-team")!.checked, false);
    await act(() => choices().find(input => input.value === "team-a")!.click());
    assert.ok(choices().every(input => !input.checked), "unchecking the last workspace restores all");
    assert.equal(all().disabled, true);
    await act(() => container.querySelector<HTMLButtonElement>('.session-filter-panel-actions .primary')!.click());
    assert.equal(filters.workspaces, null);
    assert.equal(filterRecords(records, filters).length, 8);
    assert.equal(Boolean(container.querySelector('[aria-label^="Remove Workspace:"]')), false);
    await act(() => container.querySelector<HTMLButtonElement>('.session-filters-trigger')!.click());
    await act(() => choices().find(input => input.value === "team-a")!.click());
    await act(() => [...container.querySelectorAll<HTMLButtonElement>('.session-filter-panel-actions button')].find(button => button.textContent === "Clear all")!.click());
    assert.equal(filters.workspaces, null);
    assert.equal(filterRecords(records, filters).length, 8);
  } finally {
    await act(() => root.unmount()); await harness.close(); await window.happyDOM.close();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
