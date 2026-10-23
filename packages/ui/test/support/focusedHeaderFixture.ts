import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderUsage } from "@agent-console/shared/api";
import { DashboardUsageContext } from "../../src/HeaderUsage.tsx";
import { SessionSlot } from "../../src/SessionSlot.tsx";
import { makeSession, makeSessionSlotProps } from "./fixtures.ts";

const NOW = Date.parse("2026-07-06T00:01:00Z");

/** The usage the top-bar chip would show for the focused session's account. */
export const FIXTURE_USAGE: ProviderUsage[] = [{
  provider: "claude", account: "20X", switch_key: "20X", label: "Claude", ok: true, stale: false, plan: "max",
  updated_at: NOW / 1000, note: null, error: null, reason_code: null, reset_credits: null, windows: [
    { key: "5h", label: "5h", used_percent: 9, window_minutes: 300, resets_at: NOW / 1000 + 12_000 },
    { key: "weekly", label: "weekly", used_percent: 20, window_minutes: 10_080, resets_at: NOW / 1000 + 507_600 },
  ],
}];

function fixtureSessions() {
  const roles = ["control", "steward", "nils cli", "tester", "reviewer", "agent-console-maintenance-worker"];
  return roles.map((repo, index) => makeSession({
    id: `focused-${index}`, machine: index % 2 ? "cedar" : "summit", agent: index === 3 ? "codex" : "claude",
    model: index === 3 ? "gpt-5.5-codex" : "claude-opus-5-5", reasoning_effort: "medium",
    title: index === 0
      ? "Focused header quota beside the account badge and dropdown navigation without reordering"
      : `Session ${index + 1} working on a fairly long task title`,
    repo_name: repo, status: "running",
    claude_account: index === 3 ? undefined : { schema_version: "agent-session.claude-account.v1", supported: true, state: "bound",
      selected_account: "20X", selection_source: "explicit", revision: 1, applied_runtime_id: "fixture" },
    context_usage: { used_tokens: 299_000, window_tokens: 1_000_000, observed_at: "2026-07-06T00:00:00Z", source: "claude-transcript", model: "claude-opus-5-5" },
  }));
}

export type FocusedHeaderView = "header" | "title-menu" | "pager-menu" | "overview-menu" | "empty-slot-menu";

/**
 * One #870 consumer view at `width`: the focused header (`header`), its title
 * dropdown, its position picker, or a grid card's dropdown. Phone widths use
 * the phone focused layout; Move here is offered as with manual ordering.
 */
export function renderFocusedHeaderView(view: FocusedHeaderView, width: number): string {
  const mobile = width <= 760;
  const sessions = fixtureSessions();
  const session = sessions[0]!;
  const slot = `${session.machine}/${session.id}`;
  const focused = view !== "overview-menu" && view !== "empty-slot-menu";
  const empty = view === "empty-slot-menu";
  const openSlotMenuKey = view === "title-menu" || view === "overview-menu" || empty ? "0:focused" : view === "pager-menu" ? "0:focused:nav" : null;
  const props = makeSessionSlotProps({
    session: empty ? undefined : session, options: sessions, slot: empty ? null : slot, focused, focusedKey: focused ? slot : null, viewport: { mobile: focused && mobile },
    sessionOrdinal: 1, sessionCount: sessions.length, sessionNavList: sessions,
    slotMenuKey: "0:focused", openSlotMenuKey, now: NOW, onMoveSessionHere() {},
  });
  const slotMarkup = renderToStaticMarkup(createElement(DashboardUsageContext.Provider, {
    value: { providers: FIXTURE_USAGE, reachable: true, loaded: true, error: null },
  }, createElement(SessionSlot, props)));
  return focused
    ? `<ol class="session-workspace ${mobile ? "mobile" : "desktop"} is-focused">${slotMarkup}</ol>`
    : empty
      // A four-pane grid: the narrow card that exposed the unfitted empty-slot menu.
      ? `<ol class="session-workspace desktop mode-4 slots-4" style="height:640px">${slotMarkup}<li class="terminal-slot"></li><li class="terminal-slot"></li><li class="terminal-slot"></li></ol>`
      : `<ol class="session-workspace desktop mode-1" style="height:520px">${slotMarkup}</ol>`;
}

