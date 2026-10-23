import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Plugin } from "vite";
import type { HistoryMessagesResponse, HistorySessionsResponse } from "../src/types.ts";
import { assertNoElement } from "./support/domAssert.ts";
import { uiStyles } from "./support/source.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

interface HistoryApiMock {
  listHistorySessions(
    machine: string,
    options: { readonly cursor?: string; readonly q?: string; readonly provider?: string; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<HistorySessionsResponse>;
  listHistoryMessages(
    machine: string,
    id: string,
    options?: { readonly cursor?: string; readonly direction?: "latest" | "older" },
    signal?: AbortSignal,
  ): Promise<HistoryMessagesResponse>;
  setHistoryStar?(
    machine: string,
    historyId: string,
    starred: boolean,
  ): Promise<{ readonly ok: boolean; readonly starredAt?: string; readonly error?: string }>;
  resumeHistorySession?(
    machine: string,
    historyId: string,
  ): Promise<{
    readonly ok: boolean;
    readonly id?: string;
    readonly error?: string;
    readonly errorCode?: string;
    readonly outcomeUnknown?: boolean;
  }>;
  lookupLiveHistorySession?(machine: string, provider: string, providerSessionId: string): Promise<string | undefined>;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentConsoleHistoryApiMock: HistoryApiMock | undefined;
}

// Pre-tag voice prompts arrive with newlines flattened, as normalized by the edge.
const LEGACY_VOICE_NOTE = "以下文字由語音轉寫，可能有同音字或專有名詞錯誤。請依對話脈絡理解；檔名、路徑、指令、數字或可能修改資料的內容若有歧義，先向我確認。 原始轉寫： ";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  delete globalThis.__agentConsoleHistoryApiMock;
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test("archived history badges override the row's muted span color", () => {
  assert.match(
    uiStyles(),
    /\.history-row \.history-archive-badge\s*\{[^}]*color:\s*var\(--accent\)/,
  );
});

test("HistoryPanel identifies sessions and opens the latest context before loading older messages", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const cleanupBackCalls: unknown[] = [];
  Object.defineProperty(mounted.window.history, "back", {
    configurable: true,
    value: () => cleanupBackCalls.push(mounted.window.history.state),
  });
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  const calls: Array<{ cursor?: string; direction?: "latest" | "older" }> = [];
  let closeCalls = 0;
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [{
        id: "history-1",
        machine: "maple",
        provider: "codex",
        provider_session_id: "private-provider-id",
        title: null,
        prompt_preview: "legacy wrapper",
        first_user_prompt_preview: `${LEGACY_VOICE_NOTE}first human prompt`,
        last_user_prompt_preview: `${LEGACY_VOICE_NOTE}latest human prompt`,
        cwd: "/home/runner/Project/exampleOrg/agent-console",
        repo_name: "agent-console",
        created_at: "2026-08-31T00:00:00Z",
        updated_at: "2026-09-01T13:45:36",
        resumable: true,
        archived_at: "2026-09-01T14:00:00Z",
      }],
      truncated: false,
      latestMessagePaging: true,
    }),
    listHistoryMessages: async (_machine, _id, options) => {
      calls.push(options ?? {});
      if (options?.direction === "older") {
        const page = options.cursor === "older-1" ? 1 : options.cursor === "older-2" ? 2 : 3;
        const start = 151 - page * 50;
        return {
          ok: true,
          messages: Array.from({ length: 50 }, (_, index) => ({
            id: `older-${start + index}`,
            role: "assistant",
            text: `older ${start + index}`,
          })),
          ...(page < 3 ? { olderCursor: `older-${page + 1}` } : {}),
        };
      }
      return {
        ok: true,
        messages: [{ id: "m2", role: "assistant", text: "latest" }],
        olderCursor: "older-1",
      };
    },
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"],
      onClose: () => { closeCalls += 1; },
      onResumed: () => {},
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });

  assert.match(mounted.container.textContent ?? "", /Untitled session/);
  assert.match(mounted.container.textContent ?? "", /Start\[語音\] first human prompt/);
  assert.match(mounted.container.textContent ?? "", /Latest\[語音\] latest human prompt/);
  assert.doesNotMatch(mounted.container.textContent ?? "", /語音轉寫/);
  const row = mounted.container.querySelector(".history-row");
  assert.ok(row);
  assert.equal(row.querySelector(".history-harness-badge")?.textContent, "Codex");
  assert.equal(row.querySelector(".history-project-badge")?.textContent, "agent-console");
  assert.equal(
    row.querySelector(".history-project-path")?.textContent,
    "/home/runner/Project/exampleOrg/agent-console",
  );
  assert.equal(row.querySelector(".history-row-meta")?.textContent, "2026/9/1 13:45:36");
  const contextBadges = row.querySelector(".history-context-badges");
  const archivedBadge = row.querySelector(".history-archive-badge");
  assert.ok(contextBadges);
  assert.ok(archivedBadge);
  assert.equal(archivedBadge.textContent, "Archived");
  assert.equal(archivedBadge.parentElement?.className, "history-context-badges");
  const rowChildren = [...row.children];
  const startPreview = [...row.querySelectorAll(".history-row-preview")]
    .find((preview) => preview.querySelector("b")?.textContent === "Start");
  const latestPreview = [...row.querySelectorAll(".history-row-preview")]
    .find((preview) => preview.querySelector("b")?.textContent === "Latest");
  assert.ok(startPreview);
  assert.ok(latestPreview);
  assert.ok(rowChildren.indexOf(row.querySelector(".history-session-context")!) < rowChildren.indexOf(startPreview));
  assert.ok(rowChildren.indexOf(row.querySelector(".history-row-meta")!) < rowChildren.indexOf(startPreview));
  assert.equal(rowChildren.includes(archivedBadge), false);
  assert.equal(rowChildren.indexOf(latestPreview), rowChildren.length - 1);
  assert.doesNotMatch(row.textContent ?? "", /private-provider-id/);

  const outerBackState = mounted.window.history.state;
  Object.defineProperty(mounted.window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => 800,
  });
  mounted.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const viewport = this.closest(".history-messages") as HTMLElement | null;
    const messages = viewport ? [...viewport.querySelectorAll<HTMLElement>("[data-history-message-id]")] : [];
    const index = messages.indexOf(this as HTMLElement);
    const top = index >= 0 && viewport ? 100 + index * 20 - viewport.scrollTop : 0;
    return {
      x: 0,
      y: top,
      top,
      right: 100,
      bottom: top + 20,
      left: 0,
      width: 100,
      height: 20,
      toJSON: () => ({}),
    } as DOMRect;
  };

  await act(async () => {
    (row as HTMLButtonElement).click();
    await flush();
  });
  assert.deepEqual(calls, [{ direction: "latest" }]);
  assert.match(mounted.container.textContent ?? "", /latest/);
  assert.match(mounted.container.textContent ?? "", /private-provider-id/);
  assert.equal(findButton(mounted.container, "Resume").disabled, true, "route capability is required");
  const viewerMeta = mounted.container.querySelector(".history-viewer-meta");
  assert.ok(viewerMeta);
  assert.equal(viewerMeta.querySelector(".history-harness-badge")?.textContent, "Codex");
  assert.equal(viewerMeta.querySelector(".history-project-badge")?.textContent, "agent-console");
  assert.equal(
    viewerMeta.querySelector(".history-project-path")?.textContent,
    "/home/runner/Project/exampleOrg/agent-console",
  );
  assert.equal((mounted.container.querySelector(".history-messages") as HTMLElement).scrollTop, 800);

  for (const cursor of ["older-1", "older-2", "older-3"]) {
    const anchor = mounted.container.querySelector<HTMLElement>("[data-history-message-id]");
    assert.ok(anchor);
    const anchorId = anchor.dataset.historyMessageId;
    const anchorTop = anchor.getBoundingClientRect().top;
    await act(async () => {
      findButton(mounted.container, "Load older").click();
      await flush();
    });
    assert.deepEqual(calls.at(-1), { direction: "older", cursor });
    const retainedAnchor = mounted.container.querySelector<HTMLElement>(`[data-history-message-id="${anchorId}"]`);
    assert.ok(retainedAnchor);
    assert.equal(retainedAnchor.getBoundingClientRect().top, anchorTop);
    assert.ok(mounted.container.querySelectorAll(".history-message").length <= 100);
  }
  assert.equal(mounted.container.querySelectorAll(".history-message").length, 100);
  const retainedMessageText = [...mounted.container.querySelectorAll(".history-message")]
    .map((message) => message.textContent)
    .join(" ");
  assert.match(retainedMessageText, /older 1/);
  assert.doesNotMatch(retainedMessageText, /latest/);
  assert.match(mounted.container.textContent ?? "", /Jump to latest/);

  await act(async () => {
    findButton(mounted.container, "Jump to latest").click();
    await flush();
  });
  assert.deepEqual(calls.at(-1), { direction: "latest" });
  assert.equal(mounted.container.querySelectorAll(".history-message").length, 1);
  assert.equal((mounted.container.querySelector(".history-messages") as HTMLElement).scrollTop, 800);

  assert.ok(mounted.container.querySelector(".history-body.is-viewing"));
  await act(async () => {
    // Back from the conversation reveals the still-mounted outer History dialog.
    mounted.window.history.replaceState(outerBackState, "");
    mounted.window.dispatchEvent(new mounted.window.PopStateEvent("popstate", { state: outerBackState }));
    await flush();
  });
  assert.ok(mounted.container.querySelector(".history-body.is-listing"));
  assertNoElement(mounted.container, ".history-viewer-head");
  assert.equal(closeCalls, 0);

  await act(async () => {
    (row as HTMLButtonElement).click();
    await flush();
  });
  assert.ok(mounted.container.querySelector(".history-body.is-viewing"));
  await act(async () => {
    const close = mounted.container.querySelector<HTMLButtonElement>('[aria-label="Close history"]');
    assert.ok(close !== null, "named Close history button exists");
    close!.click();
    await flush();
  });
  assert.ok(mounted.container.querySelector(".history-body.is-listing"));
  assert.equal(closeCalls, 0);
  assert.equal(cleanupBackCalls.length, 1);
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.PopStateEvent("popstate", {
      state: { agentConsoleBack: "session-history" },
    }));
    await flush();
  });
  assert.equal(closeCalls, 1);
});

