import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";
import { assertNoElement } from "./support/domAssert.ts";
import { makeSession } from "./support/fixtures.ts";

// exampleOrg/agent-console#892: phone Conversation is a mode of the focused
// session screen, so it shares the session header, dropdown and swipe order.
const sessions = [
  makeSession({ id: "one", machine: "fixture", title: "First work", provider_resume: { provider: "codex", session_id: "thread-one" } }),
  makeSession({ id: "two", machine: "fixture", title: "Second work", provider_resume: { provider: "codex", session_id: "thread-two" } }),
];

const boundary: Plugin = {
  name: "phone-conversation-mode-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id.endsWith("TerminalPane.tsx")) return "\0phone-mode-terminal";
  },
  load(id) {
    if (id === "\0phone-mode-terminal") return `import React from "react"; export function TerminalPane(props){return React.createElement("div",{className:"terminal-pane","data-session":props.id});}`;
  },
  transform(code, id) {
    if (!id.endsWith("/src/api.ts")) return;
    for (const name of ["listSessions", "listHistorySessions", "listHistoryMessages", "usage", "fetchLayoutOrder", "listAccounts"])
      code = code.replace(`export async function ${name}(`, `export async function original${name}(`);
    return code + `
      export const listSessions = async () => {
        // #942: a failed poll, as when the app sits in the system file picker.
        if (globalThis.__phoneModePollFails) throw new TypeError("Failed to fetch");
        return {ok:true,sessions:${JSON.stringify(sessions)},machines:[{name:"fixture",ok:true,capabilities:{history:true}}]};
      };
      export const listHistorySessions = async () => ({ok:true,truncated:false,latestMessagePaging:true,sessions:[
        {id:"history-one",machine:"fixture",provider:"codex",provider_session_id:"thread-one",title:"First work",cwd:"/workspace",created_at:"2026-10-15T00:00:00Z",updated_at:"2026-10-15T00:00:00Z",resumable:true},
        {id:"history-two",machine:"fixture",provider:"codex",provider_session_id:"thread-two",title:"Second work",cwd:"/workspace",created_at:"2026-10-15T00:00:00Z",updated_at:"2026-10-15T00:00:00Z",resumable:true}]});
      export const listHistoryMessages = async (machine, historyId) => ({ok:true,messages:[{id:"m-"+historyId,role:"assistant",text:"Answer from "+historyId}]});
      export const usage = async () => ({providers:[],reachable:false});
      export const fetchLayoutOrder = async () => ({order:[],revision:null,reachable:false,conflict:false});
      export const listAccounts = async () => ({accounts:[]});
    `;
  },
};

async function harness(width = 384) {
  const window = new Window({ url: "http://localhost" });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const names = ["window", "document", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "MouseEvent", "KeyboardEvent", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLSelectElement: window.HTMLSelectElement, Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container); const ssr = createUiSsrHarness([boundary]);
  return { window, container, root, ssr, async close() { await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, previous); await window.happyDOM.close(); } };
}

