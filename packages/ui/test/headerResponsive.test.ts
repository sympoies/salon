import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HEADER_COMPACT_STAGES, chooseHeaderCompactStage } from "../src/headerResponsive.ts";

test("header returns to the least compact stage that fits and collapses in order", () => {
  const needs = [1320, 1240, 1160, 1080, 1000, 900];
  for (const [index, width] of [1400, 1280, 1200, 1120, 1040, 960, 880].entries()) {
    const actual = chooseHeaderCompactStage(stage => width >= needs[stage]!);
    const expected = Math.min(index, 5);
    assert.equal(actual, expected, `${width}px chooses stage ${expected}`);
  }
  assert.deepEqual(HEADER_COMPACT_STAGES, [0, 1, 2, 3, 4, 5], "all measured stages remain available");
  assert.equal(chooseHeaderCompactStage(() => false), 5, "the final stage preserves primary actions");
});
