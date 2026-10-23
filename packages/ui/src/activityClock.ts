export interface ActivityObservationAnchor {
  readonly daemonObservedAt: string;
  readonly daemonObservedAtMs: number;
  readonly clientReceivedMonotonicMs: number;
}

export interface CreateActivityObservationAnchorInput {
  readonly daemonObservedAt: string;
  readonly clientReceivedMonotonicMs: number;
}

export function createActivityObservationAnchor(
  input: CreateActivityObservationAnchorInput,
): ActivityObservationAnchor | null {
  const daemonObservedAtMs = Date.parse(input.daemonObservedAt);
  if (!Number.isFinite(daemonObservedAtMs) || !Number.isFinite(input.clientReceivedMonotonicMs)) return null;
  return {
    daemonObservedAt: input.daemonObservedAt,
    daemonObservedAtMs,
    clientReceivedMonotonicMs: input.clientReceivedMonotonicMs,
  };
}

export function activityObservationAgeMs(
  anchor: ActivityObservationAnchor,
  currentMonotonicMs: number,
): number {
  if (!Number.isFinite(currentMonotonicMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, currentMonotonicMs - anchor.clientReceivedMonotonicMs);
}

export function activitySemanticNowMs(
  anchor: ActivityObservationAnchor,
  currentMonotonicMs: number,
): number {
  return anchor.daemonObservedAtMs + activityObservationAgeMs(anchor, currentMonotonicMs);
}

export function isActivityObservationStale(
  anchor: ActivityObservationAnchor,
  currentMonotonicMs: number,
  staleAfterMs: number,
): boolean {
  return activityObservationAgeMs(anchor, currentMonotonicMs) >= staleAfterMs;
}
