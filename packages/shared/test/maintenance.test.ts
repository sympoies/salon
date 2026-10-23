import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MAINTENANCE_SCHEMA_VERSION,
  MAINTENANCE_SCHEMA_VERSION_V2,
  normalizeSessionMaintenanceActionResult,
  normalizeSessionMaintenanceActionRequest,
  normalizeSessionMaintenanceError,
  normalizeSessionMaintenancePreview,
} from "../src/maintenance.ts";

const preview = {
  schema_version: "agent-session.session-maintenance.v1",
  session_id: "fixture-codex",
  operation: "resume",
  state: "repairable",
  session_incarnation: "fixture-runtime-incarnation",
  session_generation: 1,
  issue: {
    kind: "process_boundary_live",
    operation: "resume",
    retryable: true,
    preserves_session_metadata: true,
    message: "the recorded runtime process boundary is still live",
  },
  boundary: { kind: "managed_scope", safe_process_count: 2 },
  preservation: {
    session_metadata_retained_until_success: true,
    provider_conversation_retained: true,
    destructive_scope: "verified_recorded_runtime_only",
  },
  actions: [
    {
      id: "retry_resume",
      label: "Retry resume",
      destructive: false,
      requires_confirmation: false,
      preserves_session_metadata: true,
    },
    {
      id: "terminate_runtime_then_resume",
      label: "Terminate recorded runtime, then resume",
      destructive: true,
      requires_confirmation: true,
      preserves_session_metadata: true,
    },
  ],
  preview_digest: "sha256:8d5dece08afdf22b39fcbba1d1bc33dd6d967e81a4728a715be06995d9db7f24",
} as const;

test("maintenance preview normalizes the v1 producer contract and drops private additive data", () => {
  assert.equal(MAINTENANCE_SCHEMA_VERSION, preview.schema_version);
  assert.deepEqual(normalizeSessionMaintenancePreview({
    ...preview,
    cwd: "/home/runner/repo",
    pane_pid: 123,
    transcript: "private content",
  }), preview);
});

test("maintenance action requests are strict and require destructive confirmation", () => {
  const request = {
    operation: "resume",
    action: "terminate_runtime_then_resume",
    expected_session_incarnation: "fixture-runtime-incarnation",
    expected_session_generation: 1,
    expected_preview_digest: preview.preview_digest,
    confirmed: true,
  } as const;
  assert.deepEqual(normalizeSessionMaintenanceActionRequest(request), request);
  assert.equal(normalizeSessionMaintenanceActionRequest({ ...request, confirmed: false }), null);
  assert.equal(normalizeSessionMaintenanceActionRequest({
    ...request,
    action: "retry_resume",
    confirmed: false,
  }), null);
  assert.equal(normalizeSessionMaintenanceActionRequest({
    ...request,
    action: "retry_resume",
    confirmed: true,
  }), null);
  assert.equal(normalizeSessionMaintenanceActionRequest({ ...request, cwd: "/private" }), null);
  assert.equal(normalizeSessionMaintenanceActionRequest({ ...request, operation: "delete" }), null);
});

test("maintenance preview rejects future schemas, unsafe action metadata, and malformed digests", () => {
  for (const value of [
    { ...preview, schema_version: "agent-session.session-maintenance.v3" },
    { ...preview, schema_version: "agent-session.session-maintenance.v0" },
    { ...preview, schema_version: "agent-session.session-maintenance" },
    { ...preview, preview_digest: "sha256:UPPER" },
    { ...preview, actions: [{ ...preview.actions[0], destructive: true }] },
    { ...preview, actions: [{ ...preview.actions[1], requires_confirmation: false }] },
    { ...preview, boundary: { kind: "managed_scope", safe_process_count: -1 } },
  ]) {
    assert.equal(normalizeSessionMaintenancePreview(value), null, JSON.stringify(value));
  }
});

