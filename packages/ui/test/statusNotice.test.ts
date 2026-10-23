import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentType } from "react";
import { createUiSsrHarness } from "./support/ssr.ts";
import type { TimeoutScheduler } from "../src/scheduler.ts";
import { useStatusNotice } from "../src/useStatusNotice.ts";

type FakeTimer = { readonly delayMs: number; readonly callback: () => void; cleared: boolean };
function createFakeScheduler(): TimeoutScheduler<FakeTimer> & { timers: FakeTimer[]; fire(timer: FakeTimer, force?: boolean): void } {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimeout(callback, delayMs) { const timer = { delayMs, callback, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
    fire(timer, force = false) { if (force || !timer.cleared) timer.callback(); },
  };
}

const cleanupStack: Array<() => Promise<void>> = [];
const ssr = createUiSsrHarness();
after(async () => ssr.close());
afterEach(async () => { while (cleanupStack.length) await cleanupStack.pop()?.(); });
function installDom(): { root: Root; container: HTMLElement; cleanup(): Promise<void> } {
  const window = new Window({ url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container); let cleaned = false;
  return { root, container, async cleanup() {
    if (cleaned) return; cleaned = true;
    await act(async () => root.unmount());
    Object.assign(globalThis, previous); await window.happyDOM.abort();
  } };
}

test("status notice persists through outage, restores for three seconds, and can be dismissed", async () => {
  const { StatusNotice } = await ssr.loadModule<{ StatusNotice: ComponentType<{ notice: { kind: "unreachable" | "restored" | "attention"; message: string }; onDismiss: () => void }> }>("/src/StatusNotice.tsx");
  const scheduler = createFakeScheduler(); const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  function Probe({ error }: { error: string | null }) {
    const state = useStatusNotice(error, scheduler);
    return state.notice ? createElement(StatusNotice, { notice: state.notice, onDismiss: state.dismiss }) : null;
  }
  await act(async () => { mounted.root.render(createElement(Probe, { error: "Console server is unreachable" })); });
  assert.match(mounted.container.textContent ?? "", /Console server is unreachable/);
  assert.match(mounted.container.textContent ?? "", /Reconnecting/);
  assert.equal(scheduler.timers.length, 0, "unreachable does not schedule dismissal");
  await act(async () => { mounted.root.render(createElement(Probe, { error: null })); });
  assert.match(mounted.container.textContent ?? "", /connection restored/i);
  assert.equal(scheduler.timers[0]?.delayMs, 3_000);
  const staleTimer = scheduler.timers[0]!;
  await act(async () => { mounted.root.render(createElement(Probe, { error: "another failure" })); });
  assert.equal(staleTimer.cleared, true);
  assert.match(mounted.container.textContent ?? "", /another failure/);
  await act(async () => { scheduler.fire(staleTimer, true); });
  assert.match(mounted.container.textContent ?? "", /another failure/, "stale expiry cannot clear a newer notice");
  await act(async () => { mounted.container.querySelector<HTMLButtonElement>('[aria-label="Dismiss status notice"]')?.click(); });
  assert.equal(mounted.container.textContent, "", "dismiss button action clears the current notice");
});

test("restored status clears after its three-second expiry", async () => {
  const { StatusNotice } = await ssr.loadModule<{ StatusNotice: ComponentType<{ notice: { kind: "unreachable" | "restored" | "attention"; message: string }; onDismiss: () => void }> }>("/src/StatusNotice.tsx");
  const scheduler = createFakeScheduler(); const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  function Probe({ error }: { error: string | null }) {
    const { notice, dismiss } = useStatusNotice(error, scheduler);
    return notice ? createElement(StatusNotice, { notice, onDismiss: dismiss }) : null;
  }
  await act(async () => { mounted.root.render(createElement(Probe, { error: "Console server is unreachable" })); });
  await act(async () => { mounted.root.render(createElement(Probe, { error: null })); });
  await act(async () => { scheduler.fire(scheduler.timers[0]!); });
  assert.equal(mounted.container.textContent, "");
});

test("failure notices announce assertively while restored notices use polite status", async () => {
  const { StatusNotice } = await ssr.loadModule<typeof import("../src/StatusNotice.tsx")>("/src/StatusNotice.tsx");
  const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  for (const kind of ["attention", "unreachable", "restored"] as const) {
    await act(async () => mounted.root.render(createElement(StatusNotice, { notice: { kind, message: "Transport result" }, onDismiss() {} })));
    const notice = mounted.container.querySelector(".connection-notice")!;
    assert.equal(notice.getAttribute("role"), kind === "restored" ? "status" : "alert");
    assert.equal(notice.getAttribute("aria-live"), kind === "restored" ? "polite" : "assertive");
  }
});
