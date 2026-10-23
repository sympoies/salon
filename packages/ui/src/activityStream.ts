import { runSseStream } from "./sseStream.ts";
import {
  ActivityFeedSseDecoder,
  type ActivityFeedEvent,
  type ActivityStreamEvent,
} from "@agent-console/shared/activity";
import { appFetch } from "./runtime.ts";
import {
  withDashboardActivityObservation,
} from "./dashboardSessions.ts";
import type { DashboardSession, TurnState } from "./types.ts";

interface ActivityStreamCursor {
  readonly streamId: string;
  readonly sequence: number;
}

export type ActivityStreamCursorState = ReadonlyMap<string, ActivityStreamCursor>;
type ActivityStreamDecision = "applied" | "duplicate" | "disabled";
export type ActivityDeliveryState = "polling" | "realtime" | "reconnecting";
export type ActivityDeliveryByMachine = ReadonlyMap<string, ActivityDeliveryState>;

export interface ApplyActivityStreamEventInput {
  readonly cursors: ActivityStreamCursorState;
  readonly enabledMachines: readonly string[];
  readonly sessions: readonly DashboardSession[];
  readonly event: ActivityStreamEvent;
  readonly receivedMonotonicMs: number;
}

export interface ApplyActivityStreamEventResult {
  readonly cursors: ActivityStreamCursorState;
  readonly sessions: DashboardSession[];
  readonly decision: ActivityStreamDecision;
  readonly needsReconcile: boolean;
}

export function createActivityStreamCursorState(): ActivityStreamCursorState {
  return new Map();
}

export function createActivityDeliveryState(machines: readonly string[]): ActivityDeliveryByMachine {
  return new Map(machines.map((machine) => [machine, "polling"] as const));
}

export function activityDeliveryAfterConnection(
  current: ActivityDeliveryByMachine,
  connection: ActivityStreamConnectionState,
): ActivityDeliveryByMachine {
  if (connection !== "reconnecting") return current;
  let changed = false;
  const next = new Map(current);
  for (const [machine, delivery] of current) {
    if (delivery === "realtime") {
      next.set(machine, "reconnecting");
      changed = true;
    }
  }
  return changed ? next : current;
}

export function activityDeliveryAfterEvent(
  current: ActivityDeliveryByMachine,
  machine: string,
): ActivityDeliveryByMachine {
  if (!current.has(machine) || current.get(machine) === "realtime") return current;
  const next = new Map(current);
  next.set(machine, "realtime");
  return next;
}

export function activityDeliveryAfterFeedEvent(
  current: ActivityDeliveryByMachine,
  event: ActivityFeedEvent,
): ActivityDeliveryByMachine {
  if (!current.has(event.machine)) return current;
  if (event.type !== "delivery") return activityDeliveryAfterEvent(current, event.machine);
  if (current.get(event.machine) === event.state) return current;
  const next = new Map(current);
  next.set(event.machine, event.state);
  return next;
}

export interface ActivityReconcileGeneration {
  reconcile(): void;
}

export function createActivityReconcileGeneration(
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<void>,
): ActivityReconcileGeneration {
  let pending: Promise<void> | null = null;
  let dirty = false;
  const start = () => {
    if (signal.aborted) {
      dirty = false;
      return;
    }
    const task = Promise.resolve().then(() => run(signal));
    pending = task;
    const complete = () => {
      if (pending !== task) return;
      pending = null;
      if (signal.aborted) {
        dirty = false;
        return;
      }
      if (!dirty) return;
      dirty = false;
      start();
    };
    void task.then(complete, complete);
  };
  return {
    reconcile() {
      if (signal.aborted) return;
      if (pending !== null) {
        dirty = true;
        return;
      }
      start();
    },
  };
}

function revision(state: TurnState | null | undefined): number | null {
  return Number.isSafeInteger(state?.revision) && Number(state?.revision) >= 0 ? Number(state?.revision) : null;
}

export function applyActivityStreamEvent(
  input: ApplyActivityStreamEventInput,
): ApplyActivityStreamEventResult {
  if (!input.enabledMachines.includes(input.event.machine)) {
    return {
      cursors: input.cursors,
      sessions: input.sessions as DashboardSession[],
      decision: "disabled",
      needsReconcile: false,
    };
  }

  const previousCursor = input.cursors.get(input.event.machine);
  if (
    input.event.type !== "reset" &&
    previousCursor?.streamId === input.event.stream_id &&
    input.event.sequence <= previousCursor.sequence
  ) {
    return {
      cursors: input.cursors,
      sessions: input.sessions as DashboardSession[],
      decision: "duplicate",
      needsReconcile: false,
    };
  }

  const streamChanged = previousCursor !== undefined && previousCursor.streamId !== input.event.stream_id;
  const sequenceGap = previousCursor?.streamId === input.event.stream_id &&
    input.event.sequence > previousCursor.sequence + 1;
  const cursors = new Map(input.cursors);
  cursors.set(input.event.machine, { streamId: input.event.stream_id, sequence: input.event.sequence });
  if (input.event.type === "reset" && input.event.reason === "oversized_snapshot") {
    return {
      cursors,
      sessions: input.sessions as DashboardSession[],
      decision: "applied",
      needsReconcile: true,
    };
  }
  const projectionById = input.event.type === "heartbeat"
    ? null
    : new Map(input.event.sessions.map((session) => [session.id, session] as const));
  const currentMachineIds = new Set(
    input.sessions.filter((session) => session.machine === input.event.machine).map((session) => session.id),
  );
  let unknownProjection = false;
  let regressedRevision = false;
  if (projectionById) {
    for (const id of projectionById.keys()) {
      if (!currentMachineIds.has(id)) unknownProjection = true;
    }
  }

  const sessions = input.sessions.map((session): DashboardSession => {
    if (session.machine !== input.event.machine) return session;
    let next = session;
    if (projectionById) {
      const projection = projectionById.get(session.id);
      if (projection) {
        const incomingRevision = revision(projection.turn_state);
        const currentRevision = revision(session.turn_state);
        if (
          input.event.type !== "reset" &&
          incomingRevision !== null && currentRevision !== null &&
          incomingRevision < currentRevision
        ) {
          regressedRevision = true;
        } else {
          next = { ...session, turn_state: projection.turn_state };
        }
      }
    }
    return withDashboardActivityObservation(next, {
      daemonObservedAt: input.event.observed_at,
      receivedMonotonicMs: input.receivedMonotonicMs,
      transport: "stream",
    });
  });
  const missingProjection = projectionById !== null &&
    [...currentMachineIds].some((id) => !projectionById.has(id));

  return {
    cursors,
    sessions,
    decision: "applied",
    needsReconcile:
      input.event.type === "reset" || streamChanged || sequenceGap ||
      (previousCursor === undefined && input.event.type === "heartbeat") ||
      unknownProjection || missingProjection || regressedRevision,
  };
}

export type ActivityStreamConnectionState = "disabled" | "connecting" | "connected" | "reconnecting";

export interface RunActivityStreamOptions {
  readonly machines: readonly string[];
  readonly signal: AbortSignal;
  readonly onEvent: (event: ActivityFeedEvent) => void;
  readonly onState: (state: ActivityStreamConnectionState) => void;
  readonly fetchImpl?: typeof appFetch;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export async function runActivityStream(options: RunActivityStreamOptions): Promise<void> {
  if (options.machines.length === 0) { options.onState("disabled"); return; }
  const query = options.machines.map(encodeURIComponent).join(",");
  return runSseStream({ ...options, path: `/api/activity/events?machines=${query}`,
    createDecoder: () => new ActivityFeedSseDecoder() });
}
