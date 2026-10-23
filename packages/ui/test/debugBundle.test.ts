import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import type { DebugDiagnosticResult, DebugEvent } from "@agent-console/shared/api";
import {
  createDebugAgentBundle,
  createStartupFailureDebugBundle,
  debugAgentBundleMarkdown,
} from "../src/debugBundle.ts";
import { clearDebugEvents, recordDebugEvent } from "../src/debugLog.ts";
import { startupFailureDiagnostic } from "../src/startupFailure.ts";
import { makeSession } from "./support/fixtures.ts";

const event = {
  seq: 7,
  at: "2026-07-07T20:00:00.000Z",
  source: "client",
  request_id: "acreq_bundle",
  method: "GET",
  route: "/api/sessions/:machine",
  status: 200,
  ok: true,
  duration_ms: 11,
  machine: "summit",
  session_id: null,
  error: null,
} satisfies DebugEvent;

const diagnostics = {
  generated_at: "2026-07-07T20:00:01.000Z",
  ok: true,
  probes: [
    {
      name: "edge health",
      route: "/healthz",
      request_id: "acreq_probe",
      status: 200,
      ok: true,
      duration_ms: 5,
      error: null,
    },
  ],
} satisfies DebugDiagnosticResult;

afterEach(() => clearDebugEvents());

test("agent bundle includes redacted app context, diagnostics, and events", () => {
  const bundle = createDebugAgentBundle({
    now: "2026-07-07T20:00:02.000Z",
    app: {
      version: "0.1.0",
      build_sha: "abc123",
      surface: "web",
      url: "https://example.test/debug",
      server_url: null,
      user_agent: "node-test",
    },
    clientEvents: [event],
    edgeEvents: [],
    diagnostics,
  });

  assert.equal(bundle.kind, "agent-console.debug_bundle.v1");
  assert.equal(bundle.app.version, "0.1.0");
  assert.equal(bundle.diagnostics?.probes[0]?.route, "/healthz");
  assert.equal(bundle.client_events[0]?.request_id, "acreq_bundle");

  const markdown = debugAgentBundleMarkdown(bundle);
  assert.match(markdown, /Agent Console Debug Bundle/);
  assert.match(markdown, /edge health/);
  assert.match(markdown, /\/api\/sessions\/:machine/);
  assert.doesNotMatch(markdown, /Bearer/);
  assert.doesNotMatch(markdown, /secret/);
});

test("agent bundle carries only normalized startup failure metadata", () => {
  const bundle = createDebugAgentBundle({
    now: "2026-07-14T10:00:04Z",
    app: {
      version: "0.1.0",
      build_sha: "abc123",
      surface: "android",
      url: null,
      server_url: null,
      user_agent: null,
    },
    clientEvents: [],
    edgeEvents: [],
    diagnostics: null,
    sessionStartupFailure: {
      machine: "summit",
      session_id: "hs-failed",
      startup: {
        schema_version: "agent-session.startup.v1",
        state: "failed",
        stage: "runtime",
        started_at: "2026-07-14T10:00:00Z",
        failure_code: "agent-binary-unavailable",
        message: "The selected agent CLI could not be started.",
        occurred_at: "2026-07-14T10:00:03Z",
        retry_safe: false,
      },
    },
  });

  assert.deepEqual(bundle.session_startup_failure, {
    machine: "summit",
    session_id: "hs-failed",
    startup: {
      schema_version: "agent-session.startup.v1",
      state: "failed",
      stage: "runtime",
      started_at: "2026-07-14T10:00:00Z",
      failure_code: "agent-binary-unavailable",
      message: "The selected agent CLI could not be started.",
      occurred_at: "2026-07-14T10:00:03Z",
      retry_safe: false,
    },
  });
  const markdown = debugAgentBundleMarkdown(bundle);
  assert.match(markdown, /Startup Failure/);
  assert.match(markdown, /agent-binary-unavailable/);
  for (const forbidden of ["prompt", "cwd", "argv", "stderr", "token", "/home/"]) {
    assert.equal(markdown.includes(forbidden), false, forbidden);
  }
});

test("startup failure diagnostics reject content-bearing machine and session identifiers", () => {
  const diagnostic = startupFailureDiagnostic(makeSession({
    machine: "machine/token=secret",
    id: "/home/runner/prompt",
    startup: {
      schema_version: "agent-session.startup.v1",
      state: "failed",
      stage: "runtime",
      started_at: "2026-07-14T10:00:00Z",
      failure_code: "agent-binary-unavailable",
      message: "The selected agent CLI could not be started.",
      occurred_at: "2026-07-14T10:00:03Z",
      retry_safe: false,
    },
  }));

  assert.equal(diagnostic?.machine, "unknown");
  assert.equal(diagnostic?.session_id, "unknown");
});

test("startup failure bundle excludes unrelated debug-ring errors containing paths or provider output", () => {
  recordDebugEvent({
    source: "client",
    route: "/api/sessions/local/hs-failed/resume",
    error: "provider output includes prompt material from $HOME/example/Prompt.txt",
  });
  const diagnostic = startupFailureDiagnostic(makeSession({
    machine: "local",
    id: "hs-failed",
    startup: {
      schema_version: "agent-session.startup.v1",
      state: "failed",
      stage: "runtime",
      started_at: "2026-07-14T10:00:00Z",
      failure_code: "agent-binary-unavailable",
      message: "The selected agent CLI could not be started.",
      occurred_at: "2026-07-14T10:00:03Z",
      retry_safe: false,
    },
  }));
  assert.ok(diagnostic);

  const bundle = createStartupFailureDebugBundle(diagnostic);
  const serialized = JSON.stringify(bundle);

  assert.deepEqual(bundle.client_events, []);
  assert.deepEqual(bundle.edge_events, []);
  assert.equal(serialized.includes("provider output"), false);
  assert.equal(serialized.includes("Prompt.txt"), false);
});
