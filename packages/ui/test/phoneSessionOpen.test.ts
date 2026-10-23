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
  var __phoneHistoryAvailable: boolean | undefined;
  var __phoneHistoryMessageError: boolean | undefined;
}

const boundary: Plugin = {
  name: "phone-open-boundaries", enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id.endsWith("TerminalPane.tsx")) return "\0phone-terminal";
  },
  load(id) {
    if (id === "\0phone-terminal") return `import React from "react"; export function TerminalPane(){return React.createElement("div",{className:"terminal-pane"});}`;
  },
  transform(code, id) {
    if (!id.endsWith("/src/api.ts")) return;
    for (const name of ["listSessions", "listHistorySessions", "listHistoryMessages", "usage", "fetchLayoutOrder", "listAccounts"])
      code = code.replace(`export async function ${name}(`, `export async function original${name}(`);
    return code + `
      export const listSessions = async () => ({ok:true,sessions:[${JSON.stringify(makeSession({id:"phone",machine:"fixture",title:"Phone work",provider_resume:{provider:"codex",session_id:"thread"}}))}],machines:[{name:"fixture",ok:true,capabilities:{history:globalThis.__phoneHistoryAvailable !== false}}]});
      export const listHistorySessions = async () => ({ok:true,truncated:false,latestMessagePaging:true,sessions:[{id:"history",machine:"fixture",provider:"codex",provider_session_id:"thread",title:"Phone work",cwd:"/workspace",created_at:"2026-10-15T00:00:00Z",updated_at:"2026-10-15T00:00:00Z",resumable:true}]});
      export const listHistoryMessages = async () => {
        if (globalThis.__phoneHistoryMessageError) throw new Error("Temporary message fetch failure; retry available");
        return {ok:true,messages:[{id:"m",role:"assistant",text:"Shared conversation answer"}]};
      };
      export const usage = async () => ({providers:[],reachable:false});
      export const fetchLayoutOrder = async () => ({order:[],revision:null,reachable:false,conflict:false});
      export const listAccounts = async () => ({accounts:[]});
    `;
  },
};

async function harness(width = 412) {
  const window = new Window({url:"http://localhost"});
  Object.defineProperty(window,"innerWidth",{configurable:true,value:width});
  const names = ["window","document","Element","HTMLElement","HTMLInputElement","HTMLTextAreaElement","HTMLSelectElement","Event","MouseEvent","KeyboardEvent","localStorage","IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  Object.assign(globalThis,{window,document:window.document,Element:window.Element,HTMLElement:window.HTMLElement,HTMLInputElement:window.HTMLInputElement,HTMLTextAreaElement:window.HTMLTextAreaElement,HTMLSelectElement:window.HTMLSelectElement,Event:window.Event,MouseEvent:window.MouseEvent,KeyboardEvent:window.KeyboardEvent,localStorage:window.localStorage,IS_REACT_ACT_ENVIRONMENT:true});
  const container = window.document.createElement("div"); window.document.body.append(container);
  const root = createRoot(container); const ssr = createUiSsrHarness([boundary]);
  return {window,container,root,ssr,async close(){await act(async()=>root.unmount());await ssr.close();Object.assign(globalThis,previous);await window.happyDOM.close();}};
}
async function waitFor(condition:()=>boolean) {
  for(let i=0;i<200;i++){if(condition())return;await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5));});}
  assert.fail("phone fixture did not settle");
}

test("phone opens conversation by default with composer, then switches to terminal and back", async()=>{
  const h=await harness();
  try {
    const {Dashboard}=await h.ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
    await act(async()=>h.root.render(createElement(Dashboard,{active:true,machines:["fixture"],enabledMachines:["fixture"],machineColors:{},defaultAutoResume:false,terminalRenderMode:"realtime",terminalSelectedPaneRealtime:true,onDebug(){},onUsage(){},onSettings(){}})));
    await waitFor(()=>h.container.querySelector('[aria-label="Open Phone work"]')!==null);
    await act(async()=>h.container.querySelector<HTMLButtonElement>('[aria-label="Open Phone work"]')!.click());
    await waitFor(()=>h.container.querySelector(".phone-conversation-pane")!==null);
    await waitFor(()=>Boolean(h.container.textContent?.includes("Shared conversation answer")));
    assert.ok(h.container.querySelector('.conversation-composer:not([hidden])'),"composer is visible immediately");
    assertNoElement(h.container,".terminal-pane");
    const terminal=h.container.querySelector<HTMLButtonElement>('[aria-label="Switch to terminal"]');assert.ok(terminal);
    await act(async()=>terminal.click());
    await waitFor(()=>h.container.querySelector(".terminal-pane")!==null);
    const conversation=h.container.querySelector<HTMLButtonElement>('[aria-label="Switch to conversation"]');assert.ok(conversation);
    await act(async()=>conversation.click());
    await waitFor(()=>h.container.querySelector(".phone-conversation-pane")!==null);
  } finally {await h.close();}
});

