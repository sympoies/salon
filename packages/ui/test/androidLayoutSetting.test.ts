import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { loadAndroidLayout, saveAndroidLayout } from "../src/androidLayout.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

// #238: the Android app picks its session layout per device in Settings.
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("the stored Android layout defaults to the phone list and keeps a saved layout", () => {
  const storage = memoryStorage();
  assert.equal(loadAndroidLayout(storage), "list");
  assert.equal(saveAndroidLayout(4, storage), true);
  assert.equal(loadAndroidLayout(storage), 4);
  assert.equal(saveAndroidLayout("list", storage), true);
  assert.equal(loadAndroidLayout(storage), "list");
  assert.equal(loadAndroidLayout(memoryStorage({ "ac.androidLayout": "9" })), "list", "an unknown value falls back to the list");
});

async function settingsSelect(android: boolean, androidLayout: "list" | 3) {
  const window = new Window({ url: "http://localhost", settings: android ? { navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36" } } : {} });
  if (android) Object.assign(window, { __TAURI_INTERNALS__: {} });
  const names = ["window", "document", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "MouseEvent", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLSelectElement: window.HTMLSelectElement, Event: window.Event, MouseEvent: window.MouseEvent, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container); const ssr = createUiSsrHarness();
  const chosen: unknown[] = [];
  try {
    const { Settings } = await ssr.loadModule<typeof import("../src/Settings.tsx")>("/src/Settings.tsx");
    await act(async () => root.render(createElement(Settings, {
      variant: "manage", machines: [], machineColors: {}, defaultAutoResume: false, attentionAlerts: false,
      terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true, androidLayout, onAndroidLayoutChange: layout => chosen.push(layout),
      onMachineColorChange() {}, onMachineColorReset() {}, onDefaultAutoResumeChange() {}, onAttentionAlertsChange() {},
      onTerminalRenderModeChange() {}, onTerminalSelectedPaneRealtimeChange() {}, openAccess: false, onSignedOut() {},
    })));
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Session layout"]');
    const options = select ? [...select.options].map(option => option.value) : null;
    const value = select?.value ?? null;
    if (select) {
      select.value = "2";
      await act(async () => { select.dispatchEvent(new window.Event("change", { bubbles: true })); });
      select.value = "list";
      await act(async () => { select.dispatchEvent(new window.Event("change", { bubbles: true })); });
    }
    return { options, value, chosen };
  } finally {
    await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, previous); await window.happyDOM.close();
  }
}

test("the Android Settings offer the phone list and the fixed layouts, and report the choice", async () => {
  const result = await settingsSelect(true, 3);
  assert.deepEqual(result.options, ["list", "1", "2", "3", "4", "5", "6"]);
  assert.equal(result.value, "3");
  assert.deepEqual(result.chosen, [2, "list"]);
});

test("a browser's Settings have no Session layout choice", async () => {
  const result = await settingsSelect(false, "list");
  assert.equal(result.options, null);
});
