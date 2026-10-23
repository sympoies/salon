import type { TimeoutScheduler } from "./scheduler.ts";

interface TerminalSyntheticMouseSuppressor {
  readonly arm: () => void;
  readonly disarm: () => void;
  readonly handleCapture: (event: Event) => void;
}

// Our own synthetic link-resolution events (the pointer probe and the tap
// activation sequence) must reach xterm even while the suppressor is armed
// against browser-synthesized compatibility mouse events: a touch long-press
// arms the suppressor before the menu opens, which would otherwise swallow
// the probe at hostEl capture.
const SYNTHETIC_LINK_MOUSE_EVENT = "acSyntheticLinkMouseEvent";

export function markSyntheticLinkMouseEvent(event: Event): void {
  (event as Event & { [SYNTHETIC_LINK_MOUSE_EVENT]?: boolean })[SYNTHETIC_LINK_MOUSE_EVENT] = true;
}

export function isSyntheticLinkMouseEvent(event: Event): boolean {
  return (event as Event & { [SYNTHETIC_LINK_MOUSE_EVENT]?: boolean })[SYNTHETIC_LINK_MOUSE_EVENT] === true;
}

export function createTerminalSyntheticMouseSuppressor({
  now = () => Date.now(),
  durationMs = 700,
}: {
  readonly now?: () => number;
  readonly durationMs?: number;
} = {}): TerminalSyntheticMouseSuppressor {
  let suppressUntil = 0;
  return {
    arm() {
      suppressUntil = now() + durationMs;
    },
    disarm() {
      suppressUntil = 0;
    },
    handleCapture(event) {
      if (isSyntheticLinkMouseEvent(event)) {
        return;
      }
      // Preserve the current selection for desktop right-click copy: xterm's
      // button-2 mousedown/up handlers otherwise clear it before contextmenu.
      if (
        (event as globalThis.MouseEvent).button === 2 &&
        (event.type === "mousedown" || event.type === "mouseup")
      ) {
        event.stopImmediatePropagation();
        return;
      }
      if (now() <= suppressUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
  };
}

export function isTouchOriginContextMenu(
  event: Event,
  opts: {
    readonly hasAnyCoarsePointer: () => boolean;
    readonly recentTouchContextMenuUntil: number;
    readonly now?: () => number;
  },
): boolean {
  const pointerType = (event as Event & { pointerType?: string }).pointerType;
  if (pointerType) {
    return pointerType === "touch";
  }
  return opts.hasAnyCoarsePointer() && (opts.now?.() ?? Date.now()) <= opts.recentTouchContextMenuUntil;
}

export function touchContextMenuCandidateUntil(
  event: TouchEvent,
  opts: { readonly now?: () => number; readonly longPressMs: number },
): number | null {
  if (event.touches.length !== 1) {
    return null;
  }
  return (opts.now?.() ?? Date.now()) + opts.longPressMs * 3;
}

export function createTerminalBufferWarmOnMouseDrag<Timer = unknown>({
  warmBuffer,
  clearBuffer,
  setTimeout,
  clearTimeout,
  settleDelaysMs = [70, 250, 550, 950],
  moveThresholdPx = 3,
}: TimeoutScheduler<Timer> & {
  readonly warmBuffer: () => Promise<unknown> | unknown;
  readonly clearBuffer: () => void;
  readonly settleDelaysMs?: readonly number[];
  readonly moveThresholdPx?: number;
}): {
  readonly onMouseDown: (event: Event) => void;
  readonly onMouseUp: (event: Event) => void;
  readonly clearTimers: () => void;
} {
  let origin: { x: number; y: number } | null = null;
  const timers: Timer[] = [];
  const clearTimers = () => {
    for (const timer of timers.splice(0)) {
      clearTimeout(timer);
    }
  };
  const scheduleBufferSettle = () => {
    for (const delay of settleDelaysMs) {
      timers.push(setTimeout(() => void warmBuffer(), delay));
    }
  };
  return {
    onMouseDown(event) {
      const e = event as globalThis.MouseEvent;
      if (e.button === 0) {
        origin = { x: e.clientX, y: e.clientY };
        clearBuffer();
      }
    },
    onMouseUp(event) {
      const e = event as globalThis.MouseEvent;
      const started = origin;
      origin = null;
      if (e.button !== 0 || !started) {
        return;
      }
      if (
        Math.abs(e.clientX - started.x) > moveThresholdPx ||
        Math.abs(e.clientY - started.y) > moveThresholdPx
      ) {
        scheduleBufferSettle();
      }
    },
    clearTimers,
  };
}
