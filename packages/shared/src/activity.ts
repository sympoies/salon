import { NormalizedSseDecoder } from "./sse.ts";
const ACTIVITY_STREAM_EVENT_SCHEMA = "agent-session.activity-stream.event.v1" as const;
const ACTIVITY_DELIVERY_EVENT_SCHEMA = "agent-console.activity-delivery.event.v1" as const;
const TURN_STATE_SCHEMA = "agent-session.turn-state.v1" as const;
const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const PROVIDER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSE_LINE_CONTROL = /[\u0000-\u001F\u007F]/;

type ActivityStreamEventType = "snapshot" | "heartbeat" | "reset";

interface ActivityTurnSource {
  readonly kind: "provider_hook" | "console_observation" | "terminal_heuristic" | "runtime";
  readonly provider?: string;
  readonly confidence: "authoritative" | "observed" | "inferred";
}

interface ActivityTurnAttention {
  readonly kind: "approval" | "clarification" | "authentication" | "other";
  readonly requested_at: string;
  readonly pending_count: number;
  readonly certainty: "exact" | "conservative";
}

interface ActivityCurrentTurn {
  readonly provider_turn_id?: string;
  readonly started_at: string;
  readonly last_progress_at?: string;
  readonly attention?: ActivityTurnAttention;
}

interface ActivityLastTurn {
  readonly provider_turn_id?: string;
  readonly started_at?: string;
  readonly completed_at: string;
  readonly outcome: "completed" | "interrupted" | "failed" | "unknown";
  /** The daemon names a failed turn's cause only for these kinds. */
  readonly provider_failure_kind?: "provider_capacity" | "authentication";
}

interface ActivitySemanticEvent {
  readonly kind:
    | "turn_started"
    | "attention_requested"
    | "attention_cleared"
    | "progress"
    | "stop_observed"
    | "turn_completed"
    | "turn_failed";
  readonly observed_at: string;
}

interface ActivityDiagnostic {
  readonly reason:
    | "completion_evidence_pending"
    | "attention_authority_mismatch"
    | "provider_projection_unavailable"
    | "runtime_activity_unhealthy"
    | "activity_state_unavailable"
    | "codex_progress_quiet";
}

interface ActivityShadowObservation {
  readonly observer_version: string;
  readonly rule_id: string;
  readonly observed_at: string;
  readonly projection: "working" | "needs_input" | "waiting" | "unknown";
  readonly disagrees: boolean;
}

export interface ActivityTurnState {
  readonly schema_version: typeof TURN_STATE_SCHEMA;
  readonly phase: "starting" | "working" | "idle" | "waiting" | "needs_input" | "unknown";
  readonly phase_changed_at: string;
  readonly revision: number;
  readonly source: ActivityTurnSource;
  readonly semantic_event?: ActivitySemanticEvent;
  readonly diagnostic?: ActivityDiagnostic;
  readonly shadow_observation?: ActivityShadowObservation;
  readonly current_turn?: ActivityCurrentTurn;
  readonly last_turn?: ActivityLastTurn;
}

export function isActivityTurnWaitingPhase(phase: unknown): phase is "idle" | "waiting" {
  return phase === "idle" || phase === "waiting";
}

interface ActivitySessionProjection {
  readonly id: string;
  readonly turn_state: ActivityTurnState | null;
}

interface ActivityStreamEventBase {
  readonly schema_version: typeof ACTIVITY_STREAM_EVENT_SCHEMA;
  readonly type: ActivityStreamEventType;
  readonly stream_id: string;
  readonly sequence: number;
  readonly machine: string;
  readonly observed_at: string;
}

interface ActivityStreamProjectionEvent extends ActivityStreamEventBase {
  readonly type: "snapshot" | "reset";
  readonly sessions: readonly ActivitySessionProjection[];
  readonly reason?: never;
}

interface ActivityStreamOversizedResetEvent extends ActivityStreamEventBase {
  readonly type: "reset";
  readonly reason: "oversized_snapshot";
  readonly sessions?: never;
}

