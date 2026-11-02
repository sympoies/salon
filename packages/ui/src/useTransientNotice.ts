import type { TimeoutScheduler } from "./scheduler.ts";
import type { StatusNotice } from "./statusNoticeModel.ts";
import { TRANSIENT_NOTICE_MS } from "./transientNotice.ts";
import { useVisibleExpiringValue } from "./useVisibleExpiringValue.ts";

/**
 * The short-lived result shown in the shared status layer. Its display time starts when it is on screen: while
 * another status notice is showing (`blocked`), a result is held, so it is never lost behind that notice. A newer
 * result replaces a held or showing one and restarts the time.
 */
export function useTransientNotice<Timer = ReturnType<typeof globalThis.setTimeout>>(
  blocked: boolean,
  scheduler?: TimeoutScheduler<Timer>,
  ttlMs: number = TRANSIENT_NOTICE_MS,
): { readonly notice: StatusNotice | null; readonly show: (notice: StatusNotice) => void; readonly clear: () => void } {
  const { value, show, clear } = useVisibleExpiringValue<StatusNotice, Timer>(blocked, ttlMs, scheduler);
  return { notice: value, show, clear };
}
