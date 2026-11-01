import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test, afterEach } from "node:test";
import { normalizeActivityStreamEvent } from "@agent-console/shared/activity";
import type { SessionTitleState } from "@agent-console/shared/title";
import {
  getAuthStatus,
  createSession,
  fetchRepoRemoteUrl,
  fetchSessionBuffer,
  glance,
  killSession,
  resultOf,
  listSessions,
  listMachinePreferences,
  updateMachinePreference,
  resetSessionPollRequests,
  attachTarget,
  listHistorySessions,
  listHistoryMessages,
  archiveSession,
  setHistoryStar,
  resumeHistorySession,
  lookupLiveHistorySession,
  usage,
  resetCodexRateLimit,
  resetClaudeLimit,
  fetchLayoutOrder,
  runDebugDiagnostics,
  putLayoutOrder,
  resumeSession,
  inspectSessionMaintenance,
  executeSessionMaintenanceAction,
  setSessionAutoResume,
  listAccounts,
  switchSessionAccount,
  cancelSessionAutoResume,
  sendSessionInput,
  submitSessionPrompt,
  summarizeSessionTitle,
  fetchSessionRetitleReadiness,
  fetchSessionRetitleV3Operation,
  fetchSessionRetitleV3Readiness,
  requestSessionRetitle,
  requestSessionRetitleV3,
  updateSessionTitle,
  updateSessionTitleMode,
  searchWorkdirs,
  uploadAttachment,
  getSpeechProviders,
  transcribeSpeechAudio,
} from "../src/api.ts";
import { saveServerUrl, saveToken } from "../src/runtime.ts";
import {
  SESSION_RETITLE_CAPABILITY,
  SESSION_RETITLE_READINESS_SCHEMA_VERSION,
  SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
  SESSION_RETITLE_SCHEMA_VERSION,
  SESSION_RETITLE_V3_CAPABILITY,
  SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION,
  SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION,
  SESSION_RETITLE_V3_SCHEMA_VERSION,
} from "@agent-console/shared/session-retitle";
import { clearDebugEvents, debugEvents } from "../src/debugLog.ts";
import { startPerformanceCapture, stopPerformanceCapture } from "../src/performanceSummary.ts";
import { jsonResponse, restoreFetch, setFetchMock } from "./fetchHelper.ts";

test("host preference client projects safe account values and sends explicit reason and initial-only intent", async () => {
  const row = { name: "fixture-host", enabled: false, active: false, last_change: { actor: "principal:fixture", reason: "Maintenance", at: "2026-10-13T00:00:00Z", revision: 1 } };
  setFetchMock(async () => jsonResponse({ ok: true, data: { machines: [{ ...row, token: "not-projected" }] } }));
  assert.deepEqual(await listMachinePreferences(), { ok: true, machines: [row] });
  setFetchMock(async () => jsonResponse({ ok: true, data: { machines: [{ ...row, enabled: "false" }] } }));
  assert.deepEqual(await listMachinePreferences(), { ok: false, machines: [] });
  const writes: unknown[] = [];
  setFetchMock(async (url, init) => {
    assert.match(url, /\/api\/machine-preferences\/fixture-host$/); assert.equal(init?.method, "PUT");
    writes.push(JSON.parse(String(init?.body))); return jsonResponse({ ok: true });
  });
  assert.equal((await updateMachinePreference("fixture-host", false, "Maintenance")).ok, true);
  assert.equal((await updateMachinePreference("fixture-host", true, "Device migration", true)).ok, true);
  assert.deepEqual(writes, [{ enabled: false, reason: "Maintenance" }, { enabled: true, reason: "Device migration", initialize_only: true }]);
});

afterEach(() => {
  restoreFetch();
  clearDebugEvents();
});

async function withNativeHttp(
  send: (url: string, method: string, rid: number) => Promise<unknown> | unknown,
  run: () => Promise<void>,
): Promise<void> {
  const priorWindow = (globalThis as { window?: unknown }).window;
  const priorStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const store = new Map<string, string>();
  const urls = new Map<number, { url: string; method: string }>();
  const readBodies = new Set<number>();
  let nextRid = 0;
  (globalThis as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
  (globalThis as { window: unknown }).window = {
    location: { protocol: "tauri:", host: "" },
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { clientConfig?: { url: string; method: string }; rid?: number }) => {
        if (command === "plugin:http|fetch") {
          const rid = ++nextRid;
          urls.set(rid, { url: args.clientConfig!.url, method: args.clientConfig!.method });
          return rid;
        }
        if (command === "plugin:http|fetch_send") {
          const rid = args.rid!;
          const request = urls.get(rid)!;
          return {
            status: 200, statusText: "OK", url: request.url, headers: {}, rid,
            ...(await send(request.url, request.method, rid) as object),
          };
        }
        if (command === "plugin:http|fetch_read_body") {
          if (readBodies.has(args.rid!)) return [1];
          readBodies.add(args.rid!);
          const body = store.get(`response:${args.rid}`) ?? "";
          return [...new TextEncoder().encode(body), 0];
        }
        return undefined;
      },
    },
  };
  saveServerUrl("https://old.example");
  saveToken("old-token");
  try {
    await run();
  } finally {
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window: unknown }).window = priorWindow;
    if (priorStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage: unknown }).localStorage = priorStorage;
  }
}

test("concurrent native attaches obtain distinct one-time tickets", async () => {
  let postCount = 0;
  await withNativeHttp((url, method, rid) => {
    assert.equal(method, "POST");
    assert.match(url, /\/attach-ticket$/);
    postCount += 1;
    (globalThis as { localStorage: { setItem(k: string, v: string): void } }).localStorage
      .setItem(`response:${rid}`, JSON.stringify({ ok: true, data: { ticket: `ticket-${postCount}` } }));
  }, async () => {
    const [first, second] = await Promise.all([attachTarget("maple", "s1"), attachTarget("maple", "s1")]);
    assert.equal(postCount, 2);
    assert.notEqual(first.url, second.url);
    assert.match(first.url, /ticket=ticket-1$/);
    assert.match(second.url, /ticket=ticket-2$/);
  });
});

test("capture records a native request still pending after the caller deadline", async () => {
  await withNativeHttp(async () => new Promise(() => {}), async () => {
    const storage = (globalThis as { localStorage: Storage }).localStorage;
    startPerformanceCapture("slow-network", storage);
    try {
      await assert.rejects(listSessions(["maple"]), { name: "TimeoutError" });
      const rows = debugEvents().filter((row) => row.source === "client" &&
        (row.route === "/api/sessions" || row.route === "/performance/session-list"));
      assert.equal(rows.filter((row) => row.phase === "request_start").length, 1);
      assert.equal(rows.filter((row) => row.phase === "deadline_timeout").length, 1);
      assert.equal(rows.some((row) => row.route === "/api/sessions" && row.ok !== null), false);
    } finally {
      stopPerformanceCapture(storage);
    }
  });
});

test("capture separates admission rejection from elapsed native poll deadlines", async () => {
  await withNativeHttp(async () => new Promise(() => {}), async () => {
    const storage = (globalThis as { localStorage: Storage }).localStorage;
    startPerformanceCapture("slow-network", storage);
    try {
      await assert.rejects(listSessions(["maple"], undefined, "poll"), { name: "TimeoutError" });
      await assert.rejects(listSessions(["maple"], undefined, "poll"), { name: "TimeoutError" });
      await assert.rejects(listSessions(["maple"], undefined, "poll"), { name: "TimeoutError" });
      const rows = debugEvents().filter((row) => row.source === "client");
      assert.equal(rows.filter((row) => row.phase === "request_start").length, 2);
      assert.equal(rows.filter((row) => row.phase === "deadline_timeout").length, 2);
      assert.equal(rows.filter((row) => row.phase === "capacity_rejected").length, 1);
    } finally {
      stopPerformanceCapture(storage);
      resetSessionPollRequests();
    }
  });
});

test("native poll cannot share a request across server or token changes", async () => {
  let releaseOld!: () => void;
  let requestCount = 0;
  await withNativeHttp(async (url, method, rid) => {
    assert.equal(method, "GET");
    requestCount += 1;
    if (url.startsWith("https://old.example")) {
      await new Promise<void>((resolve) => { releaseOld = resolve; });
    }
    (globalThis as { localStorage: { setItem(k: string, v: string): void } }).localStorage
      .setItem(`response:${rid}`, JSON.stringify({ ok: true, data: { sessions: [] } }));
  }, async () => {
    const controller = new AbortController();
    const old = listSessions(["maple"], controller.signal, "poll");
    while (!releaseOld) await new Promise((resolve) => setTimeout(resolve, 0));
    saveServerUrl("https://new.example");
    saveToken("new-token");
    controller.abort();
    await assert.rejects(old, { name: "AbortError" });
    const current = await listSessions(["maple"], undefined, "poll");
    assert.equal(current.ok, true);
    assert.equal(requestCount, 2);
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

test("a post-mutation fresh list does not join a pending poll snapshot", async () => {
  let releasePoll!: () => void;
  let calls = 0;
  setFetchMock(async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise<void>((resolve) => { releasePoll = resolve; });
      return jsonResponse({ ok: true, data: { sessions: [{ machine: "maple", id: "old" }] } });
    }
    return jsonResponse({ ok: true, data: { sessions: [{ machine: "maple", id: "new" }] } });
  });
  const poll = listSessions(["maple"], undefined, "poll");
  while (!releasePoll) await new Promise((resolve) => setTimeout(resolve, 0));
  const fresh = await listSessions(["maple"]);
  assert.equal(calls, 2);
  assert.equal(fresh.sessions[0]?.id, "new");
  resetSessionPollRequests();
  releasePoll();
  await assert.rejects(poll, { name: "AbortError" });
});

test("session-list debug events distinguish automatic polls from fresh reads", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions: [] } }));
  resetSessionPollRequests();
  await listSessions(undefined, undefined, "poll");
  await listSessions();
  assert.deepEqual(
    debugEvents().filter((event) => event.route === "/api/sessions").map((event) => event.provenance),
    ["poll", "fresh"],
  );
});

test("showing all hosts keeps session polling to one aggregate request per tick", async () => {
  const paths: string[] = [];
  setFetchMock(async (input) => {
    paths.push(String(input));
    return jsonResponse({ ok: true, data: { sessions: [] } });
  });
  resetSessionPollRequests();
  await listSessions(["host-a"], undefined, "poll");
  const beforeAllHosts = paths.length;
  await listSessions(["host-a", "host-b", "host-c"], undefined, "poll");
  const afterAllHosts = paths.length - beforeAllHosts;
  assert.equal(beforeAllHosts, 1, "the one-host baseline uses one aggregate request");
  assert.equal(afterAllHosts, 1, "showing three hosts still uses one aggregate request");
  assert.deepEqual(paths, ["/api/sessions?machines=host-a", "/api/sessions?machines=host-a,host-b,host-c"]);
  resetSessionPollRequests();
});

test("speech upload carries audio while debug events retain no recording or transcript", async () => {
  const transcript = "不要刪除 src/main.ts";
  const audio = new Blob(["private-audio-canary"], { type: "audio/webm" });
  let uploaded: BodyInit | null | undefined;
  setFetchMock(async (url, init) => {
    if (url === "/api/speech/providers") {
      return jsonResponse({ ok: true, data: { providers: [{ id: "summit", label: "Summit GPU", max_duration_seconds: 45, max_bytes: 8388608 }] } });
    }
    uploaded = init?.body;
    assert.equal(url, "/api/speech/summit/transcriptions");
    assert.equal(new Headers(init?.headers).get("content-type"), "audio/webm");
    return jsonResponse({ ok: true, data: { text: transcript, language: "Chinese", provider: "summit" } });
  });

  assert.equal((await getSpeechProviders())[0]?.label, "Summit GPU");
  assert.deepEqual(await transcribeSpeechAudio("summit", audio), { text: transcript, language: "Chinese", provider: "summit", engine: null, label: null });
  assert.equal(uploaded, audio);
  assert.doesNotMatch(JSON.stringify(debugEvents()), /private-audio-canary|不要刪除/);
});

test("speech transcription returns the optional response label unchanged", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { text: "hello", language: null, provider: "summit", label: " Fast · local " } }));
  assert.equal((await transcribeSpeechAudio("summit", new Blob(["audio"], { type: "audio/webm" }))).label, " Fast · local ");
});

test("cancelling speech transcription aborts its network request", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  setFetchMock(async (_url, init) => {
    observedSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      observedSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  const pending = transcribeSpeechAudio("summit", new Blob(["audio"], { type: "audio/webm" }), controller.signal);
  await Promise.resolve();
  assert.equal(observedSignal, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("getAuthStatus normalizes principal capabilities without retaining credentials", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    authenticated: true,
    openAccess: false,
    principal: {
      id: "tess",
      permissions: ["debug", "usage"],
      token: "must-not-project",
    },
  }));
  assert.deepEqual(await getAuthStatus(), {
    authenticated: true,
    openAccess: false,
    principal: { id: "tess", permissions: ["debug", "usage"] },
  });
});

test("getAuthStatus fails closed when native startup authentication rejects", async () => {
  await withNativeHttp(() => {
    throw new Error("Native connection unavailable");
  }, async () => {
    assert.deepEqual(await getAuthStatus(), {
      authenticated: false,
      openAccess: false,
      principal: null,
      startupFailure: "transport",
      connectFailure: "unreachable",
    });
  });
});

test("getAuthStatus settles a native startup request that ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  await withNativeHttp(() => {
    requestStarted();
    return new Promise<never>(() => undefined);
  }, async () => {
    let result: Awaited<ReturnType<typeof getAuthStatus>> | undefined;
    let failure: unknown;
    void getAuthStatus().then(value => { result = value; }, error => { failure = error; });
    await started;
    t.mock.timers.tick(8_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(failure, undefined);
    assert.deepEqual(result, {
      authenticated: false,
      openAccess: false,
      principal: null,
      startupFailure: "timeout",
      connectFailure: "unreachable",
    }, "the initial auth read must finish even when native HTTP ignores abort");
    const events = debugEvents().filter(event => event.route === "/api/auth/status");
    assert.equal(events.length, 1, "a transport that never settles still records its startup deadline");
    assert.equal(events[0]?.error, "Authentication startup timed out");
    assert.equal(events[0]?.ok, false);
    assert.equal(events[0]?.status, null);
  });
});

test("unreachable native API startup uses the remaining Android boot deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  await withNativeHttp(() => {
    requestStarted();
    return new Promise<never>(() => undefined);
  }, async () => {
    Object.assign(window, {
      agentConsoleAndroidBoot: { elapsedMs: () => 2_500 },
      navigator: { userAgent: "Android" },
    });
    let result: Awaited<ReturnType<typeof getAuthStatus>> | undefined;
    void getAuthStatus({ initialStartup: true }).then(value => { result = value; });
    await started;
    t.mock.timers.tick(3_499);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(result, undefined);
    t.mock.timers.tick(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(result?.startupFailure, "timeout", "native init/bundle time counts toward the six-second recovery deadline");
    assert.equal(result?.authenticated, false);
  });
});

test("connection retries have a fresh deadline after the Android boot deadline expired", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  await withNativeHttp(() => {
    requestStarted();
    return new Promise<never>(() => undefined);
  }, async () => {
    Object.assign(window, { agentConsoleAndroidBoot: { elapsedMs: () => 60_000 } });
    let result: Awaited<ReturnType<typeof getAuthStatus>> | undefined;
    void getAuthStatus().then(value => { result = value; });
    await started;
    t.mock.timers.tick(7_999);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(result, undefined);
    t.mock.timers.tick(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(result?.startupFailure, "timeout");
  });
});

