import { createBadgeSsrHarness as createUiSsrHarness } from "./support/neutralBadges.ts";
import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { Plugin } from "vite";
import { sessionKey } from "../src/layout.ts";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";


const ssr = createUiSsrHarness([{
  name: "card-terminal-fixture", enforce: "pre",
  resolveId(source, importer) { return source.endsWith("TerminalPane.tsx") && importer?.includes("/src/") ? "\0card-terminal-fixture" : null; },
  load(id) { return id === "\0card-terminal-fixture" ? 'import React from "react"; export function TerminalPane(){return React.createElement("div",{className:"terminal-pane-mock"});}' : null; },
} satisfies Plugin]);
after(() => ssr.close());
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });
const session = makeSession({ title: "Card interaction", model: "gpt-example", reasoning_effort: "high", role: "tester",
  last_prompt: { text: "Preview text", truncated: false },
  codex_account: { schema_version: "agent-session.codex-account.v1", supported: true, state: "bound", selected_account: "alpha", revision: 1, applied_runtime_id: "launch-hs-1" },
});
const accounts = [{ account: "alpha" }, { account: "beta" }];
const key = sessionKey(session);
async function mount(width: number, focused = false, stopped = false, noPrompt = false) {
  const Mobile = (await ssr.loadModule<typeof import("../src/MobileSessionList.tsx")>("/src/MobileSessionList.tsx")).MobileSessionList;
  const Slot = (await ssr.loadModule<typeof import("../src/SessionSlot.tsx")>("/src/SessionSlot.tsx")).SessionSlot;
  const window = new Window({ url: "http://localhost" });
  window.happyDOM.setWindowSize({ width, height: 800 });
  const globals = { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map(name => [name, Reflect.get(globalThis, name)]));
  Object.assign(globalThis, globals);
  const events: string[] = [], previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => { assert.match(String(input), /\/repo-url\?cwd=/); return new Response(JSON.stringify({ data: { url: "https://github.com/example/card-fixture" } }), { status: 200 }); };
  window.open = (() => ({ opener: null, location: { replace: (url: string) => events.push(`repo:${url}`) }, close() {} })) as never;
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => { await act(async () => root.unmount()); await window.happyDOM.abort(); Object.assign(globalThis, previous); globalThis.fetch = previousFetch; };
  const base = noPrompt ? { ...session, last_prompt: undefined } : session;
  const item = stopped ? { ...base, status: "stopped" as const, resumable: true, auto_resume_control_available: true, auto_resume: { schema_version: "agent-session.auto-resume.v1", supported: true, enabled: false, state: "disabled" } } : base;
  const open = () => events.push(`open:${key}`);
  function Harness() {
    const [menu, setMenu] = useState<string | null>(null), [editing, setEditing] = useState<string | null>(null);
    const callbacks = {
      onRetitle: () => events.push("retitle"), onLineageMarker: () => events.push("role"),
      onAccount: async (_session: unknown, account: string) => { events.push(`account:${account}`); },
      onAutoResume: async (_session: unknown, enabled: boolean) => { events.push(`auto:${enabled}`); return true; },
      onResume: async () => { events.push("recover"); },
      beginTitleEdit: () => { events.push("rename"); setEditing(key); },
      saveTitleEdit: async (_session: unknown, title: string | null) => { events.push(`save:${title}`); setEditing(null); },
      cancelTitleEdit: () => setEditing(null), onConversation: () => events.push("conversation"),
    };
    if (width < 600 && !focused) return createElement(Mobile, {
      sessions: [item], options: [item], machineColors: {}, reachableMachineNames: new Set(["summit"]),
      activityDeliveryByMachine: new Map(), clockActive: false, resumingKey: null, autoResumePendingKey: null,
      accountPendingKey: null, accountsByProvider: { codex: { summit: { accounts } }, claude: {} },
      initialScrollTop: 0, onScrollTopChange() {}, onOpen: open, editingTitleKey: editing, onNewSession: () => events.push("new"), ...callbacks,
    });
    const props = makeSessionSlotProps({ slot: key, session: item, options: [item], sessionNavList: [item], accounts, focused, viewport: { mobile: width < 600 },
      focusedKey: focused ? key : null, openSlotMenuKey: menu, editingTitleKey: editing,
      setOpenSlotMenuKey: setMenu, setFocusedKey: open,
      onSlotSelect: (_index, _current, next) => events.push(next === "__new__" ? "new" : `select:${next}`), ...callbacks });
    props.actions.onLineageMarker = callbacks.onLineageMarker;
    props.terminal.onReconnect = () => events.push("refresh");
    return createElement(Slot, props);
  }
  await act(async () => root.render(createElement(Harness)));
  const click = async (selector: string) => {
    const element = container.querySelector(selector); assert.ok(element, `${width}px renders ${selector}`);
    await act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
  };
  return { container, events, click, window };
}
for (const width of [360, 384, 412, 1280]) {
  const mobile = width < 600, row = mobile ? ".mobile-session-card-row-two" : ".slot-session-card-row-two";
  for (const [region, selector] of [
    ["row 2 outside buttons", row], ["model and effort text", ".session-model-badge"],
    ["empty card header area", mobile ? ".mobile-session-card-head" : ".slot-head"],
    ["empty card area", mobile ? ".mobile-session-card" : ".terminal-slot"],
    ["row 1 outside buttons", mobile ? ".mobile-session-card-row-one" : ".slot-session-card-row-one"],
  ]) test(`${width}px: tapping ${region} does not open the session`, async () => {
    const dom = await mount(width); await dom.click(selector!); assert.deepEqual(dom.events, []);
  });
  if (mobile) {
    for (const selector of [".mobile-session-card-prompt", ".mobile-session-card-prompt-open", ".mobile-session-card-open-action"]) {
      test(`${width}px: preview region ${selector} opens exactly once`, async () => {
        const dom = await mount(width); await dom.click(selector); assert.deepEqual(dom.events, [`open:${key}`]);
      });
    }
    test(`${width}px: empty preview remains an obvious Open action`, async () => {
      const dom = await mount(width, false, false, true);
      const action = dom.container.querySelector('button[aria-label="Open Card interaction"]');
      assert.ok(action?.classList.contains("mobile-session-card-prompt-open"));
      assert.match(action.textContent ?? "", /No prompt yet/);
      await dom.click(".mobile-session-card-prompt-open"); assert.deepEqual(dom.events, [`open:${key}`]);
    });
  }
  if (!mobile) test(`${width}px: desktop overview keeps the terminal preview without a prompt strip`, async () => {
    const dom = await mount(width);
    assert.ok(!dom.container.querySelector(".slot-session-card-prompt"), "desktop header has no last-prompt strip");
    assert.ok(dom.container.querySelector(".terminal-pane-mock"), "desktop keeps its terminal preview");
    assert.doesNotMatch(dom.container.textContent ?? "", /Preview text/);
  });
  test(`${width}px: repository badge opens the repository without opening the session`, async () => {
    const dom = await mount(width); await dom.click(".repo-badge"); assert.deepEqual(dom.events, ["repo:https://github.com/example/card-fixture"]);
  });
  test(`${width}px: harness icon retitles without opening the session`, async () => {
    const dom = await mount(width); await dom.click(".agent-badge"); assert.deepEqual(dom.events, ["retitle"]);
  });
  test(`${width}px: role badge follows the coordinator action`, async () => {
    const dom = await mount(width); await dom.click(".fixture-marker"); assert.deepEqual(dom.events, ["role"]);
  });
  test(`${width}px: title opens its dropdown and supports rename, conversation and session selection`, async () => {
    const dom = await mount(width), title = mobile ? ".mobile-session-card-title" : ".slot-title-label";
    await dom.click(title); assert.ok(dom.container.querySelector(".slot-title-menu[open]")); assert.deepEqual(dom.events, []);
    const activate = async (text: string) => {
      const item = [...dom.container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === text);
      assert.ok(item, text); await act(async () => item.click());
    };
    await activate("Conversation"); assert.deepEqual(dom.events, ["conversation"]);
    await dom.click(title); await activate("Rename title"); assert.deepEqual(dom.events, ["conversation", "rename"]);
    assert.ok(dom.container.querySelector(".slot-title-input"), "rename mounts the shared title editor");
    await act(async () => dom.container.querySelector<HTMLInputElement>(".slot-title-input")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    // Choosing a listed session navigates: a phone card opens it, a desktop card hands it to the overview navigator.
    await dom.click(title); await dom.click('[role="menuitem"][aria-current="true"]'); assert.equal(dom.events.at(-1), mobile ? `open:${key}` : `select:${key}`);
    await dom.click(title); await activate("+ New session..."); assert.equal(dom.events.at(-1), "new");
  });
  test(`${width}px: account badge pins usage and switches accounts without opening the session`, async () => {
    const dom = await mount(width); await dom.click(".account-status"); assert.ok(dom.container.querySelector(".account-usage-popover.is-pinned")); assert.deepEqual(dom.events, []);
    await dom.click('.account-usage-popover button[aria-label*="beta"]'); assert.deepEqual(dom.events, ["account:beta"]);
  });
  test(`${width}px: status pill pins details; details do not open the session`, async () => {
    const dom = await mount(width); await dom.click(".session-activity-trigger"); assert.ok(dom.container.querySelector(".session-activity-popover.is-pinned"));
    await dom.click(".session-activity-popover"); assert.deepEqual(dom.events, []);
  });
  test(`${width}px: auto-resume and recovery controls do not open the session`, async () => {
    const dom = await mount(width, false, true); await dom.click(".auto-resume-status-button"); assert.deepEqual(dom.events, ["auto:true"]);
    await dom.click(mobile ? ".mobile-session-card-resume" : ".slot-resume"); assert.deepEqual(dom.events, ["auto:true", "recover"]);
  });
  if (!mobile) test(`${width}px: explicit desktop Open control opens exactly once`, async () => {
    const dom = await mount(width); await dom.click(".slot-open"); assert.deepEqual(dom.events, [`open:${key}`]);
  });
  if (!mobile) test(`${width}px: live terminal input keeps its existing interaction`, async () => {
    const dom = await mount(width); await dom.click(".terminal-pane-mock"); assert.deepEqual(dom.events, []);
  });
  test(`${width}px: focused refresh reconnects only the current pane`, async () => {
    const dom = await mount(width, true); await dom.click(".slot-refresh"); assert.deepEqual(dom.events, ["refresh"]);
  });
}
