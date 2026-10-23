import type { AgentLaunchProfileSummary, MachineStatus } from "@agent-console/shared/api";
import { describeUnreachable } from "./format.ts";
import { activitySemanticNowMs, createActivityObservationAnchor } from "./activityClock.ts";
import {
  DASHBOARD_UNAVAILABLE_SINCE,
  DASHBOARD_ACTIVITY_OBSERVATION,
  type DashboardActivityObservation,
  type DashboardSession,
  type SessionsResponse,
} from "./types.ts";

interface CurrentRef<T> {
  current: T;
}

interface ApplySessionListTargets {
  readonly sessionsRef: CurrentRef<DashboardSession[]>;
  readonly reachableMachineNamesRef: CurrentRef<ReadonlySet<string>>;
  readonly knownMachineNamesRef: CurrentRef<ReadonlySet<string>>;
  readonly setSessions: (sessions: DashboardSession[]) => void;
  readonly setReachableMachineNames: (machines: ReadonlySet<string>) => void;
  readonly setError: (message: string | null) => void;
}

export interface AppliedSessionListResult {
  readonly sessions: DashboardSession[];
  readonly reachableMachineNames: ReadonlySet<string>;
  readonly knownMachineNames: ReadonlySet<string>;
  readonly error: string | null;
}

function machineNamesFromStatus(machines: readonly Pick<MachineStatus, "name">[]): Set<string> {
  return new Set(machines.map((machine) => machine.name));
}

