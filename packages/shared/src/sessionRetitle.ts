import { normalizeSessionTitleState, type SessionTitleState } from "./title.ts";

export const SESSION_RETITLE_CAPABILITY = "agent-session.session-retitle.v2" as const;
export const SESSION_RETITLE_READINESS_SCHEMA_VERSION = "agent-session.session-retitle.readiness.v2" as const;
export const SESSION_RETITLE_REQUEST_SCHEMA_VERSION = "agent-session.session-retitle.request.v2" as const;
export const SESSION_RETITLE_SCHEMA_VERSION = "agent-session.session-retitle.v2" as const;

export const SESSION_RETITLE_V3_CAPABILITY = "agent-session.session-retitle.v3" as const;
export const SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION = "agent-session.session-retitle.readiness.v3" as const;
export const SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION = "agent-session.session-retitle.request.v3" as const;
export const SESSION_RETITLE_V3_SCHEMA_VERSION = "agent-session.session-retitle.v3" as const;
export const SESSION_RETITLE_V3_RECEIPTS_SCHEMA_VERSION = "agent-session.session-retitle.receipts.v3" as const;

export type SessionRetitlePath = "daemon_v3" | "daemon_v2" | "legacy_edge";
export type SessionRetitleTrigger = "initial" | "prompt" | "completion_recovery" | "manual";
export type SessionRetitleProviderKind = "codex_subscription" | "openai_compatible" | "command";
export type SessionRetitleReadinessStatus = "ready" | "degraded" | "unavailable";
export type SessionRetitleReadinessReason =
  | "ready"
  | "provider_not_configured"
  | "config_invalid"
  | "account_broker_unavailable"
  | "account_missing"
  | "api_key_missing"
  | "provider_command_unavailable"
  | "fallback_ready"
  | "legacy_command_provider"
  | "unknown";
export type SessionRetitleReadinessAction =
  | "none"
  | "configure_provider"
  | "configure_account_broker"
  | "select_account"
  | "set_api_key"
  | "install_provider_command"
  | "restore_primary"
  | "migrate_provider"
  | "unknown";
export type SessionRetitleContextCapability = "provider_transcript" | "unavailable";

export interface SessionRetitleReadiness {
  readonly schema_version: typeof SESSION_RETITLE_READINESS_SCHEMA_VERSION;
  readonly capability: typeof SESSION_RETITLE_CAPABILITY;
  readonly status: SessionRetitleReadinessStatus;
  readonly reason_code: SessionRetitleReadinessReason;
  readonly next_action: SessionRetitleReadinessAction;
  readonly provider_kind?: SessionRetitleProviderKind;
  readonly model_label?: string;
  readonly account?: string;
  readonly plan?: string;
  readonly context_capabilities: {
    readonly codex: SessionRetitleContextCapability;
    readonly claude: SessionRetitleContextCapability;
  };
}

export interface SessionRetitleRequest {
  readonly schema_version: typeof SESSION_RETITLE_REQUEST_SCHEMA_VERSION;
  readonly trigger: SessionRetitleTrigger;
  readonly idempotency_key: string;
  readonly expected_session_incarnation: string;
  readonly expected_title_revision: number;
  readonly expected_activity_revision?: number;
  readonly expected_provider_turn_id?: string;
}

export interface SessionRetitleCoverage {
  readonly source: "provider_transcript";
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly turn_count: number;
}

export interface SessionRetitleSession {
  readonly title: string | null;
  readonly title_state: SessionTitleState;
  readonly title_revision: number;
  readonly session_incarnation: string;
}

export interface SessionRetitleResult {
  readonly schema_version: typeof SESSION_RETITLE_SCHEMA_VERSION;
  readonly outcome: "committed" | "unchanged" | "replayed";
  readonly changed: boolean;
  readonly trigger: SessionRetitleTrigger;
  readonly provider_kind: SessionRetitleProviderKind;
  readonly processed_turn_id_hash?: string;
  readonly diagnostic_code: string;
  readonly coverage: SessionRetitleCoverage;
  readonly session: SessionRetitleSession;
}

export type SessionRetitleErrorCode =
  | "invalid-retitle-request"
  | "retitle-provider-not-configured"
  | "retitle-config-invalid"
  | "retitle-context-unavailable"
  | "retitle-api-key-missing"
  | "retitle-provider-timeout"
  | "retitle-provider-unavailable"
  | "retitle-provider-malformed-response"
  | "retitle-provider-rate-limited"
  | "retitle-provider-quota-exceeded"
  | "retitle-account-missing"
  | "retitle-queue-saturated"
  | "idempotency-key-reused"
  | "retitle-turn-conflict"
  | "retitle-state-conflict"
  | "retitle-worker-failed"
  | "title-revision-conflict"
  | "session-incarnation-conflict"
  | "retitle-v3-history-conflict"
  | "retitle-v3-history-degraded"
  | "retitle-v3-history-stale"
  | "retitle-v3-history-unavailable"
  | "retitle-v3-idempotency-conflict"
  | "retitle-v3-memory-invalid"
  | "retitle-v3-memory-not-ready"
  | "retitle-v3-objective-unavailable"
  | "retitle-v3-memory-too-large"
  | "retitle-v3-memory-version-unsupported"
  | "retitle-v3-operation-capacity"
  | "retitle-v3-operation-not-found"
  | "retitle-v3-operation-queued"
  | "retitle-v3-state-conflict"
  | "retitle-v3-turn-conflict"
  | "title-revision-overflow";
