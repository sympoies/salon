export const MAINTENANCE_SCHEMA_VERSION = "agent-session.session-maintenance.v1" as const;
/**
 * Successor contract. It exists because v1 cannot safely gain an action ID: a v1
 * consumer rejects an unknown action instead of ignoring it, so a new action in
 * a v1 payload would break existing clients rather than degrade for them.
 */
export const MAINTENANCE_SCHEMA_VERSION_V2 = "agent-session.session-maintenance.v2" as const;

export type MaintenanceContractVersion =
  | typeof MAINTENANCE_SCHEMA_VERSION
  | typeof MAINTENANCE_SCHEMA_VERSION_V2;

export type MaintenanceOperation = "resume" | "delete" | "attach" | "inspect";
export type MaintenanceState = "healthy" | "repairable" | "blocked";
export type MaintenanceIssueKind =
  | "process_boundary_live"
  | "runtime_identity_changed"
  | "runtime_identity_unavailable"
  | "session_still_running"
  | "startup_failed"
  | "unknown";
export type MaintenanceBoundaryKind = "none" | "tmux_session" | "managed_scope" | "process_group" | "unknown";
export type MaintenanceActionId =
  | "retry_resume"
  | "retry_delete"
  | "retry_attach"
  | "inspect"
  | "terminate_runtime_then_resume"
  | "terminate_runtime_then_delete"
  | "remove_console_record";

export interface MaintenanceIssue {
  readonly kind: MaintenanceIssueKind;
  readonly operation: MaintenanceOperation;
  readonly retryable: boolean;
  readonly preserves_session_metadata: true;
  readonly message: string;
}

export interface MaintenanceAction {
  readonly id: MaintenanceActionId;
  readonly label: string;
  readonly destructive: boolean;
  readonly requires_confirmation: boolean;
  readonly preserves_session_metadata: boolean;
  /**
   * Present only on an action that deliberately signals nothing. Absence means
   * the v1 default, which is what keeps every v1 action payload byte-identical.
   */
  readonly terminates_runtime?: false;
  /** Present only when the action may leave an unverified process alive. */
  readonly may_leave_runtime_running?: true;
}

export interface SessionMaintenancePreview {
  readonly schema_version: MaintenanceContractVersion;
  readonly session_id: string;
  readonly operation: MaintenanceOperation;
  readonly state: MaintenanceState;
  readonly session_incarnation: string | null;
  readonly session_generation: number | null;
  readonly issue: MaintenanceIssue | null;
  readonly boundary: {
    readonly kind: MaintenanceBoundaryKind;
    readonly safe_process_count: number;
  };
  readonly preservation: {
    readonly session_metadata_retained_until_success: true;
    readonly provider_conversation_retained: true;
    readonly destructive_scope: "verified_recorded_runtime_only";
  };
  readonly actions: readonly MaintenanceAction[];
  readonly preview_digest: string;
}

export interface SessionMaintenanceActionRequest {
  /** Omitted for v1 so an existing daemon keeps receiving the exact v1 body. */
  readonly schema_version?: typeof MAINTENANCE_SCHEMA_VERSION_V2;
  readonly operation: MaintenanceOperation;
  readonly action: MaintenanceActionId;
  readonly expected_session_incarnation: string | null;
  readonly expected_session_generation: number | null;
  readonly expected_preview_digest: string;
  readonly confirmed?: boolean;
}

export interface SessionMaintenanceActionResult {
  readonly schema_version: MaintenanceContractVersion;
  readonly session_id: string;
  readonly operation: MaintenanceOperation;
  readonly action: MaintenanceActionId;
  /** `record_removed` never means the runtime was stopped. */
  readonly outcome: "resumed" | "deleted" | "inspected" | "record_removed";
  readonly session_incarnation: string | null;
  readonly session_generation: number | null;
  readonly status: "running" | "stopped" | "unknown" | "deleted" | "record_removed";
  readonly cleanup_pending: boolean;
}

