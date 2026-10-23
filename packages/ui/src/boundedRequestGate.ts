import { RequestCapacityError, withRequestDeadline } from "./requestDeadline.ts";

interface Pending<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
}

interface GateState<T> {
  readonly normal: Set<Pending<T>>;
  readonly unresolved: Set<Pending<T>>;
  recovery: Pending<T> | null;
  promoted: boolean;
}

// Never share a one-time ticket. Two normal requests and one recovery slot are
// the fixed maximum if native HTTP ignores abort; settled requests free slots.
export function createBoundedRequestGate<K, T>(request: (key: K, signal: AbortSignal) => Promise<T>) {
  const states = new Map<K, GateState<T>>();
  return async (key: K, timeoutMs: number, recovery = false): Promise<T> => {
    let state = states.get(key);
    if (!state) {
      state = { normal: new Set(), unresolved: new Set(), recovery: null, promoted: false };
      states.set(key, state);
    }
    const useRecovery = recovery || state.promoted;
    if (recovery && state.recovery) state.recovery.controller.abort();
    if (useRecovery ? (state.recovery !== null && !recovery) || state.unresolved.size >= 3
      : state.normal.size >= 2) {
      throw new RequestCapacityError("Native attach requests are stalled; restart the app if this persists");
    }
    const controller = new AbortController();
    const pending = { controller, promise: request(key, controller.signal) };
    state.unresolved.add(pending);
    if (useRecovery) state.recovery = pending;
    else state.normal.add(pending);
    const capturedState = state;
    const clear = () => {
      capturedState.normal.delete(pending);
      capturedState.unresolved.delete(pending);
      if (capturedState.recovery === pending) capturedState.recovery = null;
      if (capturedState.unresolved.size === 0 && states.get(key) === capturedState) {
        states.delete(key);
      }
    };
    void pending.promise.then(clear, clear);
    let completed = false;
    try {
      const result = await withRequestDeadline(() => pending.promise, timeoutMs);
      completed = true;
      if (recovery) state.promoted = true;
      return result;
    } finally {
      if (!completed) controller.abort();
    }
  };
}