export type SessionRetitleErrorAction =
  | "retry"
  | "wait_and_retry"
  | "refresh_session"
  | "wait_for_context"
  | "configure_provider"
  | "select_account"
  | "set_api_key"
  | "inspect_provider"
  | "fix_request"
  | "poll_active_operations"
  | "start_new_operation"
  | "retry_or_inspect_readiness"
  | "provide_objective"
  | "none";

export interface SessionRetitleError {
  readonly code: SessionRetitleErrorCode;
  readonly retryable?: boolean;
  readonly next_action?: SessionRetitleErrorAction;
  readonly recovery?: {
    readonly strategy: string;
    readonly safe_to_retry: boolean;
  };
}

export type SessionRetitleV3ReadinessStatus = "ready" | "catching_up" | "stale" | "degraded" | "unavailable";
export type SessionRetitleV3ProviderStatus = "ready" | "unavailable";
export type SessionRetitleV3TitleStatus = "missing" | "current" | "stale" | "degraded_cached";
export type SessionRetitleV3Reason =
  | "ready"
  | "history_catching_up"
  | "history_stale"
  | "history_advanced"
  | "memory_not_initialized"
  | "degraded_cached"
  | "history_read_degraded"
  | "provider_history_unavailable"
  | "memory_unavailable"
  | "no_usable_objective"
  | "unknown";
export type SessionRetitleV3Action =
  | "none"
  | "refresh_memory"
  | "use_cached_memory_or_retry"
  | "restore_provider_history"
  | "provide_objective"
  | "unknown";

export interface SessionRetitleV3Readiness {
  readonly schema_version: typeof SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION;
  readonly capability: typeof SESSION_RETITLE_V3_CAPABILITY;
  readonly status: SessionRetitleV3ReadinessStatus;
  readonly provider_status: SessionRetitleV3ProviderStatus;
  readonly context_status: SessionRetitleV3ReadinessStatus;
  readonly title_status: SessionRetitleV3TitleStatus;
  readonly reason_code: SessionRetitleV3Reason;
  readonly next_action: SessionRetitleV3Action;
  readonly memory_revision: number;
  readonly usable_memory: boolean;
  readonly pending_operation: boolean;
  readonly cursor_fence_hash?: string;
}

export interface SessionRetitleV3Fence {
  readonly session_incarnation: string | null;
  readonly title_revision: number;
  readonly memory_revision: number;
}

export interface SessionRetitleV3Request {
  readonly schema_version: typeof SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION;
  readonly trigger: "manual" | "automatic";
  readonly idempotency_key: string;
  readonly expected: {
    readonly session_incarnation: string;
    readonly title_revision: number;
    readonly memory_revision: number;
    readonly activity_revision?: number;
    readonly provider_turn_id?: string;
  };
}

export interface SessionRetitleV3ProviderAttempt {
  readonly provider_kind: SessionRetitleProviderKind;
  readonly model_label?: string;
  readonly outcome: string;
  readonly failure_class?: string;
  readonly failure_stage?: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_bucket: string;
}

export interface SessionRetitleV3Result {
  readonly schema_version: typeof SESSION_RETITLE_V3_SCHEMA_VERSION;
  readonly capability: typeof SESSION_RETITLE_V3_CAPABILITY;
  readonly status: "accepted" | "terminal";
  readonly outcome?: "committed" | "unchanged" | "degraded_cached" | "terminal_failure";
  readonly changed?: boolean;
  readonly failure_class?: string;
  readonly failure_stage?: string;
  readonly provider_attempts: readonly SessionRetitleV3ProviderAttempt[];
  readonly operation_hash: string;
  readonly memory_revision: number;
  readonly title_revision: number;
  readonly session_incarnation: string | null;
  readonly readiness: SessionRetitleV3ReadinessStatus;
  readonly title?: string;
  readonly admission_fence: SessionRetitleV3Fence;
  readonly result_fence?: SessionRetitleV3Fence;
  readonly current_fence: SessionRetitleV3Fence;
  readonly result_is_current: boolean;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly duration_bucket: string;
}

