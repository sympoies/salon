import type { PromptDeliveryFailure } from "./promptDelivery.ts";
import { normalizeSessionModelSettings } from "@agent-console/shared/session-model";
import type { TerminalConnectionStatus } from "./TerminalPane.tsx";
import { isActivityTurnWaitingPhase, normalizeActivityTurnState } from "@agent-console/shared/activity";
import { dashboardActivityObservation, dashboardUnavailableSince } from "./dashboardSessions.ts";
import {
  activityObservationAgeMs,
  activitySemanticNowMs,
  createActivityObservationAnchor,
  isActivityObservationStale,
} from "./activityClock.ts";
import type { ActivityDeliveryState } from "./activityStream.ts";
import type { DashboardSession, TurnState } from "./types.ts";
import { isDshAgent } from "./dshAgent.ts";
import {classifySessionStatus, sessionStatusEvidence, type SessionStatusGroup} from "./sessionStatusGroups.ts";

export type SessionActivityKind =
  | "working"
  | "working-uncertain"
  | "working-attention"
  | "attention-unconfirmed"
  | "completed"
  | "waiting"
  | "needs-input"
  | "connecting"
  | "resumable"
  | "stopped"
  | "unavailable"
  | "active"
  | "quiet"
  | "unknown";

export interface EffectiveSessionActivity {
  readonly kind: SessionActivityKind;
  readonly primaryText: string;
  readonly attentionText?: string;
  readonly ariaText?: string;
  readonly timerStartedAt?: string;
  readonly attentionTimerStartedAt?: string;
  readonly sourceKind?: string;
  readonly sourceProvider?: string;
  readonly confidence?: string;
  readonly attentionKind?: string;
  readonly attentionCertainty?: "exact" | "conservative";
  readonly pendingCount?: number;
  // Stable fingerprint of the active attention (requested_at + pending_count).
  // Present only while an "Input requested" pill is shown; the popover records
  // it to dismiss that pill and a changed fingerprint restores a fresh request.
  readonly attentionDismissKey?: string;
  readonly ripple: boolean;
  readonly lastKnown?: EffectiveSessionActivity;
  readonly observationStale?: boolean;
  readonly observationTransport?: "poll" | "stream";
}

export interface SelectSessionActivityInput {
  readonly session: DashboardSession;
  readonly machineReachable: boolean;
  readonly focused: boolean;
  readonly terminalStatus?: TerminalConnectionStatus;
  readonly nowMs: number;
  readonly monotonicNowMs?: number;
  readonly activityDeliveryState?: ActivityDeliveryState;
  // When it equals the current pill's `attentionDismissKey`, the user has
  // dismissed this exact attention and the "Input requested" pill is suppressed.
  readonly dismissedAttentionKey?: string | null;
  // Device-local acknowledgement for the exact completion identity currently
  // represented by this session. A later revision/completion does not match.
  readonly acknowledgedCompletionKey?: string | null;
}

export interface ActivityDetailRow {
  readonly label: string;
  readonly value: string;
}

export interface ActivityDetailGroup {
  readonly title: string;
  readonly rows: readonly ActivityDetailRow[];
}

const ACTIVE_FALLBACK_MS = 30_000;
const TERMINAL_RIPPLE_MS = 10_000;
const COMPLETION_RIPPLE_MS = 15_000;
// A `needs_input` phase renders as "Working" (alongside the pending-input cue)
// only while provider progress is recent. Active turns emit progress well under a
// minute apart, while a stopped or blocked agent stops emitting it, so this bounds
// a stuck `needs_input` phase — e.g. an attention the provider never cleared — from
// reading as an endless "Working" after the agent has actually stopped.
export const WORKING_ATTENTION_PROGRESS_FRESH_MS = 90_000;
// `starting` is the daemon's launch state, and only a provider event moves it on.
// A provider with no hook integration therefore holds it forever, which would
// otherwise render as an endless "Connecting…" — reading as "not connected"
// rather than "state unknown". Past this bound the terminal heartbeat is the
// honest signal, so hand over to it.
export const STARTING_PHASE_FRESH_MS = 90_000;
export const PROVIDER_SEMANTIC_EVIDENCE_FRESH_MS = 5 * 60_000;
const ACTIVITY_OBSERVATION_STALE_MS = 35_000;
const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