test("history APIs normalize bounded public fields and never project daemon paths", async () => {
  const requestedUrls: string[] = [];
  setFetchMock(async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("/messages")) {
      return jsonResponse({
        ok: true,
        data: {
          messages: [
            { id: "m-1", role: "user", text: "hello", timestamp: "2026-08-31T00:00:00Z", path: "/private/transcript" },
            { id: "g-1", role: "goal", text: "Repair retitle", internal_context: "private" },
          ],
          next_cursor: "42",
          older_cursor: "21",
        },
      });
    }
    return jsonResponse({
      ok: true,
      data: {
        sessions: [{
          id: "h-123",
          provider: "codex",
          provider_session_id: "provider-1",
          cwd: "/repo/agent-console",
          repo_name: "agent-console",
          created_at: "2026-08-30T00:00:00Z",
          updated_at: "2026-08-31T00:00:00Z",
          resumable: true,
          title: "Release follow-up",
          prompt_preview: "legacy first prompt",
          first_user_prompt_preview: "first human prompt",
          last_user_prompt_preview: "latest human prompt",
          transcript_path: "/private/transcript",
        }],
        next_cursor: "50",
        truncated: false,
        capabilities: { latest_message_paging: true, resume: true, private_capability: true },
      },
    });
  });
  assert.deepEqual(await listHistorySessions("summit"), {
    ok: true,
    sessions: [{
      id: "h-123",
      machine: "summit",
      provider: "codex",
      provider_session_id: "provider-1",
      cwd: "/repo/agent-console",
      repo_name: "agent-console",
      created_at: "2026-08-30T00:00:00Z",
      updated_at: "2026-08-31T00:00:00Z",
      resumable: true,
      title: "Release follow-up",
      prompt_preview: "legacy first prompt",
      first_user_prompt_preview: "first human prompt",
      last_user_prompt_preview: "latest human prompt",
    }],
    nextCursor: "50",
    truncated: false,
    latestMessagePaging: true,
    resumeAvailable: true,
  });
  assert.deepEqual(await listHistoryMessages("summit", "h-123", { direction: "latest" }), {
    ok: true,
    messages: [
      { id: "m-1", role: "user", text: "hello", timestamp: "2026-08-31T00:00:00Z" },
      { id: "g-1", role: "goal", text: "Repair retitle" },
    ],
    nextCursor: "42",
    olderCursor: "21",
  });
  assert.match(requestedUrls.at(-1) ?? "", /direction=latest/);
});

test("history messages admit the notice role only for a valid envelope without images", async () => {
  const text = "<!-- agent-notice:v1 kind=mailbox source=fixture id=sample-1 -->\n\nSynthetic update";
  setFetchMock(async () => jsonResponse({ ok: true, data: { messages: [
    { id: "n1", role: "notice", text, timestamp: "2026-08-31T00:00:00Z" },
    { id: "n2", role: "notice", text: "plain text, not an envelope" },
    { id: "n3", role: "notice", text, images: [{ id: `${"a".repeat(16)}.0.0.${"b".repeat(32)}` }] },
    { id: "u1", role: "user", text: "hello" },
  ] } }));
  assert.deepEqual(await listHistoryMessages("summit", "h-123"), {
    ok: true,
    messages: [{ id: "n1", role: "notice", text, timestamp: "2026-08-31T00:00:00Z" }, { id: "u1", role: "user", text: "hello" }],
  });
});

test("history API drops old-daemon dsh rows and preserves supported providers", async () => {
  const row = {
    id: "h-1", provider: "codex", provider_session_id: "provider-1", cwd: "/workspace/example",
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:01Z", resumable: true,
  };
  setFetchMock(async () => jsonResponse({ ok: true, data: {
    sessions: [row, { ...row, id: "retired", provider: "dsh" }, { ...row, id: "h-2", provider: "claude" }],
    truncated: false,
  } }));
  const result = await listHistorySessions("host-a");
  assert.equal(result.ok, true);
  assert.deepEqual(result.sessions.map(({ id, provider }) => ({ id, provider })), [
    { id: "h-1", provider: "codex" }, { id: "h-2", provider: "claude" },
  ]);
});

test("archiveSession posts an incarnation fence to the distinct archive route", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenBody: unknown;
  setFetchMock(async (input, init) => {
    seenPath = String(input);
    seenMethod = init?.method ?? "GET";
    seenBody = JSON.parse(String(init?.body));
    return jsonResponse({ ok: true, data: {
      archived: {
        id: "h-123",
        provider: "codex",
        provider_session_id: "provider-1",
        cwd: "/repo/agent-console",
        created_at: "2026-08-30T00:00:00Z",
        updated_at: "2026-08-31T00:00:00Z",
        resumable: false,
      },
      deleted: { id: "live-1", deleted: true, killed: true, cleanup_pending: false },
    } });
  });
  assert.deepEqual(await archiveSession("summit", "live-1", "launch-1"), { ok: true });
  assert.equal(seenPath, "/api/sessions/summit/live-1/archive");
  assert.equal(seenMethod, "POST");
  assert.deepEqual(seenBody, { expected_session_incarnation: "launch-1" });

  setFetchMock(async () => jsonResponse({ ok: true, data: { archived: { id: "h-123" } } }));
  assert.deepEqual(await archiveSession("summit", "live-1", "launch-1"), {
    ok: false,
    error: "invalid session archive acknowledgement",
  });
});

// resultOf maps an edge {ok,data,error} envelope + HTTP status to {ok,error}.
// The key case: a 2xx with an empty/absent body must read as success (the edge
// forwards {ok:true} for an empty 2xx daemon reply), never a false failure.

test("2xx with ok:true is success", () => {
  assert.deepEqual(resultOf({ status: 200, body: { ok: true } }), { ok: true });
});

test("killSession requires a matching logical tombstone acknowledgement and preserves cleanup pending", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { deleted: { id: "worker-1", deleted: true, killed: false, cleanup_pending: true } },
  }, { status: 200 }));
  assert.deepEqual(await killSession("summit", "worker-1"), { ok: true, cleanupPending: true });

  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { deleted: { id: "replacement", deleted: true, killed: true, cleanup_pending: false } },
  }, { status: 200 }));
  assert.deepEqual(await killSession("summit", "worker-1"), {
    ok: false,
    error: "invalid session delete acknowledgement",
  });
});

test("listSessions ignores retired orchestration metadata", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: [{
        id: "main-1",
        agent: "codex",
        status: "running",
        machine: "summit",
        orchestration: {
          schema_version: "agent-session.session-orchestration.v1",
          run_id: "run-1",
          role: "main",
          relationship_revision: 3,
          run_state: "active",
          objective_summary: "Ship orchestration",
          private_packet: { prompt: "secret" },
        },
      }],
      machines: [{ name: "summit", ok: true }],
    },
  }, { status: 200 }));

  const response = await listSessions(["summit"]);
  assert.doesNotMatch(JSON.stringify(response.sessions[0]), /private_packet|prompt|secret/);
  assert.equal("orchestration" in response.sessions[0]!, false);
});

test("session machine activity metadata survives normalization without accepting malformed flags", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions: [], machines: [
    { name: "fixture-active", ok: true },
    { name: "fixture-retired", ok: false, active: false },
    { name: "fixture-malformed", ok: false, active: "false" },
  ] } }));
  const result = await listSessions();
  assert.deepEqual(result.machines, [
    { name: "fixture-active", ok: true },
    { name: "fixture-retired", ok: false, active: false },
    { name: "fixture-malformed", ok: false },
  ]);
});

test("listSessions accepts last_prompt_state only through edge and machine capability agreement", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: [
        {
          id: "supported",
          agent: "codex",
          status: "running",
          machine: "maple",
          last_prompt_state: "pending",
        },
        {
          id: "old-machine",
          agent: "codex",
          status: "running",
          machine: "m2",
          last_prompt_state: "pending",
        },
      ],
      machines: [
        { name: "maple", ok: true, capabilities: { last_prompt: true } },
        { name: "m2", ok: true },
      ],
      capabilities: { last_prompt: true },
    },
  }));

  const supported = await listSessions();
  assert.equal(supported.sessions[0]?.last_prompt_state, "pending");
  assert.equal(supported.sessions[1]?.last_prompt_state, undefined);
  assert.equal(supported.capabilities?.last_prompt, true);

  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: [{
        id: "old-edge",
        agent: "codex",
        status: "running",
        machine: "maple",
        last_prompt_state: "pending",
      }],
      machines: [{ name: "maple", ok: true, capabilities: { last_prompt: true } }],
    },
  }));
  assert.equal((await listSessions()).sessions[0]?.last_prompt_state, undefined);
});

test("listSessions drops contradictory prompts under the negotiated state contract", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: [
        {
          id: "pending",
          agent: "codex",
          status: "running",
          machine: "maple",
          last_prompt_state: "pending",
          last_prompt: { text: "stale pending prompt", truncated: false },
        },
        {
          id: "malformed",
          agent: "codex",
          status: "running",
          machine: "maple",
          last_prompt_state: "future",
          last_prompt: { text: "untrusted future prompt", truncated: false },
        },
        {
          id: "legacy",
          agent: "codex",
          status: "running",
          machine: "maple",
          last_prompt: { text: "legacy prompt", truncated: false },
        },
      ],
      machines: [{ name: "maple", ok: true, capabilities: { last_prompt: true } }],
      capabilities: { last_prompt: true },
    },
  }));

  const response = await listSessions();
  assert.equal(response.sessions[0]?.last_prompt, undefined);
  assert.equal(response.sessions[1]?.last_prompt, undefined);
  assert.equal(response.sessions[1]?.last_prompt_state, undefined);
  assert.deepEqual(response.sessions[2]?.last_prompt, { text: "legacy prompt", truncated: false });
});

test("listSessions preserves absent/valid turn state and clears partial or future contracts", async () => {
  const sessions = [
    { id: "old", agent: "codex", status: "running", machine: "summit" },
    {
      id: "valid",
      agent: "codex",
      status: "running",
      machine: "summit",
      runtime_started_at: "2026-07-10T11:44:02Z",
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "waiting",
        phase_changed_at: "2026-07-10T12:05:00Z",
        revision: 7,
        source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
        current_turn: null,
        last_turn: { completed_at: "2026-07-10T12:05:00Z", outcome: "completed" },
      },
    },
    {
      id: "partial",
      agent: "claude",
      status: "running",
      machine: "summit",
      turn_state: { schema_version: "agent-session.turn-state.v1" },
    },
    {
      id: "mixed",
      agent: "claude",
      status: "running",
      machine: "summit",
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "needs_input",
        phase_changed_at: "2026-07-10T12:09:18Z",
        revision: 8,
        source: { kind: "provider_hook", provider: "claude", confidence: "observed" },
        current_turn: {
          started_at: "2026-07-10T12:07:46Z",
          last_progress_at: "2026-07-10T12:09:30Z",
          attention: { kind: "clarification", requested_at: "2026-07-10T12:09:18Z", pending_count: 1 },
        },
      },
    },
    {
      id: "future",
      agent: "codex",
      status: "running",
      machine: "summit",
      turn_state: { schema_version: "agent-session.turn-state.v99", phase: "working" },
    },
  ];
  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions, machines: [{ name: "summit", ok: true }] } }));

  const result = await listSessions(["summit"]);
  const canonicalValidSession = structuredClone(sessions[1]) as Record<string, any>;
  delete canonicalValidSession.turn_state.current_turn;
  const canonicalMixedSession = structuredClone(sessions[3]) as Record<string, any>;
  canonicalMixedSession.turn_state.current_turn.attention.certainty = "conservative";

  assert.deepEqual(result.sessions, [
    { ...sessions[0], retitle_path: "legacy_edge" },
    { ...canonicalValidSession, retitle_path: "legacy_edge" },
    { ...sessions[2], turn_state: null, retitle_path: "legacy_edge" },
    { ...canonicalMixedSession, retitle_path: "legacy_edge" },
    { ...sessions[4], turn_state: null, retitle_path: "legacy_edge" },
  ]);
});

test("listSessions keeps only bounded launch profile ids on session records", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: [
        { id: "profiled", agent: "claude", agent_profile: "custom-claude", status: "running", machine: "maple" },
        { id: "unsafe", agent: "claude", agent_profile: "../unsafe", status: "running", machine: "maple" },
      ],
      machines: [{ name: "maple", ok: true }],
    },
  }));

  const result = await listSessions(["maple"]);
  assert.equal(result.sessions[0]?.agent_profile, "custom-claude");
  assert.equal(Object.hasOwn(result.sessions[1] ?? {}, "agent_profile"), false);
});

test("listSessions omits malformed title CAS capability fields", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: [{
        id: "bad-cas",
        agent: "codex",
        status: "running",
        machine: "summit",
        title_revision: "4",
        session_incarnation: "   ",
      }],
      machines: [{ name: "summit", ok: true }],
    },
  }));

  assert.deepEqual((await listSessions()).sessions, [{
    id: "bad-cas",
    agent: "codex",
    status: "running",
    machine: "summit",
    retitle_path: "legacy_edge",
  }]);
});

test("listSessions preserves explicit structured-title capability without requiring title state", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: [
        {
          id: "supported-valid",
          agent: "codex",
          status: "running",
          machine: "summit",
          title_state_supported: true,
          title_state: {
            topic: "  Retitle   rules ",
            topic_source: "auto",
            references: ["#317", "#317"],
            activity: " Implement contract ",
          },
        },
        {
          id: "supported-invalid",
          agent: "codex",
          status: "running",
          machine: "summit",
          title_state_supported: true,
          title_state: { topic: "Retitle rules", topic_source: "future", references: [], activity: null },
        },
        {
          id: "supported-empty",
          agent: "codex",
          status: "running",
          machine: "summit",
          title_state_supported: true,
        },
        {
          id: "old-daemon",
          agent: "codex",
          status: "running",
          machine: "summit",
        },
        {
          id: "invalid-capability",
          agent: "codex",
          status: "running",
          machine: "summit",
          title_state_supported: false,
        },
      ],
      machines: [{ name: "summit", ok: true }],
    },
  }));

  const sessions = (await listSessions()).sessions;
  assert.deepEqual(sessions[0]?.title_state, {
    topic: "Retitle rules",
    topic_source: "auto",
    references: ["#317"],
    activity: "Implement contract",
  });
  assert.equal(sessions[0]?.title_state_supported, true);
  assert.equal(Object.hasOwn(sessions[1] ?? {}, "title_state"), false);
  assert.equal(sessions[1]?.title_state_supported, true);
  assert.equal(sessions[2]?.title_state_supported, true);
  assert.equal(Object.hasOwn(sessions[2] ?? {}, "title_state"), false);
  assert.equal(Object.hasOwn(sessions[3] ?? {}, "title_state_supported"), false);
  assert.equal(Object.hasOwn(sessions[4] ?? {}, "title_state_supported"), false);
});

test("glance normalizes valid title state and drops malformed state without clearing capability", async () => {
  const responses = [
    {
      id: "valid",
      title_state_supported: true,
      title_state: {
        topic: "  Retitle   rules ",
        topic_source: "auto",
        references: ["#317", "#317"],
        activity: " Implement contract ",
      },
    },
    {
      id: "invalid",
      title_state_supported: true,
      title_state: { topic: "Retitle rules", topic_source: "future", references: [], activity: null },
    },
  ];
  setFetchMock(async () => jsonResponse({ ok: true, data: { glance: responses.shift() } }));

  assert.deepEqual(await glance("maple", "valid"), {
    id: "valid",
    title_state_supported: true,
    title_state: {
      topic: "Retitle rules",
      topic_source: "auto",
      references: ["#317"],
      activity: "Implement contract",
    },
  });
  assert.deepEqual(await glance("maple", "invalid"), {
    id: "invalid",
    title_state_supported: true,
  });
});