test("maintenance action result and error retain only safe allowlisted fields", () => {
  assert.deepEqual(normalizeSessionMaintenanceActionResult({
    schema_version: MAINTENANCE_SCHEMA_VERSION,
    session_id: "fixture-codex",
    operation: "resume",
    action: "retry_resume",
    outcome: "resumed",
    session_incarnation: "new-runtime",
    session_generation: 2,
    status: "running",
    cleanup_pending: false,
    cwd: "/private",
  }), {
    schema_version: MAINTENANCE_SCHEMA_VERSION,
    session_id: "fixture-codex",
    operation: "resume",
    action: "retry_resume",
    outcome: "resumed",
    session_incarnation: "new-runtime",
    session_generation: 2,
    status: "running",
    cleanup_pending: false,
  });

  assert.deepEqual(normalizeSessionMaintenanceError({
    code: "session-maintenance-failed",
    message: "session maintenance could not safely complete; session metadata was retained",
    details: {
      id: "fixture-codex",
      operation: "delete",
      kind: "process_boundary_live",
      retryable: true,
      session_metadata_retained: true,
      cause: "TOKEN=private",
      cwd: "/private",
    },
  }, { sessionId: "fixture-codex", operation: "delete" }), {
    code: "session-maintenance-failed",
    message: "Session maintenance could not safely complete.",
    details: {
      id: "fixture-codex",
      operation: "delete",
      kind: "process_boundary_live",
      retryable: true,
      session_metadata_retained: true,
    },
  });
});

test("maintenance failure details require request correlation and retained metadata", () => {
  const failure = {
    code: "session-maintenance-failed",
    details: {
      id: "fixture-codex",
      operation: "resume",
      kind: "process_boundary_live",
      retryable: true,
      session_metadata_retained: true,
    },
  } as const;
  const expected = { sessionId: "fixture-codex", operation: "resume" } as const;
  assert.notEqual(normalizeSessionMaintenanceError(failure, expected), null);
  assert.equal(normalizeSessionMaintenanceError({
    ...failure,
    details: { ...failure.details, id: "another-session" },
  }, expected), null);
  assert.equal(normalizeSessionMaintenanceError({
    ...failure,
    details: { ...failure.details, operation: "delete" },
  }, expected), null);
  assert.equal(normalizeSessionMaintenanceError({
    ...failure,
    details: { ...failure.details, session_metadata_retained: false },
  }, expected), null);
});

test("maintenance responses reject impossible outcomes and route/request mismatches", () => {
  const resumed = {
    schema_version: MAINTENANCE_SCHEMA_VERSION,
    session_id: "fixture-codex",
    operation: "resume",
    action: "retry_resume",
    outcome: "resumed",
    session_incarnation: "new-runtime",
    session_generation: 2,
    status: "running",
    cleanup_pending: false,
  } as const;
  const expected = {
    sessionId: "fixture-codex",
    operation: "resume",
    action: "retry_resume",
  } as const;
  assert.deepEqual(normalizeSessionMaintenanceActionResult(resumed, expected), resumed);
  const resumedLegacy = {
    ...resumed,
    session_incarnation: null,
    session_generation: null,
  };
  assert.deepEqual(normalizeSessionMaintenanceActionResult(resumedLegacy, expected), resumedLegacy);
  const inspected = {
    ...resumed,
    operation: "inspect",
    action: "inspect",
    outcome: "inspected",
    status: "stopped",
  } as const;
  assert.deepEqual(normalizeSessionMaintenanceActionResult(inspected), inspected);
  assert.equal(normalizeSessionMaintenanceActionResult({
    ...inspected,
    session_incarnation: null,
  }), null);
  assert.equal(normalizeSessionMaintenanceActionResult({
    ...inspected,
    session_generation: null,
  }), null);
  assert.equal(normalizeSessionMaintenanceActionResult({
    ...inspected,
    operation: "attach",
    action: "retry_attach",
    session_incarnation: null,
  }), null);
  for (const invalid of [
    { ...resumed, session_id: "wrong-session" },
    { ...resumed, outcome: "deleted", status: "deleted", session_incarnation: null, session_generation: null },
    { ...resumed, cleanup_pending: true },
    { ...resumed, session_incarnation: null },
    { ...resumed, session_generation: null },
    { ...resumed, action: "retry_delete", operation: "delete", outcome: "deleted", status: "deleted", session_incarnation: null, session_generation: null },
  ]) {
    assert.equal(normalizeSessionMaintenanceActionResult(invalid, expected), null, JSON.stringify(invalid));
  }

  assert.equal(
    normalizeSessionMaintenancePreview(preview, { sessionId: "wrong-session", operation: "resume" }),
    null,
  );
  assert.equal(
    normalizeSessionMaintenancePreview(preview, { sessionId: "fixture-codex", operation: "delete" }),
    null,
  );
});

