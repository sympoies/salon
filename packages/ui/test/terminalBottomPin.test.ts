import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createContentAwareBottomPinTarget,
  createPlainBottomPinTarget,
  createTerminalBottomPin,
  createTerminalBottomPinTarget,
  isTerminalAtBottom,
  nextBottomPinIntent,
  scrollToLastNonBlankLine,
  shouldAutoPinBottom,
  shouldUseContentAwareBottomPin,
  type BottomPinnableTerminal,
  type TerminalBottomPinScheduler,
} from "../src/terminalBottomPin.ts";

test("shouldAutoPinBottom never auto-scrolls while a text selection is active", () => {
  // With a selection, no combination of forced / keepPinned / atBottom scrolls:
  // auto-scrolling mid-drag reflows the selection so only the tail survives
  // (selecting "mac book" collapses to "book") and Cmd+C copies the wrong range.
  assert.equal(shouldAutoPinBottom({ forced: true, keepPinned: true, atBottom: true, hasSelection: true }), false);
  assert.equal(shouldAutoPinBottom({ forced: true, keepPinned: false, atBottom: false, hasSelection: true }), false);
  // Without a selection the prior pinning conditions still hold.
  assert.equal(shouldAutoPinBottom({ forced: true, keepPinned: false, atBottom: false, hasSelection: false }), true);
  assert.equal(shouldAutoPinBottom({ forced: false, keepPinned: true, atBottom: false, hasSelection: false }), true);
  assert.equal(shouldAutoPinBottom({ forced: false, keepPinned: false, atBottom: true, hasSelection: false }), true);
  assert.equal(shouldAutoPinBottom({ forced: false, keepPinned: false, atBottom: false, hasSelection: false }), false);
});

function createFakeTerminal({
  viewportY,
  baseY,
  settleAfterScrolls = 1,
}: {
  readonly viewportY: number;
  readonly baseY: number;
  readonly settleAfterScrolls?: number;
}) {
  const active = { viewportY, baseY };
  let scrolls = 0;
  const term: BottomPinnableTerminal = {
    buffer: { active },
    scrollToBottom: () => {
      scrolls += 1;
      if (scrolls >= settleAfterScrolls) {
        active.viewportY = active.baseY;
      }
    },
  };

  return { active, getScrolls: () => scrolls, term };
}

