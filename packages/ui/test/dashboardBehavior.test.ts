import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type Dispatch,
  type SetStateAction,
} from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Plugin } from "vite";
import { assertActiveElement, assertNoElement } from "./support/domAssert.ts";
import type {
  LayoutOrderResult,
  MaintenanceActionApiResult,
  MaintenancePreviewResult,
  SendSessionInputBody,
  TitleSummaryResult,
} from "../src/api.ts";
import { resolveToggleFocusTarget } from "../src/dashboardShortcuts.ts";
import { useDashboardKeyboard } from "../src/useDashboardKeyboard.ts";
import { sessionKey, type LayoutMode } from "../src/layout.ts";
import type {
  CreateBody,
  HistoryMessagesResponse,
  HistorySessionsResponse,
  Session,
  SessionsResponse,
} from "../src/types.ts";
import type { AccountInventory, AccountProvider, StartupStatus } from "@agent-console/shared/api";
import type { SessionTitleState } from "@agent-console/shared/title";
import type {
  MaintenanceOperation,
  SessionMaintenanceActionRequest,
  SessionMaintenancePreview,
} from "@agent-console/shared/maintenance";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { serializeActivitySseEvent } from "@agent-console/shared/activity";
import { sharedAdmissionFixture } from "./support/sharedAdmissionFixture.ts";
import { createUiSsrHarness } from "./support/ssr.ts";
import { createRequestTimeoutMs } from "../src/createLifecycle.ts";

const keys = ["summit/a", "summit/b", "summit/c", "summit/d"] as const;
const MODE_STORAGE = "agent-console.layout.mode";
const AUTO_STORAGE = "agent-console.layout.auto";
const SLOTS_STORAGE = "agent-console.layout.slots";

test("Conversation grid Open enters the focused terminal without opening the panel", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 1440 });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const session = makeSession({ id: "conversation-tile", machine: "fixture", title: "Conversation tile",
    provider_resume: { provider: "codex", session_id: "thread" } });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions: [session], machines: [{ name: "fixture", ok: true, capabilities: { history: true } }] }),
    listHistorySessions: async machine => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [{
      id: "history", machine, provider: "codex", provider_session_id: "thread", title: "Conversation tile",
      cwd: "/workspace", created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z", resumable: true,
    }] }),
    listHistoryMessages: async () => ({ ok: true, messages: [
      { id: "user", role: "user", text: "the original question" },
      { id: "assistant", role: "assistant", text: "the complete answer" },
    ] }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  const props = { active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {},
    defaultAutoResume: false, terminalRenderMode: "realtime" as const, terminalSelectedPaneRealtime: true,
    onDebug() {}, onUsage() {}, onSettings() {} };
  await act(async () => mounted.root.render(createElement(Dashboard, { ...props, sessionListDisplay: "conversation" })));
  await waitForCondition(() => mounted.container.querySelectorAll(".slot-conversation-pane .history-message").length === 2, "tile history");
  assertNoElement(mounted.container, ".terminal-pane");
  assert.ok(mounted.container.querySelector(".slot-conversation-pane .conversation-composer"), "Conversation tiles include the shared reply composer");
  assertNoElement(mounted.container, 'select[aria-label="Session list display"]');
  const open = mounted.container.querySelector<HTMLButtonElement>('[aria-label="Open Conversation tile"]');
  assert.ok(open);
  await act(async () => open.click());
  await waitForCondition(() => mounted.container.querySelector(".terminal-slot.is-focused .terminal-pane") !== null, "focused terminal");
  assertNoElement(mounted.container, ".conversation-dock");
  assertNoElement(mounted.container, ".slot-conversation-pane");
  const back = mounted.container.querySelector<HTMLButtonElement>('[aria-label="Back to session list"]');
  assert.ok(back);
  await act(async () => back.click());
  await waitForCondition(() => mounted.container.querySelector(".slot-conversation-pane") !== null, "conversation grid restored");
  await act(async () => mounted.root.render(createElement(Dashboard, { ...props, sessionListDisplay: "terminal" })));
  await waitForCondition(() => mounted.container.querySelector(".terminal-pane") !== null, "terminal restored");
  assertNoElement(mounted.container, ".slot-conversation-pane");
});

test("the macOS title bar keeps the grid's status counts in the single-session view (#938)", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 1440 });
  cleanupStack.push(mounted.cleanup);
  const titleBarCounts = mounted.window.document.createElement("div");
  titleBarCounts.id = "mac-titlebar-counts";
  mounted.window.document.body.prepend(titleBarCounts);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const phase = (value: string) => ({ phase: value }) as Session["turn_state"];
  const sessions = [
    makeSession({ id: "alpha", machine: "fixture", title: "Alpha", turn_state: phase("working") }),
    makeSession({ id: "beta", machine: "fixture", title: "Beta", turn_state: phase("working") }),
    makeSession({ id: "gamma", machine: "fixture", title: "Gamma", turn_state: phase("waiting") }),
    makeSession({ id: "delta", machine: "fixture", title: "Delta", status: "stopped" }),
  ];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions, machines: [{ name: "fixture", ok: true }] }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => mounted.root.render(createElement(Dashboard, { active: true, machines: ["fixture"], enabledMachines: ["fixture"],
    machineColors: {}, onDebug() {}, onUsage() {}, onSettings() {} })));
  const counts = (scope: ParentNode) => [...scope.querySelectorAll(".session-status-count")].map(button => button.getAttribute("aria-label")).join(" | ");
  const gridCounts = "Working: 2 sessions | Waiting: 1 session | Needs attention: 0 sessions | Stopped: 1 session";
  await waitForCondition(() => counts(mounted.window.document) === gridCounts, "grid status counts");
  const open = mounted.container.querySelector<HTMLButtonElement>('[aria-label="Open Alpha"]');
  assert.ok(open);
  await act(async () => open.click());
  await waitForCondition(() => mounted.container.querySelector(".terminal-slot.is-focused") !== null, "single-session view");
  assert.equal(counts(titleBarCounts), gridCounts);
  assert.equal(counts(mounted.window.document), gridCounts, "the title bar shows the counts once");
  const working = titleBarCounts.querySelector<HTMLButtonElement>('.session-status-count[data-status-group="working"]')!;
  await act(async () => working.click());
  await waitForCondition(() => working.isConnected && working.getAttribute("aria-pressed") === "true", "status filter applied from the single-session view");
  assert.equal(counts(titleBarCounts), gridCounts, "a status filter keeps every group's count, as in the grid");
  assert.ok(mounted.container.querySelector(".terminal-slot.is-focused"), "the focused session stays open");
  await act(async () => working.click());
  await waitForCondition(() => working.getAttribute("aria-pressed") === "false", "a second click clears the status filter");
});

// #962: the Usage panel, like every overlay, backgrounds the Dashboard. On macOS
// the status counts stayed in the title bar only while it was active, so they
// fell back into the header row and compacted it until the panel closed.
test("the macOS title bar keeps the status counts while an overlay backgrounds the Dashboard (#962)", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 1440 });
  cleanupStack.push(mounted.cleanup);
  const titleBarCounts = mounted.window.document.createElement("div");
  titleBarCounts.id = "mac-titlebar-counts";
  mounted.window.document.body.prepend(titleBarCounts);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [
    makeSession({ id: "alpha", machine: "fixture", title: "Alpha", turn_state: { phase: "working" } as Session["turn_state"] }),
    makeSession({ id: "delta", machine: "fixture", title: "Delta", status: "stopped" }),
  ];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions, machines: [{ name: "fixture", ok: true }] }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  const render = (active: boolean) => act(async () => mounted.root.render(createElement(Dashboard, { active, machines: ["fixture"],
    enabledMachines: ["fixture"], machineColors: {}, onDebug() {}, onUsage() {}, onSettings() {} })));
  const counts = (scope: ParentNode) => [...scope.querySelectorAll(".session-status-count")].map(button => button.getAttribute("aria-label")).join(" | ");
  const gridCounts = "Working: 1 session | Waiting: 0 sessions | Needs attention: 0 sessions | Stopped: 1 session";
  await render(true);
  await waitForCondition(() => counts(titleBarCounts) === gridCounts, "title bar status counts");
  const header = mounted.container.querySelector<HTMLElement>(".workspace-head")!;
  assert.equal(header.classList.contains("has-native-counts"), true);
  await render(false);
  assert.equal(counts(titleBarCounts), gridCounts, "the counts stay in the title bar");
  assertNoElement(header, ".session-status-counts");
  assert.equal(header.classList.contains("has-native-counts"), true, "the header row keeps its macOS layout");
  assert.equal(titleBarCounts.hasAttribute("inert"), true, "the counts cannot be used behind the overlay");
  await render(true);
  assert.equal(counts(titleBarCounts), gridCounts);
  assert.equal(titleBarCounts.hasAttribute("inert"), false, "usable again once the overlay closes");
});

// A Dashboard with one listed session and a badge that exposes the refresh hook
// and the live session object the dashboard currently holds for it.
async function mountRefreshDashboard(refreshSessionInfo: () => Promise<unknown>, options: { readonly web?: boolean } = {}) {
  const mounted = installDom(options);
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const listed = makeSession({ id: "alpha", machine: "fixture", title: "Alpha", model: "model-a", session_incarnation: "inc-1" });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions: [listed], machines: [{ name: "fixture", ok: true }] }),
    refreshSessionInfo,
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  const { UiExtensionsProvider, createUiExtensionRegistry, useSessionRefresh } =
    await ssr.loadModule<typeof import("../src/extensions.tsx")>("/src/extensions.tsx");
  let hook!: ReturnType<typeof useSessionRefresh>;
  let live: Record<string, unknown> | undefined;
  const Probe = () => { hook = useSessionRefresh(); return null; };
  const registry = createUiExtensionRegistry([{ id: "refresher", sessionBadges: [{ id: "probe", render: item => {
    live = item as Record<string, unknown>;
    return createElement(Probe);
  } }] }]);
  await act(async () => mounted.root.render(createElement(UiExtensionsProvider, { registry },
    createElement(Dashboard, { active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {},
      onDebug() {}, onUsage() {}, onSettings() {} }))));
  await waitForCondition(() => hook !== undefined && live !== undefined, "a mounted refresh consumer");
  return { mounted, refresh: (target: { machine: string; id: string }) => hook.refresh(target), live: () => live! };
}

const refreshReply = (id: string, incarnation: string) => ({ ok: true, changed: ["model"], unavailable: ["account"],
  session: { id, agent: "codex", session_incarnation: incarnation, model: "model-b" } });

test("the dashboard refresh control reports an unapplied reply as failed and applies a matching one", async () => {
  let answer = refreshReply("gone", "inc-1");
  const { refresh, live } = await mountRefreshDashboard(async () => answer);

  let state!: Awaited<ReturnType<typeof refresh>>;
  await act(async () => { state = await refresh({ machine: "fixture", id: "gone" }); });
  assert.equal(state.status, "failed", "a reply for a session the list no longer has is not reported as updated");

  answer = refreshReply("alpha", "inc-1");
  await act(async () => { state = await refresh({ machine: "fixture", id: "alpha" }); });
  assert.equal(state.status, "updated");
  assert.equal(live().model, "model-b");
});

test("a refresh that resolves while an activity update is still queued keeps both", async () => {
  const realFetch = globalThis.fetch;
  cleanupStack.push(async () => { globalThis.fetch = realFetch; });
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = (async (input: unknown) => String(input).startsWith("/api/activity/events")
    ? new Response(new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } }),
      { headers: { "content-type": "text/event-stream" } })
    : new Response("{}", { status: 404 })) as typeof fetch;
  let release!: (reply: unknown) => void;
  const { refresh, live } = await mountRefreshDashboard(() => new Promise(resolve => { release = resolve; }), { web: true });
  await waitForCondition(() => feed !== undefined, "the activity stream connection");

  const activity = serializeActivitySseEvent({
    schema_version: "agent-session.activity-stream.event.v1", type: "snapshot", stream_id: "boot-a", sequence: 1,
    machine: "fixture", observed_at: "2026-10-29T00:00:00Z",
    sessions: [{ id: "alpha", turn_state: {
      schema_version: "agent-session.turn-state.v1", phase: "working", phase_changed_at: "2026-10-29T00:00:00Z", revision: 1,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      current_turn: { started_at: "2026-10-29T00:00:00Z" }, last_turn: null,
    } }],
  } as Parameters<typeof serializeActivitySseEvent>[0]);
  let state!: Awaited<ReturnType<typeof refresh>>;
  await act(async () => {
    const pending = refresh({ machine: "fixture", id: "alpha" });
    feed.enqueue(new TextEncoder().encode(activity));
    // Let the stream deliver the event so its state update is queued, unrendered, before the refresh resolves.
    for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    release(refreshReply("alpha", "inc-1"));
    state = await pending;
  });
  assert.equal(state.status, "updated");
  assert.equal((live().turn_state as { phase?: string } | undefined)?.phase, "working", "the queued activity update survives");
  assert.equal(live().model, "model-b", "and the refreshed facts are applied");
  feed.close();
});

// Web and phone have no native title bar: a focused session carries its own
// count strip, with the logo on desktop and counts only on phones (#938).
async function mountFocusedCountsDashboard(width: number, props: Record<string, unknown> = {}) {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(mounted.window, "innerHeight", { configurable: true, value: width <= 760 ? 844 : 900 });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const phase = (value: string) => ({ phase: value }) as Session["turn_state"];
  const sessions = [
    makeSession({ id: "alpha", machine: "fixture", title: "Alpha", turn_state: phase("working") }),
    makeSession({ id: "beta", machine: "fixture", title: "Beta", turn_state: phase("working") }),
    makeSession({ id: "gamma", machine: "fixture", title: "Gamma", turn_state: phase("waiting") }),
    makeSession({ id: "delta", machine: "fixture", title: "Delta", status: "stopped" }),
  ];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions, machines: [{ name: "fixture", ok: true }] }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => mounted.root.render(createElement(Dashboard, { active: true, machines: ["fixture"], enabledMachines: ["fixture"],
    machineColors: {}, onDebug() {}, onUsage() {}, onSettings() {}, ...props })));
  const gridCounts = "Working: 2 sessions | Waiting: 1 session | Needs attention: 0 sessions | Stopped: 1 session";
  await waitForCondition(() => titleBarCountLabels(mounted.window.document.body).includes(gridCounts), "grid status counts");
  await openFirstSession(mounted, "Open Alpha");
  return { mounted, gridCounts, strip: () => mounted.container.querySelector(".terminal-slot.is-focused > .slot-focus-strip") };
}

test("the web single-session view shows the grid's status counts in a title strip with the logo (#938)", async () => {
  const { mounted, gridCounts, strip } = await mountFocusedCountsDashboard(1440);
  assert.ok(strip(), "the focused session has a title strip");
  assert.equal(titleBarCountLabels(strip()!), gridCounts);
  assert.ok(strip()!.querySelector("img.brand-title-icon"), "the strip leads with the logo");
  assertNoElement(mounted.container, ".slot-head .session-status-counts");
  const working = strip()!.querySelector<HTMLButtonElement>('.session-status-count[data-status-group="working"]')!;
  await act(async () => working.click());
  await waitForCondition(() => working.isConnected && working.getAttribute("aria-pressed") === "true", "status filter applied from the strip");
  assert.equal(titleBarCountLabels(strip()!), gridCounts, "a status filter keeps every group's count, as in the grid");
  assert.ok(mounted.container.querySelector(".terminal-slot.is-focused"), "the focused session stays open");
});

test("the phone single-session view shows the counts in a third row without the logo (#938)", async () => {
  const { gridCounts, strip } = await mountFocusedCountsDashboard(390);
  assert.ok(strip(), "the focused phone session has a count row");
  assert.equal(titleBarCountLabels(strip()!), gridCounts);
  assertNoElement(strip()!, "img.brand-title-icon");
});

test("a phone with counts off collapses the transient history notice row after dismissal (#938)", async () => {
  const { mounted, strip } = await mountFocusedCountsDashboard(390, { phoneFocusCounts: false });
  assert.ok(strip()?.querySelector('.connection-notice.is-info'), "history fallback temporarily uses the count row");
  assertNoElement(mounted.container, ".terminal-slot.is-focused .session-status-counts");
  const dismiss = strip()!.querySelector<HTMLButtonElement>('[aria-label="Dismiss status notice"]');
  assert.ok(dismiss);
  await act(async () => dismiss.click());
  assertNoElement(mounted.container, ".terminal-slot.is-focused > .slot-focus-strip");
  assertNoElement(mounted.container, ".terminal-slot.is-focused .session-status-counts");
});

test("hiding the phone count row does not hide the desktop strip (#938)", async () => {
  const { gridCounts, strip } = await mountFocusedCountsDashboard(1280, { phoneFocusCounts: false });
  assert.equal(titleBarCountLabels(strip()!), gridCounts);
});

const titleBarCountLabels = (titleBar: Element) => [...titleBar.querySelectorAll(".session-status-count")]
  .map(button => button.getAttribute("aria-label")).join(" | ");
async function openFirstSession(mounted: ReturnType<typeof installDom>, label = "Open Test session") {
  await act(async () => {
    [...mounted.container.querySelectorAll<HTMLButtonElement>(`[aria-label="${label}"]`)].at(-1)!.click();
    await flushPromises();
  });
  await waitForCondition(() => mounted.container.querySelector(".terminal-slot.is-focused") !== null, "single-session view");
}

test("the macOS title bar counts ignore the single-session host select, like the grid (#938 review F1)", async () => {
  const dashboard = await mountHeldCountsDashboard(undefined, { macTitleBar: true });
  const gridCounts = titleBarCountLabels(dashboard.titleBarCounts);
  assert.match(gridCounts, /Working: 2 sessions/);
  await openFirstSession(dashboard.mounted);
  assert.equal(titleBarCountLabels(dashboard.titleBarCounts), gridCounts);
  const hostSelect = dashboard.mounted.container.querySelector<HTMLSelectElement>('select[aria-label="Filter sessions by machine"]')!;
  await setSessionFilter(dashboard.mounted, "Filter sessions by machine", [...hostSelect.options].at(-1)!.value);
  assert.equal(titleBarCountLabels(dashboard.titleBarCounts), gridCounts, "picking one host in the single-session view keeps the grid's counts");
});

test("the macOS title bar counts mark partial and unknown hosts while a session is open (#938 review F2)", async () => {
  const dashboard = await mountHeldCountsDashboard(undefined, { macTitleBar: true });
  const observed = titleBarCountLabels(dashboard.titleBarCounts);
  assert.match(observed, /Working: 2 sessions/);
  await openFirstSession(dashboard.mounted);
  dashboard.setHostCooling(true);
  await dashboard.poll();
  assert.equal(titleBarCountLabels(dashboard.titleBarCounts), observed.split(" | ").map(label => `${label} (partial counts)`).join(" | "));
  assert.ok(dashboard.titleBarCounts.querySelector(".header-counts-notice"), "the offline-host notice travels with the counts");
  dashboard.advance(60_001);
  await dashboard.poll();
  assert.equal(titleBarCountLabels(dashboard.titleBarCounts), "Working: 1 session (partial counts) | Waiting: 0 sessions (partial counts) | Needs attention: 0 sessions (partial counts) | Stopped: 0 sessions (partial counts)",
    "an expired host stops contributing");
});

test("the macOS title bar counts show unknown totals, not zero, when no host can be counted (#938 review F2)", async () => {
  const dashboard = await mountHeldCountsDashboard(undefined, { macTitleBar: true, firstHostOnly: true });
  await openFirstSession(dashboard.mounted);
  dashboard.setHostCooling(true);
  await dashboard.poll();
  dashboard.advance(60_001);
  await dashboard.poll();
  assert.ok(dashboard.mounted.container.querySelector(".terminal-slot.is-focused"), "the focused session stays open");
  assert.equal(titleBarCountLabels(dashboard.titleBarCounts).replaceAll(" (partial counts)", ""),
    "Working: – sessions | Waiting: – sessions | Needs attention: – sessions | Stopped: – sessions");
});

test("the macOS title bar counts keep the applied filters while a session is open (#938 review F2)", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const titleBarCounts = mounted.window.document.createElement("div");
  titleBarCounts.id = "mac-titlebar-counts";
  mounted.window.document.body.prepend(titleBarCounts);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const lead = makeSession({ id: "lead", machine: "host-a", title: "Coordinator", role: "coordinator", coordinator_tree: { depth: 0 } });
  const child = makeSession({ id: "child", machine: "host-a", title: "Child", turn_state: { phase: "working" } as Session["turn_state"],
    dispatched_by: { machine: "host-a", session_id: "lead", repo_name: "example" }, coordinator_tree: { depth: 1 } });
  const outside = makeSession({ id: "outside", machine: "host-a", title: "Outside", agent: "claude", turn_state: { phase: "working" } as Session["turn_state"] });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions: [lead, child, outside], machines: [{ name: "host-a", ok: true }] }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, { active: true, machines: ["host-a"], enabledMachines: ["host-a"], machineColors: {},
      onDebug: () => {}, onUsage: () => {}, onSettings: () => {} }));
    await flushPromises();
  });
  await openSessionFilters(mounted);
  await setSessionFilter(mounted, "Filter sessions by harness", "codex");
  await act(async () => {
    [...mounted.container.querySelectorAll<HTMLButtonElement>(".session-filter-panel-actions button")]
      .find(button => button.textContent === "Apply filters")!.click();
    await flushPromises();
  });
  const gridCounts = titleBarCountLabels(titleBarCounts);
  assert.match(gridCounts, /^Working: 1 session \|/, "the harness filter counts only the matching working child");
  await openFirstSession(mounted, "Open Child");
  assert.equal(titleBarCountLabels(titleBarCounts), gridCounts);
});

test("mounted existing Conversation tiles select on pointer and keyboard focus", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 1440 });
  cleanupStack.push(mounted.cleanup);
  const first = makeSession({ id: "conversation-first", machine: "fixture", title: "First conversation",
    provider_resume: { provider: "codex", session_id: "thread-first" } });
  const second = makeSession({ id: "conversation-second", machine: "fixture", title: "Second conversation",
    provider_resume: { provider: "codex", session_id: "thread-second" } });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions: [first, second], machines: [{ name: "fixture", ok: true, capabilities: { history: true } }] }),
    listHistorySessions: async machine => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [first, second].map((session, index) => ({
      id: `history-${index}`, machine, provider: "codex" as const,
      provider_session_id: session.provider_resume?.session_id ?? "", title: session.title,
      cwd: "/workspace", created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z", resumable: true,
    })) }),
    listHistoryMessages: async (_machine, id) => ({ ok: true, messages: [
      { id: `message-${id}`, role: "assistant" as const, text: "[Keyboard target](https://example.test)" },
    ] }),
  };
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  const props = { active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {},
    defaultAutoResume: false, terminalRenderMode: "realtime" as const, terminalSelectedPaneRealtime: true,
    onDebug() {}, onUsage() {}, onSettings() {} };
  await act(async () => mounted.root.render(createElement(Dashboard, { ...props, sessionListDisplay: "terminal" })));
  await waitForCondition(() => mounted.container.querySelectorAll(".terminal-slot .terminal-pane").length === 2, "two existing Terminal tiles");

  const firstKey = "fixture/conversation-first";
  const secondKey = "fixture/conversation-second";
  const firstTerminalInput = mounted.container.querySelector<HTMLTextAreaElement>(
    `.terminal-slot[data-slot-key="${firstKey}"] .terminal-input`,
  );
  assert.ok(firstTerminalInput);
  await act(async () => firstTerminalInput.focus());
  await waitForCondition(() => mounted.container.querySelector(`.terminal-slot[data-slot-key="${firstKey}"].is-cmd-focus-target`) !== null,
    "Terminal pane focus to select the first existing tile");
  const secondOpenButton = mounted.container.querySelector<HTMLButtonElement>(
    `.terminal-slot[data-slot-key="${secondKey}"] .slot-open`,
  );
  assert.ok(secondOpenButton);
  await act(async () => secondOpenButton.focus());
  assert.ok(mounted.container.querySelector(`.terminal-slot[data-slot-key="${firstKey}"].is-cmd-focus-target`),
    "keyboard focus on another Terminal tile's header must preserve the selected terminal");

  const terminalTarget = mounted.container.querySelector<HTMLElement>(`.terminal-slot[data-slot-key="${secondKey}"] .slot-terminal-wrap`);
  assert.ok(terminalTarget);
  await act(async () => terminalTarget.dispatchEvent(new mounted.window.MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  await waitForCondition(() => mounted.container.querySelector(`.terminal-slot[data-slot-key="${secondKey}"].is-cmd-focus-target`) !== null,
    "Terminal mode to select the clicked existing tile");

  await act(async () => mounted.root.render(createElement(Dashboard, { ...props, sessionListDisplay: "conversation" })));
  await waitForCondition(() => mounted.container.querySelectorAll(".slot-conversation-pane").length === 2, "two existing Conversation tiles");
  const firstConversation = mounted.container.querySelector<HTMLElement>(`.terminal-slot[data-slot-key="${firstKey}"] .slot-conversation-pane`);
  assert.ok(firstConversation);
  await act(async () => firstConversation.dispatchEvent(new mounted.window.MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  await waitForCondition(() => mounted.container.querySelector(`.terminal-slot[data-slot-key="${firstKey}"].is-cmd-focus-target`) !== null,
    "Conversation mode to select the clicked existing tile");
  assertNoElement(mounted.container, ".conversation-dock");

  const secondLink = mounted.container.querySelector<HTMLAnchorElement>(`.terminal-slot[data-slot-key="${secondKey}"] .slot-conversation-pane a`);
  assert.ok(secondLink);
  await act(async () => secondLink.focus());
  await waitForCondition(() => mounted.container.querySelector(`.terminal-slot[data-slot-key="${secondKey}"].is-cmd-focus-target`) !== null,
    "Conversation mode to select the tile receiving keyboard focus");
});

test("mounted Dashboard measures header compaction as usage arrives and expands on resize", async () => {
  const mounted = installDom();
  let width = 1920;
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, get: () => width });
  mounted.window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 760px") ? width <= 760 : false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  })) as typeof mounted.window.matchMedia;
  let observedHeader: Node | null = null;
  let observedOptions: MutationObserverInit | undefined;
  let notifyMutation!: () => void;
  class HeaderMutationObserver {
    constructor(callback: MutationCallback) {
      notifyMutation = () => {
        if (observedHeader !== null) callback([], this as unknown as MutationObserver);
      };
    }
    observe(target: Node, options?: MutationObserverInit) {
      observedHeader = target;
      observedOptions = options;
    }
    disconnect() {}
    takeRecords(): MutationRecord[] { return []; }
  }
  Object.defineProperty(mounted.window, "MutationObserver", {
    configurable: true,
    value: HeaderMutationObserver,
  });

  // Happy DOM supplies no CSS geometry. Controlled bounds verify that the real
  // effect re-measures after insertion and resize; Chrome owns real fit tests.
  const nativeBounds = mounted.window.HTMLElement.prototype.getBoundingClientRect;
  mounted.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const stage = Number(this.closest<HTMLElement>(".workspace-head")?.dataset.headerCompact ?? 0);
    const isHeader = this.classList.contains("workspace-head");
    const needsLayout = this.classList.contains("layout-picker") && width < 1500 && stage < 1;
    const needsUsage = this.classList.contains("header-usage") && width < 1000 && stage < 2;
    const w = isHeader ? width : needsLayout || needsUsage ? width + 10 : 0;
    return { x:0,y:0,left:0,top:0,right:w,bottom:40,width:w,height:40,toJSON:()=>({}) } as DOMRect;
  };
  cleanupStack.push(() => { mounted.window.HTMLElement.prototype.getBoundingClientRect = nativeBounds; });
  cleanupStack.push(mounted.cleanup);

  let releaseUsage!: (value: { readonly providers: readonly unknown[]; readonly reachable: boolean }) => void;
  let usageRequested = false;
  const usagePromise = new Promise<{ readonly providers: readonly unknown[]; readonly reachable: boolean }>((resolve) => {
    releaseUsage = resolve;
  });
  const session = makeSession({ id: "header-responsive", status: "running" });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{ name: "summit", ok: true, capabilities: { history: true } }],
    }),
    usage: async () => {
      usageRequested = true;
      return usagePromise;
    },
  };
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: false,
      onDebug() {},
      onUsage() {},
      onSettings() {},
    }));
    await flushPromises();
  });
  await waitForCondition(() => usageRequested, "the initial usage request");
  assert.equal(mounted.container.querySelector(".workspace-head")?.getAttribute("data-header-compact"), "0");
  const mountedHeader = mounted.container.querySelector(".workspace-head");
  assert.equal(mountedHeader !== null, true, "mounted Dashboard renders its header");
  if (mountedHeader === null) assert.fail("mounted Dashboard header is missing");
  await waitForCondition(() => observedHeader === mountedHeader, "Dashboard header MutationObserver subscription");
  const observesHeader = observedHeader === mountedHeader;
  assert.equal(observesHeader, true, "Dashboard subscribes its MutationObserver to the mounted header");
  assert.equal(observedOptions?.childList, true, "header subscription observes child insertion");
  assert.equal(observedOptions?.subtree, true, "header subscription observes nested usage insertion");
  assert.equal(observedOptions?.characterData, true, "header subscription observes label updates");

  const changeWidth = async (nextWidth: number, expectedStage: string | null) => {
    width = nextWidth;
    await act(async () => {
      mounted.window.dispatchEvent(new mounted.window.Event("resize"));
      await flushPromises();
    });
    await waitForCondition(
      () => mounted.container.querySelector(".workspace-head")?.getAttribute("data-header-compact") === expectedStage,
      `header stage ${expectedStage ?? "expanded mobile layout"} at ${nextWidth}px`,
    );
  };
  await changeWidth(800, "1");
  await act(async () => {
    releaseUsage({ providers: [{ provider:"codex",account:null,label:"Codex",ok:true,stale:false,plan:null,
      windows:[{key:"5h",label:"5h",used_percent:30,window_minutes:300,resets_at:null}],updated_at:Date.now()/1000,
      note:null,error:null,reason_code:null }], reachable:true });
    await flushPromises();
  });
  await waitForCondition(() => mounted.container.querySelector(".header-usage") !== null, "usage arrival");
  await act(async () => notifyMutation());
  assert.equal(mountedHeader.dataset.headerCompact,"2","late Usage insertion triggers measurement");
  await changeWidth(1920,"0");
  // Phones keep the fixed two-row header (#930) and are not measured.
  await changeWidth(390, null);
});

