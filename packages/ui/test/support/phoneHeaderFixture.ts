import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSlot } from "../../src/SessionSlot.tsx";
import { makeSession, makeSessionSlotProps } from "./fixtures.ts";

const NOW = Date.parse("2026-10-15T00:00:00Z");

/**
 * A focused header (#882) for a Claude or Codex session with long model/context
 * text, page 1 of 47: the phone layout up to 760 CSS px, desktop above.
 */
export function renderPhoneFocusedHeader(agent: "claude" | "codex", width = 412): string {
  const mobile = width <= 760;
  const codex = agent === "codex";
  const session = makeSession({
    id: `${agent}-phone`, agent, status: "running", repo_name: "agent-console", title: "Phone header with a long session title",
    model: codex ? "gpt-6.1-sol" : "claude-opus-5-5", reasoning_effort: "medium",
    started_at: "2026-10-12T10:00:00Z", created_at: "2026-10-12T10:00:00Z",
    context_usage: codex
      ? { used_tokens: 255_000, window_tokens: 475_000, observed_at: "2026-10-14T23:59:00Z", source: "codex-rollout", model: "gpt-6.1-sol" }
      : { used_tokens: 398_000, window_tokens: 1_000_000, observed_at: "2026-10-14T23:59:00Z", source: "claude-transcript", model: "claude-opus-5-5" },
    // As on the tester's S22: auto-resume on and a status age of 2d14h.
    auto_resume_control_available: true,
    auto_resume: { schema_version: "agent-session.auto-resume.v1", supported: true, enabled: true, state: "enabled" },
    turn_state: { schema_version: "agent-session.turn-state.v1", phase: "waiting", phase_changed_at: "2026-10-12T10:00:00Z", revision: 1,
      source: { kind: "provider_hook", provider: agent, confidence: "authoritative" },
      last_turn: { completed_at: "2026-10-12T10:00:00Z", outcome: "completed" } },
    ...(codex
      ? { codex_account: { schema_version: "agent-session.codex-account.v1", supported: true, state: "bound", selected_account: "pro", revision: 1 } }
      : { claude_account: { schema_version: "agent-session.claude-account.v1", supported: true, state: "bound",
        selected_account: "20X", selection_source: "explicit", revision: 1, applied_runtime_id: "fixture" } }),
  });
  const sessions = [session, ...Array.from({ length: 46 }, (_, index) => makeSession({ id: `other-${index}`, title: `Other ${index}` }))];
  const slot = `${session.machine}/${session.id}`;
  return `<ol class="session-workspace ${mobile ? "mobile" : "desktop"} is-focused">${renderToStaticMarkup(createElement(SessionSlot, makeSessionSlotProps({
    session, slot, options: sessions, focused: true, focusedKey: slot, viewport: { mobile },
    sessionOrdinal: 1, sessionCount: sessions.length, sessionNavList: sessions, slotMenuKey: "0:focused", now: NOW,
  })))}</ol>`;
}

/**
 * Self-contained checks for paired captures. `fitPhone` applies the phone
 * row-2 fit (useHarnessCompact in SessionSlot.tsx) when that side ships it.
 */
export function measurePhoneFocusedHeader(fitPhone: boolean) {
  const checks: { name: string; actual: unknown; expected: unknown; pass: boolean }[] = [];
  const add = (name: string, actual: unknown, expected: unknown, pass: boolean) => checks.push({ name, actual, expected, pass });
  const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const head = document.querySelector<HTMLElement>(".terminal-slot.is-focused .slot-head")!;
  const rowTwo = head.querySelector<HTMLElement>(":scope > .slot-focus-row-two");
  if (rowTwo) {
    const badge = rowTwo.querySelector<HTMLElement>(":scope > .session-model-badge")!;
    let stage = 0;
    if (fitPhone) {
      const name = badge.querySelector<HTMLElement>(":scope > .session-model-name");
      for (stage = 0; stage <= 5; stage++) {
        rowTwo.setAttribute("data-harness-compact", String(stage));
        if (badge.scrollWidth <= badge.clientWidth + 1 && (name ? name.getBoundingClientRect().width : Infinity) >= 40) break;
      }
      stage = Math.min(stage, 5);
    }
    const items = [...head.querySelectorAll(":scope > .slot-focus-row-one > *, :scope > .slot-focus-row-two > *")].filter(visible);
    const tops: number[] = [];
    for (const item of items) {
      const r = item.getBoundingClientRect(), mid = Math.round(r.top + r.height / 2);
      if (!tops.some(seen => Math.abs(seen - mid) <= 6)) tops.push(mid);
    }
    const rowOf = (element: Element) => { const r = element.getBoundingClientRect(), mid = r.top + r.height / 2; return tops.findIndex(top => Math.abs(top - mid) <= 6); };
    const pager = rowTwo.querySelector(":scope > .slot-session-nav-menu, :scope > .slot-session-nav");
    add("phone: header rows", tops.length, 2, tops.length === 2);
    add("phone: page switcher on row 2", pager ? rowOf(pager) : null, 1, Boolean(pager) && rowOf(pager!) === 1);
    add("phone: effort and usage not cut mid-text", [badge.scrollWidth, badge.clientWidth], "scrollWidth <= clientWidth", badge.scrollWidth <= badge.clientWidth + 1);
    add("phone: context percentage visible", stage, "visible at every stage", badge.querySelector("[data-context-usage]")!.getBoundingClientRect().width > 0);
  }
  add("page horizontal overflow", document.documentElement.scrollWidth, innerWidth, document.documentElement.scrollWidth <= innerWidth);
  return checks;
}
