import type { AnimationFrameScheduler, TimeoutScheduler } from "./scheduler.ts";

export interface BottomPinnableTerminal {
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      readonly baseY: number;
    };
  };
  readonly scrollToBottom: () => void;
}

export interface TerminalBottomPinTarget {
  readonly scrollToBottom: () => void;
  readonly followBottom: () => void;
  readonly isAtBottom: () => boolean;
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

export function createPlainBottomPinTarget(term: BottomPinnableTerminal): TerminalBottomPinTarget {
  return {
    isAtBottom: () => isTerminalAtBottom(term),
    followBottom: () => {
      term.scrollToBottom();
    },
    scrollToBottom: () => {
      term.scrollToBottom();
    },
  };
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
// dead end if a selection scroll event cleared the intent.
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