async function waitFor(condition: () => boolean, message = "phone fixture did not settle") {
  for (let i = 0; i < 200; i++) { if (condition()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
  assert.fail(message);
}

async function openDashboard(h: Awaited<ReturnType<typeof harness>>, phoneSessionOpen: "conversation" | "terminal" = "conversation") {
  const { Dashboard } = await h.ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => h.root.render(createElement(Dashboard, { phoneSessionOpen, active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {}, defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true, onDebug() {}, onUsage() {}, onSettings() {} })));
  await waitFor(() => h.container.querySelector('[aria-label="Open First work"]') !== null);
  await act(async () => h.container.querySelector<HTMLButtonElement>('[aria-label="Open First work"]')!.click());
}

const focused = (h: Awaited<ReturnType<typeof harness>>) => h.container.querySelector<HTMLElement>(".terminal-slot.is-focused");
const conversationShows = (h: Awaited<ReturnType<typeof harness>>, historyId: string) =>
  Boolean(focused(h)?.querySelector(".phone-conversation-pane")?.textContent?.includes(`Answer from ${historyId}`));
const headerActions = (h: Awaited<ReturnType<typeof harness>>) =>
  [...focused(h)!.querySelectorAll<HTMLElement>(".slot-focus-actions > *")].map(node => node.className.replace(/\s+/g, " ").trim());

async function openTitleMenu(h: Awaited<ReturnType<typeof harness>>, title: string) {
  const trigger = focused(h)!.querySelector<HTMLElement>(`[aria-label="Session menu for ${title}"]`);
  assert.ok(trigger, `the focused header has the ${title} title dropdown`);
  await act(async () => trigger.click());
}

function menuItem(h: Awaited<ReturnType<typeof harness>>, label: string) {
  return [...focused(h)!.querySelectorAll<HTMLElement>(".slot-title-dropdown [role=menuitem]")]
    .find(item => item.textContent?.includes(label));
}

async function swipe(h: Awaited<ReturnType<typeof harness>>, target: Element, dx: number, dy: number) {
  const touchEvent = (type: string, x: number, y: number, ending = false) => {
    const event = new h.window.Event(type, { bubbles: true, cancelable: true });
    const touch = { clientX: x, clientY: y, identifier: 0, target };
    Object.defineProperty(event, "touches", { value: ending ? [] : [touch] });
    Object.defineProperty(event, "changedTouches", { value: [touch] });
    return event;
  };
  await act(async () => {
    target.dispatchEvent(touchEvent("touchstart", 200, 300));
    target.dispatchEvent(touchEvent("touchmove", 200 + dx / 2, 300 + dy / 2));
    target.dispatchEvent(touchEvent("touchend", 200 + dx, 300 + dy, true));
  });
}

test("phone Conversation opens in the focused session screen with the session header", async () => {
  const c = await harness();
  try {
    await openDashboard(c);
    await waitFor(() => conversationShows(c, "history-one"), "the conversation renders inside the focused session");
    assertNoElement(c.container, ".conversation-modal");
    assertNoElement(c.container, ".terminal-pane");
    assert.ok(focused(c)!.querySelector('[aria-label="Back to session list"]'), "same Back control as session mode");
    assert.ok(focused(c)!.querySelector('[aria-label="Session menu for First work"]'), "same title dropdown as session mode");
    assert.equal(headerActions(c).length, 3, "the same three header buttons");
    assert.ok(focused(c)!.querySelector('.slot-focus-actions [aria-label^="Copy"]'));
    assert.ok(focused(c)!.querySelector('.slot-focus-actions [aria-label="Kill First work"]'));
    assert.ok(focused(c)!.querySelector('.slot-focus-actions [aria-label="Refresh conversation"]'));
    assert.ok(focused(c)!.querySelector(".phone-conversation-pane .conversation-composer:not([hidden])"), "composer is visible");
  } finally { await c.close(); }
});

test("phone Conversation header buttons match session mode", async () => {
  const h = await harness();
  try {
    await openDashboard(h, "terminal");
    await waitFor(() => focused(h)?.querySelector(".terminal-pane") !== null);
    const terminalActions = headerActions(h);
    await openTitleMenu(h, "First work");
    const toConversation = menuItem(h, "Conversation");
    assert.ok(toConversation, "session mode's dropdown switches to Conversation");
    await act(async () => toConversation.click());
    await waitFor(() => conversationShows(h, "history-one"));
    assert.deepEqual(headerActions(h), terminalActions);
    await openTitleMenu(h, "First work");
    assert.equal(menuItem(h, "Conversation"), undefined);
    const toTerminal = menuItem(h, "Terminal");
    assert.ok(toTerminal, "Conversation's dropdown switches back to session mode");
    await act(async () => toTerminal.click());
    await waitFor(() => focused(h)?.querySelector(".terminal-pane") !== null);
    assertNoElement(focused(h)!, ".phone-conversation-pane");
  } finally { await h.close(); }
});

test("the dropdown lists other sessions and keeps the current mode", async () => {
  const h = await harness();
  try {
    await openDashboard(h);
    await waitFor(() => conversationShows(h, "history-one"));
    await openTitleMenu(h, "First work");
    const other = menuItem(h, "Second work");
    assert.ok(other, "Conversation's dropdown lists other sessions");
    await act(async () => other.click());
    await waitFor(() => conversationShows(h, "history-two"), "the other session opens in Conversation");
    assertNoElement(h.container, ".terminal-pane");

    await openTitleMenu(h, "Second work");
    await act(async () => menuItem(h, "Terminal")!.click());
    await waitFor(() => focused(h)?.querySelector('.terminal-pane[data-session="two"]') !== null);
    await openTitleMenu(h, "Second work");
    const first = menuItem(h, "First work");
    assert.ok(first, "session mode's dropdown lists other sessions");
    await act(async () => first.click());
    await waitFor(() => focused(h)?.querySelector('.terminal-pane[data-session="one"]') !== null, "session mode stays session mode");
    assertNoElement(h.container, ".phone-conversation-pane");
  } finally { await h.close(); }
});

test("a horizontal swipe changes session and stays in Conversation; a vertical drag does not", async () => {
  const h = await harness();
  try {
    await openDashboard(h);
    await waitFor(() => conversationShows(h, "history-one"));
    const history = () => focused(h)!.querySelector(".phone-conversation-pane .history-messages")!;
    await swipe(h, history(), 10, -160);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.ok(conversationShows(h, "history-one"), "vertical scrolling never swipes");
    await swipe(h, history(), -160, 8);
    await waitFor(() => conversationShows(h, "history-two"), "a left swipe opens the next session's Conversation");
    assertNoElement(h.container, ".terminal-pane");
    await swipe(h, history(), 160, 8);
    await waitFor(() => conversationShows(h, "history-one"), "a right swipe returns in Conversation");
  } finally { await h.close(); }
});

test("a swipe that ends with selected text does not change session", async () => {
  const h = await harness();
  try {
    await openDashboard(h);
    await waitFor(() => conversationShows(h, "history-one"));
    const history = focused(h)!.querySelector(".phone-conversation-pane .history-messages")!;
    const text = history.querySelector(".history-bubble")!.firstChild ?? history.querySelector(".history-bubble")!;
    const range = h.window.document.createRange();
    range.selectNodeContents(text as never);
    h.window.getSelection()!.removeAllRanges();
    h.window.getSelection()!.addRange(range);
    await swipe(h, history, -160, 8);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.ok(conversationShows(h, "history-one"), "text selection never swipes");
  } finally { await h.close(); }
});

// #942: a slow pick in the system file picker pauses the app long enough for a
// session poll to fail. The Conversation pane must stay mounted through the
// failed and restored polls, or the picker hands its file to a detached input.
test("#942 a failed and restored poll keeps the phone Conversation pane and its file input", async () => {
  const c = await harness();
  const pollFails = (value: boolean) => { (globalThis as { __phoneModePollFails?: boolean }).__phoneModePollFails = value; };
  try {
    await openDashboard(c);
    await waitFor(() => conversationShows(c, "history-one"));
    const pane = focused(c)!.querySelector(".phone-conversation-pane")!;
    const input = pane.querySelector<HTMLInputElement>(".conversation-file-input");
    assert.ok(input, "the paperclip's file input is in the pane");
    const poll = async () => {
      Object.defineProperty(c.window.document, "visibilityState", { configurable: true, value: "visible" });
      await act(async () => { c.window.document.dispatchEvent(new c.window.Event("visibilitychange")); await new Promise(resolve => setTimeout(resolve, 100)); });
    };
    pollFails(true);
    await poll();
    await waitFor(() => c.container.textContent?.includes("Console server is unreachable") === true, "the failed poll is reported");
    assert.equal(pane.isConnected, true, "the Conversation stays on screen while the poll fails");
    pollFails(false);
    await poll();
    await waitFor(() => c.container.textContent?.includes("Console server connection restored") === true, "the restored poll is reported");
    assert.equal(input.isConnected, true, "the picker's input is still the one in the document");
    assert.equal(focused(c)!.querySelector(".phone-conversation-pane .conversation-file-input") === input, true, "no new pane replaced it");
  } finally { pollFails(false); await c.close(); }
});