interface ActivityStreamHeartbeatEvent extends ActivityStreamEventBase {
  readonly type: "heartbeat";
  readonly sessions?: never;
}

export type ActivityStreamEvent =
  | ActivityStreamProjectionEvent
  | ActivityStreamOversizedResetEvent
  | ActivityStreamHeartbeatEvent;

export interface ActivityDeliveryEvent {
  readonly schema_version: typeof ACTIVITY_DELIVERY_EVENT_SCHEMA;
  readonly type: "delivery";
  readonly machine: string;
  readonly state: "polling" | "reconnecting";
  readonly observed_at: string;
}

export type ActivityFeedEvent = ActivityStreamEvent | ActivityDeliveryEvent;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeString(value: unknown, maxLength = 512): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 || day < 1 || day > (daysInMonth[month - 1] ?? 0) ||
    Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
    Number(offsetHourText ?? 0) > 23 || Number(offsetMinuteText ?? 0) > 59
  ) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function optionalIdentifier(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return safeString(value, 256);
}

function optionalTimestamp(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return timestamp(value);
}

function normalizeSource(value: unknown): ActivityTurnSource | null {
  const source = object(value);
  if (!source) return null;
  if (!(["provider_hook", "console_observation", "terminal_heuristic", "runtime"] as const).includes(source.kind as never)) {
    return null;
  }
  if (!(["authoritative", "observed", "inferred"] as const).includes(source.confidence as never)) return null;
  const provider = optionalIdentifier(source.provider);
  if (provider === null || provider !== undefined && !PROVIDER_IDENTIFIER.test(provider)) return null;
  return {
    kind: source.kind as ActivityTurnSource["kind"],
    ...(provider === undefined ? {} : { provider }),
    confidence: source.confidence as ActivityTurnSource["confidence"],
  };
}

function normalizeAttention(value: unknown): ActivityTurnAttention | null {
  const attention = object(value);
  if (!attention) return null;
  const rawKind = safeString(attention.kind, 64);
  if (!rawKind) return null;
  const kind = (["approval", "clarification", "authentication", "other"] as const).includes(rawKind as never)
    ? rawKind as ActivityTurnAttention["kind"]
    : "other";
  const requestedAt = timestamp(attention.requested_at);
  const certainty = attention.certainty === undefined || attention.certainty === null
    ? "conservative"
    : attention.certainty;
  if (
    !requestedAt ||
    !Number.isSafeInteger(attention.pending_count) ||
    Number(attention.pending_count) < 0 ||
    !(certainty === "exact" || certainty === "conservative")
  ) return null;
  return {
    kind,
    requested_at: requestedAt,
    pending_count: Number(attention.pending_count),
    certainty,
  };
}

function normalizeSemanticEvent(value: unknown): ActivitySemanticEvent | null {
  const event = object(value);
  if (!event) return null;
  if (!((
    [
      "turn_started",
      "attention_requested",
      "attention_cleared",
      "progress",
      "stop_observed",
      "turn_completed",
      "turn_failed",
    ] as const
  ).includes(event.kind as never))) return null;
  const observedAt = timestamp(event.observed_at);
  if (!observedAt) return null;
  return {
    kind: event.kind as ActivitySemanticEvent["kind"],
    observed_at: observedAt,
  };
}

function normalizeDiagnostic(value: unknown): ActivityDiagnostic | null {
  const diagnostic = object(value);
  if (!diagnostic) return null;
  if (!((
    [
      "completion_evidence_pending",
      "attention_authority_mismatch",
      "provider_projection_unavailable",
      "runtime_activity_unhealthy",
      "activity_state_unavailable",
      "codex_progress_quiet",
    ] as const
  ).includes(diagnostic.reason as never))) return null;
  return { reason: diagnostic.reason as ActivityDiagnostic["reason"] };
}

