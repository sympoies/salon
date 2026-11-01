import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { loadAndroidLayout, saveAndroidLayout } from "../src/androidLayout.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

// #252: the Android app picks Mobile or Desktop per device in Settings.
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("the stored Android layout defaults to Mobile, persists the choice, and the first Desktop entry uses Auto", () => {
  const storage = memoryStorage();
  assert.equal(loadAndroidLayout(storage), "mobile");
  assert.equal(saveAndroidLayout("desktop", storage), true);
  assert.equal(loadAndroidLayout(storage), "desktop");
  assert.equal(storage.getItem("agent-console.layout.auto"), "1", "the first Desktop entry follows the session count");
  storage.setItem("agent-console.layout.auto", "0");
  assert.equal(saveAndroidLayout("mobile", storage), true);
  assert.equal(saveAndroidLayout("desktop", storage), true);
  assert.equal(storage.getItem("agent-console.layout.auto"), "0", "a later Desktop entry keeps the remembered setting");
  assert.equal(loadAndroidLayout(memoryStorage({ "ac.androidLayoutChoice": "tablet" })), "mobile", "an unknown value is Mobile");
});

test("a stored #238 layout of 1 to 6 becomes Desktop with that count and Auto off; anything else becomes Mobile; the old key is removed", () => {
  for (const count of ["1", "4", "6"]) {
    const storage = memoryStorage({ "ac.androidLayout": count });
    assert.equal(loadAndroidLayout(storage), "desktop");
    assert.equal(storage.getItem("agent-console.layout.mode"), count);
    assert.equal(storage.getItem("agent-console.layout.auto"), "0");
    assert.equal(storage.getItem("ac.androidLayout"), null);
    assert.equal(loadAndroidLayout(storage), "desktop", "the migrated choice persists");
  }
  for (const other of ["list", "9", "0", "auto", ""]) {
    const storage = memoryStorage({ "ac.androidLayout": other });
    assert.equal(loadAndroidLayout(storage), "mobile", `legacy ${JSON.stringify(other)}`);
    assert.equal(storage.getItem("ac.androidLayout"), null);
    assert.equal(storage.getItem("agent-console.layout.mode"), null, "no desktop count is invented");
  }
  const current = memoryStorage({ "ac.androidLayout": "3", "ac.androidLayoutChoice": "mobile" });
  assert.equal(loadAndroidLayout(current), "mobile", "an existing choice wins over a stale old key");
  assert.equal(current.getItem("ac.androidLayout"), null);
});

async function settingsSelect(android: boolean, androidLayout: "mobile" | "desktop") {
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
    assert.equal(container.querySelector('select[aria-label="Layout"]'), null, "no native Layout select on either runtime path");
    const trigger = [...container.querySelectorAll<HTMLButtonElement>(".select-menu button[aria-haspopup]")].find(button => button.getAttribute("aria-label")?.startsWith("Layout:"));
    let options: string[] | null = null;
    const value = trigger?.getAttribute("aria-label") ?? null;
    if (trigger) {
      await act(async () => { trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
      const items = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
      options = items.map(item => item.textContent ?? "");
      await act(async () => { items[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    }
    return { options, value, chosen };
  } finally {
    await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, previous); await window.happyDOM.close();
  }
}

test("the Android Settings offer one Layout row with exactly Mobile and Desktop, and report the choice", async () => {
  const result = await settingsSelect(true, "desktop");
  assert.deepEqual(result.options, ["Mobile (default)", "Desktop"]);
  assert.match(result.value ?? "", /Desktop/);
  assert.deepEqual(result.chosen, ["mobile"]);
});

test("a browser's Settings have no Layout choice", async () => {
  const result = await settingsSelect(false, "mobile");
  assert.equal(result.options, null);
});
