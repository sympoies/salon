import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Plugin } from "vite";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

for (const [host, appName] of [["mac", undefined], ["mac", "Agent Console Test"], ["browser", undefined], ["android", undefined]] as const) {
  test(`the actual entry reserves themed title chrome only for macOS (${host}, ${appName ?? "default"})`, async () => {
    const window = new Window({ url: "http://localhost" });
    Object.defineProperty(window.navigator, "userAgent", { value: host === "android" ? "Android" : "Macintosh" });
    if (host !== "browser") Object.assign(window, { __TAURI_INTERNALS__: {} });
    const keys = ["window", "document", "navigator", "HTMLElement", "Element", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "__titleBarCreateRoot"];
    const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    let mounted: Root | undefined;
    const globals: Record<string, unknown> = { window, document: window.document, navigator: window.navigator,
      HTMLElement: window.HTMLElement, Element: window.Element, localStorage: window.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
      __titleBarCreateRoot: (container: HTMLElement) => (mounted = createRoot(container)) };
    keys.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: globals[key] }));
    const container = window.document.createElement("div"); container.id = "root"; window.document.body.append(container);
    const boundary: Plugin = { name: "titlebar-entry-app-boundary", enforce: "pre",
      resolveId(source, importer) {
        if (!/\/(main|mountApp)\.tsx$/.test(importer ?? "")) return;
        if (source === "./App") return "\0titlebar-app";
        if (source === "react-dom/client") return "\0titlebar-root";
      },
      load(id) {
        if (id === "\0titlebar-app") return 'import React from "react";import { BrandTitle } from "/src/BrandTitle.tsx";export default function App(){return React.createElement("main",{className:"dash"},React.createElement(BrandTitle));}';
        if (id === "\0titlebar-root") return 'export const createRoot=(...args)=>globalThis.__titleBarCreateRoot(...args);';
      },
    };
    const harness = createUiSsrHarness([boundary]);
    try {
      await act(async () => { const { mountApp } = await harness.loadModule<typeof import("../src/mountApp.tsx")>("/src/mountApp.tsx"); mountApp(container, appName === undefined ? {} : { appName }); });
      assert.equal(container.querySelector("main h1")?.textContent, appName ?? "Agent Console");
      if (appName !== undefined) assert.equal(window.document.title, appName);
      if (host === "mac") {
        const bar = container.querySelector(".mac-titlebar");
        assert.ok(bar, "macOS must render title chrome rather than the system-gray centered title");
        assert.equal(bar.textContent, appName ?? "Agent Console");
        assert.equal(bar.getAttribute("data-tauri-drag-region"), "");
        assert.equal(bar.querySelector("span")?.getAttribute("data-tauri-drag-region"), "");
        assert.equal(window.document.documentElement.dataset.macTitlebar, "true");
        assert.equal(bar.querySelectorAll("button, input, a, [tabindex]").length, 0, "retain native controls rather than replacing them");
      } else {
        assertNoElement(container, ".mac-titlebar");
        assert.equal(window.document.documentElement.dataset.macTitlebar, undefined);
      }
    } finally {
      await act(async () => mounted?.unmount());
      await harness.close(); await window.happyDOM.close();
      keys.forEach((key, index) => previous[index] ? Object.defineProperty(globalThis, key, previous[index]!) : Reflect.deleteProperty(globalThis, key));
    }
  });
}
