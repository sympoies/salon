import type { Terminal } from "@xterm/xterm";
import type { TimeoutScheduler } from "./scheduler.ts";

export const LONG_PRESS_MS = 520;
export const TOUCH_LONG_PRESS_CANCEL_PX = 8;
// How far a finger may stray and still have its release read as a tap. This is
// deliberately larger than the long-press cancel distance: 8px is the right
// distance to decide "this is no longer a press", but far too tight to decide
// "this was never a tap". A thumb aiming at a link label a few cells wide
// routinely drifts more than that and lifts where it started, and below the
// swipe commit distance such a gesture used to end as a dead scroll — no
// session switch, no scrolling, and no tap.
export const TOUCH_TAP_SLOP_PX = 16;
export const TOUCH_WHEEL_STEP_PX = 24;
export const SESSION_SWIPE_AXIS_LOCK_PX = 12;
export const SESSION_SWIPE_MIN_PX = 64;
export const SESSION_SWIPE_AXIS_DOMINANCE = 1.25;
// Flick momentum (inertial scroll): after a fast drag release, keep scrolling with
// a decaying velocity so a flick coasts like a native touch scroll.
const MOMENTUM_TICK_MS = 16;
// px/ms at release; below this a release is a plain stop, not a flick.
const MOMENTUM_MIN_START_VELOCITY = 0.35;
// Coast ends once the decaying velocity drops below this (px/ms). Lower = the
// glide carries further into its slow tail.
const MOMENTUM_MIN_STOP_VELOCITY = 0.02;
// Per-tick velocity retention; higher = longer coast (0.95 @ 16ms tick is a
// ~216ms half-life). Tuned up so a flick keeps gliding after the finger lifts.
const MOMENTUM_FRICTION = 0.95;
// Cap so a very fast flick can't launch an extreme coast.
const MOMENTUM_MAX_START_VELOCITY = 6;
export const TERMINAL_TOUCH_MENU_WIDTH_PX = 286;
export const TERMINAL_TOUCH_MENU_ONE_LINE_BUTTON_PX = 120;
// Wider layout when a "Copy link" button joins the toolbar (long-press or
// right-click landed on a detected URL).
export const TERMINAL_TOUCH_MENU_LINK_WIDTH_PX = 356;
// Extra toolbar width for the Links button, shown when this session has
// harvested any OSC 8 target.
export const TERMINAL_TOUCH_MENU_LINKS_BUTTON_PX = 62;
const TERMINAL_TOUCH_MENU_GAP_PX = 8;

export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SizeLike {
  readonly width: number;
  readonly height: number;
}

export interface TouchPointLike {
  readonly clientX: number;
  readonly clientY: number;
}