export interface SessionMaintenancePreviewExpectation {
  readonly sessionId: string;
  readonly operation: MaintenanceOperation;
  /**
   * Pins the contract the caller negotiated. A caller that knows what it asked
   * for must not accept the other version; omit it to accept either.
   */
  readonly schemaVersion?: MaintenanceContractVersion;
}

export interface SessionMaintenanceActionResultExpectation extends SessionMaintenancePreviewExpectation {
  readonly action: MaintenanceActionId;
}

export interface SessionMaintenanceError {
  readonly code: string;
  readonly message: string;
  readonly details?: {
    readonly id: string;
    readonly operation: MaintenanceOperation;
    readonly kind: MaintenanceIssueKind;
    readonly retryable: boolean;
    readonly session_metadata_retained: boolean;
  };
}

interface ActionDefinition {
  readonly operation: MaintenanceOperation;
  readonly label: string;
  readonly destructive: boolean;
  readonly requiresConfirmation: boolean;
  readonly preservesSessionMetadata: boolean;
  /** Set when the action is absent from v1 and must be rejected under it. */
  readonly requiresSuccessorContract?: true;
  /** Set when the action signals nothing and may leave a process running. */
  readonly recordOnly?: true;
}

const ACTIONS: Readonly<Record<MaintenanceActionId, ActionDefinition>> = {
  retry_resume: {
    operation: "resume",
    label: "Retry resume",
    destructive: false,
    requiresConfirmation: false,
    preservesSessionMetadata: true,
  },
  retry_delete: {
    operation: "delete",
    label: "Retry delete",
    destructive: true,
    requiresConfirmation: true,
    preservesSessionMetadata: false,
  },
  retry_attach: {
    operation: "attach",
    label: "Retry attach",
    destructive: false,
    requiresConfirmation: false,
    preservesSessionMetadata: true,
  },
  inspect: {
    operation: "inspect",
    label: "Inspect",
    destructive: false,
    requiresConfirmation: false,
    preservesSessionMetadata: true,
  },
  terminate_runtime_then_resume: {
    operation: "resume",
    label: "Terminate recorded runtime, then resume",
    destructive: true,
    requiresConfirmation: true,
    preservesSessionMetadata: true,
  },
  terminate_runtime_then_delete: {
    operation: "delete",
    label: "Terminate recorded runtime, then delete",
    destructive: true,
    requiresConfirmation: true,
    preservesSessionMetadata: false,
  },
  // Last-resort removal for the retry-only dead end: no tmux target and no
  // provable process ownership. Never labelled "force kill" or "force delete",
  // because it stops nothing.
  remove_console_record: {
    operation: "delete",
    label: "Remove from Console only",
    destructive: true,
    requiresConfirmation: true,
    preservesSessionMetadata: false,
    requiresSuccessorContract: true,
    recordOnly: true,
  },
};

/** Evidence classes that genuinely leave nothing safe to signal. */
const RECORD_ONLY_ISSUE_KINDS: readonly MaintenanceIssueKind[] = [
  "runtime_identity_unavailable",
  "process_boundary_live",
];

function contractVersion(value: unknown): MaintenanceContractVersion | null {
  return enumValue(value, [MAINTENANCE_SCHEMA_VERSION, MAINTENANCE_SCHEMA_VERSION_V2] as const);
}

function admitsAction(contract: MaintenanceContractVersion, id: MaintenanceActionId): boolean {
  return !ACTIONS[id].requiresSuccessorContract || contract === MAINTENANCE_SCHEMA_VERSION_V2;
}

/**
 * True when the action cannot be expressed under v1, so a caller that has to
 * fall back to v1 must report the action as unavailable instead of retrying it.
 */
export function maintenanceActionRequiresSuccessorContract(id: MaintenanceActionId): boolean {
  return ACTIONS[id].requiresSuccessorContract === true;
}

/** Parses a negotiated contract from an untrusted string; absent means v1. */
export function maintenanceContractVersion(value: unknown): MaintenanceContractVersion | null {
  return value === null || value === undefined
    ? MAINTENANCE_SCHEMA_VERSION
    : contractVersion(value);
}

