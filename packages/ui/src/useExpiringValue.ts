import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultScheduler, type TimeoutScheduler, type TimerHandle } from "./scheduler.ts";

export interface ExpiringValue<T> {
  readonly value: T | null;
  readonly set: (value: T | null) => void;
  readonly show: (value: T) => void;
  readonly clear: () => void;
}

export function useExpiringValue<T, Timer = TimerHandle>(
  ttlMs: number,
  scheduler: TimeoutScheduler<Timer> = defaultScheduler as unknown as TimeoutScheduler<Timer>,
): ExpiringValue<T> {
  const [value, setValue] = useState<T | null>(null);
  const timerRef = useRef<Timer | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      scheduler.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [scheduler]);

  const set = useCallback((next: T | null) => {
    clearTimer();
    setValue(next);
  }, [clearTimer]);

  const clear = useCallback(() => {
    set(null);
  }, [set]);

  const show = useCallback((next: T) => {
    clearTimer();
    setValue(next);
    timerRef.current = scheduler.setTimeout(() => {
      timerRef.current = null;
      setValue(null);
    }, ttlMs);
  }, [clearTimer, scheduler, ttlMs]);

  useEffect(() => clearTimer, [clearTimer]);

  return useMemo(() => ({ value, set, show, clear }), [clear, set, show, value]);
}
