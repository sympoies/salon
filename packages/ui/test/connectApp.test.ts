import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

declare global { var __connectAppStatus: unknown; }

const fixture: Plugin = {
  name: "connect-app-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id === "./Dashboard.tsx") return "\0connect-dashboard";
    if (id === "./ShellPage.tsx") return "\0connect-shell";
  },
  load(id) {
    if (id === "\0connect-shell") return "export function ShellPage() { return null; }";
    if (id === "\0connect-dashboard") return `
      import React from "react";
      export function Dashboard() { return React.createElement("div", { "data-testid": "dashboard" }); }
    `;
  },
  transform(code, id) {
    if (!id.endsWith("/src/api.ts")) return;
    return code.replace("export async function getAuthStatus(", "export async function fixtureOriginalGetAuthStatus(")
      .replace("export async function listMachineNames(", "export async function fixtureOriginalListMachineNames(") + `
      export const getAuthStatus = async () => globalThis.__connectAppStatus;
      export const listMachineNames = async () => [];
    `;
  },
};

test("native App: a rejected Connect shows its outcome, a later successful Connect leaves onboarding", { timeout: 15_000 }, async () => {
  const window = new Window({ url: "http://localhost" });
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const previous = {
    window: globalThis.window, document: globalThis.document, Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement, Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, { window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness([fixture]);
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (condition()) return;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    assert.fail("native connect fixture did not settle");
  };
  try {
    const { default: App } = await ssr.loadModule<typeof import("../src/App.tsx")>("/src/App.tsx");
    await act(async () => root.render(createElement(App)));
    await waitFor(() => container.querySelector('[data-testid="console-sign-in"]') !== null);
    const submit = async (tokenText: string) => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setValue.call(container.querySelector('input[type="url"]'), "https://new.example.test:8791");
      setValue.call(container.querySelector('[data-testid="console-access-token"]'), tokenText);
      await act(async () => container.querySelector("form")!
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    };
    globalThis.__connectAppStatus = { authenticated: false, openAccess: false, principal: null, connectFailure: "rejected" };
    await submit("fixture-wrong-token");
    await waitFor(() => /token was rejected/i.test(container.querySelector('[role="alert"]')?.textContent ?? ""));
    assertNoElement(container, '[data-testid="dashboard"]');
    globalThis.__connectAppStatus = { authenticated: true, openAccess: false, principal: { id: "viewer", permissions: [] } };
    await submit("fixture-right-token");
    await waitFor(() => container.querySelector('[data-testid="dashboard"]') !== null);
    assertNoElement(container, '[data-testid="console-sign-in"]', "onboarding is left");
  } finally {
    await act(async () => root.unmount());
    await ssr.close();
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});
