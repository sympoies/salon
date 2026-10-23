import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createTerminalTouchBridge,
  MOUSE_WHEEL_LINES_PER_NOTCH,
  MOUSE_WHEEL_NOTCH_MIN_PX,
  mouseWheelForwardedNotchLines,
  TOUCH_LONG_PRESS_CANCEL_PX,
  type TerminalTouchBridgeOptions,
} from "../src/terminalTouch.ts";

type Calls = {
  suppressSynthMouse: number;
  releaseTouchMousePress: number;
  releaseAt: Array<{ x: number; y: number }>;
  emitWheel: number;
  beginSelection: number;
};

function makeBridge(overrides: Partial<TerminalTouchBridgeOptions> = {}) {
  const calls: Calls = {
    suppressSynthMouse: 0,
    releaseTouchMousePress: 0,
    releaseAt: [],
    emitWheel: 0,
    beginSelection: 0,
  };
  const timers: Array<{ callback: () => void }> = [];
  const options: TerminalTouchBridgeOptions = {
    emitWheel: () => {
      calls.emitWheel += 1;
    },
    showActivity: () => {},
    clearMenu: () => {},
    openMenu: () => {},
    beginSelection: () => {
      calls.beginSelection += 1;
    },
    extendSelection: () => {},
    releaseTouchMousePress: (x, y) => {
      calls.releaseTouchMousePress += 1;
      calls.releaseAt.push({ x, y });
    },
    suppressSynthMouse: () => {
      calls.suppressSynthMouse += 1;
    },
    setTimeout: ((cb: () => void) => {
      const timer = { callback: cb };
      timers.push(timer);
      return timer;
    }) as TerminalTouchBridgeOptions["setTimeout"],
    clearTimeout: ((timer: { callback: () => void }) => {
      const index = timers.indexOf(timer);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    }) as TerminalTouchBridgeOptions["clearTimeout"],
    ...overrides,
  };
  return { bridge: createTerminalTouchBridge(options), calls, timers };
}

function touch(x: number, y: number) {
  return { touches: [{ clientX: x, clientY: y }], preventDefault() {}, stopPropagation() {} };
}

test("touch drag routes to smooth viewport scroll when scrollViewportPixels claims it", () => {
  const pixels: number[] = [];
  const { bridge, calls } = makeBridge({
    scrollViewportPixels: (dy: number) => {
      pixels.push(dy);
      return true;
    },
  });
  bridge.onTouchStart(touch(100, 400));
  bridge.onTouchMove(touch(100, 340)); // up 60px
  bridge.onTouchMove(touch(100, 300)); // up another 40px
  assert.equal(calls.emitWheel, 0, "smooth viewport scroll must not also emit discrete wheel notches");
  assert.ok(pixels.length >= 2, "each move forwards its raw finger delta to the viewport scroller");
  const total = pixels.reduce((sum, dy) => sum + dy, 0);
  assert.equal(Math.round(total), -100, "an upward drag reports the summed negative finger delta");
});

test("touch drag falls back to discrete wheel notches when scrollViewportPixels declines", () => {
  const { bridge, calls } = makeBridge({
    scrollViewportPixels: () => false,
  });
  bridge.onTouchStart(touch(100, 400));
  bridge.onTouchMove(touch(100, 320)); // up 80px
  bridge.onTouchMove(touch(100, 260)); // up another 60px
  assert.ok(calls.emitWheel > 0, "a declined viewport scroll falls back to wheel notches (mouse/alt buffer)");
});

test("touch bridge releases the forwarded press at the press cell as soon as a scroll passes the tap threshold", () => {
  const { bridge, calls } = makeBridge();
  bridge.onTouchStart(touch(100, 400));
  // A small move just past the 8px tap/drag boundary — still far below the ~24px
  // needed to emit the first wheel step. The press must already be released (as a
  // click at the touch-start cell) so a mouse-mode TUI does not drag-select.
  bridge.onTouchMove(touch(100, 400 - (TOUCH_LONG_PRESS_CANCEL_PX + 1)));

  assert.equal(calls.suppressSynthMouse, 1, "suppression armed at the tap threshold");
  assert.equal(calls.releaseTouchMousePress, 1, "press released once");
  assert.deepEqual(calls.releaseAt, [{ x: 100, y: 400 }], "released at the touch-start cell, not the current point");
  assert.equal(calls.emitWheel, 0, "no wheel step emitted yet at this distance");
});