const cleanupStack: Array<() => Promise<void> | void> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await flushPromises();
    });
  }
  assert.fail(`Timed out waiting for ${description}`);
}

// The browser deadline of a default (Codex) create, with or without a prompt.
function isCodexCreateDeadline(timeout: number | undefined): boolean {
  return timeout === createRequestTimeoutMs({ agent: "codex" })
    || timeout === createRequestTimeoutMs({ agent: "codex", prompt: "x" });
}

afterEach(async () => {
  delete globalThis.__agentConsoleDashboardBehaviorApiMock;
  delete globalThis.__agentConsoleDashboardPollTask;
  delete globalThis.__agentConsoleTerminalKeys;
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

interface DashboardBehaviorApiMock {
  readonly listHistorySessions?: (
    machine: string,
    options: { readonly q?: string; readonly limit?: number },
  ) => Promise<HistorySessionsResponse>;
  readonly listHistoryMessages?: (machine: string, id: string) => Promise<HistoryMessagesResponse>;
  readonly resumeHistorySession?: (
    machine: string,
    historyId: string,
  ) => Promise<{ readonly ok: boolean; readonly id?: string; readonly error?: string }>;
  readonly archiveSession?: (
    machine: string,
    id: string,
    expectedSessionIncarnation: string,
    options?: { readonly starred?: boolean },
  ) => Promise<{ readonly ok: boolean; readonly error?: string; readonly starredAt?: string }>;
  readonly createSession?: (
    machine: string,
    body: CreateBody,
  ) => Promise<{
    readonly ok: boolean;
    readonly id?: string;
    readonly session?: Session;
    readonly error?: string;
    readonly outcomeUnknown?: boolean;
    readonly startup?: StartupStatus | null;
  }>;
  readonly fetchLayoutOrder?: () => Promise<LayoutOrderResult>;
  readonly fetchRepoRemoteUrl?: (machine: string, cwd?: string | null) => Promise<string>;
  readonly glance?: (machine: string, id: string, tail?: number) => Promise<unknown>;
  readonly killSession?: (machine: string, id: string) => Promise<{
    readonly ok: boolean;
    readonly error?: string;
    readonly cleanupPending?: boolean;
  }>;
  readonly previewMainAgentGroupCleanup?: (
    machine: string,
    id: string,
  ) => Promise<any>;
  readonly executeMainAgentGroupCleanup?: (
    machine: string,
    id: string,
    request: unknown,
  ) => Promise<any>;
  readonly executeMainAgentGroupArchive?: (
    machine: string,
    id: string,
    request: unknown,
  ) => Promise<any>;
  readonly inspectSessionMaintenance?: (
    machine: string,
    id: string,
    operation: MaintenanceOperation,
    signal?: AbortSignal,
  ) => Promise<MaintenancePreviewResult>;
  readonly executeSessionMaintenanceAction?: (
    machine: string,
    id: string,
    request: SessionMaintenanceActionRequest,
  ) => Promise<MaintenanceActionApiResult>;
  readonly listSessions?: (machines?: readonly string[]) => Promise<SessionsResponse>;
  readonly resetSessionPollRequests?: () => void;
  readonly listAccounts?: (
    provider: AccountProvider,
    machine: string,
    signal?: AbortSignal,
  ) => Promise<AccountInventory>;
  readonly switchSessionAccount?: (
    provider: AccountProvider,
    machine: string,
    id: string,
    account: string,
    expectedSessionIncarnation: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string; readonly outcomeUnknown?: boolean }>;
  readonly putLayoutOrder?: (
    order: readonly string[],
    options?: { readonly baseRevision?: number | null; readonly reason?: string; readonly keepalive?: boolean },
  ) => Promise<LayoutOrderResult>;
  readonly resumeSession?: (machine: string, id: string) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  readonly restartRuntime?: (machine: string) => Promise<{
    readonly ok: boolean;
    readonly machine?: string;
    readonly error?: string;
  }>;
  readonly setSessionAutoResume?: (
    machine: string,
    id: string,
    enabled: boolean,
    signal?: AbortSignal,
    recoveryPolicy?: "wait_for_reset" | "next_account_then_resume",
  ) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  readonly cancelSessionAutoResume?: (
    machine: string,
    id: string,
  ) => Promise<{ readonly ok: boolean; readonly error?: string }>;
  readonly searchWorkdirs?: (machine: string, query: string, limit?: number) => Promise<readonly unknown[]>;
  readonly sendSessionInput?: (
    machine: string,
    id: string,
    body: SendSessionInputBody,
  ) => Promise<{ readonly ok: boolean; readonly error?: string; readonly outcomeUnknown?: boolean }>;
  readonly submitSessionPrompt?: (
    machine: string,
    id: string,
    body: { readonly text: string; readonly expected_session_incarnation?: string },
  ) => Promise<{ readonly ok: boolean; readonly error?: string; readonly outcomeUnknown?: boolean }>;
  readonly summarizeSessionTitle?: (body: unknown) => Promise<TitleSummaryResult>;
  readonly updateSessionTitle?: (
    machine: string,
    id: string,
    title: string | null,
    signal?: AbortSignal,
    expectedTitleRevision?: number,
    expectedSessionIncarnation?: string,
    expectedSessionTitle?: string | null,
    titleState?: SessionTitleState | null,
  ) => Promise<{
    readonly ok: boolean;
    readonly error?: string;
    readonly titleRevision?: number;
  }>;
  readonly usage?: () => Promise<{ readonly providers: readonly unknown[]; readonly reachable: boolean; readonly error?: string }>;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentConsoleDashboardBehaviorApiMock: DashboardBehaviorApiMock | undefined;
  // eslint-disable-next-line no-var
  var __agentConsoleDashboardPollTask: (() => Promise<void> | void) | undefined;
  // eslint-disable-next-line no-var
  var __agentConsoleTerminalKeys: string[] | undefined;
}

function terminalPaneMockPlugin(): Plugin {
  const mockId = "\0dashboard-behavior-terminal-pane-mock";
  return {
    name: "dashboard-behavior-terminal-pane-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("TerminalPane.tsx") && importer?.includes("/src/")) {
        return mockId;
      }
      return null;
    },
    load(id) {
      if (id !== mockId) {
        return null;
      }
      return `
        import { createElement, useEffect, useRef } from "react";
        export function TerminalPane(props) {
          const inputRef = useRef(null);
          const handledFocusRequestRef = useRef(0);
          useEffect(() => {
            if (!props.focusRequestToken || handledFocusRequestRef.current === props.focusRequestToken) {
              return;
            }
            handledFocusRequestRef.current = props.focusRequestToken;
            inputRef.current?.focus();
          }, [props.focusRequestToken]);
          return createElement("div", {
            className: "terminal-pane",
            "data-terminal-id": props.id,
            "data-auto-focus": String(props.autoFocus),
            "data-interactive": String(props.interactive),
            "data-layout-sync-key": props.layoutSyncKey,
            "data-focus-request-token": String(props.focusRequestToken ?? 0),
            "data-reconnect-token": String(props.reconnectToken ?? 0),
          }, createElement("textarea", {
            ref: inputRef,
            className: "terminal-input",
            onFocus: props.onPromptFocus,
            onKeyDown: (event) => {
              if (!event.metaKey && !event.ctrlKey && !event.altKey) {
                globalThis.__agentConsoleTerminalKeys?.push(event.key);
              }
            },
          }));
        }
      `;
    },
  };
}

function asyncPollMockPlugin(): Plugin {
  const mockId = "\0dashboard-behavior-async-poll-mock";
  return {
    name: "dashboard-behavior-async-poll-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("useAsyncPoll.ts") && importer?.includes("/src/Dashboard.tsx")) {
        return mockId;
      }
      return null;
    },
    load(id) {
      if (id !== mockId) {
        return null;
      }
      return `
        export function useAsyncPoll(task) {
          globalThis.__agentConsoleDashboardPollTask = () => task({
            signal: new AbortController().signal,
            isCurrent: () => true,
          });
        }
      `;
    },
  };
}

function stagedPromptCreateDialogMockPlugin(
  prompt = "Inspect startup ordering",
  machine = "summit",
  createBody: Partial<CreateBody> = { agent: "codex" },
): Plugin {
  const mockId = "\0dashboard-behavior-create-dialog-mock";
  return {
    name: "dashboard-behavior-create-dialog-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("CreateDialog.tsx") && importer?.includes("/src/")) {
        return mockId;
      }
      return null;
    },
    load(id) {
      if (id !== mockId) {
        return null;
      }
      return `
        import { createElement } from "react";
        const stagedPrompt = ${JSON.stringify(prompt)};
        const targetMachine = ${JSON.stringify(machine)};
        const createBody = ${JSON.stringify(createBody)};
        export function CreateDialog(props) {
          return createElement("div", null,
            createElement("span", { "data-create-machines": props.machines.join(",") }),
            createElement("textarea", {
              "aria-label": "Initial prompt",
              readOnly: true,
              value: stagedPrompt,
            }),
            props.error ? createElement("p", null, props.error) : null,
            createElement("button", {
              onClick: () => props.onCreate(targetMachine, {
                ...createBody,
                prompt: stagedPrompt,
              }),
            }, "Create"),
          );
        }
      `;
    },
  };
}

function queuedPromptCreateDialogMockPlugin(): Plugin {
  const mockId = "\0dashboard-behavior-queued-create-dialog-mock";
  return {
    name: "dashboard-behavior-queued-create-dialog-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("CreateDialog.tsx") && importer?.includes("/src/")) {
        return mockId;
      }
      return null;
    },
    load(id) {
      if (id !== mockId) {
        return null;
      }
      return `
        import { createElement } from "react";
        const prompts = [
          "First retained prompt",
          "Second retained prompt",
          "Third retained prompt",
          "Fourth retained prompt",
          "Fifth retained prompt",
        ];
        let nextPrompt = 0;
        export function CreateDialog(props) {
          return createElement("button", {
            onClick: () => props.onCreate("summit", {
              agent: "codex",
              prompt: prompts[nextPrompt++] ?? "Unexpected prompt",
            }),
          }, "Create");
        }
      `;
    },
  };
}

function dashboardApiMockPlugin(): Plugin {
  const mockId = "\0dashboard-behavior-api-mock";
  return {
    name: "dashboard-behavior-api-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("api.ts") && importer?.includes("/src/")) {
        return mockId;
      }
      return null;
    },
    load(id) {
      if (id !== mockId) {
        return null;
      }
      return `
        const mock = () => globalThis.__agentConsoleDashboardBehaviorApiMock ?? {};
        const ok = async () => ({ ok: true });
        const layout = (order = []) => ({ order, revision: null, reachable: false, conflict: false });
        export const archiveSession = (...args) => mock().archiveSession?.(...args) ?? ok();
        export const createSession = (...args) => mock().createSession?.(...args) ?? ok();
        export const fetchLayoutOrder = (...args) => mock().fetchLayoutOrder?.(...args) ?? Promise.resolve(layout());
        export const fetchRepoRemoteUrl = (...args) => mock().fetchRepoRemoteUrl?.(...args) ?? Promise.resolve("");
        export const glance = (...args) => mock().glance?.(...args) ?? Promise.resolve(null);
        export const killSession = (...args) => mock().killSession?.(...args) ?? ok();
        export const previewMainAgentGroupCleanup = (...args) => mock().previewMainAgentGroupCleanup?.(...args) ?? Promise.resolve({ ok: false, error: "group cleanup unavailable" });
        export const executeMainAgentGroupCleanup = (...args) => mock().executeMainAgentGroupCleanup?.(...args) ?? Promise.resolve({ ok: false, error: "group cleanup unavailable" });
        export const executeMainAgentGroupArchive = (...args) => mock().executeMainAgentGroupArchive?.(...args) ?? Promise.resolve({ ok: false, error: "group archive unavailable" });
        export const inspectSessionMaintenance = (...args) => mock().inspectSessionMaintenance?.(...args) ?? Promise.resolve({ ok: false, error: "maintenance unavailable", unsupported: true });
        export const executeSessionMaintenanceAction = (...args) => mock().executeSessionMaintenanceAction?.(...args) ?? Promise.resolve({ ok: false, error: "maintenance unavailable" });
        export const listHistorySessions = (...args) => mock().listHistorySessions?.(...args) ?? Promise.resolve({ ok: true, sessions: [], truncated: false });
        export const listHistoryMessages = (...args) => mock().listHistoryMessages?.(...args) ?? Promise.resolve({ ok: true, messages: [] });
        export const resumeHistorySession = (...args) => mock().resumeHistorySession?.(...args) ?? Promise.resolve({ ok: false, error: "history resume unavailable" });
        export const listSessions = (...args) => mock().listSessions?.(...args) ?? Promise.resolve({ ok: true, sessions: [], machines: [] });
        export const resetSessionPollRequests = (...args) => mock().resetSessionPollRequests?.(...args);
        export const listAccounts = (...args) => mock().listAccounts?.(...args) ?? Promise.resolve({ accounts: [] });
        export const switchSessionAccount = (...args) => mock().switchSessionAccount?.(...args) ?? ok();
        export const putLayoutOrder = (order, ...args) => mock().putLayoutOrder?.(order, ...args) ?? Promise.resolve(layout(order));
        export const refreshSessionInfo = (...args) => mock().refreshSessionInfo?.(...args) ?? Promise.resolve({ ok: false, error: "refresh unavailable" });
        export const resumeSession = (...args) => mock().resumeSession?.(...args) ?? ok();
        export const restartRuntime = (...args) => mock().restartRuntime?.(...args) ?? ok();
        export const setSessionAutoResume = (...args) => mock().setSessionAutoResume?.(...args) ?? ok();
        export const cancelSessionAutoResume = (...args) => mock().cancelSessionAutoResume?.(...args) ?? ok();
        export const searchWorkdirs = (...args) => mock().searchWorkdirs?.(...args) ?? Promise.resolve([]);
        export const sendSessionInput = (...args) => mock().sendSessionInput?.(...args) ?? ok();
        export const submitSessionPrompt = (...args) => mock().submitSessionPrompt?.(...args) ?? ok();
        export const summarizeSessionTitle = (...args) => mock().summarizeSessionTitle?.(...args) ?? ok();
        export const updateSessionTitle = (...args) => mock().updateSessionTitle?.(...args) ?? ok();
        export const usage = (...args) => mock().usage?.(...args) ?? Promise.resolve({ providers: [], reachable: false });
      `;
    },
  };
}

function installDom(options: { readonly web?: boolean } = {}): {
  readonly window: Window;
  readonly root: Root;
  readonly container: HTMLElement;
  cleanup(): Promise<void>;
} {
  const window = new Window({ url: options.web ? "https://console.test" : "tauri://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    localStorage: globalThis.localStorage,
    navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  if (!options.web) Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let cleaned = false;
  return {
    window,
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
        window: previous.window,
        document: previous.document,
        Element: previous.Element,
        HTMLElement: previous.HTMLElement,
        HTMLInputElement: previous.HTMLInputElement,
        HTMLTextAreaElement: previous.HTMLTextAreaElement,
        HTMLSelectElement: previous.HTMLSelectElement,
        KeyboardEvent: previous.KeyboardEvent,
        MouseEvent: previous.MouseEvent,
        Event: previous.Event,
        localStorage: previous.localStorage,
        IS_REACT_ACT_ENVIRONMENT: previous.IS_REACT_ACT_ENVIRONMENT,
      });
      if (previous.navigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", previous.navigatorDescriptor);
      } else {
        delete (globalThis as { navigator?: Navigator }).navigator;
      }
      await window.happyDOM.close();
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function metaKey(window: Window, key: string): KeyboardEvent {
  return new window.KeyboardEvent("keydown", {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
}

function primaryPointerDown(window: Window): Event {
  const event = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "button", { value: 0 });
  return event;
}

function doubleClick(window: Window): MouseEvent {
  return new window.MouseEvent("dblclick", { bubbles: true, cancelable: true });
}

function slotKeys(container: HTMLElement): Array<string | null> {
  return [...container.querySelectorAll<HTMLElement>(".terminal-slot")].map((slot) => slot.dataset.slotKey ?? null);
}

async function assertSessionRemovalCompactsFocusedGrid(operation: "archive" | "delete"): Promise<void> {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  let liveSessions: Session[] = ["a", "b", "c", "d", "e", "f"].map((id) => makeSession({
    id,
    machine: "summit",
    title: `Session ${id.toUpperCase()}`,
    status: "stopped",
    session_incarnation: `${id}-incarnation`,
    provider_resume: { provider: "codex", session_id: `provider-${id}` },
  }));
  const order = liveSessions.map(sessionKey);
  const persistedOrders: string[][] = [];
  const remove = (id: string) => {
    liveSessions = liveSessions.filter((session) => session.id !== id);
    return Promise.resolve({ ok: true } as const);
  };
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    fetchLayoutOrder: async () => ({ reachable: true, order, revision: 1 }),
    putLayoutOrder: async (nextOrder) => {
      persistedOrders.push([...nextOrder]);
      return { reachable: true, order: nextOrder, revision: 2 };
    },
    listSessions: async () => ({
      ok: true,
      sessions: liveSessions,
      machines: [{
        name: "summit",
        ok: true,
        capabilities: { history: true, archive: true },
      }],
    }),
    archiveSession: async (_machine, id) => remove(id),
    killSession: async (_machine, id) => remove(id),
  };
  mounted.window.localStorage.setItem(MODE_STORAGE, "4");
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(order.slice(0, 4)));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await act(async () => {
    mounted.container.querySelectorAll<HTMLButtonElement>(".slot-action.danger")[1]?.click();
    await flushPromises();
  });
  if (operation === "delete") {
    const deleteInstead = mounted.container.querySelector<HTMLInputElement>(
      '.close-session-delete-option input[type="checkbox"]',
    );
    assert.ok(deleteInstead);
    await act(async () => {
      deleteInstead.click();
      await flushPromises();
    });
  }
  await act(async () => {
    findTextButton(mounted.container, operation === "archive" ? "Archive session" : "Delete session").click();
    await flushPromises();
  });

  const expected = ["summit/a", "summit/c", "summit/d", "summit/e"];
  await waitForCondition(
    () => JSON.stringify(slotKeys(mounted.container)) === JSON.stringify(expected),
    `${operation} overview to compact`,
  );
  const expectedSharedOrder = [...expected, "summit/f"];
  await waitForCondition(
    () => JSON.stringify(persistedOrders[persistedOrders.length - 1]) === JSON.stringify(expectedSharedOrder),
    `${operation} shared order to retain ranked overflow`,
  );
  assert.deepEqual(persistedOrders[persistedOrders.length - 1], expectedSharedOrder);
  const sessionC = mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/c"]');
  assert.ok(sessionC);
  await act(async () => {
    sessionC.dispatchEvent(doubleClick(mounted.window));
    await flushPromises();
  });

  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey,
    "summit/c",
  );
  assert.deepEqual(slotKeys(mounted.container), expected);
  assert.equal(mounted.window.localStorage.getItem(SLOTS_STORAGE), JSON.stringify(expected));
}

function findTextButton(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  assert.ok(button, `expected button containing "${text}"`);
  return button;
}

function findAriaButton(root: ParentNode, label: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  assert.ok(button, `expected button labelled "${label}"`);
  return button;
}

async function openSessionFilters(mounted: Awaited<ReturnType<typeof installDom>>): Promise<void> {
  await act(async () => {
    const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-filters-trigger");
    if (trigger) trigger.click();
    else assert.ok(mounted.container.querySelector(".session-filter-inline"), "desktop filters are already expanded");
    await flushPromises();
  });
}

async function setSessionFilter(mounted: Awaited<ReturnType<typeof installDom>>, label: string, value: string): Promise<void> {
  await act(async () => {
    const select = mounted.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    select.value = value;
    select.dispatchEvent(new mounted.window.Event("change", { bubbles: true }));
    await flushPromises();
  });
}

async function openRepairConfirmation(
  mounted: ReturnType<typeof installDom>,
  entrypoint: "menu" | "icon" = "menu",
): Promise<void> {
  await act(async () => {
    if (entrypoint === "icon") {
      const icon = mounted.container.querySelector<HTMLButtonElement>('.brand-title-mark-button');
      assert.ok(icon, "the app icon offers the repair confirmation shortcut");
      icon.click();
    } else {
      mounted.container.querySelector<HTMLElement>(".header-menu-trigger")!.click();
      await flushPromises();
      const repair = findTextButton(mounted.container.querySelector(".header-menu-dropdown")!, "Repair");
      assert.equal(repair.textContent?.trim(), "Repair");
      repair.click();
    }
    await flushPromises();
  });
}

async function confirmSessionRepair(mounted: ReturnType<typeof installDom>): Promise<void> {
  await act(async () => {
    findTextButton(mounted.container.querySelector('[aria-labelledby="repair-session-title"]')!, "Repair sessions").click();
    await flushPromises();
  });
}

async function setVisibleHosts(mounted: Awaited<ReturnType<typeof installDom>>, visible: readonly string[]): Promise<void> {
  const inputs = [...mounted.container.querySelectorAll<HTMLInputElement>(".session-filter-host input")];
  for (const input of inputs) {
    const name = input.value;
    const shouldShow = name !== undefined && visible.includes(name);
    if (input.checked !== shouldShow) await act(async () => {
      input.click();
      await flushPromises();
    });
  }
  await act(async () => {
    const show = [...mounted.container.querySelectorAll<HTMLButtonElement>(".session-filter-panel-actions button")]
      .find(button => button.textContent === "Apply filters");
    assert.ok(show, "filter sheet offers a Show action");
    show.click();
    await flushPromises();
  });
}

function maintenancePreview(
  session: Session,
  operation: MaintenanceOperation,
  digestByte = "8",
): SessionMaintenancePreview {
  const retry = operation === "delete"
    ? {
        id: "retry_delete" as const,
        label: "Retry delete",
        destructive: true,
        requires_confirmation: true,
        preserves_session_metadata: false,
      }
    : {
        id: "retry_resume" as const,
        label: "Retry resume",
        destructive: false,
        requires_confirmation: false,
        preserves_session_metadata: true,
      };
  const terminate = operation === "delete"
    ? {
        id: "terminate_runtime_then_delete" as const,
        label: "Terminate recorded runtime, then delete",
        destructive: true,
        requires_confirmation: true,
        preserves_session_metadata: false,
      }
    : {
        id: "terminate_runtime_then_resume" as const,
        label: "Terminate recorded runtime, then resume",
        destructive: true,
        requires_confirmation: true,
        preserves_session_metadata: true,
      };
  return {
    schema_version: "agent-session.session-maintenance.v1",
    session_id: session.id,
    operation,
    state: "repairable",
    session_incarnation: session.session_incarnation ?? "launch-1",
    session_generation: 1,
    issue: {
      kind: "process_boundary_live",
      operation,
      retryable: true,
      preserves_session_metadata: true,
      message: "the recorded runtime process boundary is still live",
    },
    boundary: { kind: "managed_scope", safe_process_count: 2 },
    preservation: {
      session_metadata_retained_until_success: true,
      provider_conversation_retained: true,
      destructive_scope: "verified_recorded_runtime_only",
    },
    actions: [retry, terminate],
    preview_digest: `sha256:${digestByte.repeat(64)}`,
  };
}

async function assertCreateFocusesOverflowSession(input: {
  readonly autoLayout: boolean;
  readonly layoutMode: LayoutMode;
  readonly existingCount: number;
  readonly firstReconciliationFails?: boolean;
  readonly firstReconciliationOmitsCreated?: boolean;
  readonly mobile?: boolean;
}): Promise<void> {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  if (input.mobile) {
    Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(mounted.window, "innerHeight", { configurable: true, value: 844 });
  }
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin("Focus the created session"),
  ]);
  cleanupStack.push(ssr.close);

  const existingSessions = Array.from({ length: input.existingCount }, (_, index) => makeSession({
    id: `existing-${index + 1}`,
    machine: "summit",
    title: `Existing ${index + 1}`,
    status: "running",
  }));
  const createdSession = makeSession({
    id: "created-overflow",
    machine: "summit",
    title: "New Codex session",
    status: "running",
  });
  let created = false;
  let postCreateListCalls = 0;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      created = true;
      return { ok: true, id: createdSession.id, session: createdSession };
    },
    listSessions: async () => {
      if (created) {
        postCreateListCalls += 1;
        if (input.firstReconciliationFails && postCreateListCalls === 1) {
          throw new Error("reconciliation unavailable");
        }
      }
      return {
        ok: true,
        sessions: created && !(input.firstReconciliationOmitsCreated && postCreateListCalls === 1)
          ? [...existingSessions, createdSession]
          : existingSessions,
        machines: [{ name: "summit", ok: true }],
      };
    },
    sendSessionInput: async () => ({ ok: true }),
  };

  mounted.window.localStorage.setItem(MODE_STORAGE, String(input.layoutMode));
  mounted.window.localStorage.setItem(AUTO_STORAGE, input.autoLayout ? "1" : "0");
  mounted.window.localStorage.setItem(
    SLOTS_STORAGE,
    JSON.stringify(existingSessions.slice(0, input.layoutMode).map((session) => `${session.machine}/${session.id}`)),
  );

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "1"));
    await flushPromises();
    mounted.window.dispatchEvent(metaKey(mounted.window, "f"));
    await flushPromises();
  });

  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await waitForCondition(
    () => mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey
      === "summit/created-overflow",
    "the created session to receive focus",
  );

  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey,
    "summit/created-overflow",
  );
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus")?.dataset.slotKey ?? null,
    null,
  );

  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "f"));
    await flushPromises();
  });
  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "f"));
    await flushPromises();
  });
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey,
    "summit/created-overflow",
  );
}

// The layout still has a free slot, so the new session stays in the grid list and
// only its pane becomes the keyboard target (no jump into the full-session view).
async function assertCreateGridFocusesSession(input: {
  readonly layoutMode: LayoutMode;
  readonly existingCount: number;
}): Promise<void> {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin("Focus the created session"),
  ]);
  cleanupStack.push(ssr.close);

  const existingSessions = Array.from({ length: input.existingCount }, (_, index) => makeSession({
    id: `existing-${index + 1}`,
    machine: "summit",
    title: `Existing ${index + 1}`,
    status: "running",
  }));
  const createdSession = makeSession({
    id: "created-grid",
    machine: "summit",
    title: "New Codex session",
    status: "running",
  });
  let created = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      created = true;
      return { ok: true, id: createdSession.id, session: createdSession };
    },
    listSessions: async () => ({
      ok: true,
      sessions: created ? [...existingSessions, createdSession] : existingSessions,
      machines: [{ name: "summit", ok: true }],
    }),
    sendSessionInput: async () => ({ ok: true }),
  };

  mounted.window.localStorage.setItem(MODE_STORAGE, String(input.layoutMode));
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(
    SLOTS_STORAGE,
    JSON.stringify(existingSessions.map((session) => `${session.machine}/${session.id}`)),
  );

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await waitForCondition(
    () => mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus")?.dataset.slotKey
      === "summit/created-grid",
    "the created session to receive grid focus",
  );

  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey ?? null,
    null,
  );
  assert.ok(slotKeys(mounted.container).includes("summit/created-grid"));
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus")?.dataset.slotKey,
    "summit/created-grid",
  );
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus .terminal-pane")?.dataset.autoFocus,
    "true",
  );
}

