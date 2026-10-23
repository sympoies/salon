import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TimeoutScheduler } from "../src/scheduler.ts";
import { useExpiringValue, type ExpiringValue } from "../src/useExpiringValue.ts";

type FakeTimer = {
  readonly id: number;
  readonly delayMs: number;
  readonly callback: () => void;
  cleared: boolean;
};

function createFakeScheduler(): TimeoutScheduler<FakeTimer> & { timers: FakeTimer[]; fire(timer: FakeTimer): void } {
  let nextId = 1;
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimeout(callback, delayMs) {
      const timer = { id: nextId++, delayMs, callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
    },
    fire(timer) {
      if (!timer.cleared) {
        timer.callback();
      }
    },
  };
}

const cleanupStack: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function installDom(): { root: Root; container: HTMLElement; cleanup(): Promise<void> } {
  const window = new Window({ url: "http://localhost" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousElement = globalThis.Element;
  const previousHTMLElement = globalThis.HTMLElement;
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let cleaned = false;
  return {
    root,
    container,
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await act(async () => {
        root.unmount();
      });
      Object.assign(globalThis, {
        window: previousWindow,
        document: previousDocument,
        Element: previousElement,
        HTMLElement: previousHTMLElement,
      });
    },
  };
}

test("useExpiringValue shows a value, clears it after ttl, and cancels replaced timers", async () => {
  const scheduler = createFakeScheduler();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let expiring: ExpiringValue<string> | null = null;

  function Probe() {
    expiring = useExpiringValue<string>(1600, scheduler);
    return createElement("output", null, expiring.value ?? "");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  assert.equal(mounted.container.textContent, "");

  await act(async () => {
    expiring?.show("first");
  });
  assert.equal(mounted.container.textContent, "first");
  assert.equal(scheduler.timers[0]?.delayMs, 1600);

  await act(async () => {
    expiring?.show("second");
  });
  assert.equal(scheduler.timers[0]?.cleared, true);
  assert.equal(mounted.container.textContent, "second");

  await act(async () => {
    scheduler.fire(scheduler.timers[1]);
  });
  assert.equal(mounted.container.textContent, "");
});

test("useExpiringValue supports non-expiring set and cleanup clear", async () => {
  const scheduler = createFakeScheduler();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let expiring: ExpiringValue<{ key: string; state: string }> | null = null;

  function Probe() {
    expiring = useExpiringValue<{ key: string; state: string }>(2600, scheduler);
    return createElement("output", null, expiring.value?.state ?? "");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    expiring?.set({ key: "a", state: "working" });
  });

  assert.equal(mounted.container.textContent, "working");
  assert.equal(scheduler.timers.length, 0);

  await act(async () => {
    expiring?.show({ key: "a", state: "updated" });
  });
  assert.equal(mounted.container.textContent, "updated");
  assert.equal(scheduler.timers[0]?.delayMs, 2600);

  await mounted.cleanup();
  assert.equal(scheduler.timers[0]?.cleared, true);
});

test("useExpiringValue set cancels a pending expiring value", async () => {
  const scheduler = createFakeScheduler();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let expiring: ExpiringValue<{ key: string; state: string }> | null = null;

  function Probe() {
    expiring = useExpiringValue<{ key: string; state: string }>(2600, scheduler);
    return createElement("output", null, expiring.value?.state ?? "");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    expiring?.show({ key: "a", state: "updated" });
  });
  assert.equal(mounted.container.textContent, "updated");
  const staleTimer = scheduler.timers[0];
  assert.ok(staleTimer, "show should create a timer");

  await act(async () => {
    expiring?.set({ key: "a", state: "working" });
  });
  assert.equal(staleTimer.cleared, true);
  assert.equal(mounted.container.textContent, "working");

  await act(async () => {
    scheduler.fire(staleTimer);
  });
  assert.equal(mounted.container.textContent, "working");
});