test("nils permission attention normalizes identically over poll and stream transports", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../../shared/test/fixtures/nils-1120-permission-attention-event.json", import.meta.url),
    "utf8",
  ));
  const projection = fixture.sessions[0];
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: [{
        id: projection.id,
        agent: "codex",
        status: "running",
        machine: "summit",
        turn_state: projection.turn_state,
      }],
      machines: [{ name: "summit", ok: true }],
    },
  }));

  const polled = await listSessions(["summit"]);
  const streamed = normalizeActivityStreamEvent(fixture, "summit");

  assert.ok(streamed?.type === "snapshot");
  assert.deepEqual(polled.sessions[0]?.turn_state, streamed.sessions[0]?.turn_state);
  assert.equal(polled.sessions[0]?.turn_state?.current_turn?.attention?.kind, "other");
});

test("nils nullable multi-session snapshot normalizes identically over poll and stream transports", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../../shared/test/fixtures/nils-1120-nullable-multi-session-event.json", import.meta.url),
    "utf8",
  ));
  const pollSessions = fixture.sessions.map((projection: { id: string; turn_state: Record<string, any> }) => {
    const turnState = structuredClone(projection.turn_state);
    if (turnState.source.provider === null) delete turnState.source.provider;
    for (const field of ["current_turn", "last_turn"]) {
      if (turnState[field] === null) delete turnState[field];
    }
    for (const [turnField, optionalFields] of [
      ["current_turn", ["provider_turn_id", "last_progress_at", "attention"]],
      ["last_turn", ["provider_turn_id", "started_at"]],
    ] as const) {
      for (const optionalField of optionalFields) {
        if (turnState[turnField]?.[optionalField] === null) delete turnState[turnField][optionalField];
      }
    }
    return {
      id: projection.id,
      agent: projection.id.includes("waiting") ? "claude" : "codex",
      status: "running",
      machine: "summit",
      turn_state: turnState,
    };
  });
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { sessions: pollSessions, machines: [{ name: "summit", ok: true }] },
  }));

  const polled = await listSessions(["summit"]);
  const streamed = normalizeActivityStreamEvent(fixture, "summit");

  assert.ok(streamed?.type === "snapshot");
  assert.equal(streamed.sessions.length, fixture.sessions.length);
  assert.deepEqual(
    polled.sessions.map((session) => session.turn_state),
    streamed.sessions.map((session) => session.turn_state),
  );
});

test("nils canonical producer fixture decodes identically over poll and stream transports", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../../shared/test/fixtures/nils-1120-ff24ea72-activity-stream-v1-multi-session.json", import.meta.url),
    "utf8",
  ));
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: fixture.sessions.map((projection: { id: string; turn_state: unknown }) => ({
        id: projection.id,
        agent: "codex",
        status: "running",
        machine: "summit",
        turn_state: projection.turn_state,
      })),
      machines: [{ name: "summit", ok: true }],
    },
  }));

  const polled = await listSessions(["summit"]);
  const streamed = normalizeActivityStreamEvent(fixture, "summit");

  assert.ok(streamed?.type === "snapshot");
  assert.deepEqual(
    polled.sessions.map((session) => session.turn_state),
    streamed.sessions.map((session) => session.turn_state),
  );
});

test("provider activity evidence metadata has poll and stream parity", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../../shared/test/fixtures/nils-provider-activity-evidence-v1.json", import.meta.url),
    "utf8",
  ));
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: fixture.sessions.map((projection: { id: string; turn_state: unknown }) => ({
        id: projection.id,
        agent: projection.id.includes("unknown") ? "codex" : "claude",
        status: "running",
        machine: "summit",
        turn_state: projection.turn_state,
      })),
      machines: [{ name: "summit", ok: true }],
    },
  }));

  const polled = await listSessions(["summit"]);
  const streamed = normalizeActivityStreamEvent(fixture, "summit");

  assert.ok(streamed?.type === "snapshot");
  assert.deepEqual(
    polled.sessions.map((session) => session.turn_state),
    streamed.sessions.map((session) => session.turn_state),
  );
  assert.equal(polled.sessions[0]?.turn_state?.semantic_event?.kind, "progress");
  assert.equal(
    polled.sessions[0]?.turn_state?.current_turn?.attention?.certainty,
    "conservative",
  );
  assert.equal(polled.sessions[1]?.turn_state?.phase, "working");
  assert.equal(polled.sessions[1]?.turn_state?.semantic_event, undefined);
  assert.equal(polled.sessions[1]?.turn_state?.diagnostic, undefined);
  assert.equal(polled.sessions[1]?.turn_state?.shadow_observation, undefined);
  assert.doesNotMatch(JSON.stringify(polled.sessions), /privacy-canary/);
  assert.doesNotMatch(JSON.stringify(streamed.sessions), /privacy-canary/);
});

test("API requests carry a correlation id and record redacted debug metadata", async () => {
  let seenRequestId = "";
  setFetchMock(async (_url, init) => {
    seenRequestId = new Headers(init?.headers).get("x-agent-console-request-id") ?? "";
    return jsonResponse({ ok: true, data: { machines: [] } });
  });

  await createSession("summit", {
    agent: "codex",
    cwd: "/home/runner/private",
    prompt: "Bearer client-secret should not be logged",
  });

  assert.match(seenRequestId, /^acreq_/);
  const events = debugEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.source, "client");
  assert.equal(events[0]?.method, "POST");
  assert.equal(events[0]?.route, "/api/sessions/:machine");
  assert.equal(events[0]?.status, 200);
  assert.equal(events[0]?.request_id, seenRequestId);
  assert.equal(JSON.stringify(events).includes("client-secret"), false);
  assert.equal(JSON.stringify(events).includes("/home/runner/private"), false);
});

test("runDebugDiagnostics probes core edge routes and records correlated events", async () => {
  const seen: Array<{ url: string; requestId: string }> = [];
  setFetchMock(async (url, init) => {
    seen.push({
      url,
      requestId: new Headers(init?.headers).get("x-agent-console-request-id") ?? "",
    });
    if (url === "/healthz") {
      return jsonResponse({ ok: true, service: "agent-console-edge" });
    }
    if (url === "/api/debug/events") {
      return jsonResponse({ ok: true, data: { events: [], generated_at: "2026-07-07T00:00:00.000Z", max_events: 1000 } });
    }
    return jsonResponse({ ok: true, data: {} });
  });

  const result = await runDebugDiagnostics();

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.probes.map((probe) => probe.route),
    [
      "/healthz",
      "/api/auth/status",
      "/api/machines",
      "/api/sessions",
      "/api/usage",
      "/api/layout",
      "/api/debug/events",
    ],
  );
  assert.equal(seen.every((request) => /^acreq_/.test(request.requestId)), true);
  assert.equal(result.probes.every((probe) => /^acreq_/.test(probe.request_id ?? "")), true);
  assert.equal(debugEvents().some((event) => event.route === "/healthz"), true);
  assert.equal(debugEvents().some((event) => event.route === "/api/debug/events"), true);
});

test("runDebugDiagnostics includes extension probes and preserves their unreachable failure", async () => {
  setFetchMock(async url => jsonResponse({ ok: true, data: url === "/api/extra-reader" ? { reachable: false, error: "reader unavailable" } : {} }));
  const result = await runDebugDiagnostics([{ name: "Extra reader", route: "/api/extra-reader" }]);
  assert.equal(result.ok, false);
  const probe = result.probes.find(probe => probe.route === "/api/extra-reader");
  assert.equal(probe?.name, "Extra reader");
  assert.equal(probe?.error, "reader unavailable");
});

test("runDebugDiagnostics marks a reachable:false reader as a diagnostic failure", async () => {
  setFetchMock(async (url) => {
    if (url === "/api/usage") {
      return jsonResponse({ ok: true, data: { reachable: false, error: "usage reader status 502" } });
    }
    return jsonResponse({ ok: true, data: {} });
  });

  const result = await runDebugDiagnostics();
  const usageProbe = result.probes.find((probe) => probe.route === "/api/usage");

  assert.equal(result.ok, false);
  assert.equal(usageProbe?.ok, false);
  assert.equal(usageProbe?.error, "usage reader status 502");
});

test("runDebugDiagnostics reports a replaced machine runtime and its deployed version", async () => {
  setFetchMock(async (url) => {
    if (url === "/api/machines") return jsonResponse({ ok: true, data: { machines: [{ name: "cedar" }] } });
    if (url === "/api/machines/cedar/runtime/health") return jsonResponse({ ok: true, data: {
      machine: "cedar",
      runtime: {
        state: "unavailable",
        binary_version: "1.29.1",
        executable_state: "replaced",
        reasons: ["runtime-executable-replaced"],
      },
    } });
    return jsonResponse({ ok: true, data: {} });
  });

  const result = await runDebugDiagnostics();
  const runtime = result.probes.find((probe) => probe.route === "/api/machines/cedar/runtime/health");
  assert.equal(result.ok, false);
  assert.equal(runtime?.ok, false);
  assert.equal(runtime?.version, "1.29.1");
  assert.equal(runtime?.error, "runtime-executable-replaced");
});

test("runDebugDiagnostics accepts an available runtime with unknown executable state", async () => {
  setFetchMock(async (url) => {
    if (url === "/api/machines") return jsonResponse({ ok: true, data: { machines: [{ name: "maple" }] } });
    if (url === "/api/machines/maple/runtime/health") return jsonResponse({ ok: true, data: {
      machine: "maple",
      runtime: { state: "available", binary_version: "1.29.2", executable_state: "unknown", reasons: [] },
    } });
    return jsonResponse({ ok: true, data: {} });
  });

  const result = await runDebugDiagnostics();
  assert.equal(result.ok, true);
  assert.equal(result.probes.find((probe) => probe.route === "/api/machines/maple/runtime/health")?.ok, true);
});

test("runDebugDiagnostics retains results when the machine inventory is unavailable", async () => {
  setFetchMock(async (url) => {
    if (url === "/api/machines") throw new Error("offline");
    return jsonResponse({ ok: true, data: {} });
  });

  const result = await runDebugDiagnostics();
  assert.equal(result.ok, false);
  assert.equal(result.probes.find((probe) => probe.route === "/api/machines")?.ok, false);
});

test("2xx with an empty-forwarded body is success", () => {
  assert.deepEqual(resultOf({ status: 200, body: { ok: true, data: undefined } }), { ok: true });
});

test("non-2xx is a failure with the edge error message", () => {
  assert.deepEqual(resultOf({ status: 503, body: { ok: false, error: { message: "daemon status 503" } } }), {
    ok: false,
    error: "daemon status 503",
  });
});

test("2xx but ok:false is a failure", () => {
  const r = resultOf({ status: 200, body: { ok: false, error: { message: "bad" } } });
  assert.equal(r.ok, false);
  assert.equal(r.error, "bad");
});

test("fetchSessionBuffer returns the daemon buffer text and hits the buffer route", async () => {
  let seen = "";
  setFetchMock(async (url) => {
    seen = url;
    return jsonResponse({ ok: true, data: { machine: "summit", text: "picked selection" } });
  });
  const text = await fetchSessionBuffer("summit", "hs-claude-1");
  assert.equal(text, "picked selection");
  assert.match(seen, /\/api\/sessions\/summit\/hs-claude-1\/buffer$/);
});

test("fetchSessionBuffer is empty-safe on a missing text, a non-2xx, and a thrown fetch", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { machine: "summit" } }));
  assert.equal(await fetchSessionBuffer("summit", "x"), "");
  setFetchMock(async () => jsonResponse({ ok: false, error: { message: "nope" } }, { status: 503 }));
  assert.equal(await fetchSessionBuffer("summit", "x"), "");
  setFetchMock(async () => {
    throw new Error("network down");
  });
  assert.equal(await fetchSessionBuffer("summit", "x"), "");
});

test("fetchRepoRemoteUrl unwraps the machine repo URL and is empty-safe", async () => {
  let seen = "";
  setFetchMock(async (url) => {
    seen = url;
    return jsonResponse({ ok: true, data: { machine: "maple", url: "https://github.com/exampleOrg/agent-console" } });
  });
  assert.equal(
    await fetchRepoRemoteUrl("maple", "/home/runner/Project/summit/agent-console"),
    "https://github.com/exampleOrg/agent-console",
  );
  assert.equal(seen, "/api/machines/maple/repo-url?cwd=%2Fhome%2Frunner%2FProject%2Fsummit%2Fagent-console");

  assert.equal(await fetchRepoRemoteUrl("maple", ""), "");
  setFetchMock(async () => jsonResponse({ ok: true, data: { machine: "maple", url: null } }));
  assert.equal(await fetchRepoRemoteUrl("maple", "/repo"), "");
  setFetchMock(async () => jsonResponse({ ok: false, error: { message: "nope" } }, { status: 503 }));
  assert.equal(await fetchRepoRemoteUrl("maple", "/repo"), "");
  setFetchMock(async () => {
    throw new Error("network down");
  });
  assert.equal(await fetchRepoRemoteUrl("maple", "/repo"), "");
});

test("failure without a message falls back to the status", () => {
  const r = resultOf({ status: 422, body: undefined });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /422/);
});

test("usage unwraps providers + reachable, and treats an absent body as unreachable", async () => {
  setFetchMock(async () =>
    jsonResponse({
      ok: true,
      data: {
        reachable: true,
        providers: [
          {
            provider: "codex",
            label: "Codex",
            ok: true,
            stale: false,
            plan: "chatgpt",
            updated_at: 1783288000,
            windows: [{ key: "5h", label: "5h", used_percent: 86, window_minutes: 300, resets_at: 1783288112 }],
          },
        ],
      },
    }),
  );
  const u = await usage();
  assert.equal(u.reachable, true);
  assert.equal(u.providers.length, 1);
  assert.equal(u.providers[0]?.provider, "codex");
  assert.equal(u.providers[0]?.windows[0]?.used_percent, 86);

  // Missing data -> reachable:false, no providers (never a silent empty list).
  setFetchMock(async () => jsonResponse({ ok: true }));
  assert.deepEqual(await usage(), { providers: [], reachable: false, error: undefined });
});

test("usage derives switch_key from an edge that predates it, for generic account aliases", async () => {
  const entry = { label: "L", ok: true, stale: false, plan: null, windows: [], updated_at: null, note: null, error: null,
    reason_code: null, reset_credits: null };
  setFetchMock(async () => jsonResponse({ ok: true, data: { reachable: true, providers: [
    { ...entry, provider: "claude", account: "max@example.com", switch_key: "20X" },
    { ...entry, provider: "claude", account: "team@example.com" },
    { ...entry, provider: "codex", account: "account-secondary" },
    { ...entry, provider: "codex", account: "sym", switch_key: "sym" },
  ] } }));
  const { providers } = await usage();
  assert.deepEqual(providers.map((p) => p.switch_key), ["20X", undefined, "account-secondary", "sym"]);
});

test("usage requests a completed host refresh for a fresh poll tick", async () => {
  const urls: string[] = [];
  setFetchMock(async (input) => {
    urls.push(String(input));
    return jsonResponse({ ok: true, data: { reachable: true, providers: [] } });
  });

  const controller = new AbortController();
  await usage({ signal: controller.signal, isCurrent: () => true, fresh: true });

  assert.deepEqual(urls, ["/api/usage?refresh=1"]);
});

