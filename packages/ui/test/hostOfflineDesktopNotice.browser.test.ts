import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome } from "./support/browserLayout.ts";
import { headerFixture, headerMeasure, measureHeaderMarkup } from "./support/headerFixture.ts";

// #761: on the desktop header the host-offline notice must be readable next to the filter field. The red dot is
// only for a header with no room for the notice at all (the most compact header stage and phones).
const HOST_DOWN = "summit: offline (cooling down after a failed probe)";
// Header widths on both sides of the 1025px / 761px desktop tiers and the 1200/1280 stage changes, up to a wide display.
const WIDTHS = [761, 900, 1024, 1025, 1100, 1200, 1201, 1280, 1366, 1440, 1512, 1600, 1920, 2000, 3008] as const;

interface Box { left: number; right: number; top: number; bottom: number; width: number }
interface Measured {
  stage: number; bar: Box; row: Box; layerWidth: number;
  noticeBox: Box; noticeClipped: boolean; fullShown: number; compactShown: number; dotShown: boolean;
  dismissShown: number; searchContentRight: number; free: number; rects: number[][]; overflow: number;
}

const measure = `
 ${headerMeasure}
 const box = r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width });
 const bar = header.querySelector('.session-filter-searchbar'), row = bar.closest('.session-filter-trigger-row');
 const notice = header.querySelector('.connection-notice'), layer = header.querySelector('.connection-notice-layer');
 // Visible width of an element once every clipping ancestor up to the header, and its own clip-path, are applied.
 const shown = el => {
   if (!el) return 0;
   let r = el.getBoundingClientRect(), left = r.left, right = r.right;
   for (let a = el; a && a !== header; a = a.parentElement) {
     const cs = getComputedStyle(a);
     if (cs.display === 'none' || cs.visibility === 'hidden' || cs.clipPath !== 'none') return 0;
     if (a !== el && cs.overflowX !== 'visible') { const c = a.getBoundingClientRect(); left = Math.max(left, c.left + a.clientLeft); right = Math.min(right, c.left + a.clientLeft + a.clientWidth); }
   }
   return Math.max(0, right - left);
 };
 const dot = header.querySelector('.connection-notice-dot');
 const searchContent = [...bar.querySelectorAll('.session-filter-search-open,.session-filter-search-chips')].filter(visible);
 result.stage = stage;
 result.bar = box(bar.getBoundingClientRect()); result.row = box(row.getBoundingClientRect());
 result.layerWidth = layer ? layer.getBoundingClientRect().width : 0;
 result.noticeBox = notice ? box(notice.getBoundingClientRect()) : { left: 0, right: 0, top: 0, bottom: 0, width: 0 };
 result.noticeClipped = !!notice && getComputedStyle(notice).clipPath !== 'none';
 result.fullShown = shown(header.querySelector('.connection-notice-message-full'));
 result.compactShown = shown(header.querySelector('.connection-notice-message-compact'));
 result.dotShown = !!dot && getComputedStyle(dot).display !== 'none';
 result.dismissShown = shown(header.querySelector('.connection-notice-dismiss'));
 // The field's free width: from its last chip (or the filter button) to the inner edge of its right padding.
 const last = [...bar.querySelectorAll('.session-filter-chip')].pop() || bar.querySelector('.session-filter-search-open');
 const inner = bar.getBoundingClientRect().right - 1 - parseFloat(getComputedStyle(bar).paddingRight);
 result.searchContentRight = last.getBoundingClientRect().right;
 result.free = inner - result.searchContentRight;
 result.rects = [...header.querySelectorAll('.brand-title,.session-status-count,.session-list-pagination,.session-filter-searchbar,.header-usage,.layout-picker,.header-menu-trigger,.dashboard-new-session')]
   .filter(visible).map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
 result.overflow = document.documentElement.scrollWidth - innerWidth;
`;

test("the desktop host-offline notice is readable in the filter field's free space, or shows the dot when there is none, without moving the header", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = await headerFixture();
  try {
    for (const [chips, wideFont] of [[false, false], [true, false], [true, true]] as const) for (const width of WIDTHS) await t.test(`${width}px ${chips ? "chips" : "no chips"} ${wideFont ? "DejaVu" : "native"}`, () => {
      const font = wideFont ? "<style>body{font-family:'DejaVu Sans',sans-serif}</style>" : "";
      const off = measureHeaderMarkup<Measured>(fixture.markup(width, false, false, chips) + font, width, measure, false, 900);
      const on = measureHeaderMarkup<Measured>(fixture.markup(width, false, false, chips, undefined, HOST_DOWN) + font, width, measure, false, 900);
      const label = `${width}px stage ${on.stage}, ${Math.round(on.free)}px free in a ${Math.round(on.bar.width)}px field`;
      assert.equal(on.stage, off.stage, `${label}: the notice does not change the header compaction stage`);
      assert.deepEqual(on.rects, off.rects, `${label}: no header control moves or resizes while the notice shows`);
      assert.ok(on.overflow <= 1, `${label}: no sideways scroll`);
      // Ample free room must show the text; none must show the dot; in between, either, but never a cramped pill.
      if (on.free >= 120) assert.equal(on.dotShown, false, `${label}: room for the notice, so no dot`);
      if (on.free < 80) assert.ok(on.dotShown, `${label}: no room in the field, so the red dot stands in`);
      if (on.dotShown) { assert.ok(on.noticeBox.width <= 1, `${label}: the hidden notice is not drawn`); return; }
      const text = Math.max(on.fullShown, on.compactShown);
      assert.ok(text >= 20, `${label}: the notice text is visible (${on.fullShown}px full, ${on.compactShown}px compact)`);
      assert.ok(on.dismissShown >= 16, `${label}: the dismiss button stays visible (${on.dismissShown}px)`);
      assert.ok(on.noticeBox.left >= on.searchContentRight - 0.5, `${label}: the notice covers no filter content (${on.noticeBox.left} vs ${on.searchContentRight})`);
      assert.ok(on.noticeBox.right <= on.bar.right + 0.5 && on.noticeBox.top >= on.bar.top && on.noticeBox.bottom <= on.bar.bottom, `${label}: the notice stays inside the field`);
      if (on.free >= 220) assert.ok(on.fullShown >= 120, `${label}: a roomy field shows the full notice text, truncated (${on.fullShown}px)`);
    });
  } finally { await fixture.close(); }
});
