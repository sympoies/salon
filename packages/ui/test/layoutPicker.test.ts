import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

test("compact layout offers all six layouts, selects, restores focus and dismisses", async () => {
  const window = new Window({ url: "http://localhost" });
  const keys = ["window", "document", "navigator", "HTMLElement", "Element", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true };
  keys.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: globals[key as keyof typeof globals] }));
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container), harness = createUiSsrHarness();
  try {
    const { LayoutPicker } = await harness.loadModule<typeof import("../src/LayoutPicker.tsx")>("/src/LayoutPicker.tsx");
    let selection = 0, toggles = 0;
    function Host() {
      const [mode, setMode] = useState<1 | 2 | 3 | 4 | 5 | 6>(2);
      return createElement(LayoutPicker, { auto: false, mode, displayedMode: mode, onToggleAuto() { toggles++; }, onSelect(value) { selection = value; setMode(value); } });
    }
    await act(async () => root.render(createElement(Host)));
    const trigger = container.querySelector<HTMLButtonElement>(".layout-picker-trigger")!;
    await act(async () => trigger.click());
    const options = container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    assert.equal(options.length, 6);
    assert.equal(options[1]!.getAttribute("aria-checked"), "true");
    await act(async () => options[5]!.click());
    assert.equal(selection, 6); assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(window.document.activeElement === trigger, true);
    assert.ok(trigger.getAttribute("aria-label")?.includes("6 panes"));
    await act(async () => trigger.click());
    await act(async () => container.querySelector('[role="menu"]')!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Auto layout"]')!.click());
    assert.equal(toggles, 1);
    await act(async () => trigger.click());
    await act(async () => window.dispatchEvent(new window.Event("resize")));
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await act(async () => root.render(createElement(LayoutPicker, { auto: true, mode: 1, displayedMode: 4, onToggleAuto() {}, onSelect() {} })));
    await act(async () => container.querySelector<HTMLButtonElement>(".layout-picker-trigger")!.click());
    assert.equal(container.querySelectorAll('[role="menuitemradio"][aria-checked="true"]').length, 1);
    assert.equal(container.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent, "4 panes", "Auto highlights the same resolved layout as its current icon");
  } finally {
    await act(async () => root.unmount()); await harness.close(); await window.happyDOM.close();
    keys.forEach((key, index) => previous[index] ? Object.defineProperty(globalThis, key, previous[index]!) : Reflect.deleteProperty(globalThis, key));
  }
});
