import { sharedAdmissionFixture } from "./support/sharedAdmissionFixture.ts";
import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { IDBFactory } from "fake-indexeddb";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Plugin } from "vite";
import type {
  HistoryMessagesResponse,
  HistorySessionsResponse,
  Session,
  TurnState,
} from "../src/types.ts";
import { assertActiveElement, assertNoElement } from "./support/domAssert.ts";
import { makeSession } from "./support/fixtures.ts";
import { uiSource, uiStyles } from "./support/source.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

interface ConversationApiMock {
  submitSessionPrompt?: (...args: unknown[]) => Promise<{ ok: boolean; error?: string; outcomeUnknown?: boolean }>;
  speechProviders?: readonly { id: string; label: string; max_duration_seconds: number; max_bytes: number }[];
  speechText?: string;
  listHistorySessions(
    machine: string,
    options: { readonly q?: string; readonly cursor?: string; readonly limit?: number },
  ): Promise<HistorySessionsResponse>;
  listHistoryMessages(
    machine: string,
    id: string,
    options?: { readonly cursor?: string; readonly direction?: "latest" | "older" },
    signal?: AbortSignal,
  ): Promise<HistoryMessagesResponse>;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentConsoleConversationApiMock: ConversationApiMock | undefined;
  var __agentConsoleConversationResourceChange: ((event?: import("@agent-console/shared/resources").ResourceEvent) => void) | undefined;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  delete globalThis.__agentConsoleConversationApiMock;
  delete globalThis.__agentConsoleConversationResourceChange;
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function turnState(completedAt?: string): TurnState {
  return {
    schema_version: "agent-session.turn-state.v1",
    phase: "waiting",
    phase_changed_at: completedAt ?? "2026-09-26T00:00:00Z",
    revision: 1,
    source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
    last_turn: { completed_at: completedAt ?? "2026-09-26T00:00:00Z", outcome: "completed" as const },
  } as TurnState;
}

function liveSession(overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: "hs-7",
    machine: "maple",
    agent: "codex",
    title: "Live work",
    provider_resume: { provider: "codex", session_id: "provider-7" },
    turn_state: turnState("2026-09-26T00:01:00Z"),
    ...overrides,
  });
}

function historyEntry() {
  return {
    id: "history-7",
    machine: "maple",
    provider: "codex" as const,
    provider_session_id: "provider-7",
    title: "Live work",
    cwd: "/repo",
    created_at: "2026-09-26T00:00:00Z",
    updated_at: "2026-09-26T00:01:00Z",
    resumable: false,
  };
}

for (const view of ["panel", "tile", "phone"] as const) {
  test(`${view} discovers the first transcript without remounting or losing the first user row`, async () => {
    const mounted = installDom();
    cleanups.push(mounted.cleanup);
    const globals = new Map(["indexedDB", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) },
    } });
    cleanups.push(() => {
      for (const [key, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    });
    let tick!: () => void;
    const schedule = mounted.window.setTimeout.bind(mounted.window);
    Reflect.set(mounted.window, "setTimeout", (callback: () => void, ms: number) => {
      if (ms !== 3000) return schedule(callback, ms);
      tick = callback;
      return 538;
    });
    const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
    cleanups.push(ssr.close);
    let available = false;
    let reply = "first provider reply";
    const searches: unknown[] = [];
    const reads: unknown[] = [];
    globalThis.__agentConsoleConversationApiMock = {
      listHistorySessions: async (machine, options) => {
        searches.push({ machine, ...options });
        return { ok: true, truncated: false, latestMessagePaging: true, sessions: available ? [
          { ...historyEntry(), id: "near-match", provider_session_id: "provider-70" }, historyEntry(),
        ] : [] };
      },
      listHistoryMessages: async (machine, id, options) => {
        reads.push({ machine, id, ...options });
        return { ok: true, messages: [{ id: reply, role: "assistant", text: reply }] };
      },
    };
    // A retained legacy echo is visible without authorizing new delivery.
    const session = liveSession({ session_incarnation: undefined });
    const { conversationOutbox } = await ssr.loadModule<typeof import("../src/conversationOutbox.ts")>("/src/conversationOutbox.ts");
    await conversationOutbox().ready;
    await conversationOutbox().enqueue(session, "first user request");
    const initialOutbox = JSON.stringify(conversationOutbox().items(session));
    const component = view === "panel" ? "LiveConversationPanel" : view === "tile" ? "SessionConversationPane" : "PhoneConversationPane";
    const module = await ssr.loadModule<Record<string, import("react").ComponentType<any>>>(`/src/${component}.tsx`);
    const props = { session, machineReachable: true, onClose() {}, swipeEnabled: false, onSwipe() {}, refreshRef: { current: null } };
    const render = () => act(async () => {
      mounted.root.render(createElement(module[component]!, props));
      await flush();
    });
    await render();
    await act(async () => flush());
    const userRow = mounted.container.querySelector(".history-outgoing-reply");
    assert.ok(userRow);
    assert.match(userRow.textContent ?? "", /first user request/);
    assert.match(mounted.container.textContent ?? "", /No Codex session with ID provider-7/);
    assert.equal(reads.length, 0);
    assert.equal(searches.length, 1);

    available = true;
    await act(async () => { tick(); await flush(); });
    await act(async () => flush());
    assert.match(mounted.container.textContent ?? "", /first provider reply/);
    assert.match(mounted.container.textContent ?? "", /first user request/);
    assertNoElement(mounted.container, '[role="alert"]', "the initial miss clears after binding");
    assert.deepEqual(reads, [{ machine: "maple", id: "history-7", direction: "latest" }]);
    assert.deepEqual(searches, Array(2).fill({ machine: "maple", q: "provider-7", limit: 50 }));

    reply = "later provider reply";
    await act(async () => { tick(); await flush(); });
    assert.match(mounted.container.textContent ?? "", /later provider reply/);
    assert.match(mounted.container.textContent ?? "", /first user request/);
    assert.equal(searches.length, 2, "bound refreshes read messages without reopening history");
    assert.equal(JSON.stringify(conversationOutbox().items(session)), initialOutbox, "discovery never rewrites the outgoing row");

    await act(async () => mounted.root.render(null));
    await render();
    await act(async () => flush());
    assert.match(mounted.container.textContent ?? "", /later provider reply/);
    assert.match(mounted.container.textContent ?? "", /first user request/);
  });
}

test("discovery preserves search failures and serializes refreshes until lookup settles", async () => {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]); cleanups.push(ssr.close);
  const pending = deferred<HistorySessionsResponse>();
  let searches = 0;
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => {
      searches++;
      if (searches === 1) return { ok: false, sessions: [], truncated: false, error: "History search unavailable" };
      if (searches === 2) return pending.promise;
      throw new Error("History transport unavailable");
    },
    listHistoryMessages: async () => { assert.fail("failed discovery cannot read a conversation"); },
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  await act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session: liveSession(), onClose() {} }));
    await flush();
  });
  await act(async () => flush());
  assert.match(mounted.container.textContent ?? "", /History search unavailable/);
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.Event("focus"));
    mounted.window.document.dispatchEvent(new mounted.window.Event("visibilitychange"));
    await flush();
  });
  assert.equal(searches, 2, "focus and visibility changes share the pending search");
  assert.match(mounted.container.textContent ?? "", /History search unavailable/);
  await act(async () => {
    pending.resolve({ ok: true, sessions: [], truncated: true });
    await flush();
  });
  assert.match(mounted.container.textContent ?? "", /history scan limit was reached/);
  await act(async () => { mounted.window.dispatchEvent(new mounted.window.Event("focus")); await flush(); });
  assert.match(mounted.container.textContent ?? "", /History transport unavailable/);
  assert.doesNotMatch(mounted.container.textContent ?? "", /No Codex session/);
});