function historyApiMockPlugin(): Plugin {
  const mockId = "\0history-panel-api-mock";
  return {
    name: "history-panel-api-mock",
    enforce: "pre",
    resolveId(source, importer) {
      return source.endsWith("api.ts") && importer?.includes("/src/") ? mockId : null;
    },
    load(id) {
      if (id !== mockId) return null;
      return `
        const mock = () => globalThis.__agentConsoleHistoryApiMock;
        export const listHistorySessions = (...args) => mock().listHistorySessions(...args);
        export const listHistoryMessages = (...args) => mock().listHistoryMessages(...args);
        export const setHistoryStar = (...args) => mock().setHistoryStar(...args);
        export const resumeHistorySession = (...args) => mock().resumeHistorySession(...args);
        export const lookupLiveHistorySession = (...args) => mock().lookupLiveHistorySession(...args);
      `;
    },
  };
}

function installDom(): { window: Window; root: Root; container: HTMLElement; cleanup(): Promise<void> } {
  const window = new Window({ url: "tauri://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  return {
    window,
    root,
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      Object.assign(globalThis, {
        window: previous.window,
        document: previous.document,
        Element: previous.Element,
        HTMLElement: previous.HTMLElement,
        HTMLInputElement: previous.HTMLInputElement,
        HTMLSelectElement: previous.HTMLSelectElement,
        KeyboardEvent: previous.KeyboardEvent,
        MouseEvent: previous.MouseEvent,
        Event: previous.Event,
        IS_REACT_ACT_ENVIRONMENT: previous.IS_REACT_ACT_ENVIRONMENT,
      });
      if (previous.navigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", previous.navigatorDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "navigator");
      }
      window.close();
    },
  };
}

function findButton(container: ParentNode, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(button, `button ${label} should exist`);
  return button;
}

