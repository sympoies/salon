import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome } from "./support/browserLayout.ts";
import { measureHeaderMarkup as measureUiMarkup } from "./support/headerFixture.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { CLEAR_SESSION_FILTERS } from "../src/sessionFilters.ts";

// Header geometry is owned by headerCompaction/headerSingleRow and the actual product fixture.
test("desktop overview keeps filters collapsed and the control in flow", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const { controlSizeFixture } = await import("./support/controlSizeFixture.ts");
  for (const width of [1920, 1440, 1280, 1024, 900, 761]) {
    const markup = await controlSizeFixture(width);
    const m = measureUiMarkup<{ panel: boolean; height: number; right: number; overflow: number; trigger: boolean }>(markup, width, `
      const bar=document.querySelector('.session-filter-searchbar'),r=bar?.getBoundingClientRect();
      const result={panel:!!document.querySelector('.session-filter-panel'),height:r?.height??0,right:r?.right??0,overflow:document.documentElement.scrollWidth,trigger:!!document.querySelector('.session-filters-trigger')};
    `);
    assert.equal(m.panel, false, `${width}px has no inline filter form`);
    assert.equal(m.trigger, true, `${width}px retains Filter sessions`);
    assert.ok(m.height > 0 && m.height <= 40 && m.right <= width && m.overflow <= width, `${width}px compact control fits: ${JSON.stringify(m)}`);
  }
});

test("phone page picker menu escapes pager clipping and leaves the focused session switcher visible", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const markup = `<main class="dash workspace-shell"><header class="workspace-head"><div class="workspace-head-start"><div class="brand-title"><button class="brand-title-mark"></button><h1>Agent Console</h1></div><div class="session-list-navigator"><span class="session-list-pagination" role="group" aria-label="Page 1 of 3"><button class="session-list-page-button">‹</button><span class="session-list-page-picker"><button class="session-list-page-label">1 / 3</button><div class="session-list-page-menu" role="menu"><button type="button" role="menuitem">Page 1</button><button type="button" role="menuitem">Page 2</button></div></span><button class="session-list-page-button">›</button></span></div></div><div class="dash-actions"></div></header><div class="session-workspace mobile is-focused"><div class="terminal-slot is-focused"><span class="slot-session-nav" aria-label="Session 8 of 32"><button class="slot-ordinal slot-ordinal-trigger">8 / 32</button></span></div></div></main>`;
  for (const width of [412, 360]) {
    const result=measureUiMarkup<{listDisplay:string;switcherDisplay:string;switcherText:string;menuVisible:boolean;menuLeft:number;menuRight:number;viewportWidth:number}>(markup,width,`
      const list=document.querySelector('.session-list-pagination'),switcher=document.querySelector('.slot-session-nav'),menu=document.querySelector('.session-list-page-menu'),menuItem=menu?.querySelector('[role=menuitem]'),r=menuItem?.getBoundingClientRect();
      const menuRect=menu?.getBoundingClientRect();
      const hit=r?document.elementFromPoint(r.left+r.width/2,r.top+r.height/2):null;
      const result={listDisplay:getComputedStyle(list).display,switcherDisplay:getComputedStyle(switcher).display,switcherText:switcher.textContent.trim(),menuVisible:!!menu&&!!hit&&menu.contains(hit),menuLeft:menuRect?.left??-1,menuRight:menuRect?.right??-1,viewportWidth:innerWidth};
    `);
    assert.equal(result.listDisplay,"flex",`${width}px shows Dashboard list pagination`);
    assert.notEqual(result.switcherDisplay,"none",`${width}px keeps the focused session switcher visible`);
    assert.ok(result.menuLeft >= 0 && result.menuRight <= result.viewportWidth,
      `${width}px page menu remains inside the viewport (${result.menuLeft}..${result.menuRight} / ${result.viewportWidth})`);
    assert.ok(result.menuVisible,`${width}px page picker menu remains visible outside the pager`);
    assert.equal(result.switcherText,"8 / 32");
  }
});

