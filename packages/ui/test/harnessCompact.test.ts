import { strict as assert } from "node:assert";
import { test } from "node:test";
import { HARNESS_COMPACT_STAGES, fitHarnessCompact } from "../src/harnessCompact.ts";

// Each stage frees a fixed amount of row width; the title takes what is left.
const ITEM_WIDTHS = [0, 90, 120, 60, 55, 120];
const FIXED = 300;

function fakeRow(width: number) {
  let stage = 0;
  const content = () => FIXED + ITEM_WIDTHS.slice(stage + 1).reduce((sum, item) => sum + item, 0);
  const target = { setAttribute: (_: string, value: string) => { stage = Number(value); } } as unknown as HTMLElement;
  const row = {
    get clientWidth() { return width; },
    get scrollWidth() { return Math.max(width, content() + 100); },
  } as unknown as HTMLElement;
  const title = { getBoundingClientRect: () => ({ width: Math.max(0, width - content()) }) } as unknown as HTMLElement;
  return { target, row, title, stage: () => stage };
}

test("the harness fit applies the least compact stage whose title keeps its minimum width", () => {
  assert.deepEqual(HARNESS_COMPACT_STAGES, [0, 1, 2, 3, 4, 5], "quota meters, quota, context tokens, effort, then model drop");
  const all = FIXED + ITEM_WIDTHS.reduce((sum, item) => sum + item, 0);
  const expected: [number, number][] = [
    [all + 160, 0],
    [all + 159, 1],
    [all - 90 + 160, 1],
    [all - 90 + 159, 2],
    [all - 210 + 159, 3],
    [all - 270 + 159, 4],
    [all - 325 + 159, 5],
    [200, 5],
  ];
  let previous = -1;
  for (const [width, stage] of expected.reverse()) {
    const fake = fakeRow(width);
    const chosen = fitHarnessCompact({ target: fake.target, row: fake.row, title: fake.title, minTitlePx: 160 });
    assert.equal(chosen, stage, `${width}px chooses stage ${stage}`);
    assert.equal(fake.stage(), stage, `${width}px leaves stage ${stage} applied`);
    assert.ok(previous === -1 || chosen <= previous, "a wider row never drops more");
    previous = chosen;
  }
});

test("a row without a measured title fits on overflow alone", () => {
  const target = { setAttribute() {} } as unknown as HTMLElement;
  const row = { clientWidth: 500, scrollWidth: 500 } as unknown as HTMLElement;
  assert.equal(fitHarnessCompact({ target, row, title: null, minTitlePx: 160 }), 0);
});