const READINESS_STATUSES = new Set<SessionRetitleReadinessStatus>(["ready", "degraded", "unavailable"]);
const READINESS_REASONS = new Set<SessionRetitleReadinessReason>([
  "ready",
  "provider_not_configured",
  "config_invalid",
  "account_broker_unavailable",
  "account_missing",
  "api_key_missing",
  "provider_command_unavailable",
  "fallback_ready",
  "legacy_command_provider",
]);
const READINESS_ACTIONS = new Set<SessionRetitleReadinessAction>([
  "none",
  "configure_provider",
  "configure_account_broker",
  "select_account",
  "set_api_key",
  "install_provider_command",
  "restore_primary",
  "migrate_provider",
]);
const PROVIDER_KINDS = new Set<SessionRetitleProviderKind>([
  "codex_subscription",
  "openai_compatible",
  "command",
]);
const TRIGGERS = new Set<SessionRetitleTrigger>(["initial", "prompt", "completion_recovery", "manual"]);
const CONTEXT_CAPABILITIES = new Set<SessionRetitleContextCapability>(["provider_transcript", "unavailable"]);
const OUTCOMES = new Set<SessionRetitleResult["outcome"]>(["committed", "unchanged", "replayed"]);
const ERROR_CODES = new Set<SessionRetitleErrorCode>([
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
  "retitle-v3-history-conflict",
  "retitle-v3-history-degraded",
  "retitle-v3-history-stale",
  "retitle-v3-history-unavailable",
  "retitle-v3-idempotency-conflict",
  "retitle-v3-memory-invalid",
  "retitle-v3-memory-not-ready",
  "retitle-v3-objective-unavailable",
  "retitle-v3-memory-too-large",
  "retitle-v3-memory-version-unsupported",
  "retitle-v3-operation-capacity",
  "retitle-v3-operation-not-found",
  "retitle-v3-operation-queued",
  "retitle-v3-state-conflict",
  "retitle-v3-turn-conflict",
  "title-revision-overflow",
]);
const ERROR_ACTIONS = new Set<SessionRetitleErrorAction>([
  "retry",
  "wait_and_retry",
  "refresh_session",
  "wait_for_context",
  "configure_provider",
  "select_account",
  "set_api_key",
  "inspect_provider",
  "fix_request",
  "poll_active_operations",
  "start_new_operation",
  "retry_or_inspect_readiness",
  "provide_objective",
  "none",
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const V3_READINESS_STATUSES = new Set<SessionRetitleV3ReadinessStatus>([
  "ready", "catching_up", "stale", "degraded", "unavailable",
]);
const V3_TITLE_STATUSES = new Set<SessionRetitleV3TitleStatus>([
  "missing", "current", "stale", "degraded_cached",
]);
const V3_REASONS = new Set<Exclude<SessionRetitleV3Reason, "unknown">>([
  "ready",
  "history_catching_up",
  "history_stale",
  "history_advanced",
  "memory_not_initialized",
  "degraded_cached",
  "history_read_degraded",
  "provider_history_unavailable",
  "memory_unavailable",
  "no_usable_objective",
]);
const V3_ACTIONS = new Set<Exclude<SessionRetitleV3Action, "unknown">>([
  "none", "refresh_memory", "use_cached_memory_or_retry", "restore_provider_history", "provide_objective",
]);
const V3_OUTCOMES = new Set<NonNullable<SessionRetitleV3Result["outcome"]>>([
  "committed", "unchanged", "degraded_cached", "terminal_failure",
]);
const V3_DURATION_BUCKETS = new Set([
  "under_10_ms", "10_49_ms", "50_249_ms", "250_999_ms",
  "1_4_s", "5_29_s", "30_119_s", "120_s_plus",
]);
const STABLE_V3_METADATA = /^[a-z0-9][a-z0-9_-]*$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedMetadata(value: unknown, maxLength: number, pattern?: RegExp): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)
    || (pattern && !pattern.test(value))
  ) return undefined;
  return value;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function providerKind(value: unknown): SessionRetitleProviderKind | undefined {
  return typeof value === "string" && PROVIDER_KINDS.has(value as SessionRetitleProviderKind)
    ? value as SessionRetitleProviderKind
    : undefined;
}

function trigger(value: unknown): SessionRetitleTrigger | undefined {
  return typeof value === "string" && TRIGGERS.has(value as SessionRetitleTrigger)
    ? value as SessionRetitleTrigger
    : undefined;
}

