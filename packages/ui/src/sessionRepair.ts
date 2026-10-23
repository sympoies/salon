import { isSessionResumeAvailable, sessionLabel } from "./format.ts";
import { sessionKey } from "./layout.ts";
import type { Session } from "./types.ts";

export interface SessionRepairPlanInput {
  readonly sessions: readonly Session[];
}

export interface SessionRepairPlan {
  readonly checked: number;
  readonly resume: Session[];
  readonly reconnectKeys: string[];
}

export interface SessionRepairSummaryInput {
  readonly checked: number;
  readonly resumed: number;
  readonly reconnected: number;
  readonly failed: number;
}

export interface SessionRepairActionResult extends SessionRepairSummaryInput {
  readonly resumeKeys: string[];
  readonly reconnectKeys: string[];
  readonly failures: SessionRepairFailure[];
}

export interface SessionRepairFailure {
  readonly sessionKey: string;
  readonly label: string;
  readonly operation: "resume";
  readonly message: string;
}

export interface ExecuteSessionRepairsInput extends SessionRepairPlanInput {
  readonly resumeSession: (session: Session) => Promise<{ ok: boolean; error?: string }>;
}

export interface ExecuteSessionRepairPlanInput {
  readonly plan: SessionRepairPlan;
  readonly resumeSession: (session: Session) => Promise<{ ok: boolean; error?: string }>;
}

// The plan covers every listed session, not just the ones holding a layout slot
// or reporting a closed pane. Overview pagination and filters mount a different set of panes than the slot array, and a pane wedged
// in "connecting" — or still reporting "open" over a socket the daemon dropped —
// is exactly the one that needs reconnecting. Sessions with no mounted pane
// absorb their token bump harmlessly and reconnect when they are paged back in.
export function planSessionRepairs({ sessions }: SessionRepairPlanInput): SessionRepairPlan {
  const resumeByKey = new Map<string, Session>();
  const reconnectKeys = new Set<string>();

  for (const session of sessions) {
    const key = sessionKey(session);
    if (isSessionResumeAvailable(session)) {
      resumeByKey.set(key, resumeByKey.get(key) ?? session);
      continue;
    }
    if (session.status === "running") {
      reconnectKeys.add(key);
    }
  }

  return {
    checked: sessions.length,
    resume: [...resumeByKey.values()],
    reconnectKeys: [...reconnectKeys].filter((key) => !resumeByKey.has(key)),
  };
}

export function sessionRepairPlanHasWork(plan: SessionRepairPlan): boolean {
  return plan.resume.length > 0 || plan.reconnectKeys.length > 0;
}

export function incrementReconnectTokens(
  current: Readonly<Record<string, number>>,
  reconnectKeys: readonly string[],
): Record<string, number> {
  if (reconnectKeys.length === 0) {
    return current;
  }
  const next = { ...current };
  for (const key of reconnectKeys) {
    next[key] = (next[key] ?? 0) + 1;
  }
  return next;
}

export function applySessionRepairResult(
  sessions: readonly Session[],
  result: SessionRepairActionResult,
): Session[] {
  if (result.resumed === 0) {
    return [...sessions];
  }
  const resumedKeys = new Set(result.resumeKeys);
  return sessions.map((session) =>
    resumedKeys.has(sessionKey(session)) ? { ...session, status: "running", resumable: false } : session,
  );
}

export async function executeSessionRepairPlan({
  plan,
  resumeSession,
}: ExecuteSessionRepairPlanInput): Promise<SessionRepairActionResult> {
  let resumed = 0;
  let failed = 0;
  const failures: SessionRepairFailure[] = [];
  const resumeKeys: string[] = [];

  for (const session of plan.resume) {
    const result = await resumeSession(session).catch((err: unknown) => ({
      ok: false,
      error: (err as Error).message,
    }));
    if (result.ok) {
      resumed += 1;
      resumeKeys.push(sessionKey(session));
    } else {
      failed += 1;
      failures.push({
        sessionKey: sessionKey(session),
        label: sessionLabel(session),
        operation: "resume",
        message: result.error ?? "resume failed",
      });
    }
  }

  return {
    checked: plan.checked,
    resumed,
    reconnected: plan.reconnectKeys.length,
    reconnectKeys: plan.reconnectKeys,
    resumeKeys,
    failed,
    failures,
  };
}

export async function executeSessionRepairs({
  resumeSession,
  ...input
}: ExecuteSessionRepairsInput): Promise<SessionRepairActionResult> {
  return executeSessionRepairPlan({ plan: planSessionRepairs(input), resumeSession });
}

export function sessionRepairSummary({
  checked,
  resumed,
  reconnected,
  failed,
}: SessionRepairSummaryInput): string {
  const parts = [`Checked ${checked} ${checked === 1 ? "session" : "sessions"}`];
  if (resumed === 0 && reconnected === 0 && failed === 0) {
    parts.push("nothing to repair");
  } else {
    if (resumed > 0) {
      parts.push(`resumed ${resumed}`);
    }
    if (reconnected > 0) {
      parts.push(`reconnected ${reconnected}`);
    }
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
  }
  return `${parts.join("; ")}.`;
}