export interface TouchEventLike {
  readonly touches: ArrayLike<TouchPointLike>;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export interface TerminalTouchWheel {
  readonly deltaY: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface TerminalTouchBridge {
  onTouchStart: (event: TouchEventLike) => void;
  onTouchMove: (event: TouchEventLike) => void;
  // Only a clean tap may activate a terminal link. Scroll and selection
  // gestures must remain distinct through touchend so they cannot fall through
  // to point-based URL activation. The touchend release point, when supplied,
  // is the authoritative position for the horizontal-swipe distance decision.
  endTouch: (releasePoint?: TouchPointLike) => TerminalTouchEndKind;
  cancelTouch: () => void;
  dispose: () => void;
  cancelLongPress: () => void;
}

export type TerminalSessionSwipeDirection = "previous" | "next";
type TerminalTouchEndKind = "tap" | "scroll" | "selection" | "swipe" | "none";

export interface TerminalTouchBridgeOptions<Timer = unknown> extends TimeoutScheduler<Timer> {
  readonly emitWheel: (wheel: TerminalTouchWheel) => void;
  // Smooth, sub-line viewport scroll for the normal-buffer scrollback path.
  // Given the raw finger pixel delta (finger-down positive), it composites the
  // visible rows between xterm's whole-row viewport updates and returns true.
  // Returns false when it does not own the scroll (a mouse-tracking TUI or the
  // alt buffer), so the bridge falls back to the discrete wheel notches below.
  readonly scrollViewportPixels?: (dyPixels: number) => boolean;
  // Finger pixels per emitted wheel notch. Defaults to TOUCH_WHEEL_STEP_PX; the
  // terminal supplies the live cell height so a drag scrolls ~1:1 with the finger
  // (a coarse fixed step scrolls far less than the finger travels).
  readonly wheelStepPx?: () => number;
  // Monotonic clock (ms) used to measure flick velocity for momentum scrolling.
  // Without it, momentum is disabled (a flick just stops on release).
  readonly now?: () => number;
  readonly showActivity: () => void;
  readonly clearMenu: () => void;
  // Shown on release when a long-press selection was made (positions the copy toolbar).
  readonly openMenu: (clientX: number, clientY: number) => void;
  // Long-press: select the word under the finger and enter selection mode.
  readonly beginSelection?: (clientX: number, clientY: number) => void;
  // Drag while in selection mode: extend the selection to the finger.
  readonly extendSelection?: (clientX: number, clientY: number) => void;
  // Scroll drag (no long-press): once the gesture is confirmed a scroll, release
  // the mouse press the touch-synthesized mousedown forwarded to the app AT the
  // press coordinates, turning it into a click instead of a drag. Otherwise a
  // mouse-mode TUI (codex/claude) treats the touch drag as a drag-select that
  // fights and stalls the scroll over text. Also drops any stray xterm selection.
  readonly releaseTouchMousePress?: (clientX: number, clientY: number) => void;
  // Called once when a gesture is confirmed as a scroll or a long-press
  // selection (never for a clean tap). The terminal uses this to eat the
  // synthesized mouse events that would otherwise let xterm start a selection
  // drag and fight (stall) the finger-scroll. A clean tap is left alone so its
  // synthesized click still focuses the terminal and raises the on-screen
  // keyboard — programmatic focus does not reliably do so in Android WebView.
  readonly suppressSynthMouse?: () => void;
  // Focused mobile terminals use the same touch owner for horizontal session
  // navigation so a swipe cannot also become terminal scroll/selection input.
  readonly onHorizontalSwipe?: (direction: TerminalSessionSwipeDirection) => void;
  // TerminalPane keeps the terminal instance alive while focus, viewport, and
  // session count change. Snapshot this live eligibility at touchstart so a
  // disabled gesture stays entirely on the existing terminal interaction path.
  readonly isHorizontalSwipeEnabled?: () => boolean;
  readonly longPressMs?: number;
}

// Mouse-wheel amplification (desktop/web). A physical mouse-wheel notch is coarse
// and discrete; a trackpad fine-scroll streams small pixel deltas. In a
// mouse-tracking TUI (codex/claude) xterm forwards exactly ONE wheel escape per
// DOM wheel event regardless of the delta size, so the trackpad's stream of
// events scrolls fast while a single mouse notch only moves one line ("barely
// moves"). We forward several escapes for a real notch to fix that; a trackpad
// tick is left as-is so its native feel is preserved.
//
// Pixel deltas at/above this magnitude are treated as a mouse-wheel notch;
// smaller pixel deltas are trackpad ticks and pass through unchanged.
export const MOUSE_WHEEL_NOTCH_MIN_PX = 48;
// Wheel escapes forwarded per notch. Higher = a notch scrolls more. Tunable.
export const MOUSE_WHEEL_LINES_PER_NOTCH = 4;

export interface WheelLike {
  readonly deltaY: number;
  // WheelEvent.deltaMode: 0 = pixel, 1 = line, 2 = page.
  readonly deltaMode: number;
}

// Signed count of wheel escapes to forward for a real wheel event when the
// terminal is in mouse-tracking mode. Returns 0 to mean "not a mouse-wheel notch
// — let xterm forward its single escape unchanged" (keeps trackpad fine-scroll
// exactly as-is). The sign follows deltaY (negative = scroll up).
export function mouseWheelForwardedNotchLines(
  event: WheelLike,
  opts: { linesPerNotch?: number; notchMinPx?: number } = {},
): number {
  if (event.deltaY === 0) {
    return 0;
  }
  const linesPerNotch = opts.linesPerNotch ?? MOUSE_WHEEL_LINES_PER_NOTCH;
  const notchMinPx = opts.notchMinPx ?? MOUSE_WHEEL_NOTCH_MIN_PX;
  const sign = event.deltaY < 0 ? -1 : 1;
  // Line/page deltas are inherently discrete notches; trackpads report pixels.
  if (event.deltaMode !== 0) {
    return sign * linesPerNotch;
  }
  // Pixel deltas: a small delta is a trackpad fine-scroll — leave it to xterm.
  if (Math.abs(event.deltaY) < notchMinPx) {
    return 0;
  }
  return sign * linesPerNotch;
}

export function wheelDeltasFromTouchAccum(
  accumPx: number,
  stepPx = TOUCH_WHEEL_STEP_PX,
): { deltas: number[]; remaining: number } {
  const deltas: number[] = [];
  let remaining = accumPx;
  while (Math.abs(remaining) >= stepPx) {
    if (remaining > 0) {
      deltas.push(-1);
      remaining -= stepPx;
    } else {
      deltas.push(1);
      remaining += stepPx;
    }
  }
  return { deltas, remaining };
}

export function hasMovedBeyondLongPressThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  thresholdPx = TOUCH_LONG_PRESS_CANCEL_PX,
): boolean {
  return Math.hypot(currentX - startX, currentY - startY) > thresholdPx;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch.trim().length > 0;
}

export interface TerminalCell {
  // Character(s) rendered in this cell ("" for an empty cell or the trailing half of a wide glyph).
  readonly chars: string;
  // Cell width: 1 = normal, 2 = wide (CJK) glyph occupying this cell + the next, 0 = that trailing half.
  readonly width: number;
}

interface TerminalBufferCellPoint {
  readonly col: number;
  readonly row: number;
}

export function terminalCellFromPoint(
  term: Terminal,
  clientX: number,
  clientY: number,
): TerminalBufferCellPoint | null {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) {
    return null;
  }
  const rect = screen.getBoundingClientRect();
  const viewportRow = terminalViewportRowFromPoint(clientY, rect, term.rows);
  const col = terminalViewportColFromPoint(clientX, rect, term.cols);
  if (viewportRow === null || col === null) {
    return null;
  }
  return { col, row: term.buffer.active.viewportY + viewportRow };
}

