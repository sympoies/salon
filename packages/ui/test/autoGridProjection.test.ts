import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import type { Session } from "../src/types.ts";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const sessions = Array.from({ length: 18 }, (_, index) => makeSession({
  role: index < 6 ? "group-a" : "group-b",
  id: String(index + 1).padStart(2, "0"), machine: "fixture", title: `Session ${index + 1}`,
  created_at: `2026-10-16T00:${String(index + 1).padStart(2, "0")}:00Z`,
}));
const staleSlots = [17, 10, 11, 12, 13, 14].map(index => `fixture/${String(index).padStart(2, "0")}`);
interface Fixture { sessions: Session[]; changes: Set<() => void>; orderChanges: Set<() => void>; priorities: string[]; writes: number; }
declare global { var __autoGridFixture: Fixture | undefined; }

const boundaries: Plugin = {
  name: "auto-grid-external-boundaries", enforce: "pre",
  resolveId(id) {
    if (id.endsWith("api.ts")) return "\0auto-grid-api";
    if (id.endsWith("resourceEvents.ts")) return "\0auto-grid-events";
    if (id.endsWith("TerminalPane.tsx")) return "\0auto-grid-terminal";
  },
  load(id) {
    if (id === "\0auto-grid-terminal") return 'import React from "react";export function TerminalPane(){return React.createElement("div",{className:"fixture-terminal"});}';
    if (id === "\0auto-grid-events") return `export const RESOURCE_RECONCILE_MS=30000;
      export const resourceEvents={subscribe(_key,change,health){const f=globalThis.__autoGridFixture;f.changes.add(change);health(false);return()=>f.changes.delete(change);}};`;
    if (id !== "\0auto-grid-api") return;
    const names = [...readFileSync(new URL("../src/api.ts", import.meta.url), "utf8").matchAll(/export (?:async )?function (\w+)/g)].map(match => match[1]);
    const returns: Record<string, string> = {
      listSessions: '({ok:true,sessions:globalThis.__autoGridFixture.sessions,machines:[{name:"fixture",ok:true,capabilities:{history:true}}]})',
      fetchLayoutOrder: `({order:${JSON.stringify([...staleSlots, ...sessions.map(session => `fixture/${session.id}`).filter(key => !staleSlots.includes(key))])},revision:1,reachable:true,conflict:false})`,
      listMachinePreferences: '({ok:true,machines:[]})', listAccounts: '({accounts:[]})',
      usage: '({providers:[],reachable:false})', listHistorySessions: '({ok:true,sessions:[]})',
    };
    return names.map(name => `export async function ${name}(){${name === "putLayoutOrder" ? "globalThis.__autoGridFixture.writes++;" : ""}return ${returns[name] ?? "({ok:true})"};}`).join("\n");
  },
};

