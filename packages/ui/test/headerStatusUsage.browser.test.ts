import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, noticeFixtureFontScript } from "./support/browserLayout.ts";
import { headerFixture, measureHeaderMarkup } from "./support/headerFixture.ts";

const cases = [[360, 800, false], [390, 844, false], [412, 915, false], [915, 412, false], [915, 412, true], [1280, 900, false]] as const;
for (const theme of ["dark", "paper"]) for (const [width, height, coarse] of cases) {
  test(`${theme} ${width}x${height}${coarse ? " touch" : ""}: number-only statuses leave readable usage and clear actions`, async t => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const fixture = await headerFixture();
    try {
      const m = measureHeaderMarkup<{
        counts: { text: string; name: string; title: string; group: string }[];
        windows: string[]; providers: number; badges: number; resets: number; overlaps: string[]; clipped: string[]; overflow: number;
      }>(fixture.markup(width, coarse), width, `
        const header=document.querySelector('.workspace-head');
        const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
        const controls=[...header.querySelectorAll('.brand-title-mark,.session-status-count,.header-usage,.header-menu-trigger,.dashboard-new-session,.session-filter-searchbar,.session-list-pagination,.layout-picker')].filter(visible);
        const overlaps=[];
        controls.forEach((a,i)=>controls.slice(i+1).forEach(b=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();
          if(Math.min(x.right,y.right)-Math.max(x.left,y.left)>1&&Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>1)overlaps.push(a.className+'/'+b.className);}));
        const usage=header.querySelector('.header-usage'),u=usage.getBoundingClientRect();
        const percents=[...usage.querySelectorAll('.hu-pct')].filter(e=>visible(e)&&visible(e.closest('.hu-provider')));
        const clipped=controls.filter(e=>{const r=e.getBoundingClientRect();return r.left<0||r.right>innerWidth+1||e.scrollWidth>e.clientWidth+1;}).map(e=>e.className);
        for(const p of percents){const r=p.getBoundingClientRect();if(r.left<u.left||r.right>u.right+1)clipped.push('percentage');}
        const result={counts:[...header.querySelectorAll('.session-status-count')].map(b=>({text:[...b.querySelectorAll('span[aria-hidden="true"]')].filter(visible).map(e=>e.textContent).join(' ').trim(),name:b.getAttribute('aria-label'),title:b.title,group:b.dataset.statusGroup})),
          windows:percents.map(e=>e.closest('.hu-win').dataset.windowKey+':'+e.textContent),
          providers:[...usage.querySelectorAll('.hu-provider')].filter(visible).length,
          badges:[...usage.querySelectorAll('.hu-provider > .agent-badge')].filter(visible).length,
          resets:[...usage.querySelectorAll('.hu-reset')].filter(e=>visible(e)&&visible(e.closest('.hu-provider'))).length,
          overlaps,clipped,overflow:document.documentElement.scrollWidth-innerWidth};
      `, false, height, coarse ? ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"] : [], `document.documentElement.dataset.theme='${theme}';${noticeFixtureFontScript}`);
      assert.deepEqual(m.counts.map(c => c.group), ["working", "waiting", "attention", "stopped"], "stable order is the non-colour cue");
      for (const [i, label] of ["Working", "Waiting", "Needs attention", "Stopped"].entries()) {
        const c = m.counts[i]!;
        assert.match(c.text, /^\d+$/, `number-only visible count: ${JSON.stringify(c)}`);
        assert.match(c.name, new RegExp(`^${label}: \\d+ sessions$`));
        assert.equal(c.title, c.name);
      }
      assert.equal(m.badges, m.providers, "each visible entry identifies its provider");
      if (width < 760) assert.deepEqual(m.windows, ["weekly:40%"], "the tight header shows the lowest remaining window");
      else if (width === 1280 || coarse) assert.ok(m.windows.includes("5h:60%") && m.windows.includes("weekly:40%"), JSON.stringify(m));
      if (width === 1280) assert.ok(m.providers > 1 || m.resets > 0, "desktop uses available space for more detail");
      assert.deepEqual(m.overlaps, []);
      assert.deepEqual(m.clipped, []);
      assert.ok(m.overflow <= 1);
    } finally { await fixture.close(); }
  });
}