function normalizeShadowObservation(value: unknown): ActivityShadowObservation | null {
  const observation = object(value);
  if (!observation) return null;
  const observerVersion = safeString(observation.observer_version, 64);
  const ruleId = safeString(observation.rule_id, 64);
  const observedAt = timestamp(observation.observed_at);
  if (
    !observerVersion ||
    !ruleId ||
    !PROVIDER_IDENTIFIER.test(observerVersion) ||
    !PROVIDER_IDENTIFIER.test(ruleId) ||
    !observedAt ||
    !(["working", "needs_input", "waiting", "unknown"] as const).includes(observation.projection as never) ||
    typeof observation.disagrees !== "boolean"
  ) return null;
  return {
    observer_version: observerVersion,
    rule_id: ruleId,
    observed_at: observedAt,
    projection: observation.projection as ActivityShadowObservation["projection"],
    disagrees: observation.disagrees,
  };
}

function normalizeCurrentTurn(value: unknown): ActivityCurrentTurn | null {
  const turn = object(value);
  if (!turn) return null;
  const providerTurnId = optionalIdentifier(turn.provider_turn_id);
  const startedAt = timestamp(turn.started_at);
  const lastProgressAt = optionalTimestamp(turn.last_progress_at);
  const attention = turn.attention === undefined || turn.attention === null
    ? undefined
    : normalizeAttention(turn.attention);
  if (providerTurnId === null || !startedAt || lastProgressAt === null || attention === null) return null;
  return {
    ...(providerTurnId === undefined ? {} : { provider_turn_id: providerTurnId }),
    started_at: startedAt,
    ...(lastProgressAt === undefined ? {} : { last_progress_at: lastProgressAt }),
    ...(attention === undefined ? {} : { attention }),
  };
}

function normalizeLastTurn(value: unknown): ActivityLastTurn | null {
  const turn = object(value);
  if (!turn) return null;
  const providerTurnId = optionalIdentifier(turn.provider_turn_id);
  const startedAt = optionalTimestamp(turn.started_at);
  const completedAt = timestamp(turn.completed_at);
  if (
    providerTurnId === null || startedAt === null || !completedAt ||
    !(["completed", "interrupted", "failed", "unknown"] as const).includes(turn.outcome as never)
  ) return null;
  return {
    ...(providerTurnId === undefined ? {} : { provider_turn_id: providerTurnId }),
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    completed_at: completedAt,
    outcome: turn.outcome as ActivityLastTurn["outcome"],
    ...(turn.outcome === "failed" && (turn.provider_failure_kind === "provider_capacity" || turn.provider_failure_kind === "authentication")
      ? { provider_failure_kind: turn.provider_failure_kind } : {}),
  };
}

