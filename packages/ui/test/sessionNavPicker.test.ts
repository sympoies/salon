import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { type ComponentType } from "react";
import type { Plugin } from "vite";
import type { SessionPagerProps, SessionSlotProps } from "../src/SessionSlot.tsx";
import { sessionKey } from "../src/layout.ts";
import type { Session } from "../src/types.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { uiSource, uiStyles } from "./support/source.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

const dashboardSource = uiSource("Dashboard.tsx");
const sessionSlotSource = uiSource("SessionSlot.tsx");
const titleMenuSource = uiSource("SessionTitleMenu.tsx");
const styles = uiStyles();

type SessionSlotComponent = ComponentType<SessionSlotProps>;
type SessionPagerComponent = ComponentType<SessionPagerProps>;

const ssr = createUiSsrHarness([mockTerminalPanePlugin()]);

function mockTerminalPanePlugin(): Plugin {
  const mockId = "\0terminal-pane-mock";
  return {
    name: "mock-terminal-pane",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("TerminalPane.tsx") && importer?.includes("/src/")) {
        return mockId;
      }
      return null;
    },
    load(id) {
      if (id !== mockId) {
        return null;
      }
      return `
        import React from "react";
        export function TerminalPane() {
          return React.createElement("div", { className: "terminal-pane-mock" });
        }
      `;
    },
  };
}

async function loadSessionSlot(): Promise<SessionSlotComponent> {
  const module = await ssr.loadModule<{ SessionSlot: SessionSlotComponent }>("/src/SessionSlot.tsx");
  return module.SessionSlot as SessionSlotComponent;
}

async function loadSessionPager(): Promise<SessionPagerComponent> {
  const module = await ssr.loadModule<{ SessionPager: SessionPagerComponent }>("/src/SessionSlot.tsx");
  return module.SessionPager as SessionPagerComponent;
}

// Three sessions in ⌘-order; the focused slot is the second (ordinal 2 of 3).
const alpha = makeSession({ id: "hs-alpha", machine: "summit", title: "Alpha session" });
const bravo = makeSession({ id: "hs-bravo", machine: "summit", title: "Bravo session" });
const charlie = makeSession({ id: "hs-charlie", machine: "sable", title: "Charlie session" });
const navList = [alpha, bravo, charlie];
const focusedSlot = sessionKey(bravo);

function focusedPickerProps(overrides: Record<string, unknown> = {}): SessionSlotProps {
  return makeSessionSlotProps({
    slot: focusedSlot,
    session: bravo,
    focused: true,
    options: [bravo],
    sessionOrdinal: 2,
    sessionCount: 3,
    sessionNavList: navList,
    slotMenuKey: "slot-0",
    ...overrides,
  });
}

after(async () => {
  await ssr.close();
});

test("focused pager exposes the ordinal as a session-picker trigger", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderComponent(SessionSlot, focusedPickerProps());

  // The ordinal is now an interactive menu trigger, not a static aria-hidden span.
  assert.match(html, /class="slot-session-nav-menu"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /2 \/ 3/);
  // Closed by default: the other sessions are not listed until the menu opens.
  assert.doesNotMatch(html, /Alpha session/);
  assert.doesNotMatch(html, /Charlie session/);
});

test("opening the ordinal menu lists every session and marks the current one", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderComponent(SessionSlot, focusedPickerProps({ openSlotMenuKey: "slot-0:nav" }));

  assert.match(html, /class="slot-session-nav-dropdown"[^>]*role="menu"/);
  assert.match(html, /Alpha session/);
  assert.match(html, /Bravo session/);
  assert.match(html, /Charlie session/);
  // The current session is flagged so the picker shows where you are.
  assert.match(html, /aria-current="true"/);
});

test("prompt-target pager groups grid and overflow sessions with filtered-count context", async () => {
  const SessionPager = await loadSessionPager();
  const html = renderComponent(SessionPager, {
    currentKey: sessionKey(alpha),
    sessionOrdinal: 1,
    sessionCount: 3,
    sessions: navList,
    gridSessionKeys: [sessionKey(alpha), sessionKey(bravo)],
    shownSessionCount: 3,
    totalSessionCount: 5,
    contextLabel: "Prompt target",
    machineColors: {},
    open: true,
    onOpenChange: () => {},
    onPrevious: () => {},
    onNext: () => {},
    onSelect: () => {},
  });

  assert.match(html, /aria-label="Prompt target 1 of 3"/);
  assert.match(html, /3 shown · 5 total/);
  assert.match(html, /role="group"[^>]*aria-labelledby="[^"]+-grid"/);
  assert.match(html, />In grid</);
  assert.match(html, /role="group"[^>]*aria-labelledby="[^"]+-more"/);
  assert.match(html, />More sessions</);
});

