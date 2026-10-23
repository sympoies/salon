import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome } from "./support/browserLayout.ts";
import { measureHeaderMarkup as measureUiMarkup } from "./support/headerFixture.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { CLEAR_SESSION_FILTERS } from "../src/sessionFilters.ts";

const HOST_DOWN = "summit: offline (cooling down after a failed probe)";

interface Box { x: number; y: number; width: number; height: number }
interface Measure {
  pill: { top: number; bottom: number; left: number; right: number; width: number };
  row: { top: number; bottom: number; left: number; right: number };
  bar: { left: number; right: number };
  header: { left: number; right: number };
  dismiss: { left: number; right: number; width: number };
  layerWidth: number; full: string; compact: string; title: string | null;
  overlaps: string[]; cardOverlap: boolean;
  barShown: Box; barHidden: Box; paneShown: Box; paneHidden: Box;
  viewport: number;
  pillDisplay: string; pillText: string; fullA11y: boolean;
  dot: { display: string; top: number; bottom: number; left: number; right: number; width: number; height: number; background: string; pointerEvents: string };
  dotOverlaps: string[]; dotBarContentHits: string[]; dotCardOverlap: boolean; dismissVisibility: string; docWidthShown: number; docWidthHidden: number;
}

const CHIP_FILTERS = { ...CLEAR_SESSION_FILTERS, hosts: ["summit"], harness: "codex", repo: "agent-console" };