/**
 * Self-contained checks for paired captures: applies the shipped drop-order
 * fit when present and measures the header and every open dropdown row.
 */
export function measureFocusedHeaderLayout() {
  const checks: { name: string; actual: unknown; expected: unknown; pass: boolean }[] = [];
  const add = (name: string, actual: unknown, expected: unknown, pass: boolean) => checks.push({ name, actual, expected, pass });
  const visible = (element: Element | null | undefined) => Boolean(element) && element!.getClientRects().length > 0 && getComputedStyle(element!).visibility !== "hidden";
  // The production fit (harnessCompact.ts), inlined so both refs run the same measurement.
  const fit = (target: HTMLElement, row: HTMLElement, title: HTMLElement | null, minTitlePx: number) => {
    for (const stage of [0, 1, 2, 3, 4, 5]) {
      target.setAttribute("data-harness-compact", String(stage));
      if (row.scrollWidth <= row.clientWidth + 1 && (title ? title.getBoundingClientRect().width : Infinity) >= minTitlePx) return stage;
    }
    return 5;
  };
  const order = ["quota meters", "quota", "context tokens", "effort", "model"];
  const hiddenOf = (root: Element) => Object.entries({
    "quota meters": [...root.querySelectorAll(":scope > .session-quota .hu-meter")],
    quota: [...root.querySelectorAll(":scope > .session-quota .hu-pct, :scope > .session-quota .hu-reset")],
    "context tokens": [...root.querySelectorAll(":scope > .session-model-badge [data-context-tokens]")],
    effort: [...root.querySelectorAll(":scope > .session-model-badge > .session-model-effort")],
    model: [...root.querySelectorAll(":scope > .session-model-badge > .session-model-name")],
  }).filter(([, list]) => list.length > 0 && list.every(element => !visible(element))).map(([name]) => name);
  const inOrder = (hidden: string[]) => hidden.every(name => order.slice(0, order.indexOf(name)).every(earlier => hidden.includes(earlier) || earlier.startsWith("quota")));
  const head = document.querySelector<HTMLElement>(".terminal-slot .slot-head")!;
  const details = head.querySelector<HTMLElement>(":scope > .slot-session-details")!;
  const desktopFocused = Boolean(document.querySelector(".session-workspace.desktop.is-focused"));
  // A closed title menu keeps its (empty) dropdown in the DOM; only an open one counts.
  const menuOpen = Boolean(head.querySelector(".slot-title-menu[open] .slot-title-dropdown, .slot-session-nav-dropdown"));
  // The live header fits itself (useHarnessCompact) whether or not a menu is open.
  const stage = desktopFocused ? fit(details, head, details.querySelector<HTMLElement>(":scope > .slot-title-row > .slot-title-menu"), 160) : 0;
  if (desktopFocused && !menuOpen) {
    const hidden = hiddenOf(details);
    const quota = details.querySelector(":scope > .session-quota");
    add("header: account quota rendered beside the account badge", quota ? quota.previousElementSibling?.className : null, "account-usage-root",
      Boolean(quota && quota.previousElementSibling?.classList.contains("account-usage-root")));
    // A stage that drops the quota numbers leaves nothing to compare.
    add("header: quota matches the top-bar chip", [stage, quota?.textContent ?? null], "91% 3h 20m · 80% 5d 21h unless stage >= 2",
      Boolean(quota) && (stage >= 2 || (/91%3h 20m/.test(quota!.textContent ?? "") && /80%5d 21h/.test(quota!.textContent ?? ""))));
    add("header: items drop in the documented order", hidden, "prefix of quota meters, quota, context tokens, effort, model", inOrder(hidden));
    for (const [name, selector] of [["harness icon", ".agent-retitle-button"], ["account badge", ".account-usage-root"], ["title", ".slot-title-row"]] as const) {
      add(`header: ${name} kept`, visible(details.querySelector(`:scope > ${selector}`)), true, visible(details.querySelector(`:scope > ${selector}`)));
    }
    const items = [...details.children].filter(visible);
    const mid = (element: Element) => { const r = element.getBoundingClientRect(); return r.top + r.height / 2; };
    const spread = Math.max(...items.map(mid)) - Math.min(...items.map(mid));
    add("header: one row without wrapping", spread, "<= 4 CSS px", spread <= 4);
    add("header: no horizontal overflow", [head.scrollWidth, head.clientWidth], "scrollWidth <= clientWidth", head.scrollWidth <= head.clientWidth + 1);
  }
  if (menuOpen) {
    const rows = [...head.querySelectorAll<HTMLElement>(".slot-title-menu[open] .slot-title-dropdown .slot-menu-item, .slot-session-nav-dropdown .slot-menu-item")]
      .filter(row => row.querySelector(".repo-badge"));
    add("menu: session rows rendered", rows.length, ">= 6", rows.length >= 6);
    const badges = rows.map(row => row.querySelector<HTMLElement>(".repo-badge")!);
    const widths = badges.map(badge => Math.round(badge.getBoundingClientRect().width));
    add("menu: badges share one width", widths, "identical", new Set(widths).size === 1);
    add("menu: badges are single-line", badges.map(badge => badge.querySelectorAll(".repo-badge-line").length), "all 1", badges.every(badge => badge.querySelectorAll(".repo-badge-line").length === 1));
    const centred = badges.every(badge => { const b = badge.getBoundingClientRect(), l = badge.querySelector(".repo-badge-line")!.getBoundingClientRect(); return Math.abs((l.left + l.right) / 2 - (b.left + b.right) / 2) <= 1; });
    add("menu: badge text centred", centred, true, centred);
    const lefts = rows.map(row => Math.round(row.querySelector(".slot-menu-label")!.getBoundingClientRect().left));
    add("menu: titles start in one column", lefts, "identical", new Set(lefts).size === 1);
    const hosts = rows.filter(row => /\b(summit|cedar)\b/.test(row.textContent ?? "")).length;
    add("menu: rows carry no host text", hosts, 0, hosts === 0);
    const harness = rows.filter(row => row.querySelector(".session-harness .session-model-badge") && row.querySelector(".session-harness .agent-badge")).length;
    add("menu: rows carry the status-line harness segment", harness, rows.length, harness === rows.length);
    let ordered = true, overflow = 0;
    for (const row of rows) {
      const target = row.querySelector<HTMLElement>(".session-harness");
      if (!target) continue;
      fit(target, row, row.querySelector<HTMLElement>(".slot-menu-label"), 120);
      ordered &&= inOrder(hiddenOf(target));
      if (row.scrollWidth > row.clientWidth + 1) overflow++;
    }
    add("menu: row harness drops in the documented order", ordered, true, ordered);
    add("menu: rows do not overflow", overflow, 0, overflow === 0);
    if (document.querySelector(".is-focused")) {
      const moves = rows.filter(row => !row.classList.contains("current")).map(row => row.parentElement?.querySelector<HTMLElement>(".slot-menu-move"));
      const ok = moves.every(move => move && visible(move) && move.getBoundingClientRect().right <= move.parentElement!.getBoundingClientRect().right + 0.5);
      add("menu: Move here at the far right of each other row", moves.filter(Boolean).length, rows.length - 1, ok);
    }
  }
  add("page horizontal overflow", document.documentElement.scrollWidth, innerWidth, document.documentElement.scrollWidth <= innerWidth);
  return checks;
}

/** A desktop focused session; `menu` opens its title dropdown, `moveHere` offers Move here. */
export function renderFocusedHeaderFixture({ menu = false, moveHere = false }: { menu?: boolean; moveHere?: boolean } = {}): string {
  const sessions = fixtureSessions();
  const session = sessions[0]!;
  const slot = `${session.machine}/${session.id}`;
  const props = makeSessionSlotProps({
    session, options: sessions, slot, focused: true, focusedKey: slot, viewport: { mobile: false },
    sessionOrdinal: 1, sessionCount: sessions.length, sessionNavList: sessions,
    slotMenuKey: "0:focused", openSlotMenuKey: menu ? "0:focused" : null, now: NOW,
    ...(moveHere ? { onMoveSessionHere() {} } : {}),
  });
  const slotMarkup = renderToStaticMarkup(createElement(DashboardUsageContext.Provider, {
    value: { providers: FIXTURE_USAGE, reachable: true, loaded: true, error: null },
  }, createElement(SessionSlot, props)));
  return `<ol class="session-workspace desktop is-focused">${slotMarkup}</ol>`;
}
