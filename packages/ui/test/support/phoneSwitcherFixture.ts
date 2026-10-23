import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSlot } from "../../src/SessionSlot.tsx";
import { sessionKey } from "../../src/layout.ts";
import { makeSession, makeSessionSlotProps } from "./fixtures.ts";

const NOW = Date.parse("2026-10-17T00:00:00Z");
// Slot state left over from an earlier layout, as on the tester's phone.
const LEFTOVER_SLOTS = [13, 14, 8, 15];

/**
 * The focused session's switcher (#945), open: sixteen sessions whose stored
 * grid slots still point at four of them. `mobile` selects the phone layout.
 */
export function renderOpenSwitcher(mobile: boolean): string {
  const sessions = Array.from({ length: 16 }, (_, index) => makeSession({
    id: `s${index + 1}`, title: `Session ${index + 1}: review the implementation`, repo_name: "agent-console", status: "running",
  }));
  const current = sessions[2]!;
  const slot = sessionKey(current);
  const gridKeys = LEFTOVER_SLOTS.map((n) => sessionKey(sessions[n - 1]!));
  return `<ol class="session-workspace ${mobile ? "mobile" : "desktop"} is-focused">${renderToStaticMarkup(createElement(SessionSlot, makeSessionSlotProps({
    session: current, slot, options: sessions, focused: true, focusedKey: slot, viewport: { mobile },
    sessionOrdinal: 3, sessionCount: sessions.length, sessionNavList: sessions, sessionNavGridKeys: gridKeys,
    slotMenuKey: "0:focused", openSlotMenuKey: "0:focused:nav", now: NOW,
  })))}</ol>`;
}

/** Self-contained checks for paired captures; serialized into the page. */
export function measureOpenSwitcher(mobile: boolean) {
  const checks: { name: string; actual: unknown; expected: unknown; pass: boolean }[] = [];
  const add = (name: string, actual: unknown, expected: unknown) => checks.push({ name, actual, expected, pass: actual === expected });
  const labels = [...document.querySelectorAll(".slot-session-nav-group-label")].map((node) => node.textContent);
  const ordinals = [...document.querySelectorAll(".slot-session-nav-dropdown .slot-menu-ordinal")].map((node) => Number(node.textContent));
  const dropdown = document.querySelector(".slot-session-nav-dropdown")!.getBoundingClientRect();
  add("switcher rows", ordinals.length, 16);
  add("IN GRID headings", labels.filter((label) => label === "In grid").length, mobile ? 0 : 1);
  add("group headings", labels.length, mobile ? 0 : 2);
  if (mobile) add("rows follow the session list order", ordinals.every((n, i) => n === i + 1), true);
  add("dropdown inside the viewport width", dropdown.left >= 0 && dropdown.right <= innerWidth, true);
  return checks;
}
