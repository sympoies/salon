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
}

const COMPONENTS = "brand-title,session-status-counts,session-list-pagination,session-filters-summary,session-filter-searchbar,header-usage,layout-picker,header-menu,dashboard-new-session";
const script = (tier: boolean, grid: boolean) => `
  document.documentElement.dataset.phoneTier="${tier && !grid}";document.documentElement.dataset.phoneHeader="${tier}";
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
  const buttons={more:'.header-menu-trigger',new:'.dashboard-new-session',layout:'.layout-picker-trigger',auto:'.layout-picker .is-auto',pane:'.layout-picker-inline button'};
  const sizes={};for(const [k,s] of Object.entries(buttons)){const e=header.querySelector(s);const r=e&&e.getBoundingClientRect();if(r&&r.width>0)sizes[k]=r.width.toFixed(0)+'x'+r.height.toFixed(0);}
  const result={overlaps,outside,missing,sizes};
`;

for (const width of [320, 360, 412, 480, 600, 700, 760, 761, 800, 900, 1024]) {
  for (const mode of ["browser", "android", "grid"] as const) for (const focused of [false, true]) {
    if (mode === "grid" && focused) continue;
    const android = mode !== "browser", grid = mode === "grid";
    test(`the ${focused ? "focused" : "list"} header at ${width}px${grid ? " in the Android tile grid" : android ? " in the Android app" : ""} has no overlaps, keeps menu and New session and equal button sizes`, async t => {
      if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
      const fixture = await headerFixture();
      try {
        const tier = isPhoneWidth(width, false, android);
        const m = measureHeaderMarkup<Sweep>(fixture.markup(width, false, focused, true), width, script(tier, grid));
        const detail = JSON.stringify(m);
        assert.deepEqual(m.overlaps, [], `no component overlaps another: ${detail}`);
        assert.deepEqual(m.outside, [], `every component stays inside the header: ${detail}`);
        assert.deepEqual(m.missing, [], `the logo, New session and More stay visible: ${detail}`);
        assert.equal(new Set(Object.values(m.sizes)).size, 1, `header buttons share one size: ${detail}`);
      } finally { await fixture.close(); }
    });
  }
}
