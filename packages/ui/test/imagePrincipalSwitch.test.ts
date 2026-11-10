import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Plugin } from "vite";
import { createUiSsrHarness } from "./support/ssr.ts";

const fixture: Plugin = {
  name: "image-principal-switch", enforce: "pre",
  resolveId(id, importer) {
    if (!importer?.includes("/src/")) return;
    if (id === "./Dashboard.tsx") return "\0switch-dashboard";
    if (id === "./ShellPage.tsx") return "\0switch-shell";
    if (id === "./Login.tsx") return "\0switch-login";
    if (id === "./useLiveConversation.ts") return "\0switch-conversation";
    if (["./ConversationComposer.tsx", "./OutgoingReplies.tsx", "./SharedOutgoingReplies.tsx"].includes(id)) return "\0switch-controls";
  },
  load(id) {
    if (id === "\0switch-shell") return "export function ShellPage() { return null }";
    if (id === "\0switch-login") return `import React from 'react'; import {login} from '/src/api.ts';
      export function Login({onSignedIn}) { return React.createElement('button',{'data-testid':'sign-in',onClick:async()=>{if(await login('fixture-token')) onSignedIn()}},'Sign in') }`;
    if (id === "\0switch-controls") return "export function ConversationComposer(){return null} export function OutgoingReplies(){return null} export function SharedOutgoingReplies(){return null}";
    if (id === "\0switch-conversation") return `
      const image = 'a'.repeat(16)+'.0.0.'+'b'.repeat(32);
      const conversation = {session:{id:'history',machine:'fixture',provider:'codex'},messages:[{id:'message',role:'user',text:'Image',images:[{id:image}]}],latestMessagePaging:true,loading:false,viewportRef:{current:null}};
      export function useLiveConversation(){return {conversation,providerSessionId:'thread',label:'Conversation',resolving:false}};
    `;
    if (id === "\0switch-dashboard") return `
      import React from 'react';
      import {SessionConversationPane} from '/src/SessionConversationPane.tsx';
      import {LiveConversationPanel} from '/src/LiveConversationPanel.tsx';
      const session={id:'session',machine:'fixture',agent:'codex',title:'Conversation'};
      export function Dashboard({onSettings}) { return React.createElement(React.Fragment,null,
        React.createElement('button',{onClick:onSettings,'aria-label':'Open Settings'},'Settings'),
        React.createElement(SessionConversationPane,{session,machineReachable:true}),
        React.createElement(LiveConversationPanel,{session,machineReachable:true,docked:true,onClose(){}})); }
    `;
  },
};

test("both conversation surfaces fetch again after signing in as another principal", {timeout: 15000}, async () => {
  const window = new Window({url:"http://localhost"});
  const previous = {window:globalThis.window,document:globalThis.document,Element:globalThis.Element,
    HTMLElement:globalThis.HTMLElement,Event:globalThis.Event,MouseEvent:globalThis.MouseEvent,
    KeyboardEvent:globalThis.KeyboardEvent,IS_REACT_ACT_ENVIRONMENT:globalThis.IS_REACT_ACT_ENVIRONMENT,fetch:globalThis.fetch};
  Object.assign(globalThis,{window,document:window.document,Element:window.Element,HTMLElement:window.HTMLElement,
    Event:window.Event,MouseEvent:window.MouseEvent,KeyboardEvent:window.KeyboardEvent,IS_REACT_ACT_ENVIRONMENT:true});
  let principal: string | null = "alpha", requests = 0;
  globalThis.fetch = async input => {
    const path = new URL(String(input),"http://localhost").pathname;
    if (path === "/api/auth/status") return Response.json({authenticated:principal !== null,openAccess:false,principal:principal ? {id:principal,permissions:[]} : null});
    if (path === "/api/auth/logout") { principal = null; return Response.json({ok:true}); }
    if (path === "/api/auth/login") { principal = "beta"; return Response.json({ok:true}); }
    if (path === "/api/machines") return Response.json({machines:[]});
    if (path.includes("/images/")) { requests++; return new Response(new Uint8Array([requests]),{headers:{"content-type":"image/png"}}); }
    throw new Error(`unexpected fixture request: ${path}`);
  };
  const container = window.document.body.appendChild(window.document.createElement("div"));
  const root = createRoot(container), ssr = createUiSsrHarness({plugins:[fixture]});
  const waitFor = async (condition: () => boolean) => {
    for (let i=0;i<200;i++) { if (condition()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve,5)); }); }
    assert.fail("principal switch fixture did not settle");
  };
  try {
    const {default:App} = await ssr.loadModule<typeof import("../src/App.tsx")>("/src/App.tsx");
    await act(async () => root.render(createElement(App)));
    await waitFor(() => container.querySelectorAll('.history-viewer img').length >= 2);
    const before = [...container.querySelectorAll<HTMLImageElement>('.history-viewer img')].map(image => image.src);
    assert.equal(requests,1,"the two surfaces share the in-session image");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Settings"]')!.click());
    const signOut = [...container.querySelectorAll("button")].find(button => button.textContent === "Sign out"); assert.ok(signOut);
    await act(async () => signOut.click());
    await waitFor(() => container.querySelector('[data-testid="sign-in"]') !== null);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="sign-in"]')!.click());
    await waitFor(() => container.querySelectorAll('.history-viewer img').length >= 2);
    const after = [...container.querySelectorAll<HTMLImageElement>('.history-viewer img')].map(image => image.src);
    assert.equal(requests,2,"the next principal performs a fresh read");
    assert.ok(after.every(url => !before.includes(url)),"neither surface displays the previous principal's URL");
  } finally {
    await act(async () => root.unmount()); await ssr.close(); Object.assign(globalThis,previous); await window.happyDOM.close();
  }
});
