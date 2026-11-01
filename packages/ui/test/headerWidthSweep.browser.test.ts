import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome } from "./support/browserLayout.ts";
import { headerFixture, measureHeaderMarkup } from "./support/headerFixture.ts";
import { isPhoneWidth } from "../src/phoneTier.ts";

// #238: the workspace header is laid out by the available width, not by device type. Menu/logo,
// New session and More always stay; lower-priority parts shrink, move or hide before anything overlaps.
interface Sweep {
  readonly overlaps: string[];
  readonly outside: string[];
  readonly missing: string[];
  readonly sizes: Record<string, string>;
  readonly quota: number;
  readonly detail: string | null;
}

const COMPONENTS = "brand-title,session-status-counts,session-list-pagination,session-filters-summary,session-filter-searchbar,header-usage,layout-picker,header-menu,dashboard-new-session";
// The tier is published before the production compaction runs, as the app does (Android reports the phone tier at any width).
const tierScript = (tier: boolean, grid: boolean) => `document.documentElement.dataset.phoneTier="${tier && !grid}";document.documentElement.dataset.phoneHeader="${tier}";${grid ? 'document.documentElement.dataset.androidDesktop="true";' : ""}`;
const script = () => `
  const header=document.querySelector('.workspace-head');
  const name=e=>e.className.toString().split(' ')[0];
  const seen=[...header.querySelectorAll('.${COMPONENTS.split(",").join(",.")}')]
    .map(e=>({n:name(e),e,r:e.getBoundingClientRect()})).filter(c=>c.r.width>0&&c.r.height>0);
  // A wrapper that merely contains another component is not an overlap.
  const leaves=seen.filter(c=>!seen.some(o=>o!==c&&c.e.contains(o.e)));
  const overlaps=[];
  leaves.forEach((a,i)=>leaves.forEach((b,j)=>{if(i<j&&Math.min(a.r.right,b.r.right)-Math.max(a.r.left,b.r.left)>1&&Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)>1)overlaps.push(a.n+'/'+b.n)}));
  const h=header.getBoundingClientRect();
  const outside=seen.filter(c=>c.r.left<h.left-1||c.r.right>h.right+1||c.r.top<h.top-1||c.r.bottom>h.bottom+1).map(c=>c.n);
  const present=s=>{const e=header.querySelector(s);return !!e&&e.getBoundingClientRect().width>0};
  const missing=[['.brand-title-mark','logo'],['.dashboard-new-session','new'],['.header-menu-trigger','more']].filter(([s])=>!present(s)).map(([,n])=>n);
  const buttons={more:'.header-menu-trigger',new:'.dashboard-new-session',layout:'.layout-picker-trigger',auto:'.layout-picker .is-auto',pane:'.layout-picker-inline button',pager:'.session-list-page-button'};
  const sizes={};for(const [k,s] of Object.entries(buttons)){const found=[...new Set([...header.querySelectorAll(s)].map(e=>e.getBoundingClientRect()).filter(r=>r.width>0).map(r=>r.width.toFixed(0)+'x'+r.height.toFixed(0)))];if(found.length)sizes[k]=found.join('/');}
  const quota=[...header.querySelectorAll('.header-usage .hu-provider')].filter(e=>e.getBoundingClientRect().width>0).length;const result={overlaps,outside,missing,sizes,quota,detail:header.getAttribute('data-quota-detail')};
`;

for (const width of [320, 360, 412, 480, 600, 700, 760, 761, 800, 900, 1024, 1280]) {
  for (const mode of ["browser", "android", "grid"] as const) for (const focused of [false, true]) {
    if (mode === "grid" && focused) continue;
    const android = mode !== "browser", grid = mode === "grid";
    test(`the ${focused ? "focused" : "list"} header at ${width}px${grid ? " in the Android desktop list" : android ? " in the Android app" : ""} has no overlaps, keeps menu and New session and equal button sizes`, async t => {
      if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
      const fixture = await headerFixture();
      try {
        const tier = isPhoneWidth(width, false, android);
        const m = measureHeaderMarkup<Sweep>(fixture.markup(width, false, focused, true, undefined, "", grid), width, script(), false, 800, [], tierScript(tier, grid));
        const detail = JSON.stringify(m);
        assert.deepEqual(m.overlaps, [], `no component overlaps another: ${detail}`);
        assert.deepEqual(m.outside, [], `every component stays inside the header: ${detail}`);
        if (grid) assert.ok(m.sizes.layout || m.sizes.auto, `the layout control stays visible: ${detail}`);
        assert.deepEqual(m.missing, [], `the logo, New session and More stay visible: ${detail}`);
        assert.equal(new Set(Object.values(m.sizes)).size, 1, `header buttons share one size: ${detail}`);
      } finally { await fixture.close(); }
    });
  }
}

// The quota strip gets the room left after the logo, New, More and the counts: it reduces to fewer
// accounts as the width shrinks and is gone only when no room remains.
for (const focused of [false, true]) {
  test(`the ${focused ? "focused" : "list"} header's quota strip reduces with the width and is gone at 320px`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const fixture = await headerFixture();
    try {
      const widths = [320, 360, 412, 480, 600, 700, 760, 900, 1024, 1280];
      const shown = widths.map(width => measureHeaderMarkup<Sweep>(fixture.markup(width, false, focused, true), width, script(), false, 800, [], tierScript(true, false)).quota);
      const detail = JSON.stringify(Object.fromEntries(widths.map((width, i) => [width, shown[i]])));
      assert.equal(shown[0], 0, `the quota strip is gone at 320px: ${detail}`);
      assert.ok(shown.every((count, i) => i === 0 || count >= shown[i - 1]), `a narrower header never shows more accounts: ${detail}`);
      assert.equal(shown.at(-1), 2, `both accounts show where they fit: ${detail}`);
      assert.ok(shown.includes(1), `it reduces to fewer accounts before it disappears: ${detail}`);
    } finally { await fixture.close(); }
  });
}

// #259: with room to spare (no filter chips, a very wide window) the pager arrows and every pane layout button
// are on screen; they share the size of More, New and the layout trigger too.
for (const width of [2400, 3000]) {
  test(`the roomy header at ${width}px shows the pager arrows and every pane button at one size`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const fixture = await headerFixture();
    try {
      const m = measureHeaderMarkup<Sweep>(fixture.markup(width, false, false, false), width, script(), false, 800, [], tierScript(false, false));
      const detail = JSON.stringify(m);
      assert.deepEqual(m.overlaps, [], `no component overlaps another: ${detail}`);
      assert.ok(m.sizes.pager && m.sizes.pane, `the pager arrows and pane buttons are on screen: ${detail}`);
      assert.equal(new Set(Object.values(m.sizes)).size, 1, `header buttons share one size: ${detail}`);
    } finally { await fixture.close(); }
  });
}
