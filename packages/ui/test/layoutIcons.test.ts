import { strict as assert } from "node:assert";
import { test } from "node:test";
import { layoutIconCells } from "../src/layoutIconGeometry.ts";

test("layoutIconCells draws one cell per pane for each mode", () => {
  assert.equal(layoutIconCells(1).length, 1);
  assert.equal(layoutIconCells(2).length, 2);
  assert.equal(layoutIconCells(3).length, 3);
  assert.equal(layoutIconCells(4).length, 4);
  assert.equal(layoutIconCells(5).length, 5);
  assert.equal(layoutIconCells(6).length, 6);
});

test("layoutIconCells lays cells out in the real cols x rows grid shape", () => {
  // 6 = 3 cols x 2 rows.
  const six = layoutIconCells(6);
  assert.equal(new Set(six.map((c) => c.x)).size, 3);
  assert.equal(new Set(six.map((c) => c.y)).size, 2);
  // 4 = 2 x 2.
  const four = layoutIconCells(4);
  assert.equal(new Set(four.map((c) => c.x)).size, 2);
  assert.equal(new Set(four.map((c) => c.y)).size, 2);
  // 3 = left half full height, right half split into two stacked panes.
  const three = layoutIconCells(3);
  assert.equal(new Set(three.map((c) => c.x)).size, 2);
  assert.equal(new Set(three.map((c) => c.y)).size, 2);
  const [left, topRight, bottomRight] = three;
  assert.ok(left && topRight && bottomRight);
  assert.equal(left.h, 18);
  assert.equal(left.w, topRight.w);
  assert.equal(topRight.x, bottomRight.x);
  assert.ok(topRight.y < bottomRight.y);
  assert.equal(topRight.h + bottomRight.h + 2, left.h);

  // 5 = one full-height left pane and two stacked panes in each right column,
  // filled in reading order like every other mode.
  const five = layoutIconCells(5);
  const [main, middleTop, rightTop, middleBottom, rightBottom] = five;
  assert.ok(main && middleTop && middleBottom && rightTop && rightBottom);
  assert.equal(main.h, 18);
  assert.equal(main.w, middleTop.w);
  assert.equal(middleTop.x, middleBottom.x);
  assert.equal(rightTop.x, rightBottom.x);
  assert.ok(main.x < middleTop.x && middleTop.x < rightTop.x);
  assert.ok(middleTop.y < middleBottom.y && rightTop.y < rightBottom.y);
});

test("layoutIconCells fills every mode in reading order", () => {
  // Slot order must read left to right, then top to bottom in every mode, so an
  // Auto layout change (e.g. six panes to five after a close) never visually
  // swaps sessions whose order did not change.
  for (const mode of [1, 2, 3, 4, 5, 6] as const) {
    const cells = layoutIconCells(mode);
    const reading = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
    assert.deepEqual(cells, reading, `mode ${mode} fills in reading order`);
  }
});

test("layoutIconCells stays within the padded 24x24 icon box", () => {
  for (const mode of [1, 2, 3, 4, 5, 6] as const) {
    for (const cell of layoutIconCells(mode)) {
      assert.ok(cell.x >= 3 - 1e-6 && cell.y >= 3 - 1e-6, `cell inside top-left pad: ${JSON.stringify(cell)}`);
      assert.ok(cell.x + cell.w <= 21 + 1e-6, `cell inside right pad: ${JSON.stringify(cell)}`);
      assert.ok(cell.y + cell.h <= 21 + 1e-6, `cell inside bottom pad: ${JSON.stringify(cell)}`);
    }
  }
});
