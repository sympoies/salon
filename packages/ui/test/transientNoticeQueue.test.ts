import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { hostOfflineNotice, transientStatusNotice, type StatusNotice } from "../src/statusNoticeModel.ts";
import type { TimeoutScheduler } from "../src/scheduler.ts";
import { useTransientNotice } from "../src/useTransientNotice.ts";
import { useVisibleExpiringValue } from "../src/useVisibleExpiringValue.ts";
import { useResultNotices } from "../src/useResultNotices.ts";

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

interface Feedback { readonly key: string; readonly state: "working" | "updated" | "failed" }

async function mountFeedback(scheduler: ReturnType<typeof fakeScheduler>, ttlMs: number) {
  const window = new Window({ url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => { await act(async () => root.unmount()); Object.assign(globalThis, previous); await window.happyDOM.abort(); });
  const seen = { value: null as Feedback | null, show(_: Feedback) {}, set(_: Feedback | null) {} };
  function Probe({ blocked }: { blocked: boolean }) {
    const state = useVisibleExpiringValue<Feedback, ReturnType<typeof fakeScheduler>["timers"][number]>(blocked, ttlMs, scheduler);
    seen.value = state.value; seen.show = state.show; seen.set = state.set;
    return null;
  }
  const render = async (blocked: boolean) => { await act(async () => root.render(createElement(Probe, { blocked }))); };
  await render(false);
  return { seen, setBlocked: render };
}

// The retitle result (2600 ms) and the shortcut hint (2200 ms) use the same hook as the refresh result.
for (const ttl of [2600, 2200]) {
  test(`a ${ttl} ms result (retitle success or failure, shortcut hint) arriving behind a host notice shows after it and then expires`, async () => {
    const scheduler = fakeScheduler();
    const { seen, setBlocked } = await mountFeedback(scheduler, ttl);
    for (const state of ["updated", "failed"] as const) {
      await setBlocked(true);
      await act(async () => seen.show({ key: "host:a", state }));
      assert.equal(scheduler.live().length, 0, "no time runs while the host notice is showing");
      await setBlocked(false);
      assert.equal(seen.value?.state, state);
      assert.equal(scheduler.live()[0]!.delayMs, ttl, "the full time starts once it is visible");
      await act(async () => scheduler.live()[0]!.callback());
      assert.equal(seen.value, null);
    }
  });
}

test("an indefinite working retitle never expires, is replaced by its result and cleared by null", async () => {
  const scheduler = fakeScheduler();
  const { seen, setBlocked } = await mountFeedback(scheduler, 2600);
  await act(async () => seen.set({ key: "host:a", state: "working" }));
  assert.equal(scheduler.live().length, 0, "working has no expiry");
  await setBlocked(true);
  await setBlocked(false);
  assert.equal(scheduler.live().length, 0);
  assert.equal(seen.value?.state, "working");
  await act(async () => seen.show({ key: "host:a", state: "updated" }));
  assert.equal(scheduler.live().length, 1, "its result then expires normally");
  await act(async () => seen.set(null));
  assert.equal(seen.value, null);
  assert.equal(scheduler.live().length, 0);
});

type Results = ReturnType<typeof useResultNotices>;

// The whole shared-layer composition the dashboard uses: a host notice blocks every result, results rank
// refresh > retitle > hint, and each result's time starts when it is the one on screen.
async function mountResults(scheduler: ReturnType<typeof fakeScheduler>, live: Set<string>) {
  const window = new Window({ url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => { await act(async () => root.unmount()); Object.assign(globalThis, previous); await window.happyDOM.abort(); });
  const seen = {} as { api: Results; statusShowing: boolean };
  function Probe({ statusShowing }: { statusShowing: boolean }) {
    seen.api = useResultNotices(statusShowing, key => live.has(key), scheduler);
    seen.statusShowing = statusShowing;
    return null;
  }
  const setStatus = async (statusShowing: boolean) => { await act(async () => root.render(createElement(Probe, { statusShowing }))); };
  await setStatus(false);
  // What the layer shows: the status notice first, else the result.
  const visible = () => seen.statusShowing ? "status" : seen.api.resultNotice?.message ?? null;
  return { seen, setStatus, visible };
}

test("retitle success and failure and the shortcut hint behind a host notice show after it ends and then expire", async () => {
  const scheduler = fakeScheduler();
  const { seen, setStatus, visible } = await mountResults(scheduler, new Set(["host:a"]));
  const cases = [
    { name: "retitle success", show: () => seen.api.showRetitleFeedback({ key: "host:a", state: "updated" }), text: "Title updated", ttl: 2600 },
    { name: "retitle failure", show: () => seen.api.showRetitleFeedback({ key: "host:a", state: "failed", detail: "Try again" }), text: "Retitle failed: Try again", ttl: 2600 },
    { name: "shortcut hint", show: () => seen.api.showShortcutFeedback({ key: "host:a", text: "Open a session" }), text: "Open a session", ttl: 2200 },
  ];
  for (const c of cases) {
    await setStatus(true);
    await act(async () => c.show());
    assert.equal(visible(), "status", `${c.name}: the host notice shows first`);
    assert.equal(scheduler.live().length, 0, `${c.name}: no time runs behind the host notice`);
    await setStatus(false);
    assert.equal(visible(), c.text, `${c.name}: shows after the host notice ends`);
    assert.equal(scheduler.live()[0]!.delayMs, c.ttl, `${c.name}: its full time starts when shown`);
    await act(async () => scheduler.live()[0]!.callback());
    assert.equal(visible(), null, `${c.name}: expires normally`);
  }
});

test("results rank refresh over retitle over hint, each starting its time when it reaches the screen", async () => {
  const scheduler = fakeScheduler();
  const { seen, visible } = await mountResults(scheduler, new Set(["host:a"]));
  await act(async () => { seen.api.showShortcutFeedback({ key: "host:a", text: "Open a session" }); });
  assert.equal(visible(), "Open a session");
  await act(async () => { seen.api.showRetitleFeedback({ key: "host:a", state: "updated" }); });
  assert.equal(visible(), "Title updated", "the retitle result takes the layer from the hint");
  await act(async () => { seen.api.showTransient(transientStatusNotice("Session info updated", "ok")); });
  assert.equal(visible(), "Session info updated", "the refresh result ranks first");
  assert.equal(scheduler.live().length, 1, "only the result on screen is timing");
  await act(async () => scheduler.live()[0]!.callback());
  assert.equal(visible(), "Title updated", "the retitle result shows next with its full time");
  assert.equal(scheduler.live()[0]!.delayMs, 2600);
  await act(async () => scheduler.live()[0]!.callback());
  assert.equal(visible(), "Open a session", "then the hint, with its full time");
  assert.equal(scheduler.live()[0]!.delayMs, 2200);
  await act(async () => scheduler.live()[0]!.callback());
  assert.equal(visible(), null, "nothing is left on screen");
  assert.equal(scheduler.live().length, 0);
});

test("a retitle in progress stays until its result replaces it; dismissing clears every result", async () => {
  const scheduler = fakeScheduler();
  const { seen, visible } = await mountResults(scheduler, new Set(["host:a"]));
  await act(async () => seen.api.setRetitleFeedback({ key: "host:a", state: "working" }));
  assert.equal(visible(), "Retitling…");
  assert.equal(scheduler.live().length, 0, "progress never expires");
  await act(async () => seen.api.showRetitleFeedback({ key: "host:a", state: "updated" }));
  assert.equal(visible(), "Title updated");
  await act(async () => seen.api.showShortcutFeedback({ key: "host:a", text: "Open a session" }));
  await act(async () => seen.api.dismissResults());
  assert.equal(visible(), null);
  assert.equal(scheduler.live().length, 0);
});

test("a pending retitle for a removed session leaves no stale progress and does not hold the hint", async () => {
  const scheduler = fakeScheduler();
  const live = new Set(["host:a", "host:b"]);
  const { seen, visible } = await mountResults(scheduler, live);
  await act(async () => seen.api.setRetitleFeedback({ key: "host:a", state: "working" }));
  assert.equal(visible(), "Retitling…");
  live.delete("host:a");
  await act(async () => seen.api.showShortcutFeedback({ key: "host:b", text: "Open a session" }));
  assert.equal(visible(), "Open a session", "the removed session's progress is not shown and does not mask the hint");
  assert.equal(scheduler.live()[0]!.delayMs, 2200, "the hint times normally");
});

test("the dashboard uses the shared result composition, not its own expiring values", () => {
  const dashboard = readFileSync(new URL("../src/Dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /useResultNotices\(statusNotice !== null, \(key\) => liveSessionKeys\.has\(key\)\)/);
  assert.match(dashboard, /const visibleStatusNotice = statusNotice \?\? resultNotice \?\?/);
  assert.doesNotMatch(dashboard, /useExpiringValue<RetitleFeedback>|useExpiringValue<ShortcutFeedback>|useExpiringValue<StatusNoticeState>/);
});