test("usage reports a persistent reader outage after bounded retries", async () => {
  setFetchMock(async () =>
    jsonResponse({ ok: true, data: { providers: [], reachable: false, error: "usage reader status 502" } }),
  );
  await assert.rejects(usage(), /console server could not read the host service: usage reader status 502/);
});







test("Codex rate-limit reset posts the account and caller-owned idempotency key", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  setFetchMock(async (url, init) => {
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return jsonResponse({
      ok: true,
      data: {
        schema_version: "agent-console.codex-rate-limit-reset.v1",
        outcome: "already_redeemed",
        windows_reset: 1,
      },
    });
  });
  const key = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(await resetCodexRateLimit("sym", key), {
    ok: true,
    outcome: "already_redeemed",
    windowsReset: 1,
  });
  assert.deepEqual(requests, [{
    url: "/api/codex/rate-limit-reset",
    method: "POST",
    body: { account: "sym", idempotency_key: key },
  }]);
});

test("Claude limit reset posts the profile, program, and caller-owned idempotency key", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  let reply: unknown = {
    ok: true,
    data: {
      schema_version: "agent-console.claude-limit-reset.v1",
      program: "cedar_ember",
      outcome: "cooldown",
      reason: "cooldown",
      resets_left: 1,
      next_available_at: null,
      cooldown_until: 1790899200,
      weekly_resets_at: null,
    },
  };
  setFetchMock(async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return jsonResponse(reply);
  });
  const key = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(await resetClaudeLimit("20X", "cedar_ember", key), {
    ok: true,
    outcome: "cooldown",
    reason: "cooldown",
    resetsLeft: 1,
    cooldownUntil: 1790899200,
  });
  assert.deepEqual(requests, [{
    url: "/api/claude/limit-reset",
    method: "POST",
    body: { account: "20X", program: "cedar_ember", idempotency_key: key },
  }]);
  reply = { ok: true, data: { outcome: "maybe" } };
  assert.deepEqual(await resetClaudeLimit("20X", "juniper_tide", key), { ok: false, error: "bad response" });
});



test("fetchLayoutOrder unwraps order + reachable, and treats an absent body as unreachable", async () => {
  setFetchMock(async () =>
    jsonResponse({ ok: true, data: { reachable: true, order: ["summit/a", "summit/b"], revision: 8 } }),
  );
  const r = await fetchLayoutOrder();
  assert.equal(r.reachable, true);
  assert.deepEqual(r.order, ["summit/a", "summit/b"]);
  assert.equal(r.revision, 8);

  // Missing data -> reachable:false, empty order (so the UI keeps localStorage).
  setFetchMock(async () => jsonResponse({ ok: true }));
  assert.deepEqual(await fetchLayoutOrder(), { order: [], revision: null, reachable: false, error: undefined });
});

test("fetchLayoutOrder normalizes order like the edge layout contract", async () => {
  const longKey = "x".repeat(513);
  const overflow = Array.from({ length: 300 }, (_, i) => `overflow/${i}`);
  setFetchMock(async () =>
    jsonResponse({
      ok: true,
      data: { reachable: true, order: ["summit/a", "", 3, longKey, "summit/b", "summit/a", ...overflow] },
    }),
  );
  const r = await fetchLayoutOrder();
  assert.equal(r.order.length, 256);
  assert.deepEqual(r.order.slice(0, 3), ["summit/a", "summit/b", "overflow/0"]);
  assert.equal(r.order[r.order.length - 1], "overflow/253");
  assert.equal(r.order.includes(""), false);
  assert.equal(r.order.includes(longKey), false);
});

test("putLayoutOrder PUTs the order envelope with base revision and reports reachability", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenBody = "";
  let seenKeepalive: boolean | undefined = undefined;
  setFetchMock(async (url, init) => {
    seenPath = url;
    seenMethod = init?.method ?? "GET";
    seenBody = String(init?.body ?? "");
    seenKeepalive = init?.keepalive;
    return jsonResponse({ ok: true, data: { reachable: true, revision: 9 } }, { status: 200 });
  });
  const longKey = "x".repeat(513);
  const r = await putLayoutOrder(["summit/b", "", "summit/a", "summit/b", longKey], {
    baseRevision: 8,
    reason: "reorder",
    keepalive: true,
  });
  assert.equal(r.reachable, true);
  assert.equal(r.revision, 9);
  assert.deepEqual(r.order, ["summit/b", "summit/a"]);
  assert.equal(seenPath, "/api/layout");
  assert.equal(seenMethod, "PUT");
  assert.equal(seenKeepalive, true);
  assert.equal(seenBody, JSON.stringify({ order: ["summit/b", "summit/a"], base_revision: 8, reason: "reorder" }));
});

test("putLayoutOrder keeps all-invalid non-empty input distinct from an explicit empty clear", async () => {
  let calls = 0;
  let seenBody = "";
  setFetchMock(async (_url, init) => {
    calls += 1;
    seenBody = String(init?.body ?? "");
    return jsonResponse({ ok: true, data: { reachable: true, revision: 10 } }, { status: 200 });
  });
  const invalid = await putLayoutOrder(["", "x".repeat(513)]);
  assert.equal(calls, 0);
  assert.deepEqual(invalid, {
    order: [],
    revision: null,
    reachable: false,
    conflict: false,
    error: "layout order has no valid session keys",
  });

  const empty = await putLayoutOrder([]);
  assert.equal(calls, 1);
  assert.equal(seenBody, JSON.stringify({ order: [] }));
  assert.deepEqual(empty.order, []);
  assert.equal(empty.reachable, true);
  assert.equal(empty.revision, 10);
});

test("putLayoutOrder reports revision conflicts without treating the store as down", async () => {
  setFetchMock(async () =>
    jsonResponse(
      {
        ok: false,
        data: { reachable: true, conflict: true, order: ["summit/a", "summit/b"], revision: 8 },
      },
      { status: 409 },
    ),
  );
  assert.deepEqual(await putLayoutOrder(["summit/b", "summit/a"], { baseRevision: 7, reason: "reorder" }), {
    order: ["summit/a", "summit/b"],
    revision: 8,
    reachable: true,
    conflict: true,
    error: undefined,
  });
});

test("putLayoutOrder recognizes the multi-user HTTP409 response without a body conflict flag", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false, error: {message: "layout revision conflict"},
    data: {reachable: true, order: ["summit/a", "summit/b"], revision: 8},
  }, {status: 409}));
  assert.deepEqual(await putLayoutOrder(["summit/b", "summit/a"], {baseRevision: 7}), {
    order: ["summit/a", "summit/b"], revision: 8,
    reachable: true, conflict: true, error: undefined,
  });
});

test("putLayoutOrder reports reachable:false when the host store is absent (no-op)", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { reachable: false } }, { status: 200 }));
  assert.equal((await putLayoutOrder(["summit/a"])).reachable, false);
});

test("updateSessionTitle PATCHes null title clears through the edge route", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenBody = "";
  let seenSignal: AbortSignal | null | undefined;
  const controller = new AbortController();
  setFetchMock(async (url, init) => {
    seenPath = url;
    seenMethod = init?.method ?? "GET";
    seenBody = String(init?.body ?? "");
    seenSignal = init?.signal;
    return jsonResponse({ ok: true, data: { session: { title: null, title_revision: 8 } } }, { status: 200 });
  });
  const result = await updateSessionTitle(
    "maple",
    "s1",
    null,
    controller.signal,
    7,
    "launch-s1",
    "Previous title",
  );
  assert.deepEqual(result, { ok: true, titleRevision: 8 });
  assert.equal(seenPath, "/api/sessions/maple/s1");
  assert.equal(seenMethod, "PATCH");
  assert.equal(seenBody, JSON.stringify({
    title: null,
    expected_title_revision: 7,
    expected_session_incarnation: "launch-s1",
    expected_session_title: "Previous title",
  }));
  assert.equal(seenSignal, controller.signal);
});

test("updateSessionTitle PATCHes and confirms structured title state", async () => {
  const requestedTitleState: SessionTitleState = {
    activity: "  Implement   contract ",
    references: ["#317", "#317"],
    topic_source: "auto",
    topic: "  Retitle   rules ",
  };
  const confirmedTitleState: SessionTitleState = {
    topic: "Retitle rules",
    topic_source: "auto",
    references: ["#317"],
    activity: "Implement contract",
  };
  let seenBody = "";
  setFetchMock(async (_url, init) => {
    seenBody = String(init?.body ?? "");
    return jsonResponse({
      ok: true,
      data: {
        session: {
          title: "Retitle rules #317 - Implement contract",
          title_state: confirmedTitleState,
          title_revision: 8,
        },
      },
    }, { status: 200 });
  });

  assert.deepEqual(await updateSessionTitle(
    "maple",
    "s1",
    "Retitle rules #317 - Implement contract",
    undefined,
    7,
    "launch-s1",
    "Retitle rules #317",
    requestedTitleState,
  ), { ok: true, titleRevision: 8, titleState: confirmedTitleState });
  assert.equal(seenBody, JSON.stringify({
    title: "Retitle rules #317 - Implement contract",
    title_state: confirmedTitleState,
    expected_title_revision: 7,
    expected_session_incarnation: "launch-s1",
    expected_session_title: "Retitle rules #317",
  }));
});

test("updateSessionTitle confirms structured-state clears only from omission or explicit null", async () => {
  const responses = [
    { title: null },
    { title: null, title_state: null },
  ];
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { session: responses.shift() },
  }, { status: 200 }));

  assert.deepEqual(await updateSessionTitle("maple", "s1", null, undefined, undefined, undefined, undefined, null), {
    ok: true,
  });
  assert.deepEqual(await updateSessionTitle("maple", "s1", null, undefined, undefined, undefined, undefined, null), {
    ok: true,
  });
});

test("updateSessionTitle rejects malformed non-null state when confirming a clear", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      session: {
        title: null,
        title_state: { topic: null, topic_source: "future", references: [], activity: null },
      },
    },
  }, { status: 200 }));

  assert.deepEqual(await updateSessionTitle("maple", "s1", null, undefined, undefined, undefined, undefined, null), {
    ok: false,
    error: "structured title update was not confirmed",
  });
});

test("updateSessionTitle rejects invalid requested structured state before fetch", async () => {
  setFetchMock(async () => {
    throw new Error("fetch must not run");
  });

  assert.deepEqual(await updateSessionTitle(
    "maple",
    "s1",
    "Retitle rules",
    undefined,
    undefined,
    undefined,
    undefined,
    { topic: null, topic_source: "future", references: [], activity: null } as unknown as SessionTitleState,
  ), {
    ok: false,
    error: "structured title update is invalid",
  });
});

test("updateSessionTitle exposes authoritative title revision conflicts", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: {
      code: "title-revision-conflict",
      message: "session title changed since it was read",
      details: {
        expected_title_revision: 3,
        actual_title_revision: 4,
        actual_title: "Automatic title",
      },
    },
  }, { status: 409 }));

  assert.deepEqual(await updateSessionTitle("maple", "s1", "Manual title", undefined, 3), {
    ok: false,
    error: "session title changed since it was read",
    conflict: true,
    titleRevision: 4,
    actualTitle: "Automatic title",
  });
});

test("updateSessionTitle exposes legacy-writer title state conflicts", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: {
      code: "title-state-conflict",
      message: "session title changed since it was read",
      details: {
        actual_title_revision: 3,
        actual_session_title: "Legacy writer title",
      },
    },
  }, { status: 409 }));

  assert.deepEqual(await updateSessionTitle(
    "maple",
    "s1",
    "Requested title",
    undefined,
    3,
    "launch-s1",
    "Observed title",
  ), {
    ok: false,
    error: "session title changed since it was read",
    conflict: true,
    titleRevision: 3,
    actualTitle: "Legacy writer title",
  });
});

test("updateSessionTitle distinguishes a replaced session from a retryable revision conflict", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: {
      code: "session-incarnation-conflict",
      message: "session was replaced since it was read",
      details: {
        expected_session_incarnation: "launch-s1",
        actual_session_created_at: "2026-07-13T00:00:00Z",
      },
    },
  }, { status: 409 }));

  assert.deepEqual(await updateSessionTitle(
    "maple",
    "s1",
    "Stale title",
    undefined,
    0,
    "launch-s1",
  ), {
    ok: false,
    error: "session was replaced since it was read",
    incarnationConflict: true,
  });
});

test("updateSessionTitle rejects a success response that does not confirm the requested title", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { session: { title: "Unchanged title" } },
  }, { status: 200 }));

  assert.deepEqual(await updateSessionTitle("maple", "s1", "Requested title"), {
    ok: false,
    error: "title update was not confirmed",
  });
});

test("createSession returns the created session id when the edge forwards it", async () => {
  let seenPath = "";
  let seenMethod = "";
  setFetchMock(async (url, init) => {
    seenPath = url;
    seenMethod = init?.method ?? "GET";
    return jsonResponse({ ok: true, data: { session: { id: "created-1" } } }, { status: 200 });
  });

  assert.deepEqual(await createSession("maple", { agent: "codex" }), { ok: true, id: "created-1" });
  assert.equal(seenPath, "/api/sessions/maple");
  assert.equal(seenMethod, "POST");
});

test("createSession preserves the authoritative created-session CAS snapshot", async () => {
  const titleState = {
    topic: null,
    topic_source: "none" as const,
    references: [],
    activity: null,
  };
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      session: {
        id: "created-cas",
        agent: "codex",
        title: "New Codex session",
        title_state: titleState,
        title_state_supported: true,
        title_revision: 0,
        title_mode: "pinned",
        display_revision: 0,
        session_incarnation: "created-cas-incarnation",
        created_at: "2026-07-17T20:00:00Z",
        codex_account: {
          schema_version: "agent-session.codex-account.v1",
          supported: true,
          state: "bound",
          selected_account: "account-a",
          effective_account: "account-a",
          selection_source: "default_at_launch",
          revision: 1,
          applied_runtime_id: "created-cas-incarnation",
        },
      },
    },
  }, { status: 200 }));

  assert.deepEqual(await createSession("maple", { agent: "codex" }), {
    ok: true,
    id: "created-cas",
    session: {
      id: "created-cas",
      machine: "maple",
      agent: "codex",
      title: "New Codex session",
      title_state: titleState,
      title_state_supported: true,
      title_revision: 0,
        title_mode: "pinned",
        display_revision: 0,
      session_incarnation: "created-cas-incarnation",
      created_at: "2026-07-17T20:00:00Z",
      codex_account: {
        schema_version: "agent-session.codex-account.v1",
        supported: true,
        state: "bound",
        selected_account: "account-a",
        effective_account: "account-a",
        selection_source: "default_at_launch",
        revision: 1,
        applied_runtime_id: "created-cas-incarnation",
      },
    },
  });
});

test("createSession rejects malformed created-session fields and drops unknown response data", async () => {
  const responses = [
    {
      ok: true,
      data: {
        session: {
          id: "bad-title",
          agent: "codex",
          title: { token: "secret" },
          session_incarnation: "bad-title-incarnation",
          title_revision: 0,
        },
      },
    },
    {
      ok: true,
      data: {
        session: {
          id: "allowlisted",
          agent: "codex",
          title: "New Codex session",
          session_incarnation: "allowlisted-incarnation",
          title_revision: 0,
          unexpected_secret: "drop-me",
        },
      },
    },
  ];
  setFetchMock(async () => jsonResponse(responses.shift(), { status: 200 }));

  assert.deepEqual(await createSession("maple", { agent: "codex" }), {
    ok: true,
    id: "bad-title",
  });
  assert.deepEqual(await createSession("maple", { agent: "codex" }), {
    ok: true,
    id: "allowlisted",
    session: {
      id: "allowlisted",
      agent: "codex",
      machine: "maple",
      title: "New Codex session",
      session_incarnation: "allowlisted-incarnation",
      title_revision: 0,
    },
  });
});