function createHarness(SessionSlot: ComponentType<ReturnType<typeof makeSessionSlotProps>>) {
  return function Harness() {
  const [focusedKey, setFocusedKey] = useState<string | null>(keys[0]);
  const [lastInteractedKey, setLastInteractedKey] = useState<string | null>(null);
  const lastFocusedKeyRef = useRef<string | null>(keys[0]);
  const lastInteractedKeyRef = useRef<string | null>(null);
  const sessions: Session[] = keys.map((key) => {
    const id = key.split("/")[1] ?? key;
    return makeSession({
      id,
      machine: "summit",
      title: `Session ${id.toUpperCase()}`,
      status: "running",
    });
  });

  useEffect(() => {
    if (focusedKey !== null) {
      lastFocusedKeyRef.current = focusedKey;
    }
  }, [focusedKey]);

  const openSessionByShortcutIndex = (index: number) => {
    const key = keys[index] ?? null;
    if (key) {
      rememberSessionInteraction(key);
      setFocusedKey(key);
    }
  };
  const toggleFocusList = () => {
    if (focusedKey !== null) {
      setFocusedKey(null);
      return;
    }
    const target = resolveToggleFocusTarget({
      selectedKey: lastInteractedKeyRef.current,
      activeTerminalKey: null,
      rememberedKey: lastFocusedKeyRef.current,
      shortcutSessionKeys: keys,
    });
    if (target) {
      openSessionByShortcutIndex(keys.indexOf(target as (typeof keys)[number]));
    }
  };
  const rememberSessionInteraction = (key: string) => {
    lastInteractedKeyRef.current = key;
    setLastInteractedKey(key);
  };
  const cmdFocusTargetKey =
    focusedKey === null
      ? resolveToggleFocusTarget({
          selectedKey: lastInteractedKey,
          activeTerminalKey: null,
          rememberedKey: lastFocusedKeyRef.current,
          shortcutSessionKeys: keys,
        })
      : null;

  useDashboardKeyboard({
    active: true,
    autoLayout: false,
    autoDesktopMode: 4,
    closeFocusedSession: async () => {},
    closeOpenSlotMenus: () => {},
    focusAdjacentSession: () => {},
    isEditableShortcutTarget: () => false,
    isTerminalShortcutTarget: () => false,
    onUsage: () => {},
    onPagePrevious: () => {},
    onPageNext: () => {},
    openSessionByShortcutIndex,
    reconnectFocusedSession: () => {},
    renameFocusedSession: () => {},
    repairSessions: async () => {},
    retitleFocusedSession: async () => {},
    setAutoLayout: () => {},
    setFocusedKey,
    setLayoutMode: (() => {}) as Dispatch<SetStateAction<LayoutMode>>,
    setPendingSlot: () => {},
    setShowCreate: () => {},
    toggleFocusList,
  });

  return createElement(
    "ol",
    { className: `session-workspace desktop${focusedKey ? " is-focused" : ""}` },
    keys.map((slot, index) =>
      createElement(SessionSlot, {
        key: slot,
        ...makeSessionSlotProps({
          slot,
          index,
          session: sessions[index],
          options: sessions,
          focused: focusedKey === slot,
          cmdFocusTarget: cmdFocusTargetKey === slot,
          focusedKey,
          sessionOrdinal: index + 1,
          sessionCount: keys.length,
          setFocusedKey,
          rememberSessionInteraction,
        }),
      }),
    ),
  );
  };
}

test("Dashboard joins its initial session read when polling starts", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), asyncPollMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const initial = deferred<SessionsResponse>();
  let calls = 0;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => {
      calls += 1;
      return calls === 1 ? initial.promise : { ok: true, sessions: [], machines: [] };
    },
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  assert.equal(calls, 1);
  const poll = globalThis.__agentConsoleDashboardPollTask?.();
  await flushPromises();
  assert.equal(calls, 1, "the first poll shares the in-flight initial read");
  initial.resolve({ ok: true, sessions: [], machines: [] });
  await act(async () => { await poll; });
  await act(async () => { await globalThis.__agentConsoleDashboardPollTask?.(); });
  assert.equal(calls, 2, "a later poll starts a fresh read");
});

test("performance capture marks a usable list only after the dashboard commits a successful result", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), asyncPollMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const initial = deferred<SessionsResponse>();
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => initial.promise,
  };
  const { startPerformanceCapture } = await ssr.loadModule<typeof import("../src/performanceSummary.ts")>("/src/performanceSummary.ts");
  const { debugEvents } = await ssr.loadModule<typeof import("../src/debugLog.ts")>("/src/debugLog.ts");
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  startPerformanceCapture("normal");
  const props = {
    machines: ["summit"], enabledMachines: ["summit"], machineColors: {},
    onDebug: () => {}, onUsage: () => {}, onSettings: () => {},
  };
  await act(async () => {
    mounted.root.render(createElement(Dashboard, { ...props, active: false }));
    await flushPromises();
  });
  const usable = () => debugEvents().filter((row) => row.route === "/performance/session-list" && row.phase === "usable");
  assert.equal(usable().length, 0);
  initial.resolve({ ok: true, sessions: [], machines: [{ name: "summit", ok: true }] });
  await act(async () => { await flushPromises(); });
  assert.equal(usable().length, 0, "a backgrounded dashboard is not yet usable");
  await act(async () => { mounted.root.render(createElement(Dashboard, { ...props, active: true })); });
  assert.equal(usable().length, 1);
  await act(async () => { await globalThis.__agentConsoleDashboardPollTask?.(); });
  assert.equal(usable().length, 1);
});

async function mountHeldCountsDashboard(machines: readonly string[] = ["summit", "mesa"], { macTitleBar = false, firstHostOnly = false } = {}) {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const titleBarCounts = mounted.window.document.createElement("div");
  titleBarCounts.id = "mac-titlebar-counts";
  if (macTitleBar) mounted.window.document.body.prepend(titleBarCounts);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), asyncPollMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const realNow = Date.now;
  let nowMs = realNow();
  Date.now = () => nowMs;
  cleanupStack.push(() => { Date.now = realNow; });
  const sessions = [
    makeSession({ id: "work", machine: "summit", turn_state: { phase: "working" } as Session["turn_state"] }),
    makeSession({ id: "stop", machine: "summit", status: "stopped" }),
    makeSession({ id: "mesa-work", machine: "mesa", turn_state: { phase: "working" } as Session["turn_state"] }),
  ];
  let exampleOrgCooling = false;
  let exampleOrgRetired = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async (requested = []) => ({
      ok: true,
      sessions: sessions.filter(session => !(exampleOrgCooling || exampleOrgRetired) || session.machine !== "summit"),
      machines: requested.map(name => name === "summit" && exampleOrgRetired
        ? { name, ok: false, active: false }
        : name === "summit" && exampleOrgCooling
        ? { name, ok: false, error: "offline (cooling down after a failed probe)" }
        : { name, ok: true }),
    }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  const render = async (visibleMachines: readonly string[]) => {
    await act(async () => {
      mounted.root.render(createElement(Dashboard, {
        active: true, machines: [...visibleMachines], enabledMachines: [...visibleMachines], machineColors: {},
        onDebug: () => {}, onUsage: () => {}, onSettings: () => {},
      }));
      await flushPromises();
    });
  };
  await render(firstHostOnly ? machines.slice(0, 1) : machines);
  return {
    mounted,
    render,
    counts: () => [...mounted.container.querySelectorAll(".session-status-count")]
      .map(button => button.getAttribute("aria-label")).join(" | "),
    partialDetail: () => mounted.container.querySelector(".header-counts-notice")?.textContent ?? "",
    titleBarCounts,
    setHostCooling: (cooling: boolean) => { exampleOrgCooling = cooling; },
    setHostRetired: (retired: boolean) => { exampleOrgRetired = retired; },
    advance: (ms: number) => { nowMs += ms; },
    poll: async () => {
      await act(async () => { await globalThis.__agentConsoleDashboardPollTask?.(); await flushPromises(); });
    },
  };
}

const PLACEHOLDER_COUNTS = /^Working: – sessions \| Waiting: – sessions \| Needs attention: – sessions \| Stopped: – sessions$/;
const PARTIAL_REACHABLE_COUNTS = "Working: 1 session (partial counts) | Waiting: 0 sessions (partial counts) | Needs attention: 0 sessions (partial counts) | Stopped: 0 sessions (partial counts)";

test("status counts hold last-known values for up to 60 s while an observed machine is unreachable", async () => {
  const dashboard = await mountHeldCountsDashboard();
  const observed = dashboard.counts();
  assert.match(observed, /Working: 2 sessions/);
  assert.match(observed, /Stopped: 1 session\b/);
  dashboard.setHostCooling(true);
  await dashboard.poll();
  assert.equal(dashboard.counts().replaceAll(" (partial counts)", ""), observed, "a breaker trip keeps the last-known counts instead of placeholders");
  assert.match(dashboard.partialDetail(), /summit.*offline since.*last-known counts included/s);
  dashboard.advance(60_000);
  await dashboard.poll();
  assert.equal(dashboard.counts().replaceAll(" (partial counts)", ""), observed, "the hold covers 60 s of unavailability");
  dashboard.advance(1);
  await dashboard.poll();
  assert.equal(dashboard.counts(), PARTIAL_REACHABLE_COUNTS, "a longer outage excludes only the unavailable host's contribution");
  assert.match(dashboard.partialDetail(), /summit.*offline since.*\(excluded\)/s);
  dashboard.setHostCooling(false);
  await dashboard.poll();
  assert.equal(dashboard.counts(), observed, "an answer restores the counts");
  assert.equal(dashboard.partialDetail(), "", "recovery removes the partial marker");
});

test("a machine never observed since the last reset cannot contribute held counts", async () => {
  const dashboard = await mountHeldCountsDashboard();
  dashboard.setHostCooling(true);
  await dashboard.render(["summit", "mesa", "cedar"]);
  assert.equal(dashboard.counts(), PARTIAL_REACHABLE_COUNTS, "a machine-set change forgets earlier answers without hiding reachable counts");
  assert.match(dashboard.partialDetail(), /\(excluded\)/);
});

test("browser offline resets stale contributions while newly reachable counts stay visible", async () => {
  const dashboard = await mountHeldCountsDashboard();
  dashboard.setHostCooling(true);
  await act(async () => { globalThis.window.dispatchEvent(new globalThis.window.Event("offline")); await flushPromises(); });
  await dashboard.poll();
  assert.equal(dashboard.counts(), PARTIAL_REACHABLE_COUNTS, "going offline forgets earlier answers but fresh hosts still contribute");
  assert.match(dashboard.partialDetail(), /\(excluded\)/);
});

test("online recovery resets stale contributions without hiding answering hosts", async () => {
  const dashboard = await mountHeldCountsDashboard();
  await act(async () => { globalThis.window.dispatchEvent(new globalThis.window.Event("offline")); await flushPromises(); });
  await dashboard.poll();
  assert.match(dashboard.counts(), /Working: 2 sessions/, "answers while offline are counted again");
  dashboard.setHostCooling(true);
  await act(async () => { globalThis.window.dispatchEvent(new globalThis.window.Event("online")); await flushPromises(); });
  assert.equal(dashboard.counts(), PARTIAL_REACHABLE_COUNTS, "the recovery wake forgets earlier answers but keeps fresh counts");
  assert.match(dashboard.partialDetail(), /\(excluded\)/);
});

test("all expired offline contributions remain unknown instead of inventing zero totals", async () => {
  const dashboard = await mountHeldCountsDashboard(["summit"]);
  dashboard.setHostCooling(true);
  await dashboard.poll();
  dashboard.advance(60_001);
  await dashboard.poll();
  assert.match(dashboard.counts().replaceAll(" (partial counts)", ""), PLACEHOLDER_COUNTS);
  assert.match(dashboard.partialDetail(), /summit.*\(excluded\)/s);
});

test("host retirement removes cached contributions and the offline marker", async () => {
  const dashboard = await mountHeldCountsDashboard();
  dashboard.setHostRetired(true);
  await dashboard.poll();
  assert.equal(dashboard.counts(), "Working: 1 session | Waiting: 0 sessions | Needs attention: 0 sessions | Stopped: 0 sessions");
  assert.equal(dashboard.partialDetail(), "");
});

test("an old enabled-machine poll cannot mutate a replacement activity generation", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const oldPoll = deferred<SessionsResponse>();
  const oldSession = makeSession({ id: "old", machine: "summit", title: "Old Summit" });
  const newSession = makeSession({ id: "new", machine: "mesa", title: "Current MESA" });
  const calls: string[][] = [];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async (machines = []) => {
      calls.push([...machines]);
      return machines.includes("summit")
        ? oldPoll.promise
        : { ok: true, sessions: [newSession], machines: [{ name: "mesa", ok: true }] };
    },
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  const props = {
    active: true,
    machines: ["summit", "mesa"],
    machineColors: {},
    onDebug: () => {},
    onUsage: () => {},
    onSettings: () => {},
  } as const;

  await act(async () => {
    mounted.root.render(createElement(Dashboard, { ...props, enabledMachines: ["summit"] }));
    await flushPromises();
  });
  await act(async () => {
    mounted.root.render(createElement(Dashboard, { ...props, enabledMachines: ["mesa"] }));
    await flushPromises();
  });
  assert.match(mounted.container.textContent ?? "", /Current MESA/);

  await act(async () => {
    oldPoll.resolve({ ok: true, sessions: [oldSession], machines: [{ name: "summit", ok: true }] });
    await flushPromises();
  });

  assert.equal(calls.some((machines) => machines.includes("summit")), true);
  assert.doesNotMatch(mounted.container.textContent ?? "", /Old Summit/);
  assert.match(mounted.container.textContent ?? "", /Current MESA/);
});

test("Dashboard Copy feeds Resume by ID with the selected managed profile", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const clipboardWrites: string[] = [];
  const webClipboardWrites: string[] = [];
  Object.defineProperty(mounted.window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args: { text?: string }) => {
        assert.equal(command, "write_macos_clipboard_text");
        assert.equal(typeof args.text, "string");
        clipboardWrites.push(args.text!);
      },
    },
  });
  Object.defineProperty(mounted.window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        webClipboardWrites.push(value);
      },
    },
  });
  const profiled = makeSession({
    id: "managed-profile",
    machine: "summit",
    title: "Profiled session",
    agent: "claude",
    agent_profile: "custom-claude",
    status: "stopped",
    resumable: true,
    provider_resume: {
      provider: "claude",
      session_id: "profile-provider-id",
    },
  });
  let submitted: { machine: string; body: CreateBody } | undefined;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [profiled],
      machines: [{
        name: "summit",
        ok: true,
        observed_at: "2026-07-18T00:00:00Z",
        capabilities: {
          profile_resume_import: true,
          managed_resume_command: false,
          resume_blocked_reason: true,
        },
        agent_profiles: [{
          id: "custom-claude",
          label: "Custom Claude",
          agent: "claude",
          provider_resume_import_supported: true,
        }],
      }],
    }),
    createSession: async (machine, body) => {
      submitted = { machine, body };
      return {
        ok: true,
        id: "imported-profile",
        session: makeSession({
          id: "imported-profile",
          machine,
          agent: "claude",
          agent_profile: "custom-claude",
        }),
      };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: false,
      terminalRenderMode: "fit",
      terminalSelectedPaneRealtime: false,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  const copy = mounted.container.querySelector<HTMLButtonElement>(
    '[aria-label="Copy provider session ID for Profiled session"]',
  );
  assert.ok(copy, "the rendered session must expose its provider-id copy action");
  await act(async () => {
    copy.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.deepEqual(clipboardWrites, [], "opening the copy menu must not write");
  const copyChoice = [...mounted.window.document.body.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="Copy session actions"] [role="menuitem"]')]
    .find((button) => button.textContent?.includes("Copy provider session ID"));
  assert.ok(copyChoice);
  assert.equal(copyChoice.querySelector("code")?.textContent, "profile-provider-id");
  await act(async () => {
    copyChoice.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.deepEqual(clipboardWrites, ["profile-provider-id"]);
  assert.deepEqual(webClipboardWrites, [], "desktop copy uses the native clipboard writer");
  assert.match(mounted.window.document.body.querySelector(".session-copy-feedback")?.textContent ?? "", /Copied provider session ID/);

  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  const resumeMode = [...mounted.container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
    .find((button) => button.textContent?.trim() === "Resume by ID");
  assert.ok(resumeMode);
  await act(async () => {
    resumeMode.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });

  const agentSelect = mounted.container.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label^="Agent:"]',
  );
  assert.ok(agentSelect);
  await act(async () => {
    agentSelect.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  const profileOption = [...mounted.container.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
    .find((option) => option.textContent?.trim() === "Custom Claude");
  assert.ok(profileOption);
  await act(async () => {
    profileOption.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });

  const resumeInput = mounted.container.querySelector<HTMLInputElement>(
    'input[placeholder="Session ID or pasted resume command"]',
  );
  assert.ok(resumeInput);
  await act(async () => {
    const paste = new mounted.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: (type: string) => type === "text" ? clipboardWrites[0] ?? "" : "",
      },
    });
    resumeInput.dispatchEvent(paste);
    await flushPromises();
  });

  await act(async () => {
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.deepEqual(submitted, {
    machine: "summit",
    body: {
      agent: "claude",
      agent_profile: "custom-claude",
      provider_resume_id: "profile-provider-id",
    },
  });
});

test("shared host filters expose permitted hosts and filter rendered sessions", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const primary = makeSession({ id: "primary", machine: "summit", title: "Primary Session" });
  const studio = makeSession({ id: "studio", machine: "studio-mac", title: "Studio Session" });
  const pollRequests: string[][] = [];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async (machines = []) => {
      pollRequests.push([...machines]);
      return ({
      ok: true,
      sessions: [primary, studio],
      machines: [
        { name: "summit", ok: true },
        { name: "studio-mac", ok: true },
      ],
      });
    },
  };
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["studio-mac/studio"]));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit", "studio-mac"],
      enabledMachines: ["summit", "studio-mac"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await openSessionFilters(mounted);
  const hosts = [...mounted.container.querySelectorAll<HTMLInputElement>(".session-filter-host input")];
  assert.deepEqual(hosts.map(input => input.value), ["summit", "studio-mac"]);
  assert.match(mounted.container.textContent ?? "", /Primary Session/);
  assert.match(mounted.container.textContent ?? "", /Studio Session/);

  await setVisibleHosts(mounted, ["summit"]);

  assert.match(mounted.container.textContent ?? "", /Primary Session/);
  assert.deepEqual(pollRequests.at(-1), ["summit", "studio-mac"], "an excluded host with a retained overview slot stays in the poll allowlist");
});

test("filtered polls retain capabilities for permitted hosts omitted from the response", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin(), historyPanelMockPlugin()]);
  cleanupStack.push(ssr.close);
  const profile = { id: "studio-codex", label: "Studio Codex", agent: "codex", provider_resume_import_supported: true };
  const pollRequests: string[][] = [];
  const accountRequests: string[] = [];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async (machines = []) => {
      pollRequests.push([...machines]);
      return {
        ok: true,
        sessions: [],
        machines: machines.map(name => name === "studio-mac"
          ? { name, ok: true, capabilities: { history: true, codex_account_switch: true }, agent_profiles: [profile] }
          : { name, ok: true }),
      };
    },
    listAccounts: async (_provider, machine) => { accountRequests.push(machine); return { accounts: [{ id: `${machine}-account`, label: `${machine} account` }] }; },
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true, machines: ["summit", "studio-mac"], enabledMachines: ["summit", "studio-mac"], machineColors: {},
      onDebug: () => {}, onUsage: () => {}, onSettings: () => {},
    }));
    await flushPromises();
  });
  await openSessionFilters(mounted);
  await setVisibleHosts(mounted, ["summit"]);
  assert.deepEqual(pollRequests.at(-1), ["summit", "studio-mac"], "excluded hosts stay current for facet counts");
  await act(async () => {
    mounted.container.querySelector<HTMLElement>(".header-menu-trigger")!.click();
    findTextButton(mounted.container, "History").click();
    await flushPromises();
  });
  assert.deepEqual(mounted.container.querySelector(".history-resume-stub")?.getAttribute("data-machines"), "studio-mac");
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Close history"]')!.click();
    await flushPromises();
    findTextButton(mounted.container, "New").click();
    await flushPromises();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label^="Machine:"]')!.click();
    await flushPromises();
    [...mounted.container.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find(option => option.textContent?.includes("studio-mac"))!.click();
    await flushPromises();
  });
  assert.ok(accountRequests.includes("studio-mac"), "retained capability metadata keeps the excluded host's account inventory active");
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label^="Agent:"]')!.click();
    await flushPromises();
  });
  assert.match(mounted.container.textContent ?? "", /Studio Codex/);
});

test("shared host and harness filters compose and clear together", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const control = makeSession({ id: "control-1", machine: "host-a", agent: "claude", role: "coordinator", repo_name: "control", coordinator_tree: { depth: 0 } });
  const child = makeSession({
    id: "control-child", machine: "host-b", role: "reviewer", repo_name: "agent-console",
    dispatched_by: { machine: "host-a", session_id: "control-1", repo_name: "control" },
    coordinator_tree: { depth: 1 },
  });
  const plain = makeSession({ id: "plain", machine: "host-b", role: "worker", repo_name: "agent-console" });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions: [control, child, plain], machines: [{ name: "host-a", ok: true }, { name: "host-b", ok: true }] }),
    fetchLayoutOrder: async () => ({ reachable: true, order: [control, child, plain].map(sessionKey), revision: 1 }),
    putLayoutOrder: async (order) => ({ reachable: true, order, revision: 2 }),
  };
  mounted.window.localStorage.setItem(AUTO_STORAGE, "1");
  const Dashboard = await extendedDashboard(ssr, { sessionRole: () => (row: { session_id: string }) => row.session_id === "plain" ? "lead" : null });
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true, machines: ["host-a", "host-b"], enabledMachines: ["host-a", "host-b"], machineColors: {},
      onDebug: () => {}, onUsage: () => {}, onSettings: () => {},
    }));
    await flushPromises();
  });
  assert.deepEqual(new Set(slotKeys(mounted.container)), new Set(["host-a/control-1", "host-b/control-child", "host-b/plain"]));
  await openSessionFilters(mounted);
  await setVisibleHosts(mounted, ["host-a"]);
  assert.deepEqual(slotKeys(mounted.container), ["host-a/control-1"]);
  await openSessionFilters(mounted);
  await setSessionFilter(mounted, "Filter sessions by harness", "codex");
  await act(async () => {
    [...mounted.container.querySelectorAll<HTMLButtonElement>(".session-filter-panel-actions button")]
      .find(button => button.textContent === "Apply filters")!.click();
    await flushPromises();
  });
  assert.match(mounted.container.querySelector(".session-list-empty")!.textContent!, /No matching sessions/);
  await act(async () => { findTextButton(mounted.container, "Clear all").click(); await flushPromises(); });
  assert.deepEqual(new Set(slotKeys(mounted.container)), new Set(["host-a/control-1", "host-b/control-child", "host-b/plain"]));

  await openSessionFilters(mounted);
  const rolesGroup = mounted.container.querySelector<HTMLDetailsElement>('[data-filter-dimension="roles"]')!;
  rolesGroup.open = true;
  const roleValues = [...rolesGroup.querySelectorAll<HTMLInputElement>("input")].map(input => input.value);
  assert.ok(roleValues.includes("lead") && !roleValues.includes("worker"), "the host role hook names the Roles facet");
  // Every session has a role, so isolating "No role" matches nothing; an empty selection can never apply.
  const noRole = rolesGroup.querySelector<HTMLInputElement>('input[value=""]')!;
  await act(async () => { noRole.click(); await flushPromises(); });
  await act(async () => {
    [...mounted.container.querySelectorAll<HTMLButtonElement>(".session-filter-panel-actions button")]
      .find(button => button.textContent === "Apply filters")!.click();
    await flushPromises();
  });
  assert.match(mounted.container.querySelector(".session-list-empty")!.textContent!, /No matching sessions/);
  assert.ok([...mounted.container.querySelectorAll<HTMLButtonElement>(".session-list-empty button")]
    .some(button => button.textContent === "Clear all"), "a roles-only empty state keeps the Clear all action");
});

for (const [width, autoLayout] of [[390, "0"], [390, "1"], [1280, "0"], [1280, "1"]] as const) {
  test(`${width}px auto-layout ${autoLayout}: focused title menu navigates by id without reordering (#870)`, async () => {
    const mounted = installDom();
    Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(mounted.window, "innerHeight", { configurable: true, value: 844 });
    cleanupStack.push(mounted.cleanup);
    const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
    cleanupStack.push(ssr.close);

    const sessions: Session[] = ["a", "b", "c"].map((id) =>
      makeSession({ id, machine: "summit", title: `Session ${id.toUpperCase()}`, status: "running" }),
    );
    const persistedOrders: string[][] = [];
    let ranking = { order: sessions.map(sessionKey), revision: 1 };
    globalThis.__agentConsoleDashboardBehaviorApiMock = {
      fetchLayoutOrder: async () => ({ ...ranking, order: [...ranking.order], reachable: true, conflict: false }),
      putLayoutOrder: async (nextOrder) => {
        persistedOrders.push([...nextOrder]);
        return { reachable: true, order: nextOrder, revision: 2 };
      },
      listSessions: async () => ({ ok: true, sessions, machines: [{ name: "summit", ok: true }] }),
    };
    mounted.window.localStorage.setItem(MODE_STORAGE, "4");
    mounted.window.localStorage.setItem(AUTO_STORAGE, autoLayout);
    mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["summit/a", "summit/b", "summit/c", null]));

    const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
    await act(async () => {
      mounted.root.render(createElement(Dashboard, {
        active: true, machines: ["summit"], enabledMachines: ["summit"], machineColors: {},
        onDebug: () => {}, onUsage: () => {}, onSettings: () => {},
      }));
      await flushPromises();
    });
    const focusedSlot = () => mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused");
    const ordinal = () => focusedSlot()?.querySelector<HTMLButtonElement>(".slot-ordinal")?.textContent?.replace(/\s+/g, " ").trim();
    await act(async () => {
      mounted.window.dispatchEvent(metaKey(mounted.window, "2"));
      await flushPromises();
    });
    assert.equal(focusedSlot()?.dataset.slotKey, "summit/b");
    assert.equal(ordinal(), "2 / 3");
    const slotsBefore = slotKeys(mounted.container);

    await act(async () => {
      focusedSlot()?.querySelector<HTMLElement>("summary.slot-title")?.click();
      await flushPromises();
    });
    const menu = focusedSlot()!.querySelector<HTMLElement>(".slot-title-dropdown")!;
    assert.deepEqual(
      [...menu.querySelectorAll<HTMLElement>(".slot-menu-ordinal")].map((item) => item.textContent),
      ["1", "2", "3"],
      "the header dropdown lists every session in sorted order with its index",
    );
    await act(async () => {
      findTextButton(focusedSlot()!, "Session C").click();
      await flushPromises();
    });
    assert.equal(focusedSlot()?.dataset.slotKey, "summit/c", "selection navigates to the chosen session");
    assert.equal(ordinal(), "3 / 3", "the counter becomes the chosen session's sorted position");
    await flushPromises();
    assert.deepEqual(persistedOrders, [], "selection never writes a new ranking");
    if (width > 760) assert.deepEqual(slotKeys(mounted.container), slotsBefore, "selection never swaps grid slots");

    // A ranking update (another device's sort) moves C to the front: focus
    // follows the id and the counter follows its new position.
    ranking = { order: ["summit/c", "summit/a", "summit/b"], revision: 2 };
    await act(async () => {
      mounted.window.dispatchEvent(new mounted.window.Event("focus"));
      await flushPromises();
    });
    assert.equal(focusedSlot()?.dataset.slotKey, "summit/c", "focus stays on the session id after a reorder");
    assert.equal(ordinal(), "1 / 3", "the counter reflects the reordered position");
  });
}

for (const fixedOrder of [false, true]) {
  test(`focused dropdown Move here ${fixedOrder ? "is absent while ordering is automatic" : "swaps a session into the focused position"} (#870)`, async () => {
    const mounted = installDom();
    Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 1280 });
    cleanupStack.push(mounted.cleanup);
    const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
    cleanupStack.push(ssr.close);
    const sessions: Session[] = ["a", "b", "c", "d", "e"].map((id) =>
      makeSession({ id, machine: "summit", title: `Session ${id.toUpperCase()}`, status: "running" }),
    );
    const persistedOrders: string[][] = [];
    globalThis.__agentConsoleDashboardBehaviorApiMock = {
      fetchLayoutOrder: async () => ({ reachable: true, order: sessions.map(sessionKey), revision: 1 }),
      putLayoutOrder: async (nextOrder) => {
        persistedOrders.push([...nextOrder]);
        return { reachable: true, order: nextOrder, revision: 2 };
      },
      listSessions: async () => ({ ok: true, sessions, machines: [{ name: "summit", ok: true }] }),
    };
    // Two panes: D and E live past the visible grid, on a later page.
    mounted.window.localStorage.setItem(MODE_STORAGE, "2");
    mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
    mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["summit/a", "summit/b"]));
    const Dashboard = await extendedDashboard(ssr, { sessionOrdering: { subscribe: () => () => {}, snapshot: () => "", fixed: () => fixedOrder, order: rows => [...rows] } });
    await act(async () => {
      mounted.root.render(createElement(Dashboard, {
        active: true, machines: ["summit"], enabledMachines: ["summit"], machineColors: {},
        onDebug: () => {}, onUsage: () => {}, onSettings: () => {},
      }));
      await flushPromises();
    });
    const focusedSlot = () => mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused");
    const ordinal = () => focusedSlot()?.querySelector<HTMLButtonElement>(".slot-ordinal")?.textContent?.replace(/\s+/g, " ").trim();
    const openMenu = async () => act(async () => {
      focusedSlot()?.querySelector<HTMLElement>("summary.slot-title")?.click();
      await flushPromises();
    });
    await act(async () => {
      mounted.window.dispatchEvent(metaKey(mounted.window, "2"));
      await flushPromises();
    });
    assert.equal(focusedSlot()?.dataset.slotKey, "summit/b");
    await openMenu();
    const moveButtons = focusedSlot()!.querySelectorAll<HTMLButtonElement>(".slot-menu-move");
    if (fixedOrder) {
      assert.equal(moveButtons.length, 0, "automatic ordering offers no Move here");
      return;
    }
    assert.deepEqual([...moveButtons].map((button) => button.getAttribute("aria-label")),
      ["Move Session A here", "Move Session C here", "Move Session D here", "Move Session E here"],
      "every other session offers Move here, including later pages");
    await act(async () => {
      findAriaButton(focusedSlot()!, "Move Session E here").click();
      await flushPromises();
    });
    await waitForCondition(() => persistedOrders.length > 0, "Move here persists the ranking");
    assert.deepEqual(persistedOrders.at(-1), ["summit/a", "summit/e", "summit/c", "summit/d", "summit/b"]);
    assert.equal(focusedSlot()?.dataset.slotKey, "summit/e", "the moved session takes focus");
    assert.equal(ordinal(), "2 / 5", "it now occupies the focused position");

    // Clicking a row itself still only navigates.
    await openMenu();
    await act(async () => {
      findTextButton(focusedSlot()!, "Session D").click();
      await flushPromises();
    });
    await flushPromises();
    assert.equal(focusedSlot()?.dataset.slotKey, "summit/d");
    assert.equal(ordinal(), "4 / 5");
    assert.equal(persistedOrders.length, 1, "row selection writes no ranking");
  });
}