test("discovery ignores late lookups on identity change and unmount, clearing the previous conversation", async () => {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]); cleanups.push(ssr.close);
  const oldLookup = deferred<HistorySessionsResponse>();
  const unmountedLookup = deferred<HistorySessionsResponse>();
  const reads: string[] = [];
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async (_machine, options) => {
      if (options.q === "provider-7") return oldLookup.promise;
      if (options.q === "provider-9") return unmountedLookup.promise;
      return { ok: true, sessions: [{ ...historyEntry(), id: "history-8", provider_session_id: "provider-8" }], truncated: false };
    },
    listHistoryMessages: async (_machine, id) => {
      reads.push(id);
      return { ok: true, messages: [{ id: "a8", role: "assistant", text: "current conversation" }] };
    },
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  const render = async (id: string | null) => {
    await act(async () => {
      mounted.root.render(createElement(LiveConversationPanel, {
        session: liveSession({ provider_resume: id ? { provider: "codex", session_id: id } : null }), onClose() {},
      }));
      await flush();
    });
    await act(async () => flush());
  };
  await render("provider-7");
  await render("provider-8");
  assert.match(mounted.container.textContent ?? "", /current conversation/);
  await act(async () => {
    oldLookup.resolve({ ok: true, sessions: [historyEntry()], truncated: false });
    await flush();
  });
  assert.deepEqual(reads, ["history-8"], "a stale lookup cannot open the previous identity");
  await render(null);
  assert.doesNotMatch(mounted.container.textContent ?? "", /current conversation/);
  await render("provider-9");
  await act(async () => mounted.root.render(null));
  await act(async () => {
    unmountedLookup.resolve({ ok: true, sessions: [{ ...historyEntry(), provider_session_id: "provider-9" }], truncated: false });
    await flush();
  });
  assert.deepEqual(reads, ["history-8"], "unmount cancels discovery before message reads");
});

test("the live panel finds the session's history entry and opens its latest messages", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  const searches: unknown[] = [];
  const reads: unknown[] = [];
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async (machine, options) => {
      searches.push({ machine, ...options });
      return { ok: true, truncated: false, latestMessagePaging: true, sessions: [historyEntry()] };
    },
    listHistoryMessages: async (machine, id, options) => {
      reads.push({ machine, id, ...options });
      return {
        ok: true,
        messages: [
          { id: "u1", role: "user", text: "please fix it" },
          { id: "g1", role: "goal", text: "Finish the repair" },
          { id: "a1", role: "assistant", text: "fixed and tested" },
        ],
      };
    },
  };
  const { LiveConversationPanel } = await ssr.loadModule<typeof import("../src/LiveConversationPanel.tsx")>(
    "/src/LiveConversationPanel.tsx",
  );

  await act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session: liveSession(), onClose: () => {} }));
    await flush();
  });
  await act(async () => flush());

  assert.deepEqual(searches, [{ machine: "maple", q: "provider-7", limit: 50 }]);
  assert.deepEqual(reads, [{ machine: "maple", id: "history-7", direction: "latest" }]);
  const text = mounted.container.textContent ?? "";
  assert.match(text, /Live work/);
  assert.match(text, /please fix it/);
  assert.match(text, /GoalFinish the repair/);
  assert.match(text, /fixed and tested/);
});

test("the live panel explains a session that has no provider session id yet", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  let calls = 0;
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => {
      calls += 1;
      return { ok: true, truncated: false, sessions: [] };
    },
    listHistoryMessages: async () => {
      calls += 1;
      return { ok: true, messages: [] };
    },
  };
  const { LiveConversationPanel } = await ssr.loadModule<typeof import("../src/LiveConversationPanel.tsx")>(
    "/src/LiveConversationPanel.tsx",
  );

  await act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, {
      session: liveSession({ provider_resume: null }),
      onClose: () => {},
    }));
    await flush();
  });

  assert.equal(calls, 0);
  assert.match(mounted.container.textContent ?? "", /has not reported a provider session ID yet/);
});

test("the live panel reports a history miss instead of an empty conversation", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, sessions: [] }),
    listHistoryMessages: async () => ({ ok: true, messages: [] }),
  };
  const { LiveConversationPanel } = await ssr.loadModule<typeof import("../src/LiveConversationPanel.tsx")>(
    "/src/LiveConversationPanel.tsx",
  );

  await act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session: liveSession(), onClose: () => {} }));
    await flush();
  });
  await act(async () => flush());

  assert.match(mounted.container.textContent ?? "", /No Codex session with ID provider-7 is in maple history\./);
});

test("the live panel reloads the latest page when a turn finishes, but not while browsing older", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  const reads: Array<{ direction?: string; cursor?: string }> = [];
  let latestText = "first report";
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({
      ok: true,
      truncated: false,
      latestMessagePaging: true,
      sessions: [historyEntry()],
    }),
    listHistoryMessages: async (_machine, _id, options) => {
      reads.push({ ...options });
      if (options?.direction === "older") {
        return { ok: true, messages: [{ id: "old-1", role: "user", text: "older ask" }] };
      }
      return { ok: true, messages: [{ id: latestText, role: "assistant", text: latestText }], olderCursor: "older-1" };
    },
  };
  const { LiveConversationPanel } = await ssr.loadModule<typeof import("../src/LiveConversationPanel.tsx")>(
    "/src/LiveConversationPanel.tsx",
  );
  const render = async (session: Session) => {
    await act(async () => {
      mounted.root.render(createElement(LiveConversationPanel, { session, onClose: () => {} }));
      await flush();
    });
    await act(async () => flush());
  };

  await render(liveSession());
  assert.match(mounted.container.textContent ?? "", /first report/);

  // A status refresh that does not complete a turn leaves the view alone.
  await render(liveSession({ turn_state: { ...turnState("2026-09-26T00:01:00Z"), phase: "working" } }));
  assert.equal(reads.length, 1);

  latestText = "second report";
  await render(liveSession({ turn_state: turnState("2026-09-26T00:02:00Z") }));
  assert.deepEqual(reads.map((read) => read.direction), ["latest", "latest"]);
  assert.match(mounted.container.textContent ?? "", /second report/);

  await act(async () => {
    findButton(mounted.container, "Load older").click();
    await flush();
  });
  assert.match(mounted.container.textContent ?? "", /older ask/);
  await render(liveSession({ turn_state: turnState("2026-09-26T00:03:00Z") }));
  assert.deepEqual(reads.map((read) => read.direction), ["latest", "latest", "older"]);
});

test("a turn that completes while the first page is loading is reread once that load settles", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  const first = deferred<HistoryMessagesResponse>();
  const reads: Array<{ direction?: string }> = [];
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [historyEntry()] }),
    listHistoryMessages: (_machine, _id, options) => {
      reads.push({ ...options });
      return reads.length === 1
        ? first.promise
        : Promise.resolve({ ok: true, messages: [{ id: "fresh", role: "assistant", text: "fresh report" }] });
    },
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  const render = (session: Session) => act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session, onClose: () => {} }));
    await flush();
  });

  await render(liveSession());
  await render(liveSession({ turn_state: turnState("2026-09-26T00:02:00Z") }));
  assert.equal(reads.length, 1, "the pending first read is not aborted by the refresh");
  await act(async () => {
    first.resolve({ ok: true, messages: [{ id: "stale", role: "assistant", text: "stale report" }] });
    await flush();
  });
  await act(async () => flush());

  assert.deepEqual(reads.map((read) => read.direction), ["latest", "latest"]);
  assert.match(mounted.container.textContent ?? "", /fresh report/);
});

