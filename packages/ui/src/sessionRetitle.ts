import type { AgentSessionCapabilities } from "@agent-console/shared/api";
import {
  SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
  SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION,
  sessionRetitleLifecycleOutcome,
  type SessionRetitlePath,
  type SessionRetitleErrorCode,
  type SessionRetitleReadinessAction,
  type SessionRetitleReadinessReason,
  type SessionRetitleReadinessStatus,
  type SessionRetitleRequest,
  type SessionRetitleV3Readiness,
  type SessionRetitleV3Request,
} from "@agent-console/shared/session-retitle";

export function sessionRetitlePath(
  edgeCapabilities: AgentSessionCapabilities | undefined,
  machineCapabilities: AgentSessionCapabilities | undefined,
): SessionRetitlePath {
  if (edgeCapabilities?.session_retitle_v3 === true && machineCapabilities?.session_retitle_v3 === true) {
    return "daemon_v3";
  }
  return edgeCapabilities?.session_retitle_v2 === true && machineCapabilities?.session_retitle_v2 === true
    ? "daemon_v2"
    : "legacy_edge";
}

export function createManualSessionRetitleRequest(
  session: { readonly session_incarnation?: string; readonly title_revision?: number },
  randomUuid: () => string = () => globalThis.crypto.randomUUID(),
): SessionRetitleRequest | null {
  if (
    !session.session_incarnation
    || session.title_revision === undefined
    || !Number.isSafeInteger(session.title_revision)
    || session.title_revision < 0
  ) return null;
  return {
    schema_version: SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
    trigger: "manual",
    idempotency_key: `console-manual-${randomUuid()}`,
    expected_session_incarnation: session.session_incarnation,
    expected_title_revision: session.title_revision,
  };
}

export function createManualSessionRetitleV3Request(
  session: { readonly session_incarnation?: string; readonly title_revision?: number },
  readiness: Pick<SessionRetitleV3Readiness, "memory_revision">,
  randomUuid: () => string = () => globalThis.crypto.randomUUID(),
): SessionRetitleV3Request | null {
  if (
    !session.session_incarnation
    || session.title_revision === undefined
    || !Number.isSafeInteger(session.title_revision)
    || session.title_revision < 0
    || !Number.isSafeInteger(readiness.memory_revision)
    || readiness.memory_revision < 0
  ) return null;
  return {
    schema_version: SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION,
    trigger: "manual",
    idempotency_key: `console-manual-v3-${randomUuid()}`,
    expected: {
      session_incarnation: session.session_incarnation,
      title_revision: session.title_revision,
      memory_revision: readiness.memory_revision,
    },
  };
}

const V3_READINESS_MESSAGES: Readonly<Record<SessionRetitleV3Readiness["reason_code"], string>> = {
  ready: "Retitle memory is current.",
  history_catching_up: "Retitle memory is catching up with the session.",
  history_stale: "Retitle memory is stale and will be refreshed.",
  history_advanced: "New session history is being folded into retitle memory.",
  memory_not_initialized: "Retitle memory is being initialized.",
  degraded_cached: "The current cached title is usable while refresh is degraded.",
  history_read_degraded: "The current cached title is usable while session history is unavailable.",
  provider_history_unavailable: "Provider history is unavailable for this session.",
  memory_unavailable: "Retitle memory is unavailable for this session.",
  no_usable_objective: "No user prompt or active Goal is available for a title. Send one and try again.",
  unknown: "Retitle memory status is unavailable. Inspect the host runtime.",
};

export function sessionRetitleV3StatusMessage(readiness: SessionRetitleV3Readiness): string {
  return V3_READINESS_MESSAGES[readiness.reason_code];
}