export function normalizeActivityTurnState(value: unknown): ActivityTurnState | null {
  const state = object(value);
  if (!state || state.schema_version !== TURN_STATE_SCHEMA) return null;
  if (!(["starting", "working", "idle", "waiting", "needs_input", "unknown"] as const).includes(state.phase as never)) return null;
  const phaseChangedAt = timestamp(state.phase_changed_at);
  const source = normalizeSource(state.source);
  if (!phaseChangedAt || !source || !Number.isSafeInteger(state.revision) || Number(state.revision) < 0) return null;
  const semanticEvent = state.semantic_event === undefined || state.semantic_event === null
    ? undefined
    : normalizeSemanticEvent(state.semantic_event);
  const diagnostic = state.diagnostic === undefined || state.diagnostic === null
    ? undefined
    : normalizeDiagnostic(state.diagnostic);
  const shadowObservation = state.shadow_observation === undefined || state.shadow_observation === null
    ? undefined
    : normalizeShadowObservation(state.shadow_observation);
  const currentTurn = state.current_turn === undefined || state.current_turn === null
    ? undefined
    : normalizeCurrentTurn(state.current_turn);
  const lastTurn = state.last_turn === undefined || state.last_turn === null
    ? undefined
    : normalizeLastTurn(state.last_turn);
  if (currentTurn === null || lastTurn === null) return null;
  if (state.phase === "working" && !currentTurn) return null;
  if (state.phase === "needs_input" && (!currentTurn || !currentTurn.attention)) return null;
  if (state.phase === "waiting" && !lastTurn) return null;
  return {
    schema_version: TURN_STATE_SCHEMA,
    phase: state.phase as ActivityTurnState["phase"],
    phase_changed_at: phaseChangedAt,
    revision: Number(state.revision),
    source,
    ...(semanticEvent ? { semantic_event: semanticEvent } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    ...(shadowObservation ? { shadow_observation: shadowObservation } : {}),
    ...(currentTurn === undefined ? {} : { current_turn: currentTurn }),
    ...(lastTurn === undefined ? {} : { last_turn: lastTurn }),
  };
}

function normalizeProjection(value: unknown): ActivitySessionProjection | null {
  const projection = object(value);
  if (!projection) return null;
  const id = safeString(projection.id);
  if (!id) return null;
  const turnState = projection.turn_state === null ? null : normalizeActivityTurnState(projection.turn_state);
  if (projection.turn_state !== null && !turnState) return null;
  return {
    id,
    turn_state: turnState,
  };
}

export function normalizeActivityStreamEvent(value: unknown, configuredMachine?: string): ActivityStreamEvent | null {
  const event = object(value);
  if (!event || event.schema_version !== ACTIVITY_STREAM_EVENT_SCHEMA) return null;
  if (!(["snapshot", "heartbeat", "reset"] as const).includes(event.type as never)) return null;
  const streamId = safeString(event.stream_id, 256);
  const machine = safeString(configuredMachine ?? event.machine, 256);
  const observedAt = timestamp(event.observed_at);
  if (
    !streamId || SSE_LINE_CONTROL.test(streamId) || !machine || !observedAt ||
    !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 0
  ) return null;
  const base = {
    schema_version: ACTIVITY_STREAM_EVENT_SCHEMA,
    type: event.type as ActivityStreamEventType,
    stream_id: streamId,
    sequence: Number(event.sequence),
    machine,
    observed_at: observedAt,
  };
  if (event.type === "heartbeat") {
    return event.sessions === undefined && event.reason === undefined ? { ...base, type: "heartbeat" } : null;
  }
  if (event.type === "reset" && event.reason === "oversized_snapshot") {
    return event.sessions === undefined ? { ...base, type: "reset", reason: "oversized_snapshot" } : null;
  }
  if (event.reason !== undefined) return null;
  if (!Array.isArray(event.sessions) || event.sessions.length > 10_000) return null;
  const sessions: ActivitySessionProjection[] = [];
  for (const raw of event.sessions) {
    const projection = normalizeProjection(raw);
    if (!projection) return null;
    sessions.push(projection);
  }
  return { ...base, type: event.type as "snapshot" | "reset", sessions };
}

export function normalizeActivityDeliveryEvent(value: unknown, configuredMachine?: string): ActivityDeliveryEvent | null {
  const event = object(value);
  if (!event || event.schema_version !== ACTIVITY_DELIVERY_EVENT_SCHEMA || event.type !== "delivery") return null;
  const machine = safeString(configuredMachine ?? event.machine, 256);
  const observedAt = timestamp(event.observed_at);
  if (!machine || !observedAt || !(event.state === "polling" || event.state === "reconnecting")) return null;
  return {
    schema_version: ACTIVITY_DELIVERY_EVENT_SCHEMA,
    type: "delivery",
    machine,
    state: event.state,
    observed_at: observedAt,
  };
}

export class ActivitySseDecoder extends NormalizedSseDecoder<ActivityStreamEvent> {
  constructor(configuredMachine?: string) {
    super((value) => normalizeActivityStreamEvent(value, configuredMachine));
  }
}

export class ActivityFeedSseDecoder extends NormalizedSseDecoder<ActivityFeedEvent> {
  constructor() {
    super((value) => normalizeActivityStreamEvent(value) ?? normalizeActivityDeliveryEvent(value));
  }
}

export function serializeActivitySseEvent(event: ActivityStreamEvent): string {
  const lineSafeId = event.stream_id.replace(/[\u0000-\u001F\u007F]/g, (control) =>
    `%${control.charCodeAt(0).toString(16).padStart(2, "0")}`
  );
  return `id: ${lineSafeId}:${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function serializeActivityDeliverySseEvent(event: ActivityDeliveryEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
