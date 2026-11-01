import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";

const fixture: Plugin = {
  name: "shell-toggle-boundaries",
  enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id === "./Dashboard.tsx") return "\0shell-toggle-dashboard";
    if (id === "./ShellPage.tsx") return "\0shell-toggle-page";
  },
  load(id) {
    if (id === "\0shell-toggle-dashboard") return `export function Dashboard() { return null; }`;
    if (id === "\0shell-toggle-page") return `
      import React from "react";
      export function ShellPage() { return React.createElement("input", { className: "shell-fixture-input" }); }
    `;
  },
  transform(code, id) {
    if (id.endsWith("/src/runtime.ts")) {
      return code.replace("export function needsDeviceConfig(", "export function fixtureOriginalNeedsDeviceConfig(") + "\nexport const needsDeviceConfig = () => false;\n";
    }
    if (!id.endsWith("/src/api.ts")) return;
    return code.replace("export async function getAuthStatus(", "export async function fixtureOriginalGetAuthStatus(")
      .replace("export async function listMachineNames(", "export async function fixtureOriginalListMachineNames(") + `
      export const getAuthStatus = async () => ({authenticated:true,openAccess:true,principal:{id:"viewer",permissions:[]}});
      export const listMachineNames = async () => [];
    `;
  },
};

for (const macApp of [true, false]) test(`Command-Shift-S opens the Shell and ${macApp ? "closes it again from its input in the macOS app" : "leaves it open in the browser"}`, { timeout: 15_000 }, async () => {
  const window = new Window({ url: "http://localhost" });
  if (macApp) Object.assign(window, { __TAURI_INTERNALS__: {} });
  const names = ["window", "document", "Element", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, {
    window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event,
    MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness([fixture]);
  const input = () => container.querySelector<HTMLElement>(".shell-fixture-input");
  const press = (target: EventTarget) => act(async () => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "S", code: "KeyS", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }) as unknown as Event);
  });
  try {
    const { default: App } = await ssr.loadModule<typeof import("../src/App.tsx")>("/src/App.tsx");
    await act(async () => root.render(createElement(App)));
    for (let attempt = 0; attempt < 100 && !container.querySelector(".app-shell"); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    await press(window.document.body);
    assert.ok(input(), "the first press did not open the Shell");
    await press(input()!);
    assert.ok((input() === null) === macApp, "the second press did the wrong thing for this platform");
  } finally {
    await act(async () => root.unmount());
    await ssr.close();
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});