// The daemon's stable, content-free failure vocabulary for a terminal v3
// operation. It is not the request error vocabulary: these classes describe how
// an admitted operation ended, so a bare "Retitle failed" badge would otherwise
// discard the only diagnosis the host ever produces. A class that is also a
// request error code is deliberately absent here and resolved through
// SESSION_RETITLE_ERROR_MESSAGES below, so one condition has one sentence
// however it was reported.
const V3_FAILURE_CLASS_MESSAGES: Readonly<Record<string, string>> = {
  account_missing: "The retitle account is unavailable. Select or configure it on the host.",
  api_key_missing: "Retitle API key is missing on the host.",
  timeout: "The retitle provider timed out. Try again.",
  unavailable: "The retitle provider is unavailable. Inspect the host provider and try again.",
  rate_limited: "The retitle provider is rate limited. Wait and try again.",
  quota_exceeded: "The retitle provider quota is exhausted. Inspect the host account.",
  deadline_exhausted: "Retitle ran out of its time budget. Try again when the session is quieter.",
  malformed_response: "The retitle provider returned an invalid response. Inspect the host provider.",
  json_parse: "The retitle provider returned unparsable output. Inspect the host provider.",
  schema_validation: "The retitle provider returned a title that failed validation. Try again.",
  response_read: "The retitle provider response could not be read. Try again.",
  response_encoding: "The retitle provider response encoding was invalid. Inspect the host provider.",
  worker_failed: "The retitle worker failed. Inspect the host provider and try again.",
  missing_message: "The retitle provider returned no usable message. Try again.",
  uncertain_execution: "The retitle attempt ended with an uncertain result. Refresh the session before retrying.",
  superseded: "A newer retitle superseded this one.",
  failed: "Retitle failed on the host. Inspect the host runtime and try again.",
  history_not_found: "Provider history is unavailable for this session.",
  history_invalid_cursor: "Retitle memory lost its place in the session history. It will be rebuilt.",
  history_io: "Session history could not be read on the host. Try again.",
};

export const SESSION_RETITLE_V3_HISTORY_CONFLICT = "retitle-v3-history-conflict";

export function sessionRetitleV3FailureMessage(
  outcome: "terminal_failure" | "degraded_cached",
  failureClass?: string,
): string {
  const reason = failureClass
    ? V3_FAILURE_CLASS_MESSAGES[failureClass]
      ?? SESSION_RETITLE_ERROR_MESSAGES[failureClass as SessionRetitleErrorCode]
      ?? `Retitle failed on the host (${failureClass}). Inspect the host runtime and try again.`
    : undefined;
  if (outcome === "degraded_cached") {
    return reason
      ? `The existing cached title was preserved. ${reason}`
      : "Retitle refresh is degraded; the existing cached title was preserved.";
  }
  return reason ?? "Retitle could not create a usable title. Inspect the host runtime and try again.";
}

// A bounded lifecycle token that keeps the daemon failure class with the
// outcome, so a debug bundle explains a failure without session content. The
// edge records the same shape for its own ring, so the format is owned by the
// shared contract.
export function sessionRetitleV3LifecycleOutcome(outcome: string, failureClass?: string): string {
  return sessionRetitleLifecycleOutcome("daemon_v3", outcome, failureClass);
}

interface RetitleStatus {
  readonly status: SessionRetitleReadinessStatus;
  readonly reason_code: SessionRetitleReadinessReason;
  readonly next_action: SessionRetitleReadinessAction;
  readonly model_label?: string;
}

const READINESS_MESSAGES: Readonly<Record<SessionRetitleReadinessReason, string>> = {
  ready: "Retitle is ready.",
  provider_not_configured: "Retitle provider is not configured on the host.",
  config_invalid: "Retitle provider configuration is invalid on the host.",
  account_broker_unavailable: "Retitle account broker is unavailable. Configure or restart it on the host.",
  account_missing: "Retitle account is unavailable. Select or configure an account on the host.",
  api_key_missing: "Retitle API key is missing on the host.",
  provider_command_unavailable: "Retitle provider command is unavailable on the host.",
  fallback_ready: "Retitle is using the fallback provider while the primary provider is unavailable.",
  legacy_command_provider: "Retitle is using the legacy command provider. Migrate the host when convenient.",
  unknown: "Retitle readiness is unavailable. Inspect the host configuration.",
};

