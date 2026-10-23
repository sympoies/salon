import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

const harness = createUiSsrHarness();
after(() => harness.close());

for (const dismissal of ["scrim", "controlled", "Escape", "outside focus"] as const) {
  test(`More menu ${dismissal} dismissal preserves the focus destination`, async () => {
    const { HeaderMenu } = await harness.loadModule<typeof import("../src/HeaderMenu.tsx")>("/src/HeaderMenu.tsx");
    const window = new Window({ url: "http://localhost" });
    const keys = ["window", "document", "Element", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
    const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
    Object.assign(globalThis, { window, document: window.document, Element: window.Element,
      HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    let dismiss = () => {};
    function Probe() {
      const [open, setOpen] = useState(false);
      dismiss = () => setOpen(false); // Same controlled close used by Android Back.
      return createElement(HeaderMenu, { open, onOpenChange: setOpen, historyAvailable: false,
        onHistory() {}, onUsage() {}, onDebug() {}, onSettings() {} });
    }
    try {
      await act(async () => root.render(createElement(Probe)));
      const trigger = container.querySelector<HTMLElement>(".header-menu-trigger");
      assert.ok(trigger);
      await act(async () => trigger.click());
      await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); });
      const item = container.querySelector<HTMLElement>('[role="menuitem"]');
      assert.ok(item);
      assert.equal(window.document.activeElement === item, true, "menu takes initial focus");
      const outside = window.document.createElement("button");
      window.document.body.append(outside);
      await act(async () => {
        if (dismissal === "scrim") {
          const scrim = container.querySelector<HTMLElement>(".header-menu-scrim");
          assert.ok(scrim);
          scrim.focus(); // Pointer focus precedes its click in a browser.
          scrim.click();
        } else if (dismissal === "Escape") {
          item.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        } else {
          if (dismissal === "outside focus") outside.focus();
          dismiss();
        }
      });
      assert.equal(container.querySelector("details")?.hasAttribute("open"), false, "menu closes");
      assert.equal(window.document.activeElement === (dismissal === "outside focus" ? outside : trigger), true,
        "dismissal returns to More unless focus moved outside");
    } finally {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous);
      await window.happyDOM.close();
    }
  });
}
