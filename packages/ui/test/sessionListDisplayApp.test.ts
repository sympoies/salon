import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";

declare global { var __agentConsoleDisplayPrincipal: string | undefined; }

const fixture: Plugin = {
  name: "display-app-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id === "./Dashboard.tsx") return "\0display-dashboard";
    if (id === "./ShellPage.tsx") return "\0display-shell";
  },
  load(id) {
    if (id === "\0display-shell") return "export function ShellPage() { return null; }";
    if (id === "\0display-dashboard") return `
      import React from "react";
      export function Dashboard({sessionListDisplay,phoneSessionOpen,phoneFocusCounts,onSettings}) {
        return React.createElement("div",{"data-display-mode":sessionListDisplay,"data-phone-mode":phoneSessionOpen,"data-phone-focus-counts":String(phoneFocusCounts)},
          React.createElement("button",{onClick:onSettings,"aria-label":"Open Settings"},"Settings"));
      }
    `;
  },
  transform(code, id) {
    if (!id.endsWith("/src/api.ts")) return;
    return code.replace("export async function getAuthStatus(", "export async function fixtureOriginalGetAuthStatus(")
      .replace("export async function listMachineNames(", "export async function fixtureOriginalListMachineNames(") + `
      export const getAuthStatus = async () => ({authenticated:true,openAccess:true,
        principal:{id:globalThis.__agentConsoleDisplayPrincipal,permissions:[]}});
      export const listMachineNames = async () => [];
    `;
  },
};

test("App saves the Settings choice, restores it on remount and reloads the new principal default", { timeout: 15_000 }, async () => {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window, document: globalThis.document, Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, Event: window.Event, MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness([fixture]);
  const storage = await ssr.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
  storage.setPrincipalStorageNamespace(null);
  globalThis.__agentConsoleDisplayPrincipal = "viewer-one";
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    assert.fail("App preference fixture did not settle");
  };
  const mode = () => container.querySelector("[data-display-mode]")?.getAttribute("data-display-mode");
  try {
    const { default: App } = await ssr.loadModule<typeof import("../src/App.tsx")>("/src/App.tsx");
    const mount = async () => {
      await act(async () => root.render(createElement(App)));
      await waitFor(() => mode() !== undefined);
    };
    await mount();
    assert.equal(mode(), "terminal");
    assert.equal(container.querySelector("[data-phone-mode]")?.getAttribute("data-phone-mode"), "conversation");
    const open = container.querySelector<HTMLButtonElement>('[aria-label="Open Settings"]');
    assert.ok(open);
    await act(async () => open.click());
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Session list display"]');
    assert.ok(select);
    select.value = "conversation";
    await act(async () => select.dispatchEvent(new window.Event("change", { bubbles: true })));
    assert.equal(mode(), "conversation", "the real App passes the saved mode to Dashboard");
    assert.equal(window.localStorage.getItem("agent-console.principal.viewer-one.ac.sessionListDisplay"), "conversation");
    await act(async () => root.render(null));
    await mount();
    assert.equal(mode(), "conversation", "a remounted App restores the saved preference");
    Object.defineProperty(window, "innerWidth", {configurable:true,value:412});
    await act(async()=>window.dispatchEvent(new window.Event("resize")));
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Open Settings"]')!.click());
    const phoneSelect=container.querySelector<HTMLSelectElement>('[aria-label="Open session as"]');assert.ok(phoneSelect);
    assert.equal(phoneSelect.value,"conversation");phoneSelect.value="terminal";
    await act(async()=>phoneSelect.dispatchEvent(new window.Event("change",{bubbles:true})));
    assert.equal(mode(),"conversation","phone preference does not change desktop tiles");
    assert.equal(window.localStorage.getItem("agent-console.principal.viewer-one.ac.phoneSessionOpen"),"terminal");
    await act(async()=>root.render(null));await mount();
    assert.equal(container.querySelector("[data-phone-mode]")?.getAttribute("data-phone-mode"),"terminal");

    await act(async () => root.render(null));
    globalThis.__agentConsoleDisplayPrincipal = "viewer-two";
    await mount();
    assert.equal(mode(), "terminal", "sign-in reload uses the new principal namespace");
    assert.equal(container.querySelector("[data-phone-mode]")?.getAttribute("data-phone-mode"),"conversation","phone default reloads per principal");
  } finally {
    await act(async () => root.unmount());
    storage.setPrincipalStorageNamespace(null);
    await ssr.close();
    delete globalThis.__agentConsoleDisplayPrincipal;
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});

test("a phone hides its single-session count row from Settings, per device and across reloads (#938)", { timeout: 15_000 }, async () => {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window, document: globalThis.document, Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement, Event: globalThis.Event, MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, Event: window.Event, MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness([fixture]);
  const storage = await ssr.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
  storage.setPrincipalStorageNamespace(null);
  globalThis.__agentConsoleDisplayPrincipal = "viewer-one";
  const shown = () => container.querySelector("[data-phone-focus-counts]")?.getAttribute("data-phone-focus-counts");
  const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Single-session count row"]');
  try {
    const { default: App } = await ssr.loadModule<typeof import("../src/App.tsx")>("/src/App.tsx");
    const mount = async () => {
      await act(async () => root.render(createElement(App)));
      for (let attempt = 0; attempt < 200 && shown() === undefined; attempt++) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      }
    };
    await mount();
    assert.equal(shown(), "true", "the row is shown by default");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Settings"]')!.click());
    assert.equal(toggle(), null, "desktop Settings has no phone row switch");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 412 });
    await act(async () => window.dispatchEvent(new window.Event("resize")));
    assert.ok(toggle(), "phone Settings offers the switch");
    assert.equal(toggle()!.getAttribute("aria-checked"), "true");
    await act(async () => toggle()!.click());
    assert.equal(shown(), "false");
    assert.equal(window.localStorage.getItem("agent-console.principal.viewer-one.ac.phoneFocusCounts"), "0");
    await act(async () => root.render(null));
    await mount();
    assert.equal(shown(), "false", "a reload keeps the row hidden");
  } finally {
    await act(async () => root.unmount());
    storage.setPrincipalStorageNamespace(null);
    await ssr.close();
    delete globalThis.__agentConsoleDisplayPrincipal;
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});
