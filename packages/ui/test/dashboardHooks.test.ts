import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { createElement, StrictMode, useMemo, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Plugin } from "vite";
import type { TitleSummaryRequest } from "@agent-console/shared/api";
import type { SessionTitleState } from "@agent-console/shared/title";
import type {
  SessionRetitleReadiness,
  SessionRetitleRequest,
  SessionRetitleResult,
  SessionRetitleV3Readiness,
  SessionRetitleV3Request,
  SessionRetitleV3Result,
} from "@agent-console/shared/session-retitle";
import type { LayoutOrderResult } from "../src/api.ts";
import type { SlotKey } from "../src/layout.ts";
import type { Session, SessionsResponse } from "../src/types.ts";
import { MANUAL_RETITLE_PROMPT, createdSessionAutoTitleState } from "../src/autoTitleFlow.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

interface ApiMock {
  readonly listSessions?: (machines?: readonly string[]) => Promise<SessionsResponse>;
  readonly glance?: (machine: string, id: string, tail: number) => Promise<unknown>;
  readonly summarizeSessionTitle?: (body: TitleSummaryRequest) => Promise<unknown>;
  readonly updateSessionTitle?: (
    machine: string,
    id: string,
    title: string | null,
    signal?: AbortSignal,
    expectedTitleRevision?: number,
    expectedSessionIncarnation?: string,
    expectedSessionTitle?: string | null,
    titleState?: SessionTitleState | null,
  ) => Promise<unknown>;
  readonly fetchSessionRetitleReadiness?: (machine: string) => Promise<{
    readonly ok: boolean;
    readonly readiness?: SessionRetitleReadiness;
    readonly error?: string;
  }>;
  readonly requestSessionRetitle?: (machine: string, id: string, request: SessionRetitleRequest) => Promise<{
    readonly ok: boolean;
    readonly retitle?: SessionRetitleResult;
    readonly error?: string;
    readonly errorCode?: string;
  }>;
  readonly fetchSessionRetitleV3Readiness?: (machine: string, id: string) => Promise<{
    readonly ok: boolean;
    readonly readiness?: SessionRetitleV3Readiness;
    readonly error?: string;
  }>;
  readonly requestSessionRetitleV3?: (machine: string, id: string, request: SessionRetitleV3Request) => Promise<{
    readonly ok: boolean;
    readonly retitle?: SessionRetitleV3Result;
    readonly error?: string;
    readonly errorCode?: string;
  }>;
  readonly fetchSessionRetitleV3Operation?: (machine: string, id: string, operation: string) => Promise<{
    readonly ok: boolean;
    readonly retitle?: SessionRetitleV3Result;
    readonly error?: string;
    readonly errorCode?: string;
  }>;
  readonly fetchLayoutOrder?: () => Promise<LayoutOrderResult>;
  readonly putLayoutOrder?: (
    order: readonly string[],
    options?: { readonly baseRevision?: number | null; readonly reason?: string; readonly keepalive?: boolean },
  ) => Promise<LayoutOrderResult>;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentConsoleDashboardHooksApiMock: ApiMock | undefined;
}

type FakeTimer = {
  readonly __agentConsoleFakeTimer: true;
  readonly id: number;
  readonly at: number;
  readonly delayMs: number;
  readonly callback: () => void;
  cleared: boolean;
};

function withoutTitleSummaryTrace(requests: readonly TitleSummaryRequest[]): Array<Omit<TitleSummaryRequest, "trace">> {
  return requests.map(({ trace: _trace, ...request }) => request);
}