// Word span (run of non-whitespace cells) containing `col`, in CELL coordinates.
// Operates on cells, not a string, so full-width (CJK) glyphs map correctly: a
// wide glyph is one character but two cells, and xterm selection is cell-indexed
// while terminalViewportColFromPoint yields a cell column — a plain string index
// would drift by one per wide glyph left of the tap. On whitespace, selects one cell.
export function wordCellRange(cells: readonly TerminalCell[], col: number): { start: number; length: number } {
  const n = cells.length;
  if (n === 0) {
    return { start: Math.max(col, 0), length: 1 };
  }
  const isWord: boolean[] = new Array(n);
  for (let x = 0; x < n; x += 1) {
    const cell = cells[x];
    if (cell === undefined) {
      isWord[x] = false;
      continue;
    }
    // The trailing half of a wide glyph carries no chars; inherit the glyph's class.
    isWord[x] = cell.width === 0 && x > 0 ? (isWord[x - 1] ?? false) : isWordChar(cell.chars);
  }
  const c = Math.min(Math.max(col, 0), n - 1);
  if (!isWord[c]) {
    return { start: c, length: 1 };
  }
  let start = c;
  while (start > 0 && isWord[start - 1]) {
    start -= 1;
  }
  let end = c;
  while (end < n - 1 && isWord[end + 1]) {
    end += 1;
  }
  return { start, length: end - start + 1 };
}

export function terminalViewportColFromPoint(clientX: number, rect: RectLike, cols: number): number | null {
  if (cols <= 0 || rect.width <= 0) {
    return null;
  }
  const rawCol = Math.floor(((clientX - rect.left) / rect.width) * cols);
  return Math.min(Math.max(rawCol, 0), cols - 1);
}

// Given the anchored word span (buffer-linear cell offsets) and the current drag
// offset, produce the selection range. The word stays anchored; dragging past
// either end extends in that direction, dragging within the word keeps the word.
export function selectionRangeFromWordDrag(
  wordStart: number,
  wordEnd: number,
  current: number,
): { start: number; length: number } {
  if (current >= wordEnd) {
    return { start: wordStart, length: current - wordStart + 1 };
  }
  if (current <= wordStart) {
    return { start: current, length: wordEnd - current + 1 };
  }
  return { start: wordStart, length: wordEnd - wordStart + 1 };
}

export interface SelectionHandlePoint {
  // Pane-relative pixel position of the handle (at the bottom of its cell row).
  readonly x: number;
  readonly y: number;
  // False when the endpoint has scrolled out of the visible viewport.
  readonly visible: boolean;
}