async function mount(auto: boolean) {
  const window = new Window({ url: "http://localhost", width: 1500, height: 982 });
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement, HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement, HTMLSelectElement: globalThis.HTMLSelectElement,
    localStorage: globalThis.localStorage, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLSelectElement: window.HTMLSelectElement,
    localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.setItem("agent-console.layout.auto", auto ? "1" : "0");
  window.localStorage.setItem("agent-console.layout.mode", "6");
  window.localStorage.setItem("agent-console.layout.slots", JSON.stringify(staleSlots));
  const fixture: Fixture = { sessions: [...sessions], changes: new Set(), orderChanges: new Set(), priorities: ["group-a", "group-b"], writes: 0 };
  globalThis.__autoGridFixture = fixture;
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness([boundaries]);
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  const { UiExtensionsProvider, createUiExtensionRegistry } = await ssr.loadModule<typeof import("../src/extensions.tsx")>("/src/extensions.tsx");
  const registry = createUiExtensionRegistry([{ id: "fixture", sessionOrdering: {
    subscribe: listener => { fixture.orderChanges.add(listener); return () => fixture.orderChanges.delete(listener); },
    snapshot: () => JSON.stringify(fixture.priorities), fixed: () => true,
    order: rows => [...rows].sort((a,b) => fixture.priorities.indexOf(a.role!) - fixture.priorities.indexOf(b.role!) || Date.parse(a.created_at!) - Date.parse(b.created_at!)),
  } }]);
  await act(async () => root.render(createElement(UiExtensionsProvider, { registry }, createElement(Dashboard, { active: true, machines: ["fixture"], enabledMachines: ["fixture"],
    machineColors: {}, onSettings() {}, onDebug() {}, onUsage() {} }))));
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    assert.fail("auto-grid fixture did not settle");
  };
  await waitFor(() => container.querySelectorAll(".terminal-slot[data-slot-key]").length === 6
    && window.localStorage.getItem("agent-console.layout.slots") === JSON.stringify(staleSlots));
  const keys = () => [...container.querySelectorAll<HTMLElement>(".terminal-slot[data-slot-key]")].map(node => node.dataset.slotKey);
  return { fixture, container, waitFor, keys,
    async filterReviewers() {
      const trigger = container.querySelector<HTMLButtonElement>(".session-filters-trigger"); assert.ok(trigger);
      await act(async () => trigger.click());
      const checkbox = container.querySelector<HTMLInputElement>('[data-filter-dimension="roles"] input[value="group-b"]'); assert.ok(checkbox);
      await act(async () => checkbox.click());
      assert.equal(checkbox.checked, true, "reviewer filter is selected");
      const apply = [...container.querySelectorAll<HTMLButtonElement>(".session-filter-panel-actions button")].find(button => button.textContent === "Apply filters"); assert.ok(apply);
      await act(async () => apply.click());
      await waitFor(() => container.querySelector('.terminal-slot[data-slot-key="fixture/07"]') !== null);
    },
    async reviewersFirst() {
      fixture.priorities = ["group-b", "group-a"];
      await act(async () => { for (const listener of fixture.orderChanges) listener(); });
    },
    async open(number = 1) {
      const button = container.querySelector<HTMLButtonElement>(`[aria-label="Open Session ${number}"]`); assert.ok(button);
      await act(async () => button.click());
      await waitFor(() => container.querySelector(".terminal-slot.is-focused") !== null);
    },
    async gridMembers() {
      const trigger = container.querySelector<HTMLButtonElement>('.terminal-slot.is-focused .slot-ordinal-trigger'); assert.ok(trigger);
      if (trigger.getAttribute("aria-expanded") !== "true") await act(async () => trigger.click());
      const groups = [...container.querySelectorAll<HTMLElement>(".slot-session-nav-group")];
      const grid = groups.find(group => group.querySelector(".slot-session-nav-group-label")?.textContent === "In grid");
      assert.ok(grid);
      return [...grid.querySelectorAll(".slot-menu-label")].map(node => node.textContent);
    },
    async close() {
      await act(async () => root.unmount()); await ssr.close(); delete globalThis.__autoGridFixture;
      Object.assign(globalThis, previous); await window.happyDOM.close();
    },
  };
}

for (const target of ["grid", "navigator"] as const) {
  test(`Auto ${target} follows the first six ordered sessions despite stale persisted slots`, async () => {
    const h = await mount(true);
    try {
      assert.deepEqual(h.keys(), sessions.slice(0, 6).map(session => `fixture/${session.id}`), "overview is already ordered");
      await h.open();
      if (target === "grid") assert.deepEqual(h.keys(), sessions.slice(0, 6).map(session => `fixture/${session.id}`));
      else assert.deepEqual(await h.gridMembers(), sessions.slice(0, 6).map(session => session.title));
      assert.equal(h.fixture.writes, 0, "deriving the Auto grid does not rewrite shared ranking");
    } finally { await h.close(); }
  });
}

test("fixed focused grid and IN GRID preserve manual slot placement", async () => {
  const h = await mount(false);
  try {
    await h.open();
    assert.deepEqual(h.keys(), [...staleSlots, "fixture/01"], "an out-of-grid focused session is mounted separately");
    assert.deepEqual(await h.gridMembers(), ["Session 17", "Session 10", "Session 11", "Session 12", "Session 13", "Session 14"]);
    assert.equal(h.fixture.writes, 0);
  } finally { await h.close(); }
});


test("Auto grid and IN GRID follow role-order changes while the same session stays focused", async () => {
  const h = await mount(true);
  try {
    await h.open();
    await h.reviewersFirst();
    assert.deepEqual(await h.gridMembers(), sessions.slice(6, 12).map(session => session.title));
    assert.deepEqual(h.keys(), [...sessions.slice(6, 12).map(session => `fixture/${session.id}`), "fixture/01"]);
    assert.equal(h.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey, "fixture/01");
    assert.equal(h.fixture.writes, 0);
  } finally { await h.close(); }
});


test("Auto focused grid and IN GRID use the active filtered session list", async () => {
  const h = await mount(true);
  try {
    await h.filterReviewers();
    await h.open(7);
    assert.deepEqual(await h.gridMembers(), sessions.slice(6, 12).map(session => session.title));
    assert.deepEqual(h.keys(), sessions.slice(6, 12).map(session => `fixture/${session.id}`));
    assert.equal(h.fixture.writes, 0);
  } finally { await h.close(); }
});