function mockApiPlugin(): Plugin {
  const mockId = "\0dashboard-hooks-api-mock";
  return {
    name: "dashboard-hooks-api-mock",
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
        const mock = () => globalThis.__agentConsoleDashboardHooksApiMock ?? {};
        export const listSessions = (...args) => mock().listSessions(...args);
        export const glance = (...args) => mock().glance(...args);
        export const summarizeSessionTitle = (...args) => mock().summarizeSessionTitle(...args);
        export const updateSessionTitle = (...args) => mock().updateSessionTitle(...args);
        export const fetchSessionRetitleReadiness = (...args) => mock().fetchSessionRetitleReadiness(...args);
        export const requestSessionRetitle = (...args) => mock().requestSessionRetitle(...args);
        export const fetchSessionRetitleV3Readiness = (...args) => mock().fetchSessionRetitleV3Readiness(...args);
        export const requestSessionRetitleV3 = (...args) => mock().requestSessionRetitleV3(...args);
        export const fetchSessionRetitleV3Operation = (...args) => mock().fetchSessionRetitleV3Operation(...args);
        export const fetchLayoutOrder = (...args) => mock().fetchLayoutOrder(...args);
        export const putLayoutOrder = (...args) => mock().putLayoutOrder(...args);
      `;
    },
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "hs-1",
    machine: "summit",
    agent: "codex",
    status: "running",
    title: null,
    title_revision: 0,
    session_incarnation: "launch-hs-1",
    created_at: "2026-07-08T00:00:00Z",
    cwd: "/workspace/agent-console",
    repo_name: "agent-console",
    updated_at: "2026-07-08T00:00:00Z",
    ...overrides,
  };
}

const cleanupStack: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  delete globalThis.__agentConsoleDashboardHooksApiMock;
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function installDom(): { root: Root; container: HTMLElement; cleanup(): Promise<void> } {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    localStorage: globalThis.localStorage,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    localStorage: window.localStorage,
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
      Object.assign(globalThis, previous);
    },
  };
}

function installFakeTimers(): {
  readonly timers: FakeTimer[];
  advance(ms: number): void;
  cleanup(): void;
} {
  const previous = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    dateNow: Date.now,
  };
  let now = 0;
  let nextId = 1;
  const timers: FakeTimer[] = [];
  Object.assign(globalThis, {
    setTimeout(callback: () => void, delayMs: number, ...args: unknown[]) {
      if (
        delayMs !== 800
        && delayMs !== 5_000
        && delayMs !== 10_000
        && delayMs !== 12_000
        && delayMs !== 15_000
      ) {
        return previous.setTimeout(callback, delayMs, ...args);
      }
      const timer: FakeTimer = {
        __agentConsoleFakeTimer: true,
        id: nextId++,
        at: now + delayMs,
        delayMs,
        callback,
        cleared: false,
      };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer: FakeTimer | ReturnType<typeof globalThis.setTimeout>) {
      if (timer && typeof timer === "object" && "__agentConsoleFakeTimer" in timer) {
        timer.cleared = true;
        return;
      }
      previous.clearTimeout(timer);
    },
  });
  Date.now = () => now;
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (!timer.cleared && timer.at <= now) {
          timer.cleared = true;
          timer.callback();
        }
      }
    },
    cleanup() {
      Object.assign(globalThis, {
        setTimeout: previous.setTimeout,
        clearTimeout: previous.clearTimeout,
      });
      Date.now = previous.dateNow;
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function seedAutoTitleOwnership(
  keys: readonly string[],
  disabled = false,
  ownedTitle: string | null = "New Codex session",
): void {
  window.localStorage.setItem(
    "agent-console.auto-title.states.v1",
    JSON.stringify(Object.fromEntries(keys.map((key) => [
      key,
      { baseTitle: null, disabled, ownedTitle },
    ]))),
  );
}

function completedPlaceholderSession(id = "hs-1", machine = "summit"): Session {
  return makeSession({
    id,
    machine,
    title: "New Codex session",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "waiting",
      phase_changed_at: "2026-07-11T08:44:49Z",
      revision: 2,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      current_turn: null,
      last_turn: {
        provider_turn_id: `turn-${id}`,
        started_at: "2026-07-11T08:41:27Z",
        completed_at: "2026-07-11T08:44:49Z",
        outcome: "completed",
      },
    },
  });
}

test("useAutoTitleController keeps pending turn title refreshes across rerenders", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession();
  seedAutoTitleOwnership(["summit/hs-1"], false, null);
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<{ machine: string; id: string; title: string | null }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    glance: async () => ({ title: null, tail: "terminal output", agent: "codex", repo_name: "agent-console" }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return { ok: true, title: "Summarized turn", source: "summarizer" };
    },
    updateSessionTitle: async (machine, id, title) => {
      titleUpdates.push({ machine, id, title });
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  const applyLiveSessionList = () => undefined;
  const enabledMachinesRef = { current: ["summit"] };
  const liveRef = { current: true };
  const setError = () => undefined;
  const setRetitleFeedback = () => undefined;
  const showRetitleFeedback = () => undefined;
  const activeTerminalSlotKey = () => null;

  function Probe({ refreshVersion }: { readonly refreshVersion: number }) {
    const [sessions, setSessions] = useState<Session[]>([session]);
    const sessionsByKey = useMemo(
      () => new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      [sessions],
    );
    const controller = useAutoTitleController({
      applyLiveSessionList,
      enabledMachinesRef,
      focusedKey: null,
      liveRef,
      refresh: async () => {
        void refreshVersion;
      },
      sessionsByKey,
      setError,
      setRetitleFeedback,
      setSessions,
      showRetitleFeedback,
      activeTerminalSlotKey,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return createElement("output", null, String(refreshVersion));
  }

  await act(async () => {
    mounted.root.render(createElement(Probe, { refreshVersion: 1 }));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "please summarize this turn", "pp-turn-1");
  });
  assert.equal(timers.timers.filter((timer) => !timer.cleared).length, 1);

  await act(async () => {
    mounted.root.render(createElement(Probe, { refreshVersion: 2 }));
  });
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.equal(titleRequests.length, 1);
  assert.deepEqual(titleUpdates, [{ machine: "summit", id: "hs-1", title: "Summarized turn" }]);

  await act(async () => {
    noteTurnPromptSubmitted?.(session, "please summarize this turn", "pp-turn-1");
    timers.advance(12_000);
    await flushPromises();
  });
  assert.equal(titleRequests.length, 1, "a replayed provider event id must be ignored");

  await act(async () => {
    noteTurnPromptSubmitted?.(session, "please summarize this turn", "pp-turn-2");
    timers.advance(12_000);
    await flushPromises();
  });
  assert.equal(titleRequests.length, 2, "identical prompt text with a distinct event id is a new turn");

  await act(async () => {
    noteTurnPromptSubmitted?.(session, "TOKEN=secret-value", "pp-sensitive");
    timers.advance(12_000);
    await flushPromises();
  });
  assert.equal(titleRequests.length, 2, "credential-like provider prompts must not reach title summary");
});

test("useAutoTitleController summarizes an automatic placeholder immediately while output stays active", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  seedAutoTitleOwnership(["summit/hs-1"]);
  let liveTitle = session.title;
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "The turn is still producing output.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return { ok: true, title: "Repair first-prompt titles", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let noteTurnOutput: ((nextSession: Session) => void) | null = null;
  const enabledMachinesRef = { current: ["summit"] };
  const liveRef = { current: true };
  const setError = () => undefined;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef,
      focusedKey: null,
      liveRef,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    noteTurnOutput = controller.noteTurnOutput;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Fix startup retitle", "pp-placeholder-1");
    noteTurnOutput?.(session);
    noteTurnOutput?.(session);
    await flushPromises();
  });

  assert.deepEqual(withoutTitleSummaryTrace(titleRequests), [{ baseTitle: null, prompt: "Fix startup retitle" }]);
  assert.deepEqual(titleUpdates, ["Repair first-prompt titles"]);
  assert.equal(liveTitle, "Repair first-prompt titles");
});

test("useAutoTitleController preserves an in-flight initial summary before scheduling a later action", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  seedAutoTitleOwnership(["summit/hs-1"]);
  let liveTitle = session.title;
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<string | null> = [];
  let resolveInitialSummary: ((value: { ok: true; title: string; source: "summarizer" }) => void) | null = null;
  const applyLiveSessionList = () => undefined;
  const enabledMachinesRef = { current: ["summit"] };
  const liveRef = { current: true };
  const setError = () => undefined;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "The later action is ready to summarize.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      if (titleRequests.length === 1) {
        return new Promise((resolve) => {
          resolveInitialSummary = resolve;
        });
      }
      return { ok: true, title: "Repair first-prompt titles - Verify deployment", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList,
      enabledMachinesRef,
      focusedKey: null,
      liveRef,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Investigate first-prompt retitling", "pp-initial");
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Deploy the verified fix", "pp-later");
    setProbeSessions?.([completedPlaceholderSession()]);
    await flushPromises();
  });
  assert.equal(titleRequests.length, 1, "completion recovery must not race the in-flight initial summary");
  await act(async () => {
    resolveInitialSummary?.({ ok: true, title: "Repair first-prompt titles", source: "summarizer" });
    await flushPromises();
  });
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.deepEqual(withoutTitleSummaryTrace(titleRequests), [
    { baseTitle: null, prompt: "Investigate first-prompt retitling" },
    {
      baseTitle: "Repair first-prompt titles",
      prompt: "Deploy the verified fix",
      currentTitle: "Repair first-prompt titles",
      recentOutput: "The later action is ready to summarize.",
      agent: "codex",
      repoName: "agent-console",
    },
  ]);
  assert.deepEqual(titleUpdates, [
    "Repair first-prompt titles",
    "Repair first-prompt titles - Verify deployment",
  ]);
});

test("useAutoTitleController keeps the placeholder when initial summarization falls back to the prompt", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  seedAutoTitleOwnership(["summit/hs-1"]);
  const titleUpdates: Array<string | null> = [];
  const fallbackSetError = () => undefined;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    summarizeSessionTitle: async () => ({
      ok: true,
      title: "Paste the complete first prompt into the title",
      source: "fallback",
    }),
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: fallbackSetError,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Paste the complete first prompt into the title", "pp-fallback");
    await flushPromises();
  });

  assert.deepEqual(titleUpdates, []);
});

test("useAutoTitleController blocks an already-started completion write when the first prompt arrives", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let liveTitle = session.title;
  const completionSummary = deferred<{ ok: true; title: string; source: "summarizer" }>();
  const initialPatch = deferred<{ ok: true }>();
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "The completed turn is visible.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return body.prompt === "Completed agent task"
        ? completionSummary.promise
        : { ok: true, title: "Preserve provider prompt", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      return initialPatch.promise;
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  assert.equal(titleRequests[0]?.prompt, "Completed agent task");
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Preserve the provider-authored first prompt", "pp-late-provider");
    await flushPromises();
  });
  assert.equal(titleUpdates.length, 1, "only the initial-intent flow may reach PATCH");
  await act(async () => {
    completionSummary.resolve({ ok: true, title: "Completion fallback", source: "summarizer" });
    await flushPromises();
  });
  assert.equal(titleUpdates.length, 1, "completion final admission must observe the active initial lifecycle");
  await act(async () => {
    liveTitle = "Preserve provider prompt";
    initialPatch.resolve({ ok: true });
    await flushPromises();
  });
  assert.equal(liveTitle, "Preserve provider prompt");
});

test("useAutoTitleController reclaims an already-committed completion PATCH for the authoritative first prompt", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  const completionPatch = deferred<{ ok: true; titleRevision: number }>();
  let liveTitle = session.title;
  let liveRevision = session.title_revision ?? 0;
  let patchCount = 0;
  const titleRequests: TitleSummaryRequest[] = [];
  const patchTitles: Array<string | null> = [];
  let renderedSession = session;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle, title_revision: liveRevision }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "The completed fallback is visible.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return body.prompt === "Completed agent task"
        ? { ok: true, title: "Completion fallback", source: "summarizer" }
        : { ok: true, title: "Authoritative first prompt", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title, _signal, expectedRevision, _incarnation, expectedTitle) => {
      patchCount += 1;
      patchTitles.push(title);
      if (patchCount === 1) {
        return completionPatch.promise;
      }
      if (expectedRevision !== liveRevision || expectedTitle !== liveTitle) {
        return {
          ok: false,
          error: "session title changed since it was read",
          conflict: true,
          titleRevision: liveRevision,
          actualTitle: liveTitle,
        };
      }
      liveTitle = title;
      liveRevision += 1;
      return { ok: true, titleRevision: liveRevision };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    renderedSession = sessions[0] ?? session;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  assert.deepEqual(patchTitles, ["Completion fallback"]);
  assert.equal(renderedSession.title, "Completion fallback");
  await act(async () => {
    noteTurnPromptSubmitted?.(
      renderedSession,
      "Use the real first prompt",
      "pp-after-completion-patch",
      "2026-07-11T08:41:27Z",
    );
    await flushPromises();
  });
  await act(async () => {
    liveTitle = "Completion fallback";
    liveRevision = 1;
    completionPatch.resolve({ ok: true, titleRevision: 1 });
    await flushPromises();
  });
  await act(async () => {
    timers.advance(5_000);
    await flushPromises();
    await flushPromises();
    await flushPromises();
  });
  await act(async () => {
    timers.advance(10_000);
    await flushPromises();
    await flushPromises();
  });

  assert.deepEqual(titleRequests.map((request) => request.prompt), [
    "Completed agent task",
    "Use the real first prompt",
    "Use the real first prompt",
    "Use the real first prompt",
  ]);
  assert.deepEqual(patchTitles, [
    "Completion fallback",
    "Authoritative first prompt",
  ]);
  assert.equal(liveTitle, "Authoritative first prompt");
});

test("useAutoTitleController reclaims a fully completed fallback when the first provider prompt arrives late", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let liveTitle = session.title;
  let liveRevision = session.title_revision ?? 0;
  let renderedSession = session;
  const titleRequests: TitleSummaryRequest[] = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle, title_revision: liveRevision }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "Completion fallback context.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return body.prompt === "Completed agent task"
        ? { ok: true, title: "Completion fallback", source: "summarizer" }
        : { ok: true, title: "Late authoritative first prompt", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title, _signal, expectedRevision, _incarnation, expectedTitle) => {
      if (expectedRevision !== liveRevision || expectedTitle !== liveTitle) {
        return {
          ok: false,
          error: "session title changed since it was read",
          conflict: true,
          titleRevision: liveRevision,
          actualTitle: liveTitle,
        };
      }
      liveTitle = title;
      liveRevision += 1;
      return { ok: true, titleRevision: liveRevision };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    renderedSession = sessions[0] ?? session;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
    await flushPromises();
  });
  assert.equal(renderedSession.title, "Completion fallback");
  await act(async () => {
    noteTurnPromptSubmitted?.(
      renderedSession,
      "Use the late provider prompt",
      "pp-after-completion-done",
      "2026-07-11T08:41:27Z",
    );
    await flushPromises();
  });

  assert.deepEqual(titleRequests.map((request) => request.prompt), [
    "Completed agent task",
    "Use the late provider prompt",
  ]);
  assert.equal(liveTitle, "Late authoritative first prompt");
});

test("useAutoTitleController keeps a completed fallback as base for a post-completion prompt", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let liveTitle = session.title;
  let liveRevision = session.title_revision ?? 0;
  let renderedSession = session;
  const titleRequests: TitleSummaryRequest[] = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle, title_revision: liveRevision }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "Second turn output is ready.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return body.prompt === "Completed agent task"
        ? { ok: true, title: "Completion fallback", source: "summarizer" }
        : { ok: true, title: "Completion fallback - Second turn", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      liveTitle = title;
      liveRevision += 1;
      return { ok: true, titleRevision: liveRevision };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: (
    (nextSession: Session, prompt: string, eventId?: string, submittedAt?: string) => void
  ) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    renderedSession = sessions[0] ?? session;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
    await flushPromises();
  });
  assert.equal(renderedSession.title, "Completion fallback");
  await act(async () => {
    noteTurnPromptSubmitted?.(
      renderedSession,
      "Handle the second turn",
      "pp-after-completion-second-turn",
      "2026-07-11T08:45:49Z",
    );
    timers.advance(12_000);
    await flushPromises();
  });

  assert.equal(titleRequests[1]?.baseTitle, "Completion fallback");
  assert.equal(titleRequests[1]?.prompt, "Handle the second turn");
  assert.equal(liveTitle, "Completion fallback - Second turn");
});

test("useAutoTitleController lets manual retitle supersede a deferred initial summary", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  seedAutoTitleOwnership(["summit/hs-1"]);
  const initialSummary = deferred<{ ok: true; title: string; source: "summarizer" }>();
  const titleUpdates: Array<string | null> = [];
  let liveTitle = session.title;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({ title: liveTitle, tail: "Manual retitle context", agent: "codex", repo_name: "agent-console" }),
    summarizeSessionTitle: async (body) => body.prompt === MANUAL_RETITLE_PROMPT
      ? { ok: true, title: "Manual retitle wins", source: "summarizer" }
      : initialSummary.promise,
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let retitleSession: ((nextSession: Session) => Promise<void>) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    retitleSession = controller.retitleSession;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Deferred original intent", "pp-deferred-initial");
    await flushPromises();
    await retitleSession?.(session);
  });
  await act(async () => {
    initialSummary.resolve({ ok: true, title: "Stale initial title", source: "summarizer" });
    await flushPromises();
  });
  assert.deepEqual(titleUpdates, ["Manual retitle wins"]);
  assert.equal(liveTitle, "Manual retitle wins");
});

test("useAutoTitleController serializes a manual PATCH after an already-started initial PATCH", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  seedAutoTitleOwnership(["summit/hs-1"]);
  const initialPatch = deferred<{ ok: true }>();
  let liveTitle = session.title;
  let renderedSession = session;
  const patchTitles: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    summarizeSessionTitle: async () => ({ ok: true, title: "Initial summarized intent", source: "summarizer" }),
    updateSessionTitle: async (_machine, _id, title) => {
      patchTitles.push(title);
      if (patchTitles.length === 1) {
        return initialPatch.promise.then((result) => {
          liveTitle = title;
          return result;
        });
      }
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let updateManualSessionTitle:
    | ((nextSession: Session, title: string | null) => Promise<unknown>)
    | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    renderedSession = sessions[0] ?? session;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    updateManualSessionTitle = controller.updateManualSessionTitle;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Summarize the initial intent", "pp-patch-started");
    await flushPromises();
  });
  assert.deepEqual(patchTitles, ["Initial summarized intent"]);
  let manualResult: Promise<unknown> | null = null;
  await act(async () => {
    manualResult = updateManualSessionTitle?.(renderedSession, "Manual title wins") ?? null;
    await flushPromises();
  });
  assert.deepEqual(patchTitles, ["Initial summarized intent"]);
  await act(async () => {
    initialPatch.resolve({ ok: true });
    await manualResult;
    await flushPromises();
  });

  assert.deepEqual(patchTitles, ["Initial summarized intent", "Manual title wins"]);
  assert.equal(liveTitle, "Manual title wins");
});

test("useAutoTitleController reconciles an auto PATCH when the queued manual PATCH fails", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  seedAutoTitleOwnership(["summit/hs-1"]);
  const initialPatch = deferred<{ ok: true }>();
  let liveTitle = session.title;
  let renderedSession = session;
  const patchTitles: Array<string | null> = [];
  const titleRequests: TitleSummaryRequest[] = [];
  const applyLiveSessionList = () => undefined;
  const enabledMachinesRef = { current: ["summit"] };
  const liveRef = { current: true };
  const setError = () => undefined;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "The follow-up action completed.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return titleRequests.length === 1
        ? { ok: true, title: "Initial summarized intent", source: "summarizer" }
        : { ok: true, title: "Initial summarized intent - Continue safely", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      patchTitles.push(title);
      if (patchTitles.length === 1) {
        return initialPatch.promise.then((result) => {
          liveTitle = title;
          return result;
        });
      }
      if (patchTitles.length === 2) {
        return { ok: false, error: "manual title update failed" };
      }
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let updateManualSessionTitle:
    | ((nextSession: Session, title: string | null) => Promise<unknown>)
    | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    renderedSession = sessions[0] ?? session;
    const controller = useAutoTitleController({
      applyLiveSessionList,
      enabledMachinesRef,
      focusedKey: null,
      liveRef,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    updateManualSessionTitle = controller.updateManualSessionTitle;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Summarize the initial intent", "pp-reconcile-initial");
    await flushPromises();
  });
  let manualResult: Promise<unknown> | null = null;
  await act(async () => {
    manualResult = updateManualSessionTitle?.(renderedSession, "Manual title that fails") ?? null;
    await flushPromises();
  });
  await act(async () => {
    initialPatch.resolve({ ok: true });
    await manualResult;
    await flushPromises();
  });

  const reconciled = JSON.parse(
    window.localStorage.getItem("agent-console.auto-title.states.v1") ?? "{}",
  )["summit/hs-1"];
  assert.deepEqual(reconciled, {
    baseTitle: "Initial summarized intent",
    baseTitleConfirmed: true,
    disabled: false,
    ownedTitle: "Initial summarized intent",
  });
  assert.equal(renderedSession.title, "Initial summarized intent");
  await act(async () => {
    noteTurnPromptSubmitted?.(renderedSession, "Continue safely", "pp-reconcile-follow-up");
    timers.advance(12_000);
    await flushPromises();
  });
  assert.deepEqual(patchTitles, [
    "Initial summarized intent",
    "Manual title that fails",
    "Initial summarized intent - Continue safely",
  ]);
});

test("useAutoTitleController times out a stalled PATCH so a queued manual title can proceed", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  seedAutoTitleOwnership(["summit/hs-1"]);
  let liveTitle = session.title;
  let liveRevision = session.title_revision ?? 0;
  let stalledSignal: AbortSignal | undefined;
  const patches: Array<{
    title: string | null;
    expectedRevision: number | undefined;
    expectedIncarnation: string | undefined;
    expectedTitle: string | null | undefined;
  }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle, title_revision: liveRevision }],
      machines: [{ name: "summit", ok: true }],
    }),
    summarizeSessionTitle: async () => ({ ok: true, title: "Stalled automatic title", source: "summarizer" }),
    updateSessionTitle: async (
      _machine,
      _id,
      title,
      signal,
      expectedTitleRevision,
      expectedSessionIncarnation,
      expectedSessionTitle,
    ) => {
      patches.push({
        title,
        expectedRevision: expectedTitleRevision,
        expectedIncarnation: expectedSessionIncarnation,
        expectedTitle: expectedSessionTitle,
      });
      if (patches.length === 1) {
        stalledSignal = signal;
        signal?.addEventListener("abort", () => {
          liveTitle = title;
          liveRevision = 1;
        }, { once: true });
        return new Promise(() => undefined);
      }
      if (expectedTitleRevision !== liveRevision) {
        return {
          ok: false,
          error: "session title changed since it was read",
          conflict: true,
          titleRevision: liveRevision,
          actualTitle: liveTitle,
        };
      }
      liveTitle = title;
      liveRevision += 1;
      return { ok: true, titleRevision: liveRevision };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let updateManualSessionTitle:
    | ((nextSession: Session, title: string | null) => Promise<unknown>)
    | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    updateManualSessionTitle = controller.updateManualSessionTitle;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Start a bounded title update", "pp-timeout-initial");
    await flushPromises();
  });
  let manualResult: Promise<unknown> | null = null;
  await act(async () => {
    manualResult = updateManualSessionTitle?.(session, "Manual title after timeout") ?? null;
    await flushPromises();
  });
  assert.deepEqual(patches, [{
    title: "Stalled automatic title",
    expectedRevision: 0,
    expectedIncarnation: "launch-hs-1",
    expectedTitle: "New Codex session",
  }]);
  await act(async () => {
    timers.advance(15_000);
    await manualResult;
    await flushPromises();
  });

  assert.equal(stalledSignal?.aborted, true);
  assert.deepEqual(patches, [
    {
      title: "Stalled automatic title",
      expectedRevision: 0,
      expectedIncarnation: "launch-hs-1",
      expectedTitle: "New Codex session",
    },
    {
      title: "Manual title after timeout",
      expectedRevision: 0,
      expectedIncarnation: "launch-hs-1",
      expectedTitle: "New Codex session",
    },
    {
      title: "Manual title after timeout",
      expectedRevision: 1,
      expectedIncarnation: "launch-hs-1",
      expectedTitle: "Stalled automatic title",
    },
  ]);
  assert.equal(liveTitle, "Manual title after timeout");
  assert.equal(liveRevision, 2);
});

test("useAutoTitleController clears cached title capability after a daemon rollback", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const upgraded = makeSession({ title: "Upgraded title", title_revision: 4 });
  let patchCalls = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    updateSessionTitle: async () => {
      patchCalls += 1;
      return { ok: true, titleRevision: 5 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let updateManualSessionTitle:
    | ((session: Session, title: string | null) => Promise<{ ok: boolean; error?: string }>)
    | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([upgraded]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    updateManualSessionTitle = controller.updateManualSessionTitle;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  const rolledBack = { ...upgraded, title_revision: undefined, session_incarnation: undefined };
  await act(async () => {
    setProbeSessions?.([rolledBack]);
    await flushPromises();
  });
  let result: { ok: boolean; error?: string } | undefined;
  await act(async () => {
    result = await updateManualSessionTitle?.(rolledBack, "Unsafe old-daemon write");
  });

  assert.equal(result?.ok, false);
  assert.match(result?.error ?? "", /revision support/);
  assert.equal(patchCalls, 0);
});

test("useAutoTitleController cancels a pending initial retry when the controller unmounts", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  const completed = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let summaries = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [completed], machines: [{ name: "summit", ok: true }] }),
    summarizeSessionTitle: async () => {
      summaries += 1;
      return { ok: true, title: "Fallback title", source: "fallback" };
    },
    updateSessionTitle: async () => ({ ok: true }),
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setHostVisible: ((visible: boolean) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  function Host() {
    const [visible, setVisible] = useState(true);
    setHostVisible = setVisible;
    return visible ? createElement(Probe) : null;
  }

  await act(async () => {
    mounted.root.render(createElement(Host));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Retry only while mounted", "pp-unmount-retry");
    await flushPromises();
    setProbeSessions?.([completed]);
    await flushPromises();
  });
  assert.equal(summaries, 1);
  assert.equal(timers.timers.filter((timer) => timer.delayMs === 5_000 && !timer.cleared).length, 1);
  await act(async () => {
    setHostVisible?.(false);
    await flushPromises();
  });
  await act(async () => {
    timers.advance(5_000);
    await flushPromises();
  });
  assert.equal(summaries, 1);
});

test("useAutoTitleController remains active after StrictMode effect replay", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  seedAutoTitleOwnership(["summit/hs-1"]);
  let patches = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    summarizeSessionTitle: async () => ({ ok: true, title: "StrictMode summarized intent", source: "summarizer" }),
    updateSessionTitle: async () => {
      patches += 1;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(StrictMode, null, createElement(Probe)));
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Verify StrictMode title updates", "pp-strict-mode");
    await flushPromises();
  });

  assert.equal(patches, 1);
});

test("useAutoTitleController invalidates a removed session generation before the same key returns", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  seedAutoTitleOwnership(["summit/hs-1"]);
  const oldSummary = deferred<{ ok: true; title: string; source: "summarizer" }>();
  const titleUpdates: Array<string | null> = [];
  let liveTitle = session.title;
  let summaryCount = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [{ ...session, title: liveTitle }], machines: [{ name: "summit", ok: true }] }),
    summarizeSessionTitle: async () => {
      summaryCount += 1;
      return summaryCount === 1
        ? oldSummary.promise
        : { ok: true, title: "Returned session intent", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      liveSessionKeys: new Set(sessions.map((item) => `${item.machine}/${item.id}`)),
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Old runtime intent", "pp-old-runtime");
    await flushPromises();
  });
  await act(async () => {
    setProbeSessions?.([]);
    await flushPromises();
  });
  await act(async () => {
    setProbeSessions?.([session]);
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Returned runtime intent", "pp-returned-runtime");
    await flushPromises();
  });
  await act(async () => {
    oldSummary.resolve({ ok: true, title: "Stale old runtime title", source: "summarizer" });
    await flushPromises();
  });

  assert.deepEqual(titleUpdates, ["Returned session intent"]);
  assert.equal(liveTitle, "Returned session intent");
});

test("useAutoTitleController invalidates stale state when the same key gets a new incarnation", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const oldSession = makeSession({ title: "New Codex session", session_incarnation: "launch-old" });
  const replacement = makeSession({
    title: "New Codex session",
    session_incarnation: "launch-new",
    created_at: "2026-07-09T00:00:00Z",
  });
  seedAutoTitleOwnership(["summit/hs-1"]);
  const oldSummary = deferred<{ ok: true; title: string; source: "summarizer" }>();
  let summaryCount = 0;
  const titleUpdates: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [replacement], machines: [{ name: "summit", ok: true }] }),
    summarizeSessionTitle: async () => {
      summaryCount += 1;
      return summaryCount === 1
        ? oldSummary.promise
        : { ok: true, title: "Replacement session intent", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      return { ok: true, titleRevision: 1 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let updateAutoTitleStates: ReturnType<typeof useAutoTitleController>["updateAutoTitleStates"] | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([oldSession]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    updateAutoTitleStates = controller.updateAutoTitleStates;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(oldSession, "Old incarnation prompt", "pp-old-incarnation");
    await flushPromises();
  });
  await act(async () => {
    setProbeSessions?.([replacement]);
    await flushPromises();
  });
  await act(async () => {
    updateAutoTitleStates?.((prev) => ({
      ...prev,
      "summit/hs-1": {
        baseTitle: null,
        baseTitleConfirmed: false,
        disabled: false,
        ownedTitle: "New Codex session",
      },
    }));
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(replacement, "Replacement incarnation prompt", "pp-new-incarnation");
    await flushPromises();
  });
  await act(async () => {
    oldSummary.resolve({ ok: true, title: "Stale old incarnation title", source: "summarizer" });
    await flushPromises();
  });

  assert.deepEqual(titleUpdates, ["Replacement session intent"]);
});

test("useAutoTitleController preserves automatic title ownership across a normal resume", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const oldSession = makeSession({
    title: "Existing session intent",
    title_revision: 4,
    session_incarnation: "launch-before-resume",
  });
  const resumedSession = makeSession({
    title: "Existing session intent",
    title_revision: 4,
    session_incarnation: "launch-after-resume",
  });
  window.localStorage.setItem(
    "agent-console.auto-title.states.v1",
    JSON.stringify({
      "summit/hs-1": {
        baseTitle: "Existing session intent",
        baseTitleConfirmed: true,
        disabled: false,
        ownedTitle: "Existing session intent",
      },
    }),
  );
  const patches: Array<{
    readonly title: string | null;
    readonly incarnation: string | undefined;
    readonly expectedTitle: string | null | undefined;
  }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [resumedSession], machines: [{ name: "summit", ok: true }] }),
    glance: async () => ({
      title: "Existing session intent",
      tail: "The resumed turn is active.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async () => ({
      ok: true,
      title: "Existing session intent - add resume checks",
      source: "summarizer",
    }),
    updateSessionTitle: async (_machine, _id, title, _signal, _revision, incarnation, expectedTitle) => {
      patches.push({ title, incarnation, expectedTitle });
      return { ok: true, titleRevision: 5 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([oldSession]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(oldSession, "Add resume checks", "pp-before-resume");
    await flushPromises();
  });
  assert.equal(timers.timers.filter((timer) => !timer.cleared).length, 1);
  await act(async () => {
    setProbeSessions?.([resumedSession]);
    await flushPromises();
  });
  assert.equal(timers.timers.filter((timer) => !timer.cleared).length, 1);
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.deepEqual(patches, [{
    title: "Existing session intent - add resume checks",
    incarnation: "launch-after-resume",
    expectedTitle: "Existing session intent",
  }]);
});

test("useAutoTitleController restarts an immutable first prompt and queued action after resume", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const oldSession = makeSession({
    title: "New Codex session",
    session_incarnation: "launch-before-summary-resume",
  });
  const resumedSession = makeSession({
    title: "New Codex session",
    session_incarnation: "launch-after-summary-resume",
  });
  seedAutoTitleOwnership(["summit/hs-1"]);
  const oldSummary = deferred<{ ok: true; title: string; source: "summarizer" }>();
  let summaryCount = 0;
  let liveTitle = oldSession.title;
  let revision = 0;
  const patches: Array<{ readonly title: string | null; readonly incarnation: string | undefined }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...resumedSession, title: liveTitle, title_revision: revision }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "The queued resumed turn is active.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async () => {
      summaryCount += 1;
      if (summaryCount === 1) {
        return oldSummary.promise;
      }
      return {
        ok: true,
        title: summaryCount === 2
          ? "Immutable first prompt intent"
          : "Immutable first prompt intent - queued follow-up",
        source: "summarizer",
      };
    },
    updateSessionTitle: async (_machine, _id, title, _signal, _expectedRevision, incarnation) => {
      patches.push({ title, incarnation });
      liveTitle = title;
      revision += 1;
      return { ok: true, titleRevision: revision };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([oldSession]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(oldSession, "Preserve this immutable first prompt", "pp-first-before-resume");
    await flushPromises();
    noteTurnPromptSubmitted?.(oldSession, "Then keep this queued follow-up", "pp-queued-before-resume");
    await flushPromises();
  });
  assert.equal(summaryCount, 1);
  await act(async () => {
    setProbeSessions?.([resumedSession]);
    await flushPromises();
  });
  assert.equal(summaryCount, 2, "resume must restart the immutable first prompt");
  await act(async () => {
    oldSummary.resolve({ ok: true, title: "Stale pre-resume title", source: "summarizer" });
    await flushPromises();
  });
  assert.equal(timers.timers.filter((timer) => !timer.cleared).length, 1);
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.deepEqual(patches, [
    { title: "Immutable first prompt intent", incarnation: "launch-after-summary-resume" },
    { title: "Immutable first prompt intent - queued follow-up", incarnation: "launch-after-summary-resume" },
  ]);
});

test("useAutoTitleController restarts an active later-turn summary after resume", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const oldSession = makeSession({
    title: "Existing session intent",
    title_revision: 4,
    session_incarnation: "launch-before-active-resume",
  });
  const resumedSession = makeSession({
    title: "Existing session intent",
    title_revision: 4,
    session_incarnation: "launch-after-active-resume",
  });
  window.localStorage.setItem(
    "agent-console.auto-title.states.v1",
    JSON.stringify({
      "summit/hs-1": {
        baseTitle: "Existing session intent",
        baseTitleConfirmed: true,
        disabled: false,
        ownedTitle: "Existing session intent",
      },
    }),
  );
  const oldSummary = deferred<{ ok: true; title: string; source: "summarizer" }>();
  let summaryCount = 0;
  let currentSession = oldSession;
  const patches: Array<{ readonly title: string | null; readonly incarnation: string | undefined }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [currentSession], machines: [{ name: "summit", ok: true }] }),
    glance: async () => ({
      title: "Existing session intent",
      tail: "The active turn is still safe.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async () => {
      summaryCount += 1;
      return summaryCount === 1
        ? oldSummary.promise
        : { ok: true, title: "Existing session intent - migrated active turn", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title, _signal, _revision, incarnation) => {
      patches.push({ title, incarnation });
      return { ok: true, titleRevision: 5 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([oldSession]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(oldSession, "Migrate this active later turn", "pp-active-before-resume");
    timers.advance(12_000);
    await flushPromises();
  });
  assert.equal(summaryCount, 1);
  await act(async () => {
    currentSession = resumedSession;
    setProbeSessions?.([resumedSession]);
    await flushPromises();
  });
  assert.equal(summaryCount, 2);
  await act(async () => {
    oldSummary.resolve({ ok: true, title: "Stale old active title", source: "summarizer" });
    await flushPromises();
  });

  assert.deepEqual(patches, [{
    title: "Existing session intent - migrated active turn",
    incarnation: "launch-after-active-resume",
  }]);
});

test("useAutoTitleController does not migrate pending idle work across a manual title change on resume", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const oldSession = makeSession({
    title: "Existing session intent",
    title_revision: 4,
    session_incarnation: "launch-before-manual-resume",
  });
  const resumedSession = makeSession({
    title: "Manual resume title",
    title_revision: 5,
    session_incarnation: "launch-after-manual-resume",
  });
  window.localStorage.setItem(
    "agent-console.auto-title.states.v1",
    JSON.stringify({
      "summit/hs-1": {
        baseTitle: "Existing session intent",
        baseTitleConfirmed: true,
        disabled: false,
        ownedTitle: "Existing session intent",
      },
    }),
  );
  let summaries = 0;
  let patches = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [resumedSession], machines: [{ name: "summit", ok: true }] }),
    glance: async () => ({ title: resumedSession.title, tail: "safe", agent: "codex", repo_name: "agent-console" }),
    summarizeSessionTitle: async () => {
      summaries += 1;
      return { ok: true, title: "Must not overwrite manual title", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      patches += 1;
      return { ok: true, titleRevision: 6 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([oldSession]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(oldSession, "Pending idle work", "pp-pending-manual-resume");
  });
  await act(async () => {
    setProbeSessions?.([resumedSession]);
    timers.advance(12_000);
    await flushPromises();
  });

  assert.equal(summaries, 0);
  assert.equal(patches, 0);
});

test("useAutoTitleController commits automatic retitles against the summarized title-state revision", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const automatic = makeSession({
    title: "Retitle rules #317",
    title_revision: 4,
    title_state_supported: true,
    title_state: {
      topic: "Retitle rules",
      topic_source: "auto",
      references: ["#317"],
      activity: null,
    },
  });
  const userOwned = makeSession({
    ...automatic,
    title_revision: 5,
    title_state: {
      ...automatic.title_state!,
      topic_source: "user",
    },
  });
  const summary = deferred<{
    ok: true;
    title: string;
    titleState: NonNullable<Session["title_state"]>;
    source: "summarizer";
  }>();
  let currentSession = automatic;
  let summaryRequests = 0;
  const patches: Array<{
    readonly title: string | null;
    readonly revision: number | undefined;
    readonly incarnation: string | undefined;
    readonly expectedTitle: string | null | undefined;
    readonly titleState: SessionTitleState | null | undefined;
  }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [currentSession], machines: [{ name: "summit", ok: true }] }),
    glance: async () => ({
      title: currentSession.title,
      title_state: currentSession.title_state,
      title_state_supported: true,
      tail: "Implement the contract.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async () => {
      summaryRequests += 1;
      return summary.promise;
    },
    updateSessionTitle: async (_machine, _id, title, _signal, revision, incarnation, expectedTitle, titleState) => {
      patches.push({ title, revision, incarnation, expectedTitle, titleState });
      return { ok: true, titleRevision: (revision ?? 0) + 1 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let retitleSession: ((session: Session) => Promise<void>) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([automatic]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    retitleSession = controller.retitleSession;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  let retitlePromise: Promise<void> | undefined;
  await act(async () => {
    retitlePromise = retitleSession?.(automatic);
    for (let attempt = 0; attempt < 10 && summaryRequests === 0; attempt += 1) {
      await flushPromises();
    }
  });
  assert.equal(summaryRequests, 1);
  await act(async () => {
    currentSession = userOwned;
    setProbeSessions?.([userOwned]);
    await flushPromises();
    summary.resolve({
      ok: true,
      title: "Retitle rules #317 - Implement contract",
      titleState: {
        topic: "Retitle rules",
        topic_source: "auto",
        references: ["#317"],
        activity: "Implement contract",
      },
      source: "summarizer",
    });
    await retitlePromise;
  });

  assert.deepEqual(patches, [{
    title: "Retitle rules #317 - Implement contract",
    revision: 4,
    incarnation: "launch-hs-1",
    expectedTitle: "Retitle rules #317",
    titleState: {
      topic: "Retitle rules",
      topic_source: "auto",
      references: ["#317"],
      activity: "Implement contract",
    },
  }]);
});

test("useAutoTitleController does not restart an in-flight first summary across a manual title change on resume", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const oldSession = makeSession({
    title: "New Codex session",
    session_incarnation: "launch-before-inflight-manual-resume",
  });
  const resumedSession = makeSession({
    title: "Manual title during resume",
    title_revision: 1,
    session_incarnation: "launch-after-inflight-manual-resume",
  });
  seedAutoTitleOwnership(["summit/hs-1"]);
  const oldSummary = deferred<{ ok: true; title: string; source: "summarizer" }>();
  let summaries = 0;
  let patches = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [resumedSession], machines: [{ name: "summit", ok: true }] }),
    summarizeSessionTitle: async () => {
      summaries += 1;
      return oldSummary.promise;
    },
    updateSessionTitle: async () => {
      patches += 1;
      return { ok: true, titleRevision: 2 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([oldSession]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(oldSession, "Original first prompt", "pp-inflight-manual-resume");
    await flushPromises();
  });
  await act(async () => {
    setProbeSessions?.([resumedSession]);
    await flushPromises();
    oldSummary.resolve({ ok: true, title: "Stale automatic title", source: "summarizer" });
    await flushPromises();
  });

  assert.equal(summaries, 1);
  assert.equal(patches, 0);
});

test("useAutoTitleController confirms a title PATCH committed before its resume response", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const oldSession = makeSession({
    title: "New Codex session",
    session_incarnation: "launch-before-commit-resume",
  });
  const resumedSession = makeSession({
    title: "Committed first prompt intent",
    title_revision: 1,
    session_incarnation: "launch-after-commit-resume",
  });
  seedAutoTitleOwnership(["summit/hs-1"]);
  const firstPatchResponse = deferred<{ ok: true; titleRevision: number }>();
  const patches: Array<{ readonly title: string | null; readonly incarnation: string | undefined }> = [];
  let summaryCount = 0;
  let currentSession = oldSession;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [currentSession], machines: [{ name: "summit", ok: true }] }),
    glance: async () => ({
      title: resumedSession.title,
      tail: "The post-resume turn is active.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async () => {
      summaryCount += 1;
      return {
        ok: true,
        title: summaryCount === 1
          ? "Committed first prompt intent"
          : "Committed first prompt intent - later action",
        source: "summarizer",
      };
    },
    updateSessionTitle: async (_machine, _id, title, _signal, _revision, incarnation) => {
      patches.push({ title, incarnation });
      return patches.length === 1
        ? firstPatchResponse.promise
        : { ok: true, titleRevision: 2 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([oldSession]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(oldSession, "Commit this first intent", "pp-commit-before-resume");
    for (let attempt = 0; attempt < 10 && patches.length === 0; attempt += 1) {
      await flushPromises();
    }
  });
  assert.equal(patches.length, 1);
  await act(async () => {
    currentSession = resumedSession;
    setProbeSessions?.([resumedSession]);
    await flushPromises();
    firstPatchResponse.resolve({ ok: true, titleRevision: 1 });
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(resumedSession, "Add a later action", "pp-after-committed-resume");
    timers.advance(12_000);
    await flushPromises();
  });

  assert.deepEqual(patches, [
    { title: "Committed first prompt intent", incarnation: "launch-before-commit-resume" },
    { title: "Committed first prompt intent - later action", incarnation: "launch-after-commit-resume" },
  ]);
});

test("useAutoTitleController ignores an old completion attempt after the same key returns", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const completed = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  const oldSummary = deferred<{ ok: true; title: string; source: "summarizer" }>();
  let liveTitle = completed.title;
  let summaryCount = 0;
  const titleUpdates: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...completed, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "Completion output is safe.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async () => {
      summaryCount += 1;
      return summaryCount === 1
        ? oldSummary.promise
        : { ok: true, title: "Returned completion intent", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([completed]);
    setProbeSessions = setSessions;
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      liveSessionKeys: new Set(sessions.map((item) => `${item.machine}/${item.id}`)),
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  assert.equal(summaryCount, 1);
  await act(async () => {
    setProbeSessions?.([]);
    await flushPromises();
  });
  await act(async () => {
    setProbeSessions?.([completed]);
    await flushPromises();
  });
  await act(async () => {
    oldSummary.resolve({ ok: true, title: "Stale old completion title", source: "summarizer" });
    await flushPromises();
  });

  assert.equal(summaryCount, 2);
  assert.deepEqual(titleUpdates, ["Returned completion intent"]);
  assert.equal(liveTitle, "Returned completion intent");
});

test("useAutoTitleController retries the immutable first prompt before a queued later action", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  const completed = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let liveTitle = session.title;
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<string | null> = [];
  const applyLiveSessionList = () => undefined;
  const enabledMachinesRef = { current: ["summit"] };
  const liveRef = { current: true };
  const setError = () => undefined;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...completed, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "The queued action is ready.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      if (titleRequests.length === 1) {
        return { ok: true, title: body.prompt, source: "fallback" };
      }
      if (titleRequests.length === 2) {
        return { ok: true, title: "Preserve original intent", source: "summarizer" };
      }
      return { ok: true, title: "Preserve original intent - Deploy verified fix", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList,
      enabledMachinesRef,
      focusedKey: null,
      liveRef,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Preserve the original first intent", "pp-original");
    await flushPromises();
    noteTurnPromptSubmitted?.(session, "Deploy the verified fix", "pp-queued");
    setProbeSessions?.([completed]);
    await flushPromises();
  });
  assert.equal(titleRequests.length, 1);
  await act(async () => {
    timers.advance(5_000);
    setProbeSessions?.([{ ...completed }]);
    await flushPromises();
  });
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.deepEqual(withoutTitleSummaryTrace(titleRequests), [
    { baseTitle: null, prompt: "Preserve the original first intent" },
    { baseTitle: null, prompt: "Preserve the original first intent" },
    {
      baseTitle: "Preserve original intent",
      prompt: "Deploy the verified fix",
      currentTitle: "Preserve original intent",
      recentOutput: "The queued action is ready.",
      agent: "codex",
      repoName: "agent-console",
    },
  ]);
  assert.deepEqual(titleUpdates, [
    "Preserve original intent",
    "Preserve original intent - Deploy verified fix",
  ]);
});

test("useAutoTitleController retries a failed initial PATCH before replaying a queued prompt", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  const completed = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  const firstPatch = deferred<{ ok: false; error: string }>();
  let liveTitle = session.title;
  let renderedPatchSession = session;
  let patchCount = 0;
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...completed, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "Queued follow-up completed.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return titleRequests.length < 3
        ? { ok: true, title: "Recovered original intent", source: "summarizer" }
        : { ok: true, title: "Recovered original intent - Ship macOS update", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      patchCount += 1;
      if (patchCount === 1) {
        return firstPatch.promise;
      }
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    renderedPatchSession = sessions[0] ?? session;
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Recover the original first intent", "pp-patch-original");
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(
      renderedPatchSession,
      "Ship the macOS update",
      "pp-patch-queued",
    );
  });
  await act(async () => {
    setProbeSessions?.([completed]);
    await flushPromises();
  });
  await act(async () => {
    firstPatch.resolve({ ok: false, error: "title update failed" });
    await flushPromises();
  });
  assert.equal(timers.timers.filter((timer) => timer.delayMs === 5_000 && !timer.cleared).length, 1);
  await act(async () => {
    timers.advance(5_000);
    setProbeSessions?.([{ ...completed }]);
    await flushPromises();
  });
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.deepEqual(withoutTitleSummaryTrace(titleRequests), [
    { baseTitle: null, prompt: "Recover the original first intent" },
    { baseTitle: null, prompt: "Recover the original first intent" },
    {
      baseTitle: "Recovered original intent",
      prompt: "Ship the macOS update",
      currentTitle: "Recovered original intent",
      recentOutput: "Queued follow-up completed.",
      agent: "codex",
      repoName: "agent-console",
    },
  ]);
  assert.equal(patchCount, 3);
  assert.deepEqual(titleUpdates, [
    "Recovered original intent",
    "Recovered original intent - Ship macOS update",
  ]);
});

test("useAutoTitleController hands exhausted initial retries to completion recovery", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "New Codex session" });
  const completed = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let liveTitle = session.title;
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<string | null> = [];
  const applyExhaustionSessionList = () => undefined;
  const exhaustionEnabledMachinesRef = { current: ["summit"] };
  const exhaustionLiveRef = { current: true };
  const setExhaustionError = () => undefined;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...completed, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "Authoritative completion is available.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      if (titleRequests.length <= 3) {
        return { ok: true, title: body.prompt, source: "fallback" };
      }
      return titleRequests.length === 4
        ? { ok: true, title: "Completion recovered intent", source: "summarizer" }
        : { ok: true, title: "Completion recovered intent - Verify deployment", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: applyExhaustionSessionList,
      enabledMachinesRef: exhaustionEnabledMachinesRef,
      focusedKey: null,
      liveRef: exhaustionLiveRef,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: setExhaustionError,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Keep this immutable intent", "pp-exhaust-original");
    await flushPromises();
    noteTurnPromptSubmitted?.(session, "Verify the deployment", "pp-exhaust-queued");
    setProbeSessions?.([completed]);
    await flushPromises();
  });
  await act(async () => {
    timers.advance(5_000);
    await flushPromises();
    await flushPromises();
    await flushPromises();
  });
  await act(async () => {
    timers.advance(10_000);
    await flushPromises();
    setProbeSessions?.([{ ...completed }]);
    await flushPromises();
  });
  assert.equal(titleRequests.length, 4);
  const initialTraces = titleRequests.slice(0, 3).map((request) => request.trace);
  assert.deepEqual(initialTraces.map((trace) => trace?.phase), ["initial", "initial", "initial"]);
  assert.deepEqual(initialTraces.map((trace) => trace?.attempt), [1, 2, 3]);
  assert.equal(new Set(initialTraces.map((trace) => trace?.attemptId)).size, 1);
  assert.match(initialTraces[0]?.attemptId ?? "", /^title_[A-Za-z0-9_-]{8,72}$/);
  assert.equal(titleRequests[3]?.trace?.phase, "completion");
  const { flushDebugEvents } = await ssr.loadModule<typeof import("../src/debugLog.ts")>("/src/debugLog.ts");
  flushDebugEvents();
  const persistedLifecycle = JSON.parse(
    window.localStorage.getItem("agent-console:debug-events:v1") ?? "[]",
  ) as Array<Record<string, unknown>>;
  const initialAttemptId = initialTraces[0]?.attemptId;
  const initialLifecycle = persistedLifecycle.filter((event) => event.attempt_id === initialAttemptId);
  assert.equal(initialLifecycle.filter((event) => event.outcome === "retry_scheduled").length, 2);
  assert.equal(initialLifecycle.filter((event) => event.outcome === "retry_exhausted").length, 1);
  assert.equal(JSON.stringify(initialLifecycle).includes("Keep this immutable intent"), false);
  assert.deepEqual(titleUpdates, ["Completion recovered intent"]);
  assert.equal(timers.timers.filter((timer) => timer.delayMs === 12_000 && !timer.cleared).length, 1);
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.equal(titleRequests.length, 5);
  assert.deepEqual(titleUpdates, [
    "Completion recovered intent",
    "Completion recovered intent - Verify deployment",
  ]);
});

test("useAutoTitleController rejects a remote manual rename outside blank-create ownership", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const createdSession = makeSession({
    title: "New Codex session",
    provider_resume: { provider: "codex", session_id: "fresh-session-id" },
  });
  const ownership = createdSessionAutoTitleState({
    createBody: { agent: "codex", title: "New Codex session" },
    createdSession,
    prompt: null,
    baseTitle: null,
    fallbackTitle: null,
  });
  assert.ok(ownership);
  window.localStorage.setItem(
    "agent-console.auto-title.states.v1",
    JSON.stringify({ "summit/hs-1": ownership }),
  );
  const renamedSession = { ...createdSession, title: "Manual remote title" };
  let summaries = 0;
  let patches = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [renamedSession], machines: [{ name: "summit", ok: true }] }),
    glance: async () => renamedSession,
    summarizeSessionTitle: async () => {
      summaries += 1;
      return { ok: true, title: "Unexpected title", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      patches += 1;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((session: Session, prompt: string, eventId?: string) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([renamedSession]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(renamedSession, "Fix startup retitle", "pp-after-remote-rename");
    await flushPromises();
  });
  assert.equal(summaries, 0);
  assert.equal(patches, 0);
});

test("useAutoTitleController does not claim a non-placeholder title without local ownership", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const session = makeSession({ title: "Manual remote title" });
  let summaries = 0;
  let patches = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    glance: async () => session,
    summarizeSessionTitle: async () => {
      summaries += 1;
      return { ok: true, title: "Unexpected title", source: "summarizer" };
    },
    updateSessionTitle: async () => {
      patches += 1;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((session: Session, prompt: string, eventId?: string) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "Do not claim this title", "pp-no-ownership");
    timers.advance(12_000);
    await flushPromises();
  });
  assert.equal(summaries, 0);
  assert.equal(patches, 0);
});

test("useAutoTitleController guards initial-summary writes against stale, late-manual, and PATCH failures", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const session = makeSession({ title: "New Codex session" });
  const key = "summit/hs-1";
  seedAutoTitleOwnership([key]);
  let liveTitle: string | null = "Manual remote title";
  let pendingList: ReturnType<typeof deferred<SessionsResponse>> | null = null;
  let patchOk = true;
  let pendingPatch: ReturnType<typeof deferred<{ ok: false; error: string }>> | null = null;
  let patches = 0;
  let refreshes = 0;
  const errors: string[] = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => pendingList?.promise ?? ({
      sessions: [{ ...session, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => null,
    summarizeSessionTitle: async (body) => ({ ok: true, title: body.prompt, source: "summarizer" }),
    updateSessionTitle: async () => {
      patches += 1;
      if (pendingPatch) {
        return pendingPatch.promise;
      }
      return patchOk ? { ok: true } : { ok: false, error: "title update failed" };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let updateAutoTitleStates:
    | ((updater: (prev: Record<string, { baseTitle: string | null; disabled: boolean; ownedTitle?: string | null }>) => Record<string, { baseTitle: string | null; disabled: boolean; ownedTitle?: string | null }>) => void)
    | null = null;
  let renderedSession = session;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    renderedSession = sessions[0] ?? session;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => {
        refreshes += 1;
      },
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: (value) => {
        if (typeof value === "string") errors.push(value);
      },
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    updateAutoTitleStates = controller.updateAutoTitleStates;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "stale remote guard", "pp-stale");
    await flushPromises();
  });
  assert.equal(patches, 0);

  liveTitle = session.title ?? null;
  pendingList = deferred<SessionsResponse>();
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "late manual guard", "pp-manual");
    await flushPromises();
  });
  await act(async () => {
    updateAutoTitleStates?.((prev) => ({
      ...prev,
      [key]: { baseTitle: null, disabled: true, ownedTitle: session.title ?? null },
    }));
    pendingList?.resolve({ sessions: [session], machines: [{ name: "summit", ok: true }] });
    pendingList = null;
    await flushPromises();
  });
  assert.equal(patches, 0);

  await act(async () => {
    updateAutoTitleStates?.((prev) => ({
      ...prev,
      [key]: { baseTitle: null, disabled: false, ownedTitle: session.title ?? null },
    }));
  });
  pendingPatch = deferred<{ ok: false; error: string }>();
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "failed patch guard", "pp-failed");
    await flushPromises();
  });
  assert.equal(renderedSession.title, "failed patch guard");
  await act(async () => {
    noteTurnPromptSubmitted?.(renderedSession, "prompt while patch pending", "pp-pending-window");
    await flushPromises();
  });
  assert.equal(JSON.parse(window.localStorage.getItem("agent-console.auto-title.states.v1") ?? "{}")[key].disabled, false);
  await act(async () => {
    pendingPatch?.resolve({ ok: false, error: "title update failed" });
    pendingPatch = null;
    await flushPromises();
  });
  assert.equal(patches, 1);
  assert.deepEqual(errors, ["title update failed"]);
  assert.equal(refreshes, 1);
  await act(async () => {
    noteTurnPromptSubmitted?.(renderedSession, "prompt after patch failure", "pp-after-failure");
    await flushPromises();
  });
  assert.equal(JSON.parse(window.localStorage.getItem("agent-console.auto-title.states.v1") ?? "{}")[key].disabled, false);
});

test("useAutoTitleController consumes only committed title transitions", async () => {
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const { shouldConsumeTitleTransition } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  const transition = {
    previousTitle: "Owned title",
    committedTitle: "Optimistic retitle",
    rebasePendingTitle: false,
  };
  assert.equal(shouldConsumeTitleTransition({ ...transition, committed: false }, "Owned title"), false);
  assert.equal(shouldConsumeTitleTransition({ ...transition, committed: true }, "Owned title"), true);
});

test("structured title writes are gated by explicit daemon capability, not by existing state", async () => {
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const { structuredTitleStateForSession } = await ssr.loadModule<
    typeof import("../src/useAutoTitleController.ts")
  >("/src/useAutoTitleController.ts");
  const persistedState = {
    topic: "Retitle rules",
    topic_source: "auto" as const,
    references: ["#317"],
    activity: null,
  };

  assert.equal(structuredTitleStateForSession(makeSession({ title_state: persistedState })), undefined);
  assert.deepEqual(structuredTitleStateForSession(makeSession({
    title: "User default",
    title_state_supported: true,
  })), {
    topic: "User default",
    topic_source: "user",
    references: [],
    activity: null,
  });
  assert.deepEqual(structuredTitleStateForSession(makeSession({
    title_state_supported: true,
    title_state: persistedState,
  })), persistedState);
});

test("useAutoTitleController hydrates daemon ownership for prompt and completion updates", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const automatic = {
    ...completedPlaceholderSession("auto"),
    title_state_supported: true,
    title_state: {
      topic: null,
      topic_source: "none",
      references: [],
      activity: "New Codex session",
    },
  } satisfies Session;
  const userOwned = makeSession({
    id: "user",
    title: "User default - Current activity",
    title_state_supported: true,
    title_state: {
      topic: "User default",
      topic_source: "user",
      references: [],
      activity: "Current activity",
    },
  });
  const sessions = [automatic, userOwned];
  const patches: Array<{
    readonly id: string;
    readonly title: string | null;
    readonly revision: number | undefined;
    readonly incarnation: string | undefined;
    readonly expectedTitle: string | null | undefined;
    readonly titleState: SessionTitleState | null | undefined;
  }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions, machines: [{ name: "summit", ok: true }] }),
    glance: async (_machine, id) => ({
      ...sessions.find((session) => session.id === id),
      tail: id === "auto" ? "Completed the hydration repair." : "Continue the hydration repair.",
    }),
    summarizeSessionTitle: async (body) => body.currentTitle === automatic.title
      ? {
          ok: true,
          title: "Hydrate ownership - Completed repair",
          titleState: {
            topic: "Hydrate ownership",
            topic_source: "auto",
            references: [],
            activity: "Completed repair",
          },
          source: "summarizer",
        }
      : {
          ok: true,
          title: "User default - Continue repair",
          titleState: {
            topic: "User default",
            topic_source: "user",
            references: [],
            activity: "Continue repair",
          },
          source: "summarizer",
        },
    updateSessionTitle: async (_machine, id, title, _signal, revision, incarnation, expectedTitle, titleState) => {
      patches.push({ id, title, revision, incarnation, expectedTitle, titleState });
      return { ok: true, titleRevision: (revision ?? 0) + 1 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((session: Session, prompt: string, eventId?: string) => void) | null = null;

  function Probe() {
    const [liveSessions, setSessions] = useState<Session[]>(sessions);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(liveSessions.map((session) => [`${session.machine}/${session.id}`, session])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(userOwned, "Continue the hydration repair", "pp-hydrated-user");
    timers.advance(12_000);
    await flushPromises();
  });

  assert.deepEqual(patches.sort((left, right) => left.id.localeCompare(right.id)), [
    {
      id: "auto",
      title: "Hydrate ownership - Completed repair",
      revision: 0,
      incarnation: "launch-hs-1",
      expectedTitle: "New Codex session",
      titleState: {
        topic: "Hydrate ownership",
        topic_source: "auto",
        references: [],
        activity: "Completed repair",
      },
    },
    {
      id: "user",
      title: "User default - Continue repair",
      revision: 0,
      incarnation: "launch-hs-1",
      expectedTitle: "User default - Current activity",
      titleState: {
        topic: "User default",
        topic_source: "user",
        references: [],
        activity: "Continue repair",
      },
    },
  ]);
});

test("useAutoTitleController retitles one missed-prompt completion and deduplicates later polls", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({
    title: "New Codex session",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "working",
      phase_changed_at: "2026-07-11T08:41:27Z",
      revision: 1,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      current_turn: { provider_turn_id: "turn-1", started_at: "2026-07-11T08:41:27Z" },
    },
  });
  seedAutoTitleOwnership(["summit/hs-1"]);
  let liveSession = session;
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [liveSession], machines: [{ name: "summit", ok: true }] }),
    glance: async () => ({
      title: liveSession.title,
      tail: "Implemented startup retitle recovery and verified the focused tests.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return { ok: true, title: "Startup retitle recovery", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveSession = { ...liveSession, title };
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    setProbeSessions = setSessions;
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  const completed = {
    ...session,
    turn_state: {
      ...session.turn_state,
      phase: "waiting",
      phase_changed_at: "2026-07-11T08:44:49Z",
      revision: 2,
      current_turn: null,
      last_turn: {
        provider_turn_id: "turn-1",
        started_at: "2026-07-11T08:41:27Z",
        completed_at: "2026-07-11T08:44:49Z",
        outcome: "completed",
      },
    },
  } satisfies Session;
  liveSession = completed;
  await act(async () => {
    setProbeSessions?.([completed]);
    await flushPromises();
  });

  assert.equal(titleRequests.length, 1);
  assert.equal(titleRequests[0]?.recentOutput, "Implemented startup retitle recovery and verified the focused tests.");
  assert.deepEqual(titleUpdates, ["Startup retitle recovery"]);

  await act(async () => {
    setProbeSessions?.([{ ...completed }]);
    setProbeSessions?.([{ ...completed }]);
    await flushPromises();
  });
  assert.equal(titleRequests.length, 1, "one authoritative completion must trigger at most one fallback");
  assert.equal(titleUpdates.length, 1);
});

test("useAutoTitleController leaves a manually owned placeholder unchanged on completion", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({
    title: "New Codex session",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "waiting",
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      last_turn: {
        provider_turn_id: "turn-manual",
        completed_at: "2026-07-11T08:44:49Z",
        outcome: "completed",
      },
    },
  });
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    glance: async () => assert.fail("manual ownership must skip glance"),
    summarizeSessionTitle: async () => assert.fail("manual ownership must skip summary"),
    updateSessionTitle: async () => assert.fail("manual ownership must skip title update"),
  };
  globalThis.localStorage = undefined;
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );

  window.localStorage.setItem(
    "agent-console.auto-title.states.v1",
    JSON.stringify({ "summit/hs-1": { baseTitle: "New Codex session", disabled: true } }),
  );

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
});

test("useAutoTitleController does not claim a remote placeholder without local automatic ownership", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const session = completedPlaceholderSession();
  let glanceCalls = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    glance: async () => {
      glanceCalls += 1;
      return null;
    },
    summarizeSessionTitle: async () => assert.fail("unowned placeholder must skip summary"),
    updateSessionTitle: async () => assert.fail("unowned placeholder must skip PATCH"),
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  assert.equal(glanceCalls, 0);
});

test("useAutoTitleController rejects future and nonterminal turn-state completions", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const completed = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let glanceCalls = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [completed], machines: [{ name: "summit", ok: true }] }),
    glance: async () => {
      glanceCalls += 1;
      return null;
    },
    summarizeSessionTitle: async () => assert.fail("invalid turn state must skip summary"),
    updateSessionTitle: async () => assert.fail("invalid turn state must skip PATCH"),
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([]);
    setProbeSessions = setSessions;
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    setProbeSessions?.([{
      ...completed,
      turn_state: { ...completed.turn_state!, schema_version: "agent-session.turn-state.v99" },
    }]);
    await flushPromises();
  });
  await act(async () => {
    setProbeSessions?.([{
      ...completed,
      turn_state: {
        ...completed.turn_state!,
        phase: "working",
        current_turn: { provider_turn_id: "turn-new", started_at: "2026-07-11T08:45:00Z" },
      },
    }]);
    await flushPromises();
  });
  assert.equal(glanceCalls, 0);
});

test("useAutoTitleController wakes one transient completion retry after backoff", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const session = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let glanceCalls = 0;
  const updates: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    glance: async () => {
      glanceCalls += 1;
      return glanceCalls === 1
        ? null
        : { ...session, tail: "Recovered completion context." };
    },
    summarizeSessionTitle: async () => ({ ok: true, title: "Recovered completion", source: "summarizer" }),
    updateSessionTitle: async (_machine, _id, title) => {
      updates.push(title);
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  await act(async () => {
    timers.advance(5_000);
    await flushPromises();
  });
  assert.equal(glanceCalls, 2);
  assert.deepEqual(updates, ["Recovered completion"]);
});

test("useAutoTitleController bounds a multi-session completion batch and shares its live list", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = ["hs-1", "hs-2", "hs-3"].map((id) => completedPlaceholderSession(id));
  const keys = sessions.map((session) => `${session.machine}/${session.id}`);
  seedAutoTitleOwnership(keys);
  let listCalls = 0;
  let activeSummaries = 0;
  let maxActiveSummaries = 0;
  const releases: Array<() => void> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => {
      listCalls += 1;
      return { sessions, machines: [{ name: "summit", ok: true }] };
    },
    glance: async (_machine, id) => ({
      ...sessions.find((session) => session.id === id)!,
      tail: `Completion context for ${id}`,
    }),
    summarizeSessionTitle: async () => new Promise((resolve) => {
      activeSummaries += 1;
      maxActiveSummaries = Math.max(maxActiveSummaries, activeSummaries);
      releases.push(() => {
        activeSummaries -= 1;
        resolve({ ok: true, title: "Completed batch item", source: "summarizer" });
      });
    }),
    updateSessionTitle: async () => ({ ok: true }),
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );

  function Probe() {
    const [currentSessions, setSessions] = useState<Session[]>(sessions);
    const options = {
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(currentSessions.map((item) => [`${item.machine}/${item.id}`, item])),
      liveSessionKeys: new Set(keys),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    };
    useAutoTitleController(options);
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  for (let cycle = 0; cycle < 4; cycle += 1) {
    const pending = releases.splice(0);
    await act(async () => {
      pending.forEach((release) => release());
      await flushPromises();
    });
  }
  assert.ok(maxActiveSummaries <= 2, `expected at most 2 active summaries, saw ${maxActiveSummaries}`);
  assert.equal(listCalls, 2);
});

test("useAutoTitleController retains in-flight completion state across a machine filter", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const session = completedPlaceholderSession();
  const key = "summit/hs-1";
  seedAutoTitleOwnership([key]);
  const glanceResult = deferred<unknown>();
  let glanceCalls = 0;
  let updates = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    glance: async () => {
      glanceCalls += 1;
      return glanceResult.promise;
    },
    summarizeSessionTitle: async () => ({ ok: true, title: "Filtered completion", source: "summarizer" }),
    updateSessionTitle: async () => {
      updates += 1;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );

  function Probe({ visible }: { readonly visible: boolean }) {
    const [currentSessions, setSessions] = useState<Session[]>([session]);
    const options = {
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(visible ? [[key, session] as const] : []),
      liveSessionKeys: new Set([key]),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    };
    void currentSessions;
    useAutoTitleController(options);
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe, { visible: true }));
    await flushPromises();
  });
  await act(async () => {
    mounted.root.render(createElement(Probe, { visible: false }));
    await flushPromises();
  });
  await act(async () => {
    mounted.root.render(createElement(Probe, { visible: true }));
    await flushPromises();
  });
  await act(async () => {
    glanceResult.resolve({ ...session, tail: "Filtered completion context" });
    await flushPromises();
  });
  assert.equal(glanceCalls, 1);
  assert.equal(updates, 1);
});

test("useAutoTitleController rechecks the live title after a slow completion summary", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const session = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let liveTitle: string | null = session.title ?? null;
  const summary = deferred<{ ok: true; title: string; source: "summarizer" }>();
  let updates = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({ ...session, title: liveTitle, tail: "Slow completion context" }),
    summarizeSessionTitle: async () => summary.promise,
    updateSessionTitle: async () => {
      updates += 1;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  liveTitle = "Manual remote title";
  await act(async () => {
    summary.resolve({ ok: true, title: "Stale automatic title", source: "summarizer" });
    await flushPromises();
  });
  assert.equal(updates, 0);
});

test("useAutoTitleController rejects a render-equivalent title-state change during completion summary", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const automatic = {
    ...completedPlaceholderSession(),
    title_state_supported: true,
    title_state: {
      topic: null,
      topic_source: "none",
      references: [],
      activity: "New Codex session",
    },
  } satisfies Session;
  const userOwned = {
    ...automatic,
    title_revision: (automatic.title_revision ?? 0) + 1,
    title_state: {
      topic: "New Codex session",
      topic_source: "user",
      references: [],
      activity: null,
    },
  } satisfies Session;
  seedAutoTitleOwnership(["summit/hs-1"]);
  const summary = deferred<{
    ok: true;
    title: string;
    titleState: NonNullable<Session["title_state"]>;
    source: "summarizer";
  }>();
  let liveSession: Session = automatic;
  let summaryRequests = 0;
  let updates = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [liveSession],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({ ...liveSession, tail: "Slow completion context" }),
    summarizeSessionTitle: async () => {
      summaryRequests += 1;
      return summary.promise;
    },
    updateSessionTitle: async () => {
      updates += 1;
      return { ok: true, titleRevision: userOwned.title_revision + 1 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([automatic]);
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    for (let attempt = 0; attempt < 10 && summaryRequests === 0; attempt += 1) {
      await flushPromises();
    }
  });
  assert.equal(summaryRequests, 1);
  liveSession = userOwned;
  await act(async () => {
    summary.resolve({
      ok: true,
      title: "Completion topic - Implement contract",
      titleState: {
        topic: "Completion topic",
        topic_source: "auto",
        references: [],
        activity: "Implement contract",
      },
      source: "summarizer",
    });
    await flushPromises();
  });

  assert.equal(updates, 0);
});

test("useAutoTitleController revalidates completion identity at batch admission", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const candidate = completedPlaceholderSession();
  const working = {
    ...candidate,
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "working",
      phase_changed_at: "2026-07-11T08:45:00Z",
      revision: 3,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      current_turn: { provider_turn_id: "new-turn", started_at: "2026-07-11T08:45:00Z" },
      last_turn: candidate.turn_state?.last_turn,
    },
  } satisfies Session;
  seedAutoTitleOwnership(["summit/hs-1"]);
  let glanceCalls = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [working], machines: [{ name: "summit", ok: true }] }),
    glance: async () => {
      glanceCalls += 1;
      return null;
    },
    summarizeSessionTitle: async () => assert.fail("superseded completion must skip summary"),
    updateSessionTitle: async () => assert.fail("superseded completion must skip PATCH"),
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([candidate]);
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  assert.equal(glanceCalls, 0);
});

test("useAutoTitleController retries completion recovery after machine unavailability", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const session = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let reachable = false;
  let updates = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => reachable
      ? { sessions: [session], machines: [{ name: "summit", ok: true }] }
      : { sessions: [], machines: [{ name: "summit", ok: false, error: "offline" }] },
    glance: async () => ({ ...session, tail: "Recovered after reconnect" }),
    summarizeSessionTitle: async () => ({ ok: true, title: "Recovered after reconnect", source: "summarizer" }),
    updateSessionTitle: async () => {
      updates += 1;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    setProbeSessions = setSessions;
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  reachable = true;
  timers.advance(5_000);
  await act(async () => {
    setProbeSessions?.([{ ...session }]);
    await flushPromises();
  });
  assert.equal(updates, 1);
});

test("useAutoTitleController retries completion recovery after an aggregate error envelope", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);
  const session = completedPlaceholderSession();
  seedAutoTitleOwnership(["summit/hs-1"]);
  let reachable = false;
  let updates = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => reachable
      ? { ok: true, sessions: [session], machines: [{ name: "summit", ok: true }] }
      : { ok: false, sessions: [], machines: [] },
    glance: async () => ({ ...session, tail: "Recovered after aggregate failure" }),
    summarizeSessionTitle: async () => ({ ok: true, title: "Recovered aggregate failure", source: "summarizer" }),
    updateSessionTitle: async () => {
      updates += 1;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    setProbeSessions = setSessions;
    useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  reachable = true;
  timers.advance(5_000);
  await act(async () => {
    setProbeSessions?.([{ ...session }]);
    await flushPromises();
  });
  assert.equal(updates, 1);
});

test("useAutoTitleController applies a create summary from the create-response CAS snapshot before rerender", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const initialTitleState = {
    topic: null,
    topic_source: "none" as const,
    references: [],
    activity: null,
  };
  const summarizedTitleState = {
    topic: "Agent runtime kit",
    topic_source: "auto" as const,
    references: ["#657"],
    activity: "Handle issue",
  };
  const createdSession = makeSession({
    title: "New Codex session",
    title_state: initialTitleState,
    title_state_supported: true,
    title_revision: 0,
    session_incarnation: "created-657-incarnation",
  });
  const updates: Array<{
    title: string | null;
    expectedRevision: number | undefined;
    expectedIncarnation: string | undefined;
    expectedTitle: string | null | undefined;
    titleState: SessionTitleState | null | undefined;
  }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [createdSession],
      machines: [{ name: "summit", ok: true }],
    }),
    summarizeSessionTitle: async () => ({
      ok: true,
      title: "Agent runtime kit #657 - Handle issue",
      titleState: summarizedTitleState,
      source: "summarizer",
    }),
    updateSessionTitle: async (
      _machine,
      _id,
      title,
      _signal,
      expectedRevision,
      expectedIncarnation,
      expectedTitle,
      titleState,
    ) => {
      updates.push({ title, expectedRevision, expectedIncarnation, expectedTitle, titleState });
      return { ok: true, titleRevision: updates.length };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary:
    | ((session: Session, prompt: string, baseTitle: string | null, fallbackTitle: string) => Promise<void>)
    | null = null;
  let updateManualSessionTitle:
    | ((session: Session, title: string | null) => Promise<unknown>)
    | null = null;
  const liveSessionKeys = new Set(["summit/hs-1"]);

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      liveSessionKeys,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    updateManualSessionTitle = controller.updateManualSessionTitle;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  await act(async () => {
    await applyCreatePromptSummary?.(
      createdSession,
      "Handle agent runtime kit issue #657",
      null,
      "Handle agent runtime kit issue #657",
    );
  });

  assert.deepEqual(updates, [{
    title: "Agent runtime kit #657 - Handle issue",
    expectedRevision: 0,
    expectedIncarnation: "created-657-incarnation",
    expectedTitle: "New Codex session",
    titleState: summarizedTitleState,
  }]);

  await act(async () => {
    await updateManualSessionTitle?.({
      ...createdSession,
      title: "Agent runtime kit #657 - Handle issue",
      title_state: summarizedTitleState,
      title_revision: 1,
    }, "Manual title");
  });
  assert.equal(updates[1]?.expectedRevision, 1);
});

test("useAutoTitleController replaces late pre-render title CAS state when a new incarnation first renders", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const initialTitleState: SessionTitleState = {
    topic: null,
    topic_source: "none",
    references: [],
    activity: null,
  };
  const summarizedTitleState: SessionTitleState = {
    topic: "Issue #359",
    topic_source: "auto",
    references: ["#359"],
    activity: "Initialize Codex session",
  };
  const incarnationA = makeSession({
    title: "New Codex session",
    title_state: initialTitleState,
    title_state_supported: true,
    session_incarnation: "incarnation-a",
    title_revision: 0,
  });
  const incarnationB = makeSession({
    title: "Replacement session",
    title_state: initialTitleState,
    title_state_supported: true,
    session_incarnation: "incarnation-b",
    title_revision: 0,
    created_at: "2026-07-08T00:01:00Z",
  });
  const firstPatch = deferred<{ ok: true; titleRevision: number }>();
  let listedSession = incarnationA;
  const updates: Array<{
    expectedRevision: number | undefined;
    expectedIncarnation: string | undefined;
  }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [listedSession],
      machines: [{ name: "summit", ok: true }],
    }),
    summarizeSessionTitle: async () => ({
      ok: true,
      title: "Issue #359 - Initialize Codex session",
      titleState: summarizedTitleState,
      source: "summarizer",
    }),
    updateSessionTitle: async (
      _machine,
      _id,
      _title,
      _signal,
      expectedRevision,
      expectedIncarnation,
    ) => {
      updates.push({ expectedRevision, expectedIncarnation });
      return updates.length === 1
        ? firstPatch.promise
        : { ok: true, titleRevision: 8 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary:
    | ((session: Session, prompt: string, baseTitle: string | null, fallbackTitle: string) => Promise<void>)
    | null = null;
  let updateManualSessionTitle:
    | ((session: Session, title: string | null) => Promise<unknown>)
    | null = null;
  let renderSessions: ((sessions: Session[]) => void) | null = null;
  const liveSessionKeys = new Set(["summit/hs-1"]);

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([]);
    renderSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      liveSessionKeys,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    updateManualSessionTitle = controller.updateManualSessionTitle;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  let createSummary: Promise<void> | undefined;
  await act(async () => {
    createSummary = applyCreatePromptSummary?.(
      incarnationA,
      "Initialize the Codex session for issue #359",
      null,
      "Initialize the Codex session for issue #359",
    );
    await flushPromises();
  });
  assert.deepEqual(updates, [{ expectedRevision: 0, expectedIncarnation: "incarnation-a" }]);

  await act(async () => {
    firstPatch.resolve({ ok: true, titleRevision: 1 });
    await createSummary;
  });
  await act(async () => {
    listedSession = incarnationB;
    renderSessions?.([incarnationB]);
    await flushPromises();
  });
  await act(async () => {
    await updateManualSessionTitle?.(incarnationB, "Replacement manual title");
  });

  assert.deepEqual(updates[1], {
    expectedRevision: 0,
    expectedIncarnation: "incarnation-b",
  });
});

test("useAutoTitleController supersedes a pending create PATCH when a replacement first renders", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const initialTitleState: SessionTitleState = {
    topic: null,
    topic_source: "none",
    references: [],
    activity: null,
  };
  const summarizedTitleState: SessionTitleState = {
    topic: "Issue #359",
    topic_source: "auto",
    references: ["#359"],
    activity: "Initialize Codex session",
  };
  const incarnationA = makeSession({
    title: "New Codex session",
    title_state: initialTitleState,
    title_state_supported: true,
    session_incarnation: "pending-incarnation-a",
    title_revision: 0,
    created_at: "2026-07-08T00:00:00Z",
  });
  const incarnationB = makeSession({
    title: "Replacement session",
    title_state: initialTitleState,
    title_state_supported: true,
    session_incarnation: "pending-incarnation-b",
    title_revision: 0,
    created_at: "2026-07-08T00:01:00Z",
  });
  const summarizedTitle = "Issue #359 - Initialize Codex session";
  const pendingPatch = deferred<{ ok: true; titleRevision: number }>();
  const updates: Array<{
    readonly expectedRevision: number | undefined;
    readonly expectedIncarnation: string | undefined;
  }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [incarnationA],
      machines: [{ name: "summit", ok: true }],
    }),
    summarizeSessionTitle: async () => ({
      ok: true,
      title: summarizedTitle,
      titleState: summarizedTitleState,
      source: "summarizer",
    }),
    updateSessionTitle: async (
      _machine,
      _id,
      _title,
      _signal,
      expectedRevision,
      expectedIncarnation,
    ) => {
      updates.push({ expectedRevision, expectedIncarnation });
      return pendingPatch.promise;
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary:
    | ((session: Session, prompt: string, baseTitle: string | null, fallbackTitle: string) => Promise<void>)
    | null = null;
  let renderSessions: ((sessions: Session[]) => void) | null = null;
  const key = "summit/hs-1";

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([]);
    renderSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      liveSessionKeys: new Set([key]),
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  let createSummary: Promise<void> | undefined;
  await act(async () => {
    createSummary = applyCreatePromptSummary?.(
      incarnationA,
      "Initialize the Codex session for issue #359",
      null,
      "Initialize the Codex session for issue #359",
    );
    await flushPromises();
  });
  assert.deepEqual(updates, [{
    expectedRevision: 0,
    expectedIncarnation: "pending-incarnation-a",
  }]);
  await act(async () => {
    renderSessions?.([incarnationB]);
    await flushPromises();
  });
  await act(async () => {
    pendingPatch.resolve({ ok: true, titleRevision: 1 });
    await createSummary;
    await flushPromises();
  });

  const stored = JSON.parse(
    window.localStorage.getItem("agent-console.auto-title.states.v1") ?? "{}",
  ) as Record<string, { readonly ownedTitle?: string | null }>;
  assert.equal(stored[key]?.ownedTitle, incarnationB.title);
});

test("useAutoTitleController fences batched optimistic create title writes from replacement incarnations", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const initialTitleState: SessionTitleState = {
    topic: null,
    topic_source: "none",
    references: [],
    activity: null,
  };
  const summarizedTitleState: SessionTitleState = {
    topic: "Issue #359",
    topic_source: "auto",
    references: ["#359"],
    activity: "Initialize Codex session",
  };
  const incarnationA = makeSession({
    title: "New Codex session",
    title_state: initialTitleState,
    title_state_supported: true,
    session_incarnation: "batched-incarnation-a",
    title_revision: 0,
    created_at: "2026-07-08T00:00:00Z",
  });
  const incarnationB = makeSession({
    title: "Replacement session",
    title_state: initialTitleState,
    title_state_supported: true,
    session_incarnation: "batched-incarnation-b",
    title_revision: 0,
    created_at: "2026-07-08T00:01:00Z",
  });
  const summary = deferred<{
    readonly ok: true;
    readonly title: string;
    readonly titleState: SessionTitleState;
    readonly source: "summarizer";
  }>();
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [incarnationA],
      machines: [{ name: "summit", ok: true }],
    }),
    summarizeSessionTitle: async () => summary.promise,
    updateSessionTitle: async () => ({ ok: true, titleRevision: 1 }),
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary:
    | ((session: Session, prompt: string, baseTitle: string | null, fallbackTitle: string) => Promise<void>)
    | null = null;
  let renderSessions: ((sessions: Session[]) => void) | null = null;
  let observedSessions: readonly Session[] = [];
  const key = "summit/hs-1";

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([]);
    observedSessions = sessions;
    renderSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      liveSessionKeys: new Set([key]),
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  let createSummary: Promise<void> | undefined;
  await act(async () => {
    createSummary = applyCreatePromptSummary?.(
      incarnationA,
      "Initialize the Codex session for issue #359",
      null,
      "Initialize the Codex session for issue #359",
    );
    await flushPromises();
  });
  await act(async () => {
    renderSessions?.([incarnationB]);
    summary.resolve({
      ok: true,
      title: "Issue #359 - Initialize Codex session",
      titleState: summarizedTitleState,
      source: "summarizer",
    });
    await createSummary;
    await flushPromises();
  });

  assert.equal(observedSessions[0]?.session_incarnation, incarnationB.session_incarnation);
  assert.equal(observedSessions[0]?.title, incarnationB.title);
  assert.deepEqual(observedSessions[0]?.title_state, incarnationB.title_state);
  assert.equal(observedSessions[0]?.title_revision, incarnationB.title_revision);
});

test("useAutoTitleController rejects create title work for an already rendered replacement incarnation", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const capturedTitleState: SessionTitleState = {
    topic: "Captured topic",
    topic_source: "auto",
    references: [],
    activity: null,
  };
  const renderedTitleState: SessionTitleState = {
    topic: "Rendered topic",
    topic_source: "auto",
    references: ["#359"],
    activity: null,
  };
  const summarizedTitleState: SessionTitleState = {
    ...renderedTitleState,
    activity: "Initialize Codex session",
  };
  const capturedSession = makeSession({
    title: "New Codex session",
    title_state: capturedTitleState,
    title_state_supported: true,
    session_incarnation: "captured-incarnation",
    title_revision: 0,
    created_at: "2026-07-08T00:00:00Z",
  });
  const renderedSession = makeSession({
    title: "New Codex session",
    title_state: renderedTitleState,
    title_state_supported: true,
    session_incarnation: "rendered-incarnation",
    title_revision: 7,
    created_at: "2026-07-08T00:01:00Z",
  });
  const summaryRequests: TitleSummaryRequest[] = [];
  const updates: Array<{
    expectedRevision: number | undefined;
    expectedIncarnation: string | undefined;
    expectedTitle: string | null | undefined;
  }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      ok: true,
      sessions: [renderedSession],
      machines: [{ name: "summit", ok: true }],
    }),
    summarizeSessionTitle: async (body) => {
      summaryRequests.push(body);
      return {
        ok: true,
        title: "Rendered topic #359 - Initialize Codex session",
        titleState: summarizedTitleState,
        source: "summarizer",
      };
    },
    updateSessionTitle: async (
      _machine,
      _id,
      _title,
      _signal,
      expectedRevision,
      expectedIncarnation,
      expectedTitle,
    ) => {
      updates.push({ expectedRevision, expectedIncarnation, expectedTitle });
      return { ok: true, titleRevision: 8 };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary:
    | ((session: Session, prompt: string, baseTitle: string | null, fallbackTitle: string) => Promise<void>)
    | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([renderedSession]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      liveSessionKeys: new Set(["summit/hs-1"]),
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  await act(async () => {
    await applyCreatePromptSummary?.(
      capturedSession,
      "Initialize the Codex session for issue #359",
      null,
      "Initialize the Codex session for issue #359",
    );
  });

  assert.deepEqual(summaryRequests, []);
  assert.deepEqual(updates, []);
});

test("useAutoTitleController carries the resolved create intent into later turn titles", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const createdSession = makeSession({ title: "New Codex session" });
  let liveTitle = createdSession.title;
  const titleRequests: TitleSummaryRequest[] = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...createdSession, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "Review threads are being resolved.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return titleRequests.length === 1
        ? { ok: true, title: "PR #23", source: "summarizer" }
        : { ok: true, title: "PR #23 - Resolving review threads", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary:
    | ((session: Session, prompt: string, baseTitle: string | null, fallbackTitle: string) => Promise<void>)
    | null = null;
  let noteTurnPromptSubmitted: ((session: Session, prompt: string, eventId?: string) => void) | null = null;
  const applyLiveSessionList = () => undefined;
  const enabledMachinesRef = { current: ["summit"] };
  const liveRef = { current: true };
  const setError = () => undefined;
  const setRetitleFeedback = () => undefined;
  const showRetitleFeedback = () => undefined;
  const activeTerminalSlotKey = () => null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([createdSession]);
    const controller = useAutoTitleController({
      applyLiveSessionList,
      enabledMachinesRef,
      focusedKey: null,
      liveRef,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError,
      setRetitleFeedback,
      setSessions,
      showRetitleFeedback,
      activeTerminalSlotKey,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    await applyCreatePromptSummary?.(createdSession, "pr:deliver-pr 23", null, "pr:deliver-pr 23");
  });
  assert.equal(liveTitle, "PR #23");

  await act(async () => {
    noteTurnPromptSubmitted?.({ ...createdSession, title: liveTitle }, "resolve review threads", "pp-turn-2");
    timers.advance(12_000);
    await flushPromises();
  });

  assert.deepEqual(withoutTitleSummaryTrace(titleRequests), [
    { baseTitle: null, prompt: "pr:deliver-pr 23" },
    {
      baseTitle: "PR #23",
      prompt: "resolve review threads",
      currentTitle: "PR #23",
      recentOutput: "Review threads are being resolved.",
      agent: "codex",
      repoName: "agent-console",
    },
  ]);
  assert.equal(liveTitle, "PR #23 - Resolving review threads");
});

test("useAutoTitleController retries a failed create summary before replaying a later prompt", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const createdSession = makeSession({ title: "New Codex session" });
  const completed = completedPlaceholderSession();
  let liveTitle = createdSession.title;
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...completed, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "The queued deployment is ready.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      if (titleRequests.length === 1) {
        return { ok: true, title: body.prompt, source: "fallback" };
      }
      if (titleRequests.length === 2) {
        return { ok: true, title: "Repair first prompt title", source: "summarizer" };
      }
      return { ok: true, title: "Repair first prompt title - Deploy verified fix", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary:
    | ((session: Session, prompt: string, baseTitle: string | null, fallbackTitle: string) => Promise<void>)
    | null = null;
  let noteTurnPromptSubmitted: ((session: Session, prompt: string, eventId?: string) => void) | null = null;
  let setProbeSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([createdSession]);
    setProbeSessions = setSessions;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    await applyCreatePromptSummary?.(
      createdSession,
      "Repair the first prompt title",
      null,
      "Repair the first prompt title",
    );
    noteTurnPromptSubmitted?.(createdSession, "Deploy the verified fix", "pp-create-later");
    setProbeSessions?.([completed]);
    await flushPromises();
  });
  await act(async () => {
    timers.advance(5_000);
    await flushPromises();
    await flushPromises();
    await flushPromises();
  });
  assert.equal(titleRequests.length, 2);
  assert.ok(timers.timers.some((timer) => !timer.cleared && timer.delayMs === 12_000));
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.deepEqual(titleRequests.map((request) => request.prompt), [
    "Repair the first prompt title",
    "Repair the first prompt title",
    "Deploy the verified fix",
  ]);
  assert.deepEqual(titleUpdates, [
    "Repair first prompt title",
    "Repair first prompt title - Deploy verified fix",
  ]);
});

test("useAutoTitleController retries a failed create summary while the first turn is still active", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const createdSession = makeSession({ title: "New Codex session" });
  let liveTitle = createdSession.title;
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...createdSession, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return titleRequests.length === 1
        ? { ok: true, title: body.prompt, source: "fallback" }
        : { ok: true, title: "Repair first prompt title", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary:
    | ((session: Session, prompt: string, baseTitle: string | null, fallbackTitle: string) => Promise<void>)
    | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([createdSession]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    await applyCreatePromptSummary?.(
      createdSession,
      "Repair the first prompt title",
      null,
      "Repair the first prompt title",
    );
    await flushPromises();
  });
  assert.equal(titleRequests.length, 1);
  assert.deepEqual(titleUpdates, []);

  await act(async () => {
    timers.advance(4_999);
    await flushPromises();
  });
  assert.equal(titleRequests.length, 1, "the retry must not run before its bounded backoff");

  await act(async () => {
    timers.advance(1);
    await flushPromises();
    await flushPromises();
  });

  assert.equal(titleRequests.length, 2);
  assert.equal(titleRequests[0]?.trace?.attemptId, titleRequests[1]?.trace?.attemptId);
  assert.deepEqual(titleRequests.map((request) => request.trace?.attempt), [1, 2]);
  assert.deepEqual(titleUpdates, ["Repair first prompt title"]);
});

test("useAutoTitleController replaces a persisted legacy prompt anchor with the first confirmed manual retitle", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const firstPrompt = "Evaluate whether search supports PR issue numbers";
  const createdSession = makeSession({ title: firstPrompt });
  let liveTitle = createdSession.title;
  const titleRequests: TitleSummaryRequest[] = [];
  window.localStorage.setItem(
    "agent-console.auto-title.states.v1",
    JSON.stringify({
      "summit/hs-1": {
        baseTitle: firstPrompt,
        disabled: false,
        ownedTitle: firstPrompt,
      },
    }),
  );
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...createdSession, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "Retitle should reflect the current implementation work.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return titleRequests.length === 1
        ? { ok: true, title: "Repair retitle flow", source: "summarizer" }
        : { ok: true, title: "Repair retitle flow - Verify deployment", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let retitleSession: ((session: Session) => Promise<void>) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([createdSession]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    retitleSession = controller.retitleSession;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    await retitleSession?.({ ...createdSession, title: liveTitle });
  });
  await act(async () => {
    await retitleSession?.({ ...createdSession, title: liveTitle });
  });

  assert.equal(titleRequests.length, 2);
  assert.equal(titleRequests[0]?.baseTitle, null);
  assert.equal(titleRequests[1]?.baseTitle, "Repair retitle flow");
  assert.equal(liveTitle, "Repair retitle flow - Verify deployment");
});

test("useAutoTitleController does not infer an intent anchor from a legacy display title", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "Review auth module - Finding bugs" });
  const titleRequests: TitleSummaryRequest[] = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    glance: async () => ({
      title: session.title,
      tail: "No title change is needed.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return { ok: true, title: session.title, source: "summarizer" };
    },
    updateSessionTitle: async () => ({ ok: true }),
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  let retitleSession: ((nextSession: Session) => Promise<void>) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    retitleSession = controller.retitleSession;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    await retitleSession?.(session);
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "inspect validation paths", "pp-turn-recovered");
    timers.advance(12_000);
    await flushPromises();
  });

  assert.equal(titleRequests.length, 1);
  assert.equal(titleRequests[0]?.baseTitle, null);
});

test("useAutoTitleController leaves all automatic v2 scheduling to the daemon", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({
    title: "Existing topic",
    retitle_path: "daemon_v2",
    title_state_supported: true,
    title_state: { topic: "Existing topic", topic_source: "auto", references: [], activity: null },
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "waiting",
      phase_changed_at: "2026-07-08T00:02:00Z",
      revision: 4,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      last_turn: {
        provider_turn_id: "turn-1",
        completed_at: "2026-07-08T00:02:00Z",
        outcome: "completed",
      },
    },
  });
  let glanceCalls = 0;
  let summaryCalls = 0;
  let patchCalls = 0;
  let retitleCalls = 0;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    glance: async () => { glanceCalls += 1; return null; },
    summarizeSessionTitle: async () => { summaryCalls += 1; return { ok: false }; },
    updateSessionTitle: async () => { patchCalls += 1; return { ok: false }; },
    fetchSessionRetitleReadiness: async () => { throw new Error("automatic path must not inspect readiness"); },
    requestSessionRetitle: async () => { retitleCalls += 1; return { ok: false }; },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary: ((session: Session, prompt: string, base: string | null, fallback: string) => Promise<void>) | null = null;
  let noteTurnPromptSubmitted: ((session: Session, prompt: string, eventId?: string) => void) | null = null;
  let noteTurnOutput: ((session: Session) => void) | null = null;
  let replaceSessions: ((sessions: Session[]) => void) | null = null;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([{
      ...session,
      retitle_path: "legacy_edge",
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "working",
        phase_changed_at: "2026-07-08T00:01:00Z",
        revision: 3,
        source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      },
    }]);
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: () => undefined,
      setRetitleFeedback: () => undefined,
      setSessions,
      showRetitleFeedback: () => undefined,
      activeTerminalSlotKey: () => null,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    noteTurnOutput = controller.noteTurnOutput;
    replaceSessions = setSessions;
    return null;
  }

  await act(async () => { mounted.root.render(createElement(Probe)); await flushPromises(); });
  await act(async () => {
    noteTurnPromptSubmitted?.({ ...session, retitle_path: "legacy_edge" }, "queued legacy prompt", "event-1");
    replaceSessions?.([session]);
    await flushPromises();
  });
  await act(async () => {
    await applyCreatePromptSummary?.(session, "private initial prompt", null, "private initial prompt");
    noteTurnPromptSubmitted?.(session, "private later prompt", "event-2");
    noteTurnOutput?.(session);
    timers.advance(12_000);
    await flushPromises();
  });

  assert.deepEqual({ glanceCalls, summaryCalls, patchCalls, retitleCalls }, {
    glanceCalls: 0,
    summaryCalls: 0,
    patchCalls: 0,
    retitleCalls: 0,
  });
});

test("useAutoTitleController routes degraded manual v2 retitle with visible status and no browser context", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({
    title: "Wrong topic",
    retitle_path: "daemon_v2",
    title_state_supported: true,
    title_state: { topic: "Wrong topic", topic_source: "auto", references: [], activity: null },
    title_revision: 7,
  });
  const requests: SessionRetitleRequest[] = [];
  const feedback: string[] = [];
  const errors: Array<string | null> = [];
  let glanceCalls = 0;
  let summaryCalls = 0;
  let readinessUnavailable = false;
  const result: SessionRetitleResult = {
    schema_version: "agent-session.session-retitle.v2",
    outcome: "committed",
    changed: true,
    trigger: "manual",
    provider_kind: "codex_subscription",
    diagnostic_code: "accepted",
    coverage: { source: "provider_transcript", complete: true, truncated: false, turn_count: 8 },
    session: {
      title: "Durable retitle context - Verify fallback",
      title_state: {
        topic: "Durable retitle context",
        topic_source: "auto",
        references: [],
        activity: "Verify fallback",
      },
      title_revision: 8,
      session_incarnation: "launch-hs-1",
    },
  };
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    glance: async () => { glanceCalls += 1; return null; },
    summarizeSessionTitle: async () => { summaryCalls += 1; return { ok: false }; },
    updateSessionTitle: async () => ({ ok: false }),
    fetchSessionRetitleReadiness: async () => readinessUnavailable
      ? {
          ok: true,
          readiness: {
            schema_version: "agent-session.session-retitle.readiness.v2",
            capability: "agent-session.session-retitle.v2",
            status: "unavailable",
            reason_code: "account_missing",
            next_action: "select_account",
            context_capabilities: {
              codex: "provider_transcript",
              claude: "provider_transcript",
            },
          },
        }
      : {
          ok: true,
          readiness: {
            schema_version: "agent-session.session-retitle.readiness.v2",
            capability: "agent-session.session-retitle.v2",
            status: "degraded",
            reason_code: "legacy_command_provider",
            next_action: "migrate_provider",
            provider_kind: "command",
            context_capabilities: {
              codex: "provider_transcript",
              claude: "provider_transcript",
            },
          },
        },
    requestSessionRetitle: async (_machine, _id, request) => {
      requests.push(request);
      return { ok: true, retitle: result };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let retitleSession: ((session: Session) => Promise<void>) | null = null;
  let renderedTitle: string | null | undefined = session.title;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    renderedTitle = sessions[0]?.title;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: (value) => errors.push(typeof value === "function" ? value(null) : value),
      setRetitleFeedback: (value) => feedback.push(value.state),
      setSessions,
      showRetitleFeedback: (value) => feedback.push(value.state),
      activeTerminalSlotKey: () => null,
    });
    retitleSession = controller.retitleSession;
    return null;
  }

  await act(async () => { mounted.root.render(createElement(Probe)); });
  await act(async () => { await retitleSession?.(session); await flushPromises(); });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.trigger, "manual");
  assert.equal(JSON.stringify(requests[0]).includes("prompt"), false);
  assert.equal(renderedTitle, "Durable retitle context - Verify fallback");
  assert.deepEqual({ glanceCalls, summaryCalls }, { glanceCalls: 0, summaryCalls: 0 });
  assert.ok(feedback.includes("working"));
  assert.ok(feedback.includes("updated"));
  assert.deepEqual(errors, ["Retitle is using the legacy command provider. Migrate the host when convenient."]);

  readinessUnavailable = true;
  await act(async () => { await retitleSession?.({ ...session, title_revision: 8 }); await flushPromises(); });
  assert.equal(requests.length, 1);
  assert.ok(feedback.includes("failed"));
  assert.equal(errors.at(-1), "Retitle account is unavailable. Select or configure an account on the host.");
});

test("useAutoTitleController reconciles accepted v3 work and distinguishes committed from degraded cache", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({
    title: "Old semantic title",
    retitle_path: "daemon_v3",
    title_revision: 2,
  });
  const operationHash = `sha256:${"b".repeat(64)}`;
  const feedback: string[] = [];
  const errors: Array<string | null> = [];
  const requests: SessionRetitleV3Request[] = [];
  let scenario: "accepted" | "degraded" = "accepted";
  const responseBase = {
    schema_version: "agent-session.session-retitle.v3",
    capability: "agent-session.session-retitle.v3",
    provider_attempts: [],
    operation_hash: operationHash,
    session_incarnation: "launch-hs-1",
    readiness: "ready",
    admission_fence: { session_incarnation: "launch-hs-1", title_revision: 2, memory_revision: 8 },
    current_fence: { session_incarnation: "launch-hs-1", title_revision: 2, memory_revision: 8 },
    result_is_current: true,
    started_at: "2026-09-10T00:00:00Z",
    duration_bucket: "50_249_ms",
  } as const;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({ sessions: [session], machines: [{ name: "summit", ok: true }] }),
    fetchSessionRetitleV3Readiness: async () => ({
      ok: true,
      readiness: {
        schema_version: "agent-session.session-retitle.readiness.v3",
        capability: "agent-session.session-retitle.v3",
        status: "ready",
        provider_status: "ready",
        context_status: "ready",
        title_status: "current",
        reason_code: "ready",
        next_action: "none",
        memory_revision: 8,
        usable_memory: true,
        pending_operation: false,
      },
    }),
    requestSessionRetitleV3: async (_machine, _id, request) => {
      requests.push(request);
      if (scenario === "degraded") {
        return {
          ok: true,
          retitle: {
            ...responseBase,
            status: "terminal",
            outcome: "degraded_cached",
            changed: false,
            memory_revision: 8,
            title_revision: 3,
            title: "Committed semantic title",
            readiness: "degraded",
            result_fence: { session_incarnation: "launch-hs-1", title_revision: 3, memory_revision: 8 },
            current_fence: { session_incarnation: "launch-hs-1", title_revision: 3, memory_revision: 8 },
            finished_at: "2026-09-10T00:00:02Z",
          },
        };
      }
      return { ok: true, retitle: { ...responseBase, status: "accepted", memory_revision: 8, title_revision: 2 } };
    },
    fetchSessionRetitleV3Operation: async () => ({
      ok: true,
      retitle: {
        ...responseBase,
        status: "terminal",
        outcome: "committed",
        changed: true,
        memory_revision: 9,
        title_revision: 3,
        title: "Committed semantic title",
        result_fence: { session_incarnation: "launch-hs-1", title_revision: 3, memory_revision: 9 },
        current_fence: { session_incarnation: "launch-hs-1", title_revision: 3, memory_revision: 9 },
        finished_at: "2026-09-10T00:00:01Z",
      },
    }),
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let retitleSession: ((session: Session) => Promise<void>) | null = null;
  let renderedTitle: string | null | undefined = session.title;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    renderedTitle = sessions[0]?.title;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: (value) => errors.push(typeof value === "function" ? value(null) : value),
      setRetitleFeedback: (value) => feedback.push(value.state),
      setSessions,
      showRetitleFeedback: (value) => feedback.push(value.state),
      activeTerminalSlotKey: () => null,
    });
    retitleSession = controller.retitleSession;
    return null;
  }

  await act(async () => { mounted.root.render(createElement(Probe)); });
  let pending: Promise<void> | undefined;
  await act(async () => {
    pending = retitleSession?.(session);
    await flushPromises();
    timers.advance(500);
    await pending;
    await flushPromises();
  });
  assert.equal(renderedTitle, "Committed semantic title");
  assert.ok(feedback.includes("updating"));
  assert.ok(feedback.includes("committed"));
  assert.equal(JSON.stringify(requests[0]).includes("prompt"), false);

  scenario = "degraded";
  feedback.length = 0;
  await act(async () => { await retitleSession?.({ ...session, title: "Committed semantic title" }); });
  assert.ok(feedback.includes("degraded_cached"));
  assert.equal(errors.at(-1), "Retitle refresh is degraded; the existing cached title was preserved.");
});

test("useAutoTitleController bounds stale-revision retries and preserves the session incarnation fence", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const stale = makeSession({
    title: "Old automatic title",
    retitle_path: "daemon_v2",
    title_state_supported: true,
    title_state: { topic: "Old automatic title", topic_source: "auto", references: [], activity: null },
    title_revision: 7,
  });
  const fresh = makeSession({
    ...stale,
    title: "New automatic title",
    title_state: { topic: "New automatic title", topic_source: "auto", references: [], activity: null },
    title_revision: 8,
  });
  const requests: SessionRetitleRequest[] = [];
  const feedback: string[] = [];
  const errors: Array<string | null> = [];
  let listCalls = 0;
  let scenario: "recover" | "bounded" | "new-incarnation" = "recover";
  let refreshedSession = fresh;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => {
      listCalls += 1;
      return { sessions: [refreshedSession], machines: [{ name: "summit", ok: true }] };
    },
    fetchSessionRetitleReadiness: async () => ({
      ok: true,
      readiness: {
        schema_version: "agent-session.session-retitle.readiness.v2",
        capability: "agent-session.session-retitle.v2",
        status: "ready",
        reason_code: "ready",
        next_action: "none",
        provider_kind: "codex_subscription",
        context_capabilities: {
          codex: "provider_transcript",
          claude: "provider_transcript",
        },
      },
    }),
    requestSessionRetitle: async (_machine, _id, request) => {
      requests.push(request);
      if (scenario !== "recover" || requests.length === 1) {
        return {
          ok: false,
          error: "The session title changed; refresh and retry.",
          errorCode: "title-revision-conflict",
        };
      }
      return {
        ok: true,
        retitle: {
          schema_version: "agent-session.session-retitle.v2",
          outcome: "committed",
          changed: true,
          trigger: "manual",
          provider_kind: "codex_subscription",
          diagnostic_code: "committed",
          coverage: { source: "provider_transcript", complete: true, truncated: true, turn_count: 12 },
          session: {
            title: "Recovered manual retitle",
            title_state: {
              topic: "Recovered manual retitle",
              topic_source: "auto",
              references: [],
              activity: null,
            },
            title_revision: 9,
            session_incarnation: "launch-hs-1",
          },
        },
      };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let retitleSession: ((session: Session) => Promise<void>) | null = null;
  let renderedTitle: string | null | undefined = stale.title;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([stale]);
    renderedTitle = sessions[0]?.title;
    const controller = useAutoTitleController({
      applyLiveSessionList: (res) => {
        setSessions(res.sessions);
      },
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: (value) => errors.push(typeof value === "function" ? value(null) : value),
      setRetitleFeedback: (value) => feedback.push(value.state),
      setSessions,
      showRetitleFeedback: (value) => feedback.push(value.state),
      activeTerminalSlotKey: () => null,
    });
    retitleSession = controller.retitleSession;
    return null;
  }

  await act(async () => { mounted.root.render(createElement(Probe)); });
  await act(async () => { await retitleSession?.(stale); await flushPromises(); });

  assert.equal(listCalls, 1);
  assert.deepEqual(requests.map((request) => request.expected_title_revision), [7, 8]);
  assert.notEqual(requests[0]?.idempotency_key, requests[1]?.idempotency_key);
  assert.equal(renderedTitle, "Recovered manual retitle");
  assert.ok(feedback.includes("updated"));
  assert.deepEqual(errors, []);

  scenario = "bounded";
  requests.length = 0;
  feedback.length = 0;
  errors.length = 0;
  listCalls = 0;
  await act(async () => { await retitleSession?.(stale); await flushPromises(); });
  assert.equal(requests.length, 3);
  assert.equal(listCalls, 2);
  assert.ok(feedback.includes("failed"));
  assert.equal(errors.at(-1), "The session title changed. Refresh and try again.");

  scenario = "new-incarnation";
  refreshedSession = makeSession({ ...fresh, session_incarnation: "launch-hs-2" });
  requests.length = 0;
  feedback.length = 0;
  errors.length = 0;
  listCalls = 0;
  await act(async () => { await retitleSession?.(stale); await flushPromises(); });
  assert.equal(requests.length, 1);
  assert.equal(listCalls, 1);
  assert.ok(feedback.includes("failed"));
});

test("useAutoTitleController refreshes a pending turn after create intent resolution", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const createdSession = makeSession({ title: "New Codex session" });
  let liveTitle = createdSession.title;
  const titleRequests: TitleSummaryRequest[] = [];
  let resolveCreateSummary: ((value: { ok: true; title: string; source: "summarizer" }) => void) | null = null;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...createdSession, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "Review threads are ready.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      if (titleRequests.length === 1) {
        return new Promise((resolve) => {
          resolveCreateSummary = resolve;
        });
      }
      return { ok: true, title: "PR #23 - Resolving review threads", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary:
    | ((session: Session, prompt: string, baseTitle: string | null, fallbackTitle: string) => Promise<void>)
    | null = null;
  let noteTurnPromptSubmitted: ((session: Session, prompt: string, eventId?: string) => void) | null = null;

  const stableOptions = {
    applyLiveSessionList: () => undefined,
    enabledMachinesRef: { current: ["summit"] },
    liveRef: { current: true },
    setError: () => undefined,
    setRetitleFeedback: () => undefined,
    showRetitleFeedback: () => undefined,
    activeTerminalSlotKey: () => null,
  };

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([createdSession]);
    const controller = useAutoTitleController({
      applyLiveSessionList: stableOptions.applyLiveSessionList,
      enabledMachinesRef: stableOptions.enabledMachinesRef,
      focusedKey: null,
      liveRef: stableOptions.liveRef,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: stableOptions.setError,
      setRetitleFeedback: stableOptions.setRetitleFeedback,
      setSessions,
      showRetitleFeedback: stableOptions.showRetitleFeedback,
      activeTerminalSlotKey: stableOptions.activeTerminalSlotKey,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  let pendingCreate: Promise<void> | null = null;
  await act(async () => {
    pendingCreate = applyCreatePromptSummary?.(createdSession, "pr:deliver-pr 23", null, "pr:deliver-pr 23") ?? null;
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(createdSession, "resolve review threads", "pp-turn-pending");
  });
  await act(async () => {
    resolveCreateSummary?.({ ok: true, title: "PR #23", source: "summarizer" });
    await pendingCreate;
  });
  assert.equal(liveTitle, "PR #23");
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.equal(titleRequests.length, 2);
  assert.equal(titleRequests[1]?.baseTitle, "PR #23");
  assert.equal(titleRequests[1]?.currentTitle, "PR #23");
});

test("useAutoTitleController refreshes a pending turn after explicit-base create resolution", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const fallbackTitle = "Project #23 - pr:deliver-pr 23";
  const createdSession = makeSession({ title: "Project #23" });
  let liveTitle = createdSession.title;
  const titleRequests: TitleSummaryRequest[] = [];
  let resolveCreateSummary: ((value: { ok: true; title: string; source: "summarizer" }) => void) | null = null;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...createdSession, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "Review threads are ready.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      if (titleRequests.length === 1) {
        return new Promise((resolve) => {
          resolveCreateSummary = resolve;
        });
      }
      return { ok: true, title: "Project #23 - Resolving review threads", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let applyCreatePromptSummary:
    | ((session: Session, prompt: string, baseTitle: string | null, fallbackTitle: string) => Promise<void>)
    | null = null;
  let noteTurnPromptSubmitted: ((session: Session, prompt: string, eventId?: string) => void) | null = null;
  const stableOptions = {
    applyLiveSessionList: () => undefined,
    enabledMachinesRef: { current: ["summit"] },
    liveRef: { current: true },
    setError: () => undefined,
    setRetitleFeedback: () => undefined,
    showRetitleFeedback: () => undefined,
    activeTerminalSlotKey: () => null,
  };

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([createdSession]);
    const controller = useAutoTitleController({
      applyLiveSessionList: stableOptions.applyLiveSessionList,
      enabledMachinesRef: stableOptions.enabledMachinesRef,
      focusedKey: null,
      liveRef: stableOptions.liveRef,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: stableOptions.setError,
      setRetitleFeedback: stableOptions.setRetitleFeedback,
      setSessions,
      showRetitleFeedback: stableOptions.showRetitleFeedback,
      activeTerminalSlotKey: stableOptions.activeTerminalSlotKey,
    });
    applyCreatePromptSummary = controller.applyCreatePromptSummary;
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  let pendingCreate: Promise<void> | null = null;
  await act(async () => {
    pendingCreate = applyCreatePromptSummary?.(
      createdSession,
      "pr:deliver-pr 23",
      "Project #23",
      fallbackTitle,
    ) ?? null;
    await flushPromises();
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(createdSession, "resolve review threads", "pp-turn-explicit-pending");
  });
  await act(async () => {
    resolveCreateSummary?.({ ok: true, title: "Project #23 - Deliver PR #23", source: "summarizer" });
    await pendingCreate;
  });
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.equal(titleRequests.length, 2);
  assert.equal(titleRequests[1]?.baseTitle, "Project #23");
  assert.equal(titleRequests[1]?.currentTitle, "Project #23 - Deliver PR #23");
});

test("useAutoTitleController keeps the scheduled stale guard across unrelated title changes", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: "Review auth module - Finding bugs" });
  let liveTitle = session.title;
  const titleRequests: TitleSummaryRequest[] = [];
  const titleUpdates: Array<string | null> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      sessions: [{ ...session, title: liveTitle }],
      machines: [{ name: "summit", ok: true }],
    }),
    glance: async () => ({
      title: liveTitle,
      tail: "Work continued after the prompt.",
      agent: "codex",
      repo_name: "agent-console",
    }),
    summarizeSessionTitle: async (body) => {
      titleRequests.push(body);
      return { ok: true, title: "Review auth module - Updating tests", source: "summarizer" };
    },
    updateSessionTitle: async (_machine, _id, title) => {
      titleUpdates.push(title);
      liveTitle = title;
      return { ok: true };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let noteTurnPromptSubmitted: ((nextSession: Session, prompt: string, eventId?: string) => void) | null = null;
  const stableOptions = {
    applyLiveSessionList: () => undefined,
    enabledMachinesRef: { current: ["summit"] },
    liveRef: { current: true },
    setError: () => undefined,
    setRetitleFeedback: () => undefined,
    showRetitleFeedback: () => undefined,
    activeTerminalSlotKey: () => null,
  };

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    const controller = useAutoTitleController({
      applyLiveSessionList: stableOptions.applyLiveSessionList,
      enabledMachinesRef: stableOptions.enabledMachinesRef,
      focusedKey: null,
      liveRef: stableOptions.liveRef,
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: stableOptions.setError,
      setRetitleFeedback: stableOptions.setRetitleFeedback,
      setSessions,
      showRetitleFeedback: stableOptions.showRetitleFeedback,
      activeTerminalSlotKey: stableOptions.activeTerminalSlotKey,
    });
    noteTurnPromptSubmitted = controller.noteTurnPromptSubmitted;
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  await act(async () => {
    noteTurnPromptSubmitted?.(session, "update validation tests", "pp-turn-stale");
  });
  liveTitle = "Manually renamed elsewhere";
  await act(async () => {
    timers.advance(12_000);
    await flushPromises();
  });

  assert.equal(titleRequests.length, 0);
  assert.deepEqual(titleUpdates, []);
  assert.equal(liveTitle, "Manually renamed elsewhere");
});

test("useLayoutSync does not flush a pending reorder when reachability identity changes", async () => {
  const timers = installFakeTimers();
  cleanupStack.push(timers.cleanup);
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const sessions = [
    makeSession({ id: "hs-1" }),
    makeSession({ id: "hs-2", title: "Second" }),
  ];
  const puts: Array<{ order: readonly string[]; keepalive?: boolean; reason?: string }> = [];
  globalThis.__agentConsoleDashboardHooksApiMock = {
    fetchLayoutOrder: async () => ({ reachable: true, order: ["summit/hs-1", "summit/hs-2"], revision: 1 }),
    putLayoutOrder: async (order, options) => {
      puts.push({ order: [...order], keepalive: options?.keepalive, reason: options?.reason });
      return { reachable: true, order: [...order], revision: 2, conflict: false };
    },
  };
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>("/src/useLayoutSync.ts");
  // A third session the stored ranking does not cover is what arms the debounced
  // publish: the complete order gained a key, so this device owes the store a PUT.
  const grownSessions = [...sessions, makeSession({ id: "hs-3", title: "Third" })];

  function Probe({
    reachableVersion,
    liveSessions,
  }: {
    readonly reachableVersion: number;
    readonly liveSessions: readonly Session[];
  }) {
    void reachableVersion;
    const [slots, setSlotState] = useState<SlotKey[]>(["summit/hs-1", "summit/hs-2"]);
    useLayoutSync({
      sessions: liveSessions,
      visible: liveSessions,
      slotCount: 2,
      reachableMachineNames: new Set(["summit"]),
      getKnownMachineNames: () => new Set(["summit"]),
      setSlots: setSlotState,
    });
    return null;
  }

  await act(async () => {
    mounted.root.render(createElement(Probe, { reachableVersion: 1, liveSessions: sessions }));
    await flushPromises();
  });
  await act(async () => {
    mounted.root.render(createElement(Probe, { reachableVersion: 1, liveSessions: grownSessions }));
    await flushPromises();
  });
  assert.equal(timers.timers.some((timer) => !timer.cleared && timer.delayMs === 800), true);

  await act(async () => {
    mounted.root.render(createElement(Probe, { reachableVersion: 2, liveSessions: grownSessions }));
    await flushPromises();
  });

  assert.deepEqual(puts, []);
});

test("useAutoTitleController retries one v3 history conflict and surfaces the daemon failure class", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([mockApiPlugin()]);
  cleanupStack.push(ssr.close);

  const session = makeSession({ title: null, retitle_path: "daemon_v3", title_revision: 0 });
  const operationHash = `sha256:${"c".repeat(64)}`;
  const feedback: string[] = [];
  const errors: Array<string | null> = [];
  const requests: SessionRetitleV3Request[] = [];
  let memoryRevision = 0;
  let titleRevision = 0;
  let liveIncarnation = "launch-hs-1";
  let conflicts = 0;
  let alwaysConflict = false;
  let scenario: "terminal" | "degraded" | "rejected-request" = "terminal";
  const responseBase = {
    schema_version: "agent-session.session-retitle.v3",
    capability: "agent-session.session-retitle.v3",
    provider_attempts: [],
    operation_hash: operationHash,
    session_incarnation: "launch-hs-1",
    readiness: "ready",
    admission_fence: { session_incarnation: "launch-hs-1", title_revision: 0, memory_revision: 0 },
    current_fence: { session_incarnation: "launch-hs-1", title_revision: 0, memory_revision: 0 },
    result_is_current: true,
    started_at: "2026-09-21T00:00:00Z",
    duration_bucket: "5_29_s",
  } as const;
  globalThis.__agentConsoleDashboardHooksApiMock = {
    listSessions: async () => ({
      // The refreshed session is what a retry must fence against, so it moves
      // with the daemon rather than echoing the original request.
      sessions: [{ ...session, title_revision: titleRevision, session_incarnation: liveIncarnation }],
      machines: [{ name: "summit", ok: true }],
    }),
    fetchSessionRetitleV3Readiness: async () => ({
      ok: true,
      readiness: {
        schema_version: "agent-session.session-retitle.readiness.v3",
        capability: "agent-session.session-retitle.v3",
        status: "ready",
        provider_status: "ready",
        context_status: "ready",
        title_status: "missing",
        reason_code: "ready",
        next_action: "none",
        memory_revision: memoryRevision,
        usable_memory: true,
        pending_operation: false,
      },
    }),
    requestSessionRetitleV3: async (_machine, _id, request) => {
      requests.push(request);
      // The session keeps writing history, so the first admitted operation
      // loses the commit race exactly as a live daemon reports it.
      if (alwaysConflict || conflicts === 0) {
        conflicts += 1;
        memoryRevision += 1;
        titleRevision += 1;
        if (scenario === "rejected-request") {
          return { ok: false as const, error: "rejected", errorCode: "retitle-v3-history-conflict" };
        }
        return {
          ok: true,
          retitle: {
            ...responseBase,
            status: "terminal",
            outcome: scenario === "degraded" ? "degraded_cached" : "terminal_failure",
            changed: false,
            failure_class: "retitle-v3-history-conflict",
            failure_stage: "provider",
            memory_revision: memoryRevision,
            title_revision: 0,
            finished_at: "2026-09-21T00:00:20Z",
          },
        };
      }
      memoryRevision += 1;
      return {
        ok: true,
        retitle: {
          ...responseBase,
          status: "terminal",
          outcome: "committed",
          changed: true,
          memory_revision: memoryRevision,
          title_revision: 1,
          title: "Recovered semantic title",
          finished_at: "2026-09-21T00:00:40Z",
        },
      };
    },
  };
  const { useAutoTitleController } = await ssr.loadModule<typeof import("../src/useAutoTitleController.ts")>(
    "/src/useAutoTitleController.ts",
  );
  let retitleSession: ((session: Session) => Promise<void>) | null = null;
  let renderedTitle: string | null | undefined = session.title;

  function Probe() {
    const [sessions, setSessions] = useState<Session[]>([session]);
    renderedTitle = sessions[0]?.title;
    const controller = useAutoTitleController({
      applyLiveSessionList: () => undefined,
      enabledMachinesRef: { current: ["summit"] },
      focusedKey: null,
      liveRef: { current: true },
      refresh: async () => undefined,
      sessionsByKey: new Map(sessions.map((item) => [`${item.machine}/${item.id}`, item])),
      setError: (value) => errors.push(typeof value === "function" ? value(null) : value),
      setRetitleFeedback: (value) => feedback.push(value.state),
      setSessions,
      showRetitleFeedback: (value) => feedback.push(value.state),
      activeTerminalSlotKey: () => null,
    });
    retitleSession = controller.retitleSession;
    return null;
  }

  await act(async () => { mounted.root.render(createElement(Probe)); });
  await act(async () => { await retitleSession?.(session); await flushPromises(); });

  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]?.idempotency_key, requests[1]?.idempotency_key);
  // The retry is fenced against the refreshed session and readiness, not the
  // stale request it replaces.
  assert.equal(requests[0]?.expected.title_revision, 0);
  assert.equal(requests[0]?.expected.memory_revision, 0);
  assert.equal(requests[1]?.expected.title_revision, 1);
  assert.equal(requests[1]?.expected.memory_revision, 1);
  assert.equal(renderedTitle, "Recovered semantic title");
  assert.ok(feedback.includes("committed"));
  assert.deepEqual(errors.filter(Boolean), []);

  // A request rejected with the same conflict code retries on the same budget.
  scenario = "rejected-request";
  conflicts = 0;
  requests.length = 0;
  feedback.length = 0;
  errors.length = 0;
  await act(async () => {
    await retitleSession?.({ ...session, title_revision: titleRevision });
    await flushPromises();
  });
  assert.equal(requests.length, 2);
  assert.ok(feedback.includes("committed"));

  // A preserved cached title is never worth a second provider call.
  scenario = "degraded";
  conflicts = 0;
  alwaysConflict = true;
  requests.length = 0;
  feedback.length = 0;
  errors.length = 0;
  await act(async () => {
    await retitleSession?.({ ...session, title_revision: titleRevision });
    await flushPromises();
  });
  assert.equal(requests.length, 1);
  assert.ok(feedback.includes("degraded_cached"));
  assert.equal(
    errors.at(-1),
    "The existing cached title was preserved. The session history changed. Refresh and try again.",
  );

  scenario = "terminal";
  requests.length = 0;
  feedback.length = 0;
  await act(async () => {
    await retitleSession?.({ ...session, title_revision: titleRevision });
    await flushPromises();
  });

  assert.equal(requests.length, 2);
  assert.ok(feedback.includes("terminal_failure"));
  assert.equal(errors.at(-1), "The session history changed. Refresh and try again.");

  // A runtime that restarted under the operation abandons the retry instead of
  // fencing the next attempt against a session that no longer exists.
  liveIncarnation = "launch-hs-2";
  requests.length = 0;
  feedback.length = 0;
  await act(async () => {
    await retitleSession?.({ ...session, title_revision: titleRevision });
    await flushPromises();
  });
  assert.equal(requests.length, 1);
  assert.ok(feedback.includes("terminal_failure"));
});
