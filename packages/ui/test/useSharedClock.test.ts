import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useSharedClock } from "../src/useSharedClock.ts";

test("useSharedClock shares one interval across consumers and follows active transitions", async () => {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    dateNow: Date.now,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let intervalCallback: (() => void) | null = null;
  let intervalCount = 0;
  let clearCount = 0;
  let now = 1000;
  Date.now = () => now;
  window.setInterval = ((callback: TimerHandler) => {
    intervalCount += 1;
    intervalCallback = callback as () => void;
    return 77;
  }) as typeof window.setInterval;
  window.clearInterval = ((id: number) => {
    assert.equal(id, 77);
    clearCount += 1;
  }) as typeof window.clearInterval;

  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  function Probe({ active, label }: { active: boolean; label: string }) {
    return createElement("output", { "data-label": label }, String(useSharedClock(active)));
  }
  function Pair({ active }: { active: boolean }) {
    return createElement(
      "div",
      null,
      createElement(Probe, { active, label: "first" }),
      createElement(Probe, { active, label: "second" }),
    );
  }
  try {
    await act(async () => root.render(createElement(Pair, { active: true })));
    assert.equal(intervalCount, 1);
    assert.equal(container.textContent, "10001000");
    now = 2000;
    await act(async () => intervalCallback?.());
    assert.equal(container.textContent, "20002000");
    await act(async () => root.render(createElement(Pair, { active: false })));
    assert.equal(clearCount, 1);
    now = 3000;
    await act(async () => intervalCallback?.());
    assert.equal(container.textContent, "20002000");
    await act(async () => root.render(createElement(Pair, { active: true })));
    assert.equal(intervalCount, 2);
    assert.equal(container.textContent, "30003000");
    await act(async () => root.unmount());
    assert.equal(clearCount, 2);
  } finally {
    Date.now = previous.dateNow;
    Object.assign(globalThis, previous);
    window.close();
  }
});