interface ParsedTimestamp {
  readonly milliseconds: number;
  readonly submillisecondNanoseconds: number;
}

function parsedTimestamp(value: unknown): ParsedTimestamp | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return null;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 ||
    day < 1 || day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const fractionalNanoseconds = Number((fractionText ?? "").padEnd(9, "0"));
  return {
    milliseconds: parsed,
    submillisecondNanoseconds: fractionalNanoseconds % 1_000_000,
  };
}

function timestampMs(value: unknown): number | null {
  return parsedTimestamp(value)?.milliseconds ?? null;
}

function compareTimestamps(left: ParsedTimestamp, right: ParsedTimestamp): number {
  if (left.milliseconds !== right.milliseconds) return left.milliseconds - right.milliseconds;
  return left.submillisecondNanoseconds - right.submillisecondNanoseconds;
}

function elapsedMs(timestamp: string | undefined, nowMs: number): number | null {
  if (!timestamp || !Number.isFinite(nowMs)) return null;
  const value = timestampMs(timestamp);
  if (value === null || value > nowMs) return null;
  return nowMs - value;
}

export function formatElapsedDuration(elapsed: number): string | null {
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatActivityDuration(timestamp: string | undefined, nowMs: number): string | null {
  const elapsed = elapsedMs(timestamp, nowMs);
  return elapsed === null ? null : formatElapsedDuration(elapsed);
}

export function formatActivityHeaderText(
  activity: EffectiveSessionActivity,
  nowMs: number,
): string {
  const elapsed = elapsedMs(activity.timerStartedAt, nowMs);
  return elapsed === null ? "" : formatCardElapsedDuration(elapsed);

}

export function formatCardElapsedDuration(elapsed: number): string {
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** Names only the failure kinds the daemon sends; anything else stays unexplained. */
function failureKindSuffix(kind: string | undefined): string {
  return kind === "authentication" ? " (sign-in required)" : kind === "provider_capacity" ? " (provider at capacity)" : "";
}

export type CardStatus = "working" | "waiting" | "completed" | "blocked" | "stopped" | "unknown";
export function cardActivityPresentation(
  activity: EffectiveSessionActivity, session: DashboardSession, machineReachable: boolean,
  promptFailure?: PromptDeliveryFailure,
): {state: CardStatus; group: SessionStatusGroup | null; description: string; timerStartedAt?: string} {
  const turn = parseTurnStateV1(session.turn_state);
  const observation = dashboardActivityObservation(session);
  const lastRead = observation?.daemonObservedAt ?? session.activity_observed_at;
  const evidence = sessionStatusEvidence(session);
  const group = classifySessionStatus({ ...evidence, error: Boolean(promptFailure) || evidence.error });
  const unknown = (reason: string) => ({
    state: "unknown" as const, group, description: `State unknown: ${reason}`, timerStartedAt: lastRead,
  });
  if (promptFailure) return {
    state: promptFailure.unknown ? "unknown" : "blocked", group,
    description: promptFailure.unknown ? "State unknown: prompt delivery not confirmed" : "Blocked: prompt was not sent",
    timerStartedAt: promptFailure.unknown ? lastRead : promptFailure.at,
  };
  if (!machineReachable) return unknown("spoke disconnected");
  if (dashboardUnavailableSince(session)) return unknown("session missing from current snapshot");
  if (activity.observationStale) return unknown("status observation expired");
  if (session.startup?.state === "failed") return {
    state: "blocked", group, description: `Blocked: ${session.startup.message}`, timerStartedAt: session.startup.occurred_at,
  };
  if (activity.kind === "working-uncertain") return unknown("provider status expired");
  if (["unknown", "active", "quiet", "connecting", "unavailable"].includes(activity.kind)) {
    // Time an unknown provider state from its last evidence, not from the
    // daemon's latest read, which is always "now" (#873).
    return {...unknown(turn?.diagnostic?.reason.replaceAll("_", " ") ?? "provider status unavailable"),
      timerStartedAt: turn?.current_turn?.last_progress_at ?? turn?.semantic_event?.observed_at ?? turn?.phase_changed_at ?? lastRead};
  }
  const failed = turn?.last_turn?.outcome === "failed" && isActivityTurnWaitingPhase(turn.phase);
  // Any pending input request needs the human, whatever its certainty (#873).
  const requested = activity.kind === "needs-input" || activity.kind === "working-attention"
    || activity.kind === "attention-unconfirmed";
  const permission = requested && (activity.attentionKind === "approval" || activity.attentionKind === "authentication");
  if (failed || permission) return {
    state: "blocked", group,
    description: failed ? `Blocked: provider failed${failureKindSuffix(turn?.last_turn?.provider_failure_kind)}` : permission
      ? `Blocked: ${activity.attentionKind === "approval" ? "approval" : "authentication"} required; ${activity.ariaText ?? activity.primaryText}`
      : activity.primaryText,
    timerStartedAt: failed ? turn?.last_turn?.completed_at
      : activity.attentionTimerStartedAt ?? activity.timerStartedAt,
  };
  if (requested) return {
    state: "blocked", group,
    description: `Needs input: ${activity.attentionKind ?? "input"} requested`
      + `${activity.attentionCertainty === "conservative" ? " (unconfirmed)" : ""}; ${activity.ariaText ?? activity.primaryText}`,
    timerStartedAt: activity.attentionTimerStartedAt ?? activity.timerStartedAt,
  };
  if (activity.kind === "stopped" || activity.kind === "resumable") {
    return {state: "stopped", group, description: activity.kind === "resumable" ? "Session stopped; resume available" : "Session stopped", timerStartedAt: lastRead};
  }
  const state = activity.kind === "completed" ? "completed"
    : activity.kind === "working" ? "working" : "waiting";
  return {state, group, description: activity.ariaText ?? activity.primaryText, timerStartedAt: activity.timerStartedAt ?? turn?.phase_changed_at};
}

// Fingerprints an attention so a manual dismiss stays scoped to that exact
// request. Any change to `requested_at` or `pending_count` yields a new key,
// which restores the pill so a fresh input request is never silently muted.
function attentionFingerprint(requestedAt: string | undefined, pendingCount: number | undefined): string {
  return `${requestedAt ?? ""}#${pendingCount ?? ""}`;
}

function withTimer(
  kind: SessionActivityKind,
  label: string,
  timestamp: string | undefined,
  nowMs: number,
  extra: Partial<EffectiveSessionActivity> = {},
): EffectiveSessionActivity {
  const duration = formatActivityDuration(timestamp, nowMs);
  return {
    kind,
    primaryText: duration ? `${label} ${duration}` : label,
    timerStartedAt: duration ? timestamp : undefined,
    ripple: false,
    ...extra,
  };
}

export function parseTurnStateV1(state: unknown): TurnState | null {
  return normalizeActivityTurnState(state);
}

function safeSessionStatus(status: unknown): "running" | "stopped" | "unknown" {
  if (status === "running" || status === "stopped") return status;
  return "unknown";
}

function providerDisplayLabel(provider: unknown): "Codex" | "Claude" | "DSH" | undefined {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  if (typeof provider === "string" && isDshAgent(provider)) return "DSH";
  return undefined;
}

function fallbackActivity(session: DashboardSession, nowMs: number): EffectiveSessionActivity {
  const elapsed = elapsedMs(session.last_terminal_activity_at, nowMs);
  if (elapsed !== null) {
    const active = elapsed <= ACTIVE_FALLBACK_MS;
    return withTimer(
      active ? "active" : "quiet",
      active ? "Terminal active" : "Terminal quiet",
      session.last_terminal_activity_at,
      nowMs,
      {
      ripple: elapsed <= TERMINAL_RIPPLE_MS,
      },
    );
  }
  return { kind: "unknown", primaryText: "State unknown", ripple: false };
}

export function completionAcknowledgementKey(session: DashboardSession): string | null {
  const state = parseTurnStateV1(session.turn_state);
  if (!isActivityTurnWaitingPhase(state?.phase) || state.last_turn?.outcome !== "completed") return null;
  const incarnation = session.session_incarnation?.trim();
  if (!incarnation) return null;
  const turnIdentity = state.last_turn.provider_turn_id ?? state.last_turn.completed_at;
  return [
    session.machine,
    session.id,
    incarnation,
    turnIdentity,
    state.last_turn.completed_at,
  ].join("\u001f");
}

function providerActivity(
  session: DashboardSession,
  nowMs: number,
  dismissedAttentionKey?: string | null,
  acknowledgedCompletionKey?: string | null,
): EffectiveSessionActivity {
  const state = parseTurnStateV1(session.turn_state);
  if (!state || state.phase === "unknown") return fallbackActivity(session, nowMs);
  const metadata = {
    sourceKind: state.source?.kind,
    sourceProvider: providerDisplayLabel(state.source?.provider),
    confidence: state.source?.confidence,
  };
  if (state.phase === "starting") {
    // Phase dwell, so `phase_changed_at` alone: `semantic_event` carries provider
    // evidence age, which the `working` branch below wants but this one must not.
    // Preferring it would hand over on a fresh launch that happens to carry an old
    // event, and never hand over on a session stuck in `starting` that keeps
    // emitting — exactly inverting this bound. A future timestamp yields null and
    // stays `connecting`: an untrusted clock is not grounds to declare staleness.
    const startingElapsed = elapsedMs(state.phase_changed_at, nowMs);
    if (startingElapsed !== null && startingElapsed >= STARTING_PHASE_FRESH_MS) {
      return fallbackActivity(session, nowMs);
    }
    return { kind: "connecting", primaryText: "Connecting…", ripple: false, ...metadata };
  }
  if (state.phase === "working") {
    const terminalElapsed = elapsedMs(session.last_terminal_activity_at, nowMs);
    // Older daemons do not emit `semantic_event`; phase_changed_at is the
    // conservative semantic clock in that compatibility path.
    const semanticElapsed = elapsedMs(
      state.semantic_event?.observed_at ?? state.phase_changed_at,
      nowMs,
    );
    const evidenceOld =
      semanticElapsed !== null && semanticElapsed >= PROVIDER_SEMANTIC_EVIDENCE_FRESH_MS;
    return withTimer(evidenceOld ? "working-uncertain" : "working", evidenceOld ? "Working · evidence old" : "Working", state.phase_changed_at, nowMs, {
      ...metadata,
      ripple: terminalElapsed !== null && terminalElapsed <= TERMINAL_RIPPLE_MS,
    });
  }
  if (state.phase === "idle" || state.phase === "waiting") {
    if (state.last_turn?.outcome === "completed") {
      const completedElapsed = elapsedMs(state.last_turn.completed_at, nowMs);
      const acknowledged = completionAcknowledgementKey(session) === acknowledgedCompletionKey;
      return withTimer(acknowledged ? "waiting" : "completed", acknowledged ? "Waiting" : "Done", state.last_turn.completed_at, nowMs, {
        ...metadata,
        ripple: !acknowledged && completedElapsed !== null && completedElapsed <= COMPLETION_RIPPLE_MS,
      });
    }
    // A failed turn (e.g. a usage limit) is not plain waiting (#937).
    if (state.last_turn?.outcome === "failed") {
      return withTimer("waiting", `Failed${failureKindSuffix(state.last_turn.provider_failure_kind)}`, state.last_turn.completed_at, nowMs, metadata);
    }
    return withTimer("waiting", "Waiting", state.last_turn?.completed_at ?? state.phase_changed_at, nowMs, metadata);
  }
  const attention = state.current_turn?.attention;
  const attentionExact = attention?.certainty === "exact";
  const progressAt = parsedTimestamp(state.current_turn?.last_progress_at);
  const requestedAt = parsedTimestamp(attention?.requested_at);
  if (
    progressAt !== null &&
    requestedAt !== null &&
    progressAt.milliseconds <= nowMs &&
    requestedAt.milliseconds <= nowMs &&
    compareTimestamps(progressAt, requestedAt) > 0 &&
    nowMs - progressAt.milliseconds <= WORKING_ATTENTION_PROGRESS_FRESH_MS
  ) {
    const terminalElapsed = elapsedMs(session.last_terminal_activity_at, nowMs);
    const ripple = terminalElapsed !== null && terminalElapsed <= TERMINAL_RIPPLE_MS;
    const attentionDismissKey = attentionFingerprint(attention?.requested_at, attention?.pending_count);
    // The user manually dismissed this exact attention; fall back to a plain
    // Working cue. A later attention has a different fingerprint, so it reappears.
    if (dismissedAttentionKey !== undefined && dismissedAttentionKey === attentionDismissKey) {
      return withTimer("working", "Working", state.current_turn?.started_at, nowMs, { ...metadata, ripple });
    }
    const working = withTimer("working-attention", "Working", state.current_turn?.started_at, nowMs, {
      ...metadata,
      attentionKind: attention?.kind,
      attentionCertainty: attention?.certainty,
      pendingCount: attention?.pending_count,
      attentionDismissKey,
      ripple,
    });
    const attentionDuration = formatActivityDuration(attention?.requested_at, nowMs);
    const attentionLabel = attentionExact ? "Input requested" : "Input may be needed";
    const attentionText = attentionDuration ? `${attentionLabel} ${attentionDuration}` : attentionLabel;
    const pendingText = attention?.pending_count === undefined ? "" : `; ${attention.pending_count} pending`;
    return {
      ...working,
      attentionText,
      ariaText: `${working.primaryText}; ${attentionText.toLowerCase()}${pendingText}`,
      attentionTimerStartedAt: attentionDuration ? attention?.requested_at : undefined,
    };
  }
  return withTimer(
    attentionExact ? "needs-input" : "attention-unconfirmed",
    attentionExact ? "Needs input" : "Input may be needed",
    attention?.requested_at,
    nowMs,
    {
    ...metadata,
    attentionKind: attention?.kind,
    attentionCertainty: attention?.certainty,
    pendingCount: attention?.pending_count,
    },
  );
}

export function selectSessionActivity(input: SelectSessionActivityInput): EffectiveSessionActivity {
  const { session, machineReachable, focused, terminalStatus, nowMs } = input;
  const status = safeSessionStatus(session.status);
  const unavailableSince = dashboardUnavailableSince(session);
  const observation = dashboardActivityObservation(session);
  const anchor = observation ? createActivityObservationAnchor({
    daemonObservedAt: observation.daemonObservedAt,
    clientReceivedMonotonicMs: observation.receivedMonotonicMs,
  }) : null;
  const monotonicNowMs = input.monotonicNowMs ?? (typeof performance === "undefined" ? 0 : performance.now());
  const semanticNowMs = observation?.frozenSemanticNowMs ??
    (anchor ? activitySemanticNowMs(anchor, monotonicNowMs) : nowMs);
  const legacyUnavailableNowMs = timestampMs(unavailableSince) ?? nowMs;
  const phase = providerActivity(
    session,
    unavailableSince && !anchor ? legacyUnavailableNowMs : semanticNowMs,
    input.dismissedAttentionKey,
    input.acknowledgedCompletionKey,
  );
  const observationMetadata = anchor ? {
    observationStale: isActivityObservationStale(anchor, monotonicNowMs, ACTIVITY_OBSERVATION_STALE_MS),
    observationTransport: observation?.transport,
  } : {};
  if (!machineReachable || unavailableSince) {
    return {
      ...withTimer("unavailable", "Unavailable", unavailableSince, nowMs),
      lastKnown: phase,
      ...observationMetadata,
    };
  }
  if (status === "stopped") {
    return {
      kind: session.resumable ? "resumable" : "stopped",
      primaryText: session.resumable ? "Stopped · resumable" : "Stopped",
      ripple: false,
      lastKnown: phase,
      ...observationMetadata,
    };
  }
  if (status !== "running") {
    return { kind: "unavailable", primaryText: "Unavailable", ripple: false, lastKnown: phase, ...observationMetadata };
  }
  if (focused && terminalStatus && terminalStatus !== "open") {
    return { kind: "connecting", primaryText: "Connecting…", ripple: false, lastKnown: phase, ...observationMetadata };
  }
  return { ...phase, ...observationMetadata };
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function absoluteTime(timestamp: string | undefined): string | null {
  const parsed = timestampMs(timestamp);
  if (parsed === null) return null;
  const date = new Date(parsed);
  const pad = (value: number) => value.toString().padStart(2, "0");
  const calendarDate = `${date.getFullYear().toString().padStart(4, "0")}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  const clockTime = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${calendarDate}, ${clockTime}`;
}

/** An absolute local time with its age, e.g. `2030/01/01, 08:00:00 · 5m ago`. */
export function timeValue(timestamp: string | undefined, nowMs: number): string | null {
  const absolute = absoluteTime(timestamp);
  const relative = formatActivityDuration(timestamp, nowMs);
  return absolute && relative ? `${absolute} · ${relative} ago` : absolute;
}

function addTime(rows: ActivityDetailRow[], label: string, timestamp: string | undefined, nowMs: number): void {
  const value = timeValue(timestamp, nowMs);
  if (value) rows.push({ label, value });
}

function activitySummary(activity: EffectiveSessionActivity): string {
  if (!activity.attentionText) return activity.primaryText;
  const pending = activity.pendingCount === undefined ? "" : ` · ${activity.pendingCount} pending`;
  return `${activity.primaryText} · ${activity.attentionText}${pending}`;
}

export function buildSessionActivityDetails(
  input: SelectSessionActivityInput & { readonly effective: EffectiveSessionActivity },
): ActivityDetailGroup[] {
  const { session, effective, machineReachable, focused, terminalStatus, nowMs } = input;
  const state = parseTurnStateV1(session.turn_state);
  const unavailableSince = dashboardUnavailableSince(session);
  const observation = dashboardActivityObservation(session);
  const anchor = observation ? createActivityObservationAnchor({
    daemonObservedAt: observation.daemonObservedAt,
    clientReceivedMonotonicMs: observation.receivedMonotonicMs,
  }) : null;
  const monotonicNowMs = input.monotonicNowMs ?? (typeof performance === "undefined" ? 0 : performance.now());
  const observationNowMs = observation?.frozenSemanticNowMs ??
    (anchor ? activitySemanticNowMs(anchor, monotonicNowMs) : timestampMs(unavailableSince) ?? nowMs);
  const currentRows: ActivityDetailRow[] = [{ label: "Current state", value: activitySummary(effective) }];
  if (effective.lastKnown) currentRows.push({ label: "Last-known state", value: activitySummary(effective.lastKnown) });
  addTime(currentRows, "Unavailable since", unavailableSince, nowMs);
  if (anchor && observation) {
    const age = activityObservationAgeMs(anchor, monotonicNowMs);
    currentRows.push({
      label: "Last synced",
      value: `${formatElapsedDuration(age) ?? "Unavailable"} ago · ${observation.transport === "stream" ? "Realtime" : "Poll"}`,
    });
    currentRows.push({
      label: "Freshness",
      value: isActivityObservationStale(anchor, monotonicNowMs, ACTIVITY_OBSERVATION_STALE_MS) ? "Stale" : "Fresh",
    });
  } else {
    currentRows.push({ label: "Freshness", value: "Unavailable · old daemon fallback" });
  }
  if (input.activityDeliveryState) {
    const delivery = input.activityDeliveryState === "realtime"
      ? "Realtime connected"
      : input.activityDeliveryState === "polling"
        ? "Polling only"
        : "Poll fallback · realtime reconnecting";
    currentRows.push({ label: "Delivery", value: delivery });
  }
  if (state?.source?.confidence) currentRows.push({ label: "Confidence", value: titleCase(state.source.confidence) });
  if (state?.source?.kind) {
    const provider = providerDisplayLabel(state.source.provider);
    currentRows.push({
      label: "Source",
      value: [provider, titleCase(state.source.kind)].filter(Boolean).join(" · "),
    });
  }
  if (!state && session.last_terminal_activity_at) {
    currentRows.push({ label: "Evidence", value: "Terminal only · provider state unavailable" });
  }
  if (state?.semantic_event) {
    const age = elapsedMs(state.semantic_event.observed_at, observationNowMs);
    currentRows.push({
      label: "Last provider event",
      value: `${titleCase(state.semantic_event.kind)}${age === null ? "" : ` · ${formatElapsedDuration(age) ?? "Unavailable"} ago`}`,
    });
  }
  if (state?.diagnostic) {
    currentRows.push({ label: "Diagnostic", value: titleCase(state.diagnostic.reason) });
  }
  if (state?.shadow_observation) {
    currentRows.push({
      label: "Shadow observer",
      value: `${titleCase(state.shadow_observation.projection)} · ${titleCase(state.shadow_observation.rule_id)}${state.shadow_observation.disagrees ? " · Disagrees" : ""}`,
    });
    addTime(currentRows, "Shadow observed", state.shadow_observation.observed_at, observationNowMs);
  }
  addTime(currentRows, "Current turn", state?.current_turn?.started_at, observationNowMs);
  addTime(currentRows, "Last provider progress", state?.current_turn?.last_progress_at, observationNowMs);
  if (state?.current_turn?.attention?.kind) {
    const pending = state.current_turn.attention.pending_count;
    currentRows.push({
      label: "Attention",
      value: `${titleCase(state.current_turn.attention.kind)} · ${titleCase(state.current_turn.attention.certainty)}${pending && pending > 1 ? ` · ${pending} pending` : ""}`,
    });
    addTime(currentRows, "Attention requested", state.current_turn.attention.requested_at, observationNowMs);
  }
  addTime(currentRows, "Last terminal activity", session.last_terminal_activity_at, observationNowMs);

  const previousRows: ActivityDetailRow[] = [];
  addTime(previousRows, "Previous turn started", state?.last_turn?.started_at, observationNowMs);
  addTime(previousRows, "Previous turn completed", state?.last_turn?.completed_at, observationNowMs);
  const previousDuration =
    state?.last_turn?.started_at && state.last_turn.completed_at
      ? elapsedMs(state.last_turn.started_at, Date.parse(state.last_turn.completed_at))
      : null;
  if (previousDuration !== null) {
    previousRows.push({
      label: "Previous turn duration",
      value: formatElapsedDuration(previousDuration) ?? "Unavailable",
    });
  }
  if (state?.last_turn?.outcome) previousRows.push({ label: "Previous turn outcome", value: titleCase(state.last_turn.outcome) });

  const modelSettings = normalizeSessionModelSettings(session);
  const runtimeRows: ActivityDetailRow[] = [
    { label: "Model", value: modelSettings.model ?? "unknown" },
    { label: "Reasoning effort", value: modelSettings.reasoning_effort ?? "unknown" },
    { label: "Machine", value: `${session.machine} · ${machineReachable ? "Reachable" : "Unavailable"}` },
    { label: "Process", value: `${titleCase(safeSessionStatus(session.status))}${session.resumable ? " · Resumable" : ""}` },
  ];
  if (focused && terminalStatus) runtimeRows.push({ label: "Transport", value: titleCase(terminalStatus) });
  addTime(runtimeRows, "Session created", session.created_at, nowMs);
  addTime(runtimeRows, "Runtime started", session.runtime_started_at, nowMs);
  addTime(runtimeRows, "Record updated", session.updated_at, nowMs);

  return [
    { title: "Activity", rows: currentRows },
    ...(previousRows.length > 0 ? [{ title: "Previous turn", rows: previousRows }] : []),
    { title: "Runtime", rows: runtimeRows },
  ];
}
