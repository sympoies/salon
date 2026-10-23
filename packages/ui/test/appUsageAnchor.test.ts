import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";

declare global { var __agentConsoleUsageAnchorLeft: number | undefined; }

const fixture: Plugin = {
  name: "usage-anchor-app-boundaries",
  enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id === "./Dashboard.tsx") return "\0usage-anchor-dashboard";
    if (id === "./UsagePanel.tsx") return "\0usage-anchor-panel";
    if (id === "./ShellPage.tsx") return "\0usage-anchor-shell";
  },
  load(id) {
    if (id === "\0usage-anchor-shell") return "export function ShellPage() { return null; }";
    if (id === "\0usage-anchor-dashboard") return `
      import React from "react";
      export function Dashboard({ onUsage }) {
        return React.createElement("button", {
          className: "header-usage",
          "aria-label": "Open usage",
          onClick: event => onUsage(event.currentTarget),
          get style() { return { left: globalThis.__agentConsoleUsageAnchorLeft + "px" }; },
        }, "Usage");
      }
    `;
    if (id === "\0usage-anchor-panel") return `
      import React from "react";
      export function UsagePanel() { return React.createElement("div", { className: "usage-panel" }, "Usage details"); }
    `;
  },
  transform(code, id) {
    if (!id.endsWith("/src/api.ts")) return;
    return code.replace("export async function getAuthStatus(", "export async function fixtureOriginalGetAuthStatus(")
      .replace("export async function listMachineNames(", "export async function fixtureOriginalListMachineNames(") + `
      export const getAuthStatus = async () => ({authenticated:true,openAccess:true,
        principal:{id:"usage-viewer",permissions:["usage"]}});
      export const listMachineNames = async () => [];
    `;
  },
};

test("App remeasures the Usage anchor when Dashboard moves it without resizing", { timeout: 15_000 }, async () => {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    MutationObserver: globalThis.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const ssr = createUiSsrHarness([fixture]);
  globalThis.__agentConsoleUsageAnchorLeft = 150;
  try {
    const { default: App } = await ssr.loadModule<typeof import("../src/App.tsx")>("/src/App.tsx");
    await act(async () => root.render(createElement(App)));
    const anchor = container.querySelector<HTMLButtonElement>(".header-usage");
    assert.ok(anchor);
    Object.defineProperty(anchor, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: globalThis.__agentConsoleUsageAnchorLeft!,
        left: globalThis.__agentConsoleUsageAnchorLeft!,
        right: globalThis.__agentConsoleUsageAnchorLeft! + 120,
        top: 20,
        bottom: 44,
        y: 20,
        width: 120,
        height: 24,
        toJSON: () => ({}),
      }),
    });
    await act(async () => anchor.click());
    const panel = container.querySelector<HTMLElement>(".modal.usage-anchored");
    assert.ok(panel, "the real App and Modal render the anchored Usage panel");
    assert.equal(panel.style.getPropertyValue("--usage-anchor-center"), "210px");

    globalThis.__agentConsoleUsageAnchorLeft = 210;
    await act(async () => {
      anchor.style.left = "210px";
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    assert.equal(
      panel.style.getPropertyValue("--usage-anchor-center"),
      "270px",
      "position-only movement updates the anchor even though its size is unchanged",
    );
  } finally {
    await act(async () => root.unmount());
    await ssr.close();
    delete globalThis.__agentConsoleUsageAnchorLeft;
    Object.assign(globalThis, previous);
    await window.happyDOM.close();
  }
});