const recordOnlyDigest =
  "sha256:1f6d9c0b3a2e4f5d6c7b8a9908172635445362718293a4b5c6d7e8f90a1b2c3d";

/**
 * The B2 incident shape: no tmux session, a recorded boundary whose ownership
 * cannot be proven, and therefore no action that can safely signal anything.
 */
const recordOnlyPreview = {
  schema_version: MAINTENANCE_SCHEMA_VERSION_V2,
  session_id: "fixture-codex",
  operation: "delete",
  state: "blocked",
  session_incarnation: "fixture-runtime-incarnation",
  session_generation: 1,
  issue: {
    kind: "runtime_identity_unavailable",
    operation: "delete",
    retryable: false,
    preserves_session_metadata: true,
    message: "the recorded runtime identity is unavailable",
  },
  boundary: { kind: "unknown", safe_process_count: 0 },
  preservation: {
    session_metadata_retained_until_success: true,
    provider_conversation_retained: true,
    destructive_scope: "verified_recorded_runtime_only",
  },
  actions: [
    {
      id: "retry_delete",
      label: "Retry delete",
      destructive: true,
      requires_confirmation: true,
      preserves_session_metadata: false,
    },
    {
      id: "remove_console_record",
      label: "Remove from Console only",
      destructive: true,
      requires_confirmation: true,
      preserves_session_metadata: false,
      terminates_runtime: false,
      may_leave_runtime_running: true,
    },
  ],
  preview_digest: recordOnlyDigest,
} as const;

test("v1 never admits the record-only action and v2 carries its no-termination flags", () => {
  assert.deepEqual(normalizeSessionMaintenancePreview(recordOnlyPreview), recordOnlyPreview);
  // The whole reason v2 exists: a v1 payload must not be able to smuggle it in.
  assert.equal(normalizeSessionMaintenancePreview({
    ...recordOnlyPreview,
    schema_version: MAINTENANCE_SCHEMA_VERSION,
  }), null);
  // A consumer that pinned a contract must not silently accept the other one.
  assert.equal(normalizeSessionMaintenancePreview(recordOnlyPreview, {
    sessionId: "fixture-codex",
    operation: "delete",
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
  }), null);
  assert.deepEqual(normalizeSessionMaintenancePreview(recordOnlyPreview, {
    sessionId: "fixture-codex",
    operation: "delete",
    schemaVersion: MAINTENANCE_SCHEMA_VERSION_V2,
  }), recordOnlyPreview);
});

test("record-only removal is rejected whenever the producer could still signal something", () => {
  const [retryDelete, removeRecord] = recordOnlyPreview.actions;
  for (const value of [
    // A repairable boundary means a verified runtime can be stopped, so the
    // record-only fallback must not be offered next to it.
    {
      ...recordOnlyPreview,
      state: "repairable",
      boundary: { kind: "managed_scope", safe_process_count: 1 },
      actions: [
        retryDelete,
        {
          id: "terminate_runtime_then_delete",
          label: "Terminate recorded runtime, then delete",
          destructive: true,
          requires_confirmation: true,
          preserves_session_metadata: false,
        },
        removeRecord,
      ],
    },
    { ...recordOnlyPreview, state: "healthy", issue: null },
    // A changed identity keeps blocking every destructive action.
    {
      ...recordOnlyPreview,
      issue: {
        ...recordOnlyPreview.issue,
        kind: "runtime_identity_changed",
        message: "the recorded runtime identity changed",
      },
    },
    { ...recordOnlyPreview, boundary: { kind: "managed_scope", safe_process_count: 1 } },
    // Record-only removal exists for deletion alone.
    {
      ...recordOnlyPreview,
      operation: "resume",
      issue: { ...recordOnlyPreview.issue, operation: "resume" },
      actions: [{ ...retryDelete, id: "retry_resume", label: "Retry resume" }, removeRecord],
    },
    // It stops nothing; a payload claiming otherwise misrepresents it.
    { ...recordOnlyPreview, actions: [retryDelete, { ...removeRecord, terminates_runtime: true }] },
    {
      ...recordOnlyPreview,
      actions: [retryDelete, { ...removeRecord, may_leave_runtime_running: false }],
    },
    // The flags belong to this action only, so v1 action payloads stay exact.
    {
      ...recordOnlyPreview,
      actions: [{ ...retryDelete, terminates_runtime: true }, removeRecord],
    },
  ]) {
    assert.equal(normalizeSessionMaintenancePreview(value), null, JSON.stringify(value));
  }
});