test("fixed layout can focus a hidden session without mutating the fixed slots", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);

  const sessions: Session[] = ["a", "b", "c"].map((id) =>
    makeSession({
      id,
      machine: "summit",
      title: `Session ${id.toUpperCase()}`,
      status: "running",
    }),
  );
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };

  mounted.window.localStorage.setItem(MODE_STORAGE, "2");
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["summit/a", "summit/b"]));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(
      createElement(Dashboard, {
        active: true,
        machines: ["summit"],
        enabledMachines: ["summit"],
        machineColors: {},
        onDebug: () => {},
        onUsage: () => {},
        onSettings: () => {},
      }),
    );
    await flushPromises();
  });

  assert.deepEqual(slotKeys(mounted.container), ["summit/a", "summit/b"]);

  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "3"));
    await flushPromises();
  });

  assert.deepEqual(slotKeys(mounted.container), ["summit/a", "summit/b", "summit/c"]);
  const focusedSlot = mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused");
  assert.equal(focusedSlot?.dataset.slotKey, "summit/c");

  assert.ok(focusedSlot);
  await act(async () => {
    findAriaButton(focusedSlot, "Back to session list")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  assertNoElement(mounted.container, ".terminal-slot.is-focused");
  assert.deepEqual(slotKeys(mounted.container), ["summit/a", "summit/b"]);
  assert.equal(mounted.window.localStorage.getItem(SLOTS_STORAGE), JSON.stringify(["summit/a", "summit/b"]));
});

test("mobile hidden focused session keeps out-of-range slot actions functional", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(mounted.window, "innerHeight", { configurable: true, value: 844 });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);

  const sessions: Session[] = ["a", "b", "c", "d", "e"].map((id) =>
    makeSession({
      id,
      machine: "summit",
      title: `Session ${id.toUpperCase()}`,
      status: "running",
    }),
  );
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };

  mounted.window.localStorage.setItem(MODE_STORAGE, "2");
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(
    SLOTS_STORAGE,
    JSON.stringify(["summit/a", "summit/b", "summit/c", "summit/d"]),
  );

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await act(async () => {
    findAriaButton(mounted.container, "Open Session E").click();
    await flushPromises();
  });
  const focusedSlot = mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused");
  assert.equal(focusedSlot?.dataset.slotKey, "summit/e");

  await act(async () => {
    focusedSlot?.querySelector<HTMLElement>("summary.slot-title")?.click();
    await flushPromises();
  });
  await act(async () => {
    findTextButton(focusedSlot!, "+ New session...").click();
    await flushPromises();
  });
  assert.ok(mounted.container.querySelector('[role="dialog"][aria-label="New session"]'));

  await act(async () => {
    findTextButton(mounted.container, "Cancel").click();
    await flushPromises();
  });
  const refocusedSlot = mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused");
  assert.equal(refocusedSlot?.dataset.slotKey, "summit/e");
  await act(async () => {
    findAriaButton(refocusedSlot!, "Back to session list").click();
    await flushPromises();
  });

  assertNoElement(mounted.container, ".terminal-slot.is-focused");
  assert.ok(mounted.container.querySelector(".mobile-session-list"));
  assert.equal(
    mounted.window.localStorage.getItem(SLOTS_STORAGE),
    JSON.stringify(["summit/a", "summit/b", "summit/c", "summit/d"]),
  );
});

for (const fixedOrder of [true, false]) {
  test(`overview title menu ${fixedOrder ? "selection navigates without replacing the card" : "Move here replaces the card and stays interactive"} (#870)`, async () => {
    const mounted = installDom();
    cleanupStack.push(mounted.cleanup);
    const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
    cleanupStack.push(ssr.close);

    const sessions: Session[] = ["a", "b", "c", "d", "e", "f", "g"].map((id) =>
      makeSession({ id, machine: "summit", title: `Session ${id.toUpperCase()}`, status: "running" }),
    );
    const writes: string[][] = [];
    globalThis.__agentConsoleDashboardBehaviorApiMock = {
      fetchLayoutOrder: async () => ({ reachable: true, order: sessions.map(sessionKey), revision: 1 }),
      listSessions: async () => ({ ok: true, sessions, machines: [{ name: "summit", ok: true }] }),
      putLayoutOrder: async (order) => {
        writes.push([...order]);
        return { reachable: true, order, revision: 2 };
      },
    };
    mounted.window.localStorage.setItem(MODE_STORAGE, "6");
    mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
    mounted.window.localStorage.setItem(SLOTS_STORAGE,
      JSON.stringify(["summit/a", "summit/b", "summit/c", "summit/d", "summit/e", "summit/f"]));

    const Dashboard = await extendedDashboard(ssr, { sessionOrdering: { subscribe: () => () => {}, snapshot: () => "", fixed: () => fixedOrder, order: rows => [...rows] } });
    await act(async () => {
      mounted.root.render(createElement(Dashboard, {
        active: true, machines: ["summit"], enabledMachines: ["summit"], machineColors: {},
        onDebug: () => {}, onUsage: () => {}, onSettings: () => {},
      }));
      await flushPromises();
    });
    const slotAt = (index: number) => mounted.container.querySelector<HTMLElement>(`[data-slot-index="${index}"]`);
    const openMenu = async (slot: HTMLElement) => act(async () => {
      slot.querySelector<HTMLElement>("summary.slot-title")!
        .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushPromises();
    });
    assert.equal(slotAt(4)?.dataset.slotKey, "summit/e");
    await openMenu(slotAt(4)!);
    assert.deepEqual(
      [...slotAt(4)!.querySelectorAll<HTMLElement>(".slot-menu-ordinal")].map((item) => item.textContent),
      ["1", "2", "3", "4", "5", "6", "7"],
      "the card menu lists every session in sorted order with its index",
    );

    if (fixedOrder) {
      assertNoElement(slotAt(4)!, ".slot-menu-move");
      await act(async () => {
        findTextButton(slotAt(4)!, "Session G")
          .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await flushPromises();
      });
      await flushPromises();
      assert.equal(mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey, "summit/g",
        "selecting an off-page session opens it");
      assert.deepEqual(writes, [], "selection never writes the ranking");
      assert.equal(slotAt(4)?.dataset.slotKey, "summit/e", "the card keeps its session");
      return;
    }

    await act(async () => {
      findAriaButton(slotAt(4)!, "Move Session G here")
        .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushPromises();
    });
    await waitForCondition(() => writes.length > 0, "Move here persists the ranking");
    assert.deepEqual(writes.at(-1), ["summit/a", "summit/b", "summit/c", "summit/d", "summit/g", "summit/f", "summit/e"]);
    assertNoElement(mounted.container, ".terminal-slot.is-focused");
    assert.equal(slotAt(4)?.dataset.slotKey, "summit/g");
    const replacementMenu = slotAt(4)!.querySelector<HTMLDetailsElement>("details.slot-title-menu");
    await openMenu(slotAt(4)!);
    assert.equal(replacementMenu?.open, true);
  });
}

test("a session promoted from page 2 retains its authoritative title menu", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    asyncPollMockPlugin(),
    terminalPaneMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);

  const sessions: Session[] = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) =>
    makeSession({
      id,
      machine: "summit",
      title: `Session ${id.toUpperCase()}`,
      status: "running",
    }),
  );
  let listedSessions = sessions;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: listedSessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };

  mounted.window.localStorage.setItem(MODE_STORAGE, "6");
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(
    SLOTS_STORAGE,
    JSON.stringify(sessions.slice(0, 6).map(sessionKey)),
  );

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await act(async () => {
    findAriaButton(mounted.container, "Next page").click();
    await flushPromises();
  });
  assert.deepEqual(slotKeys(mounted.container), ["summit/g", "summit/h", null, null, null, null]);

  listedSessions = sessions.slice(1);
  await act(async () => {
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  await act(async () => {
    findAriaButton(mounted.container, "Previous page").click();
    await flushPromises();
  });

  assert.deepEqual(slotKeys(mounted.container), [
    "summit/b",
    "summit/c",
    "summit/d",
    "summit/e",
    "summit/f",
    "summit/g",
  ]);
  const promotedSlot = mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/g"]');
  assert.ok(promotedSlot);
  await act(async () => {
    promotedSlot.querySelector<HTMLElement>("summary.slot-title")?.click();
    await flushPromises();
  });

  await act(async () => {
    findAriaButton(promotedSlot, "Move Session H here").click();
    await flushPromises();
  });

  assert.deepEqual(slotKeys(mounted.container), [
    "summit/b",
    "summit/c",
    "summit/d",
    "summit/e",
    "summit/f",
    "summit/h",
  ]);
});

function revisionedLayoutStore(initialOrder: readonly string[]): {
  readonly writes: string[][];
  readonly api: {
    fetchLayoutOrder: () => Promise<{ order: string[]; revision: number; reachable: boolean; conflict: boolean }>;
    putLayoutOrder: (order: readonly string[]) => Promise<{ order: string[]; revision: number; reachable: boolean; conflict: boolean }>;
  };
} {
  let stored = { order: [...initialOrder], revision: 1 };
  const writes: string[][] = [];
  return {
    writes,
    api: {
      fetchLayoutOrder: async () => ({ ...stored, order: [...stored.order], reachable: true, conflict: false }),
      putLayoutOrder: async (order) => {
        writes.push([...order]);
        stored = { order: [...order], revision: stored.revision + 1 };
        return { ...stored, order: [...stored.order], reachable: true, conflict: false };
      },
    },
  };
}

test("a device with a spoke disabled keeps that spoke's ranked sessions in the shared order", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    asyncPollMockPlugin(),
    terminalPaneMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);

  const sessions = ["a", "b", "c"].map((id) =>
    makeSession({ id, machine: "summit", title: `Session ${id.toUpperCase()}`, status: "running" }),
  );
  const store = revisionedLayoutStore(["summit/a", "cedar/spoke", "summit/b", "summit/c"]);
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    ...store.api,
    // cedar is configured but disabled on this device, so the edge is never asked
    // about it and the session list carries no cedar status at all.
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };
  mounted.window.localStorage.setItem(MODE_STORAGE, "2");
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit", "cedar"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  const first = mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/a"]');
  assert.ok(first);
  await act(async () => {
    first.querySelector<HTMLElement>("summary.slot-title")?.click();
    await flushPromises();
  });
  await act(async () => {
    findAriaButton(first, "Move Session C here").click();
    await flushPromises();
  });

  assert.deepEqual(store.writes.at(-1), ["summit/c", "cedar/spoke", "summit/b", "summit/a"]);
});

test("manual 2-pane layout enters a third newly created session", async () => {
  await assertCreateFocusesOverflowSession({ autoLayout: false, layoutMode: 2, existingCount: 2 });
});

test("Auto 6-pane layout enters a seventh newly created session", async () => {
  await assertCreateFocusesOverflowSession({ autoLayout: true, layoutMode: 6, existingCount: 6 });
});

test("mobile enters a newly created session even when it fits the slot projection", async () => {
  await assertCreateFocusesOverflowSession({ autoLayout: false, layoutMode: 4, existingCount: 0, mobile: true });
});

test("newly created session focuses after reconciliation recovers", async () => {
  await assertCreateFocusesOverflowSession({
    autoLayout: false,
    layoutMode: 2,
    existingCount: 2,
    firstReconciliationFails: true,
  });
});

test("newly created session focuses after stale reconciliation catches up", async () => {
  await assertCreateFocusesOverflowSession({
    autoLayout: false,
    layoutMode: 2,
    existingCount: 2,
    firstReconciliationOmitsCreated: true,
  });
});

test("manual layout with a free slot keeps the created session in the grid list", async () => {
  await assertCreateGridFocusesSession({ layoutMode: 4, existingCount: 1 });
});

test("manual layout with spare capacity grid-focuses the created session", async () => {
  await assertCreateGridFocusesSession({ layoutMode: 4, existingCount: 2 });
});

test("a newly created session stays attached while outside the visible-host filter", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin("Focus the created session", "mesa"),
  ]);
  cleanupStack.push(ssr.close);
  const existingSession = makeSession({ id: "existing", machine: "summit", status: "running" });
  const createdSession = makeSession({ id: "created-filtered", machine: "mesa", status: "running" });
  let created = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async (machine) => {
      assert.equal(machine, "mesa");
      created = true;
      return { ok: true, id: createdSession.id, session: createdSession };
    },
    listSessions: async () => ({
      ok: true,
      sessions: created ? [existingSession, createdSession] : [existingSession],
      machines: [
        { name: "summit", ok: true },
        { name: "mesa", ok: true },
      ],
    }),
    sendSessionInput: async () => ({ ok: true }),
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit", "mesa"],
      enabledMachines: ["summit", "mesa"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await openSessionFilters(mounted);
  await setVisibleHosts(mounted, ["summit"]);
  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
    assert.equal(mounted.container.querySelector<HTMLElement>("[data-create-machines]")?.dataset.createMachines, "summit,mesa",
      "creation remains available on permitted hosts outside the visible session filter");
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.equal(created, true, "the create request completed on the selected machine");
  assert.equal(mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey, "mesa/created-filtered");
});

test("newly created session grid-focuses after a late stale pre-create poll", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    asyncPollMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin("Focus the created session"),
  ]);
  cleanupStack.push(ssr.close);
  const existingSession = makeSession({ id: "existing", machine: "summit", status: "running" });
  const createdSession = makeSession({ id: "created-late-poll", machine: "summit", status: "running" });
  const stalePoll = deferred<SessionsResponse>();
  let beforeCreateCalls = 0;
  let created = false;
  let omitCreated = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      created = true;
      return { ok: true, id: createdSession.id, session: createdSession };
    },
    listSessions: async () => {
      if (!created) {
        beforeCreateCalls += 1;
        if (beforeCreateCalls > 1) {
          return stalePoll.promise;
        }
        return { ok: true, sessions: [existingSession], machines: [{ name: "summit", ok: true }] };
      }
      return {
        ok: true,
        sessions: omitCreated ? [existingSession] : [existingSession, createdSession],
        machines: [{ name: "summit", ok: true }],
      };
    },
    sendSessionInput: async () => ({ ok: true }),
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  assert.ok(globalThis.__agentConsoleDashboardPollTask);
  void globalThis.__agentConsoleDashboardPollTask();
  await flushPromises();
  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await waitForCondition(
    () => mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus")?.dataset.slotKey
      === "summit/created-late-poll",
    "the created session to receive grid focus before the stale poll resolves",
  );
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey ?? null,
    null,
  );
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus")?.dataset.slotKey,
    "summit/created-late-poll",
  );

  await act(async () => {
    stalePoll.resolve({
      ok: true,
      sessions: [existingSession],
      machines: [{ name: "summit", ok: true }],
    });
    await flushPromises();
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey ?? null,
    null,
  );
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus")?.dataset.slotKey,
    "summit/created-late-poll",
  );

  const existingSlot = mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/existing"]');
  assert.ok(existingSlot);
  await act(async () => {
    existingSlot.dispatchEvent(primaryPointerDown(mounted.window));
    await flushPromises();
  });
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus")?.dataset.slotKey ?? null,
    null,
  );
  assert.equal(
    mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/created-late-poll"] .terminal-pane')
      ?.dataset.autoFocus,
    "false",
  );

  await act(async () => {
    omitCreated = true;
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  assert.equal(
    mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/created-late-poll"]')?.dataset.slotKey ?? null,
    null,
  );

  await act(async () => {
    omitCreated = false;
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus")?.dataset.slotKey ?? null,
    null,
  );
  assert.equal(
    mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/created-late-poll"] .terminal-pane')
      ?.dataset.autoFocus,
    "false",
  );
});

test("explicit session entry cancels a pending created-session focus", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin("Focus the created session"),
  ]);
  cleanupStack.push(ssr.close);
  const existingSession = makeSession({ id: "existing-choice", machine: "summit", status: "running" });
  const createdSession = makeSession({ id: "created-delayed", machine: "summit", status: "running" });
  const delayedRefresh = deferred<SessionsResponse>();
  let postCreateCalls = 0;
  let created = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      created = true;
      return { ok: true, id: createdSession.id, session: createdSession };
    },
    listSessions: async () => {
      if (!created) {
        return { ok: true, sessions: [existingSession], machines: [{ name: "summit", ok: true }] };
      }
      postCreateCalls += 1;
      if (postCreateCalls === 1) {
        return { ok: true, sessions: [existingSession], machines: [{ name: "summit", ok: true }] };
      }
      return delayedRefresh.promise;
    },
    sendSessionInput: async () => ({ ok: true }),
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await waitForCondition(
    () => postCreateCalls >= 1,
    "the first post-create reconciliation",
  );

  const openExisting = mounted.container.querySelector<HTMLButtonElement>("button.slot-open");
  assert.ok(openExisting);
  await act(async () => {
    openExisting.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
    delayedRefresh.resolve({
      ok: true,
      sessions: [existingSession, createdSession],
      machines: [{ name: "summit", ok: true }],
    });
    await flushPromises();
  });
  assert.equal(
    mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey,
    "summit/existing-choice",
  );
});

test("Auto layout button toggles automatic layout off and back on", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const session = makeSession({ id: "auto-toggle", machine: "summit", status: "running" });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{ name: "summit", ok: true }],
    }),
  };
  mounted.window.localStorage.setItem(MODE_STORAGE, "2");
  mounted.window.localStorage.setItem(AUTO_STORAGE, "1");

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  const autoButton = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Auto layout"]');
  assert.ok(autoButton);
  assert.equal(autoButton.getAttribute("aria-pressed"), "true");

  await act(async () => {
    autoButton.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.equal(autoButton.getAttribute("aria-pressed"), "false");
  assert.equal(mounted.window.localStorage.getItem(AUTO_STORAGE), "0");

  await act(async () => {
    autoButton.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.equal(autoButton.getAttribute("aria-pressed"), "true");
  assert.equal(mounted.window.localStorage.getItem(AUTO_STORAGE), "1");
});

test("an empty slot on a later overview page creates a session on that page", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), asyncPollMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = ["a", "b", "c"].map((id) => makeSession({ id, title: `Session ${id.toUpperCase()}` }));
  const createdSession = makeSession({ id: "d", title: "Session D" });
  let created = false;
  let omitCreated = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      created = true;
      return { ok: true, id: createdSession.id, session: createdSession };
    },
    listSessions: async () => ({
      ok: true,
      sessions: created && !omitCreated ? [...sessions, createdSession] : sessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(MODE_STORAGE, "2");
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["summit/a", "summit/b"]));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findAriaButton(mounted.container, "Next page")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  assert.deepEqual(slotKeys(mounted.container), ["summit/c", null]);
  const emptySlot = mounted.container.querySelector<HTMLElement>('[data-slot-index="1"]');
  assert.ok(emptySlot);
  await act(async () => {
    emptySlot.querySelector<HTMLElement>('summary[aria-label="Session menu for slot 2"]')?.click();
    await flushPromises();
  });
  assertNoElement(emptySlot, ".slot-menu-item .repo-badge", "the empty projection cannot reassign page-one slots");
  await act(async () => {
    findTextButton(emptySlot, "+ New session...").click();
    await flushPromises();
  });
  assert.ok(mounted.container.querySelector('[role="dialog"][aria-label="New session"]'));
  await act(async () => {
    findTextButton(mounted.container, "Create").click();
    await flushPromises();
  });
  await waitForCondition(
    () => mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus")?.dataset.slotKey
      === "summit/d",
    "the created session to receive grid focus on page two",
  );
  assert.deepEqual(slotKeys(mounted.container), ["summit/c", "summit/d"]);
  assertNoElement(mounted.container, ".terminal-slot.is-focused");
  assert.equal(mounted.window.localStorage.getItem(SLOTS_STORAGE), JSON.stringify(["summit/a", "summit/b"]));

  await act(async () => {
    omitCreated = true;
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  assert.deepEqual(slotKeys(mounted.container), ["summit/c", null]);
  await act(async () => {
    omitCreated = false;
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  assert.deepEqual(slotKeys(mounted.container), ["summit/c", "summit/d"]);
  assert.equal(mounted.container.querySelector<HTMLElement>(".terminal-slot.is-grid-focus")?.dataset.slotKey, "summit/d");
  assertNoElement(mounted.container, ".terminal-slot.is-focused");
  assert.equal(mounted.window.localStorage.getItem(SLOTS_STORAGE), JSON.stringify(["summit/a", "summit/b"]));

  await act(async () => {
    findAriaButton(mounted.container, "Previous page").click();
    await flushPromises();
  });
  await act(async () => {
    omitCreated = true;
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  assert.deepEqual(slotKeys(mounted.container), ["summit/a", "summit/b"]);
  await act(async () => {
    omitCreated = false;
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  assert.deepEqual(slotKeys(mounted.container), ["summit/a", "summit/b"]);
  assertNoElement(mounted.container, ".terminal-slot.is-focused");
  assertNoElement(mounted.container, ".terminal-slot.is-grid-focus");
});

test("overview paging cycles past the last page back to the first", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = ["a", "b", "c"].map((id) => makeSession({ id, title: `Session ${id.toUpperCase()}` }));
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(MODE_STORAGE, "2");
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["summit/a", "summit/b"]));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  const pageLabel = () => mounted.container
    .querySelector<HTMLElement>(".session-list-page-label")
    ?.textContent
    ?.replace(/\s+/g, " ")
    .trim();
  const clickPage = async (label: "Previous page" | "Next page") => {
    await act(async () => {
      findAriaButton(mounted.container, label)
        .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushPromises();
    });
  };
  assert.equal(pageLabel(), "1 / 2");

  await clickPage("Next page");
  assert.equal(pageLabel(), "2 / 2");

  await clickPage("Next page");
  assert.equal(pageLabel(), "1 / 2");
  assert.deepEqual(slotKeys(mounted.container), ["summit/a", "summit/b"]);

  await clickPage("Previous page");
  assert.equal(pageLabel(), "2 / 2", "stepping back from the first page should cycle to the last");
  assert.deepEqual(slotKeys(mounted.container), ["summit/c", null]);
});

for (const [from, target] of [[1, 3], [1, 4], [4, 1]] as const) {
  test(`#982 header picker jumps directly from page ${from} to ${target}`, async () => {
    const mounted = installDom();
    cleanupStack.push(mounted.cleanup);
    const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
    cleanupStack.push(ssr.close);
    const sessions = Array.from({ length: 8 }, (_, index) => makeSession({
      id: `page-${index + 1}`, machine: "fixture", title: `Page fixture ${index + 1}`,
    }));
    globalThis.__agentConsoleDashboardBehaviorApiMock = {
      listSessions: async () => ({ ok: true, sessions, machines: [{ name: "fixture", ok: true }] }),
    };
    const savedSlots = JSON.stringify(["fixture/page-1", "fixture/page-2"]);
    mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
    mounted.window.localStorage.setItem(MODE_STORAGE, "2");
    mounted.window.localStorage.setItem(SLOTS_STORAGE, savedSlots);
    const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
    await act(async () => {
      mounted.root.render(createElement(Dashboard, {
        active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {},
        onDebug() {}, onUsage() {}, onSettings() {},
      }));
      await flushPromises();
    });
    const pageLabel = () => mounted.container.querySelector(".session-list-page-label")?.textContent?.trim();
    await waitForCondition(() => pageLabel() === "1 / 4", "four-page overview");
    for (let page = 1; page < from; page += 1) {
      await act(async () => { findAriaButton(mounted.container, "Next page").click(); await flushPromises(); });
    }
    assert.equal(pageLabel(), `${from} / 4`);
    const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-list-page-label");
    assert.ok(trigger);
    await act(async () => { trigger.click(); await flushPromises(); });
    const option = [...mounted.container.querySelectorAll<HTMLButtonElement>('.session-list-page-menu [role="menuitem"]')]
      .find(item => item.textContent === `Page ${target}`);
    assert.ok(option, "the requested page is offered");
    await act(async () => { option.click(); await flushPromises(); });
    assert.equal(pageLabel(), `${target} / 4`, "the selected page is an absolute destination");
    assert.deepEqual(slotKeys(mounted.container), [`fixture/page-${target * 2 - 1}`, `fixture/page-${target * 2}`]);
    assertNoElement(mounted.container, ".session-list-page-menu");
    assertNoElement(mounted.container, ".terminal-slot.is-focused");
    assert.equal(mounted.window.localStorage.getItem(SLOTS_STORAGE), savedSlots, "paging does not rewrite the layout");
  });
}

test("a visible later-page terminal can become the overview prompt target", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = ["a", "b", "c"].map((id) => makeSession({ id, title: `Session ${id.toUpperCase()}` }));
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(MODE_STORAGE, "2");
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["summit/a", "summit/b"]));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findAriaButton(mounted.container, "Next page")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  const laterPageSlot = mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/c"]');
  const input = laterPageSlot?.querySelector<HTMLTextAreaElement>(".terminal-input");
  assert.ok(laterPageSlot);
  assert.ok(input);
  await act(async () => {
    input.focus();
    await flushPromises();
  });
  assert.ok(
    laterPageSlot.classList.contains("is-cmd-focus-target"),
    "the current overview page should own prompt-target focus",
  );
});

test("Auto layout shortcuts step from the mode displayed on the current overview page", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = ["a", "b", "c", "d", "e", "f", "g"]
    .map((id) => makeSession({ id, title: `Session ${id.toUpperCase()}` }));
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };
  mounted.window.localStorage.setItem(AUTO_STORAGE, "1");
  mounted.window.localStorage.setItem(MODE_STORAGE, "6");
  mounted.window.localStorage.setItem(
    SLOTS_STORAGE,
    JSON.stringify(sessions.slice(0, 6).map((session) => `summit/${session.id}`)),
  );

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findAriaButton(mounted.container, "Next page")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.ok(mounted.container.querySelector(".session-workspace.mode-1"));

  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "n"));
    await flushPromises();
  });

  assert.equal(mounted.window.localStorage.getItem(AUTO_STORAGE), "0");
  assert.equal(mounted.window.localStorage.getItem(MODE_STORAGE), "6");
  assert.ok(
    mounted.container.querySelector(".session-workspace.mode-6"),
    "decreasing from the displayed one-pane mode should wrap to six panes",
  );
});

test("focusing a session does not change its terminal layout invalidation key", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = ["a", "b", "c", "d", "e", "f", "g"]
    .map((id) => makeSession({ id, title: `Session ${id.toUpperCase()}` }));
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };
  mounted.window.localStorage.setItem(AUTO_STORAGE, "1");
  mounted.window.localStorage.setItem(MODE_STORAGE, "6");
  mounted.window.localStorage.setItem(
    SLOTS_STORAGE,
    JSON.stringify(sessions.slice(0, 6).map((session) => `summit/${session.id}`)),
  );

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findAriaButton(mounted.container, "Next page")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  const laterPageSlot = mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/g"]');
  const terminal = laterPageSlot?.querySelector<HTMLElement>(".terminal-pane");
  assert.ok(laterPageSlot);
  assert.ok(terminal);
  const beforeFocus = terminal.dataset.layoutSyncKey;
  assert.match(beforeFocus ?? "", /^1:/);

  await act(async () => {
    laterPageSlot.dispatchEvent(
      new mounted.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    await flushPromises();
  });

  const focusedTerminal = mounted.container.querySelector<HTMLElement>(
    '[data-slot-key="summit/g"] .terminal-pane',
  );
  assert.ok(mounted.container.querySelector('[data-slot-key="summit/g"].is-focused'));
  assert.equal(focusedTerminal?.dataset.layoutSyncKey, beforeFocus);
});

test("Cmd+F focuses the session pane clicked in list mode instead of the remembered session", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const { SessionSlot } = await ssr.loadModule<typeof import("../src/SessionSlot.tsx")>("/src/SessionSlot.tsx");
  const Harness = createHarness(SessionSlot);

  await act(async () => {
    mounted.root.render(createElement(Harness));
  });
  assert.equal(
    mounted.container.querySelector(".terminal-slot.is-focused")?.getAttribute("data-slot-key"),
    "summit/a",
  );

  await act(async () => {
    window.dispatchEvent(metaKey(mounted.window, "f"));
  });
  assertNoElement(mounted.container, ".terminal-slot.is-focused");
  assert.equal(
    mounted.container.querySelector(".terminal-slot.is-cmd-focus-target")?.getAttribute("data-slot-key"),
    "summit/a",
  );

  const fourthSlot = mounted.container.querySelectorAll(".terminal-slot").item(3);
  assert.equal(fourthSlot.getAttribute("data-slot-key"), "summit/d");

  await act(async () => {
    fourthSlot.dispatchEvent(primaryPointerDown(mounted.window));
  });
  assert.equal(
    mounted.container.querySelector(".terminal-slot.is-cmd-focus-target")?.getAttribute("data-slot-key"),
    "summit/d",
  );

  await act(async () => {
    window.dispatchEvent(metaKey(mounted.window, "f"));
  });
  assert.equal(
    mounted.container.querySelector(".terminal-slot.is-focused")?.getAttribute("data-slot-key"),
    "summit/d",
  );
});

