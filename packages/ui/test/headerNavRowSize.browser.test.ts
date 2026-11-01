import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { CLEAR_SESSION_FILTERS } from "../src/sessionFilters.ts";

// Issue #765 item 5: the pager and filter row matches the rest of the header in
// type size and height, on desktop (1200 px) and phone (384 px, 360 px).
const CHIP_FILTERS = { ...CLEAR_SESSION_FILTERS, hosts: ["summit"], harness: "codex", repo: "agent-console" };

interface RowMeasure {
  textMd: number; pageExpected: number; pagerHeight: number; pageLabelFont: number; arrowFont: number;
  barHeight: number; placeholderFont: number | null; chipHeight: number | null; chipFont: number | null;
  headerButtonHeight: number; statusFont: number; docWidth: number; coarse: boolean;
}

test("the pager and filter row uses the header type size and a compact height at 1200, 384, 360 and coarse 800 px", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness();
  try {
    const { SessionListNavigator } = await harness.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
    // A coarse-pointer 800px tablet is mobile to Dashboard (width <= 1024 with a coarse pointer), so it gets the
    // phone row height too (review F2).
    const COARSE = ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"];
    for (const [width, coarse] of [[1200, false], [384, false], [360, false], [800, true]] as const) {
      const mobile = width <= 760 || (coarse && width <= 1024);
      for (const [chips, filters] of [[0, CLEAR_SESSION_FILTERS], [3, CHIP_FILTERS]] as const) {
        const navigator = renderComponent(SessionListNavigator, {
          filters, machines: ["summit", "beta"], harnesses: [{ id: "codex", label: "Codex" }], resultCount: 30,
          statusCounts: { working: 2, waiting: 3, attention: 1, unknown: 0, stopped: 0 }, mobile, page: 1, pageCount: 3, open: false,
          onPageChange() {}, onChange() {}, onOpenChange() {},
        } as never);
        const { updateHeaderCompaction, chooseHeaderCompactStage, HEADER_COMPACT_STAGES } = await harness.loadModule<typeof import("../src/headerResponsive.ts")>("/src/headerResponsive.ts");
        const markup = `<main class="dash workspace-shell"><header class="dash-head workspace-head"><div class="workspace-head-start">`
          + `<div class="brand-title"><button class="brand-title-mark">AC</button><h1>Agent Console</h1></div>${navigator}</div>`
          + `<div class="dash-actions dash-group dash-create-actions"><button class="control-icon btn header-menu-trigger" type="button" aria-label="More">⋯</button><button class="control-icon btn dashboard-new-session" type="button">+</button></div>`
          + `</header></main>`;
        const m = measureUiMarkup<RowMeasure>(markup, width, `
          const HEADER_COMPACT_STAGES=${JSON.stringify(HEADER_COMPACT_STAGES)};const chooseHeaderCompactStage=${chooseHeaderCompactStage.toString()};(${updateHeaderCompaction.toString()})(document.querySelector('.workspace-head'));
          const need=(s)=>{const el=document.querySelector(s);if(!el)throw new Error('missing '+s);return el};
          const px=(el)=>parseFloat(getComputedStyle(el).fontSize);
          // The phone layout keeps the pre-#915 --text-md row (#930), touch tablets included (#968);
          // desktop uses the compact row tokens.
          const phone=document.documentElement.dataset.phoneHeader==='true';
          const probe=document.createElement('span');probe.style.fontSize=phone?'var(--text-md)':'var(--text-sm)';document.body.append(probe);
          const chip=document.querySelector('.session-filter-searchbar .session-filter-chip');
          const placeholder=document.querySelector('.session-filter-placeholder');
          const pageProbe=document.createElement('span');pageProbe.style.fontSize=phone?'var(--text-md)':document.querySelector('.workspace-head').dataset.headerCompact==='5'?'var(--text-xs)':'var(--text-sm)';document.body.append(pageProbe);
          const result={pageExpected:px(pageProbe),textMd:px(probe),pagerHeight:need('.session-list-pagination').getBoundingClientRect().height,
            pageLabelFont:px(need('.session-list-page-label')),arrowFont:px(need('.session-list-page-button')),
            barHeight:need('.session-filter-searchbar').getBoundingClientRect().height,
            placeholderFont:placeholder?px(placeholder):null,
            chipHeight:chip?chip.getBoundingClientRect().height:null,chipFont:chip?px(chip):null,
            headerButtonHeight:need('.dash-create-actions > .btn').getBoundingClientRect().height,
            statusFont:px(need('.session-status-count')),docWidth:document.documentElement.scrollWidth,
            coarse:matchMedia('(pointer: coarse)').matches};
        `, false, 800, coarse ? COARSE : []);
        const label = `${width}px${coarse ? " coarse" : ""} with ${chips} chips`;
        assert.equal(m.coarse, coarse, `${label}: the pointer type is emulated`);
        assert.equal(m.pageLabelFont, m.pageExpected, `${label}: the page label uses the compact text token (${m.pageLabelFont}px)`);
        assert.equal(m.arrowFont, 18, `${label}: arrows use the shared glyph token`);
        if (m.placeholderFont !== null) assert.equal(m.placeholderFont, m.textMd, `${label}: the filter placeholder uses the compact text token (${m.placeholderFont}px)`);
        if (m.chipFont !== null) assert.equal(m.chipFont, m.textMd, `${label}: filter chips use --text-md (${m.chipFont}px)`);
        assert.ok(m.statusFont <= m.textMd, `${label}: the row text is no larger than the header status counts' scale`);
        if (mobile) {
          // Phone restores the 40px 0.3.35 row, the same height as the header's icon buttons.
          assert.equal(m.pagerHeight, 40, `${label}: phone pager height (${m.pagerHeight}px)`);
          assert.equal(m.barHeight, 40, `${label}: phone filter bar height (${m.barHeight}px)`);
          assert.ok(m.barHeight <= m.headerButtonHeight, `${label}: no taller than the header buttons`);
          if (m.chipHeight !== null) assert.ok(m.chipHeight <= 30, `${label}: phone chips fit the bar (${m.chipHeight}px)`);
          assert.ok(m.docWidth <= width, `${label}: no horizontal overflow (${m.docWidth}px)`);
        } else {
          assert.equal(m.pagerHeight, 34, `${label}: desktop pager height (${m.pagerHeight}px)`);
          assert.equal(m.barHeight, 34, `${label}: desktop filter bar height (${m.barHeight}px)`);
          assert.ok(m.barHeight <= m.headerButtonHeight, `${label}: no taller than the 34px header controls`);
          if (m.chipHeight !== null) assert.ok(m.chipHeight <= 24, `${label}: desktop chips fit the bar (${m.chipHeight}px)`);
        }
      }
    }
  } finally {
    await harness.close();
  }
});
