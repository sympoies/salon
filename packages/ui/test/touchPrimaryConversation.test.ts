import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";
import { assertNoElement } from "./support/domAssert.ts";
import { makeSession } from "./support/fixtures.ts";

// #198: a primary coarse pointer decides how a session opens, whatever the
// width; the width tiers still decide layout. Rotating keeps an open conversation.
const sessions = [
  makeSession({ id: "one", machine: "fixture", title: "First work", provider_resume: { provider: "codex", session_id: "thread-one" } }),
  makeSession({ id: "two", machine: "fixture", title: "Second work", provider_resume: { provider: "codex", session_id: "thread-two" } }),
];

const boundary: Plugin = {
  name: "touch-primary-conversation-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id.endsWith("TerminalPane.tsx")) return "\0touch-primary-terminal";
  },
  load(id) {
    if (id === "\0touch-primary-terminal") return `import React from "react"; export function TerminalPane(props){return React.createElement("div",{className:"terminal-pane","data-session":props.id});}`;
  },
  transform(code, id) {
    if (!id.endsWith("/src/api.ts")) return;
    for (const name of ["listSessions", "listHistorySessions", "listHistoryMessages", "usage", "fetchLayoutOrder", "listAccounts"])
      code = code.replace(`export async function ${name}(`, `export async function original${name}(`);
    return code + `
      export const listSessions = async () => {
        // #942: a failed poll, as when the app sits in the system file picker.
        if (globalThis.__touchPrimaryNoop) throw new TypeError("Failed to fetch");
        return {ok:true,sessions:${JSON.stringify(sessions)},machines:[{name:"fixture",ok:true,capabilities:{history:!globalThis.__touchPrimaryNoHistory}}]};
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


async function harness(width: number, coarse: boolean, android = false) {
  const window = new Window({ url: "http://localhost", settings: android ? { navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36" } } : {} });
  if (android) Object.assign(window, { __TAURI_INTERNALS__: {} });
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query === "(pointer: coarse)" && coarse, media: query, addEventListener() {}, removeEventListener() {},
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
    async close() { await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis, previous); (globalThis as { __touchPrimaryNoHistory?: boolean }).__touchPrimaryNoHistory = false; await window.happyDOM.close(); },
  };
}
type H = Awaited<ReturnType<typeof harness>>;

async function waitFor(condition: () => boolean, message: string) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
  assert.fail(message);
}

async function openFirst(h: H, phoneSessionOpen: "conversation" | "terminal" = "conversation") {
  const { Dashboard } = await h.ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
  await act(async () => h.root.render(createElement(Dashboard, { phoneSessionOpen, active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {}, defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true, onDebug() {}, onUsage() {}, onSettings() {} })));
  await waitFor(() => h.container.querySelector('[aria-label="Open First work"]') !== null, "the session list renders");
  await act(async () => h.container.querySelector<HTMLButtonElement>('[aria-label="Open First work"]')!.click());
}

// The wide layout shows a conversation as a panel; the phone layout as a mode of the focused session.
const panel = (h: H) => h.container.querySelector(".conversation-modal")?.textContent?.includes("Answer from history-one") === true
  || h.window.document.querySelector(".conversation-modal")?.textContent?.includes("Answer from history-one") === true;
const phonePane = (h: H) => h.container.querySelector(".phone-conversation-pane")?.textContent?.includes("Answer from history-one") === true;
// The wide grid mounts every terminal; opening one as a terminal focuses it.
const terminal = (h: H) => h.container.querySelector('.terminal-slot.is-focused .terminal-pane[data-session="one"]') !== null;

for (const width of [1180, 1366]) {
  test(`a coarse primary pointer at ${width}px opens a session in conversation`, async () => {
    const h = await harness(width, true);
    try {
      await openFirst(h);
      await waitFor(() => panel(h), "the conversation panel shows the session");
      assert.equal(terminal(h), false);
    } finally { await h.close(); }
  });

  test(`the terminal preference opens the terminal at ${width}px with a coarse pointer`, async () => {
    const h = await harness(width, true);
    try {
      await openFirst(h, "terminal");
      await waitFor(() => terminal(h), "the terminal opens");
      assert.equal(panel(h), false);
    } finally { await h.close(); }
  });

  test(`a fine pointer at ${width}px still opens the terminal`, async () => {
    const h = await harness(width, false);
    try {
      await openFirst(h);
      await waitFor(() => terminal(h), "the terminal opens");
      assert.equal(panel(h), false);
    } finally { await h.close(); }
  });
}

// #207: the Android app is always a touch client, even when its WebView reports a fine pointer (stylus).
// The Android app takes the phone layout at any width; browsers keep the width and pointer tiers.
const noGrid = (h: H) => h.container.querySelector(".terminal-pane") === null && h.container.querySelector(".conversation-modal") === null;

test("the Android app at 900px with a fine pointer uses the phone layout and opens a session in conversation", async () => {
  const h = await harness(900, false, true);
  try {
    await openFirst(h);
    await waitFor(() => phonePane(h), "the phone conversation shows the session");
    assert.equal(noGrid(h), true);
  } finally { await h.close(); }
});

test("the Android app at 900px with a fine pointer honors the terminal preference", async () => {
  const h = await harness(900, false, true);
  try {
    await openFirst(h, "terminal");
    await waitFor(() => h.container.querySelector('.terminal-pane[data-session="one"]') !== null, "the terminal opens");
    assert.equal(phonePane(h), false);
  } finally { await h.close(); }
});

test("rotating the Android app between 677px and 902px keeps the session in conversation", async () => {
  const h = await harness(677, false, true);
  try {
    await openFirst(h);
    await waitFor(() => phonePane(h), "phone conversation open");
    await h.resize(902);
    await waitFor(() => phonePane(h), "still the phone conversation at 902px");
    assert.equal(noGrid(h), true);
    await h.resize(677);
    await waitFor(() => phonePane(h), "still the phone conversation at 677px");
  } finally { await h.close(); }
});

test("a browser at 900px with a fine pointer stays in the desktop tier", async () => {
  const h = await harness(900, false);
  try {
    await openFirst(h);
    await waitFor(() => terminal(h), "the terminal opens");
    assert.equal(phonePane(h), false);
  } finally { await h.close(); }
});

for (const width of [1180, 1400]) {
  test(`the Android app at ${width}px uses the phone layout and opens a session in conversation`, async () => {
    const h = await harness(width, false, true);
    try {
      await openFirst(h);
      await waitFor(() => phonePane(h), "the phone conversation shows the session");
      assert.equal(noGrid(h), true);
    } finally { await h.close(); }
  });
}

test("the Android app at 1400px honors the terminal preference", async () => {
  const h = await harness(1400, false, true);
  try {
    await openFirst(h, "terminal");
    await waitFor(() => h.container.querySelector('.terminal-pane[data-session="one"]') !== null, "the terminal opens");
    assert.equal(phonePane(h), false);
  } finally { await h.close(); }
});

test("a coarse pointer at 1180px opens the terminal on a machine without history", async () => {
  (globalThis as { __touchPrimaryNoHistory?: boolean }).__touchPrimaryNoHistory = true;
  const h = await harness(1180, true);
  try {
    await openFirst(h);
    await waitFor(() => terminal(h), "the terminal opens");
    assert.equal(panel(h), false);
  } finally { await h.close(); }
});

test("rotating a wide conversation into the phone tier and back keeps it open", async () => {
  const h = await harness(1180, true);
  try {
    await openFirst(h);
    await waitFor(() => panel(h), "wide conversation open");
    await h.resize(820);
    await waitFor(() => phonePane(h), "the conversation follows into the phone tier");
    assert.equal(terminal(h), false);
    await h.resize(1180);
    await waitFor(() => panel(h), "the conversation returns to the wide panel");
    assert.equal(phonePane(h), false);
  } finally { await h.close(); }
});

test("rotating a phone-tier conversation to a wide width keeps it open", async () => {
  const h = await harness(820, true);
  try {
    await openFirst(h);
    await waitFor(() => phonePane(h), "phone conversation open");
    await h.resize(1366);
    await waitFor(() => panel(h), "the conversation follows into the wide panel");
  } finally { await h.close(); }
});

// The layout tier flips at 1024px; the open mode is conversation on both sides.
for (const [width, shows] of [[1024, phonePane], [1025, panel]] as const) {
  test(`a coarse pointer at ${width}px opens conversation on its layout tier`, async () => {
    const h = await harness(width, true);
    try {
      await openFirst(h);
      await waitFor(() => shows(h), "the conversation shows in this tier's surface");
    } finally { await h.close(); }
  });
}

// styles.css follows the same tier decision through data-phone-tier on the root.
test("the phone tier published for styles.css is true for the Android app at any width", async () => {
  const h = await harness(900, false, true);
  try {
    const { watchPhoneTier } = await h.ssr.loadModule<typeof import("../src/phoneTier.ts")>("/src/phoneTier.ts");
    const stop = watchPhoneTier();
    assert.equal(h.window.document.documentElement.dataset.phoneTier, "true");
    await h.resize(1400);
    assert.equal(h.window.document.documentElement.dataset.phoneTier, "true");
    stop();
  } finally { await h.close(); }
});

test("the phone tier published for a browser at 900px with a fine pointer is desktop", async () => {
  const h = await harness(900, false);
  try {
    const { watchPhoneTier } = await h.ssr.loadModule<typeof import("../src/phoneTier.ts")>("/src/phoneTier.ts");
    watchPhoneTier()();
    assert.equal(h.window.document.documentElement.dataset.phoneTier, "false");
  } finally { await h.close(); }
});
