import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

const legacyKey = "ac.enabledMachines.optIn";
const markerKey = "ac.machinePreferences.migrationSeen";
const snapshot = (enabled = true) => ({ ok: true, machines: [
  { name: "fixture-host", enabled, active: enabled, last_change: null },
] });
interface FixtureApi {
  list(): Promise<unknown>;
  write(...args: unknown[]): Promise<unknown>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(api: FixtureApi) {
  const globals = globalThis as typeof globalThis & { __hostPreferenceLifecycleApi?: FixtureApi };
  const window = new Window({ url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document,
    Element: globalThis.Element, HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event, MouseEvent: globalThis.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, Event: window.Event, MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true });
  globals.__hostPreferenceLifecycleApi = api;
  const harness = createUiSsrHarness([{
    name: "host-preference-lifecycle-api",
    transform(code, id) {
      if (!id.endsWith("/src/api.ts")) return;
      return code.replace("export async function listMachinePreferences(", "export async function originalListMachinePreferences(")
        .replace("export async function updateMachinePreference(", "export async function originalUpdateMachinePreference(")
        .replace("export async function listSessions(", "export async function originalListSessions(") + `
        export const listMachinePreferences = () => globalThis.__hostPreferenceLifecycleApi.list();
        export const updateMachinePreference = (...args) => globalThis.__hostPreferenceLifecycleApi.write(...args);
        export const listSessions = async () => ({ok:true,sessions:[],machines:[{name:"fixture-host",ok:true}]});
      `;
    },
  }]);
  const storage = await harness.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
  storage.setPrincipalStorageNamespace(null);
  const { HostPreferencesSettings } = await harness.loadModule<{
    HostPreferencesSettings: ComponentType<{ machines: readonly string[]; onMigrationDone?: () => void }>;
  }>("/src/HostPreferencesSettings.tsx");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  return { window, container, storage,
    async mount(machines: readonly string[], onMigrationDone?: () => void) {
      await act(async () => root.render(createElement(HostPreferencesSettings, { machines, onMigrationDone })));
    },
    async unmount() { await act(async () => root.render(null)); },
    async clickImport() {
      const button = [...container.querySelectorAll("button")]
        .find(row => row.textContent === "Import device preference");
      assert.equal(Boolean(button), true, "the legacy choice is available after an authoritative snapshot");
      await act(async () => button?.click());
    },
    async close() {
      await act(async () => root.unmount());
      storage.setPrincipalStorageNamespace(null);
      await harness.close();
      delete globals.__hostPreferenceLifecycleApi;
      Object.assign(globalThis, previous);
      await window.happyDOM.close();
    },
  };
}

for (const succeeds of [true, false]) test(`legacy import uses granted preferences when discovery is empty (${succeeds ? "success" : "failure"})`, async () => {
  const writes: unknown[][] = [];
  const mounted = await fixture({ list: async () => snapshot(), write: async (...args) => {
    writes.push(args); return { ok: succeeds };
  } });
  try {
    mounted.window.localStorage.setItem(legacyKey, '["fixture-host"]');
    await mounted.mount([]);
    await mounted.clickImport();
    assert.equal(writes.length, 1, "discovery failure cannot silently acknowledge an unwritten import");
    assert.equal(writes[0]?.[0], "fixture-host");
    assert.equal(writes[0]?.[1], true);
    assert.equal(mounted.window.localStorage.getItem(legacyKey), succeeds ? null : '["fixture-host"]');
  } finally { await mounted.close(); }
});

test("successful slow polling progresses without overlapping refresh generations", async () => {
  const requests: Array<ReturnType<typeof deferred<unknown>>> = [];
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const handle = {} as ReturnType<typeof setInterval>;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay === 4000) { tick = callback; return handle; }
    return Reflect.apply(originalSet, globalThis, [callback, delay, ...args]);
  }) as typeof setInterval;
  globalThis.clearInterval = ((value: ReturnType<typeof setInterval>) => {
    if (value !== handle) originalClear(value);
  }) as typeof clearInterval;
  const mounted = await fixture({ list: () => {
    const request = deferred<unknown>(); requests.push(request); return request.promise;
  }, write: async () => ({ ok: true }) });
  try {
    await mounted.mount(["fixture-host"]);
    assert.equal(requests.length, 1);
    assert.equal(typeof tick, "function");
    await act(async () => { tick?.(); tick?.(); });
    await act(async () => requests[0]?.resolve(snapshot()));
    assert.equal(Boolean(mounted.container.querySelector('[aria-label="Disable fixture-host"]')), true,
      "the successful request must render even after more than one poll interval");
    assert.equal(requests.length, 1, "ticks do not supersede an in-flight snapshot");
    await act(async () => tick?.());
    assert.equal(requests.length, 2, "polling continues after completion");
    await act(async () => requests[1]?.resolve(snapshot(false)));
    assert.equal(Boolean(mounted.container.querySelector('[aria-label="Enable fixture-host"]')), true);
  } finally {
    await act(async () => { for (const request of requests) request.resolve(snapshot()); });
    await mounted.close();
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
});

