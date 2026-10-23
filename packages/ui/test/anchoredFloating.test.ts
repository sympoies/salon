import { strict as assert } from "node:assert";
import { test } from "node:test";
import { computeAnchoredStyle } from "../src/useAnchoredFloating.ts";

const viewport = { width: 400, height: 800 };

test("places the panel below the trigger when there is room", () => {
  const style = computeAnchoredStyle({ top: 100, bottom: 130, left: 20, width: 200 }, viewport);
  assert.equal(style.position, "fixed");
  assert.equal(style.top, 134); // rect.bottom + default gap 4
  assert.equal(style.bottom, undefined);
  assert.equal(style.left, 20);
  assert.equal(style.width, 200);
  assert.equal(style.maxHeight, 320); // default cap, room is larger
});

test("flips above the trigger when the space below is cramped and above is roomier", () => {
  const style = computeAnchoredStyle({ top: 700, bottom: 730, left: 20, width: 200 }, viewport);
  assert.equal(style.bottom, 104); // viewport.height - rect.top + gap
  assert.equal(style.top, undefined);
  assert.equal(style.maxHeight, 320);
});

test("clamps max-height to the space actually available below", () => {
  const style = computeAnchoredStyle({ top: 50, bottom: 600, left: 20, width: 200 }, viewport);
  // spaceBelow = 800 - 600 - 8 = 192 (< maxHeight, but >= 160 so no flip)
  assert.equal(style.top, 604);
  assert.equal(style.maxHeight, 192);
});

test("honors an explicit max-height option", () => {
  const style = computeAnchoredStyle({ top: 100, bottom: 130, left: 20, width: 200 }, viewport, {
    maxHeight: 50,
  });
  assert.equal(style.maxHeight, 50);
});

test("clamps the left edge inside the viewport margins", () => {
  const offLeft = computeAnchoredStyle({ top: 100, bottom: 130, left: -30, width: 200 }, viewport);
  assert.equal(offLeft.left, 8); // default margin
  const offRight = computeAnchoredStyle({ top: 100, bottom: 130, left: 350, width: 200 }, viewport);
  assert.equal(offRight.left, 192); // viewport.width - margin - width
});
