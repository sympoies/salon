import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSlot } from "../../src/SessionSlot.tsx";
import { MobileSessionList } from "../../src/MobileSessionList.tsx";
import { makeSession, makeSessionSlotProps } from "./fixtures.ts";

export function renderSessionHarnessFixture(view: "overview" | "focused", width: number, focusedIndex = 0): string {
  const mobile = width <= 760;
  const sessions = ["claude-opus-5-5", "a-very-long-model-name-that-must-truncate-before-the-effort-and-usage"].map((model, index) => makeSession({
    id: `fixture-${index}`, machine: "fixture", agent: "claude", model, reasoning_effort: "medium",
    title: "Review session layout", repo_name: "example-repository", role: "reviewer",
    last_prompt: { text: "Check that the harness metadata stays on one line.", truncated: false },
    claude_account: { schema_version: "agent-session.claude-account.v1", supported: true, state: "bound",
      selected_account: "20X", selection_source: "explicit", revision: 1, applied_runtime_id: "fixture" },
    turn_state: { schema_version: "agent-session.turn-state.v1", phase: "waiting",
      phase_changed_at: "2026-07-05T23:59:00Z", revision: 1,
      source: { kind: "provider_hook", provider: "claude", confidence: "authoritative" },
      last_turn: { completed_at: "2026-07-05T23:59:00Z", outcome: "completed" } },
    context_usage: { used_tokens: 414999, window_tokens: 1000000, observed_at: "2026-10-15T00:00:00Z", source: "claude-transcript", model },
  }));
  if (view === "overview" && mobile) {
    return renderToStaticMarkup(createElement(MobileSessionList, {
      sessions, options: sessions, machineColors: {}, reachableMachineNames: new Set(["fixture"]),
      activityDeliveryByMachine: new Map(), clockActive: false, resumingKey: null, autoResumePendingKey: null,
      accountPendingKey: null, accountsByProvider: { codex: {}, claude: {} }, initialScrollTop: 0,
      onScrollTopChange() {}, onOpen() {}, editingTitleKey: null, beginTitleEdit() {}, saveTitleEdit: async () => {},
      cancelTitleEdit() {}, onRetitle() {}, onNewSession() {}, onSelectSession() {}, onResume() {},
      onAutoResume: async () => true, onAccount: async () => {},
    }));
  }
  const focused = view === "focused";
  const cards = (focused ? [sessions[focusedIndex]!] : [...sessions, ...sessions, ...sessions]).map((session, index) =>
    renderToStaticMarkup(createElement(SessionSlot, makeSessionSlotProps({ session, options: sessions,
      slot: `fixture:${session.id}`, index, focused, focusedKey: focused ? `fixture:${session.id}` : null,
      viewport: { mobile }, sessionOrdinal: focused ? focusedIndex + 1 : null, sessionCount: 2, sessionNavList: sessions,
    }))));
  // Each focused fixture mounts one fullscreen header, as the product does.
  return focused ? cards.map(card => `<ol class="session-workspace ${mobile ? "mobile" : "desktop"} is-focused">${card}</ol>`).join("")
    : `<ol class="session-workspace desktop mode-6">${cards.join("")}</ol>`;
}

