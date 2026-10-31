import { sharedAdmissionFixture } from "./support/sharedAdmissionFixture.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";
import { makeSession } from "./support/fixtures.ts";

// #198 review F1: a reply in flight keeps its conversation mounted across a width-tier
// change, and a wide card selection waits for it.
declare global {
  var __touchBusySubmit: ((...args: unknown[]) => Promise<unknown>) | undefined;
  var __touchBusyMac: boolean | undefined;
}

// Claude retains the direct-send ACK interval these navigation locks protect.
// Codex clears after durable local admission, before its asynchronous HTTP ACK.
const turnState = { schema_version: "agent-session.turn-state.v1", phase: "idle", phase_changed_at: "2026-10-11T00:00:00Z", revision: 1, source: { kind: "provider_hook", provider: "claude", confidence: "authoritative" } };
const sessions = [
  makeSession({ id: "one", machine: "fixture", agent: "claude", title: "First work", turn_state: turnState, provider_resume: { provider: "claude", session_id: "thread-one" } } as never),
  makeSession({ id: "two", machine: "fixture", agent: "claude", title: "Second work", turn_state: turnState, provider_resume: { provider: "claude", session_id: "thread-two" } } as never),
];

const boundary: Plugin = {
  name: "touch-primary-busy-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (id.endsWith("sharedOutboxClient.ts")) return "\0shared-admission-fixture";
    if (!importer?.includes("/src/")) return;
    if (id.endsWith("TerminalPane.tsx")) return "\0touch-busy-terminal";
  },
  load(id) {
    if (id === "\0shared-admission-fixture") return sharedAdmissionFixture("globalThis.__touchBusySubmit");
    if (id === "\0touch-busy-terminal") return `import React from "react"; export function TerminalPane(props){return React.createElement("div",{className:"terminal-pane","data-session":props.id});}`;
  },
  transform(code, id) {
    if (id.endsWith("/src/runtime.ts")) {
      return code.replace("export function isMacTauri(): boolean {", "export function isMacTauri(): boolean {\n  if (globalThis.__touchBusyMac) return true;");
    }
    if (!id.endsWith("/src/api.ts")) return;
    for (const name of ["listSessions", "listHistorySessions", "listHistoryMessages", "usage", "fetchLayoutOrder", "listAccounts", "submitSessionPrompt"])
      code = code.replace(`export async function ${name}(`, `export async function original${name}(`);
    return code + `
      export const listSessions = async () => ({ok:true,sessions:${JSON.stringify(sessions)},machines:[{name:"fixture",ok:true,capabilities:{history:true}}]});
      export const listHistorySessions = async () => ({ok:true,truncated:false,latestMessagePaging:true,sessions:[
        {id:"history-one",machine:"fixture",provider:"claude",provider_session_id:"thread-one",title:"First work",cwd:"/workspace",created_at:"2026-10-15T00:00:00Z",updated_at:"2026-10-15T00:00:00Z",resumable:true},
        {id:"history-two",machine:"fixture",provider:"claude",provider_session_id:"thread-two",title:"Second work",cwd:"/workspace",created_at:"2026-10-15T00:00:00Z",updated_at:"2026-10-15T00:00:00Z",resumable:true}]});
      export const listHistoryMessages = async (machine, historyId) => ({ok:true,messages:[{id:"m-"+historyId,role:"assistant",text:"Answer from "+historyId}]});
      export const usage = async () => ({providers:[],reachable:false});
      export const fetchLayoutOrder = async () => ({order:[],revision:null,reachable:false,conflict:false});
      export const listAccounts = async () => ({accounts:[]});
      export const submitSessionPrompt = (...args) => globalThis.__touchBusySubmit(...args);
    `;
  },
};


async function harness(width: number) {
  const window = new Window({ url: "http://localhost" });
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {},
  });
  const names = ["window", "document", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "MouseEvent", "KeyboardEvent", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLSelectElement: window.HTMLSelectElement, Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container); const ssr = createUiSsrHarness([boundary]);
  return {
    window, container, root, ssr,
    async resize(next: number) {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: next });
      await act(async () => { window.dispatchEvent(new window.Event("resize")); });
    },
    async close() { await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, previous); await window.happyDOM.close(); },
  };
}
type H = Awaited<ReturnType<typeof harness>>;

