import { useCallback, useEffect, useMemo, useState } from "react";
import { defaultScheduler, type TimeoutScheduler } from "./scheduler.ts";

export interface VisibleExpiringValue<T> {
  readonly value: T | null;
  /** Sets a value that stays until it is replaced or cleared (null clears). */
  readonly set: (value: T | null) => void;
  /** Shows a value for `ttlMs` of visible time; a newer value replaces it and restarts the time. */
  readonly show: (value: T) => void;
  readonly clear: () => void;
}

interface Held<T> {
  readonly value: T;
  readonly expires: boolean;
}

/**
 * Like `useExpiringValue`, but the time runs only while the value can be seen. While `blocked` is true (another
 * notice is on screen) a shown value is held and its timer is not started, so a short-lived result is never lost
 * behind another notice. A value set without expiry stays until replaced or cleared.
 */
export function useVisibleExpiringValue<T, Timer = ReturnType<typeof globalThis.setTimeout>>(
  blocked: boolean,
  ttlMs: number,
  scheduler: TimeoutScheduler<Timer> = defaultScheduler as unknown as TimeoutScheduler<Timer>,
): VisibleExpiringValue<T> {
  const [held, setHeld] = useState<Held<T> | null>(null);
  useEffect(() => {
    if (held === null || !held.expires || blocked) return;
    const timer = scheduler.setTimeout(() => setHeld((current) => current === held ? null : current), ttlMs);
    return () => scheduler.clearTimeout(timer);
  }, [held, blocked, scheduler, ttlMs]);
  const set = useCallback((next: T | null) => setHeld(next === null ? null : { value: next, expires: false }), []);
  const show = useCallback((next: T) => setHeld({ value: next, expires: true }), []);
  const clear = useCallback(() => setHeld(null), []);
  const value = held === null ? null : held.value;
  return useMemo(() => ({ value, set, show, clear }), [value, set, show, clear]);
}