test("a turn that completes during Load older keeps the older page instead of snapping to latest", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  const older = deferred<HistoryMessagesResponse>();
  const reads: Array<{ direction?: string }> = [];
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [historyEntry()] }),
    listHistoryMessages: (_machine, _id, options) => {
      reads.push({ ...options });
      if (options?.direction === "older") return older.promise;
      return Promise.resolve({ ok: true, messages: [{ id: "latest", role: "assistant", text: "latest report" }], olderCursor: "older-1" });
    },
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  const render = (session: Session) => act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session, onClose: () => {} }));
    await flush();
  });

  await render(liveSession());
  await act(async () => flush());
  await act(async () => {
    findButton(mounted.container, "Load older").click();
    await flush();
  });
  await render(liveSession({ turn_state: turnState("2026-09-26T00:02:00Z") }));
  await act(async () => {
    older.resolve({ ok: true, messages: [{ id: "old", role: "user", text: "older ask" }] });
    await flush();
  });
  await act(async () => flush());

  assert.deepEqual(reads.map((read) => read.direction), ["latest", "older"]);
  assert.match(mounted.container.textContent ?? "", /older ask/);
  assert.ok(findButton(mounted.container, "Jump to latest"));
});

test("a successful turn refresh clears the error from a failed first load", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  let reads = 0;
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [historyEntry()] }),
    listHistoryMessages: async () => {
      reads += 1;
      return reads === 1
        ? { ok: false, messages: [], error: "history conversation unavailable" }
        : { ok: true, messages: [{ id: "back", role: "assistant", text: "back online" }] };
    },
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  const render = (session: Session) => act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session, onClose: () => {} }));
    await flush();
  });

  await render(liveSession());
  await act(async () => flush());
  assert.ok(mounted.container.querySelector('[role="alert"]'));
  await render(liveSession({ turn_state: turnState("2026-09-26T00:02:00Z") }));
  await act(async () => flush());

  assert.match(mounted.container.textContent ?? "", /back online/);
  assertNoElement(mounted.container, '[role="alert"]', "the stale load error is cleared");
});

test("without latest paging a turn refresh rereads the page the reader is on", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  const reads: Array<{ cursor?: string; direction?: string }> = [];
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, sessions: [historyEntry()] }),
    listHistoryMessages: async (_machine, _id, options) => {
      reads.push({ ...options });
      return options?.cursor === "page-2"
        ? { ok: true, messages: [{ id: `p2-${reads.length}`, role: "assistant", text: `page two read ${reads.length}` }] }
        : { ok: true, messages: [{ id: "p1", role: "user", text: "page one" }], nextCursor: "page-2" };
    },
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  const render = (session: Session) => act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session, onClose: () => {} }));
    await flush();
  });

  await render(liveSession());
  await act(async () => flush());
  await act(async () => {
    findButton(mounted.container, "Next").click();
    await flush();
  });
  await render(liveSession({ turn_state: turnState("2026-09-26T00:02:00Z") }));
  await act(async () => flush());

  assert.deepEqual(reads, [{}, { cursor: "page-2" }, { cursor: "page-2" }]);
  assert.match(mounted.container.textContent ?? "", /page two read 3/);
  assert.ok(findButton(mounted.container, "Previous"));
});

test("the live panel is a drawer on desktop and full screen on mobile", () => {
  const styles = uiStyles();
  assert.match(styles, /\.modal-backdrop\.conversation-backdrop\s*\{[^}]*justify-items:\s*end/);
  assert.match(styles, /\.modal\.conversation-modal\s*\{[^}]*height:\s*100%/);
  assert.match(
    styles,
    /@media \(max-width: 760px\)\s*\{[\s\S]*?\.modal\.conversation-modal\s*\{[^}]*width:\s*100%/,
  );
});

test("Dashboard opens the live panel from the session menu and closes it with Android back", () => {
  const dashboard = uiSource("Dashboard.tsx");
  assert.match(dashboard, /useAndroidBackEntry\("session-conversation-dock", active && conversationSession !== undefined && viewport.width >= 1100/);
  assert.match(uiSource("LiveConversationPanel.tsx"), /androidBackEntry="session-conversation"/);
  assert.match(dashboard, /<LiveConversationPanel[\s\S]*?session=\{conversationSession\}/);
  assert.match(dashboard, /onConversation: s && \(historyMachineNames\.has\(s\.machine\) \|\| \(!viewport\.mobile && sessionListDisplay === "conversation"\)\)/);
  assert.match(dashboard, /\? openConversation : undefined/);
});

function loadPanel(ssr: ReturnType<typeof createUiSsrHarness>) {
  return ssr.loadModule<typeof import("../src/LiveConversationPanel.tsx")>("/src/LiveConversationPanel.tsx");
}

test("live conversation refreshes TUI messages between completed turns without polling older or hidden views", async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  let tick!: () => void;
  let cleared = false;
  Reflect.set(mounted.window, "setTimeout", (callback: () => void, ms: number) => {
    if (ms !== 3000) return 1;
    tick = callback;
    return 538;
  });
  Reflect.set(mounted.window, "clearTimeout", () => { cleared = true; });
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  let text = "first report";
  let reads = 0;
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [historyEntry()] }),
    listHistoryMessages: async (_machine, _id, options) => {
      reads += 1;
      return { ok: true, messages: [{ id: text, role: "user", text }], olderCursor: options?.direction === "older" ? undefined : "older-1" };
    },
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  await act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session: liveSession(), onClose: () => {} }));
    await flush();
  });
  await act(async () => flush());
  assert.equal(typeof tick, "function");
  text = "new input from TUI";
  await act(async () => { tick(); await flush(); });
  assert.match(mounted.container.textContent ?? "", /new input from TUI/);
  assert.equal(reads, 2);
  Object.defineProperty(mounted.window.document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { tick(); await flush(); });
  assert.equal(reads, 2);
  Object.defineProperty(mounted.window.document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { findButton(mounted.container, "Load older").click(); await flush(); });
  const olderReads = reads;
  await act(async () => { tick(); await flush(); });
  assert.equal(reads, olderReads);
  await act(async () => mounted.root.render(null));
  assert.equal(cleared, true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function conversationApiMockPlugin(): Plugin {
  const mockId = "\0live-conversation-api-mock";
  return {
    name: "live-conversation-api-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("sharedOutboxClient.ts")) return "\0shared-admission-fixture";
      if (source.endsWith("resourceEvents.ts")) return "\0conversation-resource-mock";
      return source.endsWith("api.ts") && importer?.includes("/src/") ? mockId : null;
    },
    load(id) {
      if (id === "\0shared-admission-fixture") return sharedAdmissionFixture("globalThis.__agentConsoleConversationApiMock.submitSessionPrompt");
      if (id === "\0conversation-resource-mock") return `
        export const RESOURCE_RECONCILE_MS = 30000;
        export const resourceEvents = { subscribe(_subscription, change, health) {
          globalThis.__agentConsoleConversationResourceChange = change; health(false);
          return () => {};
        }};
      `;
      if (id !== mockId) return null;
      return `
        export * from "/src/api.ts?conversation-original";
        const mock = () => globalThis.__agentConsoleConversationApiMock;
        export const listHistorySessions = (...args) => mock().listHistorySessions(...args);
        export const listHistoryMessages = (...args) => mock().listHistoryMessages(...args);
        export const submitSessionPrompt = (...args) => mock().submitSessionPrompt(...args);
        export const getSpeechProviders = async () => mock().speechProviders ?? [];
        export const transcribeSpeechAudio = async () => ({ text: mock().speechText ?? "" });
      `;
    },
  };
}

function installDom(): { window: Window; root: Root; container: HTMLElement; cleanup(): Promise<void> } {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
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
      Object.assign(globalThis, previous);
      window.close();
    },
  };
}

