import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { headerFixture, headerMeasure } from "./support/headerFixture.ts";

// Phones (up to 760px, or touch up to 1024px) keep the pre-#915 two-row header without a
// layout picker (#930); wider headers keep #915's single measured row.
function assertPhoneHeader(m: Record<string, number | boolean | null>) {
  assert.ok(m.bounded && Number(m.overflow) <= 1, JSON.stringify(m));
  assert.equal(m.stage, null, "phones are not measured into compaction stages");
  assert.equal(m.inline, 0, "no inline layouts on a phone");
  assert.equal(m.picker, false, "no layout picker on a phone");
  assert.ok(m.newVisible, "New stays visible");
}

test("complete headers keep primary controls in one row with fresh two-provider quotas and wide fonts", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = await headerFixture();
  try {
    for (const wideFont of [false, true]) for (const [width, coarse] of [[360,false],[384,false],[760,false],[761,false],[800,false],[880,false],[881,false],[1024,true],[1025,true],[1099,false],[1100,false],[1200,false],[1201,false],[1500,false],[1512,false],[1920,false],[2000,false],[3008,false]] as const) {
      await t.test(`${width}px ${coarse ? "coarse" : "fine"} ${wideFont ? "DejaVu" : "native"}`, () => {
        const m = measureUiMarkup<Record<string, number | boolean | null>>(fixture.markup(width, coarse)
          + (wideFont ? "<style>body{font-family:'DejaVu Sans',sans-serif}</style>" : ""), width, fixture.compact + headerMeasure,
          false, 982, coarse ? ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"] : []);
        assert.equal(m.counts, 4); assert.ok(m.semanticCounts, "named status counts retain their semantic colors"); assert.ok(m.chip && m.newVisible, "active filter chip and New stay visible");
        // Touch tablets up to 1024px use the phone layout and its header (#968).
        if (width <= 760 || (coarse && width <= 1024)) { assertPhoneHeader(m); return; }
        assert.ok(m.bounded && !m.overlap && Number(m.rowSpread) <= 1 && Number(m.overflow) <= 1, JSON.stringify(m));
        assert.ok(m.inline === 6 || m.picker, "all six layouts are inline or the picker stays visible");
        assert.equal(m.inline, m.stage === 0 ? 6 : 0);
        if (Number(m.stage) >= 2) assert.equal(m.usageText, 0);
        if (Number(m.stage) >= 3) assert.equal(m.arrows, 0);
      });
    }
    for (const width of [384,761,880,1100,1920]) await t.test(`${width}px focused multi-host`, () => {
      const m = measureUiMarkup<Record<string, number | boolean | null>>(fixture.markup(width, false, true), width, fixture.compact + headerMeasure);
      if (width <= 760) { assertPhoneHeader(m); return; }
      assert.ok(m.bounded && !m.overlap && Number(m.rowSpread) <= 1, JSON.stringify(m));
      assert.ok(m.newVisible && (m.inline === 6 || m.picker));
    });
  } finally { await fixture.close(); }
});