function findByLabel(container: ParentNode, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(button, `button labelled ${label} should exist`);
  return button;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function withFastResumeLookupIntervals(run: () => Promise<void>): Promise<void> {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) =>
    realSetTimeout(callback, delay === 500 ? 0 : delay, ...args)) as typeof globalThis.setTimeout;
  try {
    await run();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test("HistoryPanel replaces bounded pages and can navigate back", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  const makeSession = (id: string) => ({
    id,
    machine: "maple",
    provider: "codex" as const,
    provider_session_id: `provider-${id}`,
    title: `Title ${id}`,
    cwd: "/repo",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:01Z",
    resumable: true,
  });
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async (_machine, options) => options.cursor === "page-2"
      ? { ok: true, sessions: [makeSession("older")], truncated: false }
      : { ok: true, sessions: [makeSession("newest")], nextCursor: "page-2", truncated: false },
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"],
      onClose: () => {},
      onResumed: () => {},
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });
  assert.match(mounted.container.textContent ?? "", /Title newest/);

  await act(async () => {
    findButton(mounted.container, "Next").click();
    await flush();
  });
  assert.match(mounted.container.textContent ?? "", /Title older/);
  assert.doesNotMatch(mounted.container.textContent ?? "", /Title newest/);

  await act(async () => {
    findButton(mounted.container, "Previous").click();
    await flush();
  });
  assert.match(mounted.container.textContent ?? "", /Title newest/);
  assert.doesNotMatch(mounted.container.textContent ?? "", /Title older/);
});