/** Self-contained so the same measurements run in Chrome and paired captures. */
export function measureSessionHarnessLayout() {
  const checks: { name: string; actual: unknown; expected: unknown; pass: boolean }[] = [];
  const add = (name: string, actual: unknown, expected: unknown, pass: boolean) => checks.push({ name, actual, expected, pass });
  const cards = [...document.querySelectorAll<HTMLElement>(".terminal-slot,.mobile-session-card")];
  // The live phone focused header fits row 2 (useHarnessCompact, harnessCompact.ts):
  // inlined here so the paired captures run the same measurement.
  for (const rowTwo of document.querySelectorAll<HTMLElement>(".session-workspace.mobile.is-focused .slot-focus-row-two")) {
    const badge = rowTwo.querySelector<HTMLElement>(":scope > .session-model-badge")!;
    const name = badge.querySelector<HTMLElement>(":scope > .session-model-name");
    for (const stage of [0, 1, 2, 3, 4, 5]) {
      rowTwo.setAttribute("data-harness-compact", String(stage));
      if (badge.scrollWidth <= badge.clientWidth + 1 && (name ? name.getBoundingClientRect().width : Infinity) >= 40) break;
    }
  }
  for (const [index, card] of cards.entries()) {
    const badge = card.querySelector<HTMLElement>(".session-model-badge")!;
    const usage = badge.querySelector<HTMLElement>("[data-context-usage]")!;
    const account = card.querySelector<HTMLElement>(".account-usage-root")!;
    const provider = card.querySelector<HTMLElement>(".agent-retitle-button")!;
    const row = card.querySelector<HTMLElement>(".slot-session-card-row-two,.mobile-session-card-row-two,.slot-focus-row-two") ?? card.querySelector<HTMLElement>(".slot-head")!;
    const label = badge.querySelector(".session-model-effort") ?? badge.firstElementChild!;
    // Measure the final visible glyphs of the effort, rather than the flex box
    // whose expansion caused #859. Range rects also detect a wrapped line.
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    let text: Node | null, effortText: Node | null = null;
    while ((text = walker.nextNode())) if (text.textContent?.includes("medium")) effortText = text;
    let gap = Infinity, effortTop = Infinity;
    if (effortText) {
      const start = effortText.textContent!.indexOf("medium");
      const range = document.createRange(); range.setStart(effortText, start); range.setEnd(effortText, start + 6);
      const r = range.getBoundingClientRect(); gap = usage.getBoundingClientRect().left - r.right; effortTop = r.top;
    }
    const u = usage.getBoundingClientRect(), b = badge.getBoundingClientRect(), a = account.getBoundingClientRect();
    const p = provider.getBoundingClientRect(), r = row.getBoundingClientRect();
    const model = badge.querySelector<HTMLElement>(".session-model-name") ?? label as HTMLElement;
    const prefix = `card ${index}`;
    // A phone header that dropped the effort to keep row 2 on one line (#882)
    // has no effort to measure; the drop order itself is covered elsewhere.
    const effortShown = getComputedStyle(label).display !== "none";
    if (effortShown) add(`${prefix}: inline effort/usage gap`, gap, "0..8 CSS px", gap >= -0.5 && gap <= 8);
    add(`${prefix}: account/model/usage order`, [a.right, b.left, u.left], "account before model before usage", a.right <= b.left + 0.5 && b.left < u.left);
    add(`${prefix}: usage visible on harness row`, [u.left, u.right, u.top, r.top, r.bottom], "fully visible on one row",
      u.width > 0 && u.left >= b.left && u.right <= b.right + 0.5 && u.right <= r.right + 0.5 && u.top >= r.top && u.bottom <= r.bottom + 0.5);
    add(`${prefix}: usage text`, usage.textContent?.trim(), "· 41% 415k/1M", usage.textContent?.trim() === "· 41% 415k/1M");
    if (effortShown) add(`${prefix}: effort stays visible`, effortTop, "same line as usage", Math.abs(effortTop - u.top) <= 3);
    const status = card.querySelector<HTMLElement>(".session-activity-root")!.getBoundingClientRect();
    add(`${prefix}: status at right`, [status.left, status.right, r.right], "after usage within right edge", status.left >= u.right - 0.5 && status.right <= r.right + 0.5 && r.right - status.right <= (innerWidth <= 760 && card.classList.contains("is-focused") ? 130 : 100));
    if (model.textContent?.startsWith("a-very-long-") && innerWidth < 1600 && (!card.classList.contains("is-focused") || innerWidth <= 760)) {
      add(`${prefix}: long model ellipsis`, [model.clientWidth, model.scrollWidth, getComputedStyle(model).textOverflow], "clipped with ellipsis",
        model.clientWidth < model.scrollWidth && getComputedStyle(model).textOverflow === "ellipsis");
    }
    if (card.classList.contains("is-focused") && innerWidth > 760) {
      add(`${prefix}: desktop provider immediately before account`, [p.right, a.left, provider.nextElementSibling?.className], "right group, gap <=8px",
        provider.nextElementSibling === account && p.right <= a.left && a.left - p.right <= 8 && !provider.closest(".slot-title-row"));
      add(`${prefix}: desktop title left of provider`, card.querySelector(".slot-title-row")!.getBoundingClientRect().right, p.left,
        card.querySelector(".slot-title-row")!.getBoundingClientRect().right <= p.left + 0.5);
      const refresh = card.querySelector(".slot-refresh")!.getBoundingClientRect();
      add(`${prefix}: refresh at right`, [refresh.left, u.right, refresh.right, r.right], "after usage inside header", refresh.left >= u.right && refresh.right <= r.right + 0.5);
    }
  }
  add("consumer cards rendered", cards.length, ">0", cards.length > 0);
  add("page horizontal overflow", document.documentElement.scrollWidth, innerWidth, document.documentElement.scrollWidth <= innerWidth);
  return checks;
}
