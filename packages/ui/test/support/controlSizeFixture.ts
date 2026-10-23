import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { createUiSsrHarness } from "./ssr.ts";
import { makeSession, makeSessionSlotProps } from "./fixtures.ts";
import { CLEAR_SESSION_FILTERS } from "../../src/sessionFilters.ts";

/** Synthetic data only: the same production surfaces serve baseline audits and regression tests. */
export async function controlSizeFixture(width: number, root = new URL("../..", import.meta.url).pathname, open = false) {
  const mobile = width < 761;
  const require = createRequire(`${root}/package.json`);
  let badgeRegistry: any;
  let BadgeProvider: any;
  const renderComponent: typeof import("./ssr.ts").renderComponent = (component, props) => require("react-dom/server").renderToStaticMarkup(require("react").createElement(BadgeProvider, { registry: badgeRegistry }, require("react").createElement(component, props)));
  const harness = createUiSsrHarness({
    createServer: config => createServer({ ...config, root }),
    plugins: [{ name: "size-fixture-terminal", enforce: "pre", resolveId(source, importer) {
      if (source.endsWith("useSharedClock.ts")) return "\0size-clock";
      return source.endsWith("TerminalPane.tsx") && importer?.includes("/src/") ? "\0size-terminal" : null;
    }, load(id) { if (id === "\0size-clock") return 'export function useSharedClock(){return Date.parse("2026-10-14T00:00:00Z");}'; return id === "\0size-terminal" ? 'import React from "react"; export function TerminalPane(){return React.createElement("div",null,"Synthetic terminal preview");}' : null; } }],
  });
  try {
    const { SessionListNavigator } = await harness.loadModule<typeof import("../../src/SessionListNavigator.tsx")>("/src/SessionListNavigator.tsx");
    const { SessionSlot } = await harness.loadModule<typeof import("../../src/SessionSlot.tsx")>("/src/SessionSlot.tsx");
    const { MobileSessionList } = await harness.loadModule<typeof import("../../src/MobileSessionList.tsx")>("/src/MobileSessionList.tsx");
    const { StatusNotice } = await harness.loadModule<typeof import("../../src/StatusNotice.tsx")>("/src/StatusNotice.tsx");
    const { IconButton } = existsSync(`${root}/src/IconButton.tsx`) ? await harness.loadModule<typeof import("../../src/IconButton.tsx")>("/src/IconButton.tsx") : { IconButton: undefined };
    const extensionModule = await harness.loadModule<typeof import("../../src/extensions.tsx")>("/src/extensions.tsx");
    BadgeProvider = extensionModule.UiExtensionsProvider;
    badgeRegistry = extensionModule.createUiExtensionRegistry([{ id: "fixture", sessionBadges: [{ id: "role", render: (_item, context) =>
      require("react").createElement(IconButton, { preset: "identity", className: "fixture-role", "aria-label": "Fixture role", style: { "--icon-size": "var(--icon-role-size)" }, onClick: context.onLineage }, "◇") }] }]);
    const logoSrc = `data:image/svg+xml;base64,${Buffer.from(readFileSync(`${root}/public/favicon.svg`)).toString("base64")}`;
    const logo = IconButton ? renderComponent(IconButton, { className: "brand-title-mark-button brand-title-mark", preset: "identity", children: require("react").createElement("img", { className: "brand-title-icon", src: logoSrc, alt: "" }) }) : `<button class="brand-title-mark-button brand-title-mark"><img class="brand-title-icon" src="${logoSrc}" alt=""></button>`;
    const { HeaderMenu } = await harness.loadModule<typeof import("../../src/HeaderMenu.tsx")>("/src/HeaderMenu.tsx");
    const { PlusIcon } = await harness.loadModule<typeof import("../../src/icons.tsx")>("/src/icons.tsx");
    const menu = renderComponent(HeaderMenu, { open: false, onOpenChange() {}, historyAvailable: true, onHistory() {}, onUsage() {}, onDebug() {}, onSettings() {} });
    const newButton = require("react-dom/server").renderToStaticMarkup(require("react").createElement(IconButton ?? "button", { preset:"standard", className: "btn dashboard-new-session", "aria-label": "New session", title:"New session" }, require("react").createElement(PlusIcon)));
    const nav = renderComponent(SessionListNavigator, { filters: CLEAR_SESSION_FILTERS, machines: ["host-a", "host-b"], roles: ["steward", "reviewer"], harnesses: [{ id: "codex", label: "Codex" }], resultCount: 48,
      mobile, countsAvailable: true, statusCounts: { working: 2, waiting: 3, attention: 1, unknown: 0, stopped: 1 }, page: 1, pageCount: 3, open, onChange() {}, onOpenChange() {}, onPageChange() {} });
    const now = Date.parse("2026-10-14T00:00:00Z");
    const session = makeSession({ id: "11111111-1111-4111-8111-111111111111", managed_resume_command_available: true, machine: "host-a", repo_name: "console", title: "Review the session layout", model: "example-model", reasoning_effort: "high", role: "steward",
      last_prompt: { text: "Compare consistent controls and readable card metadata.", truncated: false },
      turn_state: { schema_version: "agent-session.turn-state.v1", phase: "waiting", phase_changed_at: new Date(now - 159 * 60_000).toISOString(), revision: 1,
        source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" }, last_turn: { completed_at: new Date(now - 159 * 60_000).toISOString(), outcome: "completed" } } });
    const slot = (focused: boolean) => { const props = makeSessionSlotProps({ session, options: [session], focused, viewport: { mobile }, slot: "host-a:hs-1", now,
      sessionOrdinal: 1, sessionCount: 48, sessionNavList: [], onFocusSession() {} }); return renderComponent(SessionSlot, { ...props, actions: { ...props.actions, onLineageMarker() {} } }); };
    const card = mobile ? renderComponent(MobileSessionList, { sessions: [session], options: [session], machineColors: {}, reachableMachineNames: new Set(["host-a"]), activityDeliveryByMachine: new Map(), clockActive: false,
      resumingKey: null, autoResumePendingKey: null, accountPendingKey: null, accountsByProvider: { codex: {}, claude: {} }, initialScrollTop: 0, onScrollTopChange() {}, onOpen() {}, editingTitleKey: null,
      beginTitleEdit() {}, saveTitleEdit: async () => {}, cancelTitleEdit() {}, onRetitle() {}, onNewSession() {}, onSelectSession() {}, onResume: async () => {}, onAutoResume: async () => true, onAccount: async () => {}, onLineageMarker() {} }) : slot(false);
    const notice = (kind: "restored" | "attention") => renderComponent(StatusNotice, { notice: { kind, message: kind === "restored" ? "Console server connection restored" : "Some sessions need attention" }, onDismiss() {} });
    const rowsCss = readFileSync(`${root}/src/sessionCardRows.css`, "utf8");
    return `<style>${rowsCss}.audit-card .mobile-session-list{height:auto}.audit-card.session-workspace{height:200px;min-height:0}.audit-card .terminal-slot{min-height:0}.audit-detail.session-workspace{position:relative;inset:auto;height:200px;min-height:0}.audit-detail.session-workspace.is-focused .terminal-slot.is-focused{position:relative;inset:auto;width:100%;height:100%}.audit-notices{position:relative;height:230px;flex:none}.audit-notices .connection-notice-layer{position:relative;top:auto;margin:8px 0}.audit-label{margin:10px;font-size:12px;color:var(--muted)}</style>
      <main class="dash workspace-shell"><p class="audit-label">Overview</p><header class="audit-overview dash-head workspace-head"><div class="workspace-head-start"><div class="brand-title">${logo}<h1>Agent Console</h1></div>${nav}</div><div class="dash-actions dash-group dash-create-actions">${menu}${newButton}</div></header>
      <p class="audit-label">Session card</p><section class="audit-card ${mobile ? "" : "session-workspace desktop"}">${card}</section>
      <p class="audit-label">Session detail</p><section class="audit-detail session-workspace ${mobile ? "mobile" : "desktop"} is-focused">${slot(true)}</section>
      <p class="audit-label">Restored and warning notices</p><section class="audit-notices">${notice("restored")}${notice("attention")}<div class="repair-toast is-attention"><span>Some panes need repair</span><div class="repair-toast-actions"><button class="btn ghost">Review</button></div></div></section></main>`;
  } finally { await harness.close(); }
}

export const sizeSelectors = {
  logo: ".audit-overview .brand-title-mark", more: ".audit-overview .header-menu-trigger", create: ".audit-overview .dash-create-actions > .btn:last-child",
  listPager: ".audit-overview .session-list-pagination", filterBar: ".audit-overview .session-filter-searchbar", back: ".audit-detail .slot-back",
  detailPager: ".audit-detail .slot-session-nav", detailArrow: ".audit-detail .slot-session-nav-button", refresh: ".audit-detail .slot-refresh", copy: ".audit-detail .session-command-copy-button", close: ".audit-detail .slot-action.danger",
  repo: ".audit-card .repo-badge", role: ".audit-card .fixture-role", status: ".audit-card .session-activity-trigger", cardText: ".audit-card .session-model-badge",
  toast: ".audit-notices .is-restored", toastClose: ".audit-notices .is-restored .connection-notice-dismiss", warning: ".audit-notices .is-attention", warningClose: ".audit-notices .is-attention .connection-notice-dismiss", repairToast: ".audit-notices .repair-toast", repairAction: ".audit-notices .repair-toast-actions .btn",
} as const;
export const sizeMeasurementScript = `const selectors=${JSON.stringify(sizeSelectors)};const result={};for(const [name,selector] of Object.entries(selectors)){const el=document.querySelector(selector);if(!el){result[name]=null;continue;}const r=el.getBoundingClientRect(),s=getComputedStyle(el);result[name]={height:r.height,width:r.width,font:parseFloat(s.fontSize)};}`;
