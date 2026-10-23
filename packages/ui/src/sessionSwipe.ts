import {
  SESSION_SWIPE_AXIS_DOMINANCE,
  SESSION_SWIPE_MIN_PX,
  type TerminalSessionSwipeDirection,
} from "./terminalTouch.ts";

export type SessionSwipeDirection = TerminalSessionSwipeDirection;

export interface SessionSwipePoint {
  readonly clientX: number;
  readonly clientY: number;
}

// Pure decision: given the net finger travel of a single-finger drag, return the
// committed horizontal session-swipe direction, or null. Mirrors the terminal
// touch bridge thresholds (SESSION_SWIPE_MIN_PX horizontal distance plus the
// SESSION_SWIPE_AXIS_DOMINANCE axis lock) so an idle/stopped session surface —
// which has no live terminal touch bridge — swipes with the same feel as a live
// terminal. A leftward drag (dx < 0) advances to the next session; a rightward
// drag returns to the previous one.
export function sessionSwipeDirectionFromTravel(
  dx: number,
  dy: number,
): SessionSwipeDirection | null {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX < SESSION_SWIPE_MIN_PX) {
    return null;
  }
  if (absX <= absY * SESSION_SWIPE_AXIS_DOMINANCE) {
    return null;
  }
  return dx < 0 ? "next" : "previous";
}

export interface SessionSwipeTracker {
  // touchCount is the number of active touch points; a multi-touch gesture
  // (pinch/zoom) is never a session swipe.
  start(point: SessionSwipePoint, touchCount: number): void;
  move(point: SessionSwipePoint, touchCount: number): void;
  // The touchend release point is authoritative when supplied: a fast flick's
  // last coalesced move can sit below the threshold even though the finger
  // lifted well past it. Falls back to the last move when omitted (e.g. cancel).
  end(releasePoint?: SessionSwipePoint): SessionSwipeDirection | null;
  cancel(): void;
}

// Standalone, framework-agnostic horizontal-swipe tracker for a non-terminal
// focused surface. Unlike createTerminalTouchBridge it owns no scroll, selection,
// or wheel behavior — the stopped-session screen has none — so it only measures
// start-to-release travel and commits a session swipe.
export function createSessionSwipeTracker(
  onSwipe: (direction: SessionSwipeDirection) => void,
): SessionSwipeTracker {
  let startX: number | null = null;
  let startY: number | null = null;
  let lastX: number | null = null;
  let lastY: number | null = null;

  const reset = () => {
    startX = null;
    startY = null;
    lastX = null;
    lastY = null;
  };

  return {
    start(point, touchCount) {
      if (touchCount !== 1) {
        reset();
        return;
      }
      startX = point.clientX;
      startY = point.clientY;
      lastX = point.clientX;
      lastY = point.clientY;
    },
    move(point, touchCount) {
      if (startX === null) {
        return;
      }
      if (touchCount !== 1) {
        reset();
        return;
      }
      lastX = point.clientX;
      lastY = point.clientY;
    },
    end(releasePoint) {
      if (startX === null || startY === null) {
        reset();
        return null;
      }
      const endX = releasePoint?.clientX ?? lastX ?? startX;
      const endY = releasePoint?.clientY ?? lastY ?? startY;
      const direction = sessionSwipeDirectionFromTravel(endX - startX, endY - startY);
      reset();
      if (direction) {
        onSwipe(direction);
      }
      return direction;
    },
    cancel() {
      reset();
    },
  };
}