function findButton(container: ParentNode, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label);
  assert.ok(button, `button ${label} should exist`);
  return button;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function replyPanel(submit: NonNullable<ConversationApiMock['submitSessionPrompt']>, overrides: Partial<Session> = {}, docked = false, openComposer = true) {
  // These cases control local persistence to test draft/focus ownership.
  // Real durable admission and native receipts are covered separately.
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [{ ...historyEntry(), provider: "claude" }] }),
    listHistoryMessages: async () => ({ ok: true, messages: [{ id: 'a1', role: 'assistant', text: 'latest report' }] }),
    submitSessionPrompt: submit,
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  let closed = 0;
  const replyDrafts = new Map();
  const render = (changes: Partial<Session> = {}, dockMode = docked) => act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, {
      session: liveSession({ agent: "claude", provider_resume: { provider: "claude", session_id: "provider-7" }, session_incarnation: 'inc-1', ...overrides, ...changes }),
      replyDrafts,
      docked: dockMode,
      onClose: () => { closed += 1; },
    }));
    await flush();
  });
  await render();
  await act(async () => flush());
  const toggle = () => act(async () => {
    const button = mounted.container.querySelector<HTMLButtonElement>('.conversation-head .conversation-reply-toggle');
    assert.ok(button, 'a narrow conversation offers a reply toggle in its header');
    button.click();
    await flush();
  });
  if (!docked && openComposer) await toggle();
  const textarea = () => {
    const node = mounted.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to session"]');
    assert.ok(node, 'the live conversation offers a reply editor');
    return node;
  };
  const write = (text: string) => act(async () => {
    const node = textarea();
    const key = Object.keys(node).find((item) => item.startsWith('__reactProps$'))!;
    (node as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[key].onChange({ target: { value: text } });
  });
  const send = () => act(async () => {
    const button = mounted.container.querySelector<HTMLButtonElement>('.conversation-composer [aria-label="Send reply"]');
    assert.ok(button); button.click(); await flush();
  });
  return { ...mounted, render, toggle, textarea, write, send, closed: () => closed };
}

test('a live conversation submits one fenced multiline reply and clears only an acknowledged draft', async () => {
  const requests: unknown[][] = [];
  const pending = deferred<{ ok: boolean }>();
  const panel = await replyPanel((...args) => { requests.push(args); return pending.promise; });
  await panel.write('first line\nsecond line');
  await panel.send();
  await panel.send();
  assert.deepEqual(requests, [['maple', 'hs-7', { text: 'first line\nsecond line', expected_session_incarnation: 'inc-1' }]]);
  assert.equal(panel.textarea().value, 'first line\nsecond line');
  assert.equal(panel.textarea().disabled, true);
  await act(async () => { pending.resolve({ ok: true }); await flush(); });
  assert.equal(panel.textarea().value, '');
  assert.doesNotMatch(panel.container.textContent ?? '', /\bSent\b/, 'no Sent notice: the reply is its own bubble (#969)');
});

test('a reply queued behind the running turn counts as sent, with no separate notice', async () => {
  const panel = await replyPanel(async () => ({ ok: true, queued: true }));
  await panel.write('queued task');
  await panel.send();
  assert.equal(panel.textarea().value, '', 'a queued reply is delivered, so its draft is cleared');
  assert.doesNotMatch(panel.container.textContent ?? '', /\bSent\b/, 'no Sent notice: the reply is its own bubble (#969)');
  assert.doesNotMatch(panel.container.textContent ?? '', /may have been sent/);
});

test('native input eligibility is not inferred from busy or attention snapshots', async () => {
  let sends = 0;
  const panel = await replyPanel(async () => { sends += 1; return { ok: true }; });
  await panel.write('next task');
  await panel.render({ turn_state: { ...turnState(), phase: 'working', current_turn: { started_at: '2026-09-26T00:00:00Z' } } });
  assert.equal(panel.container.querySelector<HTMLButtonElement>('[aria-label="Send reply"]')!.disabled, false);
  assert.equal(sends, 0);
  assert.equal(panel.textarea().value, 'next task');
  assert.equal(panel.textarea().placeholder, 'Reply to this session…', 'Working shows in the message list (#942)');
  assertNoElement(panel.container, '.conversation-composer .conversation-hint');
  await panel.render({ turn_state: { ...turnState(), phase: 'needs_input', current_turn: {
    started_at: '2026-09-26T00:00:00Z', attention: {
      kind: 'approval', requested_at: '2026-09-26T00:00:00Z', pending_count: 1, certainty: 'exact',
    },
  } } });
  await panel.send();
  assert.equal(sends, 1, 'native guards own eligibility; the client admits this deliberate input');
  await act(async () => panel.container.querySelector<HTMLButtonElement>('[aria-label="Close conversation"]')!.click());
  assert.equal(panel.closed(), 1);
  await panel.render({ turn_state: turnState() });
  assert.equal(panel.textarea().value, '');
  assert.equal(sends, 1, 'phase changes do not repeat admission');
});

test('a local admission failure keeps the draft and permits retry after storage recovers', async () => {
  let admissions = 0;
  const panel = await replyPanel(async () => ++admissions === 1
    ? { ok: false, error: 'Local storage unavailable' } : { ok: true });
  await panel.write('keep this draft'); await panel.send();
  assert.equal(panel.textarea().value, 'keep this draft');
  assert.match(panel.container.textContent ?? '', /Local storage unavailable/);
  await panel.send(); assert.equal(panel.textarea().value, '');
  assert.equal(admissions, 2);
});

test('a failed voice reply keeps the tagged transcript in the reply composer for retry', async () => {
  let attempts = 0;
  const requests: unknown[][] = [];
  const panel = await replyPanel(async (...args) => {
    requests.push(args);
    return ++attempts === 1 ? { ok: false, error: 'Local storage unavailable' } : { ok: true };
  });
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  cleanups.push(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    if (previousRecorder) Object.defineProperty(globalThis, 'MediaRecorder', previousRecorder);
    else Reflect.deleteProperty(globalThis, 'MediaRecorder');
  });
  globalThis.__agentConsoleConversationApiMock!.speechProviders = [
    { id: 'fixture', label: 'Fixture', max_duration_seconds: 90, max_bytes: 1024 },
  ];
  globalThis.__agentConsoleConversationApiMock!.speechText = 'reviewed voice reply';
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: panel.window.navigator });
  Object.defineProperty(panel.window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
  class FixtureRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
      this.onstop?.();
    }
  }
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FixtureRecorder });
  await act(async () => { findButton(panel.container, 'Voice').click(); await flush(); });
  await panel.write("'report.txt'\n");
  await act(async () => { findButton(panel.window.document, 'Record').click(); await flush(); });
  await act(async () => flush());
  await act(async () => { findButton(panel.window.document, 'Stop recording').click(); await flush(); });
  await act(async () => flush());
  await act(async () => { findButton(panel.window.document, 'Send').click(); await flush(); });
  assert.equal(panel.textarea().value, "'report.txt'\n[語音] reviewed voice reply");
  assert.match(panel.container.textContent ?? '', /Local storage unavailable/);
  assert.deepEqual(requests[0], ['maple', 'hs-7', { text: "'report.txt'\n[語音] reviewed voice reply", expected_session_incarnation: 'inc-1' }]);
  const dialog = panel.window.document.querySelector('[role="dialog"][aria-label="Voice prompt"]');
  assert.ok(dialog, 'failed admission keeps the review dialog open');
  assert.match(dialog.textContent ?? '', /not sent.*remains in your reply draft/i);
  assert.equal([...dialog.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Send'), false);
  assert.equal([...dialog.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Insert to edit'), false);
  await act(async () => { findButton(dialog, 'Return to draft').click(); await flush(); });
  await panel.send();
  assert.equal(panel.textarea().value, '');
  assert.equal(attempts, 2);
  assert.deepEqual(requests[1], ['maple', 'hs-7', { text: "'report.txt'\n[語音] reviewed voice reply", expected_session_incarnation: 'inc-1' }]);
});

test('a voice reply stays fenced to the session incarnation where its dialog opened', async () => {
  const requests: unknown[][] = [];
  const panel = await replyPanel(async (...args) => { requests.push(args); return { ok: true }; });
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  cleanups.push(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    if (previousRecorder) Object.defineProperty(globalThis, 'MediaRecorder', previousRecorder);
    else Reflect.deleteProperty(globalThis, 'MediaRecorder');
  });
  globalThis.__agentConsoleConversationApiMock!.speechProviders = [
    { id: 'fixture', label: 'Fixture', max_duration_seconds: 90, max_bytes: 1024 },
  ];
  globalThis.__agentConsoleConversationApiMock!.speechText = 'reviewed voice reply';
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: panel.window.navigator });
  Object.defineProperty(panel.window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
  class FixtureRecorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
      this.onstop?.();
    }
  }
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FixtureRecorder });
  await act(async () => { findButton(panel.container, 'Voice').click(); await flush(); });
  await panel.render({ session_incarnation: 'inc-2' });
  await act(async () => { findButton(panel.window.document, 'Record').click(); await flush(); });
  await act(async () => flush());
  await act(async () => { findButton(panel.window.document, 'Stop recording').click(); await flush(); });
  await act(async () => flush());
  await act(async () => { findButton(panel.window.document, 'Send').click(); await flush(); });
  assert.deepEqual(requests, [], 'a reviewed voice command is not admitted to the replacement session');
  assert.equal(panel.textarea().value, '[語音] reviewed voice reply');
  assert.match(panel.container.textContent ?? '', /session restarted/i);
});
test('restarting the session fences an existing reply draft until it is explicitly discarded', async () => {
  let sends = 0;
  const panel = await replyPanel(async () => { sends += 1; return { ok: true }; });
  await panel.write('old runtime task');
  await panel.render({ session_incarnation: 'inc-2' });
  await panel.send();
  assert.equal(sends, 0);
  assert.equal(panel.textarea().value, 'old runtime task');
  assert.match(panel.container.textContent ?? '', /session restarted/i);
  await act(async () => findButton(panel.container, 'Discard draft').click());
  await panel.write('new runtime task');
  await panel.send();
  assert.equal(sends, 1);
});

