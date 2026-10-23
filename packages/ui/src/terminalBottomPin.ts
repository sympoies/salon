import type { AnimationFrameScheduler, TimeoutScheduler } from "./scheduler.ts";
import { isDshAgent } from "./dshAgent.ts";

export interface BottomPinnableTerminal {
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      readonly baseY: number;
    };
  };
  readonly scrollToBottom: () => void;
}

export interface BufferLineLike {
  readonly translateToString: (trimRight?: boolean) => string;
}

export interface ContentAwareBottomPinnableTerminal extends BottomPinnableTerminal {
  readonly rows: number;
  readonly options?: {
    smoothScrollDuration?: number;
  };
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      readonly baseY: number;
      readonly length: number;
      readonly getLine: (index: number) => BufferLineLike | undefined;
    };
  };
  readonly scrollToLine: (line: number) => void;
}

// A pin target owns BOTH halves of bottom tracking: how to reach its own bottom
// and whether the viewport is already there. By convention every construction
// site takes both from one of the factories below, because the two halves have
// to agree on where "bottom" is: the content-aware target parks the viewport
// above xterm's baseY, so an at-bottom test written as `viewportY >= baseY`
// would read every successful pin as "the user scrolled away" and auto-scroll
// would die after one write. Structural typing cannot enforce the pairing, so
// prefer `createTerminalBottomPinTarget` over assembling one by hand.
export interface TerminalBottomPinTarget {
  // Exact placement is reserved for attach/layout synchronization, where the
  // viewport may legitimately need to move in either direction after a fit.
  readonly scrollToBottom: () => void;
  // Live-output following is monotonic. In particular, a transient dsh prompt
  // clear must not pull the viewport back toward older content before the next
  // repaint restores the prompt, and a user who scrolls farther down into tmux
  // padding must not be yanked upward by the next retry.
  readonly followBottom: () => void;
  readonly isAtBottom: () => boolean;
  // Content-aware pins disable xterm smoothing around programmatic movement,
  // so an off-target onScroll cannot be an intermediate position from that
  // same move. Plain targets remain animated and do emit such positions.
  readonly programmaticScrollIsSynchronous: boolean;
}

export type TerminalBottomPinScheduler<FrameHandle, TimerHandle> =
  AnimationFrameScheduler<FrameHandle> & TimeoutScheduler<TimerHandle>;

export interface TerminalBottomPinHandle {
  readonly request: (options?: { readonly forceExact?: boolean }) => void;
  readonly flush: () => void;
  readonly cancel: () => void;
  readonly dispose: () => void;
}

const DEFAULT_SETTLE_DELAY_MS = 50;
const DEFAULT_RETRY_PASSES = 2;

export function isTerminalAtBottom(term: BottomPinnableTerminal): boolean {
  const { baseY, viewportY } = term.buffer.active;
  return viewportY >= baseY;
}

export function shouldUseContentAwareBottomPin(agent: string | undefined): boolean {
  return isDshAgent(agent);
}

// The viewportY that puts the last non-blank row on the last visible row, or
// undefined when the buffer holds no content at all.
function contentAwareBottomViewportY(
  term: ContentAwareBottomPinnableTerminal,
): number | undefined {
  const { active } = term.buffer;
  for (let lineIndex = active.length - 1; lineIndex >= 0; lineIndex -= 1) {
    const text = active.getLine(lineIndex)?.translateToString(true) ?? "";
    if (text.trim().length === 0) {
      continue;
    }
    return Math.max(0, Math.min(active.baseY, lineIndex - term.rows + 1));
  }
  return undefined;
}

export function scrollToLastNonBlankLine(term: ContentAwareBottomPinnableTerminal): void {
  const viewportY = contentAwareBottomViewportY(term) ?? term.buffer.active.baseY;
  scrollToLineImmediately(term, viewportY);
}

function scrollToLineImmediately(
  term: ContentAwareBottomPinnableTerminal,
  viewportY: number,
): void {
  // xterm 6 routes the public scrollToLine API through its browser viewport,
  // where smoothScrollDuration turns this programmatic pin into an animation.
  // Inline TUIs such as dsh can redraw a plan footer or a wrapped prompt again
  // before that animation lands. Reusing the animation then leaves ydisp
  // chasing a moving target, makes the transcript jump on every keypress, and
  // can expose an intermediate viewport as an apparent user scroll-away.
  //
  // Changing the option is synchronous in xterm: setting it to zero also makes
  // the next scroll cancel any pending animation and update the buffer in the
  // same turn. Restore it immediately so wheel/touch scrolling keeps the user's
  // configured smoothing.
  const options = term.options;
  const smoothScrollDuration = options?.smoothScrollDuration;
  if (options && smoothScrollDuration !== undefined && smoothScrollDuration !== 0) {
    options.smoothScrollDuration = 0;
    try {
      term.scrollToLine(viewportY);
    } finally {
      options.smoothScrollDuration = smoothScrollDuration;
    }
    return;
  }
  term.scrollToLine(viewportY);
}

function followLastNonBlankLine(term: ContentAwareBottomPinnableTerminal): void {
  const viewportY = contentAwareBottomViewportY(term) ?? term.buffer.active.baseY;
  // Content-aware "bottom" is a lower bound, not one exact viewport offset.
  // Once the user or a later repaint has moved at/past it, following must never
  // reverse direction. Exact attach/fit placement remains available through
  // scrollToLastNonBlankLine above.
  if (term.buffer.active.viewportY >= viewportY) {
    return;
  }
  scrollToLineImmediately(term, viewportY);
}

