import { useMemo, useRef, type TouchEvent as ReactTouchEvent } from "react";
import { createSessionSwipeTracker, type SessionSwipeDirection } from "./sessionSwipe.ts";

export interface SessionSwipeHandlers {
  readonly onTouchStart: (event: ReactTouchEvent) => void;
  readonly onTouchMove: (event: ReactTouchEvent) => void;
  readonly onTouchEnd: (event: ReactTouchEvent) => void;
  readonly onTouchCancel: (event: ReactTouchEvent) => void;
}

// Horizontal session-swipe navigation for a non-terminal focused surface (e.g. a
// stopped session's status screen), which has no live terminal touch bridge to
// own the gesture. Returns undefined when disabled so the element gets no touch
// handlers at all; spread the result as `{...(handlers ?? {})}`.
export function useSessionSwipe(
  enabled: boolean,
  onSwipe: (direction: SessionSwipeDirection) => void,
): SessionSwipeHandlers | undefined {
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;
  // One tracker per mount; the ref keeps it pointed at the latest callback so the
  // navigation targets never go stale between renders.
  const tracker = useMemo(
    () => createSessionSwipeTracker((direction) => onSwipeRef.current(direction)),
    [],
  );

  if (!enabled) {
    return undefined;
  }

  return {
    onTouchStart: (event) => {
      const t0 = event.touches[0];
      tracker.start(
        { clientX: t0?.clientX ?? 0, clientY: t0?.clientY ?? 0 },
        event.touches.length,
      );
    },
    onTouchMove: (event) => {
      const t0 = event.touches[0];
      if (t0) {
        tracker.move({ clientX: t0.clientX, clientY: t0.clientY }, event.touches.length);
      }
    },
    onTouchEnd: (event) => {
      const t0 = event.changedTouches[0];
      tracker.end(t0 ? { clientX: t0.clientX, clientY: t0.clientY } : undefined);
    },
    onTouchCancel: () => {
      tracker.cancel();
    },
  };
}
