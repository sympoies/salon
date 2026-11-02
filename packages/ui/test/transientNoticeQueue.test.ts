import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { hostOfflineNotice, transientStatusNotice, type StatusNotice } from "../src/statusNoticeModel.ts";
import type { TimeoutScheduler } from "../src/scheduler.ts";
import { useTransientNotice } from "../src/useTransientNotice.ts";

// #262: a transient result is shown for its full time once it is on screen. One that arrives while another
// status notice is showing waits behind it instead of expiring unseen.
type FakeTimer = { readonly delayMs: number; readonly callback: () => void; cleared: boolean };
function fakeScheduler(): TimeoutScheduler<FakeTimer> & { timers: FakeTimer[]; live(): FakeTimer[] } {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimeout(callback, delayMs) { const timer = { delayMs, callback, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
    live() { return timers.filter(timer => !timer.cleared); },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function mount(scheduler: ReturnType<typeof fakeScheduler>) {
  const window = new Window({ url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => { await act(async () => root.unmount()); Object.assign(globalThis, previous); await window.happyDOM.abort(); });
  const seen = { notice: null as StatusNotice | null, show(_: StatusNotice) {} };
  let blocked = false;
  function Probe({ blockedNow }: { blockedNow: boolean }) {
    const state = useTransientNotice(blockedNow, scheduler);
    seen.notice = state.notice;
    seen.show = state.show;
    return null;
  }
  const render = async (next: boolean) => { blocked = next; await act(async () => root.render(createElement(Probe, { blockedNow: blocked }))); };
  await render(false);
  return { seen, setBlocked: render };
}

test("a success and a failure arriving during another notice both show after it ends, then expire normally", async () => {
  const scheduler = fakeScheduler();
  const { seen, setBlocked } = await mount(scheduler);
  const hostOffline = hostOfflineNotice("fixture: offline");
  assert.equal(hostOffline.kind, "host-offline");
  for (const result of [transientStatusNotice("Session info updated", "ok"), { kind: "attention" as const, message: "Refresh failed" }]) {
    await setBlocked(true);
    await act(async () => seen.show(result));
    assert.equal(scheduler.live().length, 0, "no expiry starts while the other notice is showing");
    assert.equal(seen.notice, result, "the result is held, not dropped");
    await setBlocked(false);
    assert.equal(scheduler.live().length, 1, "the display time starts once it is visible");
    assert.equal(scheduler.live()[0]!.delayMs, 3000);
    assert.equal(seen.notice, result);
    await act(async () => scheduler.live()[0]!.callback());
    assert.equal(seen.notice, null, "it expires normally after being shown");
  }
});

test("a second result replaces the first and restarts the display time without leaving a stuck notice", async () => {
  const scheduler = fakeScheduler();
  const { seen } = await mount(scheduler);
  const first = transientStatusNotice("Session info updated", "ok");
  const second = { kind: "attention" as const, message: "Refresh failed" };
  await act(async () => seen.show(first));
  const firstTimer = scheduler.live()[0]!;
  await act(async () => seen.show(second));
  assert.equal(seen.notice, second);
  assert.equal(firstTimer.cleared, true, "the first result's timer is cancelled");
  assert.equal(scheduler.live().length, 1);
  await act(async () => scheduler.live()[0]!.callback());
  assert.equal(seen.notice, null, "nothing is left on screen");
  assert.equal(scheduler.live().length, 0);
});

test("a held result that is replaced while blocked shows only the newer one", async () => {
  const scheduler = fakeScheduler();
  const { seen, setBlocked } = await mount(scheduler);
  await setBlocked(true);
  await act(async () => seen.show(transientStatusNotice("Session info updated", "ok")));
  const newer = { kind: "attention" as const, message: "Refresh failed" };
  await act(async () => seen.show(newer));
  await setBlocked(false);
  assert.equal(seen.notice, newer);
  await act(async () => scheduler.live()[0]!.callback());
  assert.equal(seen.notice, null);
});

test("the dashboard drives the held result by whether another status notice is showing", () => {
  const dashboard = readFileSync(new URL("../src/Dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /useTransientNotice\(statusNotice !== null\)/);
  assert.doesNotMatch(dashboard, /useExpiringValue<StatusNoticeState>\(TRANSIENT_NOTICE_MS\)/);
});