test('stopped, unsupported and unfenced sessions do not admit conversation replies', async () => {
  let sends = 0;
  const panel = await replyPanel(async () => { sends += 1; return { ok: true }; });
  await panel.write('do not send');
  for (const changes of [
    { status: 'stopped' },
    { session_incarnation: undefined },
    { agent: 'other-provider', provider_resume: { provider: 'other-provider', session_id: 'provider-7' } },
  ]) {
    await panel.render(changes);
    await panel.send();
  }
  assert.equal(sends, 0);
});

test('a late submission acknowledgement cannot erase a draft belonging to a restarted session', async () => {
  const pending = deferred<{ ok: boolean }>();
  const panel = await replyPanel(() => pending.promise);
  await panel.write('old draft');
  await panel.send();
  await act(async () => {
    panel.container.querySelector<HTMLButtonElement>('[aria-label="Close conversation"]')?.click();
  });
  assert.equal(panel.closed(), 0, 'an in-flight submission cannot dismiss the panel');
  await panel.render({ session_incarnation: 'inc-2' });
  await act(async () => { pending.resolve({ ok: true }); await flush(); });
  assert.equal(panel.textarea().value, 'old draft');
  assert.match(panel.container.textContent ?? '', /session restarted/i);
});

test('voice opens from an empty composer over a hidden conversation and cancelling restores the composer and focus (#942)', async () => {
  const panel = await replyPanel(async () => { throw new Error('voice must fill a draft'); });
  await act(async () => { panel.container.querySelector<HTMLButtonElement>('.conversation-voice')!.click(); await flush(); });
  assert.equal(panel.container.querySelector('[hidden]')?.hasAttribute('hidden'), true);
  const dialog = panel.window.document.querySelector('[aria-label="Voice prompt"]');
  assert.ok(dialog);
  await act(async () => findButton(dialog as HTMLElement, 'Cancel').click());
  assertNoElement(panel.container, '[hidden]');
  assert.equal(panel.textarea().value, '');
  assertActiveElement(panel.window, panel.textarea());
});