// The reason code says which provider is answering; the model label says which
// model. Readiness already carries the label, and naming it here is what makes
// "which model titled this session" answerable in the console instead of only
// in a host log.
export function sessionRetitleStatusMessage(status: RetitleStatus): string {
  const message = READINESS_MESSAGES[status.reason_code];
  return status.model_label ? `${message} Titles are coming from ${status.model_label}.` : message;
}

export const SESSION_RETITLE_ERROR_MESSAGES: Readonly<Record<SessionRetitleErrorCode | "retitle-outcome-unknown", string>> = {
  "invalid-retitle-request": "The retitle request is invalid. Refresh and try again.",
  "retitle-provider-not-configured": "Retitle provider is not configured on the host.",
  "retitle-config-invalid": "Retitle provider configuration is invalid on the host.",
  "retitle-context-unavailable": "Retitle context is not ready yet. Try again after the current turn is visible.",
  "retitle-api-key-missing": "Retitle API key is missing on the host.",
  "retitle-provider-timeout": "The retitle provider timed out. Try again.",
  "retitle-provider-unavailable": "The retitle provider is unavailable. Inspect the host provider and try again.",
  "retitle-provider-malformed-response": "The retitle provider returned an invalid response. Inspect the host provider.",
  "retitle-provider-rate-limited": "The retitle provider is rate limited. Wait and try again.",
  "retitle-provider-quota-exceeded": "The retitle provider quota is exhausted. Inspect the host account.",
  "retitle-account-missing": "The retitle account is unavailable. Select or configure it on the host.",
  "retitle-queue-saturated": "The retitle queue is busy. Wait and try again.",
  "idempotency-key-reused": "The retitle request conflicted with an earlier request. Try again.",
  "retitle-turn-conflict": "The session turn changed. Refresh and try again.",
  "retitle-state-conflict": "The session retitle state changed. Refresh and try again.",
  "retitle-worker-failed": "The retitle worker failed. Inspect the host provider and try again.",
  "title-revision-conflict": "The session title changed. Refresh and try again.",
  "session-incarnation-conflict": "The session runtime changed. Refresh and try again.",
  "retitle-v3-history-conflict": "The session history changed. Refresh and try again.",
  "retitle-v3-history-degraded": "Session history is degraded; the cached title remains available.",
  "retitle-v3-history-stale": "Session history advanced. Refresh and try again.",
  "retitle-v3-history-unavailable": "Session history is unavailable.",
  "retitle-v3-idempotency-conflict": "The retitle request conflicts with an earlier request. Start a new retitle.",
  "retitle-v3-memory-invalid": "Retitle memory is invalid. Inspect the host runtime.",
  "retitle-v3-memory-not-ready": "Retitle memory is not ready yet. Wait and try again.",
  "retitle-v3-objective-unavailable": "No user prompt or active Goal is available for a title. Send one and try again.",
  "retitle-v3-memory-too-large": "Retitle memory exceeded its safe bound. Inspect the host runtime.",
  "retitle-v3-memory-version-unsupported": "Retitle memory requires a runtime upgrade.",
  "retitle-v3-operation-capacity": "Retitle operations are busy. Wait and try again.",
  "retitle-v3-operation-not-found": "The retitle operation is no longer available. Start a new retitle.",
  "retitle-v3-operation-queued": "The retitle operation is queued.",
  "retitle-v3-state-conflict": "Retitle memory changed. Refresh and try again.",
  "retitle-v3-turn-conflict": "The session turn changed. Refresh and try again.",
  "title-revision-overflow": "The session title revision cannot advance. Inspect the host session state.",
  "retitle-outcome-unknown": "The retitle outcome is unknown. Refresh the session before retrying.",
};

export function sessionRetitleErrorMessage(
  code: SessionRetitleErrorCode | "retitle-outcome-unknown" | undefined,
  fallback?: string,
): string {
  return code && SESSION_RETITLE_ERROR_MESSAGES[code]
    ? SESSION_RETITLE_ERROR_MESSAGES[code]
    : fallback || "Retitle failed. Inspect the host readiness and try again.";
}
