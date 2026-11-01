import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { CLEAR_SESSION_FILTERS, type SessionFilters } from "../src/sessionFilters.ts";
import { createUiSsrHarness } from "./support/ssr.ts";
import { assertNoElement } from "./support/domAssert.ts";

test("desktop filter panel preserves staged edits across unchanged refreshes and follow external changes", async () => {
  const window = new Window({ url: "http://localhost", width: 1280 });
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container), harness = createUiSsrHarness();
  try {
    const { SessionFiltersBar } = await harness.loadModule<typeof import("../src/SessionFiltersBar.tsx")>("/src/SessionFiltersBar.tsx");
    let filters: SessionFilters = CLEAR_SESSION_FILTERS;
    let open = false;
    const changes: SessionFilters[] = [];
    const render = () => root.render(createElement(SessionFiltersBar, { filters, mobile: false, compactHeader: true, open, onOpenChange(value) { open = value; render(); },
      machines: ["host-a", "host-b"], roles: ["steward", "reviewer"], harnesses: [{ id: "codex", label: "Codex" }], resultCount: 2,
      onChange(next) { changes.push(next); filters = next; render(); } }));
    await act(render);
    assert.equal(Boolean(container.querySelector('.session-filter-panel')), false);
    const openPanel = () => act(() => container.querySelector<HTMLButtonElement>('.session-filters-trigger')!.click());
    await openPanel();
    assert.ok(container.querySelector('.session-filter-panel[role="dialog"]'));
    assertNoElement(container, 'select[aria-label="Scope"]', "no Scope field is offered");
    let harnessSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
    await act(() => { harnessSelect.value = "codex"; harnessSelect.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await act(() => container.querySelector<HTMLInputElement>('[data-filter-dimension="hosts"] input[value="host-a"]')!.click());
    const repository = container.querySelector<HTMLInputElement>('input[aria-label="Repository"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(repository, "staged-repo");
      repository.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(changes.length, 0, "editing visible controls leaves the applied filter unchanged");
    // Dashboard coordination refreshes clone the applied filters even when nothing changed.
    await act(() => { filters = { ...filters }; render(); });
    assert.equal(harnessSelect.value, "codex", "an equal-value poll leaves the staged Harness visible");
    assert.equal(repository.value, "staged-repo", "an equal-value poll leaves the staged Repository visible");
    await act(() => container.querySelector<HTMLButtonElement>('.session-filter-panel-actions .primary')!.click());
    assert.equal(changes.length, 1);
    assert.equal(filters.harness, "codex"); assert.deepEqual(filters.hosts, ["host-a"]);
    assert.equal(filters.repo, "staged-repo", "Apply submits the draft preserved through the refresh");
    assert.equal(Boolean(container.querySelector('.session-filter-panel')), false, "Apply closes desktop filters");
    await openPanel();
    await act(() => container.querySelector<HTMLButtonElement>('[data-filter-dimension="hosts"] .session-filter-facet-all')!.click());
    await act(() => { filters = { ...filters, hosts: [...filters.hosts!], roles: filters.roles ? [...filters.roles] : filters.roles }; render(); });
    assert.equal(changes.length, 1, "facet reset remains staged until Apply");
    await act(() => container.querySelector<HTMLButtonElement>('.session-filter-panel-actions .primary')!.click());
    assert.equal(filters.hosts, null);
    await openPanel();
    await act(() => { filters = { ...CLEAR_SESSION_FILTERS, repo: "external-repo" }; render(); });
    assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="Repository"]')!.value, "external-repo");
    harnessSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
    assert.equal(harnessSelect.value, "", "a genuine external change synchronizes the Harness");
    await act(() => { harnessSelect.value = "codex"; harnessSelect.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await act(() => container.querySelector<HTMLButtonElement>('[data-status-group="working"]')!.click());
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove Repository: external-repo"]')!.click());
    await act(() => container.querySelector<HTMLButtonElement>('.session-filter-panel-actions .primary')!.click());
    assert.equal(filters.harness, "codex", "status toggles and chip removal preserve an unrelated draft");
    assert.equal(filters.statusGroup, "working"); assert.equal(filters.repo, "");
    await openPanel();
    await act(() => container.querySelector<HTMLButtonElement>('.session-filter-panel-actions .btn')!.click());
    assert.deepEqual(filters, CLEAR_SESSION_FILTERS);
    await openPanel();
    assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="Repository"]')!.value, "");
    harnessSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
    await act(() => { harnessSelect.value = "codex"; harnessSelect.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await act(() => container.querySelector<HTMLButtonElement>('.session-filter-panel-actions .btn')!.click());
    await openPanel();
    harnessSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by harness"]')!;
    assert.equal(harnessSelect.value, "", "Clear discards the draft even when applied filters are already clear");
  } finally {
    await act(() => root.unmount()); await harness.close(); await window.happyDOM.close();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