// Bottom for a content-aware pane is the viewport offset that puts the last
// content row on the last visible row — not xterm's baseY, which would leave
// tmux's blank padding on screen. Anything at or past that offset, including
// the padding region between it and baseY, still counts as tracking the tail;
// see TerminalBottomPinTarget.
function isTerminalAtContentBottom(term: ContentAwareBottomPinnableTerminal): boolean {
  const contentBottomViewportY = contentAwareBottomViewportY(term);
  if (contentBottomViewportY === undefined) {
    return isTerminalAtBottom(term);
  }
  return term.buffer.active.viewportY >= contentBottomViewportY;
}

export function createPlainBottomPinTarget(term: BottomPinnableTerminal): TerminalBottomPinTarget {
  return {
    isAtBottom: () => isTerminalAtBottom(term),
    programmaticScrollIsSynchronous: false,
    followBottom: () => {
      term.scrollToBottom();
    },
    scrollToBottom: () => {
      term.scrollToBottom();
    },
  };
}

export function createContentAwareBottomPinTarget(
  term: ContentAwareBottomPinnableTerminal,
): TerminalBottomPinTarget {
  return {
    isAtBottom: () => isTerminalAtContentBottom(term),
    programmaticScrollIsSynchronous: true,
    followBottom: () => {
      followLastNonBlankLine(term);
    },
    scrollToBottom: () => {
      scrollToLastNonBlankLine(term);
    },
  };
}

export function createTerminalBottomPinTarget(
  term: ContentAwareBottomPinnableTerminal,
  agent: string | undefined,
): TerminalBottomPinTarget {
  return shouldUseContentAwareBottomPin(agent)
    ? createContentAwareBottomPinTarget(term)
    : createPlainBottomPinTarget(term);
}

export interface BottomPinIntentInput {
  // The terminal currently has an active text selection, so the pin is paused.
  readonly hasSelection: boolean;
  // The viewport is at the pin target's own bottom right now.
  readonly isAtBottom: boolean;
  // The intent recorded before this observation.
  readonly keepPinned: boolean;
}

// Re-read "the user is tracking the tail" from the viewport. This must not run
// while the pin is paused for a selection: the pause deliberately leaves the
// viewport behind the tail, so the buffer stops reporting the user's intent and
// starts reporting our own pause. Recomputing there would latch the intent off
// and auto-scroll would never resume after the selection cleared — the same
// dead end a content-aware pin used to hit on its own scroll event.
//
// The tradeoff: a user who scrolls up *while holding a selection* is treated as
// still pinned and snaps back on the next write. That is recoverable by
// scrolling again, where a permanently dead auto-scroll is not.
export function nextBottomPinIntent(input: BottomPinIntentInput): boolean {
  if (input.hasSelection) {
    return input.keepPinned;
  }
  return input.isAtBottom;
}

export interface AutoPinBottomInput {
  // An explicit request (fit/resize, session open, first payload) to stick to bottom.
  readonly forced: boolean;
  // The user was tracking the bottom before this write.
  readonly keepPinned: boolean;
  // The viewport is currently at the bottom.
  readonly atBottom: boolean;
  // The terminal currently has an active text selection.
  readonly hasSelection: boolean;
}

// Decide whether to auto-scroll the viewport to the bottom. An active text
// selection always wins: scrolling to bottom mid-drag reflows the selection so
// only the tail survives (selecting "mac book" collapses to "book") and Cmd+C
// then copies the wrong range. Pausing here lets output pile up until the user
// clears the selection, after which normal bottom-pinning resumes.
export function shouldAutoPinBottom(input: AutoPinBottomInput): boolean {
  if (input.hasSelection) {
    return false;
  }
  return input.forced || input.keepPinned || input.atBottom;
}

export function createTerminalBottomPin<FrameHandle, TimerHandle>(
  // Older/simple targets only expose exact bottom scrolling; content-aware
  // targets add a monotonic follow path used by ordinary writes and retries.
  target: Pick<TerminalBottomPinTarget, "scrollToBottom"> &
    Partial<Pick<TerminalBottomPinTarget, "followBottom">>,
  scheduler: TerminalBottomPinScheduler<FrameHandle, TimerHandle>,
  settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
  retryPasses = DEFAULT_RETRY_PASSES,
): TerminalBottomPinHandle {
  let frame: FrameHandle | undefined;
  let timer: TimerHandle | undefined;
  let retriesRemaining = 0;
  let disposed = false;
  const followBottom = target.followBottom ?? target.scrollToBottom;

  const schedule = () => {
    if (disposed || retriesRemaining <= 0 || frame !== undefined || timer !== undefined) {
      return;
    }
    frame = scheduler.requestAnimationFrame(() => {
      frame = undefined;
      flush();
    });
    timer = scheduler.setTimeout(() => {
      timer = undefined;
      flush();
    }, settleDelayMs);
  };

  const request = (options: { readonly forceExact?: boolean } = {}) => {
    if (disposed) {
      return;
    }
    retriesRemaining = Math.max(retriesRemaining, retryPasses);
    if (options.forceExact === true) {
      target.scrollToBottom();
    } else {
      followBottom();
    }
    schedule();
  };

  const flush = () => {
    if (disposed || retriesRemaining <= 0) {
      return;
    }
    retriesRemaining -= 1;
    followBottom();
    schedule();
  };

  const cancel = () => {
    retriesRemaining = 0;
    if (frame !== undefined) {
      scheduler.cancelAnimationFrame(frame);
      frame = undefined;
    }
    if (timer !== undefined) {
      scheduler.clearTimeout(timer);
      timer = undefined;
    }
  };

  const dispose = () => {
    cancel();
    disposed = true;
  };

  return { cancel, dispose, flush, request };
}
