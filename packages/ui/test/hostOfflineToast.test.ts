import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentType } from "react";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { makeCssRuleLookup, uiStyles } from "./support/source.ts";
import type { TimeoutScheduler } from "../src/scheduler.ts";
import { useStatusNotice } from "../src/useStatusNotice.ts";
import * as statusNotice from "../src/statusNoticeModel.ts";
import { CLEAR_SESSION_FILTERS } from "../src/sessionFilters.ts";

type FakeTimer = { readonly delayMs: number; readonly callback: () => void; cleared: boolean };
function createFakeScheduler(): TimeoutScheduler<FakeTimer> & { timers: FakeTimer[] } {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimeout(callback, delayMs) { const timer = { delayMs, callback, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
  };
}
const liveTimers = (scheduler: { timers: FakeTimer[] }, delayMs: number) =>
  scheduler.timers.filter(timer => !timer.cleared && timer.delayMs === delayMs);

const HOST_DOWN = "summit: offline (cooling down after a failed probe)";

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

async function loadStatusNotice() {
  return (await ssr.loadModule<{ StatusNotice: ComponentType<{ notice: { kind: string; message: string }; onDismiss: () => void }> }>("/src/StatusNotice.tsx")).StatusNotice;
}

test("host failures are accepted only for known machine names; console and other messages are not host failures", () => {
  const known = ["summit", "beta", "gamma"];
  assert.deepEqual(statusNotice.hostFailureHosts(HOST_DOWN, known), ["summit"]);
  assert.deepEqual(statusNotice.hostFailureHosts("beta: offline; gamma: unreachable", known), ["beta", "gamma"]);
  assert.deepEqual(statusNotice.hostFailureHosts("beta: unreachable", known), ["beta"], "any reason for a known machine counts");
  assert.equal(statusNotice.hostFailureHosts("unknown-box: offline", known), null, "unknown names are not hosts");
  assert.equal(statusNotice.hostFailureHosts("Console server: unreachable", ["Console server", "summit"]), null, "the console prefix is checked first");
  assert.equal(statusNotice.hostFailureHosts("Console server is unreachable", known), null);
  assert.equal(statusNotice.hostFailureHosts("Session list unavailable", known), null);
  assert.equal(statusNotice.hostFailureHosts(HOST_DOWN, []), null, "no known machines yet means no host toast");
});

test("a host-offline toast auto-dismisses after 8 seconds even while the host stays down", async () => {
  const StatusNotice = await loadStatusNotice();
  const scheduler = createFakeScheduler(); const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  let nowMs = 0; const now = () => nowMs;
  function Probe({ error }: { error: string | null }) {
    const { notice, dismiss } = useStatusNotice(error, scheduler, { now, loaded: true, machines: ["summit"] });
    return notice ? createElement(StatusNotice, { notice, onDismiss: dismiss }) : null;
  }
  await act(async () => { mounted.root.render(createElement(Probe, { error: HOST_DOWN })); });
  nowMs = 5_000;
  await act(async () => { for (const timer of liveTimers(scheduler, 5_000)) timer.callback(); });
  assert.match(mounted.container.textContent ?? "", /summit: offline/);
  const dismissTimers = liveTimers(scheduler, 8_000);
  assert.equal(dismissTimers.length, 1, "a host-offline toast schedules an 8 second dismissal");
  nowMs = 13_000;
  await act(async () => { dismissTimers[0]!.callback(); });
  assert.equal(mounted.container.textContent, "", "the toast clears itself while the error persists");
});

test("the same host is not re-toasted within two minutes but may be after that", async () => {
  const StatusNotice = await loadStatusNotice();
  const scheduler = createFakeScheduler(); const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  let nowMs = 0; const now = () => nowMs;
  function Probe({ error }: { error: string | null }) {
    const { notice, dismiss } = useStatusNotice(error, scheduler, { now, loaded: true, machines: ["summit"] });
    return notice ? createElement(StatusNotice, { notice, onDismiss: dismiss }) : null;
  }
  await act(async () => { mounted.root.render(createElement(Probe, { error: HOST_DOWN })); });
  nowMs = 5_000;
  await act(async () => { for (const timer of liveTimers(scheduler, 5_000)) timer.callback(); });
  await act(async () => { for (const timer of liveTimers(scheduler, 8_000)) timer.callback(); });
  assert.equal(mounted.container.textContent, "");

  nowMs = 30_000;
  await act(async () => { mounted.root.render(createElement(Probe, { error: null })); });
  await act(async () => { mounted.root.render(createElement(Probe, { error: HOST_DOWN })); });
  assert.equal(mounted.container.textContent, "", "the same host is not re-toasted within two minutes");

  nowMs = 125_000;
  await act(async () => { mounted.root.render(createElement(Probe, { error: null })); });
  await act(async () => { mounted.root.render(createElement(Probe, { error: HOST_DOWN })); });
  assert.match(mounted.container.textContent ?? "", /summit: offline/, "after two minutes the host may toast again");
});

test("no host toast before the first successful load or five seconds, whichever is later", async () => {
  const StatusNotice = await loadStatusNotice();
  const scheduler = createFakeScheduler(); const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  let nowMs = 0; const now = () => nowMs;
  function Probe({ error, loaded }: { error: string | null; loaded: boolean }) {
    const { notice, dismiss } = useStatusNotice(error, scheduler, { now, loaded, machines: ["summit"] });
    return notice ? createElement(StatusNotice, { notice, onDismiss: dismiss }) : null;
  }
  await act(async () => { mounted.root.render(createElement(Probe, { error: HOST_DOWN, loaded: false })); });
  assert.equal(mounted.container.textContent, "", "nothing shows before the first load");

  nowMs = 2_000;
  await act(async () => { mounted.root.render(createElement(Probe, { error: HOST_DOWN, loaded: true })); });
  assert.equal(mounted.container.textContent, "", "first load at 2s does not end the five-second grace");

  nowMs = 5_000;
  await act(async () => { for (const timer of liveTimers(scheduler, 5_000)) timer.callback(); });
  assert.match(mounted.container.textContent ?? "", /summit: offline/, "a host still down after the grace toasts");
});

test("a host that never answers after the grace period still gets one toast", async () => {
  const StatusNotice = await loadStatusNotice();
  const scheduler = createFakeScheduler(); const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  let nowMs = 0; const now = () => nowMs;
  function Probe({ error }: { error: string | null }) {
    const { notice, dismiss } = useStatusNotice(error, scheduler, { now, loaded: true, machines: ["summit"] });
    return notice ? createElement(StatusNotice, { notice, onDismiss: dismiss }) : null;
  }
  await act(async () => { mounted.root.render(createElement(Probe, { error: HOST_DOWN })); });
  nowMs = 5_000;
  await act(async () => { for (const timer of liveTimers(scheduler, 5_000)) timer.callback(); });
  assert.equal(mounted.container.querySelectorAll(".connection-notice").length, 1, "exactly one toast");
});

test("non-host failures keep the persistent attention notice", async () => {
  const StatusNotice = await loadStatusNotice();
  const scheduler = createFakeScheduler(); const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  let nowMs = 0; const now = () => nowMs;
  function Probe({ error }: { error: string | null }) {
    const { notice, dismiss } = useStatusNotice(error, scheduler, { now, loaded: true, machines: ["summit"] });
    return notice ? createElement(StatusNotice, { notice, onDismiss: dismiss }) : null;
  }
  await act(async () => { mounted.root.render(createElement(Probe, { error: "Session list unavailable" })); });
  assert.match(mounted.container.textContent ?? "", /Session list unavailable/);
  assert.equal(liveTimers(scheduler, 8_000).length, 0, "other attention notices are not auto-dismissed");
});

test("the host-offline toast uses only the trigger row's free space: the bar keeps its box, the row stays on one line, and a compact label or no toast covers nothing", () => {
  const css = uiStyles();
  const rule = makeCssRuleLookup(css);
  assert.match(rule(".session-filter-trigger-row.has-row-notice"), /flex-wrap:\s*nowrap/, "the row stays on one line while a toast shows");
  assert.match(rule(".session-filter-trigger-row.has-row-notice > .session-filter-searchbar"), /flex:\s*none/, "the search bar never shrinks or moves");
  const layer = rule(".session-filter-trigger-row > .connection-notice-layer");
  assert.match(layer, /position:\s*relative/, "the slot stays in flow and anchors the narrow-width dot");
  assert.match(layer, /padding:\s*0;/, "an empty slot adds no width");
  assert.match(layer, /flex:\s*1 1 0/, "the toast takes only the remaining width");
  assert.match(layer, /container-type:\s*inline-size/, "the toast measures its own free space");
  const message = rule(".session-filter-trigger-row > .connection-notice-layer .connection-notice-message");
  assert.match(message, /white-space:\s*nowrap/, "the message stays on one line so the row keeps its height");
  assert.match(message, /text-overflow:\s*ellipsis/);
  assert.match(css, /@container \(max-width: 150px\) \{[\s\S]*?connection-notice-message-compact \{ display: block; \}/,
    "a narrow free space shows the compact host label");
  const compactFull = /@container \(max-width: 150px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.doesNotMatch(compactFull, /connection-notice-message-full \{ display: none; \}/,
    "the compact label keeps the full text available to assistive tech");
  assert.match(compactFull, /connection-notice-message-full \{[^}]*clip-path: inset\(50%\)/, "the full text is visually hidden, not removed");
  const noSpace = /@container \(max-width: 24px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.doesNotMatch(noSpace, /\.connection-notice \{ display: none; \}/, "with no free space the alert is not removed");
  assert.match(noSpace, /\.connection-notice \{[^}]*clip-path: inset\(50%\)/, "with no free space the toast is visually hidden but still announced");
  assert.match(noSpace, /\.connection-notice-dismiss \{[^}]*visibility: hidden/, "the hidden toast's dismiss button leaves the focus order");
  assert.match(noSpace, /\.connection-notice-dot \{[^}]*display: block/, "with no free space a red dot shows instead");
  assert.match(rule(".connection-notice-dot"), /display:\s*none/, "the dot shows only when the toast has no room");
  assert.doesNotMatch(layer, /top:\s*calc\(100% \+ 4px\)/, "the toast never drops over the card area");
});

test("the navigator renders the toast after the collapsed phone and desktop filter control", async () => {
  const { SessionListNavigator } = await ssr.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
  for (const mobile of [false, true]) {
    const html = renderComponent(SessionListNavigator, {
      filters: CLEAR_SESSION_FILTERS, machines: ["host-a"], harnesses: [], resultCount: 1, mobile,
      page: 1, pageCount: 1, onPageChange() {}, onChange() {},
      statusNotice: createElement("div", { className: "connection-notice-layer" }, "host-a: offline"),
    } as never);
    const row = html.indexOf('class="session-filter-trigger-row');
    const controls = html.indexOf("session-filter-searchbar");
    const toast = html.indexOf("connection-notice-layer");
    assert.notEqual(row, -1, "the filter row renders");
    assert.ok(controls > row && toast > controls, "the notice follows the visible filter controls");
  }
});

test("on desktop the host-offline notice sits inside the filter field, taking only its free space; a phone and a connection notice keep the row slot (#761)", async () => {
  const { SessionListNavigator } = await ssr.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
  const render = (mobile: boolean, noticeInField: boolean) => renderComponent(SessionListNavigator, {
    filters: CLEAR_SESSION_FILTERS, machines: ["host-a"], harnesses: [], resultCount: 1, mobile, noticeInField,
    page: 1, pageCount: 1, onPageChange() {}, onChange() {},
    statusNotice: createElement("div", { className: "connection-notice-layer" }, "host-a: offline"),
  } as never);
  const field = render(false, true);
  const bar = field.indexOf('class="session-filter-searchbar"');
  assert.ok(field.indexOf("session-filter-field-notice") > bar && field.indexOf("session-filter-field-notice") < field.indexOf("</div>", field.indexOf("connection-notice-layer")),
    "the desktop notice renders inside the search bar");
  assert.doesNotMatch(field, /has-row-notice/, "the row keeps its normal layout when the notice lives in the field");
  for (const html of [render(true, true), render(false, false)]) {
    assert.doesNotMatch(html, /session-filter-field-notice/, "phones and connection notices keep the row slot");
    assert.match(html, /has-row-notice/);
  }
  const rule = makeCssRuleLookup(uiStyles());
  const slot = rule(".session-filter-field-notice");
  assert.match(slot, /flex:\s*0 1000 20rem/, "the notice yields before the chips do, so it only takes free space");
  assert.match(slot, /min-width:\s*0/);
  assert.match(rule(".session-filter-searchbar:has(> .session-filter-field-notice) .session-filter-placeholder"), /display:\s*none/,
    "the empty field's hint gives its width to the notice while it shows");
});

test("only a host-offline notice carries the narrow-width red dot, and the dot is decorative", async () => {
  const StatusNotice = await loadStatusNotice();
  const host = renderComponent(StatusNotice, { notice: { kind: "host-offline", message: HOST_DOWN }, onDismiss() {} });
  assert.match(host, /<span class="connection-notice-dot" aria-hidden="true"><\/span>/);
  assert.ok(host.indexOf("connection-notice-dot") > host.indexOf('class="connection-notice is-host-offline"'),
    "the dot sits beside the toast inside the layer");
  for (const kind of ["attention", "unreachable", "restored"]) {
    const other = renderComponent(StatusNotice, { notice: { kind, message: "Session list unavailable" }, onDismiss() {} });
    assert.doesNotMatch(other, /connection-notice-dot/, `${kind} notices have no dot`);
  }
});

test("a suppressed host failure clears the notice that was on screen", async () => {
  const StatusNotice = await loadStatusNotice();
  const scheduler = createFakeScheduler(); const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  let nowMs = 0; const now = () => nowMs;
  function Probe({ error, loaded }: { error: string | null; loaded: boolean }) {
    const { notice, dismiss } = useStatusNotice(error, scheduler, { now, loaded, machines: ["summit"] });
    return notice ? createElement(StatusNotice, { notice, onDismiss: dismiss }) : null;
  }
  await act(async () => { mounted.root.render(createElement(Probe, { error: "Session list unavailable", loaded: true })); });
  assert.match(mounted.container.textContent ?? "", /Session list unavailable/);
  await act(async () => { mounted.root.render(createElement(Probe, { error: HOST_DOWN, loaded: false })); });
  assert.equal(mounted.container.textContent, "", "a host failure held by the startup grace must not leave the old notice on screen");
});