test("page picker and Session filters share Settings form sizing and preserve phone touch targets", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness();
  try {
    const { SessionListNavigator } = await harness.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
    for (const width of [1280, 412]) {
      const mobile = width <= 760;
      const navigator = renderComponent(SessionListNavigator, {
        filters: CLEAR_SESSION_FILTERS, machines: ["host-a", "host-b"], harnesses: [{ id: "codex", label: "Codex" }],
        resultCount: 4, statusCounts: { working: 2, waiting: 0, attention: 1, unknown: 0, stopped: 1 }, mobile,
        page: 1, pageCount: 6, open: true, onPageChange() {}, onChange() {}, onOpenChange() {},
      });
      const markup = `<main class="dash workspace-shell"><header class="workspace-head"><div class="workspace-head-start"><div class="brand-title"><button class="brand-title-mark"></button><h1>Agent Console</h1></div>${navigator}</div><div class="session-list-page-menu" role="menu"><button class="slot-menu-item session-list-page-menu-item" role="menuitem">Page 1</button></div></header></main>`;
      const result = measureUiMarkup<{ menuHeight:number; menuFont:number; panelPadding:number; panelFont:number; labelFont:number; selectHeight:number; selectFont:number; summaryHeight:number; choiceHeight:number; buttonHeight:number; compactHeight:number; compactFont:number; compactSpace:number; formHeight:number }>(markup, width, `
        const menuItem=document.querySelector('.session-list-page-menu [role="menuitem"]'), panel=document.querySelector('.session-filter-panel');
        const select=panel?.querySelector('select'), label=panel?.querySelector('.session-filter-panel-fields > label'), summary=panel?.querySelector('.session-filter-multi-select > summary'), choice=panel?.querySelector('.session-filter-choice'), action=panel?.querySelector('.session-filter-panel-actions .btn');
        const menuRect=menuItem?.getBoundingClientRect(), selectRect=select?.getBoundingClientRect(), summaryRect=summary?.getBoundingClientRect(), choiceRect=choice?.getBoundingClientRect(), actionRect=action?.getBoundingClientRect();
        const root=getComputedStyle(document.documentElement),compactHeight=parseFloat(root.getPropertyValue('--control-compact-height')),formHeight=parseFloat(root.getPropertyValue('--control-height'));
        const compactFont=parseFloat(root.getPropertyValue('--text-sm'))*parseFloat(root.fontSize),compactSpace=parseFloat(root.getPropertyValue('--space-sm'))*parseFloat(root.fontSize);
        const result={menuHeight:menuRect?.height??0,menuFont:parseFloat(getComputedStyle(menuItem).fontSize),panelPadding:parseFloat(getComputedStyle(panel).paddingTop),panelFont:parseFloat(getComputedStyle(panel).fontSize),labelFont:parseFloat(getComputedStyle(label).fontSize),
          selectHeight:selectRect?.height??0,selectFont:parseFloat(getComputedStyle(select).fontSize),summaryHeight:summaryRect?.height??0,choiceHeight:choiceRect?.height??0,buttonHeight:actionRect?.height??0,compactHeight,compactFont,compactSpace,formHeight};
      `);
      if (mobile) {
        assert.ok(result.menuHeight >= 48, `${width}px page menu keeps a 48px touch target (${result.menuHeight}px)`);
        assert.ok(result.selectHeight >= 39 && result.summaryHeight >= 44 && result.choiceHeight >= 44 && result.buttonHeight >= 48,
          `${width}px phone filter select retains its existing 40px height and other controls keep touch targets (${result.selectHeight}/${result.formHeight}/${result.summaryHeight}/${result.choiceHeight}/${result.buttonHeight}px)`);
        assert.ok(result.selectFont >= 16, `${width}px editable/select control text avoids mobile zoom (${result.selectFont}px)`);
      } else {
        assert.ok(Math.abs(result.menuHeight-34) <= 1, `desktop page rows use shared menu control height (${result.menuHeight}/${result.compactHeight}px)`);
        assert.ok(Math.abs(result.menuFont-result.compactFont) <= 0.1, `desktop page rows use compact type token (${result.menuFont}/${result.compactFont}px)`);
        assert.ok(Math.abs(result.selectHeight-result.compactHeight) <= 1, `desktop filter selects use compact control height (${result.selectHeight}/${result.compactHeight}px)`);
        assert.ok(Math.abs(result.summaryHeight-result.compactHeight) <= 1 && Math.abs(result.choiceHeight-result.compactHeight) <= 1,
          `desktop filter facets use compact row height (${result.summaryHeight}/${result.choiceHeight}/${result.compactHeight}px)`);
        assert.ok(Math.abs(result.buttonHeight-result.compactHeight) <= 1, `desktop filter actions use compact control height (${result.buttonHeight}/${result.compactHeight}px)`);
        assert.ok(Math.abs(result.selectFont-result.compactFont) <= 0.1 && Math.abs(result.panelFont-result.compactFont) <= 0.1,
          `desktop filter controls and panel use compact type token (${result.selectFont}/${result.panelFont}/${result.compactFont}px)`);
        assert.ok(Math.abs(result.panelPadding-result.compactSpace) <= 1,
          `desktop filter panel uses shared compact spacing (${result.panelPadding}/${result.compactSpace}px)`);
      }
      assert.ok(result.panelPadding > 0 && result.menuFont > 0 && result.labelFont > 0, `${width}px popovers retain shared spacing and type values`);
    }
  } finally { await harness.close(); }
});

