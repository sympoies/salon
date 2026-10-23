import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { jsonResponse, restoreFetch, setFetchMock } from "./fetchHelper.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

test("performance capture survives closing Debug and copies only aggregate JSON", async () => {
  const { DebugPanel } = await ssr.loadModule<typeof import("../src/DebugPanel.tsx")>("/src/DebugPanel.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, MouseEvent: window.MouseEvent,
    Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true,
  });
  let copied = "";
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true, value: { writeText: async (value: string) => { copied = value; } },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  setFetchMock(async () => jsonResponse({ ok: true, data: { events: [], max_events: 1000 } }));
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
    assert.ok(button, `button ${label}`);
    await act(async () => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  };
  try {
    await act(async () => root.render(createElement(DebugPanel, { onExit: () => {} })));
    await click("Start Capture");
    assert.match(container.textContent, /Copy Summary JSON/);
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(DebugPanel, { onExit: () => {} })));
    assert.match(container.textContent, /Copy Summary JSON/);
    await click("Copy Summary JSON");
    const summary = JSON.parse(copied) as {
      kind: string; app: { surface: string }; http: { session_list: { requests: number } };
    };
    assert.equal(summary.kind, "agent-console.performance-summary.v1");
    assert.equal(summary.http.session_list.requests, 0);
    assert.equal(JSON.stringify(summary).includes("localhost"), false);
    await click("Stop");
    assert.match(container.textContent, /Start Capture/);
  } finally {
    await act(async () => root.unmount());
    restoreFetch();
    Object.assign(globalThis, {
      window: previous.window, document: previous.document, Element: previous.Element,
      HTMLElement: previous.HTMLElement, MouseEvent: previous.MouseEvent,
      Event: previous.Event, IS_REACT_ACT_ENVIRONMENT: previous.IS_REACT_ACT_ENVIRONMENT,
    });
    if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
