import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness();
after(async () => ssr.close());

test("shortcut help lists voice and closes with Command-Slash or Escape", async () => {
  const { ShortcutHelpModal } = await ssr.loadModule<{
    ShortcutHelpModal: ComponentType<{ onClose: () => void }>;
  }>("/src/ShortcutHelpModal.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window, document: window.document, Element: window.Element,
    HTMLElement: window.HTMLElement, KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let closes = 0;
  try {
    await act(async () => root.render(createElement(ShortcutHelpModal, { onClose: () => { closes += 1; } })));
    const dialog = window.document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? "", /Voice prompt/);
    assert.match(dialog.textContent ?? "", /⌘I/);
    assert.match(dialog.textContent ?? "", /⌘\//);
    await act(async () => {
      dialog.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "/", code: "Slash", metaKey: true, bubbles: true, cancelable: true,
      }));
    });
    assert.equal(closes, 1);
    await act(async () => {
      dialog.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(closes, 2);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    await window.happyDOM.abort();
  }
});