test("double-clicking a session pane in list mode focuses that session", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const { SessionSlot } = await ssr.loadModule<typeof import("../src/SessionSlot.tsx")>("/src/SessionSlot.tsx");
  const Harness = createHarness(SessionSlot);

  await act(async () => {
    mounted.root.render(createElement(Harness));
  });

  await act(async () => {
    window.dispatchEvent(metaKey(mounted.window, "f"));
  });
  assertNoElement(mounted.container, ".terminal-slot.is-focused");

  const fourthSlot = mounted.container.querySelectorAll(".terminal-slot").item(3);
  assert.equal(fourthSlot.getAttribute("data-slot-key"), "summit/d");

  await act(async () => {
    fourthSlot.dispatchEvent(doubleClick(mounted.window));
  });
  assert.equal(
    mounted.container.querySelector(".terminal-slot.is-focused")?.getAttribute("data-slot-key"),
    "summit/d",
  );
});

test("double-clicking the focused session pane returns to the session list", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const { SessionSlot } = await ssr.loadModule<typeof import("../src/SessionSlot.tsx")>("/src/SessionSlot.tsx");
  const Harness = createHarness(SessionSlot);

  await act(async () => {
    mounted.root.render(createElement(Harness));
  });

  const focusedSlot = mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused");
  assert.equal(focusedSlot?.dataset.slotKey, "summit/a");
  const focusedTerminal = focusedSlot.querySelector<HTMLElement>(".terminal-pane");
  assert.ok(focusedTerminal);

  await act(async () => {
    focusedTerminal.dispatchEvent(doubleClick(mounted.window));
  });
  assertNoElement(mounted.container, ".terminal-slot.is-focused");
  assert.equal(
    mounted.container.querySelector(".terminal-slot.is-cmd-focus-target")?.getAttribute("data-slot-key"),
    "summit/a",
  );
});

test("double-clicking a focused session menu trigger does not return to the session list", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const { SessionSlot } = await ssr.loadModule<typeof import("../src/SessionSlot.tsx")>("/src/SessionSlot.tsx");
  const Harness = createHarness(SessionSlot);

  await act(async () => {
    mounted.root.render(createElement(Harness));
  });

  const focusedSlot = mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused");
  assert.equal(focusedSlot?.dataset.slotKey, "summit/a");
  const menuTrigger = focusedSlot.querySelector<HTMLElement>("summary.slot-title");
  assert.ok(menuTrigger);

  await act(async () => {
    menuTrigger.dispatchEvent(doubleClick(mounted.window));
  });
  assert.equal(
    mounted.container.querySelector(".terminal-slot.is-focused")?.getAttribute("data-slot-key"),
    "summit/a",
  );
});

test("double-clicking a session menu trigger in list mode does not focus that session", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const { SessionSlot } = await ssr.loadModule<typeof import("../src/SessionSlot.tsx")>("/src/SessionSlot.tsx");
  const Harness = createHarness(SessionSlot);

  await act(async () => {
    mounted.root.render(createElement(Harness));
  });

  await act(async () => {
    window.dispatchEvent(metaKey(mounted.window, "f"));
  });
  assertNoElement(mounted.container, ".terminal-slot.is-focused");

  const fourthSlot = mounted.container.querySelectorAll(".terminal-slot").item(3);
  const menuTrigger = fourthSlot.querySelector("summary");
  assert.ok(menuTrigger);

  await act(async () => {
    menuTrigger.dispatchEvent(doubleClick(mounted.window));
  });
  assertNoElement(mounted.container, ".terminal-slot.is-focused");
});

test("Dashboard drives durable auto-resume controls and a shared-clock scheduled countdown", async () => {
  const mounted = installDom();
  const originalDateNow = Date.now;
  const originalSetInterval = mounted.window.setInterval.bind(mounted.window);
  const originalClearInterval = mounted.window.clearInterval.bind(mounted.window);
  let now = Date.parse("2026-07-12T12:30:00Z");
  let sharedTick: (() => void) | null = null;
  Date.now = () => now;
  mounted.window.setInterval = ((callback: TimerHandler, delay?: number) => {
    if (delay === 1_000) {
      sharedTick = callback as () => void;
      return 991;
    }
    return originalSetInterval(callback, delay);
  }) as typeof mounted.window.setInterval;
  mounted.window.clearInterval = ((id?: number) => {
    if (id !== 991) originalClearInterval(id);
  }) as typeof mounted.window.clearInterval;
  cleanupStack.push(() => {
    Date.now = originalDateNow;
    mounted.window.setInterval = originalSetInterval;
    mounted.window.clearInterval = originalClearInterval;
  });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);

  const enableGate = deferred<{ readonly ok: boolean }>();
  let enableAttempts = 0;
  const calls: string[] = [];
  let session = makeSession({
    id: "auto",
    machine: "summit",
    agent: "codex",
    status: "stopped",
    auto_resume_control_available: true,
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: false,
      state: "disabled",
    },
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "unbound",
      revision: 0,
    },
  });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{ name: "summit", ok: true }],
    }),
    setSessionAutoResume: async (machine, id, enabled, _signal, recoveryPolicy) => {
      calls.push(`PUT ${machine}/${id} ${enabled} ${recoveryPolicy ?? "default"}`);
      enableAttempts += 1;
      if (enableAttempts === 1) {
        return enableGate.promise;
      }
      session = {
        ...session,
        auto_resume: { ...session.auto_resume!, enabled: true, state: "enabled", scheduled_at: undefined },
      };
      return { ok: true };
    },
    cancelSessionAutoResume: async (machine, id) => {
      calls.push(`DELETE ${machine}/${id}`);
      session = {
        ...session,
        auto_resume: { ...session.auto_resume!, enabled: false, state: "cancelled" },
        codex_account: {
          schema_version: "agent-session.codex-account.v1",
          supported: true,
          state: "bound",
          selected_account: "account-a",
          effective_account: "account-a",
          selection_source: "explicit",
          revision: 1,
          applied_runtime_id: "auto-incarnation",
        },
      };
      return { ok: true };
    },
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  const enable = findAriaButton(mounted.container, "Enable auto-resume for Test session");
  await act(async () => {
    enable.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.deepEqual(calls, ["PUT summit/auto true default"]);

  const pending = findAriaButton(mounted.container, "Enable auto-resume for Test session");
  assert.equal(pending.disabled, true);
  assert.equal(pending.getAttribute("aria-busy"), "true");

  session = {
    ...session,
    auto_resume: {
      ...session.auto_resume!,
      enabled: true,
      state: "scheduled",
      scheduled_at: new Date(now + 5 * 60_000).toISOString(),
    },
  };
  await act(async () => {
    enableGate.resolve({ ok: true });
    await flushPromises();
  });
  assert.match(mounted.container.textContent ?? "", /Auto-resume enabled for Test session/);
  assert.match(mounted.container.textContent ?? "", /Auto-resume scheduled in 5m/);

  now += 61_000;
  await act(async () => sharedTick?.());
  assert.match(mounted.container.textContent ?? "", /Auto-resume scheduled in 4m/);

  const cancel = findAriaButton(mounted.container, "Cancel auto-resume for Test session");
  await act(async () => {
    cancel.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.deepEqual(calls, ["PUT summit/auto true default", "DELETE summit/auto"]);
  // Cancelled is a lingering resting state, so it collapses to the glyph-only
  // badge; its label lives on the accessible attributes rather than visible text.
  const cancelledBadge = mounted.container.querySelector(".auto-resume-status.auto-resume-cancelled");
  assert.ok(cancelledBadge, "expected the badge to reflect the cancelled state");
  assert.ok(cancelledBadge.classList.contains("auto-resume-icon-only"));
  assert.equal(cancelledBadge.getAttribute("aria-label"), "Enable auto-resume for Test session");
  assert.match(cancelledBadge.getAttribute("title") ?? "", /Auto-resume cancelled/);
  assert.match(mounted.container.textContent ?? "", /Auto-resume cancelled for Test session/);

  const reenable = findAriaButton(mounted.container, "Enable auto-resume for Test session");
  await act(async () => {
    reenable.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.deepEqual(calls, [
    "PUT summit/auto true default",
    "DELETE summit/auto",
    "PUT summit/auto true next_account_then_resume",
  ]);
  const reenabledBadge = mounted.container.querySelector(".auto-resume-status.auto-resume-enabled");
  assert.ok(reenabledBadge, "expected the badge to reflect the re-enabled state");
  assert.equal(reenabledBadge.getAttribute("aria-label"), "Cancel auto-resume for Test session");
  assert.match(reenabledBadge.getAttribute("title") ?? "", /Auto-resume on/);
  assert.match(mounted.container.textContent ?? "", /Auto-resume enabled for Test session/);
});

test("Dashboard disables completed auto-resume without cancelling an already-submitted continuation", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  let session = makeSession({
    id: "auto-resumed",
    machine: "summit",
    agent: "claude",
    status: "stopped",
    auto_resume_control_available: true,
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "resumed",
    },
  });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{ name: "summit", ok: true }],
    }),
    setSessionAutoResume: async (machine, id, enabled) => {
      calls.push(`PUT ${machine}/${id} ${enabled}`);
      session = {
        ...session,
        auto_resume: { ...session.auto_resume!, enabled: false, state: "disabled" },
      };
      return { ok: true };
    },
    cancelSessionAutoResume: async (machine, id) => {
      calls.push(`DELETE ${machine}/${id}`);
      return { ok: false, error: "the continuation was already submitted" };
    },
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  const disable = findAriaButton(mounted.container, "Disable auto-resume for Test session");
  assert.match(disable.getAttribute("title") ?? "", /Auto-resume resumed/);
  await act(async () => {
    disable.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  assert.deepEqual(calls, ["PUT summit/auto-resumed false"]);
  assert.ok(mounted.container.querySelector(".auto-resume-status.auto-resume-disabled"));
  assert.doesNotMatch(mounted.container.textContent ?? "", /already submitted/);
});

test("Dashboard controls auto-resume from the mobile overview card", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(mounted.window, "innerHeight", { configurable: true, value: 844 });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);

  const enableGate = deferred<{ readonly ok: boolean }>();
  const calls: string[] = [];
  let session = makeSession({
    id: "mobile-auto",
    machine: "summit",
    agent: "claude",
    status: "running",
    auto_resume_control_available: true,
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: false,
      state: "disabled",
    },
  });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{ name: "summit", ok: true }],
    }),
    setSessionAutoResume: async (machine, id, enabled) => {
      calls.push(`PUT ${machine}/${id} ${enabled}`);
      const result = await enableGate.promise;
      session = {
        ...session,
        auto_resume: { ...session.auto_resume!, enabled: true, state: "enabled" },
      };
      return result;
    },
    cancelSessionAutoResume: async (machine, id) => {
      calls.push(`DELETE ${machine}/${id}`);
      session = {
        ...session,
        auto_resume_control_available: false,
        auto_resume: { ...session.auto_resume!, enabled: false, state: "cancelled" },
      };
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  assert.ok(mounted.container.querySelector(".mobile-session-list"));

  const enable = findAriaButton(mounted.container, "Enable auto-resume for Test session");
  await act(async () => {
    enable.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.deepEqual(calls, ["PUT summit/mobile-auto true"]);
  assert.equal(findAriaButton(mounted.container, "Enable auto-resume for Test session").disabled, true);

  await act(async () => {
    enableGate.resolve({ ok: true });
    await flushPromises();
  });
  assert.match(mounted.container.textContent ?? "", /Auto-resume enabled for Test session/);

  const cancel = findAriaButton(mounted.container, "Cancel auto-resume for Test session");
  await act(async () => {
    cancel.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.deepEqual(calls, ["PUT summit/mobile-auto true", "DELETE summit/mobile-auto"]);
  assert.match(mounted.container.textContent ?? "", /Auto-resume cancelled for Test session/);
  assert.equal(
    [...mounted.container.querySelectorAll("button")].some((button) => /auto-resume/.test(button.getAttribute("aria-label") ?? "")),
    false,
  );
  const readOnly = mounted.container.querySelector<HTMLElement>(".auto-resume-status[role='status']");
  assert.ok(readOnly);
  assert.match(readOnly.getAttribute("aria-label") ?? "", /Auto-resume cancelled: Controls unavailable/);
});

test("Dashboard renders every filtered mobile session and hides the single-page header pager", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(mounted.window, "innerHeight", { configurable: true, value: 844 });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);

  const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
    id: `mobile-list-${index + 1}`,
    title: `Mobile list ${index + 1}`,
    created_at: `2026-07-23T00:0${index}:00Z`,
  }));
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  assert.equal(mounted.container.querySelectorAll(".mobile-session-card").length, 6);
  assert.ok(!mounted.container.querySelector(".session-list-pagination"), "a phone with one page hides the pager");
  assert.match(mounted.container.textContent ?? "", /Mobile list 6/);
});

test("Dashboard restores the mobile session list scroll position after leaving a session", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(mounted.window, "innerHeight", { configurable: true, value: 844 });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);

  const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
    id: `mobile-scroll-${index + 1}`,
    title: `Mobile scroll ${index + 1}`,
    created_at: `2026-07-23T00:0${index}:00Z`,
  }));
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  const list = mounted.container.querySelector<HTMLOListElement>(".mobile-session-list");
  assert.equal(list !== null, true, "expected the mobile overview list");
  if (!list) return;
  list.scrollTop = 320;
  list.dispatchEvent(new mounted.window.Event("scroll"));

  const openTarget = mounted.container.querySelector<HTMLElement>(".mobile-session-card-open-action");
  assert.equal(openTarget !== null, true, "expected the mobile preview Open action");
  if (!openTarget) return;
  await act(async () => {
    openTarget.click();
    await flushPromises();
  });
  assertNoElement(mounted.container, ".mobile-session-list");

  const backButton = mounted.container.querySelector<HTMLButtonElement>("[aria-label='Back to session list']");
  assert.equal(backButton !== null, true, "expected the focused-session back button");
  if (!backButton) return;
  await act(async () => {
    backButton.click();
    await flushPromises();
  });

  const restoredList = mounted.container.querySelector<HTMLOListElement>(".mobile-session-list");
  assert.equal(restoredList?.scrollTop ?? null, 320);
});

test("Dashboard surfaces auto-resume mutation failures without changing daemon-owned state", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const session = makeSession({
    id: "auto-fail",
    machine: "summit",
    agent: "claude",
    status: "stopped",
    auto_resume_control_available: true,
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: false,
      state: "disabled",
    },
  });
  let enableAttempts = 0;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions: [session], machines: [{ name: "summit", ok: true }] }),
    setSessionAutoResume: async () => {
      enableAttempts += 1;
      return { ok: false, error: "enable denied" };
    },
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  const announcement = mounted.container.querySelector<HTMLElement>(
    ".auto-resume-status-button ~ [role='status'][aria-live='polite']",
  );
  assert.ok(announcement);
  const announcedResults: string[] = [];
  const observer = new mounted.window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const message = node.textContent?.trim();
        if (message) announcedResults.push(message);
      }
    }
  });
  observer.observe(announcement, { childList: true, subtree: true });
  await act(async () => {
    findAriaButton(mounted.container, "Enable auto-resume for Test session")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await act(async () => {
    findAriaButton(mounted.container, "Enable auto-resume for Test session")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  observer.disconnect();
  assert.equal(enableAttempts, 2);
  assert.deepEqual(announcedResults, [
    "Could not enable auto-resume for Test session",
    "Could not enable auto-resume for Test session",
  ]);
  assert.match(mounted.container.textContent ?? "", /enable denied/);
  // The steady "off" state renders as a glyph-only badge, so its label lives on
  // the accessible attributes rather than in visible text. The daemon-owned
  // state must remain disabled after the failed enable.
  const badge = mounted.container.querySelector(".auto-resume-status.auto-resume-disabled");
  assert.ok(badge, "expected the badge to stay in the disabled state");
  assert.ok(badge.classList.contains("auto-resume-icon-only"));
  assert.equal(badge.getAttribute("aria-label"), "Enable auto-resume for Test session");
  assert.match(badge.getAttribute("title") ?? "", /Auto-resume off/);
  assert.match(mounted.container.textContent ?? "", /Could not enable auto-resume for Test session/);
});

test("Dashboard switches the next Codex account with incarnation and reconciles success or unknown outcome", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const accountSession = makeSession({
    id: "account-session",
    machine: "machine-a",
    title: "Account session",
    status: "running",
    session_incarnation: "incarnation-a",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "waiting",
      phase_changed_at: "2026-07-22T12:00:00Z",
      revision: 2,
      source: { kind: "provider", provider: "codex", confidence: "exact" },
    },
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      revision: 3,
      applied_runtime_id: "incarnation-a",
    },
  });
  const firstSwitch = deferred<{ readonly ok: boolean }>();
  const switchCalls: Array<readonly [string, string, string, string]> = [];
  let listCalls = 0;
  let listProjection: Session = accountSession;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => {
      listCalls += 1;
      return {
        ok: true,
        sessions: [listProjection],
        machines: [{ name: "machine-a", ok: true }],
      };
    },
    listAccounts: async (provider) => provider !== "codex" ? { accounts: [] } : ({ accounts: [
      { account: "account-a", label: "Account A", plan: "plan-a" },
      { account: "account-b", label: "Account B", plan: "plan-b" },
      { account: "account-c", label: "Account C", plan: "plan-c" },
    ] }),
    switchSessionAccount: async (provider, machine, id, account, incarnation) => {
      assert.equal(provider, "codex");
      switchCalls.push([machine, id, account, incarnation]);
      if (switchCalls.length === 1) {
        return firstSwitch.promise.then((result) => {
          if (result.ok) {
            listProjection = {
              ...accountSession,
              codex_account: {
                ...accountSession.codex_account!,
                next: { account: "account-b", revision: 1, state: "queued" },
              },
            };
          }
          return result;
        });
      }
      return { ok: false, error: "switch outcome is uncertain", outcomeUnknown: true };
    },
  };
  mounted.window.localStorage.setItem(MODE_STORAGE, "1");
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["machine-a/account-session"]));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["machine-a"],
      enabledMachines: ["machine-a"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  const openPopover = async () => {
    const trigger = mounted.container.querySelector<HTMLButtonElement>("button.account-status-codex");
    assert.ok(trigger);
    if (trigger.getAttribute("aria-expanded") !== "true") {
      await act(async () => {
        trigger.click();
        await flushPromises();
      });
    }
  };
  const switchButton = (account = "account-b") => {
    const button = mounted.container.querySelector<HTMLButtonElement>(
      `button[aria-label="Queue Codex account ${account} for the next prompt"]`,
    );
    assert.ok(button);
    return button;
  };

  await openPopover();
  await act(async () => {
    switchButton().click();
    await flushPromises();
  });
  assert.deepEqual(switchCalls, [["machine-a", "account-session", "account-b", "incarnation-a"]]);

  assert.equal(switchButton().disabled, true);
  const callsBeforeSuccessRefresh = listCalls;
  await act(async () => {
    firstSwitch.resolve({ ok: true });
    await flushPromises();
  });
  assert.ok(listCalls > callsBeforeSuccessRefresh);
  assert.equal(switchButton().disabled, true);
  const currentBadge = mounted.container.querySelector<HTMLButtonElement>("button.account-status-codex");
  assert.ok(currentBadge);
  assert.equal(currentBadge.textContent, "account-a");
  assert.match(currentBadge.getAttribute("aria-label") ?? "", /Next account account-b/);

  await act(async () => {
    switchButton("account-c").click();
    await flushPromises();
  });
  assert.equal(switchCalls.length, 2);
  assert.ok(listCalls > callsBeforeSuccessRefresh + 1);
  assert.match(mounted.container.textContent ?? "", /switch outcome is uncertain/);

  await openPopover();
  assert.equal(switchButton("account-c").disabled, false);
});

test("Dashboard lists Claude accounts only for capable machines and refreshes after a Claude switch", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const claudeSession = makeSession({
    id: "claude-session",
    agent: "claude",
    machine: "machine-a",
    title: "Claude session",
    status: "running",
    session_incarnation: "incarnation-c",
    claude_account: {
      schema_version: "agent-session.claude-account.v1",
      supported: true,
      state: "bound",
      selected_account: "alpha",
      selection_source: "explicit",
      revision: 1,
      applied_runtime_id: "incarnation-c",
    },
  });
  const accountMachines: string[] = [];
  const switchCalls: Array<readonly [string, string, string, string]> = [];
  let listCalls = 0;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => {
      listCalls += 1;
      return {
        ok: true,
        sessions: [claudeSession],
        machines: [
          { name: "machine-a", ok: true, capabilities: { claude_account_switch: true } },
          { name: "machine-b", ok: true },
        ],
      };
    },
    listAccounts: async (provider, machine) => {
      if (provider !== "claude") return { accounts: [] };
      accountMachines.push(machine);
      return { accounts: [{ account: "alpha", label: "Alpha" }, { account: "beta", label: "Beta" }] };
    },
    switchSessionAccount: async (provider, machine, id, account, incarnation) => {
      assert.equal(provider, "claude");
      switchCalls.push([machine, id, account, incarnation]);
      return { ok: true };
    },
  };
  mounted.window.localStorage.setItem(MODE_STORAGE, "1");
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["machine-a/claude-session"]));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["machine-a", "machine-b"],
      enabledMachines: ["machine-a", "machine-b"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  assert.ok(accountMachines.length > 0);
  assert.deepEqual([...new Set(accountMachines)], ["machine-a"]);
  const trigger = mounted.container.querySelector<HTMLButtonElement>("button.account-status-claude");
  assert.ok(trigger);
  await act(async () => {
    trigger.click();
    await flushPromises();
  });
  const choice = mounted.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Switch Claude account to beta"]',
  );
  assert.ok(choice);
  const callsBeforeSwitch = listCalls;
  await act(async () => {
    choice.click();
    await flushPromises();
  });
  assert.deepEqual(switchCalls, [["machine-a", "claude-session", "beta", "incarnation-c"]]);
  assert.ok(listCalls > callsBeforeSwitch);
});

test("Dashboard creates blank, enables default auto-resume, then submits a nonblank prompt", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  const promptSubmission = deferred<{ readonly ok: boolean }>();
  let created = false;
  const session = makeSession({
    id: "created-auto",
    machine: "summit",
    agent: "codex",
    status: "running",
    auto_resume_control_available: true,
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "enabled",
    },
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      effective_account: "account-a",
      selection_source: "default_at_launch",
      revision: 1,
      applied_runtime_id: "created-auto-incarnation",
    },
  });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async (_machine, body) => {
      calls.push(`create ${body.prompt ?? ""}`);
      created = true;
      return { ok: true, id: session.id, session };
    },
    listSessions: async () => ({
      ok: true,
      sessions: created ? [session] : [],
      machines: [{ name: "summit", ok: true }],
    }),
    setSessionAutoResume: async (machine, id, enabled, _signal, recoveryPolicy) => {
      calls.push(`auto-resume ${machine}/${id} ${enabled} ${recoveryPolicy ?? "default"}`);
      return { ok: true };
    },
    sendSessionInput: async () => {
      calls.push("unsafe-terminal-send");
      return { ok: true };
    },
    submitSessionPrompt: async (machine, id, body) => {
      calls.push(`structured ${machine}/${id} ${body.text}`);
      return promptSubmission.promise;
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: true,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  assert.deepEqual(calls, [
    "create ",
    "auto-resume summit/created-auto true next_account_then_resume",
    "structured summit/created-auto Inspect startup ordering",
  ]);
  assert.equal(
    mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Initial prompt"]')?.value,
    "Inspect startup ordering",
  );
  await act(async () => {
    promptSubmission.resolve({ ok: true });
    await flushPromises();
  });
  await waitForCondition(
    () => !mounted.container.querySelector('textarea[aria-label="Initial prompt"]'),
    "the successful initial prompt to clear",
  );
  assertNoElement(mounted.container, 'textarea[aria-label="Initial prompt"]');
});

test("Dashboard turns a create-time startup failure into one durable session without downstream mutations", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  const startup = {
    schema_version: "agent-session.startup.v1",
    state: "failed",
    stage: "runtime",
    started_at: "2026-07-14T10:00:00Z",
    failure_code: "agent-binary-unavailable",
    message: "The selected agent CLI could not be started.",
    occurred_at: "2026-07-14T10:00:01Z",
    retry_safe: false,
  } as const;
  const session = makeSession({
    id: "created-failed",
    machine: "summit",
    status: "stopped",
    startup,
  });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      calls.push("create");
      return { ok: true, id: session.id, startup };
    },
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{ name: "summit", ok: true }],
    }),
    setSessionAutoResume: async () => {
      calls.push("auto-resume");
      return { ok: true };
    },
    sendSessionInput: async () => {
      calls.push("submit");
      return { ok: true };
    },
    summarizeSessionTitle: async () => {
      calls.push("summarize");
      return { ok: true, title: "Must not apply", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      calls.push("title");
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: true,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "New").click();
    await flushPromises();
    findTextButton(mounted.container, "Create").click();
    await flushPromises();
  });

  assert.deepEqual(calls, ["create"]);
  assert.match(mounted.container.textContent ?? "", /Session failed to start/);
  assert.match(mounted.container.textContent ?? "", /default auto-resume and the initial prompt were not submitted/i);
  assert.equal(
    mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsubmitted initial prompt"]')?.value,
    "Inspect startup ordering",
  );
});

test("Dashboard submits multiline initialization through the structured route before deriving a title", async () => {
  const prompt = "Inspect first line\nthen second line";
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(prompt),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  const submission = deferred<{ readonly ok: boolean }>();
  let created = false;
  const session = makeSession({
    id: "created-structured",
    machine: "summit",
    agent: "codex",
    status: "running",
    title: "New Codex session",
    title_revision: 0,
    session_incarnation: "created-structured-incarnation",
  });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async (_machine, body) => {
      calls.push(`create ${body.prompt ?? ""}`);
      created = true;
      return { ok: true, id: session.id, session };
    },
    listSessions: async () => ({
      ok: true,
      sessions: created ? [session] : [],
      machines: [{ name: "summit", ok: true }],
    }),
    sendSessionInput: async () => {
      calls.push("unsafe-terminal-send");
      return { ok: true };
    },
    submitSessionPrompt: async (machine, id, body) => {
      calls.push(`structured ${machine}/${id} ${body.text}`);
      return submission.promise;
    },
    summarizeSessionTitle: async () => {
      calls.push("summarize");
      return { ok: true, title: "Inspect both lines", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      calls.push("title");
      return { ok: true, titleRevision: 1 };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: false,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "New").click();
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create").click();
    await flushPromises();
  });

  assert.deepEqual(calls, ["create ", `structured summit/created-structured ${prompt}`]);
  assert.equal(calls.includes("summarize"), false);
  assert.equal(calls.includes("unsafe-terminal-send"), false);

  await act(async () => {
    submission.resolve({ ok: true });
    await flushPromises();
  });
  await waitForCondition(
    () => calls.includes("title"),
    "the multiline prompt title PATCH",
  );
  assert.deepEqual(calls, [
    "create ",
    `structured summit/created-structured ${prompt}`,
    "summarize",
    "title",
  ]);
  assertNoElement(mounted.container, ".create-prompt-recovery");
});

test("Dashboard submits the reported URL-leading Codex prompt and patches its title before reconciliation", async () => {
  const prompt = "https://github.com/sampleRepo/agent-runtime-kit/issues/657 處理掉這個 issue 要考慮到 codex 的情況 反正有 .tera 能做不同版本的規則對吧";
  const titlePrompt = "處理掉這個 issue 要考慮到 codex 的情況 反正有 .tera 能做不同版本的規則對吧";
  const summarizedTitle = "Agent runtime kit #657 - Handle Codex issue";
  const titleState = {
    topic: "Agent runtime kit",
    topic_source: "auto" as const,
    references: ["#657"],
    activity: "Handle Codex issue",
  };
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(prompt),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  let created = false;
  const reconciliation = deferred<SessionsResponse>();
  const summary = deferred<{
    readonly ok: true;
    readonly title: string;
    readonly titleState: typeof titleState;
    readonly source: "summarizer";
  }>();
  const session = makeSession({
    id: "created-url-prompt",
    machine: "summit",
    agent: "codex",
    status: "running",
    title: "New Codex session",
    title_state: {
      topic: null,
      topic_source: "none",
      references: [],
      activity: null,
    },
    title_state_supported: true,
    title_revision: 0,
    session_incarnation: "created-url-prompt-incarnation",
  });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async (_machine, body) => {
      calls.push(`create ${body.prompt ?? ""}`);
      created = true;
      return { ok: true, id: session.id, session };
    },
    listSessions: async () => {
      if (created) {
        const result = await reconciliation.promise;
        calls.push("reconciled");
        return result;
      }
      return {
        ok: true,
        sessions: [],
        machines: [{ name: "summit", ok: true }],
      };
    },
    sendSessionInput: async () => {
      calls.push("unsafe-terminal-send");
      return { ok: true };
    },
    submitSessionPrompt: async (machine, id, body) => {
      calls.push(
        `structured ${machine}/${id} ${body.text} inc=${String(body.expected_session_incarnation)}`,
      );
      return { ok: true };
    },
    summarizeSessionTitle: async (body) => {
      const request = body as { readonly prompt?: string };
      calls.push(`summarize ${request.prompt ?? ""}`);
      return summary.promise;
    },
    updateSessionTitle: async (
      machine,
      id,
      title,
      _signal,
      expectedRevision,
      expectedIncarnation,
      expectedTitle,
      updatedTitleState,
    ) => {
      calls.push(
        `title ${machine}/${id} ${title ?? ""} rev=${String(expectedRevision)} inc=${String(expectedIncarnation)} observed=${String(expectedTitle)}`,
      );
      assert.deepEqual(updatedTitleState, titleState);
      return { ok: true, titleRevision: 1 };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: false,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "New").click();
    await flushPromises();
    findTextButton(mounted.container, "Create").click();
    await flushPromises();
  });
  await waitForCondition(
    () => calls.some((call) => call.startsWith("summarize ")),
    "the create-response prompt summary",
  );

  assert.deepEqual(calls, [
    "create ",
    `structured summit/created-url-prompt ${prompt} inc=created-url-prompt-incarnation`,
    `summarize ${titlePrompt}`,
  ]);
  await act(async () => {
    summary.resolve({ ok: true, title: summarizedTitle, titleState, source: "summarizer" });
    await flushPromises();
  });
  await waitForCondition(
    () => calls.some((call) => call.startsWith("title summit/created-url-prompt")),
    "the create-response title PATCH",
  );

  assert.deepEqual(calls, [
    "create ",
    `structured summit/created-url-prompt ${prompt} inc=created-url-prompt-incarnation`,
    `summarize ${titlePrompt}`,
    `title summit/created-url-prompt ${summarizedTitle} rev=0 inc=created-url-prompt-incarnation observed=New Codex session`,
  ]);
  await act(async () => {
    reconciliation.resolve({
      ok: true,
      sessions: [session],
      machines: [{ name: "summit", ok: true }],
    });
    await flushPromises();
  });
  await waitForCondition(
    () => calls.includes("reconciled"),
    "the deferred post-create reconciliation",
  );
  assert.equal(calls.filter((call) => call.startsWith("title ")).length, 1);
  assertNoElement(mounted.container, ".create-prompt-recovery");
});

