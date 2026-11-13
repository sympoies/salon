import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";
import { assertNoElement } from "./support/domAssert.ts";
import { makeSession } from "./support/fixtures.ts";

declare global {
  var __createOpenHistory: boolean | undefined;
  var __createOpenCreated: boolean | undefined;
}

// A session created from the New dialog opens by the same phone open
// preference as a session picked from the list.
const existing = makeSession({ id: "old", machine: "fixture", title: "Existing work" });
const created = makeSession({ id: "new", machine: "fixture", title: "Created work" });

const boundary: Plugin = {
  name: "phone-create-open-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id.endsWith("TerminalPane.tsx")) return "\0create-open-terminal";
    if (id.endsWith("CreateDialog.tsx")) return "\0create-open-dialog";
  },
  load(id) {
    if (id === "\0create-open-terminal") return `import React from "react"; export function TerminalPane(){return React.createElement("div",{className:"terminal-pane"});}`;
    if (id === "\0create-open-dialog") return `import React from "react"; export function CreateDialog(props){return React.createElement("button",{"aria-label":"Submit create",onClick:()=>props.onCreate("fixture",{agent:"codex"})},"Create");}`;
  },
  transform(code, id) {
    if (!id.endsWith("/src/api.ts")) return;
    for (const name of ["listSessions", "createSession", "listHistorySessions", "listHistoryMessages", "usage", "fetchLayoutOrder", "listAccounts"])
      code = code.replace(`export async function ${name}(`, `export async function original${name}(`);
    return code + `
      export const listSessions = async () => ({ok:true,sessions:globalThis.__createOpenCreated?[${JSON.stringify(existing)},${JSON.stringify(created)}]:[${JSON.stringify(existing)}],machines:[{name:"fixture",ok:true,capabilities:{history:globalThis.__createOpenHistory !== false}}]});
      export const createSession = async () => { globalThis.__createOpenCreated = true; return {ok:true,id:"new"}; };
      export const listHistorySessions = async () => ({ok:true,truncated:false,latestMessagePaging:true,sessions:[]});
      export const listHistoryMessages = async () => ({ok:true,messages:[{id:"m",role:"assistant",text:"Created conversation answer"}]});
      export const usage = async () => ({providers:[],reachable:false});
      export const fetchLayoutOrder = async () => ({order:[],revision:null,reachable:false,conflict:false});
      export const listAccounts = async () => ({accounts:[]});
    `;
  },
};

async function harness(width: number, coarse: boolean) {
  const window = new Window({ url: "http://localhost" });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query === "(pointer: coarse)" && coarse, media: query, addEventListener() {}, removeEventListener() {},
  });
  const names = ["window", "document", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "MouseEvent", "KeyboardEvent", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis, { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLSelectElement: window.HTMLSelectElement, Event: window.Event, MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container); const ssr = createUiSsrHarness([boundary]);
  return { window, container, root, ssr, async close() {
    delete globalThis.__createOpenHistory; delete globalThis.__createOpenCreated;
    await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, previous); await window.happyDOM.close();
  } };
}

async function waitFor(condition: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
  assert.fail(message);
}

async function create(width: number, phoneSessionOpen: "conversation" | "terminal", history: boolean, coarse = false) {
  const h = await harness(width, coarse);
  globalThis.__createOpenHistory = history;
  const { Dashboard } = await h.ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => h.root.render(createElement(Dashboard, { phoneSessionOpen, active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {}, defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true, onDebug() {}, onUsage() {}, onSettings() {} })));
  await waitFor(() => h.container.querySelector('[aria-label="New session"]') !== null, "the dashboard renders");
  await act(async () => h.container.querySelector<HTMLButtonElement>('[aria-label="New session"]')!.click());
  await waitFor(() => h.container.querySelector('[aria-label="Submit create"]') !== null, "the create dialog opens");
  await act(async () => h.container.querySelector<HTMLButtonElement>('[aria-label="Submit create"]')!.click());
  return h;
}

test("a phone create with the conversation preference opens the conversation on a history machine", async () => {
  const h = await create(412, "conversation", true);
  try {
    await waitFor(() => h.container.querySelector(".phone-conversation-pane") !== null, "the conversation opens");
    assertNoElement(h.container, ".terminal-pane");
  } finally { await h.close(); }
});

test("a phone create with the terminal preference opens the terminal", async () => {
  const h = await create(412, "terminal", true);
  try {
    await waitFor(() => h.container.querySelector(".terminal-pane") !== null, "the terminal opens");
    assertNoElement(h.container, ".phone-conversation-pane");
  } finally { await h.close(); }
});

test("a phone create on a machine without history opens the terminal", async () => {
  const h = await create(412, "conversation", false);
  try {
    await waitFor(() => h.container.querySelector(".terminal-pane") !== null, "the terminal opens");
    assertNoElement(h.container, ".phone-conversation-pane");
    // Create keeps its plain terminal open, without the list's history-unavailable notice.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    assert.ok(!(h.container.textContent ?? "").includes("Conversation history is unavailable"));
  } finally { await h.close(); }
});

test("a wide create ignores the phone preference", async () => {
  const h = await create(1440, "conversation", true);
  try {
    await waitFor(() => globalThis.__createOpenCreated === true && h.container.querySelector(".terminal-pane") !== null, "the grid shows the terminal");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    assertNoElement(h.container, ".phone-conversation-pane");
    assertNoElement(h.container, ".conversation-modal");
  } finally { await h.close(); }
});

test("a touch-primary wide create with the conversation preference opens the created conversation", async () => {
  const h = await create(1440, "conversation", true, true);
  try {
    await waitFor(() => h.window.document.querySelector(".conversation-modal #conversation-title")?.textContent?.includes(created.title) === true, "the created conversation opens");
    assertNoElement(h.container, ".phone-conversation-pane");
  } finally { await h.close(); }
});