test("record removal reports removal, never a termination", () => {
  const removed = {
    schema_version: MAINTENANCE_SCHEMA_VERSION_V2,
    session_id: "fixture-codex",
    operation: "delete",
    action: "remove_console_record",
    outcome: "record_removed",
    session_incarnation: null,
    session_generation: null,
    status: "record_removed",
    cleanup_pending: true,
  } as const;
  const expected = {
    sessionId: "fixture-codex",
    operation: "delete",
    action: "remove_console_record",
  } as const;
  assert.deepEqual(normalizeSessionMaintenanceActionResult(removed, expected), removed);
  // The caller knows which contract it sent, so a mismatched echo fails closed.
  assert.equal(normalizeSessionMaintenanceActionResult(removed, {
    ...expected,
    schemaVersion: MAINTENANCE_SCHEMA_VERSION,
  }), null);
  for (const invalid of [
    { ...removed, schema_version: MAINTENANCE_SCHEMA_VERSION },
    // Presenting it as a deletion would imply the runtime was stopped.
    { ...removed, outcome: "deleted", status: "deleted" },
    { ...removed, status: "stopped" },
    { ...removed, status: "deleted" },
    { ...removed, session_incarnation: "fixture-runtime-incarnation", session_generation: 1 },
    // Only the record-only action produces this outcome.
    { ...removed, action: "retry_delete" },
  ]) {
    assert.equal(normalizeSessionMaintenanceActionResult(invalid, {
      ...expected,
      action: (invalid as { action: typeof expected.action }).action,
    }), null, JSON.stringify(invalid));
  }
  assert.equal(normalizeSessionMaintenanceActionResult({
    ...removed,
    action: "remove_console_record",
    outcome: "deleted",
    status: "deleted",
  }, expected), null);
});

test("action requests negotiate the contract and keep v1 bodies unchanged", () => {
  const v1Request = {
    operation: "delete",
    action: "retry_delete",
    expected_session_incarnation: "fixture-runtime-incarnation",
    expected_session_generation: 1,
    expected_preview_digest: recordOnlyDigest,
    confirmed: true,
  } as const;
  // A v1 body must still normalize to exactly itself: no version field appears
  // on the wire for a consumer that never asked for one.
  assert.deepEqual(normalizeSessionMaintenanceActionRequest(v1Request), v1Request);
  assert.deepEqual(normalizeSessionMaintenanceActionRequest({
    ...v1Request,
    schema_version: MAINTENANCE_SCHEMA_VERSION,
  }), v1Request);

  const v2Request = {
    schema_version: MAINTENANCE_SCHEMA_VERSION_V2,
    operation: "delete",
    action: "remove_console_record",
    expected_session_incarnation: "fixture-runtime-incarnation",
    expected_session_generation: 1,
    expected_preview_digest: recordOnlyDigest,
    confirmed: true,
  } as const;
  assert.deepEqual(normalizeSessionMaintenanceActionRequest(v2Request), v2Request);
  for (const invalid of [
    { ...v2Request, schema_version: MAINTENANCE_SCHEMA_VERSION },
    { ...v2Request, schema_version: "agent-session.session-maintenance.v3" },
    { ...v2Request, confirmed: false },
    { ...v2Request, operation: "resume" },
  ]) {
    assert.equal(normalizeSessionMaintenanceActionRequest(invalid), null, JSON.stringify(invalid));
  }
  // A v2-aware client may still request a v1 action under the v2 contract.
  assert.deepEqual(normalizeSessionMaintenanceActionRequest({
    ...v1Request,
    schema_version: MAINTENANCE_SCHEMA_VERSION_V2,
  }), { schema_version: MAINTENANCE_SCHEMA_VERSION_V2, ...v1Request });
});
