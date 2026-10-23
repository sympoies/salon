import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";

const apiMock: Plugin = {
  name: "debug-panel-api-mock",
  enforce: "pre",
  resolveId(source, importer) {
    return source.endsWith("api.ts") && importer?.includes("/src/") ? "\0debug-panel-api-mock" : null;
  },
  load(id) {
    if (id !== "\0debug-panel-api-mock") return null;
    return `export const fetchEdgeDebugEvents = async () => ({ events: [], max_events: 100 });
      export const fetchSessionRetitleReceipts = async () => ({ supported: false });
      export let receivedProbes; export const runDebugDiagnostics = async probes => { receivedProbes = probes; return { ok: true, probes: [], generated_at: "2026-10-01T00:00:00Z" }; };`;
  },
};

async function flush() { await new Promise(resolve => setTimeout(resolve, 0)); }

async function installDom(): Promise<{ window: Window; root: Root; container: HTMLElement; cleanup(): Promise<void> }> {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  return {
    window,
    root,
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      Object.assign(globalThis, {
        window: previous.window,
        document: previous.document,
        Element: previous.Element,
        HTMLElement: previous.HTMLElement,
        HTMLInputElement: previous.HTMLInputElement,
        HTMLSelectElement: previous.HTMLSelectElement,
        KeyboardEvent: previous.KeyboardEvent,
        MouseEvent: previous.MouseEvent,
        Event: previous.Event,
        IS_REACT_ACT_ENVIRONMENT: previous.IS_REACT_ACT_ENVIRONMENT,
      });
      if (previous.navigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", previous.navigatorDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "navigator");
      }
      window.close();
    },
  };
}


test("Debug filters start collapsed and preserve selections and navigation", async () => {
  const mounted = await installDom();
  const ssr = createUiSsrHarness([apiMock]);
  let exits = 0;
  try {
    const { DebugPanel } = await ssr.loadModule<typeof import("../src/DebugPanel.tsx")>("/src/DebugPanel.tsx");
    await act(async () => { mounted.root.render(createElement(DebugPanel, { onExit: () => { exits += 1; } })); await flush(); });
    const toggle = mounted.container.querySelector<HTMLButtonElement>('button[aria-controls="debug-filters"]');
    assert.ok(toggle, "Debug offers a collapsible filter disclosure");
    assert.ok(mounted.container.querySelector(".debug-body .debug-events"), "Debug owns one content scroller below its filters");
    assert.equal(toggle.closest(".debug-body") === null, true);
    const region = mounted.container.querySelector<HTMLElement>("#debug-filters");
    assert.ok(region);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(region.hidden, true);
    assert.match(toggle.textContent ?? "", /All events/);
    await act(async () => toggle.click());
    assert.equal(region.hidden, false);
    const source = region.querySelector<HTMLSelectElement>('select[aria-label="Debug source"]');
    assert.ok(source);
    await act(async () => { source.value = "edge"; source.dispatchEvent(new mounted.window.Event("change", { bubbles: true })); });
    await act(async () => toggle.click());
    assert.equal(region.hidden, true);
    assert.match(toggle.textContent ?? "", /source=edge/);
    await act(async () => toggle.click());
    assert.equal(source.value, "edge", "folding preserves the selected filter");
    const clear = [...region.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Clear Filters");
    assert.ok(clear);
    await act(async () => clear.click());
    assert.equal(source.value, "all");
    const back = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Back to dashboard"]');
    assert.ok(back);
    await act(async () => back.click());
    assert.equal(exits, 1);
  } finally { await mounted.cleanup(); await ssr.close(); }
});


test("DebugPanel passes installed diagnostic probes through its registry", async () => {
  const mounted = await installDom();
  const ssr = createUiSsrHarness([apiMock]);
  try {
    const { DebugPanel } = await ssr.loadModule<typeof import("../src/DebugPanel.tsx")>("/src/DebugPanel.tsx");
    const { UiExtensionsProvider, createUiExtensionRegistry } = await ssr.loadModule<typeof import("../src/extensions.tsx")>("/src/extensions.tsx");
    const probes = [{ name: "Extra reader", route: "/api/extra-reader" }];
    const registry = createUiExtensionRegistry([{ id: "extra-reader", diagnosticProbes: probes }]);
    await act(async () => { mounted.root.render(createElement(UiExtensionsProvider, { registry }, createElement(DebugPanel, { onExit() {} }))); await flush(); });
    const run = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Run Diagnostics");
    assert.ok(run);
    await act(async () => { run.click(); await flush(); });
    const api = await ssr.loadModule<{ receivedProbes: unknown }>("\0debug-panel-api-mock");
    assert.deepEqual(api.receivedProbes, probes);
  } finally { await mounted.cleanup(); await ssr.close(); }
});