for (const unmount of [true, false]) test(`migration completion preserves another principal after ${unmount ? "unmount" : "namespace change"}`, async () => {
  const pending = deferred<unknown>();
  let completed = 0;
  const mounted = await fixture({ list: async () => snapshot(), write: () => pending.promise });
  const aKey = `agent-console.principal.fixture-a.${legacyKey}`;
  const bKey = `agent-console.principal.fixture-b.${legacyKey}`;
  const bMarker = `agent-console.principal.fixture-b.${markerKey}`;
  try {
    mounted.storage.setPrincipalStorageNamespace("fixture-a");
    mounted.window.localStorage.setItem(aKey, '["fixture-host"]');
    mounted.window.localStorage.setItem(bKey, '["fixture-other"]');
    await mounted.mount(["fixture-host"], () => { completed++; });
    await mounted.clickImport();
    if (unmount) await mounted.unmount();
    mounted.storage.setPrincipalStorageNamespace("fixture-b");
    await act(async () => pending.resolve({ ok: true }));
    assert.equal(mounted.window.localStorage.getItem(bKey), '["fixture-other"]');
    assert.equal(mounted.window.localStorage.getItem(bMarker), null);
    assert.equal(mounted.window.localStorage.getItem(aKey), '["fixture-host"]', "stale completion retains initiating intent for retry");
    assert.equal(completed, 0, "stale completion cannot dismiss a new account's migration notice");
  } finally {
    await act(async () => pending.resolve({ ok: true }));
    await mounted.close();
  }
});

test("migration completion acknowledges its initiating account while still mounted", async () => {
  const pending = deferred<unknown>();
  let completed = 0;
  const mounted = await fixture({ list: async () => snapshot(), write: () => pending.promise });
  const key = `agent-console.principal.fixture-a.${legacyKey}`;
  try {
    mounted.storage.setPrincipalStorageNamespace("fixture-a");
    mounted.window.localStorage.setItem(key, '["fixture-host"]');
    await mounted.mount(["fixture-host"], () => { completed++; });
    await mounted.clickImport();
    await act(async () => pending.resolve({ ok: true }));
    assert.equal(mounted.window.localStorage.getItem(key), null);
    assert.equal(completed, 1);
  } finally {
    await act(async () => pending.resolve({ ok: true }));
    await mounted.close();
  }
});

// #1003: a refused change says why, instead of only "Try again".
test("#1003 a refused host preference change names the cause", async () => {
  const mounted = await fixture({ list: async () => snapshot(), write: async () => ({ ok: false, error: "cross-origin request refused" }) });
  try {
    mounted.storage.setPrincipalStorageNamespace("principal-a");
    mounted.window.localStorage.setItem(markerKey, "1");
    await mounted.mount(["fixture-host"]);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const toggle = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Disable fixture-host"]');
    assert.ok(toggle, "the host can be disabled");
    await act(async () => toggle.click());
    const input = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Host preference reason"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(mounted.window.HTMLInputElement.prototype, "value")!.set!.call(input, "Retired hardware");
      input.dispatchEvent(new mounted.window.Event("input", { bubbles: true }) as unknown as Event);
    });
    const apply = [...mounted.container.querySelectorAll("button")].find(row => row.textContent === "Apply to all devices")!;
    await act(async () => { apply.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.match(mounted.container.querySelector('[role="alert"]')?.textContent ?? "", /cross-origin request refused/);
  } finally { await mounted.close(); }
});
