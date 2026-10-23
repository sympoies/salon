import { useCallback, useEffect, useRef, useState } from "react";

// Flash-avoidance for the pending spinner. A refresh that resolves in a few ms
// would otherwise flip the spinner on and straight back off — a jarring blink.
// So: don't show the spinner unless the action outlives SHOW_DELAY (instant
// actions show nothing at all), and once it IS shown, keep it up at least
// MIN_VISIBLE so an action that just crosses the delay can't flicker off.
export const PENDING_SHOW_DELAY_MS = 120;
export const PENDING_MIN_VISIBLE_MS = 320;

export interface AsyncActionOptions {
  // Override the anti-flicker timings (mainly for tests). 0 = show immediately.
  readonly showDelayMs?: number;
  readonly minVisibleMs?: number;
}

// Shared "is this control waiting on an async action" state. Wraps an async (or
// sync) handler and reports a single `pending` flag (smoothed as above) while the
// returned promise is in flight, so every waiting button in the app shows one
// consistent, non-flickering busy state (see <AsyncButton> + the `.btn-spinner` /
// `.btn[aria-busy]` CSS). Re-entrancy and unmount safety are governed by
// synchronous refs, independent of the smoothed visible flag: a second call while
// one is in flight is a no-op (`inFlightRef`), and no state is set after unmount.
//
// `pending` is a *display* flag — intentionally delayed then held. Do not use it
// as a synchronous "is the action running" guard (it is false for the first
// show-delay of every action); gate such logic on your own state or pass
// `{ showDelayMs: 0, minVisibleMs: 0 }` when you need it to track the action exactly.
//
// It does NOT swallow the action's own errors: `run` rejects if the action
// rejects, so callers own error surfacing (every current caller resolves its own
// failures — a Result return, a try/catch, or a .catch). Do not `void run()` an
// action that can reject without handling it, or it becomes an unhandled rejection.
export function useAsyncAction<Args extends unknown[]>(
  action: (...args: Args) => unknown,
  options?: AsyncActionOptions,
): { readonly pending: boolean; readonly run: (...args: Args) => Promise<void> } {
  const showDelayMs = options?.showDelayMs ?? PENDING_SHOW_DELAY_MS;
  const minVisibleMs = options?.minVisibleMs ?? PENDING_MIN_VISIBLE_MS;

  const [pending, setPending] = useState(false);
  const inFlightRef = useRef(false); // synchronous whole-action guard (re-entrancy)
  const liveRef = useRef(true);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownAt = useRef<number | null>(null); // when the spinner became visible, else null

  const clearShowTimer = () => {
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  };
  const clearHideTimer = () => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      clearShowTimer();
      clearHideTimer();
    };
  }, []);

  const run = useCallback(
    async (...args: Args) => {
      if (inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      // A rapid re-run during a prior action's min-visible hold: cancel the pending
      // hide and keep the spinner up continuously (restart its visibility window)
      // instead of blinking. Otherwise arm the show-delay from a hidden start.
      clearHideTimer();
      if (shownAt.current !== null) {
        shownAt.current = Date.now();
      } else if (showDelayMs <= 0) {
        shownAt.current = Date.now();
        setPending(true);
      } else {
        showTimer.current = setTimeout(() => {
          showTimer.current = null;
          if (inFlightRef.current && liveRef.current) {
            shownAt.current = Date.now();
            setPending(true);
          }
        }, showDelayMs);
      }

      try {
        await action(...args);
      } finally {
        inFlightRef.current = false;
        clearShowTimer(); // finished before the spinner was ever shown → no blink
        if (shownAt.current !== null) {
          const remaining = minVisibleMs - (Date.now() - shownAt.current);
          if (remaining > 0) {
            hideTimer.current = setTimeout(() => {
              hideTimer.current = null;
              shownAt.current = null;
              if (liveRef.current) {
                setPending(false);
              }
            }, remaining);
          } else {
            shownAt.current = null;
            if (liveRef.current) {
              setPending(false);
            }
          }
        }
      }
    },
    [action, showDelayMs, minVisibleMs],
  );

  return { pending, run };
}
