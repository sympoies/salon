import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createSessionSwipeTracker,
  sessionSwipeDirectionFromTravel,
  type SessionSwipeDirection,
} from "../src/sessionSwipe.ts";
import {
  SESSION_SWIPE_AXIS_DOMINANCE,
  SESSION_SWIPE_MIN_PX,
} from "../src/terminalTouch.ts";

test("a dominant leftward drag past the min distance advances to the next session", () => {
  assert.equal(sessionSwipeDirectionFromTravel(-(SESSION_SWIPE_MIN_PX + 20), 4), "next");
});

test("a dominant rightward drag past the min distance returns to the previous session", () => {
  assert.equal(sessionSwipeDirectionFromTravel(SESSION_SWIPE_MIN_PX + 20, -4), "previous");
});

test("a short horizontal drag below the min distance is not a swipe", () => {
  assert.equal(sessionSwipeDirectionFromTravel(-(SESSION_SWIPE_MIN_PX - 1), 0), null);
});

test("a vertical-dominant drag never switches sessions", () => {
  // Same horizontal travel as a valid swipe, but the finger moved much further
  // vertically — this is a scroll, not a session swipe.
  const dx = -(SESSION_SWIPE_MIN_PX + 20);
  const dy = Math.abs(dx) * (SESSION_SWIPE_AXIS_DOMINANCE + 1);
  assert.equal(sessionSwipeDirectionFromTravel(dx, dy), null);
});

test("the tracker commits a single-finger left drag as a next-session swipe", () => {
  const swipes: SessionSwipeDirection[] = [];
  const tracker = createSessionSwipeTracker((direction) => swipes.push(direction));
  tracker.start({ clientX: 220, clientY: 300 }, 1);
  tracker.move({ clientX: 130, clientY: 302 }, 1);
  assert.equal(tracker.end({ clientX: 120, clientY: 302 }), "next");
  assert.deepEqual(swipes, ["next"]);
});

test("the tracker uses the touchend release point when the last move fell short", () => {
  const swipes: SessionSwipeDirection[] = [];
  const tracker = createSessionSwipeTracker((direction) => swipes.push(direction));
  tracker.start({ clientX: 200, clientY: 300 }, 1);
  // A coalesced last move short of the threshold, but the finger lifted well past it.
  tracker.move({ clientX: 180, clientY: 301 }, 1);
  assert.equal(tracker.end({ clientX: 120, clientY: 302 }), "next");
  assert.deepEqual(swipes, ["next"]);
});

test("the tracker ignores a multi-touch gesture (pinch/zoom is not a swipe)", () => {
  const swipes: SessionSwipeDirection[] = [];
  const tracker = createSessionSwipeTracker((direction) => swipes.push(direction));
  tracker.start({ clientX: 220, clientY: 300 }, 2);
  tracker.move({ clientX: 120, clientY: 302 }, 2);
  assert.equal(tracker.end({ clientX: 120, clientY: 302 }), null);
  assert.deepEqual(swipes, []);
});

test("the tracker cancels when a second touch joins an active drag", () => {
  const swipes: SessionSwipeDirection[] = [];
  const tracker = createSessionSwipeTracker((direction) => swipes.push(direction));
  tracker.start({ clientX: 220, clientY: 300 }, 1);
  tracker.move({ clientX: 120, clientY: 302 }, 2);
  assert.equal(tracker.end({ clientX: 120, clientY: 302 }), null);
  assert.deepEqual(swipes, []);
});

test("a cancelled gesture never commits a later swipe", () => {
  const swipes: SessionSwipeDirection[] = [];
  const tracker = createSessionSwipeTracker((direction) => swipes.push(direction));
  tracker.start({ clientX: 220, clientY: 300 }, 1);
  tracker.move({ clientX: 120, clientY: 301 }, 1);
  tracker.cancel();
  assert.equal(tracker.end(), null);
  assert.deepEqual(swipes, []);
});