test("createSession normalizes startup and distinguishes old-daemon absence from invalid supplied metadata", async () => {
  const responses = [
    { ok: true, data: { session: { id: "valid", startup: {
      schema_version: "agent-session.startup.v1",
      state: "starting",
      stage: "runtime",
      started_at: "2026-07-14T10:00:00Z",
      prompt: "drop me",
    } } } },
    { ok: true, data: { session: { id: "old" } } },
    { ok: true, data: { session: { id: "bad", startup: { schema_version: "future" } } } },
  ];
  setFetchMock(async () => jsonResponse(responses.shift(), { status: 200 }));

  assert.deepEqual(await createSession("maple", { agent: "codex" }), {
    ok: true,
    id: "valid",
    startup: {
      schema_version: "agent-session.startup.v1",
      state: "starting",
      stage: "runtime",
      started_at: "2026-07-14T10:00:00Z",
    },
  });
  assert.deepEqual(await createSession("maple", { agent: "codex" }), { ok: true, id: "old" });
  assert.deepEqual(await createSession("maple", { agent: "codex" }), { ok: true, id: "bad", startup: null });
});

test("createSession treats provider resume scan truncation as determinate", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: {
      code: "provider-resume-scan-truncated",
      message: "codex provider history scan was truncated",
    },
  }, { status: 500 }));

  assert.deepEqual(await createSession("maple", {
    agent: "codex",
    provider_resume_id: "019f5c96-65c0-7140-8657-0ce2ecb45aa5",
  }), {
    ok: false,
    error: "codex provider history scan was truncated",
    errorCode: "provider-resume-scan-truncated",
  });
});

test("createSession treats launch profile readiness rejection as determinate", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: {
      code: "agent-profile-unavailable",
      message: "agent launch profile is unavailable",
    },
  }, { status: 500 }));

  assert.deepEqual(await createSession("maple", {
    agent: "claude",
    agent_profile: "custom-claude",
  }), {
    ok: false,
    error: "agent launch profile is unavailable",
    errorCode: "agent-profile-unavailable",
  });
});

test("created-session lifecycle helpers forward their AbortSignal to fetch", async () => {
  const controller = new AbortController();
  const requests: Array<{ readonly url: string; readonly signal: AbortSignal | null | undefined }> = [];
  setFetchMock(async (url, init) => {
    requests.push({ url, signal: init?.signal });
    return jsonResponse({
      ok: true,
      data: {
        sessions: [],
        machines: [],
        session: { id: "created-1" },
      },
    }, { status: 200 });
  });

  await listSessions(["maple"], controller.signal);
  await createSession("maple", { agent: "codex" }, controller.signal);
  await setSessionAutoResume("maple", "created-1", true, controller.signal);
  await sendSessionInput("maple", "created-1", { text: "Start", keys: ["enter"] }, controller.signal);
  await submitSessionPrompt("maple", "created-1", { text: "first\nsecond" }, controller.signal);

  assert.deepEqual(requests.map(({ url }) => url), [
    "/api/sessions?machines=maple",
    "/api/sessions/maple",
    "/api/sessions/maple/created-1/auto-resume",
    "/api/sessions/maple/created-1/send",
    "/api/sessions/maple/created-1/prompt",
  ]);
  assert.ok(requests[0]?.signal, "session list uses a linked deadline signal");
  assert.equal(requests[0]?.signal?.aborted, false);
  assert.equal(requests.slice(1).every(({ signal }) => signal === controller.signal), true);
});

test("listSessions settles after caller cancellation even when fetch ignores abort", async () => {
  const caller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;
  setFetchMock(async (_url, init) => {
    receivedSignal = init?.signal;
    return new Promise<Response>(() => undefined);
  });

  const pending = listSessions(["cancel-test"], caller.signal);
  caller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(receivedSignal?.aborted, true);
});

test("create and initial-prompt server failures preserve an indeterminate outcome", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: { message: "upstream timeout" },
  }, { status: 504 }));

  assert.deepEqual(await createSession("maple", { agent: "codex" }), {
    ok: false,
    error: "upstream timeout",
    outcomeUnknown: true,
  });
  assert.deepEqual(await sendSessionInput("maple", "created-1", { text: "Start", keys: ["enter"] }), {
    ok: false,
    error: "upstream timeout",
    outcomeUnknown: true,
  });
  assert.deepEqual(await submitSessionPrompt("maple", "created-1", { text: "first\nsecond" }), {
    ok: false,
    error: "upstream timeout",
    outcomeUnknown: true,
  });
});

test("summarizeSessionTitle POSTs title summary context to the edge", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenBody = "";
  setFetchMock(async (url, init) => {
    seenPath = url;
    seenMethod = init?.method ?? "GET";
    seenBody = String(init?.body ?? "");
    return jsonResponse({
      ok: true,
      data: {
        title: "agent-console - Fixed title",
        source: "summarizer",
        diagnosticReason: "accepted",
      },
    }, {
      status: 200,
    });
  });
  const result = await summarizeSessionTitle({
    baseTitle: "agent-console",
    currentTitle: "agent-console - Old title",
    prompt: "please fix the title",
    recentOutput: "done",
    agent: "codex",
    repoName: "exampleOrg/agent-console",
    trace: {
      attemptId: "title_opaque123",
      machine: "maple",
      sessionId: "session-1",
      phase: "initial",
      attempt: 1,
    },
  });
  assert.deepEqual(result, {
    ok: true,
    title: "agent-console - Fixed title",
    source: "summarizer",
    diagnosticReason: "accepted",
  });
  assert.equal(seenPath, "/api/title-summary");
  assert.equal(seenMethod, "POST");
  assert.equal(seenBody, JSON.stringify({
    baseTitle: "agent-console",
    currentTitle: "agent-console - Old title",
    prompt: "please fix the title",
    recentOutput: "done",
    agent: "codex",
    repoName: "exampleOrg/agent-console",
    trace: {
      attemptId: "title_opaque123",
      machine: "maple",
      sessionId: "session-1",
      phase: "initial",
      attempt: 1,
    },
  }));
});

test("listSessions negotiates v3, v2, and legacy paths from both capability surfaces", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      sessions: [
        { id: "v3", agent: "codex", status: "running", machine: "m3" },
        { id: "v2", agent: "codex", status: "running", machine: "maple" },
        { id: "old", agent: "codex", status: "running", machine: "m2" },
      ],
      machines: [
        { name: "m3", ok: true, capabilities: { session_retitle_v2: true, session_retitle_v3: true } },
        { name: "maple", ok: true, capabilities: { session_retitle_v2: true } },
        { name: "m2", ok: true },
      ],
      capabilities: { session_retitle_v2: true, session_retitle_v3: true },
    },
  }));
  const result = await listSessions();
  assert.equal(result.sessions[0]?.retitle_path, "daemon_v3");
  assert.equal(result.sessions[1]?.retitle_path, "daemon_v2");
  assert.equal(result.sessions[2]?.retitle_path, "legacy_edge");
  assert.equal(result.capabilities?.session_retitle_v2, true);
  assert.equal(result.capabilities?.session_retitle_v3, true);
});

test("retitle v2 API sends no context and normalizes readiness and result", async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  setFetchMock(async (input, init) => {
    const url = String(input);
    requests.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
    if (url.endsWith("/readiness")) {
      return jsonResponse({
        ok: true,
        data: {
          machine: "maple",
          retitle: {
            schema_version: SESSION_RETITLE_READINESS_SCHEMA_VERSION,
            capability: SESSION_RETITLE_CAPABILITY,
            status: "ready",
            reason_code: "ready",
            next_action: "none",
            provider_kind: "openai_compatible",
            model_label: "deepseek-chat",
            context_capabilities: {
              codex: "provider_transcript",
              claude: "provider_transcript",
            },
            api_key: "secret",
          },
        },
      });
    }
    return jsonResponse({
      ok: true,
      data: {
        machine: "maple",
        retitle: {
          schema_version: SESSION_RETITLE_SCHEMA_VERSION,
          outcome: "committed",
          changed: true,
          trigger: "manual",
          provider_kind: "openai_compatible",
          diagnostic_code: "accepted",
          coverage: { source: "provider_transcript", complete: true, truncated: false, turn_count: 3 },
          session: {
            title: "Durable title",
            title_state: { topic: "Durable title", topic_source: "auto", references: [], activity: null },
            title_revision: 5,
            session_incarnation: "launch-s1",
          },
          model_output: "secret response",
          processed_turn_id_hash: null,
        },
      },
    });
  });

  const readiness = await fetchSessionRetitleReadiness("maple");
  assert.equal(readiness.ok, true);
  assert.equal(readiness.readiness?.model_label, "deepseek-chat");
  assert.equal(JSON.stringify(readiness).includes("api_key"), false);

  const request = {
    schema_version: SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
    trigger: "manual",
    idempotency_key: "console-manual-1234",
    expected_session_incarnation: "launch-s1",
    expected_title_revision: 4,
  } as const;
  const result = await requestSessionRetitle("maple", "s1", request);
  assert.equal(result.ok, true);
  assert.equal(result.retitle?.session.title, "Durable title");
  assert.equal(Object.hasOwn(result.retitle!, "processed_turn_id_hash"), false);
  assert.equal(JSON.stringify(result).includes("model_output"), false);
  assert.deepEqual(JSON.parse(requests[1]?.body ?? "null"), request);
  assert.equal(requests[1]?.body?.includes("prompt"), false);

  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      machine: "maple",
      retitle: {
        ...result.retitle,
        session: { ...result.retitle?.session, session_incarnation: "replacement-launch" },
      },
    },
  }));
  assert.deepEqual(await requestSessionRetitle("maple", "s1", request), {
    ok: false,
    error: "stale retitle response",
  });

  const producerErrorCodes = [
    "invalid-retitle-request",
    "retitle-provider-not-configured",
    "retitle-config-invalid",
    "retitle-queue-saturated",
    "retitle-context-unavailable",
    "retitle-account-missing",
    "retitle-api-key-missing",
    "retitle-provider-timeout",
    "retitle-provider-unavailable",
    "retitle-provider-rate-limited",
    "retitle-provider-quota-exceeded",
    "retitle-provider-malformed-response",
    "idempotency-key-reused",
    "session-incarnation-conflict",
    "title-revision-conflict",
    "retitle-turn-conflict",
    "retitle-state-conflict",
    "retitle-worker-failed",
    "title-revision-overflow",
  ] as const;
  for (const code of producerErrorCodes) {
    setFetchMock(async () => jsonResponse({
      ok: false,
      error: {
        code,
        message: "safe edge message",
        details: {
          retryable: true,
          next_action: "retry",
          recovery: { strategy: "retry_provider", safe_to_retry: true },
        },
      },
    }, { status: 409 }));
    assert.deepEqual(await requestSessionRetitle("maple", "s1", request), {
      ok: false,
      error: "safe edge message",
      errorCode: code,
      retryable: true,
      nextAction: "retry",
    });
  }
});

test("retitle v3 API sends only fences and reconciles an accepted operation", async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  const operationHash = `sha256:${"b".repeat(64)}`;
  const baseResult = {
    schema_version: SESSION_RETITLE_V3_SCHEMA_VERSION,
    capability: SESSION_RETITLE_V3_CAPABILITY,
    provider_attempts: [],
    operation_hash: operationHash,
    memory_revision: 9,
    title_revision: 3,
    session_incarnation: "launch-v3",
    readiness: "ready",
    title: "Durable objective - Verify UI",
    admission_fence: { session_incarnation: "launch-v3", title_revision: 2, memory_revision: 8 },
    current_fence: { session_incarnation: "launch-v3", title_revision: 3, memory_revision: 9 },
    result_is_current: true,
    started_at: "2026-09-10T00:00:00Z",
    duration_bucket: "50_249_ms",
  };
  setFetchMock(async (input, init) => {
    const url = String(input);
    requests.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
    if (url.endsWith("/readiness")) {
      return jsonResponse({
        ok: true,
        data: {
          machine: "maple",
          retitle: {
            schema_version: SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION,
            capability: SESSION_RETITLE_V3_CAPABILITY,
            status: "ready",
            provider_status: "ready",
            context_status: "ready",
            title_status: "current",
            reason_code: "ready",
            next_action: "none",
            memory_revision: 8,
            usable_memory: true,
            pending_operation: false,
            semantic_memory: "must-not-cross",
          },
        },
      });
    }
    if (url.includes("/operations/")) {
      return jsonResponse({
        ok: true,
        data: {
          machine: "maple",
          retitle: {
            ...baseResult,
            status: "terminal",
            outcome: "committed",
            changed: true,
            result_fence: { session_incarnation: "launch-v3", title_revision: 3, memory_revision: 9 },
            finished_at: "2026-09-10T00:00:01Z",
            provider_output: "must-not-cross",
          },
        },
      });
    }
    return jsonResponse({
      ok: true,
      data: { machine: "maple", retitle: { ...baseResult, status: "accepted" } },
    }, { status: 202 });
  });

  const readiness = await fetchSessionRetitleV3Readiness("maple", "s1");
  assert.equal(readiness.readiness?.memory_revision, 8);
  assert.equal(JSON.stringify(readiness).includes("semantic_memory"), false);
  const request = {
    schema_version: SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION,
    trigger: "manual",
    idempotency_key: "console-manual-v3-1234",
    expected: { session_incarnation: "launch-v3", title_revision: 2, memory_revision: 8 },
  } as const;
  const accepted = await requestSessionRetitleV3("maple", "s1", request);
  assert.equal(accepted.retitle?.status, "accepted");
  assert.deepEqual(JSON.parse(requests[1]?.body ?? "null"), request);
  assert.equal(requests[1]?.body?.includes("prompt"), false);
  const terminal = await fetchSessionRetitleV3Operation("maple", "s1", operationHash);
  assert.equal(terminal.retitle?.outcome, "committed");
  assert.equal(JSON.stringify(terminal).includes("provider_output"), false);
});

test("summarizeSessionTitle drops unknown diagnostic reasons", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { title: "Safe title", source: "summarizer", diagnosticReason: "prompt contents" },
  }));

  assert.deepEqual(await summarizeSessionTitle({ prompt: "private prompt" }), {
    ok: true,
    title: "Safe title",
    source: "summarizer",
  });
});

test("resumeSession POSTs the explicit resume route", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenBody = "";
  setFetchMock(async (url, init) => {
    seenPath = url;
    seenMethod = init?.method ?? "GET";
    seenBody = String(init?.body ?? "");
    return jsonResponse(
      { ok: true, data: { session: { id: "s1", status: "running", repo_name: "nils-cli" } } },
      { status: 200 },
    );
  });
  const result = await resumeSession("maple", "s1");
  assert.deepEqual(result, { ok: true });
  assert.equal(seenPath, "/api/sessions/maple/s1/resume");
  assert.equal(seenMethod, "POST");
  assert.equal(seenBody, "{}");
});