test("the phone host-offline toast lives in the trigger row's free space, or becomes a red dot inside the search bar when there is none: no header control or first card covered, the search bar unmoved, and no pane shift", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness();
  try {
    const { SessionListNavigator } = await harness.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
    const { StatusNotice } = await harness.loadModule<typeof import("../src/StatusNotice.tsx")>("/src/StatusNotice.tsx");
    const { hostOfflineNotice } = await harness.loadModule<typeof import("../src/statusNotice.ts")>("/src/statusNotice.ts");
    const { createElement } = await import("react");
    const { IconButton } = await harness.loadModule<typeof import("../src/IconButton.tsx")>("/src/IconButton.tsx");
    const { PlusIcon } = await harness.loadModule<typeof import("../src/icons.tsx")>("/src/icons.tsx");
    const actions = renderComponent(IconButton, { preset:"standard", className:"dashboard-new-session btn", "aria-label":"New session", title:"New session", children:createElement(PlusIcon) })
      + renderComponent(IconButton, { preset:"standard", className:"header-menu-trigger btn", "aria-label":"More", children:"⋯" });
    for (const pageCount of [8, 1]) for (const [chips, filters] of [[0, CLEAR_SESSION_FILTERS], [3, CHIP_FILTERS]] as const) {
      const Composed = () => createElement(SessionListNavigator, {
        filters, machines: ["summit", "beta"], harnesses: [{ id: "codex", label: "Codex" }],
        resultCount: 8, mobile: true, page: 1, pageCount, onPageChange() {}, onChange() {},
        statusNotice: createElement(StatusNotice, { notice: hostOfflineNotice(HOST_DOWN), onDismiss() {}, surface: "dashboard" }),
      } as never);
      const navigator = renderComponent(Composed as never, {} as never);
      const markup = `<header class="dash-head workspace-head"><div class="workspace-head-start">`
        + `<div class="brand-title"><span class="brand-title-mark">AC</span><h1>Agent Console</h1></div>${navigator}`
        + `</div><div class="dash-actions">${actions}</div></header>`
        + `<main class="session-workspace" style="height:320px"><div class="session-card-probe" style="height:120px">first card</div></main>`;
      for (const width of [700, 412, 360]) {
        const m = measureUiMarkup<Measure>(markup, width, `
          const need=(s)=>{const el=document.querySelector(s);if(!el)throw new Error('missing '+s);return el};
          const box=(r)=>({x:r.x,y:r.y,width:r.width,height:r.height});
          const pill_el=need('.connection-notice');
          const pill=pill_el.getBoundingClientRect();
          const layer=need('.connection-notice-layer');
          const row=need('.session-filter-trigger-row').getBoundingClientRect();
          const bar=need('.session-filter-searchbar').getBoundingClientRect();
          const header=need('.workspace-head').getBoundingClientRect();
          const pane=need('.session-workspace').getBoundingClientRect();
          const card=need('.session-card-probe').getBoundingClientRect();
          const dismiss_el=need('.connection-notice-dismiss');
          const dismiss=dismiss_el.getBoundingClientRect();
          const layerWidth=layer.getBoundingClientRect().width;
          const pillDisplay=getComputedStyle(pill_el).display;
          const full=getComputedStyle(need('.connection-notice-message-full')).display;
          const compact=getComputedStyle(need('.connection-notice-message-compact')).display;
          const title=need('.connection-notice-message').getAttribute('title');
          const pillText=pill_el.textContent;
          const fullStyle=getComputedStyle(need('.connection-notice-message-full'));
          const fullA11y=fullStyle.display!=='none'&&fullStyle.visibility!=='hidden';
          const dot_el=need('.connection-notice-dot');const dotStyle=getComputedStyle(dot_el);const d=dot_el.getBoundingClientRect();
          const dot={display:dotStyle.display,top:d.top,bottom:d.bottom,left:d.left,right:d.right,width:d.width,height:d.height,background:dotStyle.backgroundColor,pointerEvents:dotStyle.pointerEvents};
          const dismissVisibility=getComputedStyle(dismiss_el).visibility;
          const barShown=box(bar);
          const paneShown=box(pane);
          const docWidthShown=document.documentElement.scrollWidth;
          layer.style.display='none';
          const docWidthHidden=document.documentElement.scrollWidth;
          const barHidden=box(need('.session-filter-searchbar').getBoundingClientRect());
          const paneHidden=box(need('.session-workspace').getBoundingClientRect());
          layer.style.display='';
          const controls=[...document.querySelectorAll('.workspace-head button, .workspace-head input, .workspace-head select, .workspace-head a')]
            .filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&!el.closest('.connection-notice-layer')});
          const hits=(r)=>!(r.right<=pill.left||r.left>=pill.right||r.bottom<=pill.top||r.top>=pill.bottom);
          const overlaps=controls.filter(el=>hits(el.getBoundingClientRect())).map(el=>el.getAttribute('aria-label')||el.textContent.trim().slice(0,30));
          const cardOverlap=hits(card);
          const hitsDot=(r)=>!(r.right<=d.left||r.left>=d.right||r.bottom<=d.top||r.top>=d.bottom);
          const dotOverlaps=controls.filter(el=>!el.closest('.session-filter-searchbar')&&hitsDot(el.getBoundingClientRect())).map(el=>el.getAttribute('aria-label')||el.textContent.trim().slice(0,30));
          const searchbar=document.querySelector('.session-filter-searchbar');
          const visibleBox=(el)=>{let r=el.getBoundingClientRect();let box={left:r.left,right:r.right,top:r.top,bottom:r.bottom};
            for(let a=el.parentElement;a&&a!==searchbar.parentElement;a=a.parentElement){if(getComputedStyle(a).overflowX==='visible')continue;const c=a.getBoundingClientRect();
              box={left:Math.max(box.left,c.left+a.clientLeft),right:Math.min(box.right,c.left+a.clientLeft+a.clientWidth),top:Math.max(box.top,c.top),bottom:Math.min(box.bottom,c.bottom)};}
            return box;};
          const dotBarContentHits=[...searchbar.querySelectorAll('*')].filter(el=>{const r=visibleBox(el);return r.right>r.left&&r.bottom>r.top&&hitsDot(r)}).map(el=>el.getAttribute('aria-label')||el.className||el.tagName);
          const dotCardOverlap=hitsDot(card);
          const result={pillDisplay,pill:{top:pill.top,bottom:pill.bottom,left:pill.left,right:pill.right,width:pill.width},row:{top:row.top,bottom:row.bottom,left:row.left,right:row.right},
            bar:{left:bar.left,right:bar.right},header:{left:header.left,right:header.right},dismiss:{left:dismiss.left,right:dismiss.right,width:dismiss.width},
            layerWidth,full,compact,title,overlaps,cardOverlap,barShown,barHidden,paneShown,paneHidden,viewport:innerWidth,
            pillText,fullA11y,dot,dotOverlaps,dotBarContentHits,dotCardOverlap,dismissVisibility,docWidthShown,docWidthHidden};
        `, false, 900);
        const label = `${width}px with ${chips} chips and ${pageCount} page(s)`;
        assert.equal(m.viewport, width);
        assert.deepEqual(m.barShown, m.barHidden, `${label}: the search bar box must not change while a toast shows`);
        assert.match(m.pillText, /summit: offline \(cooling down after a failed probe\)/, `${label}: the alert keeps the full host text`);
        assert.ok(m.fullA11y, `${label}: the full text stays available to assistive tech`);
        assert.equal(m.docWidthShown, m.docWidthHidden, `${label}: the notice never widens the page (no sideways scroll)`);
        assert.ok(Math.abs(m.paneShown.x - m.paneHidden.x) < 0.5 && Math.abs(m.paneShown.y - m.paneHidden.y) < 0.5
          && Math.abs(m.paneShown.width - m.paneHidden.width) < 0.5 && Math.abs(m.paneShown.height - m.paneHidden.height) < 0.5,
          `${label}: the notice must not shift the pane`);
        if (m.layerWidth <= 24) {
          assert.ok(m.pill.width <= 1, `${label}: with no free space the toast is visually hidden`);
          assert.equal(m.dismissVisibility, "hidden", `${label}: the hidden dismiss button is not focusable`);
          assert.equal(m.dot.display, "block", `${label}: a red dot replaces the toast`);
          assert.ok(m.dot.width >= 6 && m.dot.width <= 12 && Math.abs(m.dot.width - m.dot.height) < 0.5, `${label}: the dot is small and round`);
          assert.match(m.dot.background, /^rgb\((\d+), (\d+), (\d+)\)$/);
          const [r, g, b] = m.dot.background.match(/\d+/g)!.map(Number);
          assert.ok(r! > 150 && r! > g! * 2 && r! > b! * 2, `${label}: the dot is red (${m.dot.background})`);
          assert.equal(m.dot.pointerEvents, "none", `${label}: taps still reach the search bar`);
          assert.ok(m.dot.left >= m.bar.left && m.dot.right <= m.bar.right, `${label}: the dot sits inside the search bar's box`);
          assert.ok(m.dot.top >= m.row.top && m.dot.bottom <= m.row.bottom, `${label}: the dot stays on the filter row`);
          assert.deepEqual(m.dotOverlaps, [], `${label}: the dot covers no header control outside the search bar`);
          assert.deepEqual(m.dotBarContentHits, [], `${label}: the dot sits in the search bar's right padding, over none of its content`);
          assert.equal(m.dotCardOverlap, false, `${label}: the dot must not cover the first card`);
          continue;
        }
        assert.equal(m.dot.display, "none", `${label}: no dot while the toast has room`);
        assert.deepEqual(m.overlaps, [], `${label}: toast must not cover any header control`);
        assert.equal(m.cardOverlap, false, `${label}: toast must not cover the first card`);
        assert.ok(m.pill.top >= m.row.top - 0.5 && m.pill.bottom <= m.row.bottom + 0.5, `${label}: toast stays on the trigger row`);
        assert.ok(m.pill.left >= m.bar.right - 0.5, `${label}: toast sits after the search bar`);
        assert.ok(m.pill.right <= m.header.right + 0.5, `${label}: toast stays inside the header`);
        // #765 item 6: on desktop the toast sits at the right end of the row's free space, not centred in it.
        if (width >= 761) assert.ok(m.row.right - m.pill.right <= 8, `${label}: desktop toast is right-aligned (${m.row.right - m.pill.right}px from the row end)`);
        assert.ok(m.dismiss.width > 0 && m.dismiss.right <= m.pill.right + 0.5, `${label}: the dismiss button stays visible inside the toast`);
        assert.equal(m.title, HOST_DOWN, `${label}: the full text is on the title attribute`);
        if (m.layerWidth <= 150) {
          assert.equal(m.compact, "block", `${label}: narrow free space shows the compact host label`);
        } else {
          assert.equal(m.full, "block", `${label}: the full text shows when there is room`);
        }
      }
    }
  } finally {
    await harness.close();
  }
});
