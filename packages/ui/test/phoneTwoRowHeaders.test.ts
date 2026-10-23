import { createBadgeSsrHarness as createUiSsrHarness } from "./support/neutralBadges.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { Plugin } from "vite";
import type { MobileSessionListProps } from "../src/MobileSessionList.tsx";
import type { SessionListNavigatorProps } from "../src/SessionListNavigator.tsx";
import type { SessionSlotProps } from "../src/SessionSlot.tsx";
import { CLEAR_SESSION_FILTERS } from "../src/sessionFilters.ts";
import type { DashboardSession, Session } from "../src/types.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { sessionKey } from "../src/layout.ts";
import { makeCssRuleLookup, uiSource, uiStyles } from "./support/source.ts";
import { renderComponent } from "./support/ssr.ts";

// Issue #765 at the two widths the maintainer judges: a 384 CSS px phone
// (Dashboard reports viewport.mobile) and a 1200 px desktop.
const PHONE = { width: 384, mobile: true } as const;
const DESKTOP = { width: 1200, mobile: false } as const;
const WIDTHS = [PHONE, DESKTOP] as const;

const cssRuleFor = makeCssRuleLookup(`${uiStyles()}\n${uiSource("sessionCardRows.css")}`);
const ssr = createUiSsrHarness([mockTerminalPanePlugin()]);
after(async () => ssr.close());

function mockTerminalPanePlugin(): Plugin {
  const mockId = "\0terminal-pane-mock";
  return {
    name: "mock-terminal-pane",
    enforce: "pre",
    resolveId(source, importer) {
      return source.endsWith("TerminalPane.tsx") && importer?.includes("/src/") ? mockId : null;
    },
    load(id) {
      return id === mockId ? `import React from "react"; export function TerminalPane() { return React.createElement("div"); }` : null;
    },
  };
}

function parse(html: string, width: number): { readonly document: Document; close(): void } {
  const window = new Window({ url: "http://localhost" });
  window.happyDOM.setWindowSize({ width, height: 800 });
  window.document.body.innerHTML = html;
  return { document: window.document as unknown as Document, close: () => window.happyDOM.abort() };
}

function session(mode: "auto" | "pinned", overrides: Partial<Session> = {}): DashboardSession {
  return makeSession({
    agent: "codex",
    title: "Review the pager rules",
    repo_name: "agent-console",
    coordinator_tree: { depth: 0 },
    model: "example-model",
    reasoning_effort: "high",
    title_mode: mode,
    display_revision: 2,
    codex_account: {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      revision: 1,
      applied_runtime_id: "launch-hs-1",
    },
    ...overrides,
  }) as DashboardSession;
}

async function renderList(sessions: readonly DashboardSession[]): Promise<string> {
  const module = await ssr.loadModule<{ MobileSessionList: ComponentType<MobileSessionListProps> }>("/src/MobileSessionList.tsx");
  return renderComponent(module.MobileSessionList, {
    sessions,
    machineColors: {},
    reachableMachineNames: new Set(["summit"]),
    activityDeliveryByMachine: new Map(),
    clockActive: false,
    resumingKey: null,
    autoResumePendingKey: null,
    accountPendingKey: null,
    accountsByProvider: { codex: { summit: { accounts: [{ account: "account-a" }] } }, claude: {} },
    initialScrollTop: 0,
    onScrollTopChange: () => {},
    onOpen: () => {},
    onResume: () => {},
    onAutoResume: async () => true,
    onAccount: async () => {},
  });
}

async function renderSlot(item: Session, overrides: Partial<SessionSlotProps>): Promise<string> {
  const module = await ssr.loadModule<{ SessionSlot: ComponentType<SessionSlotProps> }>("/src/SessionSlot.tsx");
  return renderComponent(module.SessionSlot, makeSessionSlotProps({
    session: item,
    options: [item],
    accounts: [{ account: "account-a" }],
    ...overrides,
  } as never));
}

async function renderNavigator(mobile: boolean, pageCount: number): Promise<string> {
  const module = await ssr.loadModule<{ SessionListNavigator: ComponentType<SessionListNavigatorProps> }>("/src/SessionListNavigator.tsx");
  return renderComponent(module.SessionListNavigator, {
    records: [], countsAvailable: true, filters: CLEAR_SESSION_FILTERS, machines: [], roles: [], harnesses: [], resultCount: 0,
    mobile, page: 1, pageCount, onPageChange: () => {}, onChange: () => {},
  } as never);
}

