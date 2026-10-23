import { RequestCapacityError, withRequestDeadline } from "./requestDeadline.ts";

interface Pending<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  waiters: number;
}

interface KeyState<T> {
  active: Pending<T> | null;
  recovery: Pending<T> | null;
  useRecoveryLane: boolean;
  readonly unresolved: Set<Pending<T>>;
}

// Two normal poll attempts plus one reserved recovery attempt are the maximum
// unresolved native requests per key, even if cancellation is ignored.
export function createBoundedSingleFlight<K, T>(request: (key: K, signal: AbortSignal) => Promise<T>) {
  const states = new Map<K, KeyState<T>>();
  const run = async (key: K, timeoutMs: number, signal?: AbortSignal, recovery = false): Promise<T> => {
    signal?.throwIfAborted();
    let state = states.get(key);
    if (!state) {
      state = { active: null, recovery: null, useRecoveryLane: false, unresolved: new Set() };
      states.set(key, state);
    }
    const useRecovery = recovery || state.useRecoveryLane;
    let pending = useRecovery ? state.recovery : state.active;
    const replacing = pending?.controller.signal.aborted === true;
    const normalUnresolved = state.unresolved.size - (state.recovery ? 1 : 0);
    if ((!pending || (replacing && (!useRecovery || recovery))) &&
      (useRecovery ? state.unresolved.size < 3 : normalUnresolved < 2)) {
      const controller = new AbortController();
      pending = { controller, promise: request(key, controller.signal), waiters: 0 };
      if (useRecovery) state.recovery = pending;
      else state.active = pending;
      state.unresolved.add(pending);
      const captured = pending;
      const capturedState = state;
      const clear = () => {
        capturedState.unresolved.delete(captured);
        if (capturedState.active === captured) capturedState.active = null;
        if (capturedState.recovery === captured) capturedState.recovery = null;
        if (capturedState.unresolved.size === 0 && states.get(key) === capturedState) states.delete(key);
      };
      void pending.promise.then(clear, clear);
    }
    // A recovery slot remains occupied after timeout until its physical request settles.
    if (!pending || pending.controller.signal.aborted) {
      throw new RequestCapacityError("Native session requests are stalled; restart the app if this persists");
    }
    pending.waiters += 1;
    let completed = false;
    try {
      const result = await withRequestDeadline(() => pending.promise, timeoutMs, signal);
      completed = true;
      if (recovery) state.useRecoveryLane = true;
      return result;
    } finally {
      pending.waiters -= 1;
      if (pending.waiters === 0 && !completed) {
        pending.controller.abort();
      }
    }
  };
  const read = (key: K, timeoutMs: number, signal?: AbortSignal) => run(key, timeoutMs, signal);
  return Object.assign(read, {
    recover: (key: K, timeoutMs: number, signal?: AbortSignal) => run(key, timeoutMs, signal, true),
    reset() {
      for (const state of states.values()) {
        state.active?.controller.abort();
        if (state.useRecoveryLane) state.recovery?.controller.abort();
      }
    },
  });
}