test("touch bridge leaves a clean stationary tap alone so its synth click focuses xterm", () => {
  const { bridge, calls } = makeBridge();
  bridge.onTouchStart(touch(100, 400));
  // No movement past the threshold: a clean tap must not arm suppression or
  // release a press, or the Android WebView keyboard never opens (only a real
  // synth click raises it) and the app never receives the tap.
  bridge.onTouchMove(touch(101, 401));
  assert.equal(bridge.endTouch(), "tap");

  assert.equal(calls.suppressSynthMouse, 0);
  assert.equal(calls.releaseTouchMousePress, 0);
});

test("touch bridge still taps when a finger wobbles past the long-press cancel distance", () => {
  // A thumb aiming at a small target (a rendered link label is a few cells
  // wide) routinely drifts more than the 8px long-press cancel distance and
  // then lifts where it started. That is a tap, not a drag: classifying it as
  // a scroll silently swallows the gesture, which is how tapping a link ended
  // up doing nothing at all.
  const { bridge } = makeBridge();
  bridge.onTouchStart(touch(100, 400));
  bridge.onTouchMove(touch(111, 404));

  assert.equal(bridge.endTouch({ clientX: 101, clientY: 401 }), "tap");
});

test("touch bridge taps when a horizontal wobble locks the swipe axis but never commits", () => {
  // The swipe axis locks at 12px, well inside a thumb's jitter. Below the 64px
  // commit distance the gesture used to end as a dead "scroll": no session
  // switch, no scrolling, and no tap — a silent black hole between 12px and
  // 63px of horizontal travel.
  const swipes: string[] = [];
  const { bridge } = makeBridge({
    onHorizontalSwipe: (direction: string) => swipes.push(direction),
  } as Partial<TerminalTouchBridgeOptions>);
  bridge.onTouchStart(touch(100, 400));
  bridge.onTouchMove(touch(114, 401));

  assert.equal(bridge.endTouch({ clientX: 103, clientY: 400 }), "tap");
  assert.deepEqual(swipes, [], "a wobble must not switch sessions");
});

test("touch bridge keeps a real drag out of the tap path", () => {
  // The rescue is bounded: a gesture that travels well past the slop is a
  // drag even when the finger happens to lift near where it started.
  const { bridge } = makeBridge();
  bridge.onTouchStart(touch(100, 400));
  bridge.onTouchMove(touch(100, 340));
  bridge.onTouchMove(touch(100, 300));
  bridge.onTouchMove(touch(100, 402));

  assert.equal(bridge.endTouch({ clientX: 100, clientY: 401 }), "scroll");
});

test("a rescued tap never starts an inertial coast", () => {
  // Flick velocity is an inter-move average, independent of distance from the
  // start, so a fast wobble inside the slop can satisfy it. A tap that coasts
  // would pump wheel escapes into a tracking TUI and drop the pane out of its
  // bottom pin.
  let clock = 0;
  const { bridge, calls, timers } = makeBridge({
    now: () => clock,
    scrollViewportPixels: () => false,
  } as Partial<TerminalTouchBridgeOptions>);
  bridge.onTouchStart(touch(100, 400));
  clock = 16;
  bridge.onTouchMove(touch(100, 409));
  clock = 32;
  bridge.onTouchMove(touch(100, 394));

  assert.equal(bridge.endTouch({ clientX: 100, clientY: 401 }), "tap");
  assert.equal(timers.length, 0, "a tap schedules no momentum tick");
  assert.equal(calls.emitWheel, 0, "a tap emits no wheel step");
});

test("a long press that drifted past the cancel distance is not rescued as a tap", () => {
  // The 8px threshold already cancelled the long press, so the toolbar was
  // lost; the release must stay inert rather than activating the link the
  // finger was resting on.
  let clock = 0;
  const { bridge } = makeBridge({ now: () => clock } as Partial<TerminalTouchBridgeOptions>);
  bridge.onTouchStart(touch(100, 400));
  clock = 60;
  bridge.onTouchMove(touch(104, 409));
  clock = 2000;

  assert.equal(bridge.endTouch({ clientX: 104, clientY: 410 }), "scroll");
});