test("HistoryPanel shows each message's local send time", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  const now = new Date();
  const pad = (part: number) => String(part).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T09:05:07`;
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [{
        id: "history-1",
        machine: "maple",
        provider: "codex",
        provider_session_id: "provider-1",
        title: "Timed session",
        cwd: "/repo",
        created_at: "2026-08-31T00:00:00Z",
        updated_at: "2026-08-31T00:00:01Z",
        resumable: true,
      }],
      truncated: false,
      latestMessagePaging: true,
    }),
    listHistoryMessages: async () => ({
      ok: true,
      messages: [
        { id: "earlier", role: "user", text: "earlier ask", timestamp: "2026-09-01T13:45:36" },
        { id: "today", role: "assistant", text: "today reply", timestamp: today },
        { id: "untimed", role: "assistant", text: "untimed reply" },
        { id: "invalid", role: "assistant", text: "invalid reply", timestamp: "not-a-time" },
      ],
    }),
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"],
      onClose: () => {},
      onResumed: () => {},
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });
  await act(async () => {
    (mounted.container.querySelector(".history-row") as HTMLButtonElement).click();
    await flush();
  });

  const timeOf = (id: string) =>
    mounted.container.querySelector(`[data-history-message-id="${id}"] time`);
  assert.equal(timeOf("earlier")?.textContent, "13:45");
  assert.equal(timeOf("earlier")?.getAttribute("datetime"), "2026-09-01T13:45:36");
  assert.equal(timeOf("today")?.textContent, "09:05", "a message from today shows only its time");
  assert.equal(timeOf("untimed"), null);
  assert.equal(timeOf("invalid"), null);
  assertNoElement(mounted.container, '[data-history-message-id="earlier"] header');
  assert.deepEqual([...mounted.container.querySelectorAll('.history-day-separator')].map(day => day.textContent), ['2026/9/1', '今天']);
});

test("HistoryPanel stars a session from the list and lifts it to the front", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  const makeSession = (id: string, updatedAt: string) => ({
    id,
    machine: "maple",
    provider: "codex" as const,
    provider_session_id: `provider-${id}`,
    title: `Title ${id}`,
    cwd: "/repo",
    created_at: updatedAt,
    updated_at: updatedAt,
    resumable: true,
  });
  const starCalls: Array<{ id: string; starred: boolean }> = [];
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [makeSession("newest", "2026-08-31T00:00:00Z"), makeSession("older", "2026-07-01T00:00:00Z")],
      truncated: false,
      resumeAvailable: true,
      starAvailable: true,
    }),
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    setHistoryStar: async (_machine, historyId, starred) => {
      starCalls.push({ id: historyId, starred });
      return starred ? { ok: true, starredAt: "2026-09-01T00:00:00Z" } : { ok: true };
    },
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"],
      onClose: () => {},
      onResumed: () => {},
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });

  const rowTitles = () => [...mounted.container.querySelectorAll(".history-row-title")]
    .map((element) => element.textContent);
  assert.deepEqual(rowTitles(), ["Title newest", "Title older"]);

  await act(async () => {
    findByLabel(mounted.container, "Star Title older").click();
    await flush();
  });
  assert.deepEqual(starCalls, [{ id: "older", starred: true }]);
  assert.deepEqual(rowTitles(), ["Title older", "Title newest"]);

  await act(async () => {
    findByLabel(mounted.container, "Unstar Title older").click();
    await flush();
  });
  assert.deepEqual(starCalls.at(-1), { id: "older", starred: false });
  assert.deepEqual(rowTitles(), ["Title newest", "Title older"]);
});

test("HistoryPanel leaves the order alone when the daemon refuses a star", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  const makeSession = (id: string, updatedAt: string) => ({
    id,
    machine: "maple",
    provider: "codex" as const,
    provider_session_id: `provider-${id}`,
    title: `Title ${id}`,
    cwd: "/repo",
    created_at: updatedAt,
    updated_at: updatedAt,
    resumable: true,
  });
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [makeSession("newest", "2026-08-31T00:00:00Z"), makeSession("older", "2026-07-01T00:00:00Z")],
      truncated: false,
      resumeAvailable: true,
      starAvailable: true,
    }),
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    setHistoryStar: async () => ({ ok: false, error: "star store unreachable" }),
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"],
      onClose: () => {},
      onResumed: () => {},
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });

  await act(async () => {
    findByLabel(mounted.container, "Star Title older").click();
    await flush();
  });

  assert.deepEqual(
    [...mounted.container.querySelectorAll(".history-row-title")].map((element) => element.textContent),
    ["Title newest", "Title older"],
    "a refused star never reorders the list",
  );
  assert.match(mounted.container.textContent ?? "", /star store unreachable/);
  assert.ok(findByLabel(mounted.container, "Star Title older"), "the row stays unstarred");
});

test("resuming from History hands the live session up and closes the panel", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  const resumed: unknown[] = [];
  let closeCalls = 0;
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [{
        id: "history-1",
        machine: "maple",
        provider: "codex" as const,
        provider_session_id: "provider-1",
        title: "Resume me",
        cwd: "/repo",
        created_at: "2026-08-31T00:00:00Z",
        updated_at: "2026-08-31T00:00:01Z",
        resumable: true,
      }],
      truncated: false,
      resumeAvailable: true,
    }),
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    resumeHistorySession: async () => ({ ok: true, id: "live-9" }),
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"],
      onClose: () => { closeCalls += 1; },
      onResumed: (session: unknown) => { resumed.push(session); },
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".history-row")?.click();
    await flush();
  });
  await act(async () => {
    findButton(mounted.container, "Resume").click();
    await flush();
  });

  assert.deepEqual(resumed, [{ machine: "maple", id: "live-9" }]);
  // Closing from the conversation view unwinds the Android back entry first,
  // exactly as the × button does, and completes on the popstate that follows.
  assert.ok(mounted.container.querySelector(".history-body.is-listing"));
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.PopStateEvent("popstate", {
      state: { agentConsoleBack: "session-history" },
    }));
    await flush();
  });
  assert.equal(closeCalls, 1, "History closes so the resumed session is what the user lands on");
});

for (const errorCode of ["history-resume-profile-unavailable", undefined]) {
  test(`a failed resume keeps History open: ${errorCode ?? "legacy message only"}`, async () => {
    const mounted = installDom();
    cleanups.push(mounted.cleanup);
    const ssr = createUiSsrHarness([historyApiMockPlugin()]);
    cleanups.push(ssr.close);
    const resumed: unknown[] = [];
    let closeCalls = 0;
    globalThis.__agentConsoleHistoryApiMock = {
      listHistorySessions: async () => ({
        ok: true,
        sessions: [{
          id: "history-1",
          machine: "maple",
          provider: "codex" as const,
          provider_session_id: "provider-1",
          title: "Resume me",
          cwd: "/repo",
          created_at: "2026-08-31T00:00:00Z",
          updated_at: "2026-08-31T00:00:01Z",
          resumable: true,
        }],
        truncated: false,
        resumeAvailable: true,
      }),
      listHistoryMessages: async () => ({ ok: true, messages: [] }),
      resumeHistorySession: async () => ({
        ok: false,
        errorCode,
        error: "history resume profile is unavailable; refresh History and try again",
      }),
    };

    const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
    await act(async () => {
      mounted.root.render(createElement(HistoryPanel, {
        machines: ["maple"],
        onClose: () => { closeCalls += 1; },
        onResumed: (session: unknown) => { resumed.push(session); },
      }));
      await flush();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
      await flush();
    });
    await act(async () => {
      mounted.container.querySelector<HTMLButtonElement>(".history-row")?.click();
      await flush();
    });
    await act(async () => {
      findButton(mounted.container, "Resume").click();
      await flush();
    });

    assert.deepEqual(resumed, []);
    assert.equal(closeCalls, 0);
    const error = mounted.container.querySelector('[role="alert"]');
    assert.ok(error);
    assert.equal(error.textContent, errorCode
      ? "history-resume-profile-unavailable: history resume profile is unavailable; refresh History and try again"
      : "history resume profile is unavailable; refresh History and try again");
  });
}

test("an unconfirmed resume checks inventory and disables blind retry", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  let attempts = 0;
  let lookups = 0;
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [{
        id: "history-1",
        machine: "maple",
        provider: "dsh" as const,
        provider_session_id: "provider-1",
        cwd: "/repo",
        created_at: "2026-08-31T00:00:00Z",
        updated_at: "2026-08-31T00:00:01Z",
        resumable: true,
      }],
      truncated: false,
      resumeAvailable: true,
    }),
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    lookupLiveHistorySession: async () => { lookups += 1; return undefined; },
    resumeHistorySession: async () => {
      attempts += 1;
      return {
        ok: false,
        outcomeUnknown: true,
        errorCode: "upstream-timeout",
        error: "History resume response could not be confirmed.",
      };
    },
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"],
      onClose: () => {},
      onResumed: () => {},
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".history-row")?.click();
    await flush();
  });
  await withFastResumeLookupIntervals(async () => {
    await act(async () => {
      findButton(mounted.container, "Resume").click();
      for (let flushCount = 0; flushCount < 8; flushCount += 1) await flush();
    });
  });

  const resumeButton = findButton(mounted.container, "Resume");
  assert.equal(attempts, 1);
  assert.ok(lookups > 0 && lookups <= 5);
  assert.equal(resumeButton.disabled, true);
  assert.match(mounted.container.textContent ?? "", /response could not be confirmed/i);
  assert.match(mounted.container.querySelector('[role="alert"]')?.textContent ?? "", /^upstream-timeout: /);
  assert.match(mounted.container.textContent ?? "", /live sessions were checked/i);
  resumeButton.click();
  await flush();
  assert.equal(attempts, 1, "a second blind resume is refused locally");
});

test("a resume transport failure looks up the exact conversation before returning", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  let closeCalls = 0;
  let attempts = 0;
  let lookups = 0;
  const resumed: unknown[] = [];
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [{
        id: "history-1",
        machine: "maple",
        provider: "dsh" as const,
        provider_session_id: "provider-1",
        cwd: "/repo",
        created_at: "2026-08-31T00:00:00Z",
        updated_at: "2026-08-31T00:00:01Z",
        resumable: true,
      }],
      truncated: false,
      resumeAvailable: true,
    }),
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    lookupLiveHistorySession: async (machine, provider, providerSessionId) => {
      lookups += 1;
      assert.deepEqual([machine, provider, providerSessionId], ["maple", "dsh", "provider-1"]);
      return lookups === 1 ? undefined : "live-9";
    },
    resumeHistorySession: async () => {
      attempts += 1;
      throw new Error("fetch failed for /private/runtime?token=secret");
    },
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"],
      onClose: () => { closeCalls += 1; },
      onResumed: (session: unknown) => { resumed.push(session); },
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".history-row")?.click();
    await flush();
  });
  await act(async () => {
    findButton(mounted.container, "Resume").click();
    await new Promise((resolve) => setTimeout(resolve, 550));
    await flush();
  });

  assert.equal(attempts, 1);
  assert.ok(lookups >= 2 && lookups <= 5);
  assert.deepEqual(resumed, [{ machine: "maple", id: "live-9" }]);
  assert.equal(closeCalls, 0, "native history returns to its list before the dashboard handoff completes");
  assert.doesNotMatch(mounted.container.textContent ?? "", /private|secret/);
});

test("History unmount cancels a pending resume lookup and handoff", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  let lookups = 0;
  const resumed: unknown[] = [];
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [{
        id: "history-1", machine: "maple", provider: "dsh" as const,
        provider_session_id: "provider-1", cwd: "/repo",
        created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:01Z", resumable: true,
      }],
      truncated: false,
      resumeAvailable: true,
    }),
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    lookupLiveHistorySession: async () => {
      lookups += 1;
      return lookups === 1 ? undefined : "live-9";
    },
    resumeHistorySession: async () => ({ ok: false, outcomeUnknown: true, error: "Resume timed out." }),
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"], onClose: () => {}, onResumed: (session: unknown) => { resumed.push(session); },
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".history-row")?.click();
    await flush();
  });
  await act(async () => {
    findButton(mounted.container, "Resume").click();
    await flush();
  });
  await act(async () => { mounted.root.unmount(); });
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(lookups, 1);
  assert.deepEqual(resumed, []);
});

test("History does not start an inventory lookup when unmounted during the resume POST", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  let finishResume: ((result: { readonly ok: false; readonly outcomeUnknown: true; readonly error: string }) => void) | undefined;
  const resumeResponse = new Promise<{ readonly ok: false; readonly outcomeUnknown: true; readonly error: string }>((resolve) => {
    finishResume = resolve;
  });
  let lookups = 0;
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [{
        id: "history-1", machine: "maple", provider: "dsh" as const,
        provider_session_id: "provider-1", cwd: "/repo",
        created_at: "2026-08-31T00:00:00Z", updated_at: "2026-08-31T00:00:01Z", resumable: true,
      }],
      truncated: false,
      resumeAvailable: true,
    }),
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    lookupLiveHistorySession: async () => { lookups += 1; return "live-9"; },
    resumeHistorySession: async () => resumeResponse,
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, { machines: ["maple"], onClose: () => {}, onResumed: () => {} }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".history-row")?.click();
    await flush();
  });
  await act(async () => {
    findButton(mounted.container, "Resume").click();
    await flush();
  });

  await act(async () => { mounted.root.unmount(); });
  finishResume?.({ ok: false, outcomeUnknown: true, error: "Resume timed out." });
  await act(async () => { await flush(); });

  assert.equal(lookups, 0);
});

test("a resume without a live session id is unconfirmed and cannot be retried blindly", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  const resumed: unknown[] = [];
  let closeCalls = 0;
  let attempts = 0;
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [{
        id: "history-1",
        machine: "maple",
        provider: "codex" as const,
        provider_session_id: "provider-1",
        title: "Resume me",
        cwd: "/repo",
        created_at: "2026-08-31T00:00:00Z",
        updated_at: "2026-08-31T00:00:01Z",
        resumable: true,
      }],
      truncated: false,
      resumeAvailable: true,
    }),
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    lookupLiveHistorySession: async () => undefined,
    resumeHistorySession: async () => {
      attempts += 1;
      return { ok: true };
    },
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"],
      onClose: () => { closeCalls += 1; },
      onResumed: (session: unknown) => { resumed.push(session); },
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".history-row")?.click();
    await flush();
  });
  await withFastResumeLookupIntervals(async () => {
    await act(async () => {
      findButton(mounted.container, "Resume").click();
      for (let flushCount = 0; flushCount < 8; flushCount += 1) await flush();
    });
  });

  assert.deepEqual(resumed, []);
  assert.equal(closeCalls, 0);
  const resumeButton = findButton(mounted.container, "Resume");
  assert.equal(resumeButton.disabled, true);
  assert.match(mounted.container.textContent ?? "", /History resume returned no created session/i);
  assert.match(mounted.container.textContent ?? "", /live sessions were checked/i);
  resumeButton.click();
  await flush();
  assert.equal(attempts, 1, "a success envelope without a live id cannot trigger a blind retry");
});

test("History closes before the resume handoff it cannot outlive", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]);
  cleanups.push(ssr.close);
  let releaseHandoff: (() => void) | undefined;
  const handoff = new Promise<void>((resolve) => { releaseHandoff = resolve; });
  let closeCalls = 0;
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      sessions: [{
        id: "history-1",
        machine: "maple",
        provider: "codex" as const,
        provider_session_id: "provider-1",
        title: "Resume me",
        cwd: "/repo",
        created_at: "2026-08-31T00:00:00Z",
        updated_at: "2026-08-31T00:00:01Z",
        resumable: true,
      }],
      truncated: false,
      resumeAvailable: true,
    }),
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    resumeHistorySession: async () => ({ ok: true, id: "live-9" }),
  };

  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["maple"],
      onClose: () => { closeCalls += 1; },
      // The Dashboard's handler awaits a full session-list refresh.
      onResumed: () => handoff,
    }));
    await flush();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
    await flush();
  });
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>(".history-row")?.click();
    await flush();
  });
  await act(async () => {
    findButton(mounted.container, "Resume").click();
    await flush();
  });

  // The close is already under way while the handoff is still pending, so the
  // panel never sits interactive across an await it would then act on.
  assert.ok(mounted.container.querySelector(".history-body.is-listing"));
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.PopStateEvent("popstate", {
      state: { agentConsoleBack: "session-history" },
    }));
    await flush();
  });
  assert.equal(closeCalls, 1);

  releaseHandoff?.();
  await act(async () => {
    await handoff;
    await flush();
  });
  assert.equal(closeCalls, 1, "the settled handoff does not close a second time");
});


test("History filters start collapsed and retain selection while folding", async () => {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]); cleanups.push(ssr.close);
  const calls: string[] = [];
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async (machine) => { calls.push(machine); return { ok: true, sessions: [], truncated: false }; },
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
  };
  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, { machines: ["maple", "m2"], onClose: () => {}, onResumed: () => {} }));
    await flush();
  });
  const toggle = mounted.container.querySelector<HTMLButtonElement>('button[aria-controls="history-filters"]');
  assert.ok(toggle, "History offers the shared filter disclosure");
  assert.equal(toggle.closest(".history-list") === null, true, "History filters belong above the list");
  const region = mounted.container.querySelector<HTMLElement>("#history-filters"); assert.ok(region);
  assert.equal(region.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.match(toggle.textContent ?? "", /maple · All providers/);
  await act(async () => toggle.click());
  const machine = region.querySelector<HTMLSelectElement>('select[aria-label="History machine"]'); assert.ok(machine);
  await act(async () => {
    machine.value = "m2"; machine.dispatchEvent(new mounted.window.Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 220)); await flush();
  });
  await act(async () => toggle.click());
  assert.equal(region.hidden, true);
  assert.match(toggle.textContent ?? "", /m2 · All providers/);
  await act(async () => toggle.click());
  assert.equal(machine.value, "m2");
  assert.equal(calls.at(-1), "m2");
});

function controlledCatalogClock(window: Window) {
  const originalSet = window.setTimeout.bind(window);
  const originalClear = window.clearTimeout.bind(window);
  const timers = new Map<number, () => void>();
  let next = -1;
  window.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 30_000) {
      const id = next--;
      timers.set(id, callback);
      return id;
    }
    return originalSet(callback, delay, ...args);
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => {
    if (id < 0) timers.delete(id);
    else originalClear(id);
  }) as typeof window.clearTimeout;
  return {
    get pending() { return timers.size; },
    async advance() {
      const callbacks = [...timers.values()];
      timers.clear();
      await act(async () => {
        for (const callback of callbacks) callback();
        await flush();
        await flush();
      });
    },
    restore() {
      timers.clear();
      window.setTimeout = originalSet;
      window.clearTimeout = originalClear;
    },
  };
}

const newlyAvailableHistory = {
  id: "owned-stopped-history", machine: "fixture-hub", provider: "claude" as const,
  provider_session_id: "fresh-owned-thread", title: "Fresh stopped session", cwd: "/fixture/project",
  created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:01Z", resumable: true,
};

async function mountCatalogFixture(mock: HistoryApiMock) {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  Object.defineProperty(mounted.window.document, "visibilityState", { configurable: true, value: "visible" });
  const clock = controlledCatalogClock(mounted.window); cleanups.push(clock.restore);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]); cleanups.push(ssr.close);
  globalThis.__agentConsoleHistoryApiMock = mock;
  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, {
      machines: ["fixture-hub"], onClose: () => {}, onResumed: () => {},
    }));
    await flush();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); await flush(); });
  return { ...mounted, clock };
}

test("History discovers newly available owned metadata after a cached empty result without changing filters", async () => {
  let available = false;
  const calls: Array<{ machine: string; q?: string; provider?: string; cursor?: string; limit?: number }> = [];
  const mounted = await mountCatalogFixture({
    listHistorySessions: async (machine, options) => {
      calls.push({ machine, ...options });
      return { ok: true, sessions: available ? [newlyAvailableHistory] : [], truncated: false };
    },
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
  });
  assert.equal(calls.length, 1, "initial catalogue retains its debounced read");
  assert.match(mounted.container.textContent ?? "", /No matching sessions/);
  available = true;
  await mounted.clock.advance();
  assert.equal(mounted.container.querySelector(".history-row-title")?.textContent, "Fresh stopped session");
  assert.equal(calls.length, 2, "one bounded refresh discovers the newly available record");
  assert.deepEqual(calls[1], calls[0], "machine, metadata query, provider and page limit stay unchanged");
  assert.equal(mounted.clock.pending, 1, "one next refresh is scheduled after completion");
});

test("History catalogue refresh waits for the pending read instead of overlapping requests", async () => {
  let calls = 0;
  let release: ((result: HistorySessionsResponse) => void) | undefined;
  const mounted = await mountCatalogFixture({
    listHistorySessions: async () => {
      calls += 1;
      if (calls === 2) return new Promise(resolve => { release = resolve; });
      return { ok: true, sessions: [], truncated: false };
    },
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
  });
  await mounted.clock.advance();
  assert.equal(calls, 2, "refresh starts after the initial result");
  await mounted.clock.advance();
  assert.equal(calls, 2, "an outstanding read never overlaps another tick");
  assert.equal(mounted.clock.pending, 0);
  await act(async () => { release?.({ ok: true, sessions: [newlyAvailableHistory], truncated: false }); await flush(); });
  assert.equal(mounted.container.querySelector(".history-row-title")?.textContent, "Fresh stopped session");
  assert.equal(mounted.clock.pending, 1);
});

test("History catalogue cancels a late refresh when a conversation is selected", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  let release: ((result: HistorySessionsResponse) => void) | undefined;
  const mounted = await mountCatalogFixture({
    listHistorySessions: async (_machine, _options, requestSignal) => {
      calls += 1;
      if (calls === 2) {
        signal = requestSignal;
        return new Promise(resolve => { release = resolve; });
      }
      return { ok: true, sessions: [newlyAvailableHistory], truncated: false };
    },
    listHistoryMessages: async () => ({ ok: true, messages: [{ id: "selected-message", role: "assistant", text: "Selected transcript" }] }),
  });
  await mounted.clock.advance();
  assert.equal(calls, 2);
  const row = mounted.container.querySelector<HTMLButtonElement>(".history-row"); assert.ok(row);
  await act(async () => { row.click(); await flush(); });
  assert.equal(signal?.aborted, true);
  await act(async () => { release?.({ ok: true, sessions: [], truncated: false }); await flush(); });
  assert.match(mounted.container.querySelector(".history-viewer")?.textContent ?? "", /Selected transcript/);
  assert.equal(mounted.container.querySelector(".history-row-title")?.textContent, "Fresh stopped session");
  assert.equal(mounted.clock.pending, 0, "reading a conversation pauses catalogue refresh");
});

test("History catalogue refresh pauses while hidden and on older pages", async () => {
  let calls = 0;
  const mounted = await mountCatalogFixture({
    listHistorySessions: async (_machine, options) => {
      calls += 1;
      return { ok: true, sessions: [{ ...newlyAvailableHistory,
        title: options.cursor ? "Older session" : "Fresh stopped session" }],
        truncated: false, ...(options.cursor ? {} : { nextCursor: "older-page" }) };
    },
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
  });
  Object.defineProperty(mounted.window.document, "visibilityState", { configurable: true, value: "hidden" });
  await mounted.clock.advance();
  assert.equal(calls, 1, "hidden documents perform no automatic catalogue read");
  Object.defineProperty(mounted.window.document, "visibilityState", { configurable: true, value: "visible" });
  await mounted.clock.advance();
  assert.equal(calls, 2);
  await act(async () => { findButton(mounted.container, "Next").click(); await flush(); });
  assert.equal(calls, 3);
  await mounted.clock.advance();
  assert.equal(calls, 3, "an older page remains where the reader put it");
  assert.equal(mounted.container.querySelector(".history-row-title")?.textContent, "Older session");
  assert.ok(mounted.container.querySelector(".history-pagination button"));
});

test("History automatic discovery never clears an unconfirmed resume guard", async () => {
  let calls = 0;
  let attempts = 0;
  const mounted = await mountCatalogFixture({
    listHistorySessions: async () => {
      calls += 1;
      return { ok: true, sessions: [newlyAvailableHistory], truncated: false, resumeAvailable: true };
    },
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    resumeHistorySession: async () => {
      attempts += 1;
      return { ok: false, outcomeUnknown: true, error: "Resume could not be confirmed." };
    },
    lookupLiveHistorySession: async () => undefined,
  });
  const row = mounted.container.querySelector<HTMLButtonElement>(".history-row"); assert.ok(row);
  await act(async () => { row.click(); await flush(); });
  await withFastResumeLookupIntervals(async () => {
    await act(async () => {
      findButton(mounted.container, "Resume").click();
      for (let index = 0; index < 8; index++) await flush();
    });
  });
  assert.equal(findButton(mounted.container, "Resume").disabled, true);
  await act(async () => { findButton(mounted.container, "Back to sessions").click(); await flush(); });
  await mounted.clock.advance();
  assert.equal(calls, 1, "automatic discovery is paused until the unresolved attempt is explicitly checked");
  assert.equal(attempts, 1, "background reads never initiate another resume");
  assert.equal(mounted.clock.pending, 0);
});

test("History filter changes fence a pending catalogue refresh and retain the new filter", async () => {
  const providers: Array<string | undefined> = [];
  let oldSignal: AbortSignal | undefined;
  let release: ((result: HistorySessionsResponse) => void) | undefined;
  const mounted = await mountCatalogFixture({
    listHistorySessions: async (_machine, options, signal) => {
      providers.push(options.provider);
      if (providers.length === 2) {
        oldSignal = signal;
        return new Promise(resolve => { release = resolve; });
      }
      return { ok: true, sessions: [{ ...newlyAvailableHistory,
        title: options.provider === "codex" ? "Codex catalogue" : "Fresh stopped session" }], truncated: false };
    },
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
  });
  await mounted.clock.advance();
  assert.equal(providers.length, 2);
  const select = mounted.container.querySelector<HTMLSelectElement>('select[aria-label="History provider"]');
  assert.ok(select);
  await act(async () => {
    select.value = "codex";
    select.dispatchEvent(new mounted.window.Event("change", { bubbles: true }));
    await flush();
  });
  assert.equal(oldSignal?.aborted, true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); await flush(); });
  assert.equal(mounted.container.querySelector(".history-row-title")?.textContent, "Codex catalogue");
  await act(async () => { release?.({ ok: true, sessions: [], truncated: false }); await flush(); });
  assert.equal(select.value, "codex");
  assert.equal(mounted.container.querySelector(".history-row-title")?.textContent, "Codex catalogue");
  await mounted.clock.advance();
  assert.equal(providers.length, 4, "the new filter keeps its own refresh generation");
  assert.equal(providers.at(-1), "codex");
});

test("History refresh cannot undo an immediately acknowledged Star with an older response", async () => {
  let calls = 0;
  let release: ((result: HistorySessionsResponse) => void) | undefined;
  const mounted = await mountCatalogFixture({
    listHistorySessions: async () => {
      calls += 1;
      if (calls === 2) return new Promise(resolve => { release = resolve; });
      return { ok: true, sessions: [newlyAvailableHistory], truncated: false, starAvailable: true };
    },
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
    setHistoryStar: async () => ({ ok: true, starredAt: "2026-10-12T01:00:00Z" }),
  });
  await mounted.clock.advance();
  assert.equal(calls, 2);
  await act(async () => { findByLabel(mounted.container, "Star Fresh stopped session").click(); await flush(); });
  assert.equal(mounted.container.querySelector(".history-star")?.getAttribute("aria-pressed"), "true");
  await act(async () => {
    release?.({ ok: true, sessions: [newlyAvailableHistory], truncated: false, starAvailable: true });
    await flush();
  });
  assert.equal(mounted.container.querySelector(".history-star")?.getAttribute("aria-pressed"), "true",
    "a cancelled earlier read cannot replace an acknowledged mutation");
});

function reviewer804DeadlineClock(window: Window) {
  let now = 0, next = -1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const originalSet = window.setTimeout.bind(window), originalClear = window.clearTimeout.bind(window);
  window.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 30_000) return originalSet(callback, delay, ...args);
    const id = next--; timers.set(id, { at: now + delay, callback }); return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => { if (id < 0) timers.delete(id); else originalClear(id); }) as typeof window.clearTimeout;
  return {
    get now() { return now; },
    async advanceTo(target: number) {
      for (;;) {
        const due = [...timers].sort((a,b) => a[1].at-b[1].at)[0];
        if (!due || due[1].at > target) break;
        timers.delete(due[0]); now = due[1].at;
        await act(async () => { due[1].callback(); await flush(); await flush(); });
      }
      now = target;
    },
    restore() { timers.clear(); window.setTimeout=originalSet; window.clearTimeout=originalClear; },
  };
}

test("reviewer804: first refresh waits 30 seconds after a slow initial catalogue settles", async () => {
  const mounted=installDom(); cleanups.push(mounted.cleanup);
  Object.defineProperty(mounted.window.document,"visibilityState",{configurable:true,value:"visible"});
  const clock=reviewer804DeadlineClock(mounted.window);cleanups.push(clock.restore);
  const ssr=createUiSsrHarness([historyApiMockPlugin()]);cleanups.push(ssr.close);
  let release: ((value: HistorySessionsResponse)=>void)|undefined;
  let cacheStamp=0;
  const calls:number[]=[];
  globalThis.__agentConsoleHistoryApiMock={
    listHistorySessions: async () => {
      calls.push(clock.now);
      if (calls.length===1) return new Promise(resolve=>{release=resolve;});
      return {ok:true,sessions:clock.now-cacheStamp>=30_000?[newlyAvailableHistory]:[],truncated:false};
    },
    listHistoryMessages: async()=>({ok:true,messages:[]}),
  };
  const {HistoryPanel}=await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async()=>{mounted.root.render(createElement(HistoryPanel,{machines:["fixture-hub"],onClose:()=>{},onResumed:()=>{}}));await flush();});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,220));await flush();});
  assert.equal(calls.length,1);
  await clock.advanceTo(10_000);cacheStamp=clock.now;
  await act(async()=>{release?.({ok:true,sessions:[],truncated:false});await flush();});
  await clock.advanceTo(30_000);
  console.log({initialCompletedAt:cacheStamp,requestTimes:calls,firstAutomaticAge:calls[1]===undefined?null:calls[1]-cacheStamp});
  assert.equal(calls.length,1,"a newly scanned 30s cache must not receive an early poll before 40,000ms");
  await clock.advanceTo(40_000);
  assert.equal(calls.length,2);
  assert.equal(mounted.container.querySelector(".history-row-title")?.textContent,"Fresh stopped session");
});

test("reviewer804: successful quiet refresh clears only its prior catalogue failure", async()=>{
  let calls=0;
  const mounted=await mountCatalogFixture({
    listHistorySessions:async()=> ++calls===1
      ? {ok:false,sessions:[],truncated:false,error:"SYNTHETIC_CATALOG_FAILURE"}
      : {ok:true,sessions:[newlyAvailableHistory],truncated:false},
    listHistoryMessages:async()=>({ok:true,messages:[]}),
  });
  assert.equal(mounted.container.querySelector('[role="alert"]')?.textContent,"SYNTHETIC_CATALOG_FAILURE");
  await mounted.clock.advance();
  assert.equal(mounted.container.querySelector(".history-row-title")?.textContent,"Fresh stopped session");
  console.log({recoveredRow:true,remainingAlert:mounted.container.querySelector('[role="alert"]')?.textContent});
  assertNoElement(mounted.container,'[role="alert"]');
});

test("reviewer804: quiet catalogue success must preserve a refused Star alert", async()=>{
  const mounted=await mountCatalogFixture({
    listHistorySessions:async()=>({ok:true,sessions:[newlyAvailableHistory],truncated:false,starAvailable:true}),
    listHistoryMessages:async()=>({ok:true,messages:[]}),
    setHistoryStar:async()=>({ok:false,error:"SYNTHETIC_STAR_REFUSAL"}),
  });
  await act(async()=>{findByLabel(mounted.container,"Star Fresh stopped session").click();await flush();});
  assert.equal(mounted.container.querySelector('[role="alert"]')?.textContent,"SYNTHETIC_STAR_REFUSAL");
  await mounted.clock.advance();
  assert.equal(mounted.container.querySelector('[role="alert"]')?.textContent,"SYNTHETIC_STAR_REFUSAL");
});

test("reviewer804: a slow filter read restarts the first interval from its completion", async () => {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  Object.defineProperty(mounted.window.document, "visibilityState", { configurable: true, value: "visible" });
  const clock = reviewer804DeadlineClock(mounted.window); cleanups.push(clock.restore);
  const ssr = createUiSsrHarness([historyApiMockPlugin()]); cleanups.push(ssr.close);
  const calls: Array<{ at: number; provider?: string }> = [];
  let release: ((result: HistorySessionsResponse) => void) | undefined;
  let cacheStamp = 0;
  globalThis.__agentConsoleHistoryApiMock = {
    listHistorySessions: async (_machine, options) => {
      calls.push({ at: clock.now, provider: options.provider });
      if (calls.length === 2) return new Promise(resolve => { release = resolve; });
      return { ok: true, sessions: options.provider && clock.now - cacheStamp >= 30_000
        ? [{ ...newlyAvailableHistory, provider: "codex" }] : [], truncated: false };
    },
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
  };
  const { HistoryPanel } = await ssr.loadModule<typeof import("../src/HistoryPanel.tsx")>("/src/HistoryPanel.tsx");
  await act(async () => {
    mounted.root.render(createElement(HistoryPanel, { machines: ["fixture-hub"], onClose: () => {}, onResumed: () => {} }));
    await flush();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); await flush(); });
  await clock.advanceTo(5_000);
  const select = mounted.container.querySelector<HTMLSelectElement>('select[aria-label="History provider"]');
  assert.ok(select);
  await act(async () => {
    select.value = "codex"; select.dispatchEvent(new mounted.window.Event("change", { bubbles: true }));
    await flush();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); await flush(); });
  assert.equal(calls.length, 2);
  await clock.advanceTo(15_000); cacheStamp = clock.now;
  await act(async () => { release?.({ ok: true, sessions: [], truncated: false }); await flush(); });
  await clock.advanceTo(35_000);
  assert.equal(calls.length, 2, "the filter scan's own 30-second cache has not expired");
  await clock.advanceTo(45_000);
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1)?.provider, "codex");
  assert.equal(mounted.container.querySelector(".history-row-title")?.textContent, "Fresh stopped session");
});
