import { HEADER_COMPACT_STAGES, chooseHeaderCompactStage, updateHeaderCompaction } from "../../src/headerResponsive.ts";
import { measureUiMarkup } from "./browserLayout.ts";
import { createUiSsrHarness, renderComponent } from "./ssr.ts";
import { CLEAR_SESSION_FILTERS } from "../../src/sessionFilters.ts";

export async function headerFixture() {
  const harness = createUiSsrHarness();
  const { SessionListNavigator } = await harness.loadModule<typeof import("../../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
  const { HeaderUsageReadout } = await harness.loadModule<typeof import("../../src/HeaderUsage.tsx")>("/src/HeaderUsage.tsx");
  const { BrandTitle } = await harness.loadModule<typeof import("../../src/BrandTitle.tsx")>("/src/BrandTitle.tsx");
  const { HeaderMenu } = await harness.loadModule<typeof import("../../src/HeaderMenu.tsx")>("/src/HeaderMenu.tsx");
  const { IconButton } = await harness.loadModule<typeof import("../../src/IconButton.tsx")>("/src/IconButton.tsx");
  const { PlusIcon } = await harness.loadModule<typeof import("../../src/icons.tsx")>("/src/icons.tsx");
  const { StatusNotice } = await harness.loadModule<typeof import("../../src/StatusNotice.tsx")>("/src/StatusNotice.tsx");
  const { hostOfflineNotice } = await harness.loadModule<typeof import("../../src/statusNoticeModel.ts")>("/src/statusNoticeModel.ts");
  const { createElement } = await import("react");
  const newButton = renderComponent(IconButton, { preset: "standard", className: "btn dashboard-new-session", "aria-label": "New session", title: "New session", children: createElement(PlusIcon) });
  const { LayoutPicker } = await harness.loadModule<typeof import("../../src/LayoutPicker.tsx")>("/src/LayoutPicker.tsx");
  const responsive = await harness.loadModule<typeof import("../../src/headerResponsive.ts")>("/src/headerResponsive.ts");
  const now = 1783296000000;
  const usage = renderComponent(HeaderUsageReadout, { providers: (["claude", "codex"] as const).map(provider => ({
    provider, account: `fixture-${provider}`, profile: `fixture-${provider}`, switch_key: `fixture-${provider}`, label: provider,
    ok: true, stale: false, plan: "pro", updated_at: now / 1000, note: null, error: null, reason_code: null,
    windows: [{ key: "5h", label: "5h", used_percent: 40, window_minutes: 300, resets_at: now / 1000 + 3600 },
      { key: "weekly", label: "weekly", used_percent: 60, window_minutes: 10080, resets_at: now / 1000 + 601200 }],
  })), now, onOpen() {} });
  const brand = renderComponent(BrandTitle, { onMarkClick() {} });
  const layouts = renderComponent(LayoutPicker, { auto: true, mode: 6, displayedMode: 6, onToggleAuto() {}, onSelect() {} });
  const menu = renderComponent(HeaderMenu, { open: false, onOpenChange() {}, historyAvailable: true, onHistory() {}, onUsage() {}, onDebug() {}, onSettings() {}, onAutoLayout() {}, onNewSession() {} });
  return { close: harness.close,
    markup(width: number, coarse = false, focused = false, chips = true, statusCounts = { working: 40, waiting: 50, attention: 10, unknown: 0, stopped: 20 }, hostOffline = "") {
      const nav = focused ? "" : renderComponent(SessionListNavigator, {
        scopes: { options: [{ id: "trees", label: "Sample scope", includes: () => true }] },
        filters: chips ? { ...CLEAR_SESSION_FILTERS, scope: "trees", repo: "a-long-repository-name" } : CLEAR_SESSION_FILTERS,
        machines: ["fixture-a", "fixture-b"], harnesses: [], resultCount: 120,
        statusCounts, countsAvailable: true,
        mobile: width <= 760 || (coarse && width <= 1024), page: 1, pageCount: 5, open: false,
        onPageChange() {}, onChange() {}, onOpenChange() {},
        statusNotice: hostOffline ? createElement(StatusNotice, { notice: hostOfflineNotice(hostOffline), onDismiss() {}, surface: "dashboard", inline: true }) : undefined,
      });
      const machine = focused ? '<label class="machine-filter"><select class="machine-filter-select" aria-label="Filter sessions by machine"><option>All machines</option></select></label>' : "";
      return `<main class="dash workspace-shell"><header class="dash-head workspace-head"><div class="workspace-head-start">${brand}${nav}</div>${usage}<div class="dash-actions"><div class="dash-group">${machine}${layouts}</div><div class="dash-group dash-create-actions">${menu}${newButton}</div></div></header></main>`;
    },
    compact: `const HEADER_COMPACT_STAGES=${JSON.stringify(responsive.HEADER_COMPACT_STAGES)};const chooseHeaderCompactStage=${responsive.chooseHeaderCompactStage.toString()};(${responsive.updateHeaderCompaction.toString()})(document.querySelector('.workspace-head'));`,
  };
}
export const headerMeasure = `
 const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 const header=document.querySelector('.workspace-head'),stage=Number(header.dataset.headerCompact);
 const controls=[...header.querySelectorAll('.brand-title,.session-status-count,.session-list-pagination,.session-filter-searchbar,.header-usage,.layout-picker,.header-menu-trigger,.dashboard-new-session,.machine-filter')].filter(visible);
 const rects=controls.map(e=>e.getBoundingClientRect());
 const centers=rects.map(r=>r.top+r.height/2);
 const overlap=rects.some((a,i)=>rects.some((b,j)=>i<j&&Math.min(a.right,b.right)-Math.max(a.left,b.left)>1));
 const statusButtons=[...header.querySelectorAll('.session-status-count')];
 const semanticCounts=statusButtons.length===4 && statusButtons.every(button=>button.getAttribute('aria-label')&&getComputedStyle(button).color===getComputedStyle(button.querySelector('.card-status-icon')).color)
   && getComputedStyle(statusButtons[0]).color==='rgb(61, 220, 132)' && getComputedStyle(statusButtons[1]).color==='rgb(76, 141, 255)'
   && new Set(statusButtons.map(button=>getComputedStyle(button).color)).size===4;
 const result={semanticCounts,stage, bounded:rects.every(r=>r.left>=0&&r.right<=innerWidth+1),overlap,rowSpread:Math.max(...centers)-Math.min(...centers),
  counts:[...header.querySelectorAll('.session-status-count')].filter(visible).length,
  inline:[...header.querySelectorAll('.layout-picker-inline button')].filter(visible).length,
  picker:visible(header.querySelector('.layout-picker-trigger')),newVisible:visible(header.querySelector('.dashboard-new-session')),
  scope:visible(header.querySelector('[data-filter-chip="scope"]')), usage:visible(header.querySelector('.header-usage')),
  usageText:[...header.querySelectorAll('.hu-reset')].filter(visible).length, arrows:[...header.querySelectorAll('.session-list-page-button')].filter(visible).length,
  overflow:document.documentElement.scrollWidth-innerWidth};
`;

/** Apply the production header measurement when testing a server-rendered consumer. */
export function measureHeaderMarkup<T>(markup: string, width: number, script: string, reducedMotion = false, height = 800, chromeArgs: readonly string[] = []): T {
  const prelude = `const HEADER_COMPACT_STAGES=${JSON.stringify(HEADER_COMPACT_STAGES)};const chooseHeaderCompactStage=${chooseHeaderCompactStage.toString()};const workspaceHeader=document.querySelector('.workspace-head');if(workspaceHeader)(${updateHeaderCompaction.toString()})(workspaceHeader);`;
  return measureUiMarkup<T>(markup, width, prelude + script, reducedMotion, height, chromeArgs);
}