function assertNoTitleModeLabel(root: ParentNode, label: string): void {
  assert.ok(!root.querySelector(".session-title-mode"), `${label}: no title-mode control`);
  assert.ok(!root.querySelector('[aria-label^="Title mode"]'), `${label}: no title-mode button`);
  const text = (root as Element).textContent ?? "";
  assert.doesNotMatch(text, /Pinned/, `${label}: no Pinned label`);
  assert.doesNotMatch(text, /\bAuto\b(?!-resume)/, `${label}: no Auto label`);
}

function within(row: Element | null, selector: string): boolean {
  return row?.querySelector(selector) != null;
}

test("#765.1 the pager hides on a phone with one page and always shows on desktop", async () => {
  for (const pageCount of [0, 1]) {
    const phone = await renderNavigator(PHONE.mobile, pageCount);
    assert.doesNotMatch(phone, /session-list-pagination/, `${PHONE.width}px with ${pageCount} pages hides the pager`);
    const desktop = await renderNavigator(DESKTOP.mobile, pageCount);
    assert.match(desktop, /class="session-list-pagination" role="group" aria-label="Page 1 of 1"/, `${DESKTOP.width}px with ${pageCount} pages shows 1 / 1`);
  }
  for (const { width, mobile } of WIDTHS) {
    assert.match(await renderNavigator(mobile, 3), /aria-label="Page 1 of 3"/, `${width}px with three pages shows the pager`);
  }
  // Single-row geometry is measured by headerCompaction.browser.test.ts.

});

test("#765.2 no Auto or Pinned title-mode label renders on cards, the list or either header", async () => {
  for (const mode of ["auto", "pinned"] as const) {
    const item = session(mode);
    for (const { width, mobile } of WIDTHS) {
      const card = parse(await renderSlot(item, { viewport: { mobile } }), width);
      assertNoTitleModeLabel(card.document.body, `${width}px ${mode} card`);
      card.close();
      const focused = parse(await renderSlot(item, {
        viewport: { mobile }, focused: true, focusedKey: "summit:hs-1", sessionOrdinal: 1, sessionCount: 2,
      }), width);
      assertNoTitleModeLabel(focused.document.body, `${width}px ${mode} focused header`);
      focused.close();
    }
    const list = parse(await renderList([item]), PHONE.width);
    assertNoTitleModeLabel(list.document.body, `${PHONE.width}px ${mode} overview list`);
    list.close();
  }
});

test("#765.3 phone list cards use the desktop identity and harness rows", async () => {
  const item = session("auto", { last_prompt: { text: "Check the pager on a phone" }, last_prompt_state: "current" });
  const { document, close } = parse(await renderList([item]), PHONE.width);
  try {
    const card = document.querySelector(".mobile-session-card");
    assert.ok(card);
    const rowOne = card.querySelector(".mobile-session-card-row-one");
    const rowTwo = card.querySelector(".mobile-session-card-row-two");
    assert.ok(rowOne && rowTwo, "the card renders two header rows");
    assert.ok(rowOne.compareDocumentPosition(rowTwo) & 4, "identity row precedes harness row");
    for (const selector of [".repo-badge", ".fixture-marker", ".mobile-session-card-title"]) {
      assert.ok(within(rowOne, selector), `row one holds ${selector}`);
      assert.ok(!within(rowTwo, selector), `row two omits ${selector}`);
    }
    for (const selector of [".agent-badge-icon", ".account-status", ".session-model-badge", ".session-activity-trigger"]) {
      assert.ok(within(rowTwo, selector), `row two holds ${selector}`);
      assert.ok(!within(rowOne, selector), `row one omits ${selector}`);
    }
    const order = [".agent-badge-icon", ".account-status", ".session-model-badge", ".session-activity-trigger"]
      .map(selector => rowTwo.querySelector(selector)!);
    for (let index = 1; index < order.length; index += 1) {
      assert.ok(order[index - 1]!.compareDocumentPosition(order[index]!) & 4, `row two keeps the desktop order at ${index}`);
    }
    assert.equal(card.querySelectorAll('button[aria-label^="Open "]').length, 1, "one accessible Open control per card");
    assert.match(card.textContent ?? "", /Check the pager on a phone/, "the last prompt still shows below the rows");
  } finally {
    close();
  }
});