function createScheduler() {
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  const canceledFrames: number[] = [];
  const clearedTimers: number[] = [];
  let nextFrame = 0;
  let nextTimer = 0;

  const scheduler: TerminalBottomPinScheduler<number, number> = {
    requestAnimationFrame: (callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (handle) => {
      canceledFrames.push(handle);
      frames.delete(handle);
    },
    setTimeout: (callback, delayMs) => {
      assert.equal(delayMs, 50);
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (handle) => {
      clearedTimers.push(handle);
      timers.delete(handle);
    },
  };

  return {
    canceledFrames,
    clearedTimers,
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
    runFrame: (id: number) => {
      const callback = frames.get(id);
      frames.delete(id);
      callback?.(0);
    },
    runTimer: (id: number) => {
      const callback = timers.get(id);
      timers.delete(id);
      callback?.();
    },
    scheduler,
  };
}

test("terminal bottom detection follows xterm buffer viewport state", () => {
  const { active, term } = createFakeTerminal({ viewportY: 4, baseY: 5 });

  assert.equal(isTerminalAtBottom(term), false);
  active.viewportY = 5;
  assert.equal(isTerminalAtBottom(term), true);
  active.viewportY = 6;
  assert.equal(isTerminalAtBottom(term), true);
});

test("content-aware bottom pin is enabled only for DSH sessions", () => {
  assert.equal(shouldUseContentAwareBottomPin("dsh"), true);
  // The retired hermes base no longer pins like dsh.
  assert.equal(shouldUseContentAwareBottomPin("hermes"), false);
  assert.equal(shouldUseContentAwareBottomPin("codex"), false);
  assert.equal(shouldUseContentAwareBottomPin("claude"), false);
  assert.equal(shouldUseContentAwareBottomPin(undefined), false);
});

test("content-aware bottom pin scrolls the last nonblank row above tmux padding into view", () => {
  const lines = [
    "history 1",
    "history 2",
    "history 3",
    "history 4",
    "answer 1",
    "answer 2",
    "answer 3",
    "prompt",
    "status",
    "",
    "   ",
    "",
  ];
  const active = {
    viewportY: 7,
    baseY: 7,
    length: lines.length,
    getLine: (index: number) => ({
      translateToString: () => lines[index] ?? "",
    }),
  };
  const scrollLines: number[] = [];
  const term = {
    rows: 5,
    buffer: { active },
    scrollToBottom: () => {
      active.viewportY = active.baseY;
    },
    scrollToLine: (line: number) => {
      scrollLines.push(line);
      active.viewportY = line;
    },
  };

  scrollToLastNonBlankLine(term);

  assert.deepEqual(scrollLines, [4]);
  assert.equal(active.viewportY, 4);
});

test("content-aware bottom pin allows exact placement for forced attach and layout sync", () => {
  const lines = ["history", "answer", "prompt", "", ""];
  const active = {
    viewportY: 2,
    baseY: 2,
    length: lines.length,
    getLine: (index: number) => ({
      translateToString: () => lines[index] ?? "",
    }),
  };
  const scrollLines: number[] = [];
  const target = createContentAwareBottomPinTarget({
    rows: 3,
    buffer: { active },
    scrollToBottom: () => {
      active.viewportY = active.baseY;
    },
    scrollToLine: (line: number) => {
      scrollLines.push(line);
      active.viewportY = line;
    },
  });
  const scheduler = createScheduler();
  const pin = createTerminalBottomPin(target, scheduler.scheduler);

  pin.request({ forceExact: true });

  assert.deepEqual(scrollLines, [0]);
  assert.equal(active.viewportY, 0);
});

test("content-aware bottom pin reaches a moving dsh footer without smooth-scroll lag", () => {
  const lines = ["history", "answer", "plan 1", "plan 2", "", ""];
  const active = {
    viewportY: 0,
    baseY: 3,
    length: lines.length,
    getLine: (index: number) => ({
      translateToString: () => lines[index] ?? "",
    }),
  };
  const options = { smoothScrollDuration: 120 };
  let animatedTarget: number | undefined;
  const target = createContentAwareBottomPinTarget({
    rows: 3,
    options,
    buffer: { active },
    scrollToBottom: () => {
      active.viewportY = active.baseY;
    },
    scrollToLine: (line: number) => {
      if (options.smoothScrollDuration > 0) {
        // xterm 6 routes scrollToLine through its animated browser viewport.
        // A dsh prompt/plan redraw can move the footer again before this target
        // lands, leaving the viewport between targets and latching follow off.
        animatedTarget = line;
        return;
      }
      animatedTarget = undefined;
      active.viewportY = line;
    },
  });

  target.scrollToBottom();

  assert.equal(active.viewportY, 1, "the plan footer is pinned in the same turn");
  assert.equal(animatedTarget, undefined, "no stale animated target remains behind the redraw");
  assert.equal(options.smoothScrollDuration, 120, "ordinary user scrolling keeps its configured smoothing");

  // A long prompt wraps onto another row and moves the last nonblank line while
  // the same terminal stays mounted. Each programmatic pin must land atomically
  // rather than making the whole transcript chase overlapping animations.
  lines.splice(4, 0, "wrapped prompt row");
  active.baseY += 1;
  active.length = lines.length;
  target.scrollToBottom();

  assert.equal(active.viewportY, 2);
  assert.equal(animatedTarget, undefined);
  assert.equal(options.smoothScrollDuration, 120);
});

test("content-aware bottom follow is monotonic across a dsh prompt redraw", () => {
  const lines = [
    "history 1",
    "history 2",
    "answer",
    "plan",
    "prompt",
    "status",
    "",
    "",
  ];
  const active = {
    viewportY: 3,
    baseY: 5,
    length: lines.length,
    getLine: (index: number) => ({
      translateToString: () => lines[index] ?? "",
    }),
  };
  const scrollLines: number[] = [];
  const target = createContentAwareBottomPinTarget({
    rows: 3,
    buffer: { active },
    scrollToBottom: () => {
      active.viewportY = active.baseY;
    },
    scrollToLine: (line: number) => {
      scrollLines.push(line);
      active.viewportY = line;
    },
  });
  const scheduler = createScheduler();
  const pin = createTerminalBottomPin(target, scheduler.scheduler);

  // dsh clears the prompt/status rows before repainting them for each input
  // update. A normal follow must not chase that transient older content and
  // then jump down again when the prompt returns.
  lines[4] = "";
  lines[5] = "";
  pin.request();
  assert.equal(active.viewportY, 3);
  assert.deepEqual(scrollLines, []);

  lines[4] = "prompt with newly typed text";
  lines[5] = "status";
  pin.request();
  assert.equal(active.viewportY, 3);
  assert.deepEqual(scrollLines, []);

  // New content below the current target still advances the viewport.
  lines[6] = "wrapped prompt row";
  pin.request();
  assert.equal(active.viewportY, 4);
  assert.deepEqual(scrollLines, [4]);

  // Explicit attach/layout synchronization retains the exact-placement path.
  lines[4] = "";
  lines[5] = "";
  lines[6] = "";
  pin.request({ forceExact: true });
  assert.equal(active.viewportY, 1);
  assert.deepEqual(scrollLines, [4, 1]);
});

test("terminal bottom pin retries across frame and settle phases", () => {
  const { active, getScrolls, term } = createFakeTerminal({
    viewportY: 0,
    baseY: 20,
    settleAfterScrolls: 3,
  });
  const scheduler = createScheduler();
  const pin = createTerminalBottomPin(term, scheduler.scheduler);

  pin.request();
  assert.equal(getScrolls(), 1);
  assert.equal(active.viewportY, 0);
  assert.equal(scheduler.pendingFrames(), 1);
  assert.equal(scheduler.pendingTimers(), 1);

  scheduler.runFrame(1);
  assert.equal(getScrolls(), 2);
  assert.equal(active.viewportY, 0);

  scheduler.runTimer(1);
  assert.equal(getScrolls(), 3);
  assert.equal(active.viewportY, 20);
  assert.equal(scheduler.pendingFrames(), 0);
  assert.equal(scheduler.pendingTimers(), 0);

  pin.dispose();
  assert.deepEqual(scheduler.canceledFrames, []);
  assert.deepEqual(scheduler.clearedTimers, []);
});

test("terminal bottom pin cancels pending retries on dispose", () => {
  const { term } = createFakeTerminal({
    viewportY: 0,
    baseY: 20,
    settleAfterScrolls: 3,
  });
  const scheduler = createScheduler();
  const pin = createTerminalBottomPin(term, scheduler.scheduler);

  pin.request();
  pin.dispose();

  assert.equal(scheduler.pendingFrames(), 0);
  assert.equal(scheduler.pendingTimers(), 0);
  assert.deepEqual(scheduler.canceledFrames, [1]);
  assert.deepEqual(scheduler.clearedTimers, [1]);
});

// Models the xterm 6.0 paths that produce the DSH freeze, and only those:
// BufferService.scrollLines' isUserScrolling latch and ydisp clamp,
// BufferService.scroll's "advance ydisp unless the user scrolled" rule, and
// CoreTerminal.scrollToLine's zero-delta early return. Deliberately out of
// scope: the trimmed-buffer branch of BufferService.scroll (scrollback full),
// alt-buffer behavior, and reflow. A content-aware pin lands the viewport ABOVE
// baseY (skipping tmux's blank padding), which both latches isUserScrolling and
// — before this regression test — made the at-bottom test read every successful
// pin as "the user scrolled away".
function createStreamingTerminal({ rows, padding }: { readonly rows: number; readonly padding: number }) {
  const lines: string[] = Array.from({ length: rows }, () => "");
  const scrollListeners: Array<(viewportY: number) => void> = [];
  let viewportY = 0;
  let isUserScrolling = false;
  const baseY = () => Math.max(0, lines.length - rows);
  const fire = () => {
    for (const listener of scrollListeners) {
      listener(viewportY);
    }
  };
  const scrollLines = (disp: number) => {
    if (disp < 0) {
      if (viewportY === 0) {
        return;
      }
      isUserScrolling = true;
    } else if (disp + viewportY >= baseY()) {
      isUserScrolling = false;
    }
    const previous = viewportY;
    viewportY = Math.max(0, Math.min(viewportY + disp, baseY()));
    if (previous === viewportY) {
      return;
    }
    fire();
  };
  const term = {
    rows,
    buffer: {
      active: {
        get viewportY() {
          return viewportY;
        },
        get baseY() {
          return baseY();
        },
        get length() {
          return lines.length;
        },
        getLine: (index: number) => ({ translateToString: () => lines[index] ?? "" }),
      },
    },
    scrollToBottom: () => scrollLines(baseY() - viewportY),
    // CoreTerminal.scrollToLine skips scrollLines entirely on a zero delta, so a
    // pin that is already on target never touches the isUserScrolling latch.
    scrollToLine: (line: number) => {
      const scrollAmount = line - viewportY;
      if (scrollAmount !== 0) {
        scrollLines(scrollAmount);
      }
    },
  };

  return {
    term,
    onScroll: (listener: (viewportY: number) => void) => scrollListeners.push(listener),
    // One daemon write: a content row lands above the still-blank padding tail.
    write: (text: string) => {
      lines.splice(lines.length - padding, 0, text);
      if (!isUserScrolling) {
        viewportY = baseY();
      }
      fire();
    },
    newestContentRow: () => lines[lines.length - padding - 1],
    lastVisibleContentRow: () =>
      lines
        .slice(viewportY, viewportY + rows)
        .filter((line) => line.trim().length > 0)
        .at(-1),
  };
}

test("content-aware bottom pin still reads as at bottom after parking above the buffer base", () => {
  const streaming = createStreamingTerminal({ rows: 5, padding: 2 });
  const target = createContentAwareBottomPinTarget(streaming.term);

  streaming.write("line 1");
  assert.equal(target.isAtBottom(), true);

  target.scrollToBottom();

  // The pin deliberately parks above baseY to hide the blank tmux padding, so
  // the plain xterm test disagrees with the pin's own notion of bottom.
  assert.ok(streaming.term.buffer.active.viewportY < streaming.term.buffer.active.baseY);
  assert.equal(isTerminalAtBottom(streaming.term), false);
  assert.equal(target.isAtBottom(), true);
});

test("content-aware bottom pin keeps following streamed output", () => {
  const streaming = createStreamingTerminal({ rows: 5, padding: 2 });
  const target = createContentAwareBottomPinTarget(streaming.term);
  let keepBottomPinned = true;
  streaming.onScroll(() => {
    keepBottomPinned = target.isAtBottom();
  });

  for (let index = 1; index <= 6; index += 1) {
    const pin = shouldAutoPinBottom({
      forced: false,
      keepPinned: keepBottomPinned,
      atBottom: target.isAtBottom(),
      hasSelection: false,
    });
    streaming.write(`line ${index}`);
    if (pin) {
      target.scrollToBottom();
    }
  }

  assert.equal(streaming.lastVisibleContentRow(), streaming.newestContentRow());
  assert.equal(streaming.lastVisibleContentRow(), "line 6");
});

test("content-aware bottom pin stops following once the user scrolls away", () => {
  const streaming = createStreamingTerminal({ rows: 5, padding: 2 });
  const target = createContentAwareBottomPinTarget(streaming.term);
  for (let index = 1; index <= 6; index += 1) {
    streaming.write(`line ${index}`);
    target.scrollToBottom();
  }

  streaming.term.scrollToLine(0);

  assert.equal(target.isAtBottom(), false);
});

test("plain bottom pin target keeps the xterm bottom semantics", () => {
  const { active, term } = createFakeTerminal({ viewportY: 4, baseY: 5 });
  const target = createPlainBottomPinTarget(term);

  assert.equal(target.programmaticScrollIsSynchronous, false);
  assert.equal(target.isAtBottom(), false);
  target.scrollToBottom();
  assert.equal(active.viewportY, 5);
  assert.equal(target.isAtBottom(), true);
});

test("bottom pin target selection follows the session agent", () => {
  const lines = ["answer", "", ""];
  const active = {
    viewportY: 0,
    baseY: 0,
    length: lines.length,
    getLine: (index: number) => ({ translateToString: () => lines[index] ?? "" }),
  };
  const scrolledToLine: number[] = [];
  let scrolledToBottom = 0;
  const term = {
    rows: 3,
    buffer: { active },
    scrollToBottom: () => {
      scrolledToBottom += 1;
    },
    scrollToLine: (line: number) => {
      scrolledToLine.push(line);
    },
  };

  const contentTarget = createTerminalBottomPinTarget(term, "dsh");
  assert.equal(contentTarget.programmaticScrollIsSynchronous, true);
  contentTarget.scrollToBottom();
  assert.deepEqual(scrolledToLine, [0]);
  assert.equal(scrolledToBottom, 0);

  const plainTarget = createTerminalBottomPinTarget(term, "codex");
  assert.equal(plainTarget.programmaticScrollIsSynchronous, false);
  plainTarget.scrollToBottom();
  assert.equal(scrolledToBottom, 1);
  assert.deepEqual(scrolledToLine, [0]);
});

test("bottom pin intent freezes while a selection holds the pin", () => {
  // Without a selection the viewport is the authority.
  assert.equal(nextBottomPinIntent({ hasSelection: false, isAtBottom: true, keepPinned: false }), true);
  assert.equal(nextBottomPinIntent({ hasSelection: false, isAtBottom: false, keepPinned: true }), false);
  // With a selection the pin is paused, so the viewport reports our pause rather
  // than the user's intent and the recorded intent has to survive untouched.
  assert.equal(nextBottomPinIntent({ hasSelection: true, isAtBottom: false, keepPinned: true }), true);
  assert.equal(nextBottomPinIntent({ hasSelection: true, isAtBottom: true, keepPinned: false }), false);
});

test("content-aware bottom pin resumes following after a text selection clears", () => {
  const streaming = createStreamingTerminal({ rows: 5, padding: 2 });
  const target = createContentAwareBottomPinTarget(streaming.term);
  let keepBottomPinned = true;
  let hasSelection = false;
  const observeViewport = () => {
    keepBottomPinned = nextBottomPinIntent({
      hasSelection,
      isAtBottom: target.isAtBottom(),
      keepPinned: keepBottomPinned,
    });
  };
  streaming.onScroll(observeViewport);
  const stream = (text: string) => {
    const pin = shouldAutoPinBottom({
      forced: false,
      keepPinned: keepBottomPinned,
      atBottom: target.isAtBottom(),
      hasSelection,
    });
    streaming.write(text);
    if (pin) {
      target.scrollToBottom();
    }
  };

  for (let index = 1; index <= 4; index += 1) {
    stream(`line ${index}`);
  }
  assert.equal(streaming.lastVisibleContentRow(), "line 4");

  // The user drags a selection: output keeps arriving but the pin stays paused
  // so Cmd+C copies the range they actually chose.
  hasSelection = true;
  for (let index = 5; index <= 7; index += 1) {
    stream(`line ${index}`);
  }
  assert.equal(streaming.lastVisibleContentRow(), "line 4");
  assert.equal(keepBottomPinned, true);

  // Selection cleared, mirroring onSelectionChange: pin straight away on the
  // intent that survived the pause, and let the resulting scroll re-observe the
  // viewport. Recomputing the intent *before* that pin would read the still
  // stale viewport and latch the follow off — the freeze this fix removes.
  hasSelection = false;
  if (keepBottomPinned) {
    target.scrollToBottom();
  }
  assert.equal(streaming.lastVisibleContentRow(), streaming.newestContentRow());
  assert.equal(streaming.lastVisibleContentRow(), "line 7");
  assert.equal(keepBottomPinned, true);

  // And it keeps following from there.
  stream("line 8");
  assert.equal(streaming.lastVisibleContentRow(), streaming.newestContentRow());
  assert.equal(streaming.lastVisibleContentRow(), "line 8");
});

test("content-aware bottom pin reaches a blank xterm bottom synchronously", () => {
  const lines = ["", "", ""];
  const active = {
    viewportY: 0,
    baseY: 2,
    length: lines.length,
    getLine: (index: number) => ({ translateToString: () => lines[index] ?? "" }),
  };
  const options = { smoothScrollDuration: 120 };
  const scrolledToLine: number[] = [];
  let scrolledToBottom = 0;
  let animatedTarget: number | undefined;
  const target = createContentAwareBottomPinTarget({
    rows: 3,
    options,
    buffer: { active },
    scrollToBottom: () => {
      scrolledToBottom += 1;
      if (options.smoothScrollDuration > 0) {
        animatedTarget = active.baseY;
        return;
      }
      animatedTarget = undefined;
      active.viewportY = active.baseY;
    },
    scrollToLine: (line: number) => {
      scrolledToLine.push(line);
      if (options.smoothScrollDuration > 0) {
        animatedTarget = line;
        return;
      }
      animatedTarget = undefined;
      active.viewportY = line;
    },
  });
  const scheduler = createScheduler();
  const pin = createTerminalBottomPin(target, scheduler.scheduler);

  // Even before DSH paints its first nonblank row, the content-aware target
  // advertises synchronous programmatic movement so onScroll can distinguish
  // a real scroll-away from its own movement.
  assert.equal(target.isAtBottom(), false);
  pin.request({ forceExact: true });
  assert.equal(active.viewportY, 2);
  assert.equal(animatedTarget, undefined);
  assert.equal(options.smoothScrollDuration, 120);
  assert.equal(scrolledToBottom, 0);
  assert.deepEqual(scrolledToLine, [2]);

  // Ordinary following uses the same synchronous baseY fallback.
  active.viewportY = 0;
  pin.request();
  assert.equal(active.viewportY, 2);
  assert.equal(animatedTarget, undefined);
  assert.equal(options.smoothScrollDuration, 120);
  assert.equal(scrolledToBottom, 0);
  assert.deepEqual(scrolledToLine, [2, 2]);
});

test("content-aware bottom follow leaves a downward viewport settled in the padding region", () => {
  const streaming = createStreamingTerminal({ rows: 5, padding: 2 });
  const target = createContentAwareBottomPinTarget(streaming.term);
  for (let index = 1; index <= 8; index += 1) {
    streaming.write(`line ${index}`);
    target.scrollToBottom();
  }
  const contentBottom = streaming.term.buffer.active.viewportY;
  const baseY = streaming.term.buffer.active.baseY;
  assert.ok(contentBottom < baseY);

  // Scrolling up past the last content row is a real scroll-away.
  streaming.term.scrollToLine(contentBottom - 1);
  assert.equal(target.isAtBottom(), false);

  // Scrolling down into tmux's blank padding is still at the tail. A normal
  // follow and both settle passes must preserve that monotonic user movement
  // instead of pulling the viewport upward to the exact content target.
  streaming.term.scrollToLine(baseY);
  assert.equal(target.isAtBottom(), true);
  const scheduler = createScheduler();
  const pin = createTerminalBottomPin(target, scheduler.scheduler);
  pin.request();
  scheduler.runFrame(1);
  scheduler.runTimer(1);
  assert.equal(streaming.term.buffer.active.viewportY, baseY);
});

test("bottom pin retries yield when the user scrolls away inside the settle window", () => {
  const { active, term } = createFakeTerminal({ viewportY: 20, baseY: 20 });
  const scheduler = createScheduler();
  const pin = createTerminalBottomPin(term, scheduler.scheduler);

  pin.request();
  assert.equal(active.viewportY, 20);

  active.viewportY = 3;
  pin.cancel();
  assert.equal(scheduler.pendingFrames(), 0);
  assert.equal(scheduler.pendingTimers(), 0);
  scheduler.runFrame(1);
  assert.equal(active.viewportY, 3);

  scheduler.runTimer(1);
  assert.equal(active.viewportY, 3);
});
