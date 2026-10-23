import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { headerFixture, headerMeasure } from "./support/headerFixture.ts";

test("explicit compaction preserves layout access, then shortens quota, then pager", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = await headerFixture();
  try {
    for (const stage of [0,1,2,3,4,5]) await t.test(`stage ${stage}`, () => {
      const m = measureUiMarkup<Record<string, number | boolean>>(fixture.markup(3008), 3008,
        `document.querySelector('.workspace-head').dataset.headerCompact='${stage}';` + headerMeasure);
      assert.equal(m.inline, stage === 0 ? 6 : 0); assert.equal(m.picker, stage > 0);
      assert.equal(m.usageText, stage < 2 ? 4 : 0); assert.equal(m.arrows, stage < 3 ? 2 : 0);
      assert.equal(m.counts, 4); assert.ok(m.scope && m.newVisible);
      assert.equal(m.usage, stage < 4);
    });
  } finally { await fixture.close(); }
});