function turnRevision(session: DashboardSession): number | null {
  const value = session.turn_state?.revision;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function sameRuntime(left: DashboardSession, right: DashboardSession): boolean {
  return typeof left.runtime_started_at === "string" &&
    left.runtime_started_at.length > 0 &&
    left.runtime_started_at === right.runtime_started_at;
}

function sameLastPromptRuntime(left: DashboardSession, right: DashboardSession): boolean {
  if (
    typeof left.last_prompt_continuity !== "string"
    || left.last_prompt_continuity.length === 0
    || left.last_prompt_continuity !== right.last_prompt_continuity
  ) {
    return false;
  }
  const leftIncarnation = typeof left.session_incarnation === "string" && left.session_incarnation.length > 0
    ? left.session_incarnation
    : undefined;
  const rightIncarnation = typeof right.session_incarnation === "string" && right.session_incarnation.length > 0
    ? right.session_incarnation
    : undefined;
  if (leftIncarnation !== undefined && rightIncarnation !== undefined) {
    return leftIncarnation === rightIncarnation;
  }
  return sameRuntime(left, right);
}

interface OrderedObservation {
  readonly milliseconds: number;
  readonly submillisecondNanoseconds: number;
}

function orderedObservationValue(value: string | undefined): OrderedObservation | null {
  if (!value) return null;
  const match = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const milliseconds = Date.parse(value);
  if (!match || !Number.isFinite(milliseconds)) return null;
  const fractionalNanoseconds = Number((match[1] ?? "").padEnd(9, "0"));
  return { milliseconds, submillisecondNanoseconds: fractionalNanoseconds % 1_000_000 };
}

function orderedObservation(session: DashboardSession): OrderedObservation | null {
  return orderedObservationValue(
    dashboardActivityObservation(session)?.daemonObservedAt ?? session.activity_observed_at,
  );
}

function observationIsOlder(incoming: OrderedObservation, previous: OrderedObservation): boolean {
  return incoming.milliseconds < previous.milliseconds ||
    (incoming.milliseconds === previous.milliseconds &&
      incoming.submillisecondNanoseconds < previous.submillisecondNanoseconds);
}

export interface AgentProfilesByMachineResult {
  readonly profiles: Readonly<Record<string, readonly AgentLaunchProfileSummary[]>>;
  readonly observations: ReadonlyMap<string, string>;
}

export function reconcileAgentProfilesByMachine(
  current: Readonly<Record<string, readonly AgentLaunchProfileSummary[]>>,
  previousObservations: ReadonlyMap<string, string>,
  machines: readonly MachineStatus[],
): AgentProfilesByMachineResult {
  const profiles: Record<string, readonly AgentLaunchProfileSummary[]> = {};
  const observations = new Map<string, string>();
  for (const machine of machines) {
    const previousValue = previousObservations.get(machine.name);
    const incoming = orderedObservationValue(machine.observed_at);
    const previous = orderedObservationValue(previousValue);
    if (incoming && previous && observationIsOlder(incoming, previous)) {
      const retained = current[machine.name];
      if (retained) profiles[machine.name] = retained;
      if (previousValue) observations.set(machine.name, previousValue);
      continue;
    }
    if (machine.observed_at && incoming) observations.set(machine.name, machine.observed_at);
    else if (previousValue) observations.set(machine.name, previousValue);
    if (machine.ok && machine.agent_profiles) profiles[machine.name] = machine.agent_profiles;
  }
  return { profiles, observations };
}

export function dashboardUnavailableSince(session: DashboardSession): string | undefined {
  return session[DASHBOARD_UNAVAILABLE_SINCE];
}

export function dashboardActivityObservation(session: DashboardSession): DashboardActivityObservation | undefined {
  return session[DASHBOARD_ACTIVITY_OBSERVATION];
}

export function withDashboardActivityObservation(
  session: DashboardSession,
  observation: DashboardActivityObservation,
): DashboardSession {
  return { ...session, [DASHBOARD_ACTIVITY_OBSERVATION]: observation };
}

function freezeActivityObservation(
  session: DashboardSession,
  currentMonotonicMs: number,
): DashboardActivityObservation | undefined {
  const observation = dashboardActivityObservation(session);
  if (!observation || observation.frozenSemanticNowMs !== undefined) return observation;
  const anchor = createActivityObservationAnchor({
    daemonObservedAt: observation.daemonObservedAt,
    clientReceivedMonotonicMs: observation.receivedMonotonicMs,
  });
  if (!anchor) return observation;
  return {
    ...observation,
    frozenSemanticNowMs: activitySemanticNowMs(anchor, currentMonotonicMs),
  };
}

// A rejected session-list request never reached a machine: the console server
// did not answer. Sessions on every enabled machine become unavailable, but the
// banner names the server once instead of blaming each machine.
export function retainKnownInactiveMachines(
  machines: readonly MachineStatus[], previous: ReadonlyMap<string, MachineStatus>,
): MachineStatus[] {
  return machines.map(machine => previous.get(machine.name)?.active === false ? { ...machine, active: false } : machine);
}

export function unavailableSessionList(
  machines: readonly string[], reason?: string, previous: ReadonlyMap<string, MachineStatus> = new Map(),
): SessionsResponse {
  const error = reason ? `Console server is unreachable: ${reason}` : "Console server is unreachable";
  return {
    ok: false,
    sessions: [],
    machines: retainKnownInactiveMachines(machines.map(name => ({ name, ok: false, error: reason ?? error })), previous),
    error,
  };
}

export function applySessionListResult(
  result: SessionsResponse,
  targets: ApplySessionListTargets,
  nowMs = Date.now(),
  receivedMonotonicMs = performance.now(),
): AppliedSessionListResult {
  const activeMachines = result.machines.filter(machine => machine.active !== false);
  const inactiveMachineNames = new Set(result.machines.filter(machine => machine.active === false).map(machine => machine.name));
  const reachableMachineNames = new Set(activeMachines.filter((machine) => machine.ok).map((machine) => machine.name));
  const unavailableMachineNames = new Set(
    activeMachines.filter((machine) => !machine.ok).map((machine) => machine.name),
  );
  if (!result.ok && result.machines.length === 0) {
    for (const machine of targets.knownMachineNamesRef.current) unavailableMachineNames.add(machine);
    for (const session of targets.sessionsRef.current) unavailableMachineNames.add(session.machine);
  }
  const knownMachineNames = machineNamesFromStatus(result.machines);
  for (const machine of unavailableMachineNames) knownMachineNames.add(machine);
  const error = result.error
    ?? describeUnreachable(activeMachines)
    ?? (!result.ok ? "Session list unavailable" : null);
  const previousByMachine = new Map<string, DashboardSession[]>();
  const previousByKey = new Map<string, DashboardSession>();
  for (const session of targets.sessionsRef.current) {
    const existing = previousByMachine.get(session.machine) ?? [];
    existing.push(session);
    previousByMachine.set(session.machine, existing);
    previousByKey.set(`${session.machine}\u0000${session.id}`, session);
  }
  const sessions: DashboardSession[] = result.sessions
    .filter(session => !inactiveMachineNames.has(session.machine))
    .filter((session) => !unavailableMachineNames.has(session.machine) || !previousByMachine.has(session.machine))
    .map((session) => {
      const previous = previousByKey.get(`${session.machine}\u0000${session.id}`);
      const incomingObservation = orderedObservation(session);
      const previousObservation = previous ? orderedObservation(previous) : null;
      if (
        previous !== undefined &&
        incomingObservation !== null && previousObservation !== null &&
        observationIsOlder(incomingObservation, previousObservation)
      ) {
        return previous;
      }
      const promptReconciled = previous !== undefined &&
        session.last_prompt_state === "pending" &&
        previous.last_prompt !== undefined &&
        sameLastPromptRuntime(previous, session)
        ? { ...session, last_prompt: previous.last_prompt }
        : session;
      const incomingRevision = turnRevision(promptReconciled);
      const previousRevision = previous ? turnRevision(previous) : null;
      const preserveStreamedActivity = previous !== undefined &&
        sameRuntime(previous, promptReconciled) &&
        previousRevision !== null && incomingRevision !== null &&
        previousRevision > incomingRevision;
      const merged = preserveStreamedActivity
        ? { ...promptReconciled, turn_state: previous.turn_state }
        : promptReconciled;
      if (preserveStreamedActivity) {
        const previousObservation = dashboardActivityObservation(previous);
        return previousObservation
          ? withDashboardActivityObservation(merged, previousObservation)
          : merged;
      }
      return merged.activity_observed_at
        ? withDashboardActivityObservation(merged, {
          daemonObservedAt: merged.activity_observed_at,
          receivedMonotonicMs,
          transport: "poll",
        })
        : merged;
    });
  for (const machine of unavailableMachineNames) {
    const previous = previousByMachine.get(machine);
    if (!previous) continue;
    for (const session of previous) {
      const observation = freezeActivityObservation(session, receivedMonotonicMs);
      sessions.push({
        ...session,
        ...(observation ? { [DASHBOARD_ACTIVITY_OBSERVATION]: observation } : {}),
        [DASHBOARD_UNAVAILABLE_SINCE]:
          dashboardUnavailableSince(session) ?? new Date(nowMs).toISOString(),
      });
    }
  }

  targets.sessionsRef.current = sessions;
  targets.reachableMachineNamesRef.current = reachableMachineNames;
  if (knownMachineNames.size > 0) {
    targets.knownMachineNamesRef.current = knownMachineNames;
  }
  targets.setSessions(sessions);
  targets.setReachableMachineNames(reachableMachineNames);
  targets.setError(error);

  return {
    sessions,
    reachableMachineNames,
    knownMachineNames,
    error,
  };
}
