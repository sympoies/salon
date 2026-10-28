import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { refreshSessionInfo } from "../src/api.ts";
import { mergeRefreshedSession } from "../src/sessionRefresh.ts";
import {
  SessionRefreshContext,
  useSessionRefresh,
  type SessionRefreshOutcome,
  type SessionRefreshState,
} from "../src/useSessionRefresh.ts";
import type { Session } from "../src/types.ts";
import { jsonResponse, restoreFetch, setFetchMock } from "./fetchHelper.ts";

afterEach(restoreFetch);

const session = (overrides: Partial<Session> = {}): Session => ({
  id: "s1", agent: "codex", status: "running", machine: "fixture", title: "Before", title_revision: 1,
  session_incarnation: "inc-1", model: "model-a", reasoning_effort: "low", cwd: "/work", ...overrides,
});
const refreshBody = (record: Record<string, unknown> = {}, changed: string[] = ["model"]) => ({
  ok: true,
  data: {
    machine: "fixture",
    refresh: {
      session_id: "s1", changed, unavailable: ["account"],
      session: { id: "s1", agent: "codex", session_incarnation: "inc-1", model: "model-b", reasoning_effort: "high", ...record },
    },
  },
});

test("refreshSessionInfo posts to the session route and returns only a validated record", async () => {
  let call: { url: string; method?: string } | undefined;
  setFetchMock((url, init) => {
    call = { url, method: init?.method };
    return jsonResponse(refreshBody({ title: "After", title_revision: 2 }, ["model", "title"]));
  });
  const ok = await refreshSessionInfo({ machine: "fixture", id: "s1" });
  assert.deepEqual(call, { url: "/api/sessions/fixture/s1/refresh", method: "POST" });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.changed, ["model", "title"]);
  assert.deepEqual(ok.unavailable, ["account"]);
  assert.equal(ok.session.model, "model-b");
  assert.equal(ok.session.title, "After");

  const other = await refreshSessionInfo({ machine: "other-host", id: "s1" });
  assert.equal(other.ok, false, "a record answered for another machine is not trusted");
});

test("refreshSessionInfo reports the edge's reason, and a typed unsupported host, as failures", async () => {
  setFetchMock(() => jsonResponse({ ok: false, error: { code: "session-refresh-unsupported", message: "This host cannot refresh session info yet." } }, { status: 501 }));
  assert.deepEqual(await refreshSessionInfo({ machine: "fixture", id: "s1" }), {
    ok: false, code: "session-refresh-unsupported", error: "This host cannot refresh session info yet.",
  });
  setFetchMock(() => jsonResponse(refreshBody({ id: "s2" })));
  const wrongSession = await refreshSessionInfo({ machine: "fixture", id: "s1" });
  assert.equal(wrongSession.ok, false);
  setFetchMock(() => { throw new TypeError("network"); });
  assert.deepEqual(await refreshSessionInfo({ machine: "fixture", id: "s1" }), {
    ok: false, error: "Could not reach the console server.",
  });
});

test("a refreshed record updates only the facts a refresh re-reads on the matching session", () => {
  const other = session({ id: "s2" });
  const list = [session({ last_prompt: { text: "keep me" } as Session["last_prompt"] }), other];
  const merged = mergeRefreshedSession(list, "fixture", {
    id: "s1", session_incarnation: "inc-1", model: "model-b", reasoning_effort: "high", title: "After", title_revision: 2,
    context_usage: { used_tokens: 10, window_tokens: 100, source: "codex-rollout", observed_at: "2026-10-07T00:00:00Z", model: "model-b" },
    status: "closed", cwd: "/elsewhere",
  });
  assert.equal(merged[1], other, "other sessions keep their identity");
  assert.equal(merged[0]!.model, "model-b");
  assert.equal(merged[0]!.reasoning_effort, "high");
  assert.equal(merged[0]!.title, "After");
  assert.equal(merged[0]!.title_revision, 2);
  assert.equal(merged[0]!.context_usage?.used_tokens, 10);
  assert.equal(merged[0]!.status, "running", "lifecycle and location stay with the list poll");
  assert.equal(merged[0]!.cwd, "/work");
  assert.deepEqual(merged[0]!.last_prompt, { text: "keep me" });

  assert.equal(mergeRefreshedSession(list, "other-host", { id: "s1", model: "x" }), list);
  assert.equal(mergeRefreshedSession(list, "fixture", { id: "s1", session_incarnation: "inc-2", model: "x" }), list,
    "a record of a replaced runtime is not applied");
  assert.equal(mergeRefreshedSession(list, "fixture", { id: "gone", model: "x" }), list);
});