test("#765.4 the phone focused header uses the same identity and harness rows", async () => {
  const item = session("pinned", { provider_resume: { provider: "codex", session_id: "codex-provider-id" } });
  const { document, close } = parse(await renderSlot(item, {
    viewport: { mobile: true }, focused: true, focusedKey: "summit:hs-1", sessionOrdinal: 2, sessionCount: 3,
  }), PHONE.width);
  try {
    const rowOne = document.querySelector(".slot-focus-row-one");
    const rowTwo = document.querySelector(".slot-focus-row-two");
    assert.ok(rowOne && rowTwo, "the focused phone header renders two rows");
    assert.ok(rowOne.compareDocumentPosition(rowTwo) & 4, "identity row precedes harness row");
    for (const selector of [".slot-back", ".repo-badge", ".fixture-marker", ".slot-title", ".slot-action.danger"]) {
      assert.ok(within(rowOne, selector), `row one holds ${selector}`);
      assert.ok(!within(rowTwo, selector), `row two omits ${selector}`);
    }
    for (const selector of [".agent-retitle-button", ".account-status", ".session-model-badge", ".session-activity-trigger", ".slot-session-nav"]) {
      assert.ok(within(rowTwo, selector), `row two holds ${selector}`);
      assert.ok(!within(rowOne, selector), `row one omits ${selector}`);
    }
  } finally {
    close();
  }

  // Desktop keeps its single focused header row.
  const desktop = parse(await renderSlot(item, {
    viewport: { mobile: false }, focused: true, focusedKey: "summit:hs-1", sessionOrdinal: 2, sessionCount: 3,
  }), DESKTOP.width);
  assert.ok(!desktop.document.querySelector(".slot-focus-row-one"));
  assert.ok(!desktop.document.querySelector(".slot-focus-row-two"));
  desktop.close();
});

test("#805 the phone preview is the accessible Open action described by its prompt", async () => {
  const module = await ssr.loadModule<{ MobileSessionList: ComponentType<MobileSessionListProps> }>("/src/MobileSessionList.tsx");
  const window = new Window({ url: "http://localhost", width: PHONE.width, height: 800 });
  const globals = { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent, Event: window.Event, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  const opened: string[] = [];
  const item = session("auto", { last_prompt: { text: "Check the pager on a phone" }, last_prompt_state: "current" });
  try {
    await act(async () => root.render(createElement(module.MobileSessionList, {
      sessions: [item], machineColors: {}, reachableMachineNames: new Set(["summit"]), activityDeliveryByMachine: new Map(),
      clockActive: false, resumingKey: null, autoResumePendingKey: null, accountPendingKey: null,
      accountsByProvider: { codex: {}, claude: {} }, initialScrollTop: 0, onScrollTopChange: () => {},
      onOpen: (key: string) => { opened.push(key); }, onResume: () => {}, onAutoResume: async () => true, onAccount: async () => {},
    })));
    const prompt = container.querySelector(".mobile-session-card-prompt-open") as unknown as HTMLElement | null;
    assert.ok(prompt, "the prompt area renders");
    assert.ok(!prompt.closest("[aria-hidden]"), "the prompt text stays exposed to assistive technology");
    assert.ok(prompt.matches("button"), "the preview is a native keyboard control");
    const open = container.querySelector('button[aria-label^="Open "]') as unknown as HTMLElement;
    assert.ok(open === prompt, "one Open action owns the preview");
    const describedBy = open.getAttribute("aria-describedby");
    assert.ok(describedBy, "the Open control is described by the prompt");
    assert.equal(window.document.getElementById(describedBy)?.textContent, "Check the pager on a phone");
    await act(async () => prompt.click());
    assert.deepEqual(opened, [sessionKey(item)], "a tap on the prompt opens the session");
    assert.equal(prompt.tabIndex, 0, "the native Open action participates in keyboard navigation");
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