test('a desktop conversation is nonmodal and lets focus and Tab leave for the terminal', async () => {
  const panel = await replyPanel(async () => ({ ok: true }), {}, true);
  assertNoElement(panel.container, '[aria-modal="true"]');
  const dock = panel.container.querySelector('[role="complementary"]');
  assert.ok(dock, 'a wide desktop uses a complementary conversation panel');
  const terminal = panel.window.document.createElement('textarea');
  panel.window.document.body.prepend(terminal);
  terminal.focus();
  terminal.click();
  assertActiveElement(panel.window, terminal);
  const send = panel.container.querySelector<HTMLButtonElement>('.conversation-voice')!;
  send.focus();
  const tab = new panel.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  send.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, false);
  await act(async () => dock.dispatchEvent(new panel.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(panel.closed(), 1);
});

test('a narrow conversation still traps keyboard focus in its modal', async () => {
  const panel = await replyPanel(async () => ({ ok: true }));
  await panel.write('draft');
  assert.ok(panel.container.querySelector('[aria-modal="true"]'));
  const last = findButton(panel.container, 'Send reply');
  last.focus();
  const tab = new panel.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  await act(async () => last.dispatchEvent(tab));
  assert.equal(tab.defaultPrevented, true);
});

test('resizing across the dock breakpoint preserves an in-flight send and its acknowledgement', async () => {
  let sends = 0;
  const pending = deferred<{ ok: boolean }>();
  const panel = await replyPanel(() => { sends += 1; return pending.promise; });
  await panel.write('only once');
  await panel.send();
  for (const docked of [true, false, true]) {
    await panel.render({}, docked);
    assert.equal(panel.textarea().disabled, true);
    await panel.send();
    await act(async () => panel.container.querySelector<HTMLButtonElement>('[aria-label="Close conversation"]')?.click());
    assert.equal(panel.closed(), 0);
  }
  assert.equal(sends, 1);
  await act(async () => { pending.resolve({ ok: true }); await flush(); });
  assert.equal(panel.textarea().value, '');
  assert.doesNotMatch(panel.container.textContent ?? '', /\bSent\b/, 'no Sent notice: the reply is its own bubble (#969)');
});

test('narrowing a docked panel restores modal focus without stealing focus when widened', async () => {
  const panel = await replyPanel(async () => ({ ok: true }), {}, true);
  const terminal = panel.window.document.createElement('textarea');
  panel.window.document.body.prepend(terminal);
  terminal.focus();
  await panel.render({}, false);
  const dialog = panel.container.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.equal(dialog.contains(panel.window.document.activeElement), true);
  await panel.toggle();
  await panel.write('draft');
  const last = findButton(panel.container, 'Send reply');
  last.focus();
  const tab = new panel.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  await act(async () => last.dispatchEvent(tab));
  assert.equal(tab.defaultPrevented, true);
  await panel.render({}, true);
  terminal.focus();
  await panel.render({}, true);
  assertActiveElement(panel.window, terminal);
});

test('a narrow conversation keeps its reply editor collapsed behind a header toggle', async () => {
  const panel = await replyPanel(async () => ({ ok: true }), {}, false, false);
  const toggle = panel.container.querySelector<HTMLButtonElement>('.conversation-head .conversation-reply-toggle');
  assert.ok(toggle, 'the header offers a reply toggle beside close');
  assert.equal(toggle.getAttribute('aria-label'), 'Reply');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  const composer = panel.container.querySelector('.conversation-composer');
  assert.ok(composer);
  assert.equal(composer.hasAttribute('hidden'), true, 'the reply editor starts collapsed');
  assert.equal(
    [...panel.container.querySelectorAll('button')].some((button) => /Return to terminal/.test(button.textContent ?? '')),
    false,
    'the header close button is the only way back to the terminal',
  );

  const close = panel.container.querySelector<HTMLButtonElement>('[aria-label="Close conversation"]');
  assert.ok(close);
  close.focus();
  const tab = new panel.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  await act(async () => close.dispatchEvent(tab));
  assert.equal(tab.defaultPrevented, true, 'Tab wraps inside the modal instead of reaching collapsed reply controls');

  await panel.toggle();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(composer.hasAttribute('hidden'), false);
  assertActiveElement(panel.window, panel.textarea());
  await panel.toggle();
  assert.equal(composer.hasAttribute('hidden'), true);
});

test('a saved reply draft reopens the narrow reply editor', async () => {
  const panel = await replyPanel(async () => ({ ok: true }));
  await panel.write('keep me visible');
  await act(async () => { panel.root.render(null); });
  await panel.render();
  assert.equal(panel.container.querySelector('.conversation-composer')?.hasAttribute('hidden'), false);
  assert.equal(panel.textarea().value, 'keep me visible');
});

test('a docked conversation always shows its reply editor without a toggle', async () => {
  const panel = await replyPanel(async () => ({ ok: true }), {}, true);
  assertNoElement(panel.container, '.conversation-reply-toggle');
  assert.equal(panel.container.querySelector('.conversation-composer')?.hasAttribute('hidden'), false);
});

test('conversation offers icon-only compact paperclip, mic and send controls on the editor row (#942)', async () => {
  const panel = await replyPanel(async () => ({ ok: true }));
  const row = panel.container.querySelector('.conversation-composer-row');
  assert.ok(row);
  const iconOnly = (labels: readonly string[]) => {
    for (const label of labels) {
      const button = row.querySelector(`[aria-label="${label}"]`);
      assert.ok(button, label);
      assert.ok(button.querySelector('svg[aria-hidden="true"]'));
      assert.equal(button.textContent?.trim(), '');
    }
  };
  iconOnly(['Attach files', 'Voice']);
  await panel.write('typed');
  iconOnly(['Attach files', 'Send reply']);
  assert.ok(row.contains(panel.textarea()));
});

test('narrowing a docked panel keeps an active reply editor open', async () => {
  const pending = deferred<{ ok: boolean }>();
  const panel = await replyPanel(() => pending.promise, {}, true);
  await panel.write('typed while docked');
  await panel.render({}, false);
  const composer = () => panel.container.querySelector('.conversation-composer');
  const toggle = () => panel.container.querySelector('.conversation-reply-toggle');
  assert.equal(composer()?.hasAttribute('hidden'), false, 'a saved draft stays visible after narrowing');
  assert.equal(toggle()?.getAttribute('aria-expanded'), 'true');
  await panel.toggle();
  assert.equal(composer()?.hasAttribute('hidden'), true);

  await panel.render({}, true);
  await panel.send();
  await panel.render({}, false);
  assert.equal(composer()?.hasAttribute('hidden'), false, 'an in-flight send stays visible after narrowing');
  assert.equal(panel.container.querySelector('[aria-label="Send reply"]')?.getAttribute('aria-busy'), 'true');
  await act(async () => { pending.resolve({ ok: true }); await flush(); });
  assert.doesNotMatch(panel.container.textContent ?? '', /\bSent\b/, 'no Sent notice: the reply is its own bubble (#969)');
});


test("a resource notification during the initial history read queues a fresh latest read", async () => {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]); cleanups.push(ssr.close);
  const pending = deferred<HistoryMessagesResponse>(); let reads = 0;
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [historyEntry()] }),
    listHistoryMessages: async () => {
      reads += 1;
      return reads === 1 ? pending.promise : { ok: true, messages: [{ id: "fresh", role: "assistant", text: "fresh resource result" }] };
    },
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  await act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session: liveSession(), onClose: () => {} })); await flush();
  });
  assert.equal(reads, 1); assert.ok(globalThis.__agentConsoleConversationResourceChange);
  await act(async () => { globalThis.__agentConsoleConversationResourceChange?.(); await flush(); });
  assert.equal(reads, 1, "only queue while the first read is in flight");
  await act(async () => {
    pending.resolve({ ok: true, messages: [{ id: "stale", role: "assistant", text: "stale initial result" }] }); await flush();
  });
  await act(async () => flush());
  assert.equal(reads, 2); assert.match(mounted.container.textContent ?? "", /fresh resource result/);
});

test('the conversation header offers equal square icon actions: Refresh, Reply, Close', async () => {
  const panel = await replyPanel(async () => ({ ok: true }), {}, false, false);
  const actions = () => [...panel.container.querySelectorAll<HTMLButtonElement>('.conversation-head-actions > button')];
  assert.deepEqual(actions().map((button) => button.getAttribute('aria-label')), ['Refresh conversation', 'Reply', 'Close conversation']);
  for (const button of actions()) {
    const label = button.getAttribute('aria-label');
    assert.equal(button.classList.contains('icon-btn'), true, `${label} is a square icon button`);
    assert.equal(button.querySelector('svg[aria-hidden="true"]') !== null, true, `${label} draws an inline SVG icon`);
    assert.equal(button.textContent?.trim(), '', `${label} carries no text label`);
    assert.ok(button.getAttribute('title'), `${label} has a tooltip`);
  }
  const reply = actions()[1]!;
  assert.equal(reply.getAttribute('aria-controls'), 'conversation-composer');
  assert.equal(reply.getAttribute('aria-expanded'), 'false');
  await panel.toggle();
  assert.equal(reply.getAttribute('aria-expanded'), 'true');
  assert.match(uiStyles(), /\.conversation-reply-toggle\[aria-expanded="true"\]\s*\{[^}]*color:\s*var\(--accent\)/);

  await panel.render({}, true);
  assert.deepEqual(actions().map((button) => button.getAttribute('aria-label')), ['Refresh conversation', 'Close conversation']);
});

test('Refresh rereads the latest messages at once and shows busy until the read settles', async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  const second = deferred<HistoryMessagesResponse>();
  const reads: Array<{ direction?: string }> = [];
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [historyEntry()] }),
    listHistoryMessages: (_machine, _id, options) => {
      reads.push({ ...options });
      return reads.length === 1
        ? Promise.resolve({ ok: true, messages: [{ id: 'a1', role: 'assistant', text: 'first report' }] })
        : second.promise;
    },
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  await act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session: liveSession(), onClose: () => {} }));
    await flush();
  });
  await act(async () => flush());
  assert.match(mounted.container.textContent ?? '', /first report/);
  const refresh = () => mounted.container.querySelector<HTMLButtonElement>('[aria-label="Refresh conversation"]');
  assert.equal(refresh()?.disabled, false);

  refresh()?.focus();
  await act(async () => { refresh()?.click(); await flush(); });
  assert.deepEqual(reads.map((read) => read.direction), ['latest', 'latest'], 'Refresh reads without waiting for the poll');
  assert.equal(refresh()?.getAttribute('aria-disabled'), 'true', 'a running refresh reads as disabled');
  assert.equal(refresh()?.getAttribute('aria-busy'), 'true');
  assertActiveElement(mounted.window, refresh(), 'keyboard focus stays on Refresh inside the dialog');
  await act(async () => { refresh()?.click(); await flush(); });
  assert.equal(reads.length, 2, 'a running refresh cannot be stacked');

  await act(async () => {
    second.resolve({ ok: true, messages: [{ id: 'a2', role: 'assistant', text: 'second report' }] });
    await flush();
  });
  assert.match(mounted.container.textContent ?? '', /second report/);
  assert.equal(refresh()?.getAttribute('aria-disabled'), 'false');
  assert.equal(refresh()?.getAttribute('aria-busy'), 'false');
});