test("open Dashboard filters stay inside the 1200x820 desktop viewport with Repository focus visible", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness();
  let markup: string;
  try {
    const { SessionListNavigator } = await harness.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
    const machines = ["host-a", "host-b", "host-c", "host-d"];
    const navigator = renderComponent(SessionListNavigator, {
      filters: { ...CLEAR_SESSION_FILTERS, hosts: machines.slice(0, 3), repo: "console160fixture" },
      machines,
      harnesses: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }],
      resultCount: 2,
      statusCounts: { working: 1, waiting: 0, attention: 0, unknown: 0, stopped: 1 },
      mobile: false,
      page: 1,
      pageCount: 1,
      open: true,
      onPageChange() {},
      onChange() {},
    });
    markup = `<div class="dash workspace-shell"><header class="workspace-head"><div class="workspace-head-start"><div class="brand-title"><button class="brand-title-mark brand-title-mark-button"><img class="brand-title-icon" src="/icon.svg" alt=""></button><h1>Agent Console</h1></div>${navigator}</div><div class="dash-actions"><div class="dash-create-actions"><button class="header-menu-trigger btn" aria-label="More actions">…</button><button class="btn" aria-label="New session">+</button></div></div></header><ol class="mobile-session-list"><li class="mobile-session-card">Session fixture</li></ol></div>`;
  } finally {
    await harness.close();
  }
  const result = measureUiMarkup<{ height: number; expanded: boolean; panelLeft: number; panelRight: number; viewportWidth: number; viewportHeight: number; controlsInside: boolean; focused: boolean; outline: string; boxShadow:string; borderColor:string; focusVisible:boolean }>(markup, 1200, `
    const panel=document.querySelector('.session-filter-panel'),rect=panel?.getBoundingClientRect();
    const fields=[...(panel?.querySelectorAll('.session-filter-panel-fields label,.session-filter-panel-fields fieldset,.session-filter-panel-heading,.session-filter-panel-actions')??[])];
    const repo=panel?.querySelector('input[aria-label="Repository"]');repo?.focus();
    const style=repo?getComputedStyle(repo):null;
    const result={height:innerHeight,expanded:panel?.getAttribute('role')==='dialog',panelLeft:rect?.left??-1,panelRight:rect?.right??-1,
      viewportWidth:innerWidth,viewportHeight:innerHeight,
      controlsInside:!!rect&&fields.every(el=>{const r=el.getBoundingClientRect();return r.left>=rect.left-1&&r.right<=rect.right+1&&r.left>=0&&r.right<=innerWidth;}),
      focused:document.activeElement===repo,outline:style?.outlineStyle??'',boxShadow:style?.boxShadow??'',borderColor:style?.borderColor??'',focusVisible:repo?.matches(':focus-visible')??false};
  `, false, 820);
  assert.equal(result.viewportHeight, 820);
  assert.ok(result.expanded, "the desktop filter dialog is open");
  assert.ok(result.panelLeft >= 0 && result.panelRight <= 1200, `dialog stays inside viewport (${result.panelLeft}..${result.panelRight})`);
  assert.ok(result.controlsInside, "panel controls stay within the dialog and app bounds");
  assert.ok(result.focused && (result.outline !== "none" || result.boxShadow !== "none"), `Repository focus remains visible inside the panel: ${JSON.stringify(result)}`);
});