test("Dashboard retains multiline initialization when the structured endpoint is unavailable", async () => {
  const prompt = "Inspect first line\nthen second line";
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(prompt),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  const session = makeSession({ id: "created-old-daemon", machine: "summit", agent: "codex", status: "running" });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => ({ ok: true, id: session.id, session }),
    listSessions: async () => ({ ok: true, sessions: [session], machines: [{ name: "summit", ok: true }] }),
    sendSessionInput: async () => {
      calls.push("unsafe-terminal-send");
      return { ok: true };
    },
    submitSessionPrompt: async () => {
      calls.push("structured");
      return { ok: false, error: "daemon status 404" };
    },
    summarizeSessionTitle: async () => {
      calls.push("summarize");
      return { ok: true, title: "Must not apply", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      calls.push("title");
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: false,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "New").click();
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create").click();
    await flushPromises();
  });
  await waitForCondition(
    () => calls.includes("structured"),
    "the fenced prompt rejection",
  );

  assert.deepEqual(calls, ["structured"]);
  assert.equal(
    mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsubmitted initial prompt"]')?.value,
    prompt,
  );
  assert.match(mounted.container.textContent ?? "", /daemon status 404/i);
});

test("Dashboard isolates a shortcut-opened busy create modal from the focused terminal", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  globalThis.__agentConsoleTerminalKeys = [];
  const autoResumeInitialization = deferred<{ readonly ok: boolean }>();
  const existingSession = makeSession({ id: "existing", machine: "summit", agent: "codex", status: "running" });
  const createdSession = makeSession({ id: "created-isolated", machine: "summit", agent: "codex", status: "running" });
  let created = false;
  let sendCalls = 0;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      created = true;
      return { ok: true, id: createdSession.id, session: createdSession };
    },
    listSessions: async () => ({
      ok: true,
      sessions: created ? [existingSession, createdSession] : [existingSession],
      machines: [{ name: "summit", ok: true }],
    }),
    setSessionAutoResume: async () => autoResumeInitialization.promise,
    sendSessionInput: async () => {
      sendCalls += 1;
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: true,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  const terminalInput = mounted.container.querySelector<HTMLTextAreaElement>(".terminal-input");
  assert.ok(terminalInput);
  terminalInput.focus();
  assertActiveElement(mounted.window, terminalInput);
  await act(async () => {
    terminalInput.dispatchEvent(metaKey(mounted.window, "t"));
    await flushPromises();
  });

  const dialog = mounted.container.querySelector<HTMLElement>('[role="dialog"]');
  const promptInput = dialog?.querySelector<HTMLTextAreaElement>("textarea");
  assert.ok(dialog);
  assert.ok(promptInput);
  assert.equal(dialog.contains(mounted.window.document.activeElement), true);
  assertActiveElement(mounted.window, dialog);
  await act(async () => {
    dialog.dispatchEvent(new mounted.window.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    await flushPromises();
  });
  assertActiveElement(mounted.window, findTextButton(dialog, "Create"));
  dialog.focus();
  await act(async () => {
    findTextButton(dialog, "Create").click();
    await flushPromises();
  });
  await waitForCondition(
    () => promptInput.disabled,
    "the create modal to enter its busy state",
  );

  assert.equal(sendCalls, 0);
  assert.equal(promptInput.disabled, true);
  assert.equal(
    [...dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
      "input, select, textarea, button",
    )].every((control) => control.disabled),
    true,
  );
  assert.equal(mounted.container.querySelector(".session-workspace")?.hasAttribute("inert"), true);
  assert.equal(dialog.contains(mounted.window.document.activeElement), true);
  const valueSetter = Object.getOwnPropertyDescriptor(
    mounted.window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  assert.ok(valueSetter);
  await act(async () => {
    valueSetter.call(promptInput, "Edited while busy");
    promptInput.dispatchEvent(new mounted.window.Event("input", { bubbles: true, cancelable: true }));
    mounted.window.document.activeElement?.dispatchEvent(
      new mounted.window.KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }),
    );
    mounted.window.dispatchEvent(new mounted.window.Event("resize"));
    await flushPromises();
  });
  assert.equal(promptInput.value, "");
  assert.deepEqual(globalThis.__agentConsoleTerminalKeys, []);

  await act(async () => {
    autoResumeInitialization.resolve({ ok: true });
    await flushPromises();
  });
});

test("Dashboard recovers a failed authoritative prompt without prompt-derived retitling", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  let created = false;
  const session = makeSession({
    id: "created-send-failed",
    machine: "summit",
    agent: "codex",
    status: "running",
  });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      calls.push("create");
      created = true;
      return { ok: true, id: session.id, session };
    },
    listSessions: async () => ({
      ok: true,
      sessions: created ? [session] : [],
      machines: [{ name: "summit", ok: true }],
    }),
    sendSessionInput: async () => {
      calls.push("unsafe-terminal-send");
      return { ok: true };
    },
    submitSessionPrompt: async () => {
      calls.push("structured");
      return { ok: false, error: "send failed" };
    },
    summarizeSessionTitle: async () => {
      calls.push("summarize");
      return { ok: true, title: "Must not apply", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      calls.push("title");
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: false,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await waitForCondition(
    () => calls.includes("structured"),
    "the failed fenced prompt submission",
  );

  assert.deepEqual(calls, ["create", "structured"]);
  assert.match(mounted.container.textContent ?? "", /send failed/i);
  assert.equal(
    mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsubmitted initial prompt"]')?.value,
    "Inspect startup ordering",
  );
});

test("Dashboard keeps multiple prompt recoveries independently copyable and dismissible", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    queuedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const clipboardWrites: string[] = [];
  Object.defineProperty(mounted.window.navigator, "clipboard", {
    value: { writeText: async (value: string) => { clipboardWrites.push(value); } },
    configurable: true,
  });
  const sessions: Session[] = [];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      const id = `created-failed-${sessions.length + 1}`;
      sessions.push(makeSession({ id, machine: "summit", agent: "codex", status: "running" }));
      return { ok: true, id };
    },
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
    submitSessionPrompt: async () => ({ ok: false, error: "send failed" }),
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: false,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await act(async () => {
      findTextButton(mounted.container, "New")
        .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushPromises();
      findTextButton(mounted.container, "Create")
        .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushPromises();
    });
    await waitForCondition(
      () => mounted.container.querySelectorAll(".create-prompt-recovery").length === attempt + 1,
      `prompt recovery ${attempt + 1}`,
    );
  }

  let recoveries = [...mounted.container.querySelectorAll<HTMLElement>(".create-prompt-recovery")];
  assert.deepEqual(
    recoveries.map((entry) => entry.querySelector<HTMLTextAreaElement>("textarea")?.value),
    ["First retained prompt", "Second retained prompt"],
  );
  assert.match(recoveries[0]!.textContent ?? "", /summit \/ created-failed-1/);
  assert.match(recoveries[1]!.textContent ?? "", /summit \/ created-failed-2/);

  await act(async () => {
    findTextButton(recoveries[0]!, "Copy prompt").click();
    findTextButton(recoveries[1]!, "Copy prompt").click();
    await flushPromises();
  });
  assert.deepEqual(clipboardWrites, ["First retained prompt", "Second retained prompt"]);

  await act(async () => {
    findTextButton(recoveries[0]!, "Dismiss").click();
    await flushPromises();
  });
  recoveries = [...mounted.container.querySelectorAll<HTMLElement>(".create-prompt-recovery")];
  assert.deepEqual(
    recoveries.map((entry) => entry.querySelector<HTMLTextAreaElement>("textarea")?.value),
    ["Second retained prompt"],
  );
});

test("Dashboard bounds retained prompt recovery and re-enables create after dismissal", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    queuedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const sessions: Session[] = [];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      const id = `created-cap-${sessions.length + 1}`;
      sessions.push(makeSession({ id, machine: "summit", agent: "codex", status: "running" }));
      return { ok: true, id };
    },
    listSessions: async () => ({
      ok: true,
      sessions,
      machines: [{ name: "summit", ok: true }],
    }),
    submitSessionPrompt: async () => ({ ok: false, error: "send failed" }),
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: false,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await act(async () => {
      findTextButton(mounted.container, "New").click();
      await flushPromises();
      findTextButton(mounted.container, "Create").click();
      await flushPromises();
    });
    await waitForCondition(
      () => mounted.container.querySelectorAll(".create-prompt-recovery").length === attempt + 1,
      `bounded prompt recovery ${attempt + 1}`,
    );
  }

  assert.equal(mounted.container.querySelectorAll(".create-prompt-recovery").length, 4);
  const newButton = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.getAttribute("aria-label") === "New session");
  assert.ok(newButton);
  assert.equal(newButton.hasAttribute("disabled"), true);
  assert.match(mounted.container.textContent ?? "", /dismiss a retained prompt/i);

  await act(async () => {
    findTextButton(mounted.container, "Dismiss").click();
    await flushPromises();
  });
  assert.equal(newButton.hasAttribute("disabled"), false);
});

test("Dashboard bounds an unknown auto-resume outcome, retains the prompt, and unlocks create", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
    nativeSetTimeout(handler, timeout === 15_000 ? 5 : timeout, ...args)
  )) as typeof globalThis.setTimeout;
  cleanupStack.push(() => { globalThis.setTimeout = nativeSetTimeout; });
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const session = makeSession({ id: "created-timeout", machine: "summit", agent: "codex", status: "running" });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => ({ ok: true, id: session.id, session }),
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{ name: "summit", ok: true }],
    }),
    setSessionAutoResume: async () => new Promise(() => {}),
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: true,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "New").click();
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create").click();
    await flushPromises();
  });
  await waitForCondition(
    () => /outcome is unknown/i.test(mounted.container.textContent ?? ""),
    "the bounded auto-resume timeout",
  );

  assert.match(mounted.container.textContent ?? "", /outcome is unknown/i);
  assert.equal(
    mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsubmitted initial prompt"]')?.value,
    "Inspect startup ordering",
  );
  assert.equal(findTextButton(mounted.container, "New").hasAttribute("disabled"), false);
});

test("Dashboard retains an unknown creation prompt, blocks retry, and performs no downstream mutations", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
    nativeSetTimeout(handler, isCodexCreateDeadline(timeout) ? 5 : timeout, ...args)
  )) as typeof globalThis.setTimeout;
  cleanupStack.push(() => { globalThis.setTimeout = nativeSetTimeout; });
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      calls.push("create");
      return new Promise(() => {});
    },
    setSessionAutoResume: async () => {
      calls.push("auto-resume");
      return { ok: true };
    },
    sendSessionInput: async () => {
      calls.push("submit");
      return { ok: true };
    },
    summarizeSessionTitle: async () => {
      calls.push("summarize");
      return { ok: true, title: "Must not apply", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      calls.push("title");
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: true,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "New").click();
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create").click();
    await flushPromises();
  });
  await waitForCondition(
    () => /session creation timed out/i.test(mounted.container.textContent ?? ""),
    "the bounded creation timeout",
  );

  assert.deepEqual(calls, ["create"]);
  assert.match(mounted.container.textContent ?? "", /session creation timed out/i);
  assert.match(mounted.container.textContent ?? "", /creation may have completed without this prompt/i);
  assert.equal(
    mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsubmitted initial prompt"]')?.value,
    "Inspect startup ordering",
  );
  const newButton = findTextButton(mounted.container, "New");
  assert.equal(newButton.hasAttribute("disabled"), true);
  await act(async () => {
    findTextButton(mounted.container, "Dismiss").click();
    await flushPromises();
  });
  assert.equal(newButton.hasAttribute("disabled"), false);
  assert.deepEqual(calls, ["create"]);
});

test("Dashboard unlocks a new session after a post-incident refresh and explicit acknowledgement", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const nativeSetTimeout = globalThis.setTimeout;
  const heldPollTimers = new Set<ReturnType<typeof setTimeout>>();
  let nextPoll: (() => void) | null = null;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 4_000 && typeof handler === "function") {
      // Drive the poll explicitly: elapsed wall time must not reconcile the
      // incident while this test is checking the stale response.
      const timer = nativeSetTimeout(() => {}, 60_000);
      heldPollTimers.add(timer);
      nextPoll = () => {
        clearTimeout(timer);
        heldPollTimers.delete(timer);
        handler(...args);
      };
      return timer;
    }
    return nativeSetTimeout(handler, isCodexCreateDeadline(timeout) ? 200 : timeout, ...args);
  }) as typeof globalThis.setTimeout;
  cleanupStack.push(() => {
    for (const timer of heldPollTimers) clearTimeout(timer);
    globalThis.setTimeout = nativeSetTimeout;
  });
  const runNextPoll = async () => {
    await waitForCondition(() => nextPoll !== null, "the scheduled session poll");
    await act(async () => {
      const poll = nextPoll;
      nextPoll = null;
      assert.ok(poll);
      poll();
      await flushPromises();
    });
  };
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  const reachable: SessionsResponse = { ok: true, sessions: [], machines: [{ name: "summit", ok: true }] };
  let createStarted = false;
  let incidentRetained = false;
  let listsAfterIncident = 0;
  // The first read issued while the create is pending is held until after the
  // incident is retained: it answers, but it was issued before the failure.
  const preIncidentRead = deferred<SessionsResponse>();
  let preIncidentReadIssued = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => {
      if (createStarted && !incidentRetained && !preIncidentReadIssued) {
        preIncidentReadIssued = true;
        return preIncidentRead.promise;
      }
      if (incidentRetained) listsAfterIncident += 1;
      return reachable;
    },
    resetSessionPollRequests: () => {
      calls.push("reset-poll");
      incidentRetained = true;
    },
    createSession: async () => {
      calls.push("create");
      createStarted = true;
      return new Promise(() => {});
    },
    setSessionAutoResume: async () => {
      calls.push("auto-resume");
      return { ok: true };
    },
    sendSessionInput: async () => {
      calls.push("submit");
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: false,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "New").click();
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create").click();
    await flushPromises();
  });
  await runNextPoll();
  await waitForCondition(
    () => /creation may have completed without this prompt/i.test(mounted.container.textContent ?? ""),
    "the retained unknown-create incident",
  );
  const newButton = findTextButton(mounted.container, "New");
  assert.equal(newButton.hasAttribute("disabled"), true);
  assert.equal(preIncidentReadIssued, true);
  assert.equal(findTextButton(mounted.container, "Allow new session").hasAttribute("disabled"), true);

  // An answer to a read issued before the failure cannot reconcile the incident.
  await act(async () => {
    listsAfterIncident = 0;
    preIncidentRead.resolve(reachable);
    await flushPromises();
  });
  assert.equal(listsAfterIncident, 0);
  assert.equal(findTextButton(mounted.container, "Allow new session").hasAttribute("disabled"), true);

  // The next regular poll is issued after the incident and answers for the machine.
  await runNextPoll();
  await waitForCondition(
    () => !findTextButton(mounted.container, "Allow new session").hasAttribute("disabled"),
    "the post-incident poll",
  );
  assert.ok(listsAfterIncident >= 1);
  assert.match(mounted.container.textContent ?? "", /session list has been refreshed/i);

  await act(async () => {
    findTextButton(mounted.container, "Allow new session").click();
    await flushPromises();
  });
  assert.equal(findTextButton(mounted.container, "New").hasAttribute("disabled"), false);
  // The incident and its prompt remain visible and dismissible.
  assert.equal(
    mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsubmitted initial prompt"]')?.value,
    "Inspect startup ordering",
  );
  assert.match(mounted.container.textContent ?? "", /creation may have completed without this prompt/i);
  assert.ok(findTextButton(mounted.container, "Dismiss"));
  assert.equal(mounted.container.textContent?.includes("Allow new session"), false);
  assert.deepEqual(calls, ["create", "reset-poll"]);
});

test("Dashboard retains an authoritative prompt with unknown send outcome and never retitles it", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
    nativeSetTimeout(handler, timeout === 15_000 ? 5 : timeout, ...args)
  )) as typeof globalThis.setTimeout;
  cleanupStack.push(() => { globalThis.setTimeout = nativeSetTimeout; });
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  const session = makeSession({ id: "created-send-timeout", machine: "summit", agent: "codex", status: "running" });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      calls.push("create");
      return { ok: true, id: session.id, session };
    },
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{ name: "summit", ok: true }],
    }),
    sendSessionInput: async () => {
      calls.push("unsafe-terminal-send");
      return { ok: true };
    },
    submitSessionPrompt: async () => {
      calls.push("structured");
      return new Promise(() => {});
    },
    summarizeSessionTitle: async () => {
      calls.push("summarize");
      return { ok: true, title: "Must not apply", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      calls.push("title");
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: false,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "New").click();
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create").click();
    await flushPromises();
  });
  await waitForCondition(
    () => /submission outcome is unknown/i.test(mounted.container.textContent ?? ""),
    "the bounded provider submission timeout",
  );

  assert.deepEqual(calls, ["create", "structured"]);
  assert.match(mounted.container.textContent ?? "", /submission outcome is unknown/i);
  const recovery = mounted.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Unsubmitted initial prompt"]',
  );
  assert.equal(recovery?.value, "Inspect startup ordering");
  assert.match(
    recovery?.closest(".create-prompt-recovery")?.textContent ?? "",
    /may have been submitted.*summit \/ created-send-timeout/is,
  );
  assert.equal(findTextButton(mounted.container, "New").hasAttribute("disabled"), false);
});

test("Dashboard refuses to initialize a no-id created session from an uncorrelated list result", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  let created = false;
  let createAttempts = 0;
  const session = makeSession({ id: "resolved-auto", machine: "summit", agent: "claude", status: "running" });
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      calls.push("create");
      createAttempts += 1;
      if (createAttempts === 2) {
        return { ok: false, error: "replacement create failed" };
      }
      created = true;
      return createAttempts === 1 ? { ok: true } : { ok: true, id: session.id };
    },
    listSessions: async () => ({
      ok: true,
      sessions: created ? [session] : [],
      machines: [{ name: "summit", ok: true }],
    }),
    putLayoutOrder: async (order) => {
      calls.push("layout");
      return { order, revision: 1, reachable: true, conflict: false };
    },
    summarizeSessionTitle: async () => {
      calls.push("summarize");
      return { ok: true, title: "Unrelated retitle", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      calls.push("title");
      return { ok: true };
    },
    setSessionAutoResume: async (machine, id, enabled) => {
      calls.push(`auto-resume ${machine}/${id} ${enabled}`);
      return { ok: true };
    },
    sendSessionInput: async (machine, id) => {
      calls.push(`submit ${machine}/${id}`);
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: true,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await waitForCondition(
    () => /created session identity was not confirmed/i.test(mounted.container.textContent ?? ""),
    "the uncorrelated create result to fail closed",
  );

  assert.deepEqual(calls, ["create"]);
  assert.match(mounted.container.textContent ?? "", /created session identity was not confirmed/i);
  assert.match(mounted.container.textContent ?? "", /initial prompt was not submitted/i);
  const recovery = mounted.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Unsubmitted initial prompt"]',
  );
  assert.equal(recovery?.value, "Inspect startup ordering");

  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  assert.deepEqual(calls, ["create", "create"]);
  assert.equal(
    mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsubmitted initial prompt"]')?.value,
    "Inspect startup ordering",
  );

  await act(async () => {
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await waitForCondition(
    () => mounted.container.querySelectorAll(".create-prompt-recovery").length === 2,
    "the second unfenced prompt recovery",
  );
  assert.equal(
    mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Unsubmitted initial prompt"]')?.value,
    "Inspect startup ordering",
  );
});

test("Dashboard surfaces an unsent staged prompt when no-id reconciliation fails", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    stagedPromptCreateDialogMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  let created = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    createSession: async () => {
      calls.push("create");
      created = true;
      return { ok: true };
    },
    listSessions: async () => {
      if (created) {
        throw new Error("list failed");
      }
      return { ok: true, sessions: [], machines: [{ name: "summit", ok: true }] };
    },
    setSessionAutoResume: async () => {
      calls.push("auto-resume");
      return { ok: true };
    },
    sendSessionInput: async () => {
      calls.push("submit");
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      defaultAutoResume: true,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await act(async () => {
    findTextButton(mounted.container, "New")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Create")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await waitForCondition(
    () => /initial prompt was not submitted/i.test(mounted.container.textContent ?? ""),
    "the failed no-id reconciliation recovery",
  );

  assert.deepEqual(calls, ["create"]);
  assert.match(mounted.container.textContent ?? "", /initial prompt was not submitted/i);
});

test("Dashboard does not publish a failed manual rename as the retitle anchor", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const session = makeSession({
    id: "rename-fail",
    machine: "summit",
    title: "Existing intent - Current action",
    title_revision: 0,
    created_at: "2026-07-08T00:00:00Z",
  });
  mounted.window.localStorage.setItem(
    "agent-console.auto-title.states.v1",
    JSON.stringify({
      "summit/rename-fail": {
        baseTitle: "Existing intent",
        baseTitleConfirmed: true,
        disabled: false,
        ownedTitle: session.title,
      },
    }),
  );
  let titleUpdates = 0;
  const renameUpdate = deferred<{ ok: false; error: string }>();
  const rejectedRenameUpdate = deferred<{ ok: true }>();
  const summaryRequests: Array<{ readonly baseTitle?: string | null }> = [];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({ ...session, tail: "Retitle after the rejected rename." }),
    summarizeSessionTitle: async (body) => {
      summaryRequests.push(body as { readonly baseTitle?: string | null });
      return { ok: true, title: "Existing intent - Retitled", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      titleUpdates += 1;
      if (titleUpdates === 1) return renameUpdate.promise;
      if (titleUpdates === 2) return rejectedRenameUpdate.promise;
      return { ok: true };
    },
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  const menuTrigger = mounted.container.querySelector<HTMLElement>("summary.slot-title");
  assert.ok(menuTrigger);
  await act(async () => {
    menuTrigger.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Rename title")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  const input = mounted.container.querySelector<HTMLInputElement>(".slot-title-input");
  const form = mounted.container.querySelector<HTMLFormElement>(".slot-title-form");
  assert.ok(input);
  assert.ok(form);
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      mounted.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    assert.ok(valueSetter);
    valueSetter.call(input, "Rejected rename");
    input.dispatchEvent(new mounted.window.Event("input", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new mounted.window.Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.equal(
    JSON.parse(
      mounted.window.localStorage.getItem("agent-console.auto-title.states.v1") ?? "{}",
    )["summit/rename-fail"]?.disabled,
    true,
  );
  await act(async () => {
    renameUpdate.resolve({ ok: false, error: "title update was not confirmed" });
    await flushPromises();
  });
  assert.equal(titleUpdates, 1);

  await act(async () => {
    form.dispatchEvent(new mounted.window.Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.equal(
    JSON.parse(
      mounted.window.localStorage.getItem("agent-console.auto-title.states.v1") ?? "{}",
    )["summit/rename-fail"]?.disabled,
    true,
  );
  await act(async () => {
    rejectedRenameUpdate.reject(new Error("rename network failed"));
    await flushPromises();
  });
  assert.equal(titleUpdates, 2);

  const retitle = mounted.container.querySelector<HTMLButtonElement>(".agent-retitle-button");
  assert.ok(retitle);
  await act(async () => {
    retitle.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });

  assert.equal(summaryRequests.length, 1);
  assert.equal(summaryRequests[0]?.baseTitle, "Existing intent");
});

test("Dashboard removes a producer-tombstoned card immediately and keeps cleanup pending maintenance-only", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const session = makeSession({
    id: "direct-tombstone",
    machine: "summit",
    title: "Direct Tombstone",
    status: "stopped",
    session_incarnation: "launch-direct",
  });
  let deleted = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: deleted ? [] : [session],
      machines: [{ name: "summit", ok: true }],
    }),
    killSession: async () => {
      deleted = true;
      return { ok: true, cleanupPending: true };
    },
  };
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["summit/direct-tombstone"]));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".slot-action.danger")?.click();
    await flushPromises();
    findTextButton(mounted.container, "Delete session").click();
    await flushPromises();
  });

  assert.equal(mounted.container.textContent?.includes("Direct Tombstone"), false);
  assertNoElement(mounted.container, '.terminal-slot[data-slot-key="summit/direct-tombstone"]');
  assert.match(mounted.container.querySelector(".repair-toast")?.textContent ?? "", /cleanup is pending/i);
  await act(async () => {
    findTextButton(mounted.container.querySelector(".repair-toast")!, "View failures").click();
    await flushPromises();
  });
  const cleanupDrawer = mounted.container.querySelector<HTMLElement>(".maintenance-drawer");
  assert.match(cleanupDrawer?.textContent ?? "", /cleanup pending/i);
  assert.equal(
    [...(cleanupDrawer?.querySelectorAll("button") ?? [])].some((button) => button.textContent?.includes("Inspect again")),
    false,
  );
});

test("Dashboard makes archive the single default action and locks its delete selector while busy", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    asyncPollMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const session = makeSession({
    id: "archive-race",
    machine: "summit",
    title: "Archive race",
    status: "stopped",
    session_incarnation: "archive-incarnation",
    provider_resume: { provider: "codex", session_id: "provider-archive-race" },
  });
  const archive = deferred<{ readonly ok: boolean }>();
  let deleteCalls = 0;
  let archiveAvailable = true;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{
        name: "summit",
        ok: true,
        capabilities: { history: true, archive: archiveAvailable },
      }],
    }),
    archiveSession: async () => archive.promise,
    killSession: async () => {
      deleteCalls += 1;
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".slot-action.danger")?.click();
    await flushPromises();
  });

  const deleteInstead = mounted.container.querySelector<HTMLInputElement>(
    '.close-session-delete-option input[type="checkbox"]',
  );
  assert.ok(deleteInstead);
  assert.equal(deleteInstead.checked, false);
  assert.ok(findAriaButton(mounted.container, "Cancel close session"));
  assert.equal(
    [...mounted.container.querySelectorAll("button")]
      .some((button) => button.textContent?.includes("Delete session")),
    false,
  );

  await act(async () => {
    deleteInstead.click();
    await flushPromises();
  });
  assert.equal(deleteInstead.checked, true);
  assert.equal(
    [...mounted.container.querySelectorAll("button")]
      .some((button) => button.textContent?.includes("Archive session")),
    false,
  );
  assert.ok(findTextButton(mounted.container, "Delete session"));

  archiveAvailable = false;
  await act(async () => {
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  const unavailableDelete = findTextButton(mounted.container, "Delete session");
  assert.equal(unavailableDelete.disabled, true);
  assert.equal(deleteInstead.disabled, true);
  assert.match(mounted.container.textContent ?? "", /Archive became unavailable/i);
  assert.equal(
    [...mounted.container.querySelectorAll("button")]
      .some((button) => button.textContent?.includes("Archive session")),
    false,
  );
  unavailableDelete.click();
  assert.equal(deleteCalls, 0);

  archiveAvailable = true;
  await act(async () => {
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  await act(async () => {
    deleteInstead.click();
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Archive session").click();
    await flushPromises();
  });

  assert.equal(deleteInstead.disabled, true);
  deleteInstead.click();
  assert.equal(deleteInstead.checked, false);
  assert.equal(
    [...mounted.container.querySelectorAll("button")]
      .some((button) => button.textContent?.includes("Delete session")),
    false,
  );
  assert.equal(deleteCalls, 0);

  await act(async () => {
    archive.resolve({ ok: true });
    await flushPromises();
  });
});

test("Dashboard deletes an archive-capable session only after the explicit delete selection", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const session = makeSession({
    id: "delete-instead",
    machine: "summit",
    title: "Delete instead",
    status: "stopped",
    session_incarnation: "delete-instead-incarnation",
    provider_resume: { provider: "codex", session_id: "provider-delete-instead" },
  });
  let archiveCalls = 0;
  let deleteCalls = 0;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{
        name: "summit",
        ok: true,
        capabilities: { history: true, archive: true },
      }],
    }),
    archiveSession: async () => {
      archiveCalls += 1;
      return { ok: true };
    },
    killSession: async () => {
      deleteCalls += 1;
      return { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".slot-action.danger")?.click();
    await flushPromises();
  });

  const deleteInstead = mounted.container.querySelector<HTMLInputElement>(
    '.close-session-delete-option input[type="checkbox"]',
  );
  assert.ok(deleteInstead);
  await act(async () => {
    deleteInstead.click();
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Delete session").click();
    await flushPromises();
  });

  assert.equal(deleteCalls, 1);
  assert.equal(archiveCalls, 0);
  assertNoElement(mounted.container, ".close-session-modal");
});

