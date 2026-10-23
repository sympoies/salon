import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

test("IconButton forwards native button/summary refs, state and events", async () => {
  const window = new Window({ url: "http://localhost" });
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const h = createUiSsrHarness();
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  try {
    const { IconButton } = await h.loadModule<typeof import("../src/IconButton.tsx")>("/src/IconButton.tsx");
    const buttonRef = createRef<HTMLButtonElement>();
    const summaryRef = createRef<HTMLElement>();
    let clicks = 0, pointers = 0, summaries = 0, prevented = false;
    const button = (disabled: boolean) => createElement(IconButton, {
      ref: buttonRef, type: "submit", preset: "compact", disabled, "aria-busy": disabled,
      "aria-label": "Move fixture", className: "role-order-handle",
      onClick(event) { clicks++; event.stopPropagation(); },
      onPointerDown() { pointers++; },
    }, "↑");
    await act(async () => root.render(createElement("div", {}, button(false), createElement("details", {},
      createElement(IconButton, { as: "summary", ref: summaryRef, "aria-label": "More fixture", "aria-expanded": false,
        onClick(event) { event.preventDefault(); prevented = event.defaultPrevented; summaries++; } }, "⋯")))));
    assert.equal(buttonRef.current?.tagName, "BUTTON");
    assert.equal(buttonRef.current?.type, "submit");
    assert.equal(buttonRef.current?.getAttribute("aria-label"), "Move fixture");
    assert.equal(summaryRef.current?.tagName, "SUMMARY");
    assert.equal(summaryRef.current?.getAttribute("aria-expanded"), "false");
    await act(async () => {
      buttonRef.current?.click();
      buttonRef.current?.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
      summaryRef.current?.click();
    });
    assert.equal(clicks, 1);
    assert.equal(pointers, 1);
    assert.equal(summaries, 1);
    assert.equal(prevented, true, "consumer can cancel native summary activation");
    await act(async () => root.render(button(true)));
    assert.equal(buttonRef.current?.disabled, true);
    assert.equal(buttonRef.current?.getAttribute("aria-busy"), "true");
    await act(async () => buttonRef.current?.click());
    assert.equal(clicks, 1, "disabled button does not invoke its action");
  } finally {
    await act(async () => root.unmount());
    await h.close();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
