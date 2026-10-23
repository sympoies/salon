import { defaultScheduler, type TimeoutScheduler, type TimerHandle as DefaultTimerHandle } from "./scheduler.ts";

export interface TurnTitleIdleScheduler<T> {
  set(key: string, value: T): void;
  bump(key: string): void;
  take(key: string): T | undefined;
  dispose(): void;
}

interface PendingIdle<T, Timer> {
  value: T;
  idleUntil: number;
  timer: Timer | null;
}

interface TurnTitleIdleSchedulerOptions<T, Timer> extends Partial<TimeoutScheduler<Timer>> {
  readonly idleMs: number;
  readonly run: (key: string, value: T) => void;
  readonly now?: () => number;
}

export function createTurnTitleIdleScheduler<T, Timer = DefaultTimerHandle>(
  options: TurnTitleIdleSchedulerOptions<T, Timer>,
): TurnTitleIdleScheduler<T> {
  const pending: Record<string, PendingIdle<T, Timer>> = {};
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeout ?? (defaultScheduler.setTimeout as TimeoutScheduler<Timer>["setTimeout"]);
  const clearTimer = options.clearTimeout ?? (defaultScheduler.clearTimeout as TimeoutScheduler<Timer>["clearTimeout"]);

  const schedule = (key: string, entry: PendingIdle<T, Timer>) => {
    entry.idleUntil = now() + options.idleMs;
    if (entry.timer) {
      return;
    }
    const checkIdle = () => {
      const current = pending[key];
      if (!current) {
        return;
      }
      const remainingMs = current.idleUntil - now();
      if (remainingMs > 0) {
        current.timer = setTimer(checkIdle, remainingMs);
        return;
      }
      current.timer = null;
      delete pending[key];
      options.run(key, current.value);
    };
    entry.timer = setTimer(checkIdle, options.idleMs);
  };

  return {
    set(key, value) {
      const entry = pending[key] ?? { value, idleUntil: 0, timer: null };
      entry.value = value;
      pending[key] = entry;
      schedule(key, entry);
    },
    bump(key) {
      const entry = pending[key];
      if (entry) {
        schedule(key, entry);
      }
    },
    take(key) {
      const entry = pending[key];
      if (!entry) {
        return undefined;
      }
      if (entry.timer) {
        clearTimer(entry.timer);
      }
      delete pending[key];
      return entry.value;
    },
    dispose() {
      for (const [key, entry] of Object.entries(pending)) {
        if (entry.timer) {
          clearTimer(entry.timer);
        }
        delete pending[key];
      }
    },
  };
}
