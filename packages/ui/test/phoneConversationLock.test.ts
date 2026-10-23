import { sharedAdmissionFixture } from "./support/sharedAdmissionFixture.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";
import { makeSession } from "./support/fixtures.ts";

// exampleOrg/agent-console#896 review F1/F2: a phone Conversation reply in flight
// keeps its session on screen against double-click and navigation shortcuts.
declare global {
  var __phoneLockSubmit: ((...args: unknown[]) => Promise<unknown>) | undefined;
  var __phoneLockMacShortcuts: boolean | undefined;
}

// Claude retains the direct-send ACK interval these navigation locks protect.
// Codex clears after durable local admission, before its asynchronous HTTP ACK.
const turnState = { schema_version: "agent-session.turn-state.v1", phase: "idle", phase_changed_at: "2026-10-11T00:00:00Z", revision: 1, source: { kind: "provider_hook", provider: "claude", confidence: "authoritative" } };
const sessions = [
  makeSession({ id: "one", machine: "fixture", agent: "claude", title: "First work", turn_state: turnState, provider_resume: { provider: "claude", session_id: "thread-one" } } as never),
  makeSession({ id: "two", machine: "fixture", agent: "claude", title: "Second work", turn_state: turnState, provider_resume: { provider: "claude", session_id: "thread-two" } } as never),
];

const boundary: Plugin = {
  name: "phone-conversation-lock-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (id.endsWith("sharedOutboxClient.ts")) return "\0shared-admission-fixture";
    if (!importer?.includes("/src/")) return;
    if (id.endsWith("TerminalPane.tsx")) return "\0phone-lock-terminal";
  },
  load(id) {
    if (id === "\0shared-admission-fixture") return sharedAdmissionFixture("globalThis.__phoneLockSubmit");
    if (id === "\0phone-lock-terminal") return `import React from "react"; export function TerminalPane(props){return React.createElement("div",{className:"terminal-pane","data-session":props.id});}`;
  },
  transform(code, id) {
    if (id.endsWith("/src/runtime.ts")) {
      return code.replace("export function isMacTauri(): boolean {", "export function isMacTauri(): boolean {\n  if (globalThis.__phoneLockMacShortcuts) return true;");
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
      export const submitSessionPrompt = (...args) => globalThis.__phoneLockSubmit(...args);
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
type Harness = Awaited<ReturnType<typeof harness>>;

async function waitFor(condition: () => boolean, message = "phone fixture did not settle") {
  for (let i = 0; i < 200; i++) { if (condition()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
  assert.fail(message);
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

const focused = (h: Harness) => h.container.querySelector<HTMLElement>(".terminal-slot.is-focused");
const conversationShows = (h: Harness, historyId: string) =>
  Boolean(focused(h)?.querySelector(".phone-conversation-pane")?.textContent?.includes(`Answer from ${historyId}`));

async function openFirstConversation(h: Harness) {
  const { Dashboard } = await h.ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => h.root.render(createElement(Dashboard, { phoneSessionOpen: "conversation", active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {}, defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true, onDebug() {}, onUsage() {}, onSettings() {} })));
  await waitFor(() => h.container.querySelector('[aria-label="Open First work"]') !== null);
  await act(async () => h.container.querySelector<HTMLButtonElement>('[aria-label="Open First work"]')!.click());
  await waitFor(() => conversationShows(h, "history-one"));
}

// Starts a reply whose ACK the test releases; returns the release function.
async function startPendingReply(h: Harness) {
  const requests: unknown[][] = [];
  let acknowledge!: (result: { ok: boolean; queued: boolean }) => void;
  globalThis.__phoneLockSubmit = (...args) => { requests.push(args); return new Promise(resolve => { acknowledge = resolve; }); };
  const editor = focused(h)!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to session"]')!;
  await act(async () => {
    const key = Object.keys(editor).find(name => name.startsWith("__reactProps$"))!;
    (editor as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[key].onChange({ target: { value: "continue" } });
  });
  await act(async () => focused(h)!.querySelector<HTMLButtonElement>('[aria-label="Send reply"]')!.click());
  assert.equal(requests.length, 1, "the reply request is in flight");
  return async () => {
    await act(async () => acknowledge({ ok: true, queued: false }));
    await waitFor(() => focused(h)?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to session"]')?.value === "",
      "the accepted reply clears its draft");
  };
}

function doubleClick(h: Harness, target: Element) {
  return act(async () => { target.dispatchEvent(new h.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }) as never); });
}

function press(h: Harness, key: string, init: Record<string, unknown> = {}) {
  return act(async () => {
    h.window.dispatchEvent(new h.window.KeyboardEvent("keydown", { key, code: /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key, bubbles: true, cancelable: true, ...init }) as never);
  });
}

for (const pending of [false, true]) {
  test(`double-clicking ${pending ? "a pending" : "an idle"} phone Conversation history keeps the session`, async () => {
    const h = await harness();
    try {
      await openFirstConversation(h);
      const release = pending ? await startPendingReply(h) : null;
      await doubleClick(h, focused(h)!.querySelector(".phone-conversation-pane .history-bubble")!);
      await settle();
      assert.ok(conversationShows(h, "history-one"), "a double-click to select text never leaves the session");
      if (release) {
        await release();
        assert.ok(conversationShows(h, "history-one"));
      }
    } finally { delete globalThis.__phoneLockSubmit; await h.close(); }
  });
}

test("navigation shortcuts wait for a pending phone Conversation reply", async () => {
  const h = await harness();
  globalThis.__phoneLockMacShortcuts = true;
  try {
    await openFirstConversation(h);
    const release = await startPendingReply(h);
    for (const [key, init] of [["l", { metaKey: true }], ["h", { metaKey: true }], ["2", { metaKey: true }], ["f", { metaKey: true }], ["`", { metaKey: true }]] as const) {
      await press(h, key, init);
      await settle();
      assert.ok(conversationShows(h, "history-one"), `Cmd+${key} keeps the pending session`);
    }
    await release();
    await press(h, "l", { metaKey: true });
    await waitFor(() => conversationShows(h, "history-two"), "after the ACK, Cmd+L moves on in Conversation");
  } finally { delete globalThis.__phoneLockSubmit; delete globalThis.__phoneLockMacShortcuts; await h.close(); }
});
