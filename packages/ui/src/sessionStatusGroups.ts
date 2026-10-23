export const SESSION_STATUS_GROUPS = ["working", "waiting", "attention", "unknown", "stopped"] as const;
export type SessionStatusGroup = typeof SESSION_STATUS_GROUPS[number];
/** Full, compact and narrow labels for each group, in that order. */
export const SESSION_STATUS_LABELS: Readonly<Record<SessionStatusGroup, readonly [string, string, string]>> = {
  working: ["Working", "Working", "Work"],
  waiting: ["Waiting", "Waiting", "Wait"],
  attention: ["Needs attention", "Attention", "Attn"],
  unknown: ["State unknown", "Unknown", "Unkn"],
  stopped: ["Stopped", "Stop", "Stop"],
};

export interface SessionStatusEvidence {
  readonly runtimeStatus?: string | null;
  readonly turnPhase?: string | null;
  readonly lastTurnOutcome?: string | null;
  readonly error?: boolean;
}

/** Maps runtime, turn, and outcome evidence to the five compact status groups.
 * A pending input request (any harness, any certainty), a failed turn, a
 * starting session and an offline or erroring runtime need the human
 * (Attention). A running session whose turn state is missing, unknown or
 * unrecognized is only unobservable, so it is "State unknown", not Attention
 * (#873).
 */
export function classifySessionStatus(evidence: SessionStatusEvidence): SessionStatusGroup | null {
  if (evidence.error
    || (evidence.turnPhase === "unknown" && evidence.runtimeStatus !== "running")
    || (evidence.turnPhase === "needs_input" && evidence.runtimeStatus !== "running")
    || evidence.runtimeStatus === "unknown" || evidence.runtimeStatus === "missing"
    || (evidence.runtimeStatus != null && evidence.runtimeStatus !== "running" && evidence.runtimeStatus !== "stopped")) return "attention";
  if (evidence.runtimeStatus === "stopped") return "stopped";
  if (evidence.runtimeStatus === "running") {
    if (evidence.turnPhase === "working") return "working";
    if (evidence.turnPhase === "needs_input" || evidence.turnPhase === "starting") return "attention";
    if (evidence.turnPhase === "idle" || evidence.turnPhase === "waiting") {
      return evidence.lastTurnOutcome === "failed" ? "attention" : "waiting";
    }
    return "unknown";
  }
  return "attention";
}

interface StatusRecord {
  readonly status?: string | null;
  readonly runtime_status?: string | null;
  readonly turn_state?: { readonly phase?: string | null; readonly last_turn?: { readonly outcome?: string | null } | null } | null;
  readonly startup?: { readonly state?: string } | null;
}

/** The one evidence reading behind header counts, filters and cards (#873). */
export function sessionStatusEvidence(record: StatusRecord): SessionStatusEvidence {
  return {
    runtimeStatus: record.runtime_status ?? record.status,
    turnPhase: record.turn_state?.phase,
    lastTurnOutcome: record.turn_state?.last_turn?.outcome,
    error: record.startup?.state === "failed",
  };
}

export type SessionStatusCounts = Readonly<Record<SessionStatusGroup, number>>;

export function countSessionStatuses<T>(records: readonly T[], evidence: (record: T) => SessionStatusEvidence): SessionStatusCounts {
  const counts: Record<SessionStatusGroup, number> = { working: 0, waiting: 0, attention: 0, unknown: 0, stopped: 0 };
  for (const record of records) {
    const group = classifySessionStatus(evidence(record));
    if (group) counts[group] += 1;
  }
  return counts;
}