for (const width of [412,1440]) test(`Settings shows only the layout preference at ${width}`,async()=>{
  const h=await harness(width);
  try {
    const {Settings}=await h.ssr.loadModule<typeof import("../src/Settings.tsx")>("/src/Settings.tsx");
    await act(async()=>h.root.render(createElement(Settings,{onSaved(){},machines:[],machineColors:{},defaultAutoResume:false,attentionAlerts:false,pinCoordinators:false,terminalRenderMode:"realtime",terminalSelectedPaneRealtime:true,onMachineColorChange(){},onMachineColorReset(){},onDefaultAutoResumeChange(){},onAttentionAlertsChange(){},onPinCoordinatorsChange(){},onTerminalRenderModeChange(){},onTerminalSelectedPaneRealtimeChange(){},openAccess:true,onSignedOut(){}})));
    const phone=h.container.querySelector<HTMLSelectElement>('[aria-label="Open session as"]');
    const desktop=h.container.querySelector<HTMLSelectElement>('[aria-label="Session list display"]');
    assert.equal(Boolean(phone),width===412);assert.equal(Boolean(desktop),width!==412);
    assert.equal((phone??desktop)?.value,width===412?"conversation":"terminal");
  } finally {await h.close();}
});

test("phone Terminal preference preserves terminal open", async()=>{
  const h=await harness();
  try {
    globalThis.__phoneHistoryAvailable = true;
    const {Dashboard}=await h.ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
    await act(async()=>h.root.render(createElement(Dashboard,{phoneSessionOpen:"terminal",active:true,machines:["fixture"],enabledMachines:["fixture"],machineColors:{},defaultAutoResume:false,terminalRenderMode:"realtime",terminalSelectedPaneRealtime:true,onDebug(){},onUsage(){},onSettings(){}})));
    await waitFor(()=>h.container.querySelector('[aria-label="Open Phone work"]')!==null);
    await act(async()=>h.container.querySelector<HTMLButtonElement>('[aria-label="Open Phone work"]')!.click());
    await waitFor(()=>h.container.querySelector(".terminal-pane")!==null);
    assertNoElement(h.container,".phone-conversation-pane");

  } finally {delete globalThis.__phoneHistoryAvailable;await h.close();}
});

test("unavailable phone history opens terminal with a short notice", async()=>{
  const h=await harness();
  try {
    globalThis.__phoneHistoryAvailable = false;
    const {Dashboard}=await h.ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
    await act(async()=>h.root.render(createElement(Dashboard,{active:true,machines:["fixture"],enabledMachines:["fixture"],machineColors:{},defaultAutoResume:false,terminalRenderMode:"realtime",terminalSelectedPaneRealtime:true,onDebug(){},onUsage(){},onSettings(){}})));
    await waitFor(()=>h.container.querySelector('[aria-label="Open Phone work"]')!==null);
    await act(async()=>h.container.querySelector<HTMLButtonElement>('[aria-label="Open Phone work"]')!.click());
    await waitFor(()=>h.container.querySelector(".terminal-pane")!==null);
    assertNoElement(h.container,".phone-conversation-pane");
    assert.match(h.container.querySelector('[role="status"]')?.textContent??"",/history is unavailable.*terminal/);
  } finally {delete globalThis.__phoneHistoryAvailable;await h.close();}
});

for (const phase of ["initial read", "refresh"]) {
  test(`supported phone conversation keeps ${phase} errors visible and recovers with Refresh`, async () => {
    const h = await harness();
    try {
      globalThis.__phoneHistoryAvailable = true;
      globalThis.__phoneHistoryMessageError = phase === "initial read";
      const { Dashboard } = await h.ssr.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
      await act(async () => h.root.render(createElement(Dashboard, {
        active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {},
        defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
        onDebug() {}, onUsage() {}, onSettings() {},
      })));
      await waitFor(() => h.container.querySelector('[aria-label="Open Phone work"]') !== null);
      await act(async () => h.container.querySelector<HTMLButtonElement>('[aria-label="Open Phone work"]')!.click());
      if (phase === "refresh") {
        await waitFor(() => Boolean(h.container.textContent?.includes("Shared conversation answer")));
        globalThis.__phoneHistoryMessageError = true;
        const refresh = h.container.querySelector<HTMLButtonElement>('[aria-label="Refresh conversation"]');
        assert.ok(refresh);
        await act(async () => refresh.click());
      }
      await waitFor(() => Boolean(h.container.textContent?.includes("Temporary message fetch failure"))
        || h.container.querySelector(".terminal-pane") !== null);
      assert.equal(Boolean(h.container.querySelector(".phone-conversation-pane")), true,
        "a supported history request error must keep Conversation open");
      assertNoElement(h.container, ".terminal-pane");
      assert.match(h.container.querySelector('[role="alert"]')?.textContent ?? "", /Temporary message fetch failure/);
      assert.equal(h.container.textContent?.includes("Conversation history is unavailable"), false);
      assert.ok(h.container.querySelector('[aria-label="Switch to terminal"]'), "explicit Terminal stays available");
      const refresh = h.container.querySelector<HTMLButtonElement>('[aria-label="Refresh conversation"]');
      assert.ok(refresh);
      assert.equal(refresh.disabled, false);
      globalThis.__phoneHistoryMessageError = false;
      await act(async () => refresh.click());
      await waitFor(() => Boolean(h.container.textContent?.includes("Shared conversation answer"))
        && h.container.querySelector('[role="alert"]') === null);
      assert.equal(Boolean(h.container.querySelector(".phone-conversation-pane")), true);
      assertNoElement(h.container, ".terminal-pane");
    } finally {
      delete globalThis.__phoneHistoryAvailable;
      delete globalThis.__phoneHistoryMessageError;
      await h.close();
    }
  });
}