test("a gesture that scrolled the buffer is never rescued as a tap", () => {
  // Scrolling moves the row a tap would resolve against; on the non-tracking
  // path that opens an implicit URL from the adjacent row with no
  // confirmation. Distance alone cannot catch it, because the viewport path
  // amplifies the finger delta and can cross a cell inside the slop.
  const { bridge } = makeBridge({
    scrollViewportPixels: () => true,
  });
  bridge.onTouchStart(touch(100, 400));
  bridge.onTouchMove(touch(100, 407));
  bridge.onTouchMove(touch(100, 414));

  assert.equal(bridge.endTouch({ clientX: 100, clientY: 415 }), "scroll");
});

test("the sub-cell visual preview alone still leaves the gesture a tap", () => {
  // A mouse-tracking pane declines the viewport scroll and only composites a
  // transform over the rendered rows. No buffer row moves, so the gesture is
  // still eligible to be a tap.
  const { bridge, calls } = makeBridge({
    scrollViewportPixels: () => false,
    wheelStepPx: () => 100,
  } as Partial<TerminalTouchBridgeOptions>);
  bridge.onTouchStart(touch(100, 400));
  bridge.onTouchMove(touch(100, 407));
  bridge.onTouchMove(touch(100, 414));

  assert.equal(bridge.endTouch({ clientX: 100, clientY: 415 }), "tap");
  assert.equal(calls.emitWheel, 0, "no semantic row was emitted");
});

test("touch bridge classifies a stationary long press as selection, never a link tap", () => {
  let menuOpens = 0;
  const { bridge, calls, timers } = makeBridge({
    openMenu: () => {
      menuOpens += 1;
    },
  });
  bridge.onTouchStart(touch(100, 400));
  assert.equal(timers.length, 1, "long-press timer was armed");
  timers[0]?.callback();

  assert.equal(calls.beginSelection, 1);
  assert.equal(calls.suppressSynthMouse, 1);
  assert.equal(bridge.endTouch(), "selection");
  assert.equal(menuOpens, 1, "selection release opens the copy menu");
});

test("touch bridge releases the press once but re-arms suppression on every scroll move", () => {
  const { bridge, calls } = makeBridge();
  bridge.onTouchStart(touch(100, 400));
  bridge.onTouchMove(touch(100, 360));
  bridge.onTouchMove(touch(100, 320));
  bridge.onTouchMove(touch(100, 280));

  // The press is released once (turning the forwarded gesture into a single
  // click), but suppression is re-armed each move so a long scroll never outlives
  // the 700ms window and lets a trailing compat mouse event reach the app.
  assert.equal(calls.releaseTouchMousePress, 1, "press released exactly once per gesture");
  assert.equal(calls.suppressSynthMouse, 3, "suppression re-armed on each move");
  assert.ok(calls.emitWheel > 0, "a longer drag still emits wheel steps to scroll");
  assert.equal(bridge.endTouch(), "scroll", "a scroll cannot fall through to link activation");
});

test("a dominant left swipe switches to the next session without scrolling the terminal", () => {
  const swipes: string[] = [];
  const options: Partial<TerminalTouchBridgeOptions> & {
    onHorizontalSwipe: (direction: string) => void;
  } = {
    onHorizontalSwipe: (direction) => swipes.push(direction),
  };
  const { bridge, calls } = makeBridge(options);

  bridge.onTouchStart(touch(220, 300));
  bridge.onTouchMove(touch(130, 302));

  assert.equal(bridge.endTouch(), "swipe");
  assert.deepEqual(swipes, ["next"]);
  assert.equal(calls.emitWheel, 0, "a session swipe never emits terminal wheel steps");
  assert.equal(calls.releaseTouchMousePress, 0, "navigation never completes a forwarded TUI click");
});

test("a dominant right swipe switches to the previous session", () => {
  const swipes: string[] = [];
  const options: Partial<TerminalTouchBridgeOptions> & {
    onHorizontalSwipe: (direction: string) => void;
  } = {
    onHorizontalSwipe: (direction) => swipes.push(direction),
  };
  const { bridge } = makeBridge(options);

  bridge.onTouchStart(touch(100, 300));
  bridge.onTouchMove(touch(190, 298));

  assert.equal(bridge.endTouch(), "swipe");
  assert.deepEqual(swipes, ["previous"]);
});