export function normalizeSessionRetitleReadiness(value: unknown): SessionRetitleReadiness | null {
  const raw = object(value);
  if (
    !raw
    || raw.schema_version !== SESSION_RETITLE_READINESS_SCHEMA_VERSION
    || raw.capability !== SESSION_RETITLE_CAPABILITY
    || typeof raw.status !== "string"
    || !READINESS_STATUSES.has(raw.status as SessionRetitleReadinessStatus)
    || typeof raw.reason_code !== "string"
    || typeof raw.next_action !== "string"
  ) return null;
  const rawContext = object(raw.context_capabilities);
  if (!rawContext) return null;
  const contextEntries = [rawContext.codex, rawContext.claude];
  if (contextEntries.some((entry) => typeof entry !== "string" || !CONTEXT_CAPABILITIES.has(entry as SessionRetitleContextCapability))) {
    return null;
  }
  const normalizedProvider = raw.provider_kind === undefined ? undefined : providerKind(raw.provider_kind);
  if (raw.provider_kind !== undefined && normalizedProvider === undefined) return null;
  const reason = READINESS_REASONS.has(raw.reason_code as SessionRetitleReadinessReason)
    ? raw.reason_code as SessionRetitleReadinessReason
    : "unknown";
  const action = READINESS_ACTIONS.has(raw.next_action as SessionRetitleReadinessAction)
    ? raw.next_action as SessionRetitleReadinessAction
    : "unknown";
  const modelLabel = raw.model_label === undefined ? undefined : boundedMetadata(raw.model_label, 128);
  const account = raw.account === undefined ? undefined : boundedMetadata(raw.account, 64, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const plan = raw.plan === undefined ? undefined : boundedMetadata(raw.plan, 64, /^[A-Za-z0-9][A-Za-z0-9._ -]*$/);
  if (
    raw.model_label !== undefined && modelLabel === undefined
    || raw.account !== undefined && account === undefined
    || raw.plan !== undefined && plan === undefined
  ) return null;
  return {
    schema_version: SESSION_RETITLE_READINESS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_CAPABILITY,
    status: raw.status as SessionRetitleReadinessStatus,
    reason_code: reason,
    next_action: action,
    ...(normalizedProvider ? { provider_kind: normalizedProvider } : {}),
    ...(modelLabel ? { model_label: modelLabel } : {}),
    ...(account ? { account } : {}),
    ...(plan ? { plan } : {}),
    context_capabilities: {
      codex: rawContext.codex as SessionRetitleContextCapability,
      claude: rawContext.claude as SessionRetitleContextCapability,
    },
  };
}

export function normalizeSessionRetitleRequest(value: unknown): SessionRetitleRequest | null {
  const raw = object(value);
  if (!raw || raw.schema_version !== SESSION_RETITLE_REQUEST_SCHEMA_VERSION) return null;
  const allowed = new Set([
    "schema_version",
    "trigger",
    "idempotency_key",
    "expected_session_incarnation",
    "expected_title_revision",
    "expected_activity_revision",
    "expected_provider_turn_id",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  const normalizedTrigger = trigger(raw.trigger);
  const idempotencyKey = boundedMetadata(raw.idempotency_key, 128, IDEMPOTENCY_KEY);
  const incarnation = boundedMetadata(raw.expected_session_incarnation, 128, SAFE_IDENTIFIER);
  const titleRevision = nonNegativeInteger(raw.expected_title_revision);
  const activityRevision = raw.expected_activity_revision === undefined
    ? undefined
    : nonNegativeInteger(raw.expected_activity_revision);
  const providerTurnId = raw.expected_provider_turn_id === undefined
    ? undefined
    : boundedMetadata(raw.expected_provider_turn_id, 256, SAFE_IDENTIFIER);
  if (
    !normalizedTrigger
    || !idempotencyKey
    || !incarnation
    || titleRevision === undefined
    || raw.expected_activity_revision !== undefined && activityRevision === undefined
    || raw.expected_provider_turn_id !== undefined && providerTurnId === undefined
  ) return null;
  const manual = normalizedTrigger === "manual";
  if (manual === (activityRevision !== undefined || providerTurnId !== undefined)) return null;
  if (!manual && (activityRevision === undefined || providerTurnId === undefined)) return null;
  return {
    schema_version: SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
    trigger: normalizedTrigger,
    idempotency_key: idempotencyKey,
    expected_session_incarnation: incarnation,
    expected_title_revision: titleRevision,
    ...(activityRevision === undefined ? {} : { expected_activity_revision: activityRevision }),
    ...(providerTurnId === undefined ? {} : { expected_provider_turn_id: providerTurnId }),
  };
}

function normalizeCoverage(value: unknown): SessionRetitleCoverage | null {
  const raw = object(value);
  const turnCount = nonNegativeInteger(raw?.turn_count);
  if (
    !raw
    || raw.source !== "provider_transcript"
    || typeof raw.complete !== "boolean"
    || typeof raw.truncated !== "boolean"
    || turnCount === undefined
  ) return null;
  return {
    source: "provider_transcript",
    complete: raw.complete,
    truncated: raw.truncated,
    turn_count: turnCount,
  };
}

function normalizeResultSession(value: unknown): SessionRetitleSession | null {
  const raw = object(value);
  if (!raw) return null;
  const title = raw.title === null ? null : boundedMetadata(raw.title, 512);
  const titleState = normalizeSessionTitleState(raw.title_state);
  const titleRevision = nonNegativeInteger(raw.title_revision);
  const incarnation = boundedMetadata(raw.session_incarnation, 128, SAFE_IDENTIFIER);
  if (title === undefined || !titleState || titleRevision === undefined || !incarnation) return null;
  return { title, title_state: titleState, title_revision: titleRevision, session_incarnation: incarnation };
}

export function normalizeSessionRetitleResult(value: unknown): SessionRetitleResult | null {
  const raw = object(value);
  if (
    !raw
    || raw.schema_version !== SESSION_RETITLE_SCHEMA_VERSION
    || typeof raw.outcome !== "string"
    || !OUTCOMES.has(raw.outcome as SessionRetitleResult["outcome"])
    || typeof raw.changed !== "boolean"
  ) return null;
  const normalizedTrigger = trigger(raw.trigger);
  const normalizedProvider = providerKind(raw.provider_kind);
  const diagnosticCode = boundedMetadata(raw.diagnostic_code, 128, /^[a-z0-9][a-z0-9_-]*$/);
  const coverage = normalizeCoverage(raw.coverage);
  const session = normalizeResultSession(raw.session);
  // The daemon serializes an absent manual-request turn hash as null.
  const hasProcessedTurnIdHash = raw.processed_turn_id_hash != null;
  const processedTurnIdHash = !hasProcessedTurnIdHash
    ? undefined
    : boundedMetadata(raw.processed_turn_id_hash, 71, SHA256);
  if (
    !normalizedTrigger
    || !normalizedProvider
    || !diagnosticCode
    || !coverage
    || !session
    || hasProcessedTurnIdHash && !processedTurnIdHash
  ) return null;
  return {
    schema_version: SESSION_RETITLE_SCHEMA_VERSION,
    outcome: raw.outcome as SessionRetitleResult["outcome"],
    changed: raw.changed,
    trigger: normalizedTrigger,
    provider_kind: normalizedProvider,
    ...(processedTurnIdHash ? { processed_turn_id_hash: processedTurnIdHash } : {}),
    diagnostic_code: diagnosticCode,
    coverage,
    session,
  };
}

export function normalizeSessionRetitleError(value: unknown): SessionRetitleError | null {
  const raw = object(value);
  if (!raw || typeof raw.code !== "string" || !ERROR_CODES.has(raw.code as SessionRetitleErrorCode)) return null;
  const details = raw.details === undefined ? undefined : object(raw.details);
  if (raw.details !== undefined && !details) return null;
  const retryable = details?.retryable;
  const nextAction = details?.next_action;
  if (retryable !== undefined && typeof retryable !== "boolean") return null;
  if (
    nextAction !== undefined
    && (typeof nextAction !== "string" || !ERROR_ACTIONS.has(nextAction as SessionRetitleErrorAction))
  ) return null;
  const rawRecovery = details?.recovery;
  const recovery = rawRecovery === undefined ? undefined : object(rawRecovery);
  if (rawRecovery !== undefined && !recovery) return null;
  const strategy = recovery ? boundedMetadata(recovery.strategy, 64, /^[a-z0-9][a-z0-9_-]*$/) : undefined;
  if (recovery && (!strategy || typeof recovery.safe_to_retry !== "boolean")) return null;
  return {
    code: raw.code as SessionRetitleErrorCode,
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(typeof nextAction === "string" ? { next_action: nextAction as SessionRetitleErrorAction } : {}),
    ...(recovery && strategy
      ? { recovery: { strategy, safe_to_retry: recovery.safe_to_retry as boolean } }
      : {}),
  };
}

function v3ReadinessStatus(value: unknown): SessionRetitleV3ReadinessStatus | undefined {
  return typeof value === "string" && V3_READINESS_STATUSES.has(value as SessionRetitleV3ReadinessStatus)
    ? value as SessionRetitleV3ReadinessStatus
    : undefined;
}

function v3Timestamp(value: unknown): string | undefined {
  return boundedMetadata(value, 64, /^\d{4}-\d{2}-\d{2}T[^\u0000-\u001f\u007f]+$/);
}

function normalizeV3Fence(value: unknown, requireIncarnation: boolean): SessionRetitleV3Fence | null {
  const raw = object(value);
  if (!raw) return null;
  const incarnation = raw.session_incarnation === null
    ? null
    : boundedMetadata(raw.session_incarnation, 128, SAFE_IDENTIFIER);
  const titleRevision = nonNegativeInteger(raw.title_revision);
  const memoryRevision = nonNegativeInteger(raw.memory_revision);
  if (
    incarnation === undefined
    || requireIncarnation && incarnation === null
    || titleRevision === undefined
    || memoryRevision === undefined
  ) return null;
  return { session_incarnation: incarnation, title_revision: titleRevision, memory_revision: memoryRevision };
}

export function normalizeSessionRetitleV3Readiness(value: unknown): SessionRetitleV3Readiness | null {
  const raw = object(value);
  if (
    !raw
    || raw.schema_version !== SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION
    || raw.capability !== SESSION_RETITLE_V3_CAPABILITY
  ) return null;
  const status = v3ReadinessStatus(raw.status);
  const contextStatus = v3ReadinessStatus(raw.context_status);
  const titleStatus = typeof raw.title_status === "string"
    && V3_TITLE_STATUSES.has(raw.title_status as SessionRetitleV3TitleStatus)
    ? raw.title_status as SessionRetitleV3TitleStatus
    : undefined;
  const memoryRevision = nonNegativeInteger(raw.memory_revision);
  const cursorFenceHash = raw.cursor_fence_hash === undefined
    ? undefined
    : boundedMetadata(raw.cursor_fence_hash, 71, SHA256);
  if (
    !status
    || (raw.provider_status !== "ready" && raw.provider_status !== "unavailable")
    || !contextStatus
    || !titleStatus
    || typeof raw.reason_code !== "string"
    || typeof raw.next_action !== "string"
    || memoryRevision === undefined
    || typeof raw.usable_memory !== "boolean"
    || typeof raw.pending_operation !== "boolean"
    || raw.cursor_fence_hash !== undefined && !cursorFenceHash
  ) return null;
  const reason = V3_REASONS.has(raw.reason_code as Exclude<SessionRetitleV3Reason, "unknown">)
    ? raw.reason_code as Exclude<SessionRetitleV3Reason, "unknown">
    : "unknown";
  const action = V3_ACTIONS.has(raw.next_action as Exclude<SessionRetitleV3Action, "unknown">)
    ? raw.next_action as Exclude<SessionRetitleV3Action, "unknown">
    : "unknown";
  return {
    schema_version: SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_V3_CAPABILITY,
    status,
    provider_status: raw.provider_status,
    context_status: contextStatus,
    title_status: titleStatus,
    reason_code: reason,
    next_action: action,
    memory_revision: memoryRevision,
    usable_memory: raw.usable_memory,
    pending_operation: raw.pending_operation,
    ...(cursorFenceHash ? { cursor_fence_hash: cursorFenceHash } : {}),
  };
}

export function normalizeSessionRetitleV3Request(value: unknown): SessionRetitleV3Request | null {
  const raw = object(value);
  if (!raw || raw.schema_version !== SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION) return null;
  if (Object.keys(raw).some((key) => !["schema_version", "trigger", "idempotency_key", "expected"].includes(key))) {
    return null;
  }
  if (raw.trigger !== "manual" && raw.trigger !== "automatic") return null;
  const key = boundedMetadata(raw.idempotency_key, 128, IDEMPOTENCY_KEY);
  const expectedRaw = object(raw.expected);
  if (!key || !expectedRaw) return null;
  const allowedExpected = new Set([
    "session_incarnation", "title_revision", "memory_revision", "activity_revision", "provider_turn_id",
  ]);
  if (Object.keys(expectedRaw).some((field) => !allowedExpected.has(field))) return null;
  const fence = normalizeV3Fence(expectedRaw, true);
  const activityRevision = expectedRaw.activity_revision === undefined
    ? undefined
    : nonNegativeInteger(expectedRaw.activity_revision);
  const providerTurnId = expectedRaw.provider_turn_id === undefined
    ? undefined
    : boundedMetadata(expectedRaw.provider_turn_id, 256, SAFE_IDENTIFIER);
  if (
    !fence
    || expectedRaw.activity_revision !== undefined && activityRevision === undefined
    || expectedRaw.provider_turn_id !== undefined && !providerTurnId
  ) return null;
  const hasTurnFence = activityRevision !== undefined || providerTurnId !== undefined;
  if (raw.trigger === "manual" ? hasTurnFence : activityRevision === undefined || !providerTurnId) return null;
  return {
    schema_version: SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION,
    trigger: raw.trigger,
    idempotency_key: key,
    expected: {
      session_incarnation: fence.session_incarnation as string,
      title_revision: fence.title_revision,
      memory_revision: fence.memory_revision,
      ...(activityRevision === undefined ? {} : { activity_revision: activityRevision }),
      ...(providerTurnId ? { provider_turn_id: providerTurnId } : {}),
    },
  };
}

function normalizeV3ProviderAttempt(value: unknown): SessionRetitleV3ProviderAttempt | null {
  const raw = object(value);
  if (!raw) return null;
  const normalizedProvider = providerKind(raw.provider_kind);
  const modelLabel = raw.model_label === undefined ? undefined : boundedMetadata(raw.model_label, 128);
  const outcome = boundedMetadata(raw.outcome, 64, STABLE_V3_METADATA);
  const failureClass = raw.failure_class === undefined ? undefined : boundedMetadata(raw.failure_class, 128, STABLE_V3_METADATA);
  const failureStage = raw.failure_stage === undefined ? undefined : boundedMetadata(raw.failure_stage, 64, STABLE_V3_METADATA);
  const startedAt = v3Timestamp(raw.started_at);
  const finishedAt = v3Timestamp(raw.finished_at);
  const durationBucket = typeof raw.duration_bucket === "string" && V3_DURATION_BUCKETS.has(raw.duration_bucket)
    ? raw.duration_bucket
    : undefined;
  if (
    !normalizedProvider || !outcome || !startedAt || !finishedAt || !durationBucket
    || raw.model_label !== undefined && !modelLabel
    || raw.failure_class !== undefined && !failureClass
    || raw.failure_stage !== undefined && !failureStage
  ) return null;
  return {
    provider_kind: normalizedProvider,
    ...(modelLabel ? { model_label: modelLabel } : {}),
    outcome,
    ...(failureClass ? { failure_class: failureClass } : {}),
    ...(failureStage ? { failure_stage: failureStage } : {}),
    started_at: startedAt,
    finished_at: finishedAt,
    duration_bucket: durationBucket,
  };
}

export function normalizeSessionRetitleV3Result(value: unknown): SessionRetitleV3Result | null {
  const raw = object(value);
  if (
    !raw
    || raw.schema_version !== SESSION_RETITLE_V3_SCHEMA_VERSION
    || raw.capability !== SESSION_RETITLE_V3_CAPABILITY
    || (raw.status !== "accepted" && raw.status !== "terminal")
  ) return null;
  const outcome = raw.outcome === undefined ? undefined : (
    typeof raw.outcome === "string" && V3_OUTCOMES.has(raw.outcome as NonNullable<SessionRetitleV3Result["outcome"]>)
      ? raw.outcome as NonNullable<SessionRetitleV3Result["outcome"]>
      : undefined
  );
  const operationHash = boundedMetadata(raw.operation_hash, 71, SHA256);
  const memoryRevision = nonNegativeInteger(raw.memory_revision);
  const titleRevision = nonNegativeInteger(raw.title_revision);
  const incarnation = raw.session_incarnation === null
    ? null
    : boundedMetadata(raw.session_incarnation, 128, SAFE_IDENTIFIER);
  const readiness = v3ReadinessStatus(raw.readiness);
  const title = raw.title === undefined ? undefined : boundedMetadata(raw.title, 512);
  const admissionFence = normalizeV3Fence(raw.admission_fence, false);
  const resultFence = raw.result_fence === undefined ? undefined : normalizeV3Fence(raw.result_fence, false);
  const currentFence = normalizeV3Fence(raw.current_fence, false);
  const startedAt = v3Timestamp(raw.started_at);
  const finishedAt = raw.finished_at === undefined ? undefined : v3Timestamp(raw.finished_at);
  const durationBucket = typeof raw.duration_bucket === "string" && V3_DURATION_BUCKETS.has(raw.duration_bucket)
    ? raw.duration_bucket
    : undefined;
  const failureClass = raw.failure_class === undefined ? undefined : boundedMetadata(raw.failure_class, 128, STABLE_V3_METADATA);
  const failureStage = raw.failure_stage === undefined ? undefined : boundedMetadata(raw.failure_stage, 64, STABLE_V3_METADATA);
  const providerAttempts = raw.provider_attempts === undefined
    ? []
    : Array.isArray(raw.provider_attempts)
      ? raw.provider_attempts.slice(0, 3).map(normalizeV3ProviderAttempt)
      : [null];
  if (
    !operationHash || memoryRevision === undefined || titleRevision === undefined || incarnation === undefined
    || !readiness || !admissionFence || !currentFence || !startedAt || !durationBucket
    || typeof raw.result_is_current !== "boolean"
    || raw.changed !== undefined && typeof raw.changed !== "boolean"
    || raw.outcome !== undefined && !outcome
    || raw.title !== undefined && !title
    || raw.result_fence !== undefined && !resultFence
    || raw.finished_at !== undefined && !finishedAt
    || raw.failure_class !== undefined && !failureClass
    || raw.failure_stage !== undefined && !failureStage
    || Array.isArray(raw.provider_attempts) && raw.provider_attempts.length > 2
    || providerAttempts.some((attempt) => !attempt)
    || raw.status === "accepted" && (outcome !== undefined || raw.finished_at !== undefined)
    || raw.status === "terminal" && (!outcome || raw.changed === undefined || !finishedAt)
  ) return null;
  return {
    schema_version: SESSION_RETITLE_V3_SCHEMA_VERSION,
    capability: SESSION_RETITLE_V3_CAPABILITY,
    status: raw.status,
    ...(outcome ? { outcome } : {}),
    ...(typeof raw.changed === "boolean" ? { changed: raw.changed } : {}),
    ...(failureClass ? { failure_class: failureClass } : {}),
    ...(failureStage ? { failure_stage: failureStage } : {}),
    provider_attempts: providerAttempts as SessionRetitleV3ProviderAttempt[],
    operation_hash: operationHash,
    memory_revision: memoryRevision,
    title_revision: titleRevision,
    session_incarnation: incarnation,
    readiness,
    ...(title ? { title } : {}),
    admission_fence: admissionFence,
    ...(resultFence ? { result_fence: resultFence } : {}),
    current_fence: currentFence,
    result_is_current: raw.result_is_current,
    started_at: startedAt,
    ...(finishedAt ? { finished_at: finishedAt } : {}),
    duration_bucket: durationBucket,
  };
}

// The daemon's own record of what retitle did on a session. It is a strict
// subset of the operation result and carries no title, so it is safe on the
// multi-principal debug surface that renders it.
export interface SessionRetitleV3Receipt {
  readonly operation_hash: string;
  readonly trigger: string;
  readonly state: string;
  readonly terminal: boolean;
  readonly outcome?: string;
  readonly changed?: boolean;
  readonly failure_class?: string;
  readonly failure_stage?: string;
  readonly provider_attempts: readonly SessionRetitleV3ProviderAttempt[];
  readonly admission_fence: SessionRetitleV3Fence;
  readonly result_fence?: SessionRetitleV3Fence;
  readonly result_is_current: boolean;
  readonly attempt_generation: number;
  readonly execution_claim_held: boolean;
  readonly started_at: string;
  readonly updated_at: string;
  readonly duration_bucket: string;
}

export interface SessionRetitleV3Receipts {
  readonly schema_version: typeof SESSION_RETITLE_V3_RECEIPTS_SCHEMA_VERSION;
  readonly capability: typeof SESSION_RETITLE_V3_CAPABILITY;
  readonly readiness: SessionRetitleV3ReadinessStatus;
  readonly current_fence: SessionRetitleV3Fence;
  readonly max_receipts: number;
  readonly selected_operation_hash?: string;
  readonly receipts: readonly SessionRetitleV3Receipt[];
}

const MAX_PROJECTED_RECEIPTS = 16;

function normalizeV3Receipt(value: unknown): SessionRetitleV3Receipt | null {
  const raw = object(value);
  if (!raw) return null;
  const operationHash = boundedMetadata(raw.operation_hash, 71, SHA256);
  const trigger = boundedMetadata(raw.trigger, 32, STABLE_V3_METADATA);
  const state = boundedMetadata(raw.state, 32, STABLE_V3_METADATA);
  const outcome = raw.outcome === undefined ? undefined : boundedMetadata(raw.outcome, 64, STABLE_V3_METADATA);
  const failureClass = raw.failure_class === undefined
    ? undefined
    : boundedMetadata(raw.failure_class, 128, STABLE_V3_METADATA);
  const failureStage = raw.failure_stage === undefined
    ? undefined
    : boundedMetadata(raw.failure_stage, 64, STABLE_V3_METADATA);
  const providerAttempts = raw.provider_attempts === undefined
    ? []
    : Array.isArray(raw.provider_attempts)
      ? raw.provider_attempts.slice(0, 3).map(normalizeV3ProviderAttempt)
      : [null];
  const admissionFence = normalizeV3Fence(raw.admission_fence, false);
  const resultFence = raw.result_fence === undefined ? undefined : normalizeV3Fence(raw.result_fence, false);
  const attemptGeneration = nonNegativeInteger(raw.attempt_generation);
  const startedAt = v3Timestamp(raw.started_at);
  const updatedAt = v3Timestamp(raw.updated_at);
  const durationBucket = typeof raw.duration_bucket === "string" && V3_DURATION_BUCKETS.has(raw.duration_bucket)
    ? raw.duration_bucket
    : undefined;
  if (
    !operationHash || !trigger || !state || !admissionFence || !startedAt || !updatedAt || !durationBucket
    || attemptGeneration === undefined
    || typeof raw.terminal !== "boolean"
    || typeof raw.result_is_current !== "boolean"
    || typeof raw.execution_claim_held !== "boolean"
    || raw.changed !== undefined && typeof raw.changed !== "boolean"
    || raw.outcome !== undefined && !outcome
    || raw.failure_class !== undefined && !failureClass
    || raw.failure_stage !== undefined && !failureStage
    || raw.result_fence !== undefined && !resultFence
    || providerAttempts.some((attempt) => !attempt)
  ) return null;
  return {
    operation_hash: operationHash,
    trigger,
    state,
    terminal: raw.terminal,
    ...(outcome ? { outcome } : {}),
    ...(typeof raw.changed === "boolean" ? { changed: raw.changed } : {}),
    ...(failureClass ? { failure_class: failureClass } : {}),
    ...(failureStage ? { failure_stage: failureStage } : {}),
    provider_attempts: providerAttempts as SessionRetitleV3ProviderAttempt[],
    admission_fence: admissionFence,
    ...(resultFence ? { result_fence: resultFence } : {}),
    result_is_current: raw.result_is_current,
    attempt_generation: attemptGeneration,
    execution_claim_held: raw.execution_claim_held,
    started_at: startedAt,
    updated_at: updatedAt,
    duration_bucket: durationBucket,
  };
}

export function normalizeSessionRetitleV3Receipts(value: unknown): SessionRetitleV3Receipts | null {
  const raw = object(value);
  if (
    !raw
    || raw.schema_version !== SESSION_RETITLE_V3_RECEIPTS_SCHEMA_VERSION
    || raw.capability !== SESSION_RETITLE_V3_CAPABILITY
    || !Array.isArray(raw.receipts)
    || raw.receipts.length > MAX_PROJECTED_RECEIPTS
  ) return null;
  const readiness = v3ReadinessStatus(raw.readiness);
  const currentFence = normalizeV3Fence(raw.current_fence, false);
  const maxReceipts = nonNegativeInteger(raw.max_receipts);
  const selected = raw.selected_operation_hash === undefined
    ? undefined
    : boundedMetadata(raw.selected_operation_hash, 71, SHA256);
  const receipts = raw.receipts.map(normalizeV3Receipt);
  if (
    !readiness || !currentFence || maxReceipts === undefined
    || raw.selected_operation_hash !== undefined && !selected
    || receipts.some((receipt) => !receipt)
  ) return null;
  return {
    schema_version: SESSION_RETITLE_V3_RECEIPTS_SCHEMA_VERSION,
    capability: SESSION_RETITLE_V3_CAPABILITY,
    readiness,
    current_fence: currentFence,
    max_receipts: maxReceipts,
    ...(selected ? { selected_operation_hash: selected } : {}),
    receipts: receipts as SessionRetitleV3Receipt[],
  };
}

// One lifecycle vocabulary for both debug rings. The browser records the
// attempt it made and the edge records what the daemon returned, and a debug
// bundle greps the two together, so the token is built here rather than
// formatted independently on each side.
export function sessionRetitleLifecycleOutcome(
  path: Exclude<SessionRetitlePath, "legacy_edge">,
  outcome: string,
  failureClass?: string,
): string {
  return failureClass ? `${path}_${outcome}:${failureClass}` : `${path}_${outcome}`;
}