test("Dashboard archive compacts every later focused-grid pane across overflow", async () => {
  await assertSessionRemovalCompactsFocusedGrid("archive");
});

test("Dashboard delete compacts every later focused-grid pane across overflow", async () => {
  await assertSessionRemovalCompactsFocusedGrid("delete");
});

test("Dashboard retains failed Delete context and serializes stale-fenced recovery actions", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
    nativeSetTimeout(handler, timeout === 3200 ? 50 : timeout, ...args)
  )) as typeof globalThis.setTimeout;
  cleanupStack.push(() => { globalThis.setTimeout = nativeSetTimeout; });
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({
    id: "recovery-delete",
    machine: "summit",
    agent: "codex",
    title: "Recovery Delete",
    status: "stopped",
    session_incarnation: "launch-1",
  });
  let deleted = false;
  let currentPreview = maintenancePreview(session, "delete", "8");
  const staleAction = deferred<MaintenanceActionApiResult>();
  let actionCalls = 0;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: deleted ? [] : [session],
      machines: [{ name: "summit", ok: true }],
    }),
    killSession: async () => ({ ok: false, error: "session metadata was retained" }),
    inspectSessionMaintenance: async () => ({ ok: true, maintenance: currentPreview }),
    executeSessionMaintenanceAction: async (_machine, _id, request) => {
      actionCalls += 1;
      if (actionCalls === 1) return staleAction.promise;
      deleted = true;
      return {
        ok: true,
        result: {
          schema_version: "agent-session.session-maintenance.v1",
          session_id: session.id,
          operation: "delete",
          action: request.action,
          outcome: "deleted",
          session_incarnation: null,
          session_generation: null,
          status: "deleted",
          cleanup_pending: true,
        },
      };
    },
  };
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["summit/recovery-delete"]));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".slot-action.danger")?.click();
    await flushPromises();
    findTextButton(mounted.container, "Delete session").click();
    await flushPromises();
  });
  assert.ok(mounted.container.querySelector(".close-session-modal"));
  assert.match(mounted.container.textContent ?? "", /session metadata was retained/);

  await act(async () => {
    findTextButton(mounted.container, "Review recovery").click();
    await flushPromises();
  });
  const drawer = mounted.container.querySelector<HTMLElement>(".maintenance-drawer");
  assert.ok(drawer);
  const retryRow = [...drawer.querySelectorAll<HTMLElement>(".maintenance-action-row")]
    .find((row) => row.textContent?.includes("Retry delete"));
  assert.ok(retryRow);
  const confirm = retryRow.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(confirm);
  await act(async () => {
    confirm.click();
    retryRow.querySelector<HTMLButtonElement>("button.btn.danger")?.click();
    await flushPromises();
  });
  assert.equal(findTextButton(drawer, "Inspect again").disabled, true);
  assert.equal(drawer.querySelector<HTMLButtonElement>('button[aria-label="Close maintenance"]')?.disabled, true);
  assert.equal(retryRow.querySelector<HTMLButtonElement>("button.btn.danger")?.disabled, true);

  currentPreview = maintenancePreview(session, "delete", "9");
  await act(async () => {
    staleAction.resolve({
      ok: false,
      error: "Session state changed. Inspect it again before retrying.",
      maintenance: currentPreview,
    });
    await flushPromises();
  });
  assert.ok(mounted.container.querySelector(".maintenance-drawer"));
  const refreshedRetryRow = [...mounted.container.querySelectorAll<HTMLElement>(".maintenance-action-row")]
    .find((row) => row.textContent?.includes("Retry delete"));
  assert.ok(refreshedRetryRow);
  const refreshedConfirm = refreshedRetryRow.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.equal(refreshedConfirm?.checked, false);

  await act(async () => {
    refreshedConfirm?.click();
    refreshedRetryRow.querySelector<HTMLButtonElement>("button.btn.danger")?.click();
    await flushPromises();
  });
  assertNoElement(mounted.container, ".maintenance-drawer");
  assert.match(mounted.container.querySelector(".repair-toast")?.textContent ?? "", /cleanup is pending/);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  assert.ok(mounted.container.querySelector(".repair-toast"), "cleanup acknowledgement remains actionable");
  await act(async () => {
    findTextButton(mounted.container.querySelector(".repair-toast")!, "Dismiss").click();
    await flushPromises();
  });
  assertNoElement(mounted.container, ".repair-toast");
});

for (const width of [390, 1200]) for (const entrypoint of ["menu", "icon"] as const) {
  test(`Dashboard ${entrypoint} confirms only filtered repair targets and cancellation runs nothing at ${width}px`, async () => {
    const mounted = installDom();
    Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: width });
    cleanupStack.push(mounted.cleanup);
    const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
    cleanupStack.push(ssr.close);
    const target = makeSession({ id: "repair-target", machine: "host-a", agent: "codex", repo_name: "alpha", status: "stopped", resumable: true });
    const others = [
      makeSession({ ...target, id: "other-repo", repo_name: "beta" }),
      makeSession({ ...target, id: "other-host", machine: "host-b" }),
      makeSession({ ...target, id: "other-harness", agent: "claude" }),
    ];
    const resumed: string[] = [];
    const repair = deferred<{ ok: boolean }>();
    globalThis.__agentConsoleDashboardBehaviorApiMock = {
      listSessions: async () => ({ ok: true, sessions: [target, ...others], machines: [{ name: "host-a", ok: true }, { name: "host-b", ok: true }] }),
      resumeSession: async (machine, id) => { resumed.push(`${machine}/${id}`); return repair.promise; },
    };
    const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
    await act(async () => {
      mounted.root.render(createElement(Dashboard, {
        active: true, machines: ["host-a", "host-b"], enabledMachines: ["host-a", "host-b"], machineColors: {},
        onDebug: () => {}, onUsage: () => {}, onSettings: () => {},
      }));
      await flushPromises();
    });
    await openSessionFilters(mounted);
    await setSessionFilter(mounted, "Filter sessions by harness", "codex");
    await act(async () => {
      const repo = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Repository"]')!;
      repo.focus();
      Object.getOwnPropertyDescriptor(mounted.window.HTMLInputElement.prototype, "value")?.set?.call(repo, "alpha");
      repo.dispatchEvent(new mounted.window.Event("input", { bubbles: true }));
      repo.dispatchEvent(new mounted.window.KeyboardEvent("keyup", { key: "a", bubbles: true }));
      await flushPromises();
    });
    await setVisibleHosts(mounted, ["host-a"]);
    assert.ok(mounted.container.querySelector('button[aria-label="Remove Repository: alpha"]'), "repository filter is active before repair");
    assert.ok(mounted.container.querySelector('button[aria-label="Remove Harness: Codex"]'), "harness filter is active before repair");

    await openRepairConfirmation(mounted, entrypoint);
    assert.deepEqual(resumed, [], "opening repair must not resume any session before confirmation");
    const confirmation = mounted.container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="repair-session-title"]');
    assert.ok(confirmation);
    assert.equal(confirmation.querySelector("#repair-session-title")?.textContent, "Repair sessions");
    assert.equal(mounted.container.querySelector<HTMLButtonElement>(".brand-title-mark-button")?.disabled, true);
    assert.equal(findTextButton(mounted.container.querySelector(".header-menu-dropdown")!, "Repair").disabled, true);
    assert.match(confirmation.textContent ?? "", /1 session/);
    assert.match(confirmation.textContent ?? "", /host-a/);
    assert.match(confirmation.textContent ?? "", /alpha/);
    await act(async () => { findTextButton(confirmation, "Cancel").click(); await flushPromises(); });
    assertNoElement(mounted.container, '[aria-labelledby="repair-session-title"]');
    assert.deepEqual(resumed, [], "cancelling repair must perform no session action");
    assertNoElement(mounted.container, ".repair-toast");
    assert.equal(mounted.container.querySelector<HTMLButtonElement>(".brand-title-mark-button")?.disabled, false);

    await openRepairConfirmation(mounted, entrypoint);
    await confirmSessionRepair(mounted);
    assert.deepEqual(resumed, ["host-a/repair-target"], "confirmed repair must exclude other repositories, hosts and harnesses");
    assert.equal(mounted.container.querySelector<HTMLButtonElement>(".brand-title-mark-button")?.disabled, true);
    assert.equal(mounted.container.querySelector(".brand-title-mark-button")?.getAttribute("aria-busy"), "true");
    assert.equal(findTextButton(mounted.container.querySelector(".header-menu-dropdown")!, "Repair").disabled, true);
    await act(async () => { repair.resolve({ ok: true }); await flushPromises(); });
    assertNoElement(mounted.container, '[aria-labelledby="repair-session-title"]');
    assert.equal(mounted.container.querySelector<HTMLButtonElement>(".brand-title-mark-button")?.disabled, false);
  });
}

test("Dashboard repair uses the machine selected when its delayed preview resolves", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 1200 });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [
    makeSession({ id: "repair-a", machine: "host-a", status: "stopped", resumable: true }),
    makeSession({ id: "repair-b", machine: "host-b", status: "stopped", resumable: true }),
  ];
  const response: SessionsResponse = { ok: true, sessions, machines: [{ name: "host-a", ok: true }, { name: "host-b", ok: true }] };
  const delayed = deferred<SessionsResponse>();
  let delayList = false;
  const resumed: string[] = [];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => delayList ? delayed.promise : { ...response, sessions: sessions.map(session => ({ ...session, status: "running" as const })) },
    resumeSession: async (machine, id) => { resumed.push(`${machine}/${id}`); return { ok: true }; },
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true, machines: ["host-a", "host-b"], enabledMachines: ["host-a", "host-b"], machineColors: {},
      onDebug: () => {}, onUsage: () => {}, onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLElement>('[data-slot-key="host-a/repair-a"]')!.dispatchEvent(
      new mounted.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }),
    );
    await flushPromises();
  });
  await setSessionFilter(mounted, "Filter sessions by machine", "host-a");
  const machineSelector = mounted.container.querySelector<HTMLSelectElement>('[aria-label="Filter sessions by machine"]')!;
  delayList = true;
  await openRepairConfirmation(mounted);
  assertNoElement(mounted.container, '[aria-labelledby="repair-session-title"]');
  await setSessionFilter(mounted, "Filter sessions by machine", "host-b");
  assert.equal(machineSelector.value, "host-b", "machine scope changed while repair was awaiting the list");
  await act(async () => { delayed.resolve(response); await flushPromises(); });
  const confirmation = mounted.container.querySelector<HTMLElement>('[aria-labelledby="repair-session-title"]');
  assert.ok(confirmation);
  assert.match(confirmation.textContent ?? "", /Machines: host-b/, "preview must use the current machine scope");
  assert.deepEqual(resumed, []);
  await confirmSessionRepair(mounted);
  assert.deepEqual(resumed, ["host-b/repair-b"]);
});

test("Dashboard mounts actionable Repair All failures and auto-dismisses successful summaries", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const nativeSetTimeout = globalThis.setTimeout;
  let autoDismissRepairToast: (() => void) | null = null;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => (
    timeout === 3200 && typeof handler === "function"
      ? (autoDismissRepairToast = () => handler(...args), nativeSetTimeout(() => {}, 60_000))
      : nativeSetTimeout(handler, timeout, ...args)
  )) as typeof globalThis.setTimeout;
  cleanupStack.push(() => { globalThis.setTimeout = nativeSetTimeout; });
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({
    id: "repair-all",
    machine: "summit",
    agent: "codex",
    title: "Repair All",
    status: "stopped",
    resumable: true,
    session_incarnation: "launch-1",
  });
  let listed: Session[] = [session];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: listed,
      machines: [{ name: "summit", ok: true }],
    }),
    resumeSession: async () => ({ ok: false, error: "resume remained fenced" }),
    inspectSessionMaintenance: async () => ({ ok: true, maintenance: maintenancePreview(session, "resume") }),
  };
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["summit/repair-all"]));

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await openRepairConfirmation(mounted);
  await confirmSessionRepair(mounted);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  let toast = mounted.container.querySelector<HTMLElement>(".repair-toast");
  assert.match(toast?.textContent ?? "", /1 failed/);
  assert.ok(findTextButton(toast!, "View failures"));
  assert.ok(findTextButton(toast!, "Dismiss"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  assert.ok(mounted.container.querySelector(".repair-toast"), "attention toast does not auto-dismiss");

  await act(async () => {
    findTextButton(mounted.container.querySelector(".repair-toast")!, "View failures").click();
    await flushPromises();
  });
  assert.ok(mounted.container.querySelector(".maintenance-drawer"));
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Close maintenance"]')?.click();
    await flushPromises();
    findTextButton(mounted.container.querySelector(".repair-toast")!, "Dismiss").click();
    await flushPromises();
  });
  assertNoElement(mounted.container, ".repair-toast");

  listed = [];
  await openRepairConfirmation(mounted);
  await confirmSessionRepair(mounted);
  await waitForCondition(
    () => /nothing to repair/.test(mounted.container.querySelector<HTMLElement>(".repair-toast")?.textContent ?? ""),
    "the nothing-to-repair success summary",
  );
  toast = mounted.container.querySelector<HTMLElement>(".repair-toast");
  assert.match(toast?.textContent ?? "", /nothing to repair/);
  assert.equal(autoDismissRepairToast !== null, true, "successful summary schedules auto-dismiss");
  await act(async () => {
    autoDismissRepairToast?.();
    await flushPromises();
  });
  assertNoElement(mounted.container, ".repair-toast");
});

test("Dashboard keeps the selected maintenance incident through unrelated reconciliation", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    asyncPollMockPlugin(),
    terminalPaneMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);

  const sessionA = makeSession({
    id: "repair-a",
    machine: "summit",
    agent: "codex",
    title: "Repair A",
    status: "stopped",
    resumable: true,
    session_incarnation: "launch-a",
  });
  const sessionB = makeSession({
    id: "repair-b",
    machine: "summit",
    agent: "claude",
    title: "Repair B",
    status: "stopped",
    resumable: true,
    session_incarnation: "launch-b",
  });
  let listed: Session[] = [sessionA, sessionB];
  const action = deferred<MaintenanceActionApiResult>();
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: listed,
      machines: [{ name: "summit", ok: true }],
    }),
    resumeSession: async () => ({ ok: false, error: "resume remained fenced" }),
    inspectSessionMaintenance: async (_machine, id) => ({
      ok: true,
      maintenance: maintenancePreview(id === sessionA.id ? sessionA : sessionB, "resume"),
    }),
    executeSessionMaintenanceAction: async () => action.promise,
  };
  mounted.window.localStorage.setItem(
    SLOTS_STORAGE,
    JSON.stringify(["summit/repair-a", "summit/repair-b"]),
  );

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  await openRepairConfirmation(mounted);
  await confirmSessionRepair(mounted);
  await act(async () => {
    findTextButton(mounted.container.querySelector(".repair-toast")!, "View failures").click();
    await flushPromises();
  });
  assert.match(
    mounted.container.querySelector(".maintenance-drawer")?.textContent ?? "",
    /Recover Repair A/,
  );
  await act(async () => {
    findTextButton(mounted.container.querySelector(".maintenance-incident-list")!, "Repair B").click();
    await flushPromises();
  });

  let drawer = mounted.container.querySelector<HTMLElement>(".maintenance-drawer");
  assert.match(drawer?.textContent ?? "", /Recover Repair B/);
  assert.match(
    drawer?.querySelector(".maintenance-incident-list")?.textContent ?? "",
    /Repair B · recovery/,
  );
  const operation = [...drawer!.querySelectorAll<HTMLElement>(".maintenance-summary dl > div")]
    .find((row) => row.querySelector("dt")?.textContent === "Operation");
  assert.equal(operation?.querySelector("dd")?.textContent, "recovery");
  const retryB = [...drawer!.querySelectorAll<HTMLElement>(".maintenance-action-row")]
    .find((row) => row.textContent?.includes("Retry recovery"));
  assert.ok(retryB);
  await act(async () => {
    retryB.querySelector<HTMLButtonElement>("button.btn.primary")?.click();
    await flushPromises();
  });
  assert.equal(retryB.querySelector<HTMLButtonElement>("button.btn.primary")?.getAttribute("aria-busy"), "true");

  listed = [sessionB];
  await act(async () => {
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  drawer = mounted.container.querySelector<HTMLElement>(".maintenance-drawer");
  assert.ok(drawer, "reconciling Repair A must not close the selected Repair B incident");
  assert.match(drawer.textContent ?? "", /Recover Repair B/);

  await act(async () => {
    action.resolve({
      ok: false,
      error: "Session state changed. Inspect it again before retrying.",
      maintenance: maintenancePreview(sessionB, "resume", "9"),
    });
    await flushPromises();
  });
  assert.match(mounted.container.querySelector(".maintenance-drawer")?.textContent ?? "", /Recover Repair B/);
});



test("Dashboard offers the supported archive star and retains it after a child-guard refusal", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    asyncPollMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const session = makeSession({
    id: "archive-star",
    machine: "summit",
    title: "Archive star",
    status: "stopped",
    session_incarnation: "archive-incarnation",
    provider_resume: { provider: "codex", session_id: "provider-archive-star" },
  });
  let historyStar = false;
  let childGuard = true;
  const archiveCalls: Array<{ readonly starred?: boolean }> = [];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [session],
      machines: [{
        name: "summit",
        ok: true,
        capabilities: { history: true, archive: true, history_star: historyStar },
      }],
    }),
    archiveSession: async (_machine, _id, _incarnation, options) => {
      archiveCalls.push({ ...(options?.starred ? { starred: true } : {}) });
      if (childGuard) return {
        ok: false,
        error: "this session still has child sessions; close them before archiving or deleting it",
      };
      return options?.starred ? { ok: true, starredAt: "2026-09-01T00:00:00Z" } : { ok: true };
    },
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });

  // A machine whose daemon has no star offers no star.
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".slot-action.danger")?.click();
    await flushPromises();
  });
  assertNoElement(mounted.container, ".close-session-star-option");
  await act(async () => {
    findAriaButton(mounted.container, "Cancel close session").click();
    await flushPromises();
  });

  historyStar = true;
  await act(async () => {
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".slot-action.danger")?.click();
    await flushPromises();
  });

  const star = mounted.container.querySelector<HTMLInputElement>(
    '.close-session-star-option input[type="checkbox"]',
  );
  assert.ok(star);
  assert.equal(star.checked, false);

  // The star refines the default action, so it reads before the option that
  // replaces that action with a delete.
  const options = [...mounted.container.querySelectorAll(
    ".close-session-star-option, .close-session-delete-option",
  )].map((element) => element.className.split(" ")[0]);
  assert.deepEqual(options, ["close-session-star-option", "close-session-delete-option"]);

  // Both options put their checkbox on the same line as their title, rather
  // than relying on grid placement that a narrow WebView renders stacked.
  for (const option of [".close-session-star-option", ".close-session-delete-option"]) {
    const head = mounted.container.querySelector(`${option} .close-session-option-head`);
    assert.ok(head, `${option} has an option head`);
    assert.deepEqual(
      [...head.children].map((child) => child.tagName.toLowerCase()),
      ["input", "strong"],
      `${option} keeps its checkbox beside its title`,
    );
    assert.equal(
      mounted.container.querySelector(`${option} > small`)?.parentElement?.className.split(" ")[0],
      option.slice(1),
      `${option} keeps its description on its own line`,
    );
  }

  // The label carries the same filled star the History rows use, so the option
  // is recognisable as the control behind that badge before reading the text.
  const starLabel = mounted.container.querySelector(".close-session-star-option strong");
  assert.ok(starLabel);
  assert.equal(starLabel.firstElementChild?.tagName.toLowerCase(), "svg");
  assert.ok(starLabel.firstElementChild?.classList.contains("star-icon"));
  assert.equal(starLabel.firstElementChild?.getAttribute("fill"), "currentColor");
  assert.match(starLabel.textContent ?? "", /Star it in History/);

  // The star belongs to archiving, so choosing delete instead disables it.
  const deleteInstead = mounted.container.querySelector<HTMLInputElement>(
    '.close-session-delete-option input[type="checkbox"]',
  );
  assert.ok(deleteInstead);
  await act(async () => {
    deleteInstead.click();
    await flushPromises();
  });
  assert.equal(star.disabled, true);
  await act(async () => {
    deleteInstead.click();
    await flushPromises();
  });
  assert.equal(star.disabled, false);

  await act(async () => {
    star.click();
    await flushPromises();
  });
  await act(async () => {
    findTextButton(mounted.container, "Archive session").click();
    await flushPromises();
  });

  assert.deepEqual(archiveCalls, [{ starred: true }]);
  assert.match(mounted.container.textContent ?? "", /close them before archiving or deleting it/);
  assert.doesNotMatch(mounted.container.textContent ?? "", /archived and starred/i);
  assert.ok([...mounted.container.querySelectorAll(".slot-title-text")]
    .some((element) => element.textContent === "Archive star"), "the refused session remains in its tile");
  assert.equal(mounted.container.querySelector<HTMLInputElement>(
    '.close-session-star-option input[type="checkbox"]',
  )?.checked, true, "the selected Star intent survives the refusal");
  assert.equal(findTextButton(mounted.container, "Archive session").disabled, false);
  await act(async () => { await flushPromises(); });
  assert.equal(archiveCalls.length, 1, "the refusal does not trigger an automatic retry");

  // After the child has been closed elsewhere, only an explicit confirmation
  // sends another archive; its successful acknowledgement owns the toast.
  childGuard = false;
  await act(async () => {
    findTextButton(mounted.container, "Archive session").click();
    await flushPromises();
  });
  assert.deepEqual(archiveCalls, [{ starred: true }, { starred: true }]);
  assert.match(mounted.container.textContent ?? "", /archived and starred/i);
});

function historyPanelMockPlugin(): Plugin {
  const mockId = "\0dashboard-behavior-history-panel-mock";
  return {
    name: "dashboard-behavior-history-panel-mock",
    enforce: "pre",
    resolveId(source, importer) {
      return source.endsWith("HistoryPanel.tsx") && importer?.includes("/src/") ? mockId : null;
    },
    load(id) {
      if (id !== mockId) return null;
      // Stands in for the real panel's resume: hand a live session up, then
      // close, which is the order the panel itself uses.
      return `
        import { createElement } from "react";
        export function HistoryPanel(props) {
          return createElement("div", null,
          createElement("button", {
            type: "button",
            className: "history-resume-stub",
            "data-machines": props.machines.join(","),
            onClick: () => {
              void Promise.resolve(props.onResumed({ machine: "summit", id: "resumed-1" }));
              props.onClose();
            },
          }, "Resume from History"),
          createElement("button", { type: "button", "aria-label": "Close history", onClick: props.onClose }, "Close"));
        }
      `;
    },
  };
}

test("Dashboard lands on the session a History resume created", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    asyncPollMockPlugin(),
    historyPanelMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const existingSession = makeSession({
    id: "existing",
    machine: "summit",
    title: "Existing",
  });
  const resumedSession = makeSession({
    id: "resumed-1",
    machine: "summit",
    title: "Resumed",
  });
  let resumedIsLive = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: resumedIsLive ? [existingSession, resumedSession] : [existingSession],
      machines: [{ name: "summit", ok: true, capabilities: { history: true } }],
    }),
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });

  await act(async () => {
    mounted.container.querySelector<HTMLElement>(".header-menu-trigger")
      ?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
    findTextButton(mounted.container, "History")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assert.ok(mounted.container.querySelector(".history-resume-stub"));

  // The resume only reports the session; it becomes listable on the next poll.
  resumedIsLive = true;
  await act(async () => {
    findTextButton(mounted.container, "Resume from History")
      .dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushPromises();
  });
  assertNoElement(mounted.container, ".history-resume-stub");

  await waitForCondition(
    () => mounted.container.querySelector<HTMLElement>(
      ".terminal-slot.is-grid-focus, .terminal-slot.is-focused",
    )?.dataset.slotKey === "summit/resumed-1",
    "the resumed session to receive focus once it is listed",
  );
});

test("Dashboard opens a live conversation from the title menu, closes it with Cmd+Y, and forgets it when the session leaves", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), asyncPollMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const session = makeSession({
    id: "a",
    title: "Live A",
    provider_resume: { provider: "codex", session_id: "provider-a" },
  });
  let live: Session[] = [session];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: live,
      machines: [{ name: "summit", ok: true, capabilities: { history: true } }],
    }),
    listHistorySessions: async (machine) => ({
      ok: true,
      truncated: false,
      latestMessagePaging: true,
      sessions: [{
        id: "history-a",
        machine,
        provider: "codex",
        provider_session_id: "provider-a",
        cwd: "/work",
        created_at: "2026-09-26T00:00:00Z",
        updated_at: "2026-09-26T00:00:00Z",
        resumable: false,
      }],
    }),
    listHistoryMessages: async () => ({ ok: true, messages: [{ id: "maple", role: "assistant", text: "report A" }] }),
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  const openConversation = async () => {
    await act(async () => {
      mounted.container.querySelector<HTMLElement>('summary[aria-label="Session menu for Live A"]')?.click();
      await flushPromises();
    });
    await act(async () => {
      findTextButton(mounted.container, "Conversation").click();
      await flushPromises();
    });
    await waitForCondition(
      () => (mounted.container.querySelector(".conversation-modal")?.textContent ?? "").includes("report A"),
      "the live conversation to load",
    );
  };
  const poll = async () => {
    await act(async () => {
      await globalThis.__agentConsoleDashboardPollTask?.();
      await flushPromises();
    });
  };

  await openConversation();
  const dialog = mounted.container.querySelector<HTMLElement>(".conversation-modal");
  assert.ok(dialog);
  // Focus sits inside the dialog, which the dashboard shortcut layer treats as
  // an editable target; Cmd+Y must still close the panel it opened.
  await act(async () => {
    dialog.dispatchEvent(metaKey(mounted.window, "y"));
    await flushPromises();
  });
  assertNoElement(mounted.container, ".conversation-modal");

  await openConversation();
  live = [];
  await poll();
  assertNoElement(mounted.container, ".conversation-modal");
  live = [session];
  await poll();
  assert.ok(mounted.container.querySelector('summary[aria-label="Session menu for Live A"]'));
  assertNoElement(mounted.container, ".conversation-modal", "a returning session does not reopen a forgotten panel");
});

// Component-only seam that holds a reply in flight; the real journal and HTTP
// admission are covered by sharedOutboxClient.test.ts.
function sharedReplyAdmissionMockPlugin(): Plugin {
  const mockId = "\0dashboard-behavior-shared-admission";
  return {
    name: "dashboard-behavior-shared-admission",
    enforce: "pre",
    resolveId: (source) => (source.endsWith("sharedOutboxClient.ts") ? mockId : null),
    load: (id) => (id === mockId
      ? sharedAdmissionFixture("(...args) => globalThis.__agentConsoleDashboardBehaviorApiMock.submitSessionPrompt(...args)")
      : null),
  };
}

// Three sessions on a desktop-width dashboard: two on a history-capable host and
// one on a host without conversation views.
async function mountPinnedConversationDashboard(
  options: { readonly submitSessionPrompt?: DashboardBehaviorApiMock["submitSessionPrompt"] } = {},
) {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 1440 });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin(), sharedReplyAdmissionMockPlugin()]);
  cleanupStack.push(ssr.close);
  const live = [
    makeSession({ id: "a", machine: "summit", title: "Live A", session_incarnation: "inc-a", provider_resume: { provider: "codex", session_id: "provider-a" } }),
    makeSession({ id: "b", machine: "summit", title: "Live B", session_incarnation: "inc-b", provider_resume: { provider: "codex", session_id: "provider-b" } }),
    makeSession({ id: "c", machine: "plain", title: "Live C" }),
  ];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: live,
      machines: [{ name: "summit", ok: true, capabilities: { history: true } }, { name: "plain", ok: true }],
    }),
    listHistorySessions: async (machine) => ({
      ok: true,
      truncated: false,
      latestMessagePaging: true,
      sessions: ["a", "b"].map((id) => ({
        id: `history-${id}`,
        machine,
        provider: "codex" as const,
        provider_session_id: `provider-${id}`,
        cwd: "/work",
        created_at: "2026-09-26T00:00:00Z",
        updated_at: "2026-09-26T00:00:00Z",
        resumable: false,
      })),
    }),
    listHistoryMessages: async (_machine, id) => ({
      ok: true,
      messages: [{ id: `message-${id}`, role: "assistant", text: `report ${id.slice(-1).toUpperCase()}` }],
    }),
    submitSessionPrompt: options.submitSessionPrompt,
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit", "plain"],
      enabledMachines: ["summit", "plain"],
      machineColors: {},
      defaultAutoResume: false,
      sessionListDisplay: "terminal",
      terminalRenderMode: "realtime" as const,
      terminalSelectedPaneRealtime: true,
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await waitForCondition(() => mounted.container.querySelectorAll(".terminal-slot .terminal-pane").length === 3, "three terminal tiles");
  const panelText = () => mounted.container.querySelector(".conversation-dock")?.textContent ?? "";
  const panelTitle = () => mounted.container.querySelector(".conversation-dock #conversation-title")?.textContent ?? "";
  const openPanel = async (title: string, report: string) => {
    await act(async () => {
      mounted.container.querySelector<HTMLElement>(`summary[aria-label="Session menu for ${title}"]`)?.click();
      await flushPromises();
    });
    await act(async () => {
      findTextButton(mounted.container, "Conversation").click();
      await flushPromises();
    });
    await waitForCondition(() => panelText().includes(report), `${title} conversation to load`);
  };
  const select = async (id: string) => {
    const wrap = mounted.container.querySelector<HTMLElement>(`.terminal-slot[data-slot-key="${id}"] .slot-terminal-wrap`);
    assert.ok(wrap, `tile ${id}`);
    await act(async () => {
      wrap.dispatchEvent(primaryPointerDown(mounted.window));
      await flushPromises();
    });
  };
  const togglePin = async (label: "Pin conversation" | "Unpin conversation") => {
    await act(async () => {
      findAriaButton(mounted.container.querySelector<HTMLElement>(".conversation-dock")!, label).click();
      await flushPromises();
    });
  };
  const draftEditor = () => {
    const node = mounted.container.querySelector<HTMLTextAreaElement>('.conversation-dock textarea[aria-label="Reply to session"]');
    assert.ok(node, "the docked panel offers a reply editor");
    return node;
  };
  const writeDraft = (text: string) => act(async () => {
    const node = draftEditor();
    const key = Object.keys(node).find((item) => item.startsWith("__reactProps$"))!;
    (node as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[key].onChange({ target: { value: text } });
    await flushPromises();
  });
  return { mounted, panelText, panelTitle, openPanel, select, togglePin, draftEditor, writeDraft };
}