test("short horizontal drags and vertical scrolls never switch sessions", () => {
  const swipes: string[] = [];
  const options: Partial<TerminalTouchBridgeOptions> & {
    onHorizontalSwipe: (direction: string) => void;
  } = {
    onHorizontalSwipe: (direction) => swipes.push(direction),
  };
  const short = makeBridge(options);
  short.bridge.onTouchStart(touch(200, 300));
  short.bridge.onTouchMove(touch(165, 302));
  short.bridge.endTouch();

  const vertical = makeBridge(options);
  vertical.bridge.onTouchStart(touch(200, 300));
  vertical.bridge.onTouchMove(touch(196, 220));
  assert.equal(vertical.bridge.endTouch(), "scroll");

  assert.deepEqual(swipes, []);
  assert.ok(vertical.calls.emitWheel > 0, "vertical motion retains terminal scrolling");
});

test("a cancelled horizontal gesture clears state without switching sessions", () => {
  const swipes: string[] = [];
  const options: Partial<TerminalTouchBridgeOptions> & {
    onHorizontalSwipe: (direction: string) => void;
  } = {
    onHorizontalSwipe: (direction) => swipes.push(direction),
  };
  const { bridge } = makeBridge(options);

  bridge.onTouchStart(touch(220, 300));
  bridge.onTouchMove(touch(120, 301));
  bridge.cancelTouch();

  assert.deepEqual(swipes, []);
  assert.equal(bridge.endTouch(), "none", "cancel leaves no gesture to commit later");
});

test("a fast horizontal flick swipes using the touchend release point, not the last move", () => {
  const swipes: string[] = [];
  const options: Partial<TerminalTouchBridgeOptions> & {
    onHorizontalSwipe: (direction: string) => void;
  } = {
    onHorizontalSwipe: (direction) => swipes.push(direction),
  };
  const { bridge, calls } = makeBridge(options);

  bridge.onTouchStart(touch(220, 300));
  // The last coalesced touchmove is only 30px — below the 64px swipe threshold —
  // but the finger actually lifted 100px away in a fast flick.
  bridge.onTouchMove(touch(190, 302));
  assert.equal(bridge.endTouch({ clientX: 120, clientY: 302 }), "swipe");
  assert.deepEqual(swipes, ["next"], "the release point crossing the threshold commits the swipe");
  assert.equal(calls.emitWheel, 0, "a session swipe never emits terminal wheel steps");
});

test("a horizontal drag that returns near its start before lift stays a scroll", () => {
  const swipes: string[] = [];
  const options: Partial<TerminalTouchBridgeOptions> & {
    onHorizontalSwipe: (direction: string) => void;
  } = {
    onHorizontalSwipe: (direction) => swipes.push(direction),
  };
  const { bridge } = makeBridge(options);

  bridge.onTouchStart(touch(220, 300));
  // Finger travels far then comes back; the release point is only 20px from start.
  bridge.onTouchMove(touch(120, 302));
  assert.equal(bridge.endTouch({ clientX: 200, clientY: 302 }), "scroll");
  assert.deepEqual(swipes, [], "a release below the threshold is not a swipe");
});

test("touch bridge re-arms suppression at a non-tap commit so a paused lift cannot leak a compat click", () => {
  const { bridge, calls } = makeBridge();
  bridge.onTouchStart(touch(100, 400));
  bridge.onTouchMove(touch(100, 360));
  const armedBeforeCommit = calls.suppressSynthMouse;
  assert.equal(bridge.endTouch(), "scroll");
  assert.equal(
    calls.suppressSynthMouse,
    armedBeforeCommit + 1,
    "committing a scroll re-arms the fixed suppression window at the moment of lift",
  );
});

