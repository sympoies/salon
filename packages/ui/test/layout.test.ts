import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assignSlot,
  autoLayoutMode,
  compactSlotsAfterRemoval,
  isLayoutMode,
  LAYOUT_MODES,
  mobileSlotCount,
  parseLayoutMode,
  reconcileSlots,
  sessionKey,
  stepLayoutMode,
  swapSlots,
} from "../src/layout.ts";

const sessions = [
  { id: "a", machine: "summit" },
  { id: "b", machine: "summit" },
  { id: "c", machine: "mesa" },
];

test("sessionKey is stable across machines", () => {
  assert.equal(sessionKey(sessions[2]!), "mesa/c");
});

test("reconcileSlots removes missing and duplicate sessions, then fills empty slots", () => {
  const out = reconcileSlots(["summit/b", "missing/x", "summit/b", null], sessions, 4);
  assert.deepEqual(out, ["summit/b", "summit/a", "mesa/c", null]);
});

test("reconcileSlots preserves existing order when resizing available sessions", () => {
  assert.deepEqual(reconcileSlots(["summit/b"], sessions, 3), ["summit/b", "summit/a", "mesa/c"]);
  assert.deepEqual(reconcileSlots(["summit/b", "summit/a", "mesa/c"], sessions, 2), ["summit/b", "summit/a"]);
});

test("removing a middle session shifts every later pane before filling from overflow", () => {
  const current = ["summit/a", "summit/b", "summit/c", "summit/d"];
  const remaining = ["a", "c", "d", "e", "f"].map((id) => ({ id, machine: "summit" }));

  assert.deepEqual(compactSlotsAfterRemoval(
    current,
    new Set(["summit/b"]),
    remaining,
    ["summit/a", "summit/c", "summit/d", "summit/e", "summit/f"],
  ), [
    "summit/a",
    "summit/c",
    "summit/d",
    "summit/e",
  ]);
});

test("removal compaction handles multiple visible removals and ranked overflow", () => {
  const remaining = ["b", "d", "e", "f"].map((id) => ({ id, machine: "summit" }));
  assert.deepEqual(compactSlotsAfterRemoval(
    ["summit/b", "summit/a", "summit/c", "summit/d"],
    new Set(["summit/a", "summit/c"]),
    remaining,
    ["summit/b", "summit/d", "summit/f", "summit/e"],
  ), ["summit/b", "summit/d", "summit/f", "summit/e"]);
});

test("visible removal reprojects a local pane arrangement from the shared order", () => {
  const remaining = ["a", "b", "d", "e"].map((id) => ({ id, machine: "summit" }));
  assert.deepEqual(compactSlotsAfterRemoval(
    ["summit/d", "summit/b", "summit/c", "summit/a"],
    new Set(["summit/c"]),
    remaining,
    ["summit/a", "summit/b", "summit/d", "summit/e"],
  ), ["summit/a", "summit/b", "summit/d", "summit/e"]);
});

test("removing an off-grid session preserves the local pane arrangement", () => {
  const current = ["summit/a", null, "summit/c", "summit/d"];
  const remaining = ["a", "c", "d", "e"].map((id) => ({ id, machine: "summit" }));
  assert.deepEqual(compactSlotsAfterRemoval(
    current,
    new Set(["summit/off-grid"]),
    remaining,
    ["summit/d", "summit/c", "summit/a", "summit/e"],
  ), current);
});

test("removal compaction leaves only trailing empty panes in a fixed layout", () => {
  const remaining = ["a", "c"].map((id) => ({ id, machine: "summit" }));
  assert.deepEqual(compactSlotsAfterRemoval(
    ["summit/a", "summit/b", "summit/c", null],
    new Set(["summit/b"]),
    remaining,
    ["summit/a", "summit/c"],
  ), ["summit/a", "summit/c", null, null]);
});

test("assignSlot keeps a session in only one slot", () => {
  assert.deepEqual(assignSlot(["summit/a", "summit/b", null], 2, "summit/a"), [
    null,
    "summit/b",
    "summit/a",
  ]);
  assert.deepEqual(assignSlot(["summit/a", "summit/b"], 0, null), [null, "summit/b"]);
});

test("swapSlots swaps positions without duplicating sessions", () => {
  assert.deepEqual(swapSlots(["summit/a", null, "mesa/c"], 0, 2), ["mesa/c", null, "summit/a"]);
});

test("mobileSlotCount fits two or three panes by available resolution", () => {
  assert.equal(mobileSlotCount(390, 740), 2);
  assert.equal(mobileSlotCount(430, 920), 3);
  assert.equal(mobileSlotCount(840, 420), 3);
});

test("mobileSlotCount follows visible sessions up to four panes", () => {
  assert.equal(mobileSlotCount(390, 740, 1), 1);
  assert.equal(mobileSlotCount(390, 740, 2), 2);
  assert.equal(mobileSlotCount(430, 920, 3), 3);
  assert.equal(mobileSlotCount(430, 920, 4), 4);
  assert.equal(mobileSlotCount(430, 920, 8), 4);
});

test("stepLayoutMode moves through desktop pane counts and wraps around the ends", () => {
  assert.equal(stepLayoutMode(3, -1), 2);
  assert.equal(stepLayoutMode(3, 1), 4);
  assert.equal(stepLayoutMode(4, 1), 5);
  assert.equal(stepLayoutMode(5, 1), 6);
  assert.equal(stepLayoutMode(2, -1), 1);
  // Circular wrap: stepping down from the low end lands on the high end and back.
  assert.equal(stepLayoutMode(1, -1), 6);
  assert.equal(stepLayoutMode(6, 1), 1);
});

test("LAYOUT_MODES is the 1/2/3/4/5/6 ladder and isLayoutMode gates it", () => {
  assert.deepEqual(LAYOUT_MODES, [1, 2, 3, 4, 5, 6]);
  for (const mode of [1, 2, 3, 4, 5, 6]) {
    assert.equal(isLayoutMode(mode), true);
  }
  assert.equal(parseLayoutMode("5"), 5);
  assert.equal(isLayoutMode(0), false);
});

test("autoLayoutMode picks the smallest grid that shows every session, capped at 6", () => {
  assert.equal(autoLayoutMode(0), 1);
  assert.equal(autoLayoutMode(1), 1);
  assert.equal(autoLayoutMode(2), 2);
  assert.equal(autoLayoutMode(3), 3);
  assert.equal(autoLayoutMode(4), 4);
  assert.equal(autoLayoutMode(5), 5);
  assert.equal(autoLayoutMode(6), 6);
  assert.equal(autoLayoutMode(9), 6);
});