test("maintenance helpers normalize safe previews and preserve cleanup-pending results", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const preview = {
    schema_version: "agent-session.session-maintenance.v1",
    session_id: "s1",
    operation: "delete",
    state: "repairable",
    session_incarnation: "launch-1",
    session_generation: 1,
    issue: {
      kind: "process_boundary_live",
      operation: "delete",
      retryable: true,
      preserves_session_metadata: true,
      message: "drop producer wording",
    },
    boundary: { kind: "managed_scope", safe_process_count: 2 },
    preservation: {
      session_metadata_retained_until_success: true,
      provider_conversation_retained: true,
      destructive_scope: "verified_recorded_runtime_only",
    },
    actions: [
      {
        id: "retry_delete",
        label: "untrusted label",
        destructive: true,
        requires_confirmation: true,
        preserves_session_metadata: false,
      },
      {
        id: "terminate_runtime_then_delete",
        label: "untrusted label",
        destructive: true,
        requires_confirmation: true,
        preserves_session_metadata: false,
      },
    ],
    preview_digest: `sha256:${"a".repeat(64)}`,
    cwd: "/private",
  };
  setFetchMock(async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if ((init?.method ?? "GET") === "GET") {
      return jsonResponse({ ok: true, data: { maintenance: preview } });
    }
    return jsonResponse({ ok: true, data: { maintenance_result: {
      schema_version: "agent-session.session-maintenance.v1",
      session_id: "s1",
      operation: "delete",
      action: "terminate_runtime_then_delete",
      outcome: "deleted",
      session_incarnation: null,
      session_generation: null,
      status: "deleted",
      cleanup_pending: true,
      cwd: "/private",
    } } });
  });

  const inspected = await inspectSessionMaintenance("maple", "s1", "delete");
  assert.equal(inspected.ok, true);
  assert.equal(inspected.maintenance?.issue?.message, "the recorded runtime process boundary is still live");
  assert.equal(inspected.maintenance?.actions[0]?.label, "Retry delete");
  assert.equal("cwd" in (inspected.maintenance ?? {}), false);

  const request = {
    operation: "delete" as const,
    action: "terminate_runtime_then_delete" as const,
    expected_session_incarnation: "launch-1",
    expected_session_generation: 1,
    expected_preview_digest: preview.preview_digest,
    confirmed: true,
  };
  const acted = await executeSessionMaintenanceAction("maple", "s1", request);
  assert.equal(acted.ok, true);
  assert.equal(acted.result?.cleanup_pending, true);
  assert.equal("cwd" in (acted.result ?? {}), false);
  assert.deepEqual(requests, [
    {
      // The preview asks for the successor contract; the edge degrades to v1
      // against an older daemon and echoes whichever one answered.
      url: "/api/sessions/maple/s1/maintenance"
        + "?operation=delete&schema_version=agent-session.session-maintenance.v2",
      method: "GET",
      body: "",
    },
    {
      // The v1 preview above means the action body stays exactly v1.
      url: "/api/sessions/maple/s1/maintenance/actions",
      method: "POST",
      body: JSON.stringify(request),
    },
  ]);
});

test("maintenance helpers correlate successful envelopes with the requested route and action", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | null | undefined;
  let requestCount = 0;
  setFetchMock(async (_url, init) => {
    requestCount += 1;
    seenSignal = init?.signal;
    if (requestCount === 1) {
      return jsonResponse({ ok: true, data: { maintenance: {
        schema_version: "agent-session.session-maintenance.v1",
        session_id: "wrong-session",
        operation: "resume",
        state: "healthy",
        session_incarnation: "launch-1",
        session_generation: 1,
        issue: null,
        boundary: { kind: "tmux_session", safe_process_count: 1 },
        preservation: {
          session_metadata_retained_until_success: true,
          provider_conversation_retained: true,
          destructive_scope: "verified_recorded_runtime_only",
        },
        actions: [{
          id: "retry_resume",
          label: "Retry resume",
          destructive: false,
          requires_confirmation: false,
          preserves_session_metadata: true,
        }],
        preview_digest: `sha256:${"a".repeat(64)}`,
      } } });
    }
    return jsonResponse({ ok: true, data: { maintenance_result: {
      schema_version: "agent-session.session-maintenance.v1",
      session_id: "s1",
      operation: "resume",
      action: "retry_resume",
      outcome: "deleted",
      session_incarnation: null,
      session_generation: null,
      status: "deleted",
      cleanup_pending: true,
    } } });
  });

  assert.deepEqual(await inspectSessionMaintenance("maple", "s1", "resume", controller.signal), {
    ok: false,
    error: "invalid session maintenance response",
  });
  assert.equal(seenSignal, controller.signal);
  assert.deepEqual(await executeSessionMaintenanceAction("maple", "s1", {
    operation: "resume",
    action: "retry_resume",
    expected_session_incarnation: "launch-1",
    expected_session_generation: 1,
    expected_preview_digest: `sha256:${"a".repeat(64)}`,
  }), { ok: false, error: "invalid maintenance result" });
});

test("maintenance helpers omit uncorrelated or non-retained failure details", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: {
      code: "session-maintenance-failed",
      details: {
        id: "another-session",
        operation: "delete",
        kind: "process_boundary_live",
        retryable: true,
        session_metadata_retained: false,
      },
    },
  }, { status: 409 }));

  assert.deepEqual(await inspectSessionMaintenance("maple", "s1", "resume"), {
    ok: false,
    error: "session maintenance is unavailable",
  });
  assert.deepEqual(await executeSessionMaintenanceAction("maple", "s1", {
    operation: "resume",
    action: "retry_resume",
    expected_session_incarnation: "launch-1",
    expected_session_generation: 1,
    expected_preview_digest: `sha256:${"a".repeat(64)}`,
  }), {
    ok: false,
    error: "session maintenance failed",
  });
});

test("auto-resume helpers PUT recovery policy and DELETE durable cancellation", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  setFetchMock(async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    return jsonResponse({ ok: true, data: { auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "enabled",
    } } }, { status: 200 });
  });

  assert.deepEqual(
    await setSessionAutoResume("maple", "s1", true, undefined, "next_account_then_resume"),
    { ok: true },
  );
  assert.deepEqual(await cancelSessionAutoResume("maple", "s1"), { ok: true });
  assert.deepEqual(requests, [
    {
      url: "/api/sessions/maple/s1/auto-resume",
      method: "PUT",
      body: JSON.stringify({ enabled: true, recovery_policy: "next_account_then_resume" }),
    },
    { url: "/api/sessions/maple/s1/auto-resume", method: "DELETE", body: "" },
  ]);
});

test("auto-resume enablement preserves an indeterminate edge outcome", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: { code: "auto-resume-outcome-unknown", message: "auto-resume outcome is unknown" },
  }, { status: 504 }));

  assert.deepEqual(await setSessionAutoResume("maple", "s1", true), {
    ok: false,
    error: "auto-resume outcome is unknown",
    outcomeUnknown: true,
  });
});

test("auto-resume enablement treats a previous edge generic 500 as indeterminate", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: { message: "internal error" },
  }, { status: 500 }));

  assert.deepEqual(await setSessionAutoResume("maple", "s1", true), {
    ok: false,
    error: "internal error",
    outcomeUnknown: true,
  });
});

test("Codex account helpers list metadata and PUT nickname plus incarnation", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  setFetchMock(async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url.endsWith("/codex/accounts")) {
      return jsonResponse({ ok: true, data: { accounts: [
        { account: "account-secondary", label: "Secondary", plan: "team", access_token: "drop-me" },
        { account: "../bad" },
      ], readiness: {
        schema_version: "agent-session.codex-account-readiness.v1",
        supported: true,
        provider_version: "0.144.5",
        access_token: "drop-me",
      } } });
    }
    return jsonResponse({ ok: true, data: { codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "sym",
      revision: 4,
      applied_runtime_id: "launch-s1",
      access_token: "drop-me",
    } } });
  });

  assert.deepEqual(await listAccounts("codex", "maple"), {
    accounts: [{ account: "account-secondary", label: "Secondary", plan: "team" }],
    readiness: {
      schema_version: "agent-session.codex-account-readiness.v1",
      supported: true,
      provider_version: "0.144.5",
    },
  });
  assert.deepEqual(await switchSessionAccount("codex", "maple", "s1", "sym", "launch-s1"), {
    ok: true,
    account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "sym",
      revision: 4,
      applied_runtime_id: "launch-s1",
    },
  });
  assert.deepEqual(requests, [
    { url: "/api/machines/maple/codex/accounts", method: "GET", body: "" },
    {
      url: "/api/sessions/maple/s1/account",
      method: "PUT",
      body: JSON.stringify({ account: "sym", expected_session_incarnation: "launch-s1" }),
    },
  ]);
});

test("Codex account inventory fails closed when an edge supplies malformed readiness", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: {
    accounts: [{ account: "sym", label: "Sym" }],
    readiness: {
      schema_version: "agent-session.codex-account-readiness.v1",
      supported: true,
      reason_code: "codex-version-too-old",
    },
  } }));

  assert.deepEqual(await listAccounts("codex", "maple"), {
    accounts: [],
    readiness: {
      schema_version: "agent-session.codex-account-readiness.v1",
      supported: false,
      reason_code: "unknown",
    },
  });
});

test("Codex account inventory rejects HTTP failures so callers can retain last-good ownership", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: { message: "account reader unavailable" },
  }, { status: 502 }));

  await assert.rejects(listAccounts("codex", "maple"), /account reader unavailable/);
});

test("Codex account switch preserves an indeterminate edge outcome", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: { code: "account-switch-outcome-unknown", message: "account switch outcome is unknown" },
  }, { status: 504 }));

  // The edge cannot name the provider before the daemon answers, so either
  // provider's switch reads the neutral code as an unknown outcome.
  for (const provider of ["codex", "claude"] as const) {
    assert.deepEqual(await switchSessionAccount(provider, "maple", "s1", "sym", "launch-s1"), {
      ok: false,
      error: "account switch outcome is unknown",
      outcomeUnknown: true,
    });
  }
});

test("Codex account switch bounds browser transport and treats rejection as indeterminate", async () => {
  setFetchMock(async (_url, init) => {
    assert.ok(init?.signal);
    throw new TypeError("network connection dropped");
  });

  assert.deepEqual(await switchSessionAccount("codex", "maple", "s1", "sym", "launch-s1"), {
    ok: false,
    error: "Codex account switch outcome is unknown",
    outcomeUnknown: true,
  });
});

test("a refused Claude account switch shows the edge's typed message and is not an unknown outcome", async () => {
  const message = "the Claude account broker did not answer in time, try again later; the running session was left unchanged";
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: { code: "claude-account-switch-refused", message, details: { cause: "claude-account-broker-timeout" } },
  }, { status: 422 }));

  assert.deepEqual(await switchSessionAccount("claude", "maple", "s1", "sym", "launch-s1"), { ok: false, error: message });
});

test("Codex account switch rejects confirmation for another runtime incarnation", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "sym",
      revision: 5,
      applied_runtime_id: "replacement-launch",
    } },
  }));

  assert.deepEqual(await switchSessionAccount("codex", "maple", "s1", "sym", "launch-s1"), {
    ok: false,
    error: "Codex account switch was not confirmed",
  });
});

test("Codex account switch accepts authoritative queued and future-state outcomes", async () => {
  for (const [rawState, expectedState] of [
    ["queued", "queued"],
    ["applying", "applying"],
    ["failed", "failed"],
    ["future-state", "unknown"],
  ] as const) {
    setFetchMock(async () => jsonResponse({
      ok: true,
      data: { codex_account: {
        schema_version: "agent-session.codex-account.v1",
        supported: true,
        state: "bound",
        selected_account: "account-a",
        revision: 5,
        applied_runtime_id: "launch-s1",
        next: {
          account: "account-b",
          revision: 2,
          state: rawState,
          ...(rawState === "failed" ? { failure_reason: "apply_failed" } : {}),
          access_token: "drop-me",
        },
      } },
    }));

    const result = await switchSessionAccount("codex", "maple", "s1", "account-b", "launch-s1");
    assert.equal(result.ok, true, rawState);
    assert.equal(result.account?.selected_account, "account-a");
    assert.equal(result.account?.next?.account, "account-b");
    assert.equal(result.account?.next?.state, expectedState);
    assert.equal("access_token" in (result.account?.next ?? {}), false);
  }
});

test("Codex account switch accepts an edge-confirmed unbound next outcome", async () => {
  // An unbound queue is fenced to the runtime the edge names in its answer.
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { session_incarnation: "launch-s1", codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "unbound",
      revision: 0,
      next: { account: "account-b", revision: 1, state: "queued" },
    } },
  }));

  assert.deepEqual(
    await switchSessionAccount("codex", "maple", "s1", "account-b", "launch-s1"),
    {
      ok: true,
      account: {
        schema_version: "agent-session.codex-account.v1",
        supported: true,
        state: "unbound",
        revision: 0,
        next: { account: "account-b", revision: 1, state: "queued" },
      },
    },
  );
});

test("Codex account switch trusts the unbound-queue fence of an edge that predates the echo", async () => {
  const unboundQueued = {
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "unbound",
    revision: 0,
    next: { account: "account-b", revision: 1, state: "queued" },
  };
  // An older edge checked the fence itself and answered without the echo.
  setFetchMock(async () => jsonResponse({ ok: true, data: { codex_account: unboundQueued } }));
  assert.equal((await switchSessionAccount("codex", "maple", "s1", "account-b", "launch-s1")).ok, true);
  // A present echo is still compared.
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { session_incarnation: "launch-other", codex_account: unboundQueued },
  }));
  assert.equal((await switchSessionAccount("codex", "maple", "s1", "account-b", "launch-s1")).ok, false);
});

test("Codex account switch rejects non-queued unbound next outcomes", async () => {
  for (const state of ["applying", "failed", "future-state"] as const) {
    setFetchMock(async () => jsonResponse({
      ok: true,
      data: { codex_account: {
        schema_version: "agent-session.codex-account.v1",
        supported: true,
        state: "unbound",
        revision: 0,
        next: { account: "account-b", revision: 1, state },
      } },
    }));

    assert.deepEqual(
      await switchSessionAccount("codex", "maple", "s1", "account-b", "launch-s1"),
      {
        ok: false,
        error: "Codex account switch was not confirmed",
      },
      state,
    );
  }
});

test("Codex account switch rejects a queued result bound to another runtime", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      revision: 5,
      applied_runtime_id: "replacement-launch",
      next: { account: "account-b", revision: 2, state: "queued" },
    } },
  }));

  assert.deepEqual(await switchSessionAccount("codex", "maple", "s1", "account-b", "launch-s1"), {
    ok: false,
    error: "Codex account switch was not confirmed",
  });
});

test("listSessions normalizes auto-resume, edge capability, and old-daemon absence", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions: [
    { id: "old", agent: "claude", status: "stopped", machine: "maple" },
    { id: "valid", agent: "claude", status: "stopped", machine: "maple", auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "scheduled",
      scheduled_at: "2026-07-12T12:34:56Z",
      continuation: "drop me",
    } },
    { id: "bad", agent: "claude", status: "stopped", machine: "maple", auto_resume: { enabled: true } },
  ], machines: [], capabilities: { auto_resume_control: true } } }));

  const result = await listSessions();
  assert.equal("auto_resume" in result.sessions[0]!, false);
  assert.deepEqual(result.sessions[1]!.auto_resume, {
    schema_version: "agent-session.auto-resume.v1",
    supported: true,
    enabled: true,
    state: "scheduled",
    scheduled_at: "2026-07-12T12:34:56Z",
  });
  assert.equal(result.sessions[1]!.auto_resume_control_available, true);
  assert.equal(result.sessions[2]!.auto_resume, null);
});