test("a committed swipe re-arms suppression so a late compat click cannot reach the new session", () => {
  const swipes: string[] = [];
  const options: Partial<TerminalTouchBridgeOptions> & {
    onHorizontalSwipe: (direction: string) => void;
  } = {
    onHorizontalSwipe: (direction) => swipes.push(direction),
  };
  const { bridge, calls } = makeBridge(options);

  bridge.onTouchStart(touch(220, 300));
  bridge.onTouchMove(touch(120, 302));
  const armedBeforeCommit = calls.suppressSynthMouse;
  assert.equal(bridge.endTouch(), "swipe");
  assert.equal(
    calls.suppressSynthMouse,
    armedBeforeCommit + 1,
    "committing a swipe re-arms suppression after navigation",
  );
});

// A scheduler + clock that lets a test drive the momentum coast deterministically.
function makeScrollBridge(wheelStepPx: number) {
  const wheels: number[] = [];
  const timers: Array<(() => void) | null> = [];
  let clock = 0;
  const bridge = createTerminalTouchBridge({
    emitWheel: (w) => wheels.push(w.deltaY),
    wheelStepPx: () => wheelStepPx,
    now: () => clock,
    showActivity: () => {},
    clearMenu: () => {},
    openMenu: () => {},
    setTimeout: ((cb: () => void) => {
      timers.push(cb);
      return timers.length;
    }) as TerminalTouchBridgeOptions["setTimeout"],
    clearTimeout: ((id: number) => {
      timers[id - 1] = null;
    }) as TerminalTouchBridgeOptions["clearTimeout"],
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  const setClock = (ms: number) => {
    clock = ms;
  };
  // Run the latest pending timer (momentum schedules one at a time) until none remain.
  const runPendingTimers = (maxTicks = 500) => {
    for (let i = 0; i < maxTicks; i += 1) {
      let idx = -1;
      for (let j = timers.length - 1; j >= 0; j -= 1) {
        if (timers[j]) {
          idx = j;
          break;
        }
      }
      if (idx < 0) break;
      const cb = timers[idx]!;
      timers[idx] = null;
      clock += 16;
      cb();
    }
  };
  const move = (x: number, y: number) =>
    bridge.onTouchMove({ touches: [{ clientX: x, clientY: y }], preventDefault() {}, stopPropagation() {} });
  const start = (x: number, y: number) => bridge.onTouchStart({ touches: [{ clientX: x, clientY: y }] });
  return { bridge, wheels, timers, advance, setClock, runPendingTimers, move, start };
}

test("a finer wheel step scrolls more for the same finger travel", () => {
  const coarse = makeScrollBridge(24);
  coarse.start(50, 300);
  coarse.setClock(16);
  coarse.move(50, 204); // 96px up in one move
  const fine = makeScrollBridge(8);
  fine.start(50, 300);
  fine.setClock(16);
  fine.move(50, 204); // same 96px
  assert.equal(coarse.wheels.length, 4, "96px / 24px step = 4 notches");
  assert.equal(fine.wheels.length, 12, "96px / 8px step = 12 notches (finer = more scroll)");
});

test("a fast flick coasts with decaying momentum after release", () => {
  const s = makeScrollBridge(16);
  s.start(50, 400);
  // fast upward flick: ~3 px/ms
  s.setClock(10);
  s.move(50, 370);
  s.setClock(20);
  s.move(50, 340);
  const duringDrag = s.wheels.length;
  s.bridge.endTouch();
  s.runPendingTimers();
  const afterCoast = s.wheels.length;
  assert.ok(afterCoast > duringDrag, "momentum emitted extra wheel steps after the finger lifted");
  // A coast is finite: all momentum timers eventually stop.
  assert.equal(s.timers.filter(Boolean).length, 0, "momentum settles (no timer left pending)");
});

test("a slow release does not trigger momentum", () => {
  const s = makeScrollBridge(16);
  s.start(50, 400);
  // slow drag: 20px over 200ms = 0.1 px/ms, below the flick threshold
  s.setClock(100);
  s.move(50, 390);
  s.setClock(200);
  s.move(50, 380);
  const duringDrag = s.wheels.length;
  s.bridge.endTouch();
  s.runPendingTimers();
  assert.equal(s.wheels.length, duringDrag, "no coast after a slow release");
});

test("a new touch cancels an in-flight momentum coast", () => {
  const s = makeScrollBridge(16);
  s.start(50, 400);
  s.setClock(10);
  s.move(50, 370);
  s.setClock(20);
  s.move(50, 340);
  s.bridge.endTouch(); // schedules momentum
  s.start(50, 200); // a new touch must stop the coast
  const afterCancel = s.wheels.length;
  s.runPendingTimers();
  assert.equal(s.wheels.length, afterCancel, "coast stopped by the new touch");
});

test("cancelling touch stops active and in-flight momentum without scheduling more work", () => {
  const active = makeScrollBridge(16);
  active.start(50, 400);
  active.setClock(10);
  active.move(50, 370);
  active.setClock(20);
  active.move(50, 340);
  const activeWheels = active.wheels.length;
  active.bridge.cancelTouch();
  assert.equal(active.timers.filter(Boolean).length, 0, "cancelling an active drag does not start a coast");
  active.runPendingTimers();
  assert.equal(active.wheels.length, activeWheels, "cancelled drag emits no later wheel rows");

  const coasting = makeScrollBridge(16);
  coasting.start(50, 400);
  coasting.setClock(10);
  coasting.move(50, 370);
  coasting.setClock(20);
  coasting.move(50, 340);
  coasting.bridge.endTouch();
  assert.ok(coasting.timers.some(Boolean), "release starts momentum before cancellation");
  const coastWheels = coasting.wheels.length;
  coasting.bridge.cancelTouch();
  assert.equal(coasting.timers.filter(Boolean).length, 0, "cancelling an in-flight coast clears its timer");
  coasting.runPendingTimers();
  assert.equal(coasting.wheels.length, coastWheels, "cancelled coast emits no later wheel rows");
});

// In a mouse-tracking TUI (codex/claude) xterm forwards exactly one wheel escape
// per DOM wheel event regardless of the delta size. mouseWheelForwardedNotchLines
// decides how many escapes to forward for a real wheel event so a discrete mouse
// notch scrolls a meaningful amount while trackpad fine-scroll is left untouched.
const PIXEL = 0;
const LINE = 1;
const PAGE = 2;

test("a discrete pixel-mode mouse notch forwards several wheel escapes", () => {
  // A wheel notch reports a coarse pixel delta; forward LINES_PER_NOTCH escapes,
  // sign following the scroll direction.
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: 120, deltaMode: PIXEL }), MOUSE_WHEEL_LINES_PER_NOTCH);
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: -120, deltaMode: PIXEL }), -MOUSE_WHEEL_LINES_PER_NOTCH);
});

