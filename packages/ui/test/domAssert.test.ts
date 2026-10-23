import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { assertActiveElement, assertNoElement } from "./support/domAssert.ts";

// The safe helper must keep failure diagnostics small no matter how large the
// matched subtree is. If a failure ever serialized the Happy DOM object graph the
// message would be enormous (and the process could OOM); this bound is the proxy
// for "no object graph was embedded".
const MAX_DIAGNOSTIC_LENGTH = 600;

function withWindow(run: (window: Window) => void): void {
  const window = new Window({ url: "http://localhost" });
  try {
    run(window);
  } finally {
    void window.happyDOM.close();
  }
}

test("assertNoElement passes when nothing matches", () => {
  withWindow((window) => {
    const container = window.document.createElement("div");
    container.innerHTML = "<span class='present'></span>";
    assertNoElement(container as unknown as { querySelector(s: string): Element | null }, ".terminal-slot.is-focused");
  });
});

test("assertNoElement fails normally when an element exists", () => {
  withWindow((window) => {
    const container = window.document.createElement("div");
    const slot = window.document.createElement("div");
    slot.className = "terminal-slot is-focused";
    slot.dataset.slotKey = "summit/created-grid";
    container.append(slot);

    let thrown: unknown;
    try {
      assertNoElement(
        container as unknown as { querySelector(s: string): Element | null },
        ".terminal-slot.is-focused",
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof assert.AssertionError, "expected an AssertionError");
    assert.equal((thrown as { code?: string }).code, "ERR_ASSERTION");
    assert.match(thrown.message, /\.terminal-slot\.is-focused/);
    assert.match(thrown.message, /terminal-slot is-focused/);
  });
});

test("assertNoElement keeps diagnostics bounded for a huge matched subtree", () => {
  withWindow((window) => {
    const container = window.document.createElement("div");
    const slot = window.document.createElement("div");
    slot.className = "terminal-slot is-focused";
    // A subtree big enough that serializing it (or the window graph) would blow
    // the diagnostic bound many times over.
    for (let i = 0; i < 5000; i += 1) {
      const child = window.document.createElement("p");
      child.textContent = `line ${i} with some padding text to grow the outerHTML`;
      slot.append(child);
    }
    container.append(slot);

    let thrown: unknown;
    try {
      assertNoElement(
        container as unknown as { querySelector(s: string): Element | null },
        ".terminal-slot.is-focused",
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof assert.AssertionError, "expected an AssertionError");
    assert.ok(
      thrown.message.length < MAX_DIAGNOSTIC_LENGTH,
      `diagnostic message must stay bounded, got ${thrown.message.length} chars`,
    );
    assert.match(thrown.message, /\[\+\d+ chars\]/, "expected the outerHTML to be truncated");
  });
});

test("assertNoElement honors a custom failure message", () => {
  withWindow((window) => {
    const container = window.document.createElement("div");
    container.append(window.document.createElement("button"));
    assert.throws(
      () => assertNoElement(container as unknown as { querySelector(s: string): Element | null }, "button", "custom boom"),
      /custom boom/,
    );
  });
});

test("assertActiveElement passes when the expected element holds focus", () => {
  withWindow((window) => {
    const button = window.document.createElement("button");
    window.document.body.append(button);
    button.focus();
    assertActiveElement(window as unknown as { document: { activeElement: Element | null } }, button as unknown as Element);
  });
});

test("assertActiveElement fails with bounded diagnostics on a focus mismatch", () => {
  withWindow((window) => {
    const focused = window.document.createElement("button");
    focused.className = "real-focus";
    const other = window.document.createElement("input");
    other.className = "wanted-focus";
    window.document.body.append(focused, other);
    focused.focus();

    let thrown: unknown;
    try {
      assertActiveElement(
        window as unknown as { document: { activeElement: Element | null } },
        other as unknown as Element,
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof assert.AssertionError, "expected an AssertionError");
    assert.ok(thrown.message.length < MAX_DIAGNOSTIC_LENGTH, "focus diagnostics must stay bounded");
    assert.match(thrown.message, /wanted-focus/);
    assert.match(thrown.message, /real-focus/);
  });
});