test("listSessions marks controls unavailable when an old edge passes new-daemon metadata", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions: [{
    id: "skew",
    agent: "claude",
    status: "stopped",
    machine: "maple",
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: false,
      state: "disabled",
    },
  }], machines: [] } }));

  const result = await listSessions();
  assert.equal(result.sessions[0]!.auto_resume_control_available, false);
});

test("listSessions enables managed resume only through edge and machine capabilities", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: {
    sessions: [
      {
        id: "profiled",
        agent: "claude",
        agent_profile: "custom-claude",
        status: "stopped",
        machine: "maple",
        resume_blocked_reason: "agent-profile-unavailable",
        agent_profile_provider_config_dir: "/private/profile-root",
        readiness_args: ["--private-check"],
        profile_resume_context: { provider_config_dir: "/private/nested-profile-root" },
        runtime: { extra: { readiness_env: { TOKEN: "nested-private" } } },
        launcher_path: "/private/unknown-launcher",
        provider_resume: {
          provider: "claude",
          session_id: "safe-provider-id",
          provider_config_dir: "/private/nested-provider-root",
        },
      },
      {
        id: "old-machine",
        agent: "claude",
        agent_profile: "custom-claude",
        status: "stopped",
        machine: "m2",
        resume_blocked_reason: "/private/root",
      },
      {
        id: "managed-profile",
        agent: "claude",
        agent_profile: "custom-claude",
        status: "stopped",
        machine: "maple",
      },
    ],
    machines: [
      {
        name: "maple",
        ok: true,
        capabilities: {
          profile_resume_import: true,
          managed_resume_command: true,
          resume_blocked_reason: true,
          history: true,
        },
        agent_profiles: [{
          id: "custom-claude",
          label: "Custom Claude",
          agent: "claude",
          provider_resume_import_supported: true,
        }],
      },
      {
        name: "m2",
        ok: true,
        agent_profiles: [{
          id: "custom-claude",
          label: "Custom Claude",
          agent: "claude",
          provider_resume_import_supported: true,
        }],
      },
    ],
    capabilities: {
      profile_resume_import: true,
      managed_resume_command: true,
      resume_blocked_reason: true,
    },
  } }));

  const result = await listSessions();
  assert.notEqual(result.sessions[0]?.managed_resume_command_available, true);
  assert.equal(result.sessions[0]?.resume_blocked_reason, "agent-profile-unavailable");
  assert.equal(Object.hasOwn(result.sessions[0] ?? {}, "agent_profile_provider_config_dir"), false);
  assert.equal(Object.hasOwn(result.sessions[0] ?? {}, "readiness_args"), false);
  assert.equal(Object.hasOwn(result.sessions[0] ?? {}, "profile_resume_context"), false);
  assert.equal(Object.hasOwn(result.sessions[0] ?? {}, "runtime"), false);
  assert.equal(Object.hasOwn(result.sessions[0] ?? {}, "launcher_path"), false);
  assert.deepEqual(result.sessions[0]?.provider_resume, {
    provider: "claude",
    session_id: "safe-provider-id",
  });
  assert.notEqual(result.sessions[1]?.managed_resume_command_available, true);
  assert.equal(Object.hasOwn(result.sessions[1] ?? {}, "resume_blocked_reason"), false);
  assert.equal(result.sessions[2]?.managed_resume_command_available, true);
  assert.equal(result.machines[0]?.agent_profiles?.[0]?.provider_resume_import_supported, true);
  assert.equal(result.machines[1]?.agent_profiles?.[0]?.provider_resume_import_supported, false);
});





test("listSessions normalizes Codex account metadata and strips credential fields", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions: [{
    id: "codex",
    agent: "codex",
    status: "running",
    machine: "maple",
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-secondary",
      revision: 2,
      applied_runtime_id: "launch-s1",
      access_token: "drop-me",
    },
  }], machines: [] } }));

  // A daemon without the Codex flag predates it and always serves the switch.
  const result = await listSessions();
  assert.deepEqual(result.sessions[0]!.codex_account, {
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "bound",
    selected_account: "account-secondary",
    revision: 2,
    applied_runtime_id: "launch-s1",
  });
});

test("listSessions normalizes startup, preserves absence, and prevents raw startup leakage through session spread", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions: [
    { id: "old", agent: "codex", status: "stopped", machine: "maple" },
    { id: "failed", agent: "codex", status: "stopped", machine: "maple", startup: {
      schema_version: "agent-session.startup.v1",
      state: "failed",
      stage: "runtime",
      started_at: "2026-07-14T10:00:00Z",
      failure_code: "agent-binary-unavailable",
      message: "The selected agent CLI could not be started.",
      occurred_at: "2026-07-14T10:00:01Z",
      retry_safe: false,
      stderr: "private raw stderr",
    } },
    { id: "bad", agent: "codex", status: "stopped", machine: "maple", startup: {
      schema_version: "future",
      prompt: "private prompt",
    } },
  ], machines: [] } }));

  const result = await listSessions();

  assert.equal("startup" in result.sessions[0]!, false);
  assert.deepEqual(result.sessions[1]!.startup, {
    schema_version: "agent-session.startup.v1",
    state: "failed",
    stage: "runtime",
    started_at: "2026-07-14T10:00:00Z",
    failure_code: "agent-binary-unavailable",
    message: "The selected agent CLI could not be started.",
    occurred_at: "2026-07-14T10:00:01Z",
    retry_safe: false,
  });
  assert.equal(result.sessions[2]!.startup, null);
  assert.equal(JSON.stringify(result.sessions).includes("private raw stderr"), false);
  assert.equal(JSON.stringify(result.sessions).includes("private prompt"), false);
});

test("sendSessionInput POSTs terminal text and keys through the edge send route", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenBody = "";
  setFetchMock(async (url, init) => {
    seenPath = url;
    seenMethod = init?.method ?? "GET";
    seenBody = String(init?.body ?? "");
    return jsonResponse({ ok: true, data: { sent: { sent_text: true, keys: ["enter"] } } }, {
      status: 200,
    });
  });

  const result = await sendSessionInput("maple", "s1", { text: "hello", keys: ["enter"] });
  assert.deepEqual(result, { ok: true });
  assert.equal(seenPath, "/api/sessions/maple/s1/send");
  assert.equal(seenMethod, "POST");
  assert.equal(
    seenBody,
    JSON.stringify({ text: "hello", keys: ["enter"], allow_blocked: true }),
  );
});

// Every caller of this function is the interactive terminal: the transport's
// fallback when the attach socket is not open, and TerminalPane's direct send
// before a transport exists. Both carry keystrokes a person just typed, so the
// daemon's blocked-input refusal must not apply — a human answering an approval
// dialog is exactly the deliberate case that refusal exists to leave alone.
test("sendSessionInput declares human intent so a blocked pane still accepts typing", async () => {
  let seenBody = "";
  setFetchMock(async (_url, init) => {
    seenBody = String(init?.body ?? "");
    return jsonResponse({ ok: true, data: { sent: { sent_text: true, keys: [] } } }, {
      status: 200,
    });
  });

  await sendSessionInput("maple", "s1", { text: "y" });

  assert.equal(
    JSON.parse(seenBody).allow_blocked,
    true,
    "terminal input must set allow_blocked so agent-blocked cannot reject a person's keystrokes",
  );
});

test("submitSessionPrompt preserves the unfenced compatibility route and acknowledgement", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenBody = "";
  setFetchMock(async (url, init) => {
    seenPath = url;
    seenMethod = init?.method ?? "GET";
    seenBody = String(init?.body ?? "");
    return jsonResponse({ ok: true, data: { submitted: true } }, { status: 200 });
  });

  const result = await submitSessionPrompt("maple", "s1", { text: "first\nsecond" });
  assert.deepEqual(result, { ok: true });
  assert.equal(seenPath, "/api/sessions/maple/s1/prompt");
  assert.equal(seenMethod, "POST");
  assert.equal(seenBody, JSON.stringify({ text: "first\nsecond" }));
});

test("submitSessionPrompt preserves explicit compatibility-route failures", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: { message: "provider rejected prompt" },
  }, { status: 200 }));

  assert.deepEqual(await submitSessionPrompt("maple", "s1", { text: "hello" }), {
    ok: false,
    error: "provider rejected prompt",
  });
});

test("submitSessionPrompt POSTs exact multiline text and incarnation through the fenced edge route", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenBody = "";
  setFetchMock(async (url, init) => {
    seenPath = url;
    seenMethod = init?.method ?? "GET";
    seenBody = String(init?.body ?? "");
    return jsonResponse({
      ok: true,
      data: { submitted: true, session_incarnation: "launch-s1" },
    }, { status: 200 });
  });

  const result = await submitSessionPrompt("maple", "s1", {
    text: "first\nsecond",
    expected_session_incarnation: "launch-s1",
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(seenPath, "/api/sessions/maple/s1/prompt/v2");
  assert.equal(seenMethod, "POST");
  assert.equal(seenBody, JSON.stringify({
    text: "first\nsecond",
    expected_session_incarnation: "launch-s1",
  }));
});

test("submitSessionPrompt reports a prompt queued behind the running turn as sent", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { submitted: true, queued: true, session_incarnation: "launch-s1" },
  }, { status: 200 }));
  assert.deepEqual(await submitSessionPrompt("maple", "s1", {
    text: "hello",
    expected_session_incarnation: "launch-s1",
  }), { ok: true, queued: true });
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: { submitted: true, queued: "true", session_incarnation: "launch-s1" },
  }, { status: 200 }));
  assert.deepEqual(await submitSessionPrompt("maple", "s1", {
    text: "hello",
    expected_session_incarnation: "launch-s1",
  }), { ok: true }, "only a boolean queued mark is read");
});

test("submitSessionPrompt requires a matching fenced incarnation acknowledgement", async () => {
  for (const sessionIncarnation of [undefined, "launch-replacement"]) {
    setFetchMock(async () => jsonResponse({
      ok: true,
      data: {
        submitted: true,
        ...(sessionIncarnation === undefined
          ? {}
          : { session_incarnation: sessionIncarnation }),
      },
    }, { status: 200 }));

    assert.deepEqual(await submitSessionPrompt("maple", "s1", {
      text: "hello",
      expected_session_incarnation: "launch-s1",
    }), {
      ok: false,
      error: "provider prompt submission was not acknowledged",
      outcomeUnknown: true,
    });
  }
});

test("submitSessionPrompt treats a fenced 501 as unsupported before submission", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: { message: "structured prompt endpoint unavailable" },
  }, { status: 501 }));

  assert.deepEqual(await submitSessionPrompt("maple", "s1", {
    text: "hello",
    expected_session_incarnation: "launch-s1",
  }), {
    ok: false,
    error: "structured prompt endpoint unavailable",
  });
});

test("submitSessionPrompt treats malformed successful responses as outcome-unknown", async () => {
  const responses = [
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];

  for (const [index, response] of responses.entries()) {
    setFetchMock(async () => response);
    assert.deepEqual(await submitSessionPrompt("maple", "s1", { text: "hello" }), {
      ok: false,
      error: "provider prompt submission was not acknowledged",
      outcomeUnknown: true,
    });
  }
});

test("submitSessionPrompt requires explicit provider acknowledgement", async () => {
  for (const data of [
    {},
    { submitted: false },
    { submitted: "true" },
    { response_item: { type: "message", role: "user", content: "injected" } },
  ]) {
    setFetchMock(async () => jsonResponse({ ok: true, data }, { status: 200 }));

    assert.deepEqual(await submitSessionPrompt("maple", "s1", { text: "hello" }), {
      ok: false,
      error: "provider prompt submission was not acknowledged",
      outcomeUnknown: true,
    });
  }
});

test("searchWorkdirs unwraps workdir suggestions", async () => {
  setFetchMock(async (url) => {
    assert.equal(url, "/api/machines/maple/workdirs?q=agent&limit=7&git_only=true&exclude_worktrees=true");
    return jsonResponse(
      {
        ok: true,
        data: {
          workdirs: [
            {
              path: "/home/runner/Project/agent-console",
              name: "agent-console",
              last_used: "2026-07-05T08:00:00Z",
            },
          ],
        },
      },
      { status: 200 },
    );
  });
  const workdirs = await searchWorkdirs("maple", "agent", 7);
  assert.equal(workdirs[0]?.path, "/home/runner/Project/agent-console");
  assert.equal(workdirs[0]?.last_used, "2026-07-05T08:00:00Z");
});

test("uploadAttachment posts the raw file body and returns the remote path", async () => {
  const payload = new File([new Uint8Array([1, 2, 3])], "clip.png", { type: "image/png" });
  let seenPath = "";
  let seenMethod = "";
  let seenType = "";
  let seenBytes = 0;
  setFetchMock(async (url, init) => {
    seenPath = url;
    seenMethod = init?.method ?? "GET";
    seenType = new Headers(init?.headers).get("content-type") ?? "";
    seenBytes = init?.body instanceof File ? init.body.size : 0;
    return jsonResponse(
      { ok: true, data: { attachment: { path: "/tmp/clip.png", bytes: 3 } } },
      { status: 200 },
    );
  });
  const result = await uploadAttachment("maple", "s1", payload);
  assert.equal(result.ok, true);
  assert.equal(result.path, "/tmp/clip.png");
  assert.equal(seenPath, "/api/sessions/maple/s1/attachments?filename=clip.png");
  assert.equal(seenMethod, "POST");
  assert.equal(seenType, "image/png");
  assert.equal(seenBytes, 3);
});

test("uploadAttachment gives nameless clipboard files safe fallback names", async () => {
  const seenPaths: string[] = [];
  setFetchMock(async (url) => {
    seenPaths.push(url);
    return jsonResponse({ ok: true, data: { attachment: { path: "/attachments/file", bytes: 1 } } }, {
      status: 200,
    });
  });

  await uploadAttachment("maple", "s1", new File([new Uint8Array([1])], "", { type: "image/webp" }));
  await uploadAttachment("maple", "s1", new File([new Uint8Array([1])], "", { type: "text/plain" }));

  assert.deepEqual(seenPaths, [
    "/api/sessions/maple/s1/attachments?filename=pasted.webp",
    "/api/sessions/maple/s1/attachments?filename=attachment.bin",
  ]);
});

test("uploadAttachment surfaces an edge failure without a path", async () => {
  setFetchMock(async () =>
    jsonResponse({ ok: false, error: { message: "daemon status 500" } }, {
      status: 500,
    }),
  );
  const payload = new File([new Uint8Array([1])], "clip.png", { type: "image/png" });
  const result = await uploadAttachment("maple", "s1", payload);
  assert.equal(result.ok, false);
  assert.equal(result.path, undefined);
  assert.match(result.error ?? "", /500/);
});

