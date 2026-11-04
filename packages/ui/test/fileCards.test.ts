import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createUiSsrHarness } from "./support/ssr.ts";
import { assertNoElement } from "./support/domAssert.ts";

test("non-image uploads form named or neutral file cards after text and still copy their exact paths", async () => {
  const window = new Window({ url: "http://localhost" });
  const copied: string[] = [];
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement,
    navigator: { clipboard: { writeText: async (path: string) => { copied.push(path); } } }, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const ssr = createUiSsrHarness(), container = window.document.body.appendChild(window.document.createElement("div"));
  const root = createRoot(container);
  const paths = ["/fixture/sessions/sample/attachments/123-video.mp4", "/fixture/sessions/sample/attachments/123-doc.pdf", "/fixture/sessions/sample/attachments/123-archive.zip"];
  try {
    const { OutgoingBubble } = await ssr.loadModule<typeof import("../src/OutgoingBubble.tsx")>("/src/OutgoingBubble.tsx");
    await act(async () => root.render(createElement(OutgoingBubble, { uploadSessionId: "sample",
      onDismiss() {}, text: paths.map(path => `'${path}'`).join("\n") + "\nReview these files.",
      attachments: [{ path: paths[0]!, original_name: "Demo recording.mp4", bytes: 2048 },
        { path: paths[1]!, original_name: "Project proposal.pdf", bytes: 1024 }],
    })));
    const cards = [...container.querySelectorAll<HTMLButtonElement>(".file-card")];
    assert.equal(cards.length, 3);
    assert.deepEqual(cards.map(card => card.querySelector(".file-card-name")?.textContent), ["Demo recording.mp4", "Project proposal.pdf", "Archive"]);
    assert.deepEqual(cards.map(card => card.querySelector(".file-card-details")?.textContent), ["Video · 2 KB", "Document · 1 KB", "Archive"]);
    assert.doesNotMatch(container.textContent ?? "", /\[File|\[Attachment|123-|\/fixture/);
    assert.ok((container.textContent ?? "").startsWith("Review these files."));
    assert.ok(cards.every(card => card.querySelector(".file-card-copy svg")));
    const key = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => cards[0]!.dispatchEvent(key));
    assert.equal(key.defaultPrevented, false, "copy keeps native button keyboard activation");
    assertNoElement(container, '[role="menu"]', "keyboard copy must not open the reply menu");
    await act(async () => cards[0]!.click());
    assert.deepEqual(copied, [paths[0]]);
    assert.match(cards[0]!.textContent ?? "", /Copied/);
  } finally {
    await act(async () => root.unmount()); await ssr.close();
    for (const [key, value] of saved) value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