async function waitFor(condition: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
  assert.fail(message);
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

const editor = (h: H) => h.window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to session"]');
const wideShows = (h: H, id: string) => h.window.document.querySelector(".conversation-modal")?.textContent?.includes(`Answer from ${id}`) === true;
const phoneShows = (h: H, id: string) => h.container.querySelector(".phone-conversation-pane")?.textContent?.includes(`Answer from ${id}`) === true;

async function openFirst(h: H) {
  const { Dashboard } = await h.ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => h.root.render(createElement(Dashboard, { phoneSessionOpen: "conversation", active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {}, defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true, onDebug() {}, onUsage() {}, onSettings() {} })));
  await waitFor(() => h.container.querySelector('[aria-label="Open First work"]') !== null, "the session list renders");
  await act(async () => h.container.querySelector<HTMLButtonElement>('[aria-label="Open First work"]')!.click());
}

// Starts a reply whose ACK the test releases; returns the release function.
async function startPendingReply(h: H) {
  let acknowledge!: (result: { ok: boolean; queued: boolean }) => void;
  let sent = 0;
  globalThis.__touchBusySubmit = () => { sent += 1; return new Promise(resolve => { acknowledge = resolve; }); };
  const field = editor(h)!;
  await act(async () => {
    const key = Object.keys(field).find(name => name.startsWith("__reactProps$"))!;
    (field as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[key].onChange({ target: { value: "continue" } });
  });
  await act(async () => h.window.document.querySelector<HTMLButtonElement>('[aria-label="Send reply"]')!.click());
  assert.equal(sent, 1, "the reply request is in flight");
  return async () => { await act(async () => acknowledge({ ok: true, queued: false })); await settle(); };
}

test("a reply in flight keeps the wide conversation mounted when rotating into the phone tier", async () => {
  const h = await harness(1180);
  try {
    await openFirst(h);
    await waitFor(() => wideShows(h, "history-one"), "wide conversation open");
    const field = editor(h)!;
    const release = await startPendingReply(h);
    await h.resize(820);
    await settle();
    assert.equal(field.isConnected, true, "the composer with the reply in flight stays mounted");
    await release();
    await waitFor(() => phoneShows(h, "history-one"), "the conversation transfers once the reply is accepted");
  } finally { delete globalThis.__touchBusySubmit; await h.close(); }
});

test("a reply in flight keeps the phone conversation mounted when widening", async () => {
  const h = await harness(820);
  try {
    await openFirst(h);
    await waitFor(() => phoneShows(h, "history-one"), "phone conversation open");
    const field = editor(h)!;
    const release = await startPendingReply(h);
    await h.resize(1366);
    await settle();
    assert.equal(field.isConnected, true, "the composer with the reply in flight stays mounted");
    await release();
    await waitFor(() => wideShows(h, "history-one"), "the conversation transfers once the reply is accepted");
  } finally { delete globalThis.__touchBusySubmit; await h.close(); }
});

test("a wide card selection waits for a reply in flight", async () => {
  const h = await harness(1180);
  try {
    await openFirst(h);
    await waitFor(() => wideShows(h, "history-one"), "wide conversation open");
    const release = await startPendingReply(h);
    await act(async () => h.container.querySelector<HTMLButtonElement>('[aria-label="Open Second work"]')!.click());
    await settle();
    assert.ok(wideShows(h, "history-one"), "the conversation stays on the session with the reply in flight");
    assert.equal(wideShows(h, "history-two"), false);
    await release();
  } finally { delete globalThis.__touchBusySubmit; await h.close(); }
});

test("a wide card menu selection waits for a reply in flight", async () => {
  const h = await harness(1180);
  try {
    await openFirst(h);
    await waitFor(() => wideShows(h, "history-one"), "wide conversation open");
    const field = editor(h)!;
    const release = await startPendingReply(h);
    const trigger = [...h.container.querySelectorAll<HTMLElement>('[aria-label="Session menu for First work"]')][0];
    await act(async () => trigger.click());
    const item = [...h.container.querySelectorAll<HTMLElement>(".slot-title-dropdown [role=menuitem]")].find(node => node.textContent?.includes("Second work"));
    assert.ok(item, "the card menu lists the other session");
    await act(async () => item.click());
    await settle();
    assert.equal(field.isConnected, true, "the composer with the reply in flight stays mounted");
    assert.equal(wideShows(h, "history-two"), false);
    await release();
  } finally { delete globalThis.__touchBusySubmit; await h.close(); }
});