test('conversation messages render as formatted Markdown, not literal syntax', async () => {
  const mounted = installDom();
  cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]);
  cleanups.push(ssr.close);
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [historyEntry()] }),
    listHistoryMessages: async () => ({
      ok: true,
      messages: [{
        id: 'a1',
        role: 'assistant',
        text: 'Release is **blocked** on `v1.31.7`.\n\n- first item\n- **second** item\n\n```sh\npnpm test\n```',
      }],
    }),
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  await act(async () => {
    mounted.root.render(createElement(LiveConversationPanel, { session: liveSession(), onClose: () => {} }));
    await flush();
  });
  await act(async () => flush());

  const message = mounted.container.querySelector('.history-message.is-assistant');
  assert.equal(message?.querySelector('.message-markdown strong')?.textContent, 'blocked');
  assert.equal(message?.querySelectorAll('ul > li').length, 2);
  assert.equal(message?.querySelector('p code')?.textContent, 'v1.31.7');
  assert.equal(message?.querySelector('pre > code')?.textContent?.trim(), 'pnpm test');
  assert.doesNotMatch(message?.textContent ?? '', /\*\*|```/);
});

test('the conversation header icon actions sit 4px apart so the title keeps more room', () => {
  const rule = uiStyles().match(/\.conversation-head > \.conversation-head-actions \{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /gap:\s*var\(--space-2xs\)/);
  assert.match(uiStyles(), /--space-2xs:\s*0\.25rem/);
});

for (const view of ["panel", "tile"]) test(`${view} applies pushed pages without refetch, replaces reconnect snapshots and fences a stale latest-page fetch`, async () => {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]); cleanups.push(ssr.close);
  let reads = 0;
  const pending = deferred<HistoryMessagesResponse>();
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [historyEntry()] }),
    listHistoryMessages: async () => { reads++; return reads === 1 ? { ok: true, messages: [{ id: "a1", role: "assistant", text: "initial" }] } : pending.promise; },
  };
  const component = view === "panel" ? (await loadPanel(ssr)).LiveConversationPanel
    : (await ssr.loadModule<typeof import("../src/SessionConversationPane.tsx")>("/src/SessionConversationPane.tsx")).SessionConversationPane;
  await act(async () => { mounted.root.render(createElement(component as any, { session: liveSession(), machineReachable: true, onClose() {} })); await flush(); });
  await act(async () => flush());
  const emit = async (messages: import("../src/types.ts").HistoryMessage[]) => {
    await act(async () => { globalThis.__agentConsoleConversationResourceChange?.({ schema_version: "agent-console.resource-event.v1", resource: "conversation/maple/history-7", type: "changed", revision: 1, conversation: { messages } }); await flush(); });
  };
  await emit([{ id: "a1", role: "assistant", text: "updated in place" }, { id: "a2", role: "assistant", text: "pushed" }]);
  assert.equal(reads, 1, "the event supplies the page; no redundant HTTP read");
  assert.match(mounted.container.textContent ?? "", /pushed/);
  await act(async () => {
    globalThis.__agentConsoleConversationResourceChange?.({ schema_version: "agent-console.resource-event.v1", resource: "conversation/maple/previous-history", type: "changed", revision: 9,
      conversation: { messages: [{ id: "wrong", role: "assistant", text: "another conversation" }] } }); await flush();
  });
  assert.doesNotMatch(mounted.container.textContent ?? "", /another conversation/, "late previous-resource snapshot cannot paint the current conversation");
  assert.equal(reads, 1, "a previous-resource event must not trigger a current-resource fetch");
  await act(async () => { globalThis.__agentConsoleConversationResourceChange?.(); await flush(); });
  assert.equal(reads, 2, "metadata-only old edge retains HTTP fallback");
  const page = [{ id: "a1", role: "assistant" as const, text: "updated in place" }, { id: "a2", role: "assistant" as const, text: "pushed" }, { id: "a3", role: "assistant" as const, text: "missed while disconnected" }];
  await emit(page); await emit(page);
  await act(async () => { pending.resolve({ ok: true, messages: [{ id: "stale", role: "assistant", text: "stale HTTP page" }] }); await flush(); });
  assert.deepEqual([...mounted.container.querySelectorAll("[data-history-message-id]")].map(node => node.getAttribute("data-history-message-id")), ["a1", "a2", "a3"]);
  assert.doesNotMatch(mounted.container.textContent ?? "", /stale HTTP page/);
});

for (const outcome of ["success", "failure"]) for (const timing of ["before loading render", "after loading render"]) test(`a snapshot preserves older-page navigation ${timing} on ${outcome}`, async () => {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness([conversationApiMockPlugin()]); cleanups.push(ssr.close);
  const pending = deferred<HistoryMessagesResponse>(); const reads: unknown[] = [];
  globalThis.__agentConsoleConversationApiMock = {
    listHistorySessions: async () => ({ ok: true, truncated: false, latestMessagePaging: true, sessions: [historyEntry()] }),
    listHistoryMessages: async (_machine, _id, options) => {
      reads.push(options);
      return reads.length === 1 ? { ok: true, messages: [{ id: "a1", role: "assistant", text: "initial latest" }], olderCursor: "older" }
        : reads.length === 2 ? pending.promise : { ok: true, messages: [{ id: "a2", role: "assistant", text: "refreshed after failure" }] };
    },
  };
  const { LiveConversationPanel } = await loadPanel(ssr);
  await act(async () => { mounted.root.render(createElement(LiveConversationPanel, { session: liveSession(), onClose() {} })); await flush(); });
  await act(async () => flush());
  const push = () => globalThis.__agentConsoleConversationResourceChange?.({ schema_version: "agent-console.resource-event.v1", resource: "conversation/maple/history-7", type: "changed", revision: 2,
    conversation: { messages: [{ id: "a2", role: "assistant", text: "new latest must wait" }] } });
  await act(async () => {
    findButton(mounted.container, "Load older").click();
    if (timing === "before loading render") push();
    await flush();
  });
  assert.deepEqual(reads[1], { direction: "older", cursor: "older" });
  if (timing === "after loading render") await act(async () => { push(); await flush(); });
  await act(async () => { pending.resolve(outcome === "success" ? { ok: true, messages: [{ id: "old", role: "user", text: "older history" }] } : { ok: false, messages: [], error: "older request failed" }); await flush(); });
  await act(async () => flush());
  assert.deepEqual([...mounted.container.querySelectorAll("[data-history-message-id]")].map(node => node.getAttribute("data-history-message-id")), outcome === "success" ? ["old", "a1"] : ["a2"]);
  assert.equal(reads.length, outcome === "success" ? 2 : 3);
  assert.doesNotMatch(mounted.container.textContent ?? "", /new latest must wait/);
});

test('LINE message rows omit names, group avatars, separate days and keep times outside bubbles', async () => {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness(); cleanups.push(ssr.close);
  const { HistoryConversationView } = await ssr.loadModule<typeof import('../src/HistoryConversation.tsx')>('/src/HistoryConversation.tsx');
  const messages = [
    {id:'a1',role:'assistant',text:'**First**',timestamp:'2026-09-01T09:01:00'},
    {id:'a2',role:'assistant',text:'Second',timestamp:'2026-09-01T09:02:00'},
    {id:'u1',role:'user',text:'Question',timestamp:'2026-09-01T09:03:00'},
    {id:'a3',role:'assistant',text:'New run',timestamp:'2026-09-01T09:04:00'},
    {id:'a4',role:'assistant',text:'New day',timestamp:'2026-09-02T09:05:00'},
  ] as const;
  await act(async () => mounted.root.render(createElement(HistoryConversationView, {
    conversation: {session:historyEntry(),messages,latestMessagePaging:true,loading:false,viewportRef:{current:null}} as unknown as import('../src/HistoryConversation.tsx').HistoryConversation,
    onJumpToLatest() {},
  })));
  const rows = [...mounted.container.querySelectorAll('.history-message')];
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(row => row.querySelectorAll('.agent-badge').length), [1,0,0,1,1]);
  for (const row of rows) {
    assertNoElement(row, 'header');
    const bubble = row.querySelector('.history-bubble'); assert.ok(bubble);
    const time = row.querySelector('time'); assert.ok(time);
    assert.equal(bubble.contains(time), false);
    assert.match(time.textContent ?? '', /^09:0[1-5]$/);
    if (row.classList.contains('is-user')) assert.equal(time.nextElementSibling === bubble, true);
    else assert.equal(bubble.nextElementSibling === time, true);
  }
  assert.equal(rows[0]?.querySelector('strong')?.textContent, 'First');
  assert.deepEqual([...mounted.container.querySelectorAll('.history-day-separator')].map(day => day.textContent), ['2026/9/1','2026/9/2']);
});

test('shared conversation rows expose every speaker to assistive technology without visible author names', async () => {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness(); cleanups.push(ssr.close);
  const { HistoryConversationView } = await ssr.loadModule<typeof import('../src/HistoryConversation.tsx')>('/src/HistoryConversation.tsx');
  const messages = [
    {id:'a1',role:'assistant',text:'First reply'},
    {id:'a2',role:'assistant',text:'Continued reply'},
    {id:'u1',role:'user',text:'First question'},
    {id:'u2',role:'user',text:'Continued question'},
    {id:'g1',role:'goal',text:'First objective'},
    {id:'g2',role:'goal',text:'Continued objective'},
  ] as const;
  for (const provider of ['codex', 'claude', undefined] as const) {
    await act(async () => mounted.root.render(createElement(HistoryConversationView, {
      conversation: {session:provider ? {...historyEntry(),provider} : undefined,messages,latestMessagePaging:true,loading:false,viewportRef:{current:null}} as unknown as import('../src/HistoryConversation.tsx').HistoryConversation,
      onJumpToLatest() {},
    })));
    const rows = [...mounted.container.querySelectorAll('article.history-message')];
    assert.deepEqual(rows.map(row => row.getAttribute('aria-label')), [provider ?? 'Agent',provider ?? 'Agent','You','You','Goal','Goal']);
    assert.deepEqual(rows.map(row => row.querySelector('.history-bubble')?.textContent), ['First reply','Continued reply','First question','Continued question','GoalFirst objective','GoalContinued objective']);
    for (const row of rows) assertNoElement(row, 'header');
    for (const avatar of mounted.container.querySelectorAll('.agent-badge')) {
      assert.equal(avatar.getAttribute('aria-hidden'), 'true');
    }
  }
});

// #1043: Claude records a user turn that carried a paste wrapped in
// <pasted_content id="…">; the tags are markup and are not shown.
test('a user turn wrapped only by a paste marker shows its inner text without tags', async () => {
  const mounted = installDom(); cleanups.push(mounted.cleanup);
  const ssr = createUiSsrHarness(); cleanups.push(ssr.close);
  const { HistoryConversationView } = await ssr.loadModule<typeof import('../src/HistoryConversation.tsx')>('/src/HistoryConversation.tsx');
  const wrapped = (text: string, open = 'a1b2', close = open) => `\n\n<pasted_content id="${open}">\n${text}\n</pasted_content id="${close}">\n`;
  const messages = [
    {id:'u1',role:'user',text:wrapped('Run the build')},
    {id:'u2',role:'user',text:wrapped('Run the build', 'a1b2', 'ffff')},
    {id:'u3',role:'user',text:`See ${wrapped('this paste')}`},
    {id:'a1',role:'assistant',text:wrapped('Agent text')},
    {id:'u4',role:'user',text:wrapped(wrapped('Nested', 'c3d4'))},
  ] as const;
  await act(async () => mounted.root.render(createElement(HistoryConversationView, {
    conversation: {session:historyEntry(),messages,latestMessagePaging:true,loading:false,viewportRef:{current:null}} as unknown as import('../src/HistoryConversation.tsx').HistoryConversation,
    onJumpToLatest() {},
  })));
  const bubbles = [...mounted.container.querySelectorAll('.history-bubble')].map(node => node.textContent ?? '');
  assert.equal(bubbles[0], 'Run the build', 'the outer wrapper is removed');
  for (const index of [1, 2, 3, 4]) assert.match(bubbles[index] ?? '', /pasted_content/, `message ${index} is shown unchanged`);
  assert.match(bubbles[4] ?? '', /<pasted_content id="c3d4">/, 'only one wrapper layer is removed');
});

test('composer starts at one row, grows for measured wraps to 120px, scrolls and resets after send', async () => {
  const panel = await replyPanel(async () => ({ok:true}));
  const editor = panel.textarea();
  assert.equal(Number(editor.rows), 1);
  assert.equal(editor.style.height, '34px');
  let measuredHeight = 54;
  Object.defineProperty(editor, 'scrollHeight', {get: () => measuredHeight});
  await panel.write('two lines\nwrapped');
  assert.equal(editor.style.height, '54px');
  assert.equal(editor.style.overflowY, 'hidden');
  measuredHeight = 240;
  await panel.write('long draft');
  assert.equal(editor.style.height, '120px');
  assert.equal(editor.style.overflowY, 'auto');
  await panel.send();
  assert.equal(editor.value, '');
  assert.equal(editor.style.height, '34px');
  assert.equal(editor.style.overflowY, 'hidden');
});

for (const view of ["panel", "tile", "phone"] as const) test(`${view} refresh honors scrolling during an in-flight latest request`,async()=>{
  const mounted=installDom();cleanups.push(mounted.cleanup);
  const ssr=createUiSsrHarness([conversationApiMockPlugin()]);cleanups.push(ssr.close);
  const pending=deferred<HistoryMessagesResponse>();let reads=0;
  globalThis.__agentConsoleConversationApiMock={
    listHistorySessions:async()=>({ok:true,truncated:false,latestMessagePaging:true,sessions:[historyEntry()]}),
    listHistoryMessages:async()=>++reads===1?{ok:true,messages:[{id:"a1",role:"assistant",text:"old conversation"}]}:pending.promise,
  };
  const session=liveSession();
  const component=view==="panel"?"LiveConversationPanel":view==="tile"?"SessionConversationPane":"PhoneConversationPane";
  const module=await ssr.loadModule<Record<string,import("react").ComponentType<any>>>(`/src/${component}.tsx`);
  await act(async()=>{mounted.root.render(createElement(module[component]!,{session,machineReachable:true,onClose(){},replyDrafts:new Map(),swipeEnabled:false,onSwipe(){},refreshRef:{current:null}}));await flush();});
  await act(async()=>flush());
  const viewport=mounted.container.querySelector<HTMLElement>(".history-messages");assert.ok(viewport);
  Object.defineProperties(viewport,{scrollHeight:{configurable:true,get:()=>1000},clientHeight:{configurable:true,get:()=>200}});
  viewport.scrollTop=800;
  await act(async()=>{mounted.window.dispatchEvent(new mounted.window.Event("focus"));await flush();});
  assert.equal(reads,2);
  viewport.scrollTop=300;
  viewport.dispatchEvent(new mounted.window.Event("scroll"));
  await act(async()=>{pending.resolve({ok:true,messages:[{id:"a1",role:"assistant",text:"old conversation"},{id:"a2",role:"assistant",text:"new conversation"}]});await flush();});
  assert.equal(viewport.scrollTop,300,"a refresh must not undo the reader's manual scroll");
});