test("the phone picker is one flat list in session order even with leftover slot state", async () => {
  // #945: a phone has no multi-tile grid, so slot state left over from another
  // layout must not surface as an "In grid" group.
  const SessionSlot = await loadSessionSlot();
  const html = renderComponent(SessionSlot, focusedPickerProps({
    openSlotMenuKey: "slot-0:nav",
    viewport: { mobile: true },
    sessionNavGridKeys: [sessionKey(charlie), sessionKey(alpha)],
  }));
  const dropdown = html.slice(html.indexOf("slot-session-nav-dropdown"));
  assert.doesNotMatch(dropdown, /In grid/);
  assert.doesNotMatch(dropdown, /More sessions/);
  assert.doesNotMatch(dropdown, /slot-session-nav-group-label/);
  const order = ["Alpha session", "Bravo session", "Charlie session"].map((title) => dropdown.indexOf(title));
  assert.ok(order.every((index) => index >= 0), "every session is listed");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "rows follow the session-list order");
});

test("the desktop picker keeps the In grid and More sessions groups", async () => {
  const SessionSlot = await loadSessionSlot();
  const html = renderComponent(SessionSlot, focusedPickerProps({
    openSlotMenuKey: "slot-0:nav",
    viewport: { mobile: false },
    sessionNavGridKeys: [sessionKey(alpha), sessionKey(bravo)],
  }));
  const dropdown = html.slice(html.indexOf("slot-session-nav-dropdown"));
  assert.match(dropdown, />In grid</);
  assert.match(dropdown, />More sessions</);
});

test("the picker menu items focus a chosen session and the wiring reaches enterSession", () => {
  // Item selection navigates (focuses) rather than reassigning the slot.
  assert.match(sessionSlotSource, /onSelect\(candidateKey\)/);
  assert.match(sessionSlotSource, /useDismissOnOutside\([^)]*"\.slot-session-nav-menu"/);
  assert.match(sessionSlotSource, /role="menu"[\s\S]*?onKeyDown=\{menuFocus\.onKeyDown\}/);
  // Dashboard builds the ordered nav list from the shortcut order and wires focus
  // to the same entry point the ⌘H/⌘L pager uses.
  assert.match(dashboardSource, /const sessionNavList = useMemo\(/);
  assert.match(dashboardSource, /const onFocusSession = useCallback\(\(key: string\) => \{\s*enterSession\(/);
  // ...and both are handed to the slot.
  assert.match(dashboardSource, /sessionNavList,/);
  assert.match(dashboardSource, /onFocusSession,/);
});

test("the picker reserves aligned columns for the position and a fixed-width repository badge", () => {
  // Position, one fixed-width single-line badge, then the flexible title: every
  // title starts in one column (exampleOrg/agent-console#870 C).
  assert.match(
    styles,
    /\.slot-menu-session\s+\.slot-menu-main\.is-ordered\s*\{[^}]*grid-template-columns:\s*1\.5rem var\(--slot-menu-badge-width\) minmax\(0, 1fr\);/s,
  );
  assert.match(
    styles,
    /\.slot-menu-session\s+\.repo-badge\s*\{[^}]*width:\s*var\(--slot-menu-badge-width\);[^}]*max-width:\s*none;/s,
  );
  assert.match(titleMenuSource, /<RepoBadge label=\{sessionRepoLabel\(session\)\}[^>]*singleLine \/>/);
});

test("each picker row carries the session's status-line harness segment", () => {
  // The pager and the title menu share one row; its harness segment reuses the
  // status line's agent mark and model badge, keyed on the row's own session.
  assert.match(sessionSlotSource, /<SessionMenuOption[\s\S]*?ordinal=\{\(sessionIndexByKey\.get\(candidateKey\)/);
  assert.match(titleMenuSource, /<span className="session-harness">\s*<AgentBadge agent=\{session\.agent\} decorative \/>\s*<SessionAccountChip session=\{session\} \/>\s*<SessionModelBadge session=\{session\} \/>/);
});

test("picker rows carry no host text", async () => {
  // The repo badge color identifies the host, so no row prints a machine name.
  const SessionSlot = await loadSessionSlot();
  const html = renderComponent(SessionSlot, focusedPickerProps({ openSlotMenuKey: "slot-0:nav" }));
  const navDropdown = html.slice(html.indexOf("slot-session-nav-dropdown"));
  assert.match(navDropdown, /Charlie session/);
  assert.doesNotMatch(navDropdown, /slot-menu-meta/);
  assert.doesNotMatch(navDropdown, />(?:sable|summit)</);
});