export interface SelectionEndpoints {
  readonly start: SelectionHandlePoint;
  readonly end: SelectionHandlePoint;
}

export interface SelectionGeometry {
  // Offset of the .xterm-screen box relative to the pane.
  readonly screenLeft: number;
  readonly screenTop: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly rows: number;
  readonly viewportY: number;
}

// Pixel positions for the two draggable selection handles, given the selection's
// buffer-cell endpoints (row = absolute buffer line). Handles sit at the bottom
// of their cell row; an endpoint scrolled out of the viewport is marked hidden.
export function selectionHandlePoints(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  geo: SelectionGeometry,
): SelectionEndpoints {
  const point = (col: number, bufferRow: number): SelectionHandlePoint => {
    const viewportRow = bufferRow - geo.viewportY;
    return {
      x: geo.screenLeft + col * geo.cellWidth,
      y: geo.screenTop + (viewportRow + 1) * geo.cellHeight,
      visible: viewportRow >= 0 && viewportRow < geo.rows,
    };
  };
  return { start: point(startCol, startRow), end: point(endCol, endRow) };
}

export function createTerminalTouchBridge<Timer = unknown>({
  emitWheel,
  scrollViewportPixels,
  wheelStepPx,
  now,
  showActivity,
  clearMenu,
  openMenu,
  beginSelection,
  extendSelection,
  releaseTouchMousePress,
  suppressSynthMouse,
  onHorizontalSwipe,
  isHorizontalSwipeEnabled,
  setTimeout,
  clearTimeout,
  longPressMs = LONG_PRESS_MS,
}: TerminalTouchBridgeOptions<Timer>): TerminalTouchBridge {
  let touchY: number | null = null;
  let touchStartX: number | null = null;
  let touchStartY: number | null = null;
  let lastX: number | null = null;
  let lastY: number | null = null;
  let touchAccum = 0;
  let longPressTimer: Timer | null = null;
  // Selection mode: a stationary long-press selected a word; subsequent moves
  // extend the selection instead of scrolling, and release shows the copy menu.
  let selecting = false;
  // Whether the finger crossed the tap threshold. Crossing it confirms a drag
  // (not a tap): once, we drop the stray selection the touch started and arm
  // synth-mouse suppression so xterm cannot start a selection drag that stalls
  // the scroll over text. A clean tap never crosses it, so its synth click still
  // reaches xterm and raises the keyboard.
  let moved = false;
  // Farthest the finger has been from where it landed. Tap classification uses
  // the whole path, not just the release point, so a real scroll that happens
  // to return to its start is still a scroll.
  let maxTouchDistance = 0;
  // When the finger landed, for bounding the tap rescue to a tap-length press.
  let touchStartAt: number | null = null;
  // Whether this gesture has moved the buffer under the finger (a viewport
  // scroll or an emitted wheel row). The sub-cell visual preview does not count:
  // it is a transform over the rendered rows and moves no buffer row.
  let bufferMoved = false;
  // The injected clock exists for flick velocity and is optional; the tap
  // duration bound must hold with or without it, so fall back to wall time.
  const monotonicNow = () => (now ? now() : Date.now());
  let gestureAxis: "horizontal" | "vertical" | null = null;
  let horizontalOffset = 0;
  let horizontalSwipeEnabled = false;
  // Flick-velocity tracking (px/ms, sign = finger direction) and the coast timer.
  let flickVelocity = 0;
  let lastMoveTime: number | null = null;
  let momentumTimer: Timer | null = null;

  const currentStepPx = () => Math.max(4, wheelStepPx?.() ?? TOUCH_WHEEL_STEP_PX);

  const cancelLongPress = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const cancelMomentum = () => {
    if (momentumTimer !== null) {
      clearTimeout(momentumTimer);
      momentumTimer = null;
    }
  };

  // Continue scrolling after a fast flick, decaying the velocity each tick until it
  // settles — the inertial coast of a native touch scroll. A new touch cancels it.
  const startMomentum = () => {
    if (!now || lastX === null || lastY === null) {
      return;
    }
    let velocity = flickVelocity;
    if (velocity > MOMENTUM_MAX_START_VELOCITY) velocity = MOMENTUM_MAX_START_VELOCITY;
    else if (velocity < -MOMENTUM_MAX_START_VELOCITY) velocity = -MOMENTUM_MAX_START_VELOCITY;
    if (Math.abs(velocity) < MOMENTUM_MIN_START_VELOCITY) {
      return;
    }
    const anchorX = lastX;
    const anchorY = lastY;
    let accum = 0;
    const tick = () => {
      momentumTimer = null;
      const stepPx = velocity * MOMENTUM_TICK_MS;
      if (scrollViewportPixels?.(stepPx)) {
        // Smooth viewport scroll owns the coast (normal-buffer scrollback).
        showActivity();
      } else {
        accum += stepPx;
        const wheel = wheelDeltasFromTouchAccum(accum, currentStepPx());
        accum = wheel.remaining;
        for (const deltaY of wheel.deltas) {
          emitWheel({ deltaY, clientX: anchorX, clientY: anchorY });
        }
        if (wheel.deltas.length > 0) {
          showActivity();
        }
      }
      velocity *= MOMENTUM_FRICTION;
      if (Math.abs(velocity) >= MOMENTUM_MIN_STOP_VELOCITY) {
        momentumTimer = setTimeout(tick, MOMENTUM_TICK_MS);
      }
    };
    momentumTimer = setTimeout(tick, MOMENTUM_TICK_MS);
  };

  const beginMovedGesture = () => {
    if (moved) {
      return;
    }
    moved = true;
    cancelLongPress();
    clearMenu();
    if (!horizontalSwipeEnabled && touchStartX !== null && touchStartY !== null) {
      releaseTouchMousePress?.(touchStartX, touchStartY);
    }
  };

  const endTouch = (releasePoint?: TouchPointLike, commit = true): TerminalTouchEndKind => {
    cancelLongPress();
    // Measure the swipe distance to the touchend release point when available.
    // The last coalesced touchmove can sit below the threshold on a fast flick
    // even though the finger actually lifted well past it, and a drag that
    // returns near its start before lifting should not commit a swipe. Fall back
    // to the last move offset when no release point is supplied (e.g. cancel).
    const swipeOffset =
      releasePoint && touchStartX !== null ? releasePoint.clientX - touchStartX : horizontalOffset;
    const swipeDirection: TerminalSessionSwipeDirection | null =
      commit && gestureAxis === "horizontal" && Math.abs(swipeOffset) >= SESSION_SWIPE_MIN_PX
        ? swipeOffset < 0
          ? "next"
          : "previous"
        : null;
    // `moved` is armed by the 8px long-press cancel and by the 12px swipe axis
    // lock, both far tighter than a thumb's aim. A gesture that never left the
    // tap slop is still a tap: without this, tapping a small target such as a
    // rendered link label silently produced nothing.
    const releaseDistance =
      releasePoint && touchStartX !== null && touchStartY !== null
        ? Math.hypot(releasePoint.clientX - touchStartX, releasePoint.clientY - touchStartY)
        : 0;
    // Distance alone is not enough. The 8px threshold has already cancelled the
    // long press by the time a settling thumb crosses it, so without a duration
    // bound a press-and-hold that drifted ~10px would come back as a tap and
    // activate the link the user was holding to reach the toolbar for.
    const heldFor = touchStartAt === null ? 0 : monotonicNow() - touchStartAt;
    // A gesture that actually scrolled is not a tap however small it was: the
    // row a tap would resolve has moved out from under the finger, and on the
    // non-tracking path an implicit URL opens with no confirmation.
    const stayedWithinTapSlop =
      !bufferMoved &&
      Math.max(maxTouchDistance, releaseDistance) <= TOUCH_TAP_SLOP_PX &&
      heldFor < longPressMs;
    const endKind: TerminalTouchEndKind = !commit
      ? "none"
      : selecting
      ? "selection"
      : swipeDirection
        ? "swipe"
        : moved && !stayedWithinTapSlop
          ? "scroll"
          : touchStartX !== null && touchStartY !== null
            ? "tap"
            : "none";
    if (commit && selecting && lastX !== null && lastY !== null) {
      openMenu(lastX, lastY);
    } else if (swipeDirection) {
      onHorizontalSwipe?.(swipeDirection);
    } else if (commit && endKind === "scroll" && gestureAxis !== "horizontal") {
      // A drag released fast enough coasts (inertial scroll); startMomentum reads
      // flickVelocity + lastX/lastY, so run it before the reset below. Keyed on
      // the classification, not the raw moved flag: flick velocity is an
      // inter-move average that a fast wobble inside the tap slop can satisfy,
      // and a tap that coasts would pump wheel escapes into a tracking TUI or
      // silently drop the pane out of its bottom pin.
      startMomentum();
    }
    // Re-arm suppression at the commit itself. The fixed suppression window is
    // otherwise only refreshed on touchmove, so a non-tap gesture that pauses
    // longer than the window before the finger lifts would let the trailing
    // compat mouseup/click reach the app — landing on the new session after a
    // swipe. A clean tap is left alone so its synth click still focuses xterm and
    // raises the on-screen keyboard.
    if (commit && endKind !== "tap" && endKind !== "none") {
      suppressSynthMouse?.();
    }
    selecting = false;
    moved = false;
    maxTouchDistance = 0;
    bufferMoved = false;
    touchStartAt = null;
    gestureAxis = null;
    horizontalOffset = 0;
    horizontalSwipeEnabled = false;
    flickVelocity = 0;
    lastMoveTime = null;
    touchY = null;
    touchStartX = null;
    touchStartY = null;
    lastX = null;
    lastY = null;
    touchAccum = 0;
    return endKind;
  };

  const cancelTouch = () => {
    cancelMomentum();
    endTouch(undefined, false);
  };

  return {
    onTouchStart(event) {
      const t0 = event.touches.length === 1 ? event.touches[0] : undefined;
      touchY = t0 ? t0.clientY : null;
      touchStartX = t0 ? t0.clientX : null;
      touchStartY = t0 ? t0.clientY : null;
      lastX = t0 ? t0.clientX : null;
      lastY = t0 ? t0.clientY : null;
      touchAccum = 0;
      selecting = false;
      moved = false;
      maxTouchDistance = 0;
      bufferMoved = false;
      touchStartAt = t0 ? monotonicNow() : null;
      gestureAxis = null;
      horizontalOffset = 0;
      horizontalSwipeEnabled = Boolean(
        t0 && onHorizontalSwipe && (isHorizontalSwipeEnabled?.() ?? true),
      );
      flickVelocity = 0;
      lastMoveTime = null;
      // A new touch stops any in-flight inertial coast (native scroll behavior).
      cancelMomentum();
      cancelLongPress();
      clearMenu();
      if (touchY !== null && touchStartX !== null && touchStartY !== null) {
        showActivity();
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (touchStartX !== null && touchStartY !== null) {
            selecting = true;
            // Eat the synth click that a stationary long-press otherwise fires
            // on release, which would clear the word we just selected.
            suppressSynthMouse?.();
            beginSelection?.(touchStartX, touchStartY);
          }
        }, longPressMs);
      }
    },
    onTouchMove(event) {
      const t0 = event.touches[0];
      if (touchY === null || !t0 || event.touches.length !== 1) {
        return;
      }
      lastX = t0.clientX;
      lastY = t0.clientY;
      if (touchStartX !== null && touchStartY !== null) {
        maxTouchDistance = Math.max(
          maxTouchDistance,
          Math.hypot(t0.clientX - touchStartX, t0.clientY - touchStartY),
        );
      }
      if (selecting) {
        // Extend the word selection; never scroll while selecting.
        extendSelection?.(t0.clientX, t0.clientY);
        showActivity();
        event.preventDefault?.();
        event.stopPropagation?.();
        return;
      }
      if (
        touchStartX !== null &&
        touchStartY !== null &&
        horizontalSwipeEnabled &&
        gestureAxis !== "vertical"
      ) {
        const dx = t0.clientX - touchStartX;
        const dy = t0.clientY - touchStartY;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        horizontalOffset = dx;
        if (gestureAxis === null && Math.max(absX, absY) >= SESSION_SWIPE_AXIS_LOCK_PX) {
          if (absX > absY * SESSION_SWIPE_AXIS_DOMINANCE) {
            gestureAxis = "horizontal";
          } else if (absY > absX * SESSION_SWIPE_AXIS_DOMINANCE) {
            gestureAxis = "vertical";
          }
        }
        if (gestureAxis === "horizontal") {
          beginMovedGesture();
          suppressSynthMouse?.();
          event.preventDefault?.();
          event.stopPropagation?.();
          return;
        }
        if (gestureAxis === null && Math.max(absX, absY) >= SESSION_SWIPE_AXIS_LOCK_PX) {
          // Hold an ambiguous diagonal gesture until its axis is clear instead
          // of leaking partial horizontal motion into terminal wheel input.
          beginMovedGesture();
          suppressSynthMouse?.();
          event.preventDefault?.();
          event.stopPropagation?.();
          return;
        }
      }
      if (
        touchStartX !== null &&
        touchStartY !== null &&
        hasMovedBeyondLongPressThreshold(touchStartX, touchStartY, t0.clientX, t0.clientY)
      ) {
        if (!moved) {
          // First move past the tap threshold: the gesture is a drag, not a tap.
          // A touch on a touch-action:none element emits compatibility mouse
          // events; the mousedown lands at touch-start and is forwarded to a
          // mouse-mode TUI (codex/claude) as a button press. Left to run, the
          // gesture becomes a forwarded drag (press here, release elsewhere) that
          // the app reads as a drag-select, fighting and stalling the scroll over
          // text. Release the press NOW at the SAME cell it pressed — a clean
          // click, not a drag — and arm synth-mouse suppression so the trailing
          // compat mouse events (moves, the real touchend up/click) never reach
          // the app. A clean stationary tap never crosses the threshold, so its
          // synth click still focuses xterm and raises the keyboard.
          beginMovedGesture();
        }
        // Re-arm suppression on every move so a long scroll never outlives the
        // 700ms window and lets a late compat mouse event reach the app.
        suppressSynthMouse?.();
      }
      const dy = t0.clientY - touchY;
      if (now) {
        const t = now();
        if (lastMoveTime !== null) {
          const dt = t - lastMoveTime;
          if (dt > 0) {
            // EMA-smoothed finger velocity (px/ms) for release momentum.
            flickVelocity = flickVelocity * 0.4 + (dy / dt) * 0.6;
          }
        }
        lastMoveTime = t;
      }
      touchY = t0.clientY;
      if (scrollViewportPixels?.(dy)) {
        // Smooth sub-line viewport scroll owns this gesture; drop any pending
        // wheel-notch remainder so a mid-drag mode flip can't double-apply it.
        bufferMoved = true;
        touchAccum = 0;
      } else {
        touchAccum += dy;
        const wheel = wheelDeltasFromTouchAccum(touchAccum, currentStepPx());
        touchAccum = wheel.remaining;
        for (const deltaY of wheel.deltas) {
          // A semantic row: the buffer under the finger has moved.
          bufferMoved = true;
          emitWheel({ deltaY, clientX: t0.clientX, clientY: t0.clientY });
        }
      }
      showActivity();
      event.preventDefault?.();
      event.stopPropagation?.();
    },
    endTouch,
    cancelTouch,
    dispose: cancelTouch,
    cancelLongPress,
  };
}

