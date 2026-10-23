import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { headerFixture } from "./support/headerFixture.ts";

// #932: the desktop row starts with the brand logo, keeps the filter field at
// its dropdown panel's width, and centers the quota group on the row. macOS
// moves the counts to the title bar and shows the logo without the title text.
const nativeTitleBar = `
  const header=document.querySelector('.workspace-head');
  header.classList.add('has-native-counts');
  const titleCounts=document.createElement('div');titleCounts.className='mac-titlebar';
  titleCounts.append(header.querySelector('.session-status-counts'));document.body.append(titleCounts);
`;
const measure = `
  const head=document.querySelector('.workspace-head');
  const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  const rect=e=>e.getBoundingClientRect();
  const logo=head.querySelector('.brand-title-mark');
  const others=[...head.querySelectorAll('.session-status-count,.session-list-pagination,.session-filter-searchbar,.header-usage,.layout-picker,.header-menu-trigger,.dashboard-new-session')].filter(visible);
  const usage=head.querySelector('.header-usage');
  const filter=head.querySelector('.session-filter-searchbar');
  const panelProbe=document.createElement('div');panelProbe.style.width='var(--session-filter-panel-width)';document.body.append(panelProbe);
  const rects=[logo,...others].filter(visible).map(rect);
  const result={
    stage:head.dataset.headerCompact,
    logoVisible:visible(logo),
    logoFirst:visible(logo)&&others.every(e=>rect(logo).right<=rect(e).left+1),
    titleTextVisible:visible(head.querySelector('.brand-title h1'))&&head.querySelector('.brand-title h1').getBoundingClientRect().width>1,
    titleAccessible:!!head.querySelector('.brand-title h1')&&getComputedStyle(head.querySelector('.brand-title h1')).display!=='none'&&getComputedStyle(head.querySelector('.brand-title h1')).visibility!=='hidden'&&head.querySelector('.brand-title h1').textContent.trim()==='Agent Console',
    filterWidth:Math.round(rect(filter).width),
    panelWidth:Math.round(panelProbe.getBoundingClientRect().width),
    usageVisible:visible(usage),
    usageCenterOffset:visible(usage)?Math.abs((rect(usage).left+rect(usage).right)/2-(rect(head).left+rect(head).right)/2):null,
    overlap:rects.some((a,i)=>rects.some((b,j)=>i<j&&Math.min(a.right,b.right)-Math.max(a.left,b.left)>1)),
    overflow:document.documentElement.scrollWidth-innerWidth,
  };
`;

test("the desktop header leads with the logo, sizes the filter to its panel and centers quotas", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = await headerFixture();
  try {
    for (const native of [false, true]) for (const chips of [false, true]) for (const width of [1280, 1500, 1920]) {
      await t.test(`${width}px ${native ? "macOS title bar" : "web"} ${chips ? "with" : "without"} filter chips`, () => {
        const m = measureUiMarkup<Record<string, number | boolean | string | null>>(fixture.markup(width, false, false, chips), width,
          (native ? nativeTitleBar : "") + fixture.compact + measure, false, 982);
        const detail = JSON.stringify(m);
        assert.equal(m.logoVisible, true, `the brand logo is visible: ${detail}`);
        assert.equal(m.logoFirst, true, `the brand logo is the first item: ${detail}`);
        assert.equal(m.titleTextVisible, false, `the row shows the logo without the title text: ${detail}`);
        assert.equal(m.titleAccessible, true, `the title stays the accessible page heading: ${detail}`);
        if (Number(m.stage) >= 3) assert.ok(Number(m.filterWidth) <= Number(m.panelWidth), `from stage 3 the filter may shrink: ${detail}`);
        else assert.equal(m.filterWidth, m.panelWidth, `the filter field matches its panel width: ${detail}`);
        // Web keeps the status counts in the row; with active filter chips at
        // 1280px, Scope readability (#915) yields Usage at stage 4.
        if (native || !chips || width > 1280) assert.equal(m.usageVisible, true, `quotas stay visible at ${width}px: ${detail}`);
        if (m.usageVisible) assert.ok(Number(m.usageCenterOffset) <= 1, `quotas sit at the row center: ${detail}`);
        assert.equal(m.overlap, false, `controls never overlap: ${detail}`);
        assert.ok(Number(m.overflow) <= 1, `no horizontal overflow: ${detail}`);
      });
    }
  } finally { await fixture.close(); }
});

// Without Usage (the capability is off) there is nothing to center, so the left
// group takes the free space and compaction matches the #930 row (#934 F1).
const withoutUsage = "document.querySelector('.workspace-head > .header-usage')?.remove();";

test("the desktop header without Usage keeps the uncompacted row", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = await headerFixture();
  try {
    for (const width of [1100, 1280, 1500]) await t.test(`${width}px web without Usage`, () => {
      const m = measureUiMarkup<Record<string, number | boolean | string | null>>(fixture.markup(width, false, false, true), width,
        withoutUsage + fixture.compact + measure, false, 982);
      const detail = JSON.stringify(m);
      assert.equal(m.stage, "0", `no compaction is needed without Usage: ${detail}`);
      assert.equal(m.logoFirst, true, `the brand logo is the first item: ${detail}`);
      assert.equal(m.filterWidth, m.panelWidth, `the filter field matches its panel width: ${detail}`);
      assert.equal(m.titleAccessible, true, `the title stays the accessible page heading: ${detail}`);
      assert.equal(m.overlap, false, `controls never overlap: ${detail}`);
    });
  } finally { await fixture.close(); }
});