const ISSUE_MESSAGES: Readonly<Record<MaintenanceIssueKind, string>> = {
  process_boundary_live: "the recorded runtime process boundary is still live",
  runtime_identity_changed: "the recorded runtime identity changed",
  runtime_identity_unavailable: "the recorded runtime identity is unavailable",
  session_still_running: "the terminal session is still running",
  startup_failed: "the last runtime startup failed",
  unknown: "the session state could not be verified",
};

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "maintenance-preview-stale": "Session state changed. Inspect it again before retrying.",
  "maintenance-session-busy": "Session maintenance is busy. Retry after the current operation finishes.",
  "maintenance-confirmation-required": "This maintenance action requires explicit confirmation.",
  "session-maintenance-failed": "Session maintenance could not safely complete.",
  "session-not-found": "Session was not found.",
  "maintenance-unsupported": "Session maintenance is unavailable on this machine.",
  "maintenance-outcome-unknown": "The maintenance outcome is unknown. Inspect the session before retrying.",
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === "string" && values.includes(value as T) ? value as T : null;
}

function boundedString(value: unknown, max = 256): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value)
    ? value
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return boundedString(value, 256) ?? undefined;
}

function nullableGeneration(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function actionId(value: unknown): MaintenanceActionId | null {
  return enumValue(value, Object.keys(ACTIONS) as MaintenanceActionId[]);
}

export function normalizeSessionMaintenanceActionRequest(
  value: unknown,
): SessionMaintenanceActionRequest | null {
  const raw = object(value);
  if (!raw) return null;
  const allowed = new Set([
    "schema_version",
    "operation",
    "action",
    "expected_session_incarnation",
    "expected_session_generation",
    "expected_preview_digest",
    "confirmed",
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  // An absent version means v1, so an existing client keeps working unchanged.
  const contract = raw.schema_version === undefined
    ? MAINTENANCE_SCHEMA_VERSION
    : contractVersion(raw.schema_version);
  const requestedOperation = operation(raw.operation);
  const action = actionId(raw.action);
  const incarnation = nullableString(raw.expected_session_incarnation);
  const generation = nullableGeneration(raw.expected_session_generation);
  if (
    !contract || !requestedOperation || !action || ACTIONS[action].operation !== requestedOperation
    || !admitsAction(contract, action)
    || incarnation === undefined || generation === undefined
    || typeof raw.expected_preview_digest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(raw.expected_preview_digest)
    || (raw.confirmed !== undefined && typeof raw.confirmed !== "boolean")
    || (ACTIONS[action].destructive && raw.confirmed !== true)
    || (!ACTIONS[action].destructive && raw.confirmed !== undefined)
  ) return null;
  return {
    // Emitted only for the successor contract: a v1 request stays byte-identical
    // to what a v1 daemon already accepts.
    ...(contract === MAINTENANCE_SCHEMA_VERSION_V2 ? { schema_version: contract } : {}),
    operation: requestedOperation,
    action,
    expected_session_incarnation: incarnation,
    expected_session_generation: generation,
    expected_preview_digest: raw.expected_preview_digest,
    ...(raw.confirmed === undefined ? {} : { confirmed: raw.confirmed }),
  };
}

function operation(value: unknown): MaintenanceOperation | null {
  return enumValue(value, ["resume", "delete", "attach", "inspect"]);
}

function issueKind(value: unknown): MaintenanceIssueKind | null {
  return enumValue(value, [
    "process_boundary_live",
    "runtime_identity_changed",
    "runtime_identity_unavailable",
    "session_still_running",
    "startup_failed",
    "unknown",
  ]);
}

function normalizeAction(
  value: unknown,
  expectedOperation: MaintenanceOperation,
  contract: MaintenanceContractVersion,
): MaintenanceAction | null {
  const raw = object(value);
  const id = actionId(raw?.id);
  if (!raw || !id) return null;
  const definition = ACTIONS[id];
  const recordOnly = definition.recordOnly === true;
  if (
    definition.operation !== expectedOperation
    || !admitsAction(contract, id)
    || raw.destructive !== definition.destructive
    || raw.requires_confirmation !== definition.requiresConfirmation
    || raw.preserves_session_metadata !== definition.preservesSessionMetadata
    // The no-termination flags belong to the record-only action alone. Requiring
    // their exact values there, and their absence everywhere else, stops a
    // payload from either hiding the caveat or claiming a guarantee it lacks.
    || raw.terminates_runtime !== (recordOnly ? false : undefined)
    || raw.may_leave_runtime_running !== (recordOnly ? true : undefined)
  ) return null;
  return {
    id,
    label: definition.label,
    destructive: definition.destructive,
    requires_confirmation: definition.requiresConfirmation,
    preserves_session_metadata: definition.preservesSessionMetadata,
    ...(recordOnly ? { terminates_runtime: false, may_leave_runtime_running: true } as const : {}),
  };
}

export function normalizeSessionMaintenancePreview(
  value: unknown,
  expected?: SessionMaintenancePreviewExpectation,
): SessionMaintenancePreview | null {
  const raw = object(value);
  const contract = contractVersion(raw?.schema_version);
  if (
    !raw || !contract
    || (expected?.schemaVersion !== undefined && contract !== expected.schemaVersion)
  ) return null;
  const sessionId = boundedString(raw.session_id);
  const requestedOperation = operation(raw.operation);
  const state = enumValue(raw.state, ["healthy", "repairable", "blocked"] as const);
  const incarnation = nullableString(raw.session_incarnation);
  const generation = nullableGeneration(raw.session_generation);
  const boundary = object(raw.boundary);
  const boundaryKind = enumValue(boundary?.kind, ["none", "tmux_session", "managed_scope", "process_group", "unknown"] as const);
  const safeProcessCount = boundary?.safe_process_count;
  const preservation = object(raw.preservation);
  if (
    !sessionId || !requestedOperation || !state || incarnation === undefined || generation === undefined
    || (expected !== undefined && (sessionId !== expected.sessionId || requestedOperation !== expected.operation))
    || !boundaryKind || typeof safeProcessCount !== "number" || !Number.isSafeInteger(safeProcessCount)
    || safeProcessCount < 0 || safeProcessCount > 1_000_000
    || preservation?.session_metadata_retained_until_success !== true
    || preservation.provider_conversation_retained !== true
    || preservation.destructive_scope !== "verified_recorded_runtime_only"
    || typeof raw.preview_digest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(raw.preview_digest)
    || !Array.isArray(raw.actions) || raw.actions.length === 0 || raw.actions.length > 2
  ) return null;

  const actions = raw.actions.map((item) => normalizeAction(item, requestedOperation, contract));
  if (actions.some((item) => item === null)) return null;
  const safeActions = actions as MaintenanceAction[];
  if (new Set(safeActions.map((item) => item.id)).size !== safeActions.length) return null;
  const repairAction = safeActions.find((item) => item.id.startsWith("terminate_runtime_then_"));
  if ((state === "repairable") !== Boolean(repairAction) || (repairAction && boundaryKind !== "managed_scope")) {
    return null;
  }

  let issue: MaintenanceIssue | null = null;
  if (raw.issue !== null) {
    const issueRaw = object(raw.issue);
    const kind = issueKind(issueRaw?.kind);
    if (
      !issueRaw || !kind || issueRaw.operation !== requestedOperation
      || typeof issueRaw.retryable !== "boolean" || issueRaw.preserves_session_metadata !== true
    ) return null;
    issue = {
      kind,
      operation: requestedOperation,
      retryable: issueRaw.retryable,
      preserves_session_metadata: true,
      message: ISSUE_MESSAGES[kind],
    };
  }
  if ((state === "healthy") !== (issue === null)) return null;

  // Record-only removal is the fallback for having nothing safe to signal. If the
  // producer still reports a reachable or repairable boundary, or a changed
  // identity that must keep blocking, the offer contradicts its own evidence.
  if (
    safeActions.some((item) => item.may_leave_runtime_running === true)
    && (
      state !== "blocked"
      || requestedOperation !== "delete"
      || boundaryKind === "managed_scope"
      || issue === null
      || !RECORD_ONLY_ISSUE_KINDS.includes(issue.kind)
    )
  ) return null;

  return {
    schema_version: contract,
    session_id: sessionId,
    operation: requestedOperation,
    state,
    session_incarnation: incarnation,
    session_generation: generation,
    issue,
    boundary: { kind: boundaryKind, safe_process_count: safeProcessCount },
    preservation: {
      session_metadata_retained_until_success: true,
      provider_conversation_retained: true,
      destructive_scope: "verified_recorded_runtime_only",
    },
    actions: safeActions,
    preview_digest: raw.preview_digest,
  };
}

export function normalizeSessionMaintenanceActionResult(
  value: unknown,
  expected?: SessionMaintenanceActionResultExpectation,
): SessionMaintenanceActionResult | null {
  const raw = object(value);
  const contract = contractVersion(raw?.schema_version);
  if (
    !raw || !contract
    || (expected?.schemaVersion !== undefined && contract !== expected.schemaVersion)
  ) return null;
  const sessionId = boundedString(raw.session_id);
  const requestedOperation = operation(raw.operation);
  const action = actionId(raw.action);
  const outcome = enumValue(raw.outcome, ["resumed", "deleted", "inspected", "record_removed"] as const);
  const status = enumValue(
    raw.status,
    ["running", "stopped", "unknown", "deleted", "record_removed"] as const,
  );
  const incarnation = nullableString(raw.session_incarnation);
  const generation = nullableGeneration(raw.session_generation);
  if (
    !sessionId || !requestedOperation || !action || ACTIONS[action].operation !== requestedOperation
    || !admitsAction(contract, action)
    || (expected !== undefined && (
      sessionId !== expected.sessionId
      || requestedOperation !== expected.operation
      || action !== expected.action
    ))
    || !outcome || !status || incarnation === undefined || generation === undefined
    || (incarnation === null) !== (generation === null)
    || typeof raw.cleanup_pending !== "boolean"
  ) return null;
  const recordOnly = ACTIONS[action].recordOnly === true;
  if (
    (requestedOperation === "resume" && outcome !== "resumed")
    // Removal is reported as its own outcome precisely because nothing was
    // stopped, so it must never be mistaken for, or reported as, a deletion.
    || (requestedOperation === "delete" && outcome !== (recordOnly ? "record_removed" : "deleted"))
    || (["attach", "inspect"].includes(requestedOperation) && outcome !== "inspected")
    || (outcome === "resumed" && (
      status !== "running"
      || raw.cleanup_pending
    ))
    || (outcome === "deleted" && (status !== "deleted" || incarnation !== null || generation !== null))
    || (outcome === "record_removed" && (
      status !== "record_removed" || incarnation !== null || generation !== null
    ))
    || (outcome === "inspected" && (
      !["running", "stopped", "unknown"].includes(status) || raw.cleanup_pending
    ))
  ) return null;
  return {
    schema_version: contract,
    session_id: sessionId,
    operation: requestedOperation,
    action,
    outcome,
    session_incarnation: incarnation,
    session_generation: generation,
    status,
    cleanup_pending: raw.cleanup_pending,
  };
}

export function normalizeSessionMaintenanceError(
  value: unknown,
  expected?: { readonly sessionId: string; readonly operation: MaintenanceOperation },
): SessionMaintenanceError | null {
  const raw = object(value);
  const code = boundedString(raw?.code, 64);
  if (!raw || !code || !(code in ERROR_MESSAGES)) return null;
  if (code !== "session-maintenance-failed") {
    return { code, message: ERROR_MESSAGES[code]! };
  }
  const details = object(raw.details);
  const id = boundedString(details?.id);
  const requestedOperation = operation(details?.operation);
  const kind = issueKind(details?.kind);
  if (
    !details || !id || !requestedOperation || !kind
    || typeof details.retryable !== "boolean"
    || details.session_metadata_retained !== true
    || (expected !== undefined && (
      id !== expected.sessionId || requestedOperation !== expected.operation
    ))
  ) return null;
  return {
    code,
    message: ERROR_MESSAGES[code]!,
    details: {
      id,
      operation: requestedOperation,
      kind,
      retryable: details.retryable,
      session_metadata_retained: true,
    },
  };
}