test("expanded filter panel stays inside the viewport when its desktop container is narrow", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness();
  try {
    const { SessionFiltersBar } = await harness.loadModule<typeof import("../src/SessionFiltersBar.tsx")>("/src/SessionFiltersBar.tsx");
    const filters = renderComponent(SessionFiltersBar, {
      filters: CLEAR_SESSION_FILTERS,
      machines: ["host-a", "host-b"],
      harnesses: [{ id: "codex", label: "Codex" }],
      resultCount: 2,
      statusCounts: { working: 1, waiting: 0, attention: 1, unknown: 0, stopped: 0 },
      mobile: false,
      open: true,
      onOpenChange() {},
      onChange() {},
    });
    const markup = `<main style="width:220px">${filters}</main>`;
    const result = measureUiMarkup<{ left:number; right:number; panelWidth:number; viewportWidth:number }>(markup, 1200, `
      const panel=document.querySelector('.session-filter-panel'),r=panel?.getBoundingClientRect();
      const result={left:r?.left??-1,right:r?.right??-1,panelWidth:r?.width??-1,viewportWidth:innerWidth};
    `);
    assert.ok(result.left >= 0 && result.right <= result.viewportWidth,
      `expanded filter panel stays inside the app (${result.left}..${result.right} / ${result.viewportWidth})`);
  } finally {
    await harness.close();
  }
});

test("Hosts and Roles start expanded with compact choices on desktop and phone", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness();
  try {
    const { SessionListNavigator } = await harness.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
    for (const width of [1280, 412]) {
      const navigator = renderComponent(SessionListNavigator, {
        filters: { ...CLEAR_SESSION_FILTERS, hosts: ["host-a", "host-b", "host-c"], roles: ["reviewer", null] },
        machines: ["host-a", "host-b", "host-c", "host-d"], roles: ["analyst", "reviewer", "tester"],
        harnesses: [{ id: "codex", label: "Codex" }], resultCount: 4, mobile: width <= 760, open: true,
        page: 1, pageCount: 6, onPageChange() {}, onChange() {},
      });
      const markup = `<main class="dash workspace-shell" style="width:${width}px"><header class="workspace-head"><div class="workspace-head-start">${navigator}</div></header></main>`;
      const result = measureUiMarkup<{ panelWidth:number; panelRight:number; fieldColumns:number; hostSummary:string; roleSummary:string; expanded:boolean; choiceColumns:number; overflow:number }>(markup, width, `
        const panel=document.querySelector('.session-filter-panel'),rect=panel?.getBoundingClientRect();
        const sections=[...document.querySelectorAll('[data-filter-dimension="hosts"], [data-filter-dimension="roles"]')];
        const summaryText=sections.map(section=>section.querySelector('summary')?.textContent?.trim()??'');
        const expanded=sections.length===2&&sections.every(section=>section.open);
        sections.forEach(section=>section.open=true);
        const fields=panel?.querySelector('.session-filter-panel-fields'),labels=[...(panel?.querySelectorAll('.session-filter-choice')??[])];
        const positions=[...new Set(labels.map(label=>Math.round(label.getBoundingClientRect().left)))];
        const result={panelWidth:rect?.width??-1,panelRight:rect?.right??-1,fieldColumns:fields?getComputedStyle(fields).gridTemplateColumns.split(' ').length:0,
          hostSummary:summaryText[0]??'',roleSummary:summaryText[1]??'',expanded,choiceColumns:positions.length,overflow:document.documentElement.scrollWidth};
      `);
      assert.ok(result.expanded, `${width}px Hosts and Roles initially show their checkbox lists`);
      assert.match(result.hostSummary, /Hosts.*3 of 4/);
      assert.match(result.roleSummary, /Roles.*2 of 4/);
      assert.ok(result.panelWidth > 0 && result.panelRight <= width + 1, `${width}px filter panel fits in viewport`);
      assert.equal(result.fieldColumns, 1, `${width}px panel fields use one column`);
      assert.ok(result.choiceColumns >= 2, `${width}px multi-select choices wrap compactly across columns (${result.choiceColumns})`);
      assert.ok(result.overflow <= width, `${width}px filter panel has no horizontal overflow`);
    }
  } finally { await harness.close(); }
});


