import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { CLEAR_SESSION_FILTERS, type SessionFilters } from "../src/sessionFilters.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const LONG = "workspace-with-an-exceptionally-long-descriptive-name-that-cannot-fit";
const CJK = "工作区甲";

async function mount(filters: SessionFilters, compactHeader: boolean, onChange: (next: SessionFilters) => void = () => {}) {
  const window = new Window({ url: "http://localhost", width: 390 });
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container), harness = createUiSsrHarness();
  const { SessionFiltersBar } = await harness.loadModule<typeof import("../src/SessionFiltersBar.tsx")>("/src/SessionFiltersBar.tsx");
  await act(() => root.render(createElement(SessionFiltersBar, { filters, mobile: false, compactHeader, machines: ["host-a", "host-b", "host-c"],
    roles: ["steward", "reviewer"], harnesses: [], resultCount: 1, onChange })));
  return { container, async close() {
    await act(() => root.unmount()); await harness.close(); await window.happyDOM.close();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  } };
}

const chipOf = (container: Element, key: string) => container.querySelector<HTMLButtonElement>(`.session-filter-chip[aria-label^="Remove ${key}"]`)!;
const labelOf = (chip: Element) => chip.textContent!.replace(/\s×$/, "");

for (const compactHeader of [false, true]) test(`session filter chips are compact one-line labels with the full list in title and name (${compactHeader ? "search bar" : "chip row"})`, async () => {
  const cases: [SessionFilters, string, string, string][] = [
    [{ ...CLEAR_SESSION_FILTERS, workspaces: ["alpha"] }, "Workspace", "Workspace: alpha", "Workspace: alpha"],
    [{ ...CLEAR_SESSION_FILTERS, workspaces: ["alpha", "beta", "gamma"] }, "Workspace", "Workspace: alpha +2", "Workspace: alpha, beta, gamma"],
    [{ ...CLEAR_SESSION_FILTERS, excludedWorkspaces: ["alpha", "beta"] }, "Workspace", "Workspace: All except alpha +1", "Workspace: All except alpha, beta"],
    [{ ...CLEAR_SESSION_FILTERS, workspaces: [LONG, "beta"] }, "Workspace", `Workspace: ${LONG} +1`, `Workspace: ${LONG}, beta`],
    [{ ...CLEAR_SESSION_FILTERS, workspaces: [CJK, "乙组"] }, "Workspace", `Workspace: ${CJK} +1`, `Workspace: ${CJK}, 乙组`],
    [{ ...CLEAR_SESSION_FILTERS, hosts: ["host-a", "host-b"] }, "Hosts", "Hosts: host-a +1", "Hosts: host-a, host-b"],
    [{ ...CLEAR_SESSION_FILTERS, roles: ["steward", "reviewer"] }, "Roles", "Roles: steward +1", "Roles: steward, reviewer"],
  ];
  for (const [filters, key, compact, full] of cases) {
    const mounted = await mount(filters, compactHeader);
    try {
      const chip = chipOf(mounted.container, key);
      assert.ok(chip, `${key} chip renders for ${full}`);
      assert.equal(labelOf(chip), compact);
      assert.equal(chip.getAttribute("aria-label"), `Remove ${full}`);
      assert.equal(chip.getAttribute("title"), full, "the tooltip carries the full list");
    } finally { await mounted.close(); }
  }
});

test("a Roles selection whose roles no longer exist still reads as a labelled chip", async () => {
  const mounted = await mount({ ...CLEAR_SESSION_FILTERS, roles: ["vanished"] }, false);
  try {
    const chip = chipOf(mounted.container, "Roles");
    assert.equal(labelOf(chip), "Roles: None");
    assert.equal(chip.getAttribute("aria-label"), "Remove Roles: None");
  } finally { await mounted.close(); }
});

test("removing a compact chip still resets its whole dimension", async () => {
  let applied: SessionFilters | undefined;
  const mounted = await mount({ ...CLEAR_SESSION_FILTERS, workspaces: ["alpha", "beta"] }, false, next => { applied = next; });
  try {
    await act(() => chipOf(mounted.container, "Workspace").click());
    assert.equal(applied?.workspaces, null);
  } finally { await mounted.close(); }
});

test("the closed trigger summary uses the compact workspace form without joining every value", async () => {
  const mounted = await mount({ ...CLEAR_SESSION_FILTERS, workspaces: ["alpha", "beta", "gamma"] }, false);
  try {
    const summary = mounted.container.querySelector(".session-filters-trigger-summary")!;
    assert.match(summary.textContent!, /Workspace: alpha \+2/);
    assert.doesNotMatch(summary.textContent!, /beta/);
    assert.match(mounted.container.querySelector(".session-filters-trigger")!.getAttribute("aria-label")!, /Workspace: alpha, beta, gamma/,
      "the accessible name keeps the full list");
  } finally { await mounted.close(); }
});
