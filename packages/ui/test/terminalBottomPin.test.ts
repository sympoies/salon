import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createPlainBottomPinTarget,
  createTerminalBottomPin,
  isTerminalAtBottom,
  nextBottomPinIntent,
  shouldAutoPinBottom,
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

test("plain bottom pin target keeps the xterm bottom semantics", () => {
  const { active, term } = createFakeTerminal({ viewportY: 4, baseY: 5 });
  const target = createPlainBottomPinTarget(term);

  assert.equal(target.isAtBottom(), false);
  target.scrollToBottom();
  assert.equal(active.viewportY, 5);
  assert.equal(target.isAtBottom(), true);
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