test("long active workspace chips keep their label inside padding and the remove glyph visible", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness();
  try {
    const { SessionListNavigator } = await harness.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
    for (const [width, height] of [[360, 780], [412, 915], [760, 915], [761, 915], [1500, 982]]) {
      const navigator = renderComponent(SessionListNavigator, {
        filters: { ...CLEAR_SESSION_FILTERS, workspaces: ["sample-workspace-alpha", "sample-workspace-beta", null] },
        machines: [], harnesses: [], resultCount: 4, mobile: width <= 760,
        page: 1, pageCount: 3, open: false, onPageChange() {}, onChange() {},
      });
      const markup = `<main class="dash workspace-shell"><header class="workspace-head"><div class="workspace-head-start"><div class="brand-title"><button class="brand-title-mark"></button><h1>Salon</h1></div>${navigator}</div><div class="dash-actions"><button class="btn dashboard-new-session">+</button></div></header></main>`;
      const m = measureUiMarkup<{ paddingLeft:number; labelLeft:number; contentLeft:number; labelRight:number; contentRight:number; ellipsis:string; overflow:string; whiteSpace:string; scrollWidth:number; clientWidth:number; removeVisible:boolean; bounded:boolean; chipWidth:number }>(markup, width, `
        const chip=document.querySelector('[data-filter-chip="workspace"]'),label=chip.querySelector('.session-filter-chip-label'),remove=chip.lastElementChild;
        const r=chip.getBoundingClientRect(),l=label.getBoundingClientRect(),x=remove.getBoundingClientRect(),s=getComputedStyle(chip),ls=getComputedStyle(label);
        const bar=document.querySelector('.session-filter-searchbar').getBoundingClientRect(),icon=document.querySelector('.session-filter-search-open').getBoundingClientRect(),clips=document.querySelector('.session-filter-search-chips').getBoundingClientRect();
        const hit=document.elementFromPoint(x.left+x.width/2,x.top+x.height/2);
        const result={paddingLeft:parseFloat(s.paddingLeft),labelLeft:l.left,contentLeft:r.left+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft),labelRight:l.right,contentRight:r.right-parseFloat(s.borderRightWidth)-parseFloat(s.paddingRight),
          ellipsis:ls.textOverflow,overflow:ls.overflow,whiteSpace:ls.whiteSpace,scrollWidth:label.scrollWidth,clientWidth:label.clientWidth,
          removeVisible:remove.textContent.trim()==='×'&&x.width>0&&x.left>=l.right&&x.right<=r.right&&x.left>=clips.left&&x.right<=clips.right&&(hit===chip||chip.contains(hit)),
          bounded:r.left>=icon.right&&r.right<=bar.right&&r.left>=0&&r.right<=innerWidth,chipWidth:r.width};
      `, false, height);
      const context = `${width}x${height}: ${JSON.stringify(m)}`;
      assert.ok(m.paddingLeft > 0, `chip has inner padding: ${context}`);
      assert.ok(m.labelLeft >= m.contentLeft && m.labelRight <= m.contentRight, `label stays inside the chip content box: ${context}`);
      assert.ok(m.scrollWidth > m.clientWidth && m.clientWidth > 0 && m.ellipsis === "ellipsis" && m.overflow === "hidden" && m.whiteSpace === "nowrap", `long label is ellipsized: ${context}`);
      assert.ok(m.removeVisible, `remove glyph stays visible: ${context}`);
      assert.ok(m.bounded && m.chipWidth <= 240, `chip is capped and clears the filter icon: ${context}`);
    }
  } finally { await harness.close(); }
});
