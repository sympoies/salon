import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DebugEvent } from "@agent-console/shared/api";
import {
  createPerformanceSummary,
  loadPerformanceCapture,
  startPerformanceCapture,
  stopPerformanceCapture,
} from "../src/performanceSummary.ts";

const app = {
  version: "0.3.9",
  build_sha: "abc123",
  surface: "macos" as const,
  url: "https://secret.example/private",
  server_url: "https://secret.example",
  user_agent: "private-device",
};

function event(at: string, extra: Partial<DebugEvent>): DebugEvent {
  return {
    seq: 1, at, source: "client", request_id: null, method: "GET",
    route: "/api/sessions", status: 200, ok: true, duration_ms: 100,
    machine: null, session_id: null, error: null, ...extra,
  };
}

test("summarizes only the selected window, routes and WebSocket recovery without identifiers", () => {
  const summary = createPerformanceSummary({
    capture: { scenario: "offline-recovery", started_at: "2026-09-26T10:00:00.000Z" },
    endedAt: "2026-09-26T10:01:00.000Z",
    app,
    events: [
      event("2026-09-26T09:59:59.000Z", { duration_ms: 5000 }),
      event("2026-09-26T10:00:01.000Z", { provenance: "poll", duration_ms: 120 }),
      event("2026-09-26T10:00:02.000Z", { provenance: "fresh", duration_ms: 80 }),
      event("2026-09-26T10:00:03.000Z", {
        method: "POST", route: "/api/sessions/private/secret/attach-ticket",
        machine: "private", session_id: "secret", error: "Bearer secret-token",
        duration_ms: 50,
      }),
      event("2026-09-26T10:00:03.500Z", {
        source: "ws", method: "WS", route: "/api/sessions/:machine/:id/attach",
        machine: "private", session_id: "secret", status: 101, ok: true,
      }),
      event("2026-09-26T10:00:03.900Z", {
        source: "ws", method: "WS", route: "/api/sessions/:machine/:id/attach",
        machine: "private", session_id: "secret", status: null, ok: false, error: "socket error",
      }),
      event("2026-09-26T10:00:04.000Z", {
        source: "ws", method: "WS", route: "/api/sessions/:machine/:id/attach",
        machine: "private", session_id: "secret", status: null, ok: false, error: "closed",
      }),
      event("2026-09-26T10:00:05.000Z", {
        source: "ws", method: "WS", route: "/api/sessions/:machine/:id/attach",
        machine: "private", session_id: "secret", status: null, ok: null,
      }),
      event("2026-09-26T10:00:06.000Z", {
        source: "ws", method: "WS", route: "/api/sessions/:machine/:id/attach",
        machine: "private", session_id: "secret", status: 101, ok: true,
      }),
      event("2026-09-26T10:00:07.000Z", {
        source: "ws", method: "WS", route: "/api/sessions/:machine/:id/attach",
        machine: "other", session_id: "sensitive", status: null, ok: false, error: "closed",
      }),
    ],
  });

  assert.equal(summary.kind, "agent-console.performance-summary.v1");
  assert.equal(summary.scenario, "offline-recovery");
  assert.equal(summary.http.session_list.requests, 2);
  assert.equal(summary.http.session_list.automatic_requests, 1);
  assert.equal(summary.http.session_list.fresh_requests, 1);
  assert.equal(summary.http.session_list.first_success_ms, 1000);
  assert.equal(summary.http.attach_ticket.requests, 1);
  assert.equal(summary.websocket.disconnects, 2);
  assert.equal(summary.websocket.failure_events, 1);
  assert.equal(summary.websocket.recovered_panes, 1);
  assert.equal(summary.websocket.unresolved_disconnects, 1);
  assert.equal(summary.websocket.recovery_p50_ms, 2000);
  const json = JSON.stringify(summary);
  for (const forbidden of ["private", "secret", "Bearer", "secret-token", "user_agent", "server_url"]) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
});

test("capture is explicit, bounded to the traffic retention window, and clearable", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const started = startPerformanceCapture("slow-network", storage, "2026-09-26T10:00:00.000Z");
  assert.deepEqual(loadPerformanceCapture(storage, "2026-09-26T10:05:00.000Z"), started);
  assert.equal(loadPerformanceCapture(storage, "2026-09-26T10:31:00.000Z"), null);
  assert.equal(values.size, 0);
  startPerformanceCapture("normal", storage, "2026-09-26T11:00:00.000Z");
  stopPerformanceCapture(storage);
  assert.equal(loadPerformanceCapture(storage, "2026-09-26T11:01:00.000Z"), null);
});

test("capture exposes an unfinished native request and the separate caller deadline", () => {
  const summary = createPerformanceSummary({
    capture: { scenario: "slow-network", started_at: "2026-09-26T10:00:00.000Z" },
    endedAt: "2026-09-26T10:00:10.000Z", app,
    events: [
      event("2026-09-26T10:00:01.000Z", { request_id: "a", ok: null, status: null, duration_ms: null, phase: "request_start", provenance: "poll" }),
      event("2026-09-26T10:00:02.000Z", { request_id: "b", ok: null, status: null, duration_ms: null, phase: "request_start", provenance: "fresh" }),
      event("2026-09-26T10:00:03.000Z", { request_id: "b", duration_ms: 1000, provenance: "fresh" }),
      event("2026-09-26T10:00:09.000Z", { route: "/performance/session-list", phase: "deadline_timeout", ok: false, status: null, duration_ms: 8000 }),
      event("2026-09-26T10:00:03.050Z", { route: "/performance/session-list", phase: "usable", ok: true, status: null, duration_ms: null }),
    ],
  });
  assert.equal(summary.http.session_list.requests, 1);
  assert.equal(summary.http.session_list.attempts, 2);
  assert.equal(summary.http.session_list.outstanding_attempts, 1);
  assert.equal(summary.http.session_list.caller_deadline_timeouts, 1);
  assert.equal(summary.http.session_list.caller_capacity_rejections, 0);
  assert.equal(summary.http.session_list.automatic_attempts, 1);
  assert.equal(summary.http.session_list.fresh_attempts, 1);
  assert.equal(summary.http.session_list.automatic_requests, 0);
  assert.equal(summary.http.session_list.fresh_requests, 1);
  assert.equal(summary.http.session_list.max_overlapping_requests, 2);
  assert.equal(summary.http.session_list.usable_list_ms, 3050);
});

test("capacity rejection remains distinct from a waited deadline", () => {
  const summary = createPerformanceSummary({
    capture: { scenario: "slow-network", started_at: "2026-09-26T10:00:00.000Z" },
    endedAt: "2026-09-26T10:00:10.000Z", app,
    events: [event("2026-09-26T10:00:02.000Z", {
      route: "/performance/session-list", phase: "capacity_rejected", ok: false,
      status: null, duration_ms: null,
    })],
  });
  assert.equal(summary.http.session_list.caller_deadline_timeouts, 0);
  assert.equal(summary.http.session_list.caller_capacity_rejections, 1);
});