test("a trackpad fine-scroll passes through unchanged (0 = let xterm forward its one escape)", () => {
  // Small pixel deltas are trackpad ticks: return 0 so the existing one-escape
  // behavior (which already feels fast on a trackpad) is preserved exactly.
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: 8, deltaMode: PIXEL }), 0);
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: -12, deltaMode: PIXEL }), 0);
  // Just below the notch threshold is still a trackpad tick.
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: MOUSE_WHEEL_NOTCH_MIN_PX - 1, deltaMode: PIXEL }), 0);
  // At the threshold it counts as a notch.
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: MOUSE_WHEEL_NOTCH_MIN_PX, deltaMode: PIXEL }), MOUSE_WHEEL_LINES_PER_NOTCH);
});

test("line- and page-mode deltas are always discrete notches", () => {
  // Trackpads report pixels; a line/page delta is a real wheel notch (e.g. Firefox).
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: 1, deltaMode: LINE }), MOUSE_WHEEL_LINES_PER_NOTCH);
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: -3, deltaMode: LINE }), -MOUSE_WHEEL_LINES_PER_NOTCH);
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: 1, deltaMode: PAGE }), MOUSE_WHEEL_LINES_PER_NOTCH);
});

test("a zero delta forwards nothing", () => {
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: 0, deltaMode: PIXEL }), 0);
  assert.equal(mouseWheelForwardedNotchLines({ deltaY: 0, deltaMode: LINE }), 0);
});

test("the notch step and threshold are tunable per call", () => {
  assert.equal(
    mouseWheelForwardedNotchLines({ deltaY: 120, deltaMode: PIXEL }, { linesPerNotch: 6 }),
    6,
  );
  // A higher threshold lets a mid-size delta fall through as fine-scroll.
  assert.equal(
    mouseWheelForwardedNotchLines({ deltaY: 60, deltaMode: PIXEL }, { notchMinPx: 100 }),
    0,
  );
});
