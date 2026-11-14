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
    assert.equal(trigger.getAttribute("aria-label"), "Choose layout, currently 2 panes");
    assert.equal(trigger.textContent?.trim(), "Choose layout, currently 2 panes");
    await act(async () => trigger.click());
    const all = container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    assert.equal(all.length, 7);
    assert.equal(all[0]!.textContent, "Auto", "the menu lists Auto first, as the inline control does at wide widths");
    assert.equal(all[0]!.getAttribute("aria-checked"), "false");
    const options = [...all].slice(1);
    assert.equal(options[1]!.getAttribute("aria-checked"), "true");
    await act(async () => options[5]!.click());
    assert.equal(selection, 6); assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(window.document.activeElement === trigger, true);
    assert.equal(trigger.getAttribute("aria-label"), "Choose layout, currently 6 panes");
    assert.equal(trigger.textContent?.trim(), "Choose layout, currently 6 panes", "name text follows layout changes");
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
    assert.equal(container.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent, "Auto", "while Auto is on, the menu shows Auto as the choice");
    assert.ok(container.querySelector(".layout-picker-trigger")!.getAttribute("aria-label")?.includes("Auto, 4 panes"), "the trigger still shows the resolved layout");
  } finally {
    await act(async () => root.unmount()); await harness.close(); await window.happyDOM.close();
    keys.forEach((key, index) => previous[index] ? Object.defineProperty(globalThis, key, previous[index]!) : Reflect.deleteProperty(globalThis, key));
  }
});

test("the compact menu applies Auto and a pane count turns it off", async () => {
  const window = new Window({ url: "http://localhost" });
  const keys = ["window", "document", "navigator", "HTMLElement", "Element", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true };
  keys.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: globals[key as keyof typeof globals] }));
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container), harness = createUiSsrHarness();
  try {
    const { LayoutPicker } = await harness.loadModule<typeof import("../src/LayoutPicker.tsx")>("/src/LayoutPicker.tsx");
    function Host() {
      const [auto, setAuto] = useState(false);
      const [mode, setMode] = useState<1 | 2 | 3 | 4 | 5 | 6>(3);
      return createElement(LayoutPicker, { auto, mode, displayedMode: auto ? 2 : mode,
        onToggleAuto() { setAuto(value => !value); }, onSelect(value) { setAuto(false); setMode(value); } });
    }
    await act(async () => root.render(createElement(Host)));
    const trigger = container.querySelector<HTMLButtonElement>(".layout-picker-trigger")!;
    const item = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(node => node.textContent === name)!;
    await act(async () => trigger.click());
    await act(async () => item("Auto").click());
    assert.ok(trigger.getAttribute("aria-label")?.includes("Auto, 2 panes"));
    await act(async () => trigger.click());
    assert.equal(item("Auto").getAttribute("aria-checked"), "true");
    await act(async () => item("Auto").click());
    assert.ok(trigger.getAttribute("aria-label")?.includes("Auto, 2 panes"), "choosing Auto again keeps it on");
    await act(async () => trigger.click());
    await act(async () => item("5 panes").click());
    assert.ok(!trigger.getAttribute("aria-label")?.includes("Auto"));
    assert.ok(trigger.getAttribute("aria-label")?.includes("5 panes"));
  } finally {
    await act(async () => root.unmount()); await harness.close(); await window.happyDOM.close();
    keys.forEach((key, index) => previous[index] ? Object.defineProperty(globalThis, key, previous[index]!) : Reflect.deleteProperty(globalThis, key));
  }
});