test("an unpinned docked conversation follows the selected session and keeps its session for one without a conversation", async () => {
  const { mounted, panelText, panelTitle, openPanel, select } = await mountPinnedConversationDashboard();
  await openPanel("Live A", "report A");
  assert.ok(mounted.container.querySelector(".conversation-dock"), "the panel is docked at a desktop width");
  assert.ok(findAriaButton(mounted.container, "Pin conversation"), "the panel opens unpinned");

  await select("summit/b");
  await waitForCondition(() => panelText().includes("report B"), "the panel to follow the selection");
  assert.equal(panelTitle(), "Live B");
  assert.doesNotMatch(panelText(), /report A/, "no content from the previous session remains");

  await select("plain/c");
  assert.equal(panelTitle(), "Live B", "a session without a conversation view leaves the panel where it is");
  assert.match(panelText(), /report B/);
});

test("a pinned docked conversation stays on its session until it is unpinned", async () => {
  const { panelText, panelTitle, openPanel, select, togglePin, mounted } = await mountPinnedConversationDashboard();
  await openPanel("Live A", "report A");
  await togglePin("Pin conversation");
  assert.ok(findAriaButton(mounted.container, "Unpin conversation"), "the pinned state is announced by the control");

  await select("summit/b");
  assert.equal(panelTitle(), "Live A");
  assert.match(panelText(), /report A/);
  assert.doesNotMatch(panelText(), /report B/);
});

test("unpinning retargets the docked conversation to the current selection", async () => {
  const { panelText, panelTitle, openPanel, select, togglePin } = await mountPinnedConversationDashboard();
  await openPanel("Live A", "report A");
  await togglePin("Pin conversation");
  await select("summit/b");
  assert.equal(panelTitle(), "Live A");

  await togglePin("Unpin conversation");
  await waitForCondition(() => panelText().includes("report B"), "the panel to move to the current selection");
  assert.equal(panelTitle(), "Live B");
  assert.doesNotMatch(panelText(), /report A/);
});

test("a docked conversation with a reply in flight defers following until it is idle, then applies the latest selection", async () => {
  const submission = deferred<{ readonly ok: boolean }>();
  const { mounted, panelText, panelTitle, openPanel, select, writeDraft } = await mountPinnedConversationDashboard({
    submitSessionPrompt: () => submission.promise,
  });
  await openPanel("Live A", "report A");
  await writeDraft("working on it");
  await act(async () => {
    findAriaButton(mounted.container.querySelector<HTMLElement>(".conversation-dock")!, "Send reply").click();
    await flushPromises();
  });

  await select("summit/b");
  assert.equal(panelTitle(), "Live A", "a switch never interrupts a reply in flight");
  assert.match(panelText(), /report A/);

  await act(async () => {
    submission.resolve({ ok: true });
    await flushPromises();
  });
  await waitForCondition(() => panelText().includes("report B"), "the deferred selection to apply once idle");
  assert.equal(panelTitle(), "Live B");
});

test("each session keeps its own unsent reply draft while the docked conversation follows the selection", async () => {
  const { panelText, panelTitle, openPanel, select, draftEditor, writeDraft } = await mountPinnedConversationDashboard();
  await openPanel("Live A", "report A");
  await writeDraft("draft for A");

  await select("summit/b");
  await waitForCondition(() => panelText().includes("report B"), "the panel to follow the selection");
  assert.equal(draftEditor().value, "", "another session's draft is not shown");
  await writeDraft("draft for B");

  await select("summit/a");
  await waitForCondition(() => panelTitle() === "Live A" && panelText().includes("report A"), "the panel to return to the first session");
  assert.equal(draftEditor().value, "draft for A");
  await select("summit/b");
  await waitForCondition(() => panelTitle() === "Live B" && panelText().includes("report B"), "the panel to return to the second session");
  assert.equal(draftEditor().value, "draft for B");
});

async function mountOverviewShortcutDashboard() {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const calls: string[] = [];
  const sessions = ["a", "b", "c"].map((id) => makeSession({
    id, title: `Session ${id.toUpperCase()}`, session_incarnation: `${id}-incarnation`,
    status: id === "c" ? "stopped" : "running",
  }));
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions, machines: [{ name: "summit", ok: true }] }),
    glance: async (_machine, id) => {
      calls.push(`retitle:${id}`);
      return { ...sessions.find((session) => session.id === id), tail: "Working on overview shortcuts" };
    },
    summarizeSessionTitle: async () => ({ ok: true, title: "Overview shortcuts", source: "summarizer" }),
    updateSessionTitle: async (_machine, id) => { calls.push(`title:${id}`); return { ok: true }; },
    killSession: async (_machine, id) => { calls.push(`kill:${id}`); return { ok: true }; },
  };
  mounted.window.localStorage.setItem(AUTO_STORAGE, "0");
  mounted.window.localStorage.setItem(MODE_STORAGE, "2");
  mounted.window.localStorage.setItem(SLOTS_STORAGE, JSON.stringify(["summit/a", "summit/b"]));
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true, machines: ["summit"], enabledMachines: ["summit"], machineColors: {},
      onDebug: () => {}, onUsage: () => {}, onSettings: () => {},
    }));
    await flushPromises();
  });
  const selectedSlot = mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/b"]');
  const selectedInput = selectedSlot?.querySelector<HTMLTextAreaElement>(".terminal-input");
  assert.ok(selectedSlot);
  assert.ok(selectedInput);
  await act(async () => { selectedInput.focus(); await flushPromises(); });
  assert.ok(selectedSlot.classList.contains("is-cmd-focus-target"));
  await act(async () => { findAriaButton(mounted.container, "Next page").focus(); });
  return { ...mounted, calls, selectedSlot };
}

for (const key of ["e", "p", "r", "w"] as const) {
  test(`overview session shortcut ${key} retains selection after DOM focus leaves the terminal`, async () => {
    const mounted = await mountOverviewShortcutDashboard();
    const beforeReconnect = mounted.selectedSlot.querySelector<HTMLElement>(".terminal-pane")?.dataset.reconnectToken;
    await act(async () => {
      mounted.window.dispatchEvent(metaKey(mounted.window, key));
      await flushPromises();
    });
    assertNoElement(mounted.container, ".terminal-slot.is-focused");
    if (key === "e") {
      const editor = mounted.selectedSlot.querySelector<HTMLInputElement>(".slot-title-input");
      assert.equal(editor?.value, "Session B");
      assertNoElement(mounted.container, '[data-slot-key="summit/a"] .slot-title-input');
    } else if (key === "p") {
      await waitForCondition(() => mounted.calls.includes("retitle:b"), "selected session retitle");
      assert.ok(!mounted.calls.includes("retitle:a"));
    } else if (key === "r") {
      assert.equal(Number(mounted.selectedSlot.querySelector<HTMLElement>(".terminal-pane")?.dataset.reconnectToken), Number(beforeReconnect) + 1);
      assert.equal(mounted.container.querySelector<HTMLElement>('[data-slot-key="summit/a"] .terminal-pane')?.dataset.reconnectToken, "0");
    } else {
      const dialog = mounted.container.querySelector(".close-session-modal");
      assert.ok(dialog);
      assert.match(dialog.textContent ?? "", /Session B/);
      assert.deepEqual(mounted.calls, [], "closing must wait for confirmation");
    }
  });
}

test("overview session shortcut navigation wraps within the current page and Command-F opens its selection", async () => {
  const mounted = await mountOverviewShortcutDashboard();
  for (const [key, expected] of [["l", "summit/a"], ["h", "summit/b"]]) {
    await act(async () => {
      mounted.window.dispatchEvent(metaKey(mounted.window, key));
      await flushPromises();
    });
    assert.equal(mounted.container.querySelector<HTMLElement>(".is-cmd-focus-target")?.dataset.slotKey, expected);
    assertNoElement(mounted.container, ".terminal-slot.is-focused");
  }
  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "f"));
    await flushPromises();
  });
  assert.equal(mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused")?.dataset.slotKey, "summit/b");
});

test("overview session shortcut after paging never acts on the previous page selection", async () => {
  const mounted = await mountOverviewShortcutDashboard();
  await act(async () => {
    findAriaButton(mounted.container, "Next page").click();
    await flushPromises();
  });
  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "w"));
    await flushPromises();
  });
  assertNoElement(mounted.container, ".close-session-modal");
  assert.deepEqual(mounted.calls, []);
  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "h"));
    await flushPromises();
  });
  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "w"));
    await flushPromises();
  });
  const dialog = mounted.container.querySelector(".close-session-modal");
  assert.ok(dialog);
  assert.match(dialog.textContent ?? "", /Session C/);
  assert.doesNotMatch(dialog.textContent ?? "", /Session B/);
  assert.deepEqual(mounted.calls, []);
});

test("overview session shortcuts cannot retain an invisible target in a narrow macOS window", async () => {
  const mounted = await mountOverviewShortcutDashboard();
  await act(async () => {
    Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 700 });
    mounted.window.dispatchEvent(new mounted.window.Event("resize"));
    await flushPromises();
  });
  await waitForCondition(() => Boolean(mounted.container.querySelector(".mobile-session-list")), "narrow overview cards");
  for (const key of ["l", "e", "p", "r", "w"]) {
    await act(async () => {
      mounted.window.dispatchEvent(metaKey(mounted.window, key));
      await flushPromises();
    });
  }
  assertNoElement(mounted.container, ".close-session-modal");
  assertNoElement(mounted.container, ".slot-title-input");
  assert.deepEqual(mounted.calls, []);
  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "f"));
    await flushPromises();
  });
  assert.ok(mounted.container.querySelector(".terminal-slot.is-focused"));
  await act(async () => {
    mounted.window.dispatchEvent(metaKey(mounted.window, "e"));
    await flushPromises();
  });
  assert.ok(mounted.container.querySelector(".terminal-slot.is-focused .slot-title-input"));
});

test("Dashboard ignores the retired Board capability while retaining overview sessions", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([
    dashboardApiMockPlugin(),
    terminalPaneMockPlugin(),
    asyncPollMockPlugin(),
  ]);
  cleanupStack.push(ssr.close);
  const existingSession = makeSession({ id: "existing", machine: "summit", title: "Existing" });
  const otherSession = makeSession({ id: "other", machine: "summit", title: "Other" });
  let advertised = false;
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [existingSession, otherSession],
      machines: [{ name: "summit", ok: true }],
      capabilities: advertised ? { session_board: true } : {},
    }),
  };
  const menuItems = () => [...mounted.container.querySelectorAll<HTMLButtonElement>(".header-menu-item")]
    .map((item) => item.textContent?.trim());
  const toggleMenu = async () => {
    await act(async () => {
      mounted.container.querySelector<HTMLElement>(".header-menu-trigger")
        ?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushPromises();
    });
  };

  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, {
      active: true,
      machines: ["summit"],
      enabledMachines: ["summit"],
      machineColors: {},
      onDebug: () => {},
      onUsage: () => {},
      onSettings: () => {},
    }));
    await flushPromises();
  });
  await act(async () => {
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });

  await toggleMenu();
  assert.equal(menuItems().includes("Board"), false, "no Board entry before the edge advertises the route");
  await toggleMenu();

  advertised = true;
  await act(async () => {
    await globalThis.__agentConsoleDashboardPollTask?.();
    await flushPromises();
  });
  await toggleMenu();
  assert.equal(menuItems().includes("Board"), false, "shared backend capability never restores the retired UI");
  assertNoElement(mounted.container, ".board-modal");
  assert.ok(mounted.container.querySelector('[data-slot-key="summit/existing"]'), "overview sessions remain available");
  for (const item of ["Usage", "Debug", "Settings"]) assert.ok(menuItems().includes(item), `${item} remains available`);
});

test("mobile session ordinal and pager follow the list when local slots have a different order", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window,"innerWidth",{configurable:true,value:390});
  Object.defineProperty(mounted.window,"innerHeight",{configurable:true,value:844});
  cleanupStack.push(mounted.cleanup);
  const slotOrderPlugin: Plugin = { name:"navigation-slot-order",enforce:"pre",
    resolveId(source, importer) { return source === "./useLayoutSync.ts" && importer?.endsWith("/Dashboard.tsx") ? "\0navigation-layout" : null; },
    load(id) { return id === "\0navigation-layout" ? `import {useEffect} from "react";
      export function useLayoutSync({setSlots}) {
        useEffect(() => { setSlots(["summit/c","summit/b","summit/a",null]); },[setSlots]);
        return {orderedSessionKeys:["summit/a","summit/b","summit/c"],applyLayoutLocalOrder(){},persistLayoutLocalOrder(){},cancelPendingLayoutDebounce(){}};
      }` : null; }
  };
  const ssr = createUiSsrHarness([slotOrderPlugin,dashboardApiMockPlugin(),terminalPaneMockPlugin()]); cleanupStack.push(ssr.close);
  const sessions = ["a","b","c"].map(id => makeSession({id,title:`Order ${id}`,created_at:"2026-09-30T00:00:00Z"}));
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions:async () => ({ok:true,sessions,machines:[{name:"summit",ok:true}]}),
    fetchLayoutOrder:async () => ({reachable:false,order:[],revision:null}),
  };
  mounted.window.localStorage.setItem(MODE_STORAGE,"4"); mounted.window.localStorage.setItem(AUTO_STORAGE,"0");
  mounted.window.localStorage.setItem(SLOTS_STORAGE,JSON.stringify(["summit/a","summit/b","summit/c",null]));
  const {Dashboard} = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => { mounted.root.render(createElement(Dashboard,{active:true,machines:["summit"],enabledMachines:["summit"],machineColors:{},onDebug(){},onUsage(){},onSettings(){}})); await flushPromises(); });
  const cards = [...mounted.container.querySelectorAll<HTMLElement>(".mobile-session-card")];
  assert.equal(cards.length,3);
  const labels = cards.map(card => card.querySelector(".mobile-session-card-title")?.textContent ?? "");
  await act(async () => { cards[0].querySelector<HTMLButtonElement>(".mobile-session-card-open-action")!.click(); await flushPromises(); });
  assert.equal(mounted.container.querySelector(".slot-ordinal")?.textContent?.replace(/\s+/g," ").trim(),"1 / 3");
  await act(async () => { findAriaButton(mounted.container,"Next session").click(); await flushPromises(); });
  assert.equal(mounted.container.querySelector(".slot-ordinal")?.textContent?.replace(/\s+/g," ").trim(),"2 / 3");
  const focused = mounted.container.querySelector<HTMLElement>(".terminal-slot.is-focused");
  assert.equal(focused?.dataset.slotKey,`summit/${labels[1].slice(-1)}`);
});

test("phone cards show neutral role chips for every session without extensions", async () => {
  const sessions = ["coordinator", "domain-coordinator", "reviewer"].map((role, index) => makeSession({ id: role, machine: "host-a", title: role, role, created_at: `2026-10-01T00:00:0${index}Z` }));
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 360 });
  Object.defineProperty(mounted.window, "innerHeight", { configurable: true, value: 800 });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions, machines: [{ name: "host-a", ok: true }] }),
    fetchLayoutOrder: async () => ({ reachable: false, order: [], revision: null }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, { active: true, machines: ["host-a"], enabledMachines: ["host-a"], machineColors: {}, onDebug() {}, onUsage() {}, onSettings() {} }));
    await flushPromises();
  });
  const cards = [...mounted.container.querySelectorAll(".mobile-session-card")];
  assert.equal(cards.length, sessions.length);
  for (const session of sessions) assert.ok(mounted.container.querySelector(`[data-session-key="${session.machine}/${session.id}"]`) || [...cards].some(card => card.textContent?.includes(session.id)));
  assert.deepEqual([...mounted.container.querySelectorAll(".session-role-chip")].map(chip => chip.textContent).sort(), ["coordinator", "domain-coordinator", "reviewer"].sort());
});

test("#987 Workspace selections save through Dashboard, survive remount and stay isolated per principal", async () => {
  const mounted = installDom();
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 1440 });
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  const storage = await ssr.loadModule<typeof import("../src/storage.ts")>("/src/storage.ts");
  cleanupStack.push(() => storage.setPrincipalStorageNamespace(null));
  storage.setPrincipalStorageNamespace("workspace-one");
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions: [
      makeSession({ id: "team-a", machine: "fixture", workspace: "team-a" }),
      makeSession({ id: "team-b", machine: "fixture", workspace: "team-b" }),
      makeSession({ id: "legacy", machine: "fixture" }),
    ], machines: [{ name: "fixture", ok: true }] }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  const props = { active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {},
    defaultAutoResume: false, terminalRenderMode: "realtime" as const, terminalSelectedPaneRealtime: true,
    onDebug() {}, onUsage() {}, onSettings() {} };
  const count = () => mounted.container.querySelectorAll('.terminal-slot[data-slot-key]').length;
  const mount = async (expected: number) => {
    await act(async () => mounted.root.render(createElement(Dashboard, props)));
    await waitForCondition(() => count() === expected, "workspace filtered cards");
  };
  const open = async () => {
    const trigger = mounted.container.querySelector<HTMLButtonElement>('.session-filters-trigger'); assert.ok(trigger);
    await act(async () => trigger.click());
  };
  await mount(3);
  await open();
  const teamA = mounted.container.querySelector<HTMLInputElement>('[data-filter-dimension="workspaces"] input[value="team-a"]'); assert.ok(teamA);
  await act(async () => teamA.click());
  await act(async () => mounted.container.querySelector<HTMLButtonElement>('.session-filter-panel-actions .primary')!.click());
  assert.equal(count(), 1);
  const key = "agent-console.principal.workspace-one.agent-console.workspaces.v2";
  assert.equal(mounted.window.localStorage.getItem(key), '["team-a"]');
  await act(async () => mounted.root.render(null));
  await mount(1);
  assert.ok(mounted.container.querySelector('.terminal-slot[data-slot-key="fixture/team-a"]'));
  await act(async () => mounted.root.render(null));
  storage.setPrincipalStorageNamespace("workspace-two");
  await mount(3);
  await act(async () => mounted.root.render(null));
  storage.setPrincipalStorageNamespace("workspace-one");
  await mount(1);
  await open();
  await act(async () => mounted.container.querySelector<HTMLButtonElement>('.session-filter-panel-actions .btn')!.click());
  assert.equal(count(), 3);
  assert.equal(mounted.window.localStorage.getItem(key), "null");
  await act(async () => mounted.root.render(null));
  await mount(3);
});

for (const [key, saved, expected] of [
  ["excluded-workspaces.v1", '["team-a"]', ["fixture/b", "fixture/legacy"]],
  ["excluded-workspaces.v1", "[]", ["fixture/a", "fixture/b", "fixture/legacy"]],
  ["workspaces.v2", '["team-a","team-b",null]', ["fixture/a", "fixture/b", "fixture/legacy"]],
] as const) test(`#987 Dashboard migrates ${key} ${saved} before rendering the first list`, async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  mounted.window.localStorage.setItem(`agent-console.${key}`, saved);
  const sessions = [makeSession({ id: "a", machine: "fixture", workspace: "team-a" }),
    makeSession({ id: "b", machine: "fixture", workspace: "team-b" }),
    makeSession({ id: "legacy", machine: "fixture" })];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true, sessions, machines: [{ name: "fixture", ok: true }] }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  const props = { active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {},
    onDebug() {}, onUsage() {}, onSettings() {} };
  await act(async () => { mounted.root.render(createElement(Dashboard, props)); await flushPromises(); });
  await waitForCondition(() => slotKeys(mounted.container).filter(Boolean).length === expected.length, "migrated matching slots");
  assert.deepEqual(slotKeys(mounted.container).filter(Boolean), [...expected]);
  const canonical = saved === '["team-a"]' ? '["team-b",null]' : "null";
  assert.equal(mounted.window.localStorage.getItem("agent-console.workspaces.v2"), canonical);
  await act(async () => mounted.root.render(null));
  sessions.push(makeSession({ id: "c", machine: "fixture", workspace: "team-c" }));
  await act(async () => { mounted.root.render(createElement(Dashboard, props)); await flushPromises(); });
  await waitForCondition(() => slotKeys(mounted.container).filter(Boolean).length === expected.length + (canonical === "null" ? 1 : 0), "new workspace after canonical reload");
  assert.equal(Boolean(mounted.container.querySelector('.terminal-slot[data-slot-key="fixture/c"]')), canonical === "null");
});

for (const mobile of [false, true]) test(`reviewer990 initial migration preserves staged repo ${mobile}`, async () => {
  const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: mobile ? 384 : 1440 });
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), terminalPaneMockPlugin()]); cleanupStack.push(ssr.close);
  mounted.window.localStorage.setItem("agent-console.excluded-workspaces.v1", '["team-a"]');
  const pending = deferred<SessionsResponse>();
  globalThis.__agentConsoleDashboardBehaviorApiMock = { listSessions: () => pending.promise };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, { active: true, machines: ["fixture"], enabledMachines: ["fixture"],
      machineColors: {}, onDebug() {}, onUsage() {}, onSettings() {} }));
    await flushPromises();
  });
  const trigger = mounted.container.querySelector<HTMLButtonElement>(".session-filters-trigger"); assert.ok(trigger);
  await act(async () => { trigger.click(); await flushPromises(); });
  const repo = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Repository"]'); assert.ok(repo);
  await act(async () => {
    repo.focus();
    Object.getOwnPropertyDescriptor(mounted.window.HTMLInputElement.prototype, "value")?.set?.call(repo, "staged-repo");
    repo.dispatchEvent(new mounted.window.Event("input", { bubbles: true }));
    repo.dispatchEvent(new mounted.window.KeyboardEvent("keyup", { key: "a", bubbles: true }));
    await flushPromises();
  });
  await act(async () => {
    pending.resolve({ ok: true, sessions: [makeSession({ id: "a", machine: "fixture", workspace: "team-a" }),
      makeSession({ id: "b", machine: "fixture", workspace: "team-b" }), makeSession({ id: "u", machine: "fixture" })],
    machines: [{ name: "fixture", ok: true }] });
    await flushPromises();
  });
  assert.equal(repo.value, "staged-repo", "first-list migration cannot discard unrelated staged repo");
  await act(async () => { mounted.container.querySelector<HTMLButtonElement>(".session-filter-panel-actions .primary")!.click(); await flushPromises(); });
  assert.equal(mounted.window.localStorage.getItem("agent-console.workspaces.v2"), '["team-b",null]',
    "Apply must not overwrite migrated exclusion with the old draft");
});

for (const [key, saved] of [["excluded-workspaces.v1", '["team-b"]'], ["workspaces.v2", '["team-a",null]']] as const)
  test(`reviewer990 partial snapshot recovery preserves ${key}`, async () => {
  const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), asyncPollMockPlugin(), terminalPaneMockPlugin()]); cleanupStack.push(ssr.close);
  mounted.window.localStorage.setItem(`agent-console.${key}`, saved);
  let recovered = false;
  const online = [makeSession({ id: "a", machine: "host-a", workspace: "team-a" }), makeSession({ id: "u", machine: "host-a" })];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true,
      sessions: recovered ? [...online, makeSession({ id: "b", machine: "host-b", workspace: "team-b" })] : online,
      machines: [{ name: "host-a", ok: true }, { name: "host-b", ok: recovered }] }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, { active: true, machines: ["host-a", "host-b"], enabledMachines: ["host-a", "host-b"],
      machineColors: {}, onDebug() {}, onUsage() {}, onSettings() {} }));
    await flushPromises();
  });
  await waitForCondition(() => slotKeys(mounted.container).filter(Boolean).length === 2, "first partial list");
  // An untouched editor must not normalize an explicit subset against partial choices either.
  await openSessionFilters(mounted);
  await act(async () => { mounted.container.querySelector<HTMLButtonElement>(".session-filter-panel-actions .primary")!.click(); await flushPromises(); });
  if (key === "workspaces.v2") assert.equal(mounted.window.localStorage.getItem("agent-console.workspaces.v2"), saved);
  await act(async () => { recovered = true; await globalThis.__agentConsoleDashboardPollTask?.(); await flushPromises(); });
  assertNoElement(mounted.container, '.terminal-slot[data-slot-key="host-b/b"]',
    "an excluded workspace must not become visible merely because its host recovers");
});

test("reviewer990-extra unrelated Apply retains deferred all-normalization false", async () => {
  const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  Object.defineProperty(mounted.window, "innerWidth", { configurable: true, value: 1440 });
  const ssr = createUiSsrHarness([dashboardApiMockPlugin(), asyncPollMockPlugin(), terminalPaneMockPlugin()]);
  cleanupStack.push(ssr.close);
  mounted.window.localStorage.setItem("agent-console.workspaces.v2", '["team-a",null]');
  let phase = 0;
  const online = [makeSession({ id: "a", machine: "host-a", workspace: "team-a", repo_name: "staged-repo" }),
    makeSession({ id: "u", machine: "host-a", repo_name: "staged-repo" })];
  globalThis.__agentConsoleDashboardBehaviorApiMock = {
    listSessions: async () => ({ ok: true,
      sessions: phase === 2 ? [...online, makeSession({ id: "b", machine: "host-b", workspace: "team-b", repo_name: "staged-repo" })] : online,
      machines: [{ name: "host-a", ok: true }, { name: "host-b", ok: phase > 0 }] }),
  };
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => {
    mounted.root.render(createElement(Dashboard, { active: true, machines: ["host-a", "host-b"], enabledMachines: ["host-a", "host-b"],
      machineColors: {}, onDebug() {}, onUsage() {}, onSettings() {} }));
    await flushPromises();
  });
  await waitForCondition(() => slotKeys(mounted.container).filter(Boolean).length === 2, "initial partial list");
  await openSessionFilters(mounted);
  const repo = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Repository"]'); assert.ok(repo);
  await act(async () => {
    repo.focus();
    Object.getOwnPropertyDescriptor(mounted.window.HTMLInputElement.prototype, "value")!.set!.call(repo, "staged-repo");
    repo.dispatchEvent(new mounted.window.Event("input", { bubbles: true }));
    repo.dispatchEvent(new mounted.window.KeyboardEvent("keyup", { key: "a", bubbles: true }));
    await flushPromises();
  });
  await act(async () => { mounted.container.querySelector<HTMLButtonElement>(".session-filter-panel-actions .primary")!.click(); await flushPromises(); });
  await act(async () => { phase = 1; await globalThis.__agentConsoleDashboardPollTask?.(); await flushPromises(); });
  const afterComplete = mounted.window.localStorage.getItem("agent-console.workspaces.v2");
  await act(async () => { phase = 2; await globalThis.__agentConsoleDashboardPollTask?.(); await flushPromises(); });
  assert.ok(mounted.container.querySelector('.terminal-slot[data-slot-key="host-b/b"]'),
    "saved-all must normalize on complete discovery after unrelated Apply; v2=" + afterComplete);
  assert.equal(afterComplete, "null");
});

async function extendedDashboard(ssr: ReturnType<typeof createUiSsrHarness>, extension: Record<string, unknown>) {
  const { Dashboard } = await ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  const { UiExtensionsProvider, createUiExtensionRegistry } = await ssr.loadModule<typeof import("../src/extensions.tsx")>("/src/extensions.tsx");
  const registry = createUiExtensionRegistry([{ id: "fixture", ...extension }]);
  return (props: Parameters<typeof Dashboard>[0]) => createElement(UiExtensionsProvider, { registry }, createElement(Dashboard, props));
}


test("page shortcuts wrap in overview", async () => {
  const mounted = await mountOverviewShortcutDashboard();
  const pageLabel = () => mounted.container.querySelector(".session-list-page-label")?.textContent?.trim();
  const press = async (key: string) => {
    await act(async () => { mounted.window.dispatchEvent(metaKey(mounted.window, key)); await flushPromises(); });
  };
  assert.equal(pageLabel(), "1 / 2");
  await press("<");
  assert.equal(pageLabel(), "2 / 2");
  await press(">");
  assert.equal(pageLabel(), "1 / 2");
});
