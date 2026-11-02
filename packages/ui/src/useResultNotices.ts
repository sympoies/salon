import { useCallback } from "react";
import type { TimeoutScheduler } from "./scheduler.ts";
import { resultStatusNotice, type RetitleFeedbackState, type StatusNotice } from "./statusNoticeModel.ts";
import { TRANSIENT_NOTICE_MS } from "./transientNotice.ts";
import { useTransientNotice } from "./useTransientNotice.ts";
import { useVisibleExpiringValue } from "./useVisibleExpiringValue.ts";

export interface RetitleResult {
  readonly key: string;
  readonly state: RetitleFeedbackState;
  readonly detail?: string;
}

export interface ShortcutResult {
  readonly key: string;
  readonly text: string;
}

/** How long a retitle result and the shortcut hint stay once they are on screen. */
export const RETITLE_RESULT_MS = 2_600;
export const SHORTCUT_HINT_MS = 2_200;

/**
 * Every short-lived result of the shared status layer: the announced result (session refresh), the retitle
 * progress and result, and the shortcut hint. Each result's display time starts only once it is the notice on
 * screen (#262): while another status notice shows, or a higher result does, it is held instead of expiring
 * unseen. A retitle still in progress (set without expiry) stays until its result replaces it.
 */
export function useResultNotices<Timer = ReturnType<typeof globalThis.setTimeout>>(
  statusNoticeShowing: boolean,
  isLive: (key: string) => boolean,
  scheduler?: TimeoutScheduler<Timer>,
): {
  readonly resultNotice: StatusNotice | null;
  readonly showTransient: (notice: StatusNotice) => void;
  readonly retitleFeedback: RetitleResult | null;
  readonly setRetitleFeedback: (value: RetitleResult | null) => void;
  readonly showRetitleFeedback: (value: RetitleResult) => void;
  readonly showShortcutFeedback: (value: ShortcutResult) => void;
  readonly dismissResults: () => void;
} {
  const transient = useTransientNotice<Timer>(statusNoticeShowing, scheduler, TRANSIENT_NOTICE_MS);
  const blocked = statusNoticeShowing || transient.notice !== null;
  const retitle = useVisibleExpiringValue<RetitleResult, Timer>(blocked, RETITLE_RESULT_MS, scheduler);
  const retitleShowing = retitle.value !== null && isLive(retitle.value.key);
  const shortcut = useVisibleExpiringValue<ShortcutResult, Timer>(blocked || retitleShowing, SHORTCUT_HINT_MS, scheduler);
  const resultNotice = resultStatusNotice({ transient: transient.notice, retitle: retitle.value, shortcut: shortcut.value, isLive });
  const clearTransient = transient.clear;
  const clearShortcut = shortcut.clear;
  const setRetitle = retitle.set;
  const dismissResults = useCallback(() => { clearTransient(); clearShortcut(); setRetitle(null); }, [clearTransient, clearShortcut, setRetitle]);
  return {
    resultNotice,
    showTransient: transient.show,
    retitleFeedback: retitle.value,
    setRetitleFeedback: retitle.set,
    showRetitleFeedback: retitle.show,
    showShortcutFeedback: shortcut.show,
    dismissResults,
  };
}
