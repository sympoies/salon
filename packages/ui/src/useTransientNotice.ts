import { useCallback, useEffect, useState } from "react";
import { defaultScheduler, type TimeoutScheduler } from "./scheduler.ts";
import type { StatusNotice } from "./statusNoticeModel.ts";
import { TRANSIENT_NOTICE_MS } from "./transientNotice.ts";

/**
 * The short-lived result shown in the shared status layer. Its display time starts when it is on screen: while
 * another status notice is showing (`blocked`), a result is held, so it is never lost behind that notice. A newer
 * result replaces a held or showing one and restarts the time.
 */
export function useTransientNotice<Timer = ReturnType<typeof globalThis.setTimeout>>(
  blocked: boolean,
  scheduler: TimeoutScheduler<Timer> = defaultScheduler as unknown as TimeoutScheduler<Timer>,
  ttlMs: number = TRANSIENT_NOTICE_MS,
): { readonly notice: StatusNotice | null; readonly show: (notice: StatusNotice) => void; readonly clear: () => void } {
  const [notice, setNotice] = useState<StatusNotice | null>(null);
  useEffect(() => {
    if (notice === null || blocked) return;
    const timer = scheduler.setTimeout(() => setNotice((current) => current === notice ? null : current), ttlMs);
    return () => scheduler.clearTimeout(timer);
  }, [notice, blocked, scheduler, ttlMs]);
  const show = useCallback((next: StatusNotice) => setNotice(next), []);
  const clear = useCallback(() => setNotice(null), []);
  return { notice, show, clear };
}