test("setHistoryStar posts the toggle to the machine-scoped history star route", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenBody: unknown;
  setFetchMock(async (input, init) => {
    seenPath = String(input);
    seenMethod = init?.method ?? "GET";
    seenBody = JSON.parse(String(init?.body));
    return jsonResponse({ ok: true, data: { history_id: "h-123", starred_at: "2026-09-01T00:00:00Z" } });
  });

  assert.deepEqual(await setHistoryStar("summit", "h-123", true), {
    ok: true,
    starredAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(seenPath, "/api/history/sessions/summit/h-123/star");
  assert.equal(seenMethod, "POST");
  assert.deepEqual(seenBody, { starred: true });

  setFetchMock(async () => jsonResponse({ ok: true, data: { history_id: "h-123", starred_at: null } }));
  assert.deepEqual(await setHistoryStar("summit", "h-123", false), { ok: true });
});

test("resumeHistorySession posts no browser-selected launch arguments and returns the live id", async () => {
  let seenPath = "";
  let seenInit: RequestInit | undefined;
  setFetchMock(async (input, init) => {
    seenPath = String(input);
    seenInit = init;
    return jsonResponse({
      ok: true,
      data: { session: { id: "live-9", agent: "codex", private_runtime_path: "/private" } },
    });
  });

  assert.deepEqual(await resumeHistorySession("summit", "h-123"), {
    ok: true,
    id: "live-9",
    session: { id: "live-9", agent: "codex", machine: "summit" },
  });
  assert.equal(seenPath, "/api/history/sessions/summit/h-123/resume");
  assert.equal(seenInit?.method, "POST");
  assert.equal(seenInit?.body, undefined);
});

test("resumeHistorySession reports the live session that already owns the conversation", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: {
      code: "history-session-live",
      message: "this conversation is already open; switching to its live session",
      live_session_id: "live-owner",
    },
  }, { status: 409 }));

  // Both resume entry points land on result.id, so the live owner is returned
  // as the session to open rather than as a failure to show.
  assert.deepEqual(await resumeHistorySession("summit", "h-123"), {
    ok: true,
    id: "live-owner",
    alreadyLive: true,
  });

  setFetchMock(async () => jsonResponse({
    ok: false,
    error: { code: "history-session-live", message: "this conversation is already open; switching to its live session" },
  }, { status: 409 }));
  assert.deepEqual(await resumeHistorySession("summit", "h-123"), {
    ok: false,
    error: "this conversation is already open; switching to its live session",
    errorCode: "history-session-live",
  });
});

test("resumeHistorySession rejects every 2xx response without a created session", async () => {
  const responses = [
    new Response(null, { status: 200 }),
    new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    jsonResponse({ ok: true, data: { session: { id: "", agent: "codex" } } }),
  ];
  for (const response of responses.slice(0, 2)) {
    setFetchMock(async () => response);
    const result = await resumeHistorySession("summit", "h-123");
    assert.equal(result.ok, false);
    assert.equal(result.outcomeUnknown, true);
  }
  setFetchMock(async () => responses[2]!);
  assert.deepEqual(await resumeHistorySession("summit", "h-123"), {
    ok: false,
    error: "History resume returned no created session.",
    outcomeUnknown: true,
  });
});

test("lookupLiveHistorySession matches the exact provider thread in owner-scoped inventory", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions: [
    { id: "other-machine", machine: "m2", agent: "claude", status: "running", provider_resume: { provider: "claude", session_id: "thread-1" } },
    { id: "other-thread", machine: "maple", agent: "claude", status: "running", provider_resume: { provider: "claude", session_id: "thread-other" } },
    { id: "live-match", machine: "maple", agent: "claude", status: "running", provider_resume: { provider: "claude", session_id: "thread-1" } },
  ], machines: [{ name: "maple", ok: true }] } }));
  assert.equal(await lookupLiveHistorySession("maple", "claude", "thread-1"), "live-match");
});

test("lookupLiveHistorySession ignores stopped matches and opens the sole running exact match", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions: [
    { id: "stopped-old", machine: "maple", agent: "claude", status: "stopped", provider_resume: { provider: "claude", session_id: "thread-1" } },
    { id: "running-new", machine: "maple", agent: "claude", status: "running", provider_resume: { provider: "claude", session_id: "thread-1" } },
  ], machines: [{ name: "maple", ok: true }] } }));
  assert.equal(await lookupLiveHistorySession("maple", "claude", "thread-1"), "running-new");
});

test("lookupLiveHistorySession leaves stopped-only and ambiguous running matches unknown", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions: [
    { id: "stopped-only", machine: "maple", agent: "claude", status: "stopped", provider_resume: { provider: "claude", session_id: "thread-1" } },
  ], machines: [{ name: "maple", ok: true }] } }));
  assert.equal(await lookupLiveHistorySession("maple", "claude", "thread-1"), undefined);

  setFetchMock(async () => jsonResponse({ ok: true, data: { sessions: [
    { id: "running-one", machine: "maple", agent: "claude", status: "running", provider_resume: { provider: "claude", session_id: "thread-1" } },
    { id: "running-two", machine: "maple", agent: "claude", status: "running", provider_resume: { provider: "claude", session_id: "thread-1" } },
  ], machines: [{ name: "maple", ok: true }] } }));
  assert.equal(await lookupLiveHistorySession("maple", "claude", "thread-1"), undefined);
});

test("lookupLiveHistorySession treats a degraded target machine as unchecked", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: {
    sessions: [
      { id: "stale-result", machine: "maple", agent: "claude", status: "running", provider_resume: { provider: "claude", session_id: "thread-1" } },
    ],
    machines: [{ name: "maple", ok: false, error: "reader unavailable" }],
  } }));
  await assert.rejects(
    lookupLiveHistorySession("maple", "claude", "thread-1"),
    /Live sessions could not be checked/,
  );
});

test("resumeHistorySession preserves safe typed failures and determinate daemon reads", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: { code: "history-read-failed", message: "session history could not be read; refresh History and try again" },
  }, { status: 500 }));

  assert.deepEqual(await resumeHistorySession("summit", "h-123"), {
    ok: false,
    error: "session history could not be read; refresh History and try again",
    errorCode: "history-read-failed",
  });

  setFetchMock(async () => jsonResponse({
    ok: false,
    error: {
      code: "history-resume-profile-unavailable",
      message: "history resume profile is unavailable; refresh History and try again",
    },
  }, { status: 503 }));
  assert.deepEqual(await resumeHistorySession("summit", "h-profile"), {
    ok: false,
    error: "history resume profile is unavailable; refresh History and try again",
    errorCode: "history-resume-profile-unavailable",
  });
});

test("archiveSession forwards a requested star and reports the star it landed with", async () => {
  let seenBody: unknown;
  setFetchMock(async (_input, init) => {
    seenBody = JSON.parse(String(init?.body));
    return jsonResponse({ ok: true, data: {
      archived: {
        id: "h-123",
        provider: "codex",
        provider_session_id: "provider-1",
        cwd: "/repo/agent-console",
        created_at: "2026-08-30T00:00:00Z",
        updated_at: "2026-08-31T00:00:00Z",
        starred_at: "2026-09-01T00:00:00Z",
        resumable: false,
      },
      deleted: { id: "live-1", deleted: true, killed: true, cleanup_pending: false },
    } });
  });

  assert.deepEqual(await archiveSession("summit", "live-1", "launch-1", { starred: true }), {
    ok: true,
    starredAt: "2026-09-01T00:00:00Z",
  });
  assert.deepEqual(seenBody, { expected_session_incarnation: "launch-1", starred: true });
});

test("archiveSession retains a typed child-guard refusal without retrying or reporting a star", async () => {
  let calls = 0;
  let seenBody: unknown;
  setFetchMock(async (_input, init) => {
    calls += 1;
    seenBody = JSON.parse(String(init?.body));
    return jsonResponse({ ok: false, error: {
      code: "session-has-live-children",
      message: "this session still has child sessions; close them before archiving or deleting it",
    } }, { status: 409 });
  });
  assert.deepEqual(await archiveSession("summit", "child-1", "launch-child", { starred: true }), {
    ok: false,
    error: "this session still has child sessions; close them before archiving or deleting it",
    errorCode: "session-has-live-children",
  });
  assert.equal(calls, 1);
  assert.deepEqual(seenBody, { expected_session_incarnation: "launch-child", starred: true });
});

test("Usage reads retry transient transport failures before reporting an outage", async () => {
  let calls = 0;
  setFetchMock(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("temporary connection failure");
    return jsonResponse({ data: { reachable: true, providers: [] } });
  });
  assert.equal((await usage()).reachable, true);
  assert.equal(calls, 3);
});



test("Usage transport exhaustion identifies the console connection without raw native details", async () => {
  let calls = 0;
  setFetchMock(async () => {
    calls += 1;
    throw new Error("error sending request for url (https://private-host/api/usage)");
  });
  await assert.rejects(usage(), /Cannot reach the console server/);
  assert.equal(calls, 3);
});

test("Usage authentication failures are not retried or mislabeled as host outages", async () => {
  let calls = 0;
  setFetchMock(async () => {
    calls += 1;
    return jsonResponse({ ok: false, error: { message: "unauthorized" } }, { status: 401 });
  });
  await assert.rejects(usage(), /Authentication/);
  assert.equal(calls, 1);
});

const CLAUDE_BOUND = {
  schema_version: "agent-session.claude-account.v1",
  supported: true,
  state: "bound",
  selected_account: "alpha",
  selection_source: "default_at_launch",
  revision: 1,
  applied_runtime_id: "launch-c1",
} as const;

test("listSessions keeps a Claude account view only where the machine advertises claude_account_switch", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: {
    sessions: [
      { id: "c1", agent: "claude", status: "running", machine: "maple", claude_account: { ...CLAUDE_BOUND, config_dir: "/private" } },
      { id: "c2", agent: "claude", status: "running", machine: "old", claude_account: CLAUDE_BOUND },
    ],
    machines: [
      { name: "maple", ok: true, capabilities: { claude_account_switch: true } },
      { name: "old", ok: true },
    ],
  } }));

  const result = await listSessions();
  assert.deepEqual(result.sessions[0]!.claude_account, CLAUDE_BOUND);
  assert.equal("claude_account" in result.sessions[1]!, false);
  assert.equal(result.machines[0]!.capabilities?.claude_account_switch, true);
});

test("Claude account helpers list nicknames and confirm a queued or applied switch", async () => {
  const requests: Array<{ url: string; method: string; body: string }> = [];
  let answer: unknown = {};
  setFetchMock(async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url.endsWith("/claude/accounts")) {
      return jsonResponse({ ok: true, data: {
        accounts: [{ account: "alpha", label: "Alpha", config_dir: "/private" }, { account: "../bad" }],
        selection_strategies: ["current_default"],
      } });
    }
    return jsonResponse(answer);
  });

  assert.deepEqual(await listAccounts("claude", "maple"), {
    accounts: [{ account: "alpha", label: "Alpha" }],
    selection_strategies: ["current_default"],
  });

  answer = { ok: true, data: {
    session_incarnation: "launch-c1",
    claude_account: { ...CLAUDE_BOUND, next: { account: "beta", revision: 2, state: "queued" } },
  } };
  const queued = await switchSessionAccount("claude", "maple", "c1", "beta", "launch-c1");
  assert.equal(queued.ok, true);
  assert.equal(queued.account?.next?.account, "beta");

  answer = { ok: true, data: {
    session_incarnation: "launch-c2",
    claude_account: { ...CLAUDE_BOUND, selected_account: "beta", selection_source: "explicit", revision: 2, applied_runtime_id: "launch-c2" },
  } };
  assert.equal((await switchSessionAccount("claude", "maple", "c1", "beta", "launch-c1")).ok, true);

  answer = { ok: true, data: { session_incarnation: "launch-c1", claude_account: CLAUDE_BOUND } };
  assert.deepEqual(await switchSessionAccount("claude", "maple", "c1", "beta", "launch-c1"), {
    ok: false,
    error: "Claude account switch was not confirmed",
  });

  assert.deepEqual(requests.slice(0, 2), [
    { url: "/api/machines/maple/claude/accounts", method: "GET", body: "" },
    {
      url: "/api/sessions/maple/c1/account",
      method: "PUT",
      body: JSON.stringify({ account: "beta", expected_session_incarnation: "launch-c1" }),
    },
  ]);
});

test("Claude account switch surfaces a refused switch as determinate", async () => {
  setFetchMock(async () => jsonResponse({
    ok: false,
    error: {
      code: "claude-account-switch-refused",
      message: "the new Claude account could not be prepared; the running session was left unchanged",
    },
  }, { status: 422 }));

  assert.deepEqual(await switchSessionAccount("claude", "maple", "c1", "beta", "launch-c1"), {
    ok: false,
    error: "the new Claude account could not be prepared; the running session was left unchanged",
  });
});

test("createSession keeps a new Claude session's account binding like a Codex one", async () => {
  setFetchMock(async () => jsonResponse({
    ok: true,
    data: {
      session: {
        id: "created-claude",
        agent: "claude",
        session_incarnation: "launch-c1",
        claude_account: { ...CLAUDE_BOUND, config_dir: "/private" },
      },
    },
  }));

  const created = await createSession("maple", { agent: "claude", claude_account: "alpha" });
  assert.equal(created.ok, true);
  assert.deepEqual(created.session?.claude_account, CLAUDE_BOUND);
  assert.equal("codex_account" in (created.session ?? {}), false);
});


test("title mode switches send exact metadata fences and require the persisted response", async () => {
  const session = {machine: "fixture", id: "s1", agent: "codex", status: "running", created_at: "2026-10-07T00:00:00Z", display_revision: 2};
  setFetchMock((url, init) => {
    assert.match(url, /sessions\/fixture\/s1\/display-metadata$/);
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {title_mode: "pinned", expected_revision: 2, expected_session_created_at: session.created_at});
    return jsonResponse({ok: true, data: {session: {...session, title_mode: "pinned", display_revision: 3}}});
  });
  assert.deepEqual(await updateSessionTitleMode(session, "pinned"), {ok: true, revision: 3});
  setFetchMock(() => jsonResponse({ok: true, data: {session: {...session, title_mode: "auto", display_revision: 3}}}));
  assert.equal((await updateSessionTitleMode(session, "pinned")).ok, false);
  setFetchMock(() => jsonResponse({ok: false, error: {message: "Refresh metadata"}}, {status: 409}));
  assert.deepEqual(await updateSessionTitleMode(session, "pinned"), {ok: false, error: "Refresh metadata"});
  assert.equal((await updateSessionTitleMode({...session, display_revision: undefined}, "pinned")).ok, false);
});

test("listSessions retains workspace and origin from mixed-version edge projections", async () => {
  const parent = { session_id: "parent", machine: "host-a" };
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, data: { sessions: [
    { id: "worker", machine: "host-a", agent: "codex", workspace: "team-a", origin: { parent } },
    { id: "manual", machine: "host-a", agent: "codex", workspace: null, origin: { parent: null } },
    { id: "legacy", machine: "host-a", agent: "codex" },
  ] } }), { status: 200 })) as typeof fetch;
  const out = await listSessions();
  assert.deepEqual(out.sessions.map(row => [row.workspace, row.origin]), [["team-a", { parent }], [null, { parent: null }], [undefined, undefined]]);
});

test("session list keeps response extension capabilities without deriving private session fields", async () => {
  setFetchMock(async () => jsonResponse({ ok: true, data: { machines: [], sessions: [], ext: { sample: { mode: "custom" } }, capabilities: { sample_mode: "custom" } } }));
  const result = await listSessions();
  assert.deepEqual(result.ext, { sample: { mode: "custom" } });
  assert.equal(result.capabilities?.sample_mode, "custom");
});


test("listSessions gates last_message on both edge and daemon support", async () => {
  for (const edge of [true, false]) for (const daemon of [true, false]) {
    setFetchMock(async () => jsonResponse({ok: true, data: {
      capabilities: {last_message: edge}, machines: [{name: "fixture", ok: true, capabilities: {last_message: daemon}}],
      sessions: [{id: "s", agent: "codex", status: "running", machine: "fixture", last_message: {role: "assistant", text: "Done\nnow"}, last_prompt: {text: "Check this"}}],
    }}));
    const response = await listSessions();
    assert.deepEqual(response.sessions[0]?.last_message, edge && daemon ? {role: "assistant", text: "Done now"} : undefined);
    assert.equal(response.sessions[0]?.last_prompt?.text, "Check this");
    assert.equal(response.capabilities?.last_message, edge);
  }
});
