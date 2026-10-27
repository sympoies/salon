import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome } from "./support/browserLayout.ts";
import { measureHeaderMarkup as measureUiMarkup } from "./support/headerFixture.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { CLEAR_SESSION_FILTERS } from "../src/sessionFilters.ts";

const HOST_DOWN = "summit: offline (cooling down after a failed probe)";

interface Box { x: number; y: number; width: number; height: number }
interface Measure {
  inRow: boolean; atEnd: boolean; countsVisible: boolean; dismissClickable: boolean;
  fullA11y: boolean; title: string | null; dotDisplay: string; overlaps: number;
  barShown: Box; barHidden: Box; paneShown: Box; paneHidden: Box; widened: boolean;
}

const CHIP_FILTERS = { ...CLEAR_SESSION_FILTERS, hosts: ["summit"], harness: "codex", repo: "agent-console" };

test("phone host notices overlay the count row without shifting filters, pager or cards", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness();
  try {
    const { SessionListNavigator } = await harness.loadModule<typeof import("../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
    const { StatusNotice } = await harness.loadModule<typeof import("../src/StatusNotice.tsx")>("/src/StatusNotice.tsx");
    const { hostOfflineNotice } = await harness.loadModule<typeof import("../src/statusNoticeModel.ts")>("/src/statusNoticeModel.ts");
    const { createElement } = await import("react");
    const { IconButton } = await harness.loadModule<typeof import("../src/IconButton.tsx")>("/src/IconButton.tsx");
    const { PlusIcon } = await harness.loadModule<typeof import("../src/icons.tsx")>("/src/icons.tsx");
    const actions = renderComponent(IconButton, { preset:"standard", className:"dashboard-new-session btn", "aria-label":"New session", title:"New session", children:createElement(PlusIcon) })
      + renderComponent(IconButton, { preset:"standard", className:"header-menu-trigger btn", "aria-label":"More", children:"⋯" });
    for (const pageCount of [8, 1]) for (const [chips, filters] of [[0, CLEAR_SESSION_FILTERS], [3, CHIP_FILTERS]] as const) {
      const Composed = () => createElement(SessionListNavigator, {
        filters, machines: ["summit", "beta"], harnesses: [{ id: "codex", label: "Codex" }],
        statusCounts: {working:4,waiting:2,attention:1,unknown:0,stopped:1}, countsAvailable: true,
        resultCount: 8, mobile: true, page: 1, pageCount, onPageChange() {}, onChange() {},
        statusNotice: createElement(StatusNotice, { notice: hostOfflineNotice(HOST_DOWN), onDismiss() {}, surface: "dashboard", inline: true }),
      } as never);
      const navigator = renderComponent(Composed as never, {} as never);
      const markup = `<header class="dash-head workspace-head"><div class="workspace-head-start">`
        + `<div class="brand-title"><span class="brand-title-mark">AC</span><h1>Agent Console</h1></div>${navigator}`
        + `</div><div class="dash-actions">${actions}</div></header>`
        + `<main class="session-workspace" style="height:320px"><div class="session-card-probe" style="height:120px">first card</div></main>`;
      for (const width of [700, 412, 360]) {
        const m = measureUiMarkup<Measure>(markup, width, `
          const pill=document.querySelector('.connection-notice'),p=pill.getBoundingClientRect();
          const layer=pill.parentElement,row=pill.closest('.session-filter-status-row'),r=row?.getBoundingClientRect();
          const box=el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};
          const bar=document.querySelector('.session-filter-searchbar'),pane=document.querySelector('.session-workspace');
          const barShown=box(bar),paneShown=box(pane),widthShown=document.documentElement.scrollWidth;layer.style.display='none';
          const barHidden=box(bar),paneHidden=box(pane),widthHidden=document.documentElement.scrollWidth;layer.style.display='';
          const counts=row?.querySelector('.session-status-counts');
          const dismiss=pill.querySelector('button'),d=dismiss.getBoundingClientRect(),hit=document.elementFromPoint(d.x+d.width/2,d.y+d.height/2);
          const full=pill.querySelector('.connection-notice-message-full'),cs=getComputedStyle(full);
          const controls=[...document.querySelectorAll('.workspace-head button,.session-card-probe')]
            .filter(el=>!el.closest('.connection-notice-layer,.session-status-counts'));
          const overlaps=controls.filter(el=>{const b=el.getBoundingClientRect();return b.width>0&&b.height>0&&Math.min(b.right,p.right)>Math.max(b.left,p.left)&&Math.min(b.bottom,p.bottom)>Math.max(b.top,p.top)}).length;
          const result={barShown,barHidden,paneShown,paneHidden,overlaps,
            inRow:!!r&&p.top>=r.top&&p.bottom<=r.bottom,atEnd:!!r&&Math.abs(p.right-r.right)<=1,
            countsVisible:!!counts?.getBoundingClientRect().width,
            dismissClickable:hit===dismiss||dismiss.contains(hit),fullA11y:cs.display!=='none'&&cs.visibility!=='hidden',
            title:pill.querySelector('.connection-notice-message').title,
            dotDisplay:getComputedStyle(pill.parentElement.querySelector('.connection-notice-dot')).display,
            widened:widthShown>widthHidden};
        `, false, 900);
        const label = `${width}px with ${chips} chips and ${pageCount} page(s)`;
        assert.deepEqual(m.barShown, m.barHidden, `${label}: search bar stays fixed`);
        assert.deepEqual(m.paneShown, m.paneHidden, `${label}: first card stays fixed`);
        assert.equal(m.inRow, true, `${label}: notice stays inside the count row`);
        assert.equal(m.atEnd, true, `${label}: notice stays at the right end`);
        assert.equal(m.countsVisible, true, `${label}: counts remain rendered under the overlay`);
        assert.equal(m.dismissClickable, true);
        assert.equal(m.fullA11y, true);
        assert.equal(m.title, HOST_DOWN);
        assert.equal(m.dotDisplay, "none", `${label}: notice remains dismissible instead of collapsing to a dot`);
        assert.equal(m.overlaps, 0, `${label}: filters, pager, actions and cards remain clear`);
        assert.equal(m.widened, false, `${label}: notice never widens the page`);
      }
    }
  } finally {
    await harness.close();
  }
});
