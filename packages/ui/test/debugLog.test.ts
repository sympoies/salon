import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import {
  DEBUG_EVENTS_STORAGE_KEY,
  clearDebugEvents,
  debugEvents,
  debugEventsMarkdown,
  flushDebugEvents,
  hydrateDebugEventsFromStorage,
  recordDebugEvent,
  redactDebugPath,
  subscribeDebugEvents,
} from "../src/debugLog.ts";
import { setPrincipalStorageNamespace } from "../src/storage.ts";

let restoreStorage: (() => void) | null = null;

afterEach(() => {
  clearDebugEvents();
  setPrincipalStorageNamespace(null);
  restoreStorage?.();
  restoreStorage = null;
});

function installMemoryStorage(): Storage {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  restoreStorage = () => {
    if (previous) {
      Object.defineProperty(globalThis, "localStorage", previous);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  };
  return storage;
}

test("redactDebugPath strips query values and replaces machine/session ids", () => {
  assert.equal(
    redactDebugPath("/api/sessions/summit/hs-codex-123/send?token=secret&cwd=/home/runner/private"),
    "/api/sessions/:machine/:id/send",
  );
  assert.equal(redactDebugPath("/api/machines/mesa/repo-url?cwd=/secret/repo"), "/api/machines/:machine/repo-url");
});

test("debug event ring buffer is bounded and coalesces subscriber notifications", async () => {
  const counts: number[] = [];
  const unsubscribe = subscribeDebugEvents((events) => {
    counts.push(events.length);
  });

  for (let i = 0; i < 1205; i += 1) {
    recordDebugEvent({ source: "client", route: `/api/example/${i}`, ok: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  unsubscribe();

  const events = debugEvents();
  assert.equal(events.length, 1000);
  assert.equal(events[0]?.route, "/api/example/205");
  assert.equal(events.at(-1)?.route, "/api/example/1204");
  assert.ok(counts.length > 0);
  assert.equal(counts.length, 1);
  assert.equal(counts.at(-1), 1000);
});

test("routine polling cannot evict a failure or a lifecycle row", () => {
  recordDebugEvent({
    source: "client",
    method: "POST",
    route: "/api/sessions/:machine/:id/retitle-v3",
    status: 200,
    ok: false,
    errorEnvelope: {
      ok: false,
      error: {
        code: "retitle-v3-history-conflict",
        message: "The session history changed.",
        details: {
          retryable: true,
          next_action: "refresh_session",
          recovery: { strategy: "refresh_and_retry", safe_to_retry: true },
        },
      },
    },
  });
  recordDebugEvent({
    source: "edge",
    route: "/title-lifecycle",
    ok: null,
    operation: "title",
    outcome: "daemon_v3_terminal_failure",
    failure_class: "retitle-v3-history-conflict",
  });

  // Far past the traffic ring's own capacity: under one ring these two rows
  // would be long gone, which is exactly the look-back problem.
  for (let i = 0; i < 1500; i += 1) {
    recordDebugEvent({ source: "client", route: "/api/sessions", ok: true });
  }

  const kept = debugEvents();
  const failure = kept.find((event) => event.ok === false);
  const lifecycle = kept.find((event) => event.operation === "title");
  assert.ok(failure, "the failed mutation was evicted by routine polling");
  assert.ok(lifecycle, "the lifecycle outcome was evicted by routine polling");
  assert.equal(failure?.code, "retitle-v3-history-conflict");
  assert.equal(failure?.retryable, true);
  assert.equal(failure?.next_action, "refresh_session");
  assert.equal(failure?.recovery_strategy, "refresh_and_retry");
  assert.equal(failure?.recovery_safe_to_retry, true);
  assert.equal(lifecycle?.failure_class, "retitle-v3-history-conflict");
  assert.equal(kept.filter((event) => event.route === "/api/sessions").length, 1000);
  // Sequence order still holds across the two populations.
  assert.deepEqual([...kept].sort((a, b) => a.seq - b.seq).map((e) => e.seq), kept.map((e) => e.seq));

  const markdown = debugEventsMarkdown(kept);
  assert.match(markdown, /code=retitle-v3-history-conflict retryable=true next_action=refresh_session/);
  assert.match(markdown, /failure_class=retitle-v3-history-conflict/);
});

test("a free-text response body never reaches the ring through the failure envelope", () => {
  const event = recordDebugEvent({
    source: "client",
    route: "/api/sessions/:machine/:id/retitle-v3",
    ok: false,
    errorEnvelope: {
      ok: false,
      error: {
        code: "the provider said: rm -rf / and other prose",
        message: "a long human message that is not a token",
        details: {
          retryable: "yes",
          next_action: "please refresh the session and try again",
          recovery: { strategy: "do the thing", safe_to_retry: 1 },
        },
      },
    },
  });
  assert.equal(event.code, undefined);
  assert.equal(event.retryable, undefined);
  assert.equal(event.next_action, undefined);
  assert.equal(event.recovery_strategy, undefined);
  assert.equal(event.recovery_safe_to_retry, undefined);
});

test("debug markdown export omits raw secrets and request bodies", () => {
  recordDebugEvent({
    source: "client",
    method: "POST",
    route: "/api/sessions/:machine",
    status: 200,
    ok: true,
    duration_ms: 12,
    request_id: "acreq_test",
    error: "Bearer client-secret should not be copied",
  });

  const markdown = debugEventsMarkdown(debugEvents());
  assert.match(markdown, /\/api\/sessions\/:machine/);
  assert.doesNotMatch(markdown, /client-secret/);
  assert.doesNotMatch(markdown, /Bearer/);
});

test("title lifecycle debug metadata is bounded, persisted, and content-free", () => {
  const event = recordDebugEvent({
    source: "client",
    route: "/title-lifecycle",
    machine: "summit",
    session_id: "20260804-105857-codex",
    operation: "title",
    phase: "initial",
    outcome: "retry_scheduled",
    provenance: "client_supplied",
    attempt_id: "title_opaque123",
    attempt: 1,
  });

  assert.equal(event.operation, "title");
  assert.equal(event.phase, "initial");
  assert.equal(event.outcome, "retry_scheduled");
  assert.equal(event.provenance, "client_supplied");
  assert.equal(event.attempt_id, "title_opaque123");
  assert.equal(event.attempt, 1);
  const markdown = debugEventsMarkdown([event]);
  assert.match(markdown, /operation=title phase=initial outcome=retry_scheduled provenance=client_supplied/);
  assert.match(markdown, /attempt_id=title_opaque123 attempt=1/);
  assert.doesNotMatch(markdown, /prompt|model output|recent output/i);
});

test("debug events persist recent entries and drop expired entries on hydration", async () => {
  const storage = installMemoryStorage();
  const recentAt = new Date().toISOString();
  const expiredAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  storage.setItem(
    DEBUG_EVENTS_STORAGE_KEY,
    JSON.stringify([
      {
        seq: 1,
        at: expiredAt,
        source: "client",
        request_id: null,
        method: "GET",
        route: "/api/expired",
        status: 200,
        ok: true,
        duration_ms: 1,
        machine: null,
        session_id: null,
        error: null,
      },
      {
        seq: 2,
        at: recentAt,
        source: "client",
        request_id: "acreq_recent",
        method: "GET",
        route: "/api/recent",
        status: 200,
        ok: true,
        duration_ms: 2,
        machine: null,
        session_id: null,
        error: null,
      },
    ]),
  );

  hydrateDebugEventsFromStorage();
  assert.deepEqual(debugEvents().map((event) => event.route), ["/api/recent"]);

  recordDebugEvent({ source: "client", route: "/api/next", ok: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const persisted = JSON.parse(storage.getItem(DEBUG_EVENTS_STORAGE_KEY) ?? "[]") as Array<{ route?: string }>;
  assert.deepEqual(persisted.map((event) => event.route), ["/api/recent", "/api/next"]);
});

test("a termination flush persists a pending diagnostic batch", () => {
  const storage = installMemoryStorage();
  recordDebugEvent({ source: "client", route: "/title-lifecycle", outcome: "retry_exhausted" });

  flushDebugEvents();

  const persisted = JSON.parse(storage.getItem(DEBUG_EVENTS_STORAGE_KEY) ?? "[]") as Array<{
    outcome?: string;
  }>;
  assert.equal(persisted.at(-1)?.outcome, "retry_exhausted");
});

test("debug events stay isolated when the authenticated principal changes", () => {
  const storage = installMemoryStorage();

  setPrincipalStorageNamespace("tess");
  hydrateDebugEventsFromStorage();
  recordDebugEvent({ source: "client", route: "/api/tess", ok: true });
  flushDebugEvents();

  setPrincipalStorageNamespace("dana");
  hydrateDebugEventsFromStorage();
  assert.deepEqual(debugEvents(), []);
  recordDebugEvent({ source: "client", route: "/api/dana", ok: true });
  flushDebugEvents();

  setPrincipalStorageNamespace("tess");
  hydrateDebugEventsFromStorage();
  assert.deepEqual(debugEvents().map((event) => event.route), ["/api/tess"]);

  const tess = JSON.parse(
    storage.getItem(`agent-console.principal.tess.${DEBUG_EVENTS_STORAGE_KEY}`) ?? "[]",
  ) as Array<{ route?: string }>;
  const dana = JSON.parse(
    storage.getItem(`agent-console.principal.dana.${DEBUG_EVENTS_STORAGE_KEY}`) ?? "[]",
  ) as Array<{ route?: string }>;
  assert.deepEqual(tess.map((event) => event.route), ["/api/tess"]);
  assert.deepEqual(dana.map((event) => event.route), ["/api/dana"]);
});