interface Mounted { states: SessionRefreshState[]; refresh: ReturnType<typeof useSessionRefresh>["refresh"]; unmount(): Promise<void> }

async function mount(refresh: (target: { machine: string; id: string }) => Promise<SessionRefreshOutcome>): Promise<Mounted> {
  const window = new Window({ url: "https://console.test" });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const mounted: Mounted = {
    states: [], refresh: undefined as never,
    async unmount() {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous);
      await window.happyDOM.close();
    },
  };
  function Probe() {
    const hook = useSessionRefresh();
    mounted.refresh = hook.refresh;
    if (mounted.states.at(-1) !== hook.state) mounted.states.push(hook.state);
    return null;
  }
  await act(async () => {
    root.render(createElement(SessionRefreshContext.Provider, { value: { refresh } }, createElement(Probe)));
  });
  return mounted;
}

test("the refresh hook reports progress then success, and ignores a second tap while one is running", async () => {
  let release!: (outcome: SessionRefreshOutcome) => void;
  const targets: { machine: string; id: string }[] = [];
  const mounted = await mount(target => { targets.push(target); return new Promise(resolve => { release = resolve; }); });
  try {
    let first!: Promise<SessionRefreshState>;
    let second!: Promise<SessionRefreshState>;
    await act(async () => {
      first = mounted.refresh({ machine: "fixture", id: "s1" });
      second = mounted.refresh({ machine: "fixture", id: "s1" });
    });
    assert.deepEqual(mounted.states.map(state => state.status), ["idle", "refreshing"]);
    await act(async () => release({ ok: true, changed: ["model"] }));
    const done = await first;
    assert.equal(await second, done, "the second tap shares the running refresh");
    assert.equal(targets.length, 1);
    assert.deepEqual(done, { status: "updated", message: "Session info updated", changed: ["model"] });
    assert.deepEqual(mounted.states.map(state => state.status), ["idle", "refreshing", "updated"]);
  } finally {
    await mounted.unmount();
  }
});

test("the refresh hook reports the failure reason and allows a retry", async () => {
  const outcomes: SessionRefreshOutcome[] = [{ ok: false, message: "This host cannot refresh session info yet." }, { ok: true, changed: [] }];
  const mounted = await mount(async () => outcomes.shift()!);
  try {
    let failed!: SessionRefreshState;
    await act(async () => { failed = await mounted.refresh({ machine: "fixture", id: "s1" }); });
    assert.deepEqual(failed, { status: "failed", message: "This host cannot refresh session info yet." });
    let retried!: SessionRefreshState;
    await act(async () => { retried = await mounted.refresh({ machine: "fixture", id: "s1" }); });
    assert.equal(retried.status, "updated");
    assert.deepEqual(mounted.states.at(-1), { status: "updated", message: "Session info updated", changed: [] });
  } finally {
    await mounted.unmount();
  }
});

test("the refresh hook is inert outside the dashboard and survives an unmount mid-request", async () => {
  const window = new Window({ url: "https://console.test" });
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div");
  const root = createRoot(container);
  let hook!: ReturnType<typeof useSessionRefresh>;
  function Probe() { hook = useSessionRefresh(); return null; }
  try {
    await act(async () => root.render(createElement(Probe)));
    let state!: SessionRefreshState;
    await act(async () => { state = await hook.refresh({ machine: "fixture", id: "s1" }); });
    assert.equal(state.status, "failed");
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
  }

  let release!: (outcome: SessionRefreshOutcome) => void;
  const mounted = await mount(() => new Promise(resolve => { release = resolve; }));
  let pending!: Promise<SessionRefreshState>;
  await act(async () => { pending = mounted.refresh({ machine: "fixture", id: "s1" }); });
  await mounted.unmount();
  release({ ok: true, changed: [] });
  assert.equal((await pending).status, "updated");
});
