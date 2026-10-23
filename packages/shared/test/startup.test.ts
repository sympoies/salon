import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  STARTUP_SCHEMA_VERSION,
  normalizeStartupStatus,
  type StartupFailureCode,
  type StartupStage,
} from "../src/api.ts";

const startedAt = "2026-07-14T10:00:00Z";
const occurredAt = "2026-07-14T10:00:03.125Z";

test("startup preserves the producer runtime fallback vocabulary without raw diagnostics", () => {
  const ready = { schema_version: STARTUP_SCHEMA_VERSION, state: "ready", stage: "initial_connection", started_at: startedAt };
  for (const reason of [
    "codex-unavailable", "codex-version-unrecognized", "codex-version-too-old",
    "codex-app-server-transport-unavailable", "codex-app-server-runtime-dir-unavailable",
    "codex-app-server-runtime-dir-unsafe", "codex-app-server-socket-path-too-long",
    "codex-app-server-runtime-unavailable",
  ]) {
    assert.deepEqual(normalizeStartupStatus({ ...ready, runtime_fallback: reason, stderr: "untrusted diagnostic" }), {
      ...ready, runtime_fallback: reason,
    }, reason);
  }
  assert.deepEqual(normalizeStartupStatus(ready), ready, "old daemons omit fallback");
  for (const unknown of ["future-reason", "untrusted diagnostic", { reason: "codex-unavailable" }, null]) {
    assert.deepEqual(normalizeStartupStatus({ ...ready, runtime_fallback: unknown }), ready);
  }
});

const failures = [
  ["runtime-helper-unavailable", "proxy", "Session runtime helper is unavailable after an upgrade.", true],
  ["agent-binary-unavailable", "runtime", "The selected agent CLI could not be started.", false],
  ["working-directory-unavailable", "record", "The selected working directory is unavailable.", false],
  ["terminal-runtime-create-failed", "tmux", "The terminal runtime could not be created.", true],
  ["app-server-start-failed", "app_server", "The agent control server did not become ready.", true],
  ["proxy-start-failed", "proxy", "Agent Console could not connect the terminal to the agent runtime.", true],
  ["provider-client-exited", "provider_client", "The agent exited before the session was ready.", true],
  ["provider-configuration-rejected", "provider_client", "The agent needs configuration or sign-in on this machine.", false],
  ["startup-timeout", "initial_connection", "Session startup timed out; the outcome may be uncertain.", false],
  ["startup-exited", "initial_connection", "The session stopped during startup.", true],
] as const satisfies readonly (readonly [StartupFailureCode, StartupStage, string, boolean])[];

test("normalizeStartupStatus accepts starting and ready without failure fields", () => {
  for (const state of ["starting", "ready"] as const) {
    assert.deepEqual(normalizeStartupStatus({
      schema_version: STARTUP_SCHEMA_VERSION,
      state,
      stage: state === "starting" ? "runtime" : "initial_connection",
      started_at: startedAt,
      secret: "drop me",
    }), {
      schema_version: STARTUP_SCHEMA_VERSION,
      state,
      stage: state === "starting" ? "runtime" : "initial_connection",
      started_at: startedAt,
    });
  }
});

test("normalizeStartupStatus accepts every documented failure class and drops raw diagnostics", () => {
  for (const [failureCode, stage, message, retrySafe] of failures) {
    const normalized = normalizeStartupStatus({
      schema_version: STARTUP_SCHEMA_VERSION,
      state: "failed",
      stage,
      started_at: startedAt,
      failure_code: failureCode,
      message,
      occurred_at: occurredAt,
      retry_safe: retrySafe,
      prompt: "private prompt",
      cwd: "/home/runner/repo",
      argv: ["--token", "secret"],
      stderr: "Bearer secret",
    });
    assert.deepEqual(normalized, {
      schema_version: STARTUP_SCHEMA_VERSION,
      state: "failed",
      stage,
      started_at: startedAt,
      failure_code: failureCode,
      message,
      occurred_at: occurredAt,
      retry_safe: retrySafe,
    }, failureCode);
  }
});

test("normalizeStartupStatus keeps the bounded cleanup caveat and nothing more", () => {
  const failed = {
    schema_version: STARTUP_SCHEMA_VERSION,
    state: "failed",
    stage: "tmux",
    started_at: startedAt,
    failure_code: "terminal-runtime-create-failed",
    message: "The terminal runtime could not be created.",
    occurred_at: occurredAt,
    retry_safe: true,
  } as const;
  const reasons = [
    "session_still_running",
    "process_boundary_live",
    "runtime_identity_changed",
    "runtime_identity_unavailable",
    "termination_failed",
    "termination_timeout",
    "verification_failed",
    "cleanup_unavailable",
    "unknown",
  ] as const;
  for (const state of ["pending", "blocked"] as const) {
    for (const reason of reasons) {
      // The startup failure stays primary; cleanup is only a caveat beside it.
      assert.deepEqual(
        normalizeStartupStatus({ ...failed, cleanup: { state, reason } }),
        { ...failed, cleanup: { state, reason } },
        `${state}/${reason}`,
      );
    }
  }
  // Absent cleanup carries no caveat at all.
  assert.deepEqual(normalizeStartupStatus(failed), failed);
  for (const value of [
    { ...failed, cleanup: { state: "completed", reason: "unknown" } },
    { ...failed, cleanup: { state: "pending", reason: "kill-failed" } },
    { ...failed, cleanup: { state: "pending" } },
    { ...failed, cleanup: { reason: "unknown" } },
    { ...failed, cleanup: { state: "pending", reason: "unknown", pid: 4242 } },
    { ...failed, cleanup: "pending" },
    { ...failed, cleanup: null },
    // A projection that never launched anything must not claim a caveat.
    {
      schema_version: STARTUP_SCHEMA_VERSION,
      state: "starting",
      stage: "tmux",
      started_at: startedAt,
      cleanup: { state: "pending", reason: "unknown" },
    },
  ]) {
    assert.equal(normalizeStartupStatus(value), null, JSON.stringify(value));
  }
});

test("normalizeStartupStatus rejects malformed, future, partial, and mismatched projections", () => {
  const valid = {
    schema_version: STARTUP_SCHEMA_VERSION,
    state: "failed",
    stage: "proxy",
    started_at: startedAt,
    failure_code: "proxy-start-failed",
    message: "Agent Console could not connect the terminal to the agent runtime.",
    occurred_at: occurredAt,
    retry_safe: true,
  } as const;
  const invalid = [
    null,
    [],
    { ...valid, schema_version: "agent-session.startup.v2" },
    { ...valid, state: "recovering" },
    { ...valid, stage: "shell" },
    { ...valid, started_at: "2026-02-30T10:00:00Z" },
    { ...valid, occurred_at: "yesterday" },
    { ...valid, failure_code: "raw-spawn-error" },
    { ...valid, message: "spawn /secret/path ENOENT" },
    { ...valid, stage: "runtime" },
    { ...valid, retry_safe: false },
    { ...valid, failure_code: undefined },
    { ...valid, occurred_at: undefined },
    { ...valid, state: "ready" },
    { ...valid, state: "starting" },
  ];
  for (const value of invalid) {
    assert.equal(normalizeStartupStatus(value), null, JSON.stringify(value));
  }
});
