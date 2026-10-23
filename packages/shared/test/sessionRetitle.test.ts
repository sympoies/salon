import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SESSION_RETITLE_CAPABILITY,
  SESSION_RETITLE_READINESS_SCHEMA_VERSION,
  SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
  SESSION_RETITLE_SCHEMA_VERSION,
  SESSION_RETITLE_V3_CAPABILITY,
  SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION,
  SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION,
  SESSION_RETITLE_V3_SCHEMA_VERSION,
  normalizeSessionRetitleError,
  normalizeSessionRetitleReadiness,
  normalizeSessionRetitleRequest,
  normalizeSessionRetitleResult,
  normalizeSessionRetitleV3Readiness,
  normalizeSessionRetitleV3Request,
  normalizeSessionRetitleV3Result,
  sessionRetitleLifecycleOutcome,
} from "../src/sessionRetitle.ts";

const PRODUCER_ERROR_CODES = [
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

test("session retitle readiness keeps only bounded actionable metadata", () => {
  assert.deepEqual(normalizeSessionRetitleReadiness({
    schema_version: SESSION_RETITLE_READINESS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_CAPABILITY,
    status: "unavailable",
    reason_code: "account_missing",
    provider_kind: "codex_subscription",
    model_label: "gpt-5-codex",
    account: "work",
    plan: "pro",
    next_action: "select_account",
    context_capabilities: {
      codex: "provider_transcript",
      claude: "provider_transcript",
      hermes: "unavailable",
    },
    access_token: "secret",
    prompt: "private prompt",
    diagnostics: { response: "private model output" },
  }), {
    schema_version: SESSION_RETITLE_READINESS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_CAPABILITY,
    status: "unavailable",
    reason_code: "account_missing",
    provider_kind: "codex_subscription",
    model_label: "gpt-5-codex",
    account: "work",
    plan: "pro",
    next_action: "select_account",
    context_capabilities: {
      codex: "provider_transcript",
      claude: "provider_transcript",
    },
  });
  assert.equal(normalizeSessionRetitleReadiness({
    schema_version: SESSION_RETITLE_READINESS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_CAPABILITY,
    status: "future-status",
    reason_code: "ready",
    next_action: "none",
    context_capabilities: {
      codex: "provider_transcript",
      claude: "provider_transcript",
      hermes: "unavailable",
    },
  }), null);

  const fallback = normalizeSessionRetitleReadiness({
    schema_version: SESSION_RETITLE_READINESS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_CAPABILITY,
    status: "degraded",
    reason_code: "fallback_ready",
    next_action: "restore_primary",
    provider_kind: "openai_compatible",
    model_label: "qwen3.6-apex-compact",
    context_capabilities: {
      codex: "provider_transcript",
      claude: "provider_transcript",
    },
  });
  assert.equal(fallback?.reason_code, "fallback_ready");
  assert.equal(fallback?.next_action, "restore_primary");
});

test("session retitle mutation accepts content-free triggers and rejects context", () => {
  const request = {
    schema_version: SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
    trigger: "prompt",
    idempotency_key: "console-prompt-1234",
    expected_session_incarnation: "launch-123",
    expected_title_revision: 7,
    expected_activity_revision: 18,
    expected_provider_turn_id: "turn-8",
  } as const;
  assert.deepEqual(normalizeSessionRetitleRequest(request), request);
  assert.equal(normalizeSessionRetitleRequest({
    ...request,
    schema_version: "agent-session.session-retitle.request.v3",
  }), null);
  assert.equal(normalizeSessionRetitleRequest({ ...request, prompt: "do not forward" }), null);
  assert.equal(normalizeSessionRetitleRequest({ ...request, transcript: [] }), null);
  assert.equal(normalizeSessionRetitleRequest({
    ...request,
    expected_provider_turn_id: "prompt content",
  }), null);
  assert.equal(normalizeSessionRetitleRequest({
    ...request,
    expected_provider_turn_id: "/home/runner/private",
  }), null);
  assert.equal(normalizeSessionRetitleRequest({
    ...request,
    trigger: "manual",
    idempotency_key: "console-manual-1234",
    expected_activity_revision: undefined,
    expected_provider_turn_id: undefined,
  })?.trigger, "manual");
});

test("session retitle result is bounded and drops provider internals", () => {
  assert.deepEqual(normalizeSessionRetitleResult({
    schema_version: SESSION_RETITLE_SCHEMA_VERSION,
    outcome: "replayed",
    changed: false,
    trigger: "prompt",
    provider_kind: "openai_compatible",
    diagnostic_code: "accepted",
    processed_turn_id_hash: `sha256:${"a".repeat(64)}`,
    coverage: { source: "provider_transcript", complete: true, truncated: false, turn_count: 8 },
    session: {
      title: "Durable retitle context - Verify fallback",
      title_state: {
        topic: "Durable retitle context",
        topic_source: "auto",
        references: [],
        activity: "Verify fallback",
      },
      title_revision: 9,
      session_incarnation: "launch-123",
    },
    title_revision: 9,
    provider: "deepseek-chat",
    prompt: "private prompt",
  }), {
    schema_version: SESSION_RETITLE_SCHEMA_VERSION,
    outcome: "replayed",
    changed: false,
    trigger: "prompt",
    provider_kind: "openai_compatible",
    diagnostic_code: "accepted",
    processed_turn_id_hash: `sha256:${"a".repeat(64)}`,
    coverage: { source: "provider_transcript", complete: true, truncated: false, turn_count: 8 },
    session: {
      title: "Durable retitle context - Verify fallback",
      title_state: {
        topic: "Durable retitle context",
        topic_source: "auto",
        references: [],
        activity: "Verify fallback",
      },
      title_revision: 9,
      session_incarnation: "launch-123",
    },
  });
  assert.equal(normalizeSessionRetitleResult({
    schema_version: SESSION_RETITLE_SCHEMA_VERSION,
    outcome: "future-outcome",
  }), null);
});

test("manual retitle accepts the daemon's null turn hash but rejects malformed hashes", () => {
  const result = {
    schema_version: SESSION_RETITLE_SCHEMA_VERSION,
    outcome: "committed",
    changed: true,
    trigger: "manual",
    provider_kind: "codex_subscription",
    diagnostic_code: "committed",
    coverage: { source: "provider_transcript", complete: true, truncated: false, turn_count: 2 },
    session: {
      title: "Retitle response",
      title_state: { topic: "Retitle response", topic_source: "auto", references: [], activity: null },
      title_revision: 1,
      session_incarnation: "launch-123",
    },
  };
  const normalized = normalizeSessionRetitleResult(result);
  assert.ok(normalized);
  assert.deepEqual(normalizeSessionRetitleResult({ ...result, processed_turn_id_hash: null }), normalized);
  const hash = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(normalizeSessionRetitleResult({ ...result, processed_turn_id_hash: hash }), {
    ...normalized, processed_turn_id_hash: hash,
  });
  for (const invalid of ["", "sha256:bad", "a".repeat(64), 0, false, {}, []]) {
    assert.equal(normalizeSessionRetitleResult({ ...result, processed_turn_id_hash: invalid }), null);
  }
});

test("session retitle errors preserve the complete producer vocabulary and bounded recovery", () => {
  assert.deepEqual(normalizeSessionRetitleError({
    code: "retitle-v3-objective-unavailable",
    details: {
      retryable: false,
      next_action: "provide_objective",
      recovery: { strategy: "provide_objective", safe_to_retry: false },
      objective: "must-not-cross",
    },
  }), {
    code: "retitle-v3-objective-unavailable",
    retryable: false,
    next_action: "provide_objective",
    recovery: { strategy: "provide_objective", safe_to_retry: false },
  });
  for (const code of PRODUCER_ERROR_CODES) {
    assert.deepEqual(normalizeSessionRetitleError({
      code,
      message: "producer wording must not cross the edge",
      details: {
        retryable: true,
        next_action: "retry",
        recovery: { strategy: "retry_provider", safe_to_retry: true, private_context: "drop" },
        transcript: "drop",
      },
    }), {
      code,
      retryable: true,
      next_action: "retry",
      recovery: { strategy: "retry_provider", safe_to_retry: true },
    });
  }
});

test("retitle v3 contracts normalize only bounded content-free state", () => {
  assert.deepEqual(normalizeSessionRetitleV3Readiness({
    schema_version: SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_V3_CAPABILITY,
    status: "unavailable",
    provider_status: "ready",
    context_status: "ready",
    title_status: "missing",
    reason_code: "no_usable_objective",
    next_action: "provide_objective",
    memory_revision: 42,
    usable_memory: false,
    pending_operation: false,
    internal_context: "must-not-cross",
  }), {
    schema_version: SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_V3_CAPABILITY,
    status: "unavailable",
    provider_status: "ready",
    context_status: "ready",
    title_status: "missing",
    reason_code: "no_usable_objective",
    next_action: "provide_objective",
    memory_revision: 42,
    usable_memory: false,
    pending_operation: false,
  });
  assert.deepEqual(normalizeSessionRetitleV3Readiness({
    schema_version: SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_V3_CAPABILITY,
    status: "stale",
    provider_status: "ready",
    context_status: "stale",
    title_status: "stale",
    reason_code: "history_advanced",
    next_action: "refresh_memory",
    memory_revision: 41,
    usable_memory: true,
    pending_operation: false,
    cursor_fence_hash: `sha256:${"a".repeat(64)}`,
    origin: "must-not-cross",
    transcript: ["must-not-cross"],
  }), {
    schema_version: SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_V3_CAPABILITY,
    status: "stale",
    provider_status: "ready",
    context_status: "stale",
    title_status: "stale",
    reason_code: "history_advanced",
    next_action: "refresh_memory",
    memory_revision: 41,
    usable_memory: true,
    pending_operation: false,
    cursor_fence_hash: `sha256:${"a".repeat(64)}`,
  });

  const request = {
    schema_version: SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION,
    trigger: "manual",
    idempotency_key: "console-manual-v3-1234",
    expected: {
      session_incarnation: "launch-123",
      title_revision: 7,
      memory_revision: 41,
    },
  } as const;
  assert.deepEqual(normalizeSessionRetitleV3Request(request), request);
  assert.equal(normalizeSessionRetitleV3Request({ ...request, prompt: "must-not-cross" }), null);

  const automaticRequest = {
    ...request,
    trigger: "automatic",
    idempotency_key: "console-auto-v3-1234",
    expected: {
      ...request.expected,
      activity_revision: 42,
      provider_turn_id: "turn-8",
    },
  } as const;
  assert.deepEqual(normalizeSessionRetitleV3Request(automaticRequest), automaticRequest);
  for (const providerTurnId of ["prompt content", "/home/runner/private", "../provider-turn"]) {
    assert.equal(normalizeSessionRetitleV3Request({
      ...automaticRequest,
      expected: { ...automaticRequest.expected, provider_turn_id: providerTurnId },
    }), null);
  }

  const terminal = normalizeSessionRetitleV3Result({
    schema_version: SESSION_RETITLE_V3_SCHEMA_VERSION,
    capability: SESSION_RETITLE_V3_CAPABILITY,
    status: "terminal",
    outcome: "degraded_cached",
    changed: false,
    failure_class: "timeout",
    failure_stage: "provider_call",
    provider_attempts: [{
      provider_kind: "codex_subscription",
      model_label: "gpt-5.6",
      outcome: "timeout",
      failure_class: "timeout",
      failure_stage: "provider_call",
      started_at: "2026-09-10T00:00:00Z",
      finished_at: "2026-09-10T00:00:01Z",
      duration_bucket: "1_4_s",
      response: "must-not-cross",
    }],
    operation_hash: `sha256:${"b".repeat(64)}`,
    memory_revision: 41,
    title_revision: 7,
    session_incarnation: "launch-123",
    readiness: "degraded",
    title: "Semantic memory - Verify rollout",
    admission_fence: { session_incarnation: "launch-123", title_revision: 7, memory_revision: 41 },
    result_fence: { session_incarnation: "launch-123", title_revision: 7, memory_revision: 41 },
    current_fence: { session_incarnation: "launch-123", title_revision: 7, memory_revision: 41 },
    result_is_current: true,
    started_at: "2026-09-10T00:00:00Z",
    finished_at: "2026-09-10T00:00:01Z",
    duration_bucket: "1_4_s",
    semantic_memory: "must-not-cross",
  });
  assert.equal(terminal?.outcome, "degraded_cached");
  assert.equal(JSON.stringify(terminal).includes("must-not-cross"), false);
  assert.deepEqual(normalizeSessionRetitleV3Result({
    ...terminal,
    provider_attempts: undefined,
  })?.provider_attempts, []);
});

test("a hostile v3 failure class fails the whole result closed", () => {
  const base = {
    schema_version: SESSION_RETITLE_V3_SCHEMA_VERSION,
    capability: SESSION_RETITLE_V3_CAPABILITY,
    status: "terminal",
    outcome: "terminal_failure",
    changed: false,
    failure_stage: "provider_call",
    provider_attempts: [],
    operation_hash: `sha256:${"c".repeat(64)}`,
    memory_revision: 41,
    title_revision: 7,
    session_incarnation: "launch-123",
    readiness: "degraded",
    admission_fence: { session_incarnation: "launch-123", title_revision: 7, memory_revision: 41 },
    result_fence: { session_incarnation: "launch-123", title_revision: 7, memory_revision: 41 },
    current_fence: { session_incarnation: "launch-123", title_revision: 7, memory_revision: 41 },
    result_is_current: true,
    started_at: "2026-09-10T00:00:00Z",
    finished_at: "2026-09-10T00:00:01Z",
    duration_bucket: "1_4_s",
  };
  // The class reaches a process log and a DOM attribute, so anything outside
  // the stable token shape must reject the result rather than be carried.
  assert.equal(normalizeSessionRetitleV3Result({ ...base, failure_class: "timeout" })?.failure_class, "timeout");
  for (const hostile of [
    "provider said: boom",
    "timeout\nevent=forged",
    "Timeout",
    "-leading-dash",
    "x".repeat(129),
  ]) {
    assert.equal(normalizeSessionRetitleV3Result({ ...base, failure_class: hostile }), null, hostile);
  }
});

test("the lifecycle outcome token is one vocabulary for both rings", () => {
  assert.equal(
    sessionRetitleLifecycleOutcome("daemon_v3", "terminal_failure", "retitle-v3-history-conflict"),
    "daemon_v3_terminal_failure:retitle-v3-history-conflict",
  );
  assert.equal(sessionRetitleLifecycleOutcome("daemon_v2", "committed"), "daemon_v2_committed");
});
