import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import type { SessionSlotProps } from "../src/SessionSlot.tsx";
import type { Session } from "../src/types.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { uiSource } from "./support/source.ts";

type SessionSlotComponent = ComponentType<SessionSlotProps>;

const ssr = createUiSsrHarness([mockTerminalPanePlugin()]);

after(async () => {
  await ssr.close();
});

function mockTerminalPanePlugin(): Plugin {
  const mockId = "\0terminal-pane-mock";
  return {
    name: "mock-terminal-pane",
    enforce: "pre",
    resolveId(source, importer) {
      return source.endsWith("TerminalPane.tsx") && importer?.includes("/src/") ? mockId : null;
    },
    load(id) {
      if (id !== mockId) return null;
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
  return module.SessionSlot;
}

test("desktop Conversation tiles mount the shared reply composer without a terminal", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession();
  const props = makeSessionSlotProps({ session, options: [session] });
  const html = renderComponent(SessionSlot, {
    ...props, view: { ...props.view, sessionListDisplay: "conversation" as const },
  });
  assert.doesNotMatch(html, /terminal-pane-mock/, "Conversation mode must not mount TerminalPane");
  assert.match(html, /slot-conversation-pane/);
  assert.match(html, /conversation-composer/);
  assert.match(html, /has not reported a provider session ID yet/);
});

test("keyboard-selected tiles keep the same blue focus outline in Terminal and Conversation modes", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession();
  const props = makeSessionSlotProps({ session, options: [session] });
  const htmlByMode = ["terminal", "conversation"].map(sessionListDisplay => renderComponent(SessionSlot, {
    ...props,
    view: { ...props.view, gridFocusTarget: true, sessionListDisplay: sessionListDisplay as "terminal" | "conversation" },
  }));

  assert.deepEqual(htmlByMode.map(html => /class="terminal-slot [^"]*is-grid-focus/.test(html)), [true, true]);
  const styles = uiSource("styles.css");
  assert.match(styles, /\.terminal-slot\.is-cmd-focus-target::after,\s*\.session-workspace\.desktop \.terminal-slot\.is-grid-focus::after\s*\{[^}]*border:\s*1px solid var\(--accent\)/);
});

test("Terminal default and phone or focused sessions keep their terminal view", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession();
  for (const overrides of [
    {},
    { viewport: { mobile: true } },
    { focused: true, focusedKey: "summit/hs-1" },
  ]) {
    const props = makeSessionSlotProps({ session, options: [session], ...overrides });
    const html = renderComponent(SessionSlot, overrides.focused || overrides.viewport
      ? { ...props, view: { ...props.view, sessionListDisplay: "conversation" as const } }
      : props);
    assert.match(html, /terminal-pane-mock/);
    assert.doesNotMatch(html, /slot-conversation-pane/);
  }
});

test("the session title menu offers Conversation only where history is available", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession();
  const withHistory = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    openSlotMenuKey: "slot-0",
    onConversation: () => {},
  }));
  const withoutHistory = renderComponent(SessionSlot, makeSessionSlotProps({
    session,
    options: [session],
    openSlotMenuKey: "slot-0",
  }));

  assert.match(withHistory, /<span class="slot-menu-label">Conversation<\/span>/);
  assert.doesNotMatch(withoutHistory, />Conversation</);
});

test("the session title menu has no Empty slot item on desktop or mobile", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession();
  for (const mobile of [false, true]) {
    const html = renderComponent(SessionSlot, makeSessionSlotProps({
      session,
      options: [session],
      openSlotMenuKey: "slot-0",
      focused: mobile,
      viewport: { mobile },
      slotAssignmentEnabled: true,
    }));
    // Slot reconciliation refills an emptied pane from the synced session order
    // on the next list update, so the item could never keep a pane empty.
    assert.match(html, /Rename title/);
    assert.doesNotMatch(html, /Empty slot/);
  }
});

test("choosing Conversation closes the menu and opens that session's conversation", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession();
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const opened: Session[] = [];
  const menuKeys: Array<string | null> = [];
  try {
    await act(async () => {
      root.render(createElement(SessionSlot, makeSessionSlotProps({
        session,
        options: [session],
        openSlotMenuKey: "slot-0",
        setOpenSlotMenuKey: (value) => {
          menuKeys.push(typeof value === "function" ? value("slot-0") : value);
        },
        onConversation: (target) => opened.push(target),
      })));
    });
    const item = [...container.querySelectorAll<HTMLButtonElement>(".slot-menu-item")]
      .find((candidate) => candidate.textContent?.trim() === "Conversation");
    assert.ok(item);
    await act(async () => {
      item.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(opened, [session]);
    assert.ok(menuKeys.includes(null), "the menu closes before the panel opens");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    window.close();
  }
});

test("#921 a stopped Conversation tile offers Recover through the slot's resume", async () => {
  const SessionSlot = await loadSessionSlot();
  const session = makeSession({ status: "stopped", resumable: true });
  const render = (resumingKey: string | null) => {
    const props = makeSessionSlotProps({ session, options: [session], resumingKey });
    return renderComponent(SessionSlot, { ...props, view: { ...props.view, sessionListDisplay: "conversation" as const } });
  };
  const idle = render(null);
  assert.match(idle, /This session stopped\./);
  assert.match(idle, /<button[^>]*aria-busy="false"[^>]*>Recover<\/button>/);
  assert.match(render("summit/hs-1"), /<button[^>]*aria-busy="true"[^>]*disabled=""[^>]*>Recover<\/button>/, "the slot's pending resume");
});

test("#921 the phone pane and the Dashboard conversation panel get the same Recover", () => {
  const slot = uiSource("SessionSlot.tsx");
  assert.match(slot, /const conversationRecovery = s \? \{ onRecover: \(\) => void onResume\(s\), pending: resumingKey === sessionKey\(s\) \|\| repairingSessions \}/);
  assert.match(slot, /<PhoneConversationPane[^>]*recovery=\{conversationRecovery\}/);
  const dashboard = uiSource("Dashboard.tsx");
  assert.match(dashboard, /<LiveConversationPanel[\s\S]*?recovery=\{\{ onRecover: \(\) => void onResume\(conversationSession\),\s*pending: resumingKey === sessionKey\(conversationSession\) \|\| repairingSessions \}\}/);
});

test("#921 the phone pane and the mobile conversation panel pass their terminal switch to Possibly stuck", () => {
  const slot = uiSource("SessionSlot.tsx");
  assert.match(slot, /<PhoneConversationPane[^>]*onTerminal=\{onTerminal \? \(\) => onTerminal\(s\) : undefined\}/);
  assert.match(uiSource("PhoneConversationPane.tsx"), /<ConversationComposer[^>]*onTerminal=\{onTerminal\}/);
  assert.match(uiSource("LiveConversationPanel.tsx"), /<ConversationComposer[^>]*onTerminal=\{onTerminal\}/);
});