// Resolve the same CSS box used by the rendered toolbar, including shared
// target height, padding and borders, before clamping its placement.
export function terminalTouchMenuHeight(pane: HTMLElement): number {
  const probe = pane.ownerDocument.createElement("div");
  probe.className = "terminal-touch-menu";
  probe.setAttribute("aria-hidden", "true");
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  pane.append(probe);
  try {
    return probe.getBoundingClientRect().height;
  } finally {
    probe.remove();
  }
}

export function terminalTouchMenuPosition(
  clientX: number,
  clientY: number,
  rect: RectLike,
  menuSize: SizeLike,
  marginPx = 8,
  gapPx = TERMINAL_TOUCH_MENU_GAP_PX,
): { x: number; y: number } {
  const menuWidth = Math.min(menuSize.width, Math.max(marginPx, rect.width - marginPx * 2));
  const menuHeight = Math.min(menuSize.height, Math.max(marginPx, rect.height - marginPx * 2));
  const maxX = Math.max(marginPx, rect.width - marginPx - menuWidth);
  const maxY = Math.max(marginPx, rect.height - marginPx - menuHeight);
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const preferredY = localY - gapPx - menuHeight;
  const fallbackY = localY + gapPx;
  return {
    x: clamp(localX - menuWidth / 2, marginPx, maxX),
    y: clamp(preferredY >= marginPx ? preferredY : fallbackY, marginPx, maxY),
  };
}

export function terminalViewportRowFromPoint(clientY: number, rect: RectLike, rows: number): number | null {
  if (rows <= 0 || rect.height <= 0) {
    return null;
  }
  const rawRow = Math.floor(((clientY - rect.top) / rect.height) * rows);
  return Math.min(Math.max(rawRow, 0), rows - 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
