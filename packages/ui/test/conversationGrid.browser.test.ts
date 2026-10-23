import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("1440px Conversation grid preserves geometry and reuses panel styling under both color-scheme preferences", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import React from "react";
    import {createRoot} from "react-dom/client";
    import {SessionSlot} from "/src/SessionSlot.tsx";
    import {LiveConversationPanel} from "/src/LiveConversationPanel.tsx";
    import {makeSession,makeSessionSlotProps} from "/test/support/fixtures.ts";
    const sessions = [0,1].map(index=>makeSession({id:"tile-"+index,machine:"fixture",title:"Tile "+index,
      provider_resume:{provider:"codex",session_id:"thread-"+index}}));
    window.terminals=0;
    window.unexpectedRequests=0;
    window.fetch=async()=>{window.unexpectedRequests++;throw new Error("unexpected fixture network");};
    function Fixture() {
      const [mode,setMode]=React.useState("terminal");
      window.setDisplay=setMode;
      return React.createElement(React.Fragment,null,
        React.createElement("ol",{className:"session-workspace desktop mode-4 slots-4",style:{height:"600px"}},
          ...[0,1,2,3].map(index=>{
            const session=sessions[index];
            const props=makeSessionSlotProps({index,session,slot:session?"fixture/"+session.id:null,
              options:session?[session]:[],viewport:{mobile:false}});
            return React.createElement(SessionSlot,{...props,key:index,view:{...props.view,sessionListDisplay:mode}});
          })),
        React.createElement("div",{className:"reference-panel"},React.createElement(LiveConversationPanel,{
          session:sessions[0],onClose(){},docked:true})));
    }
    const root=createRoot(document.querySelector("#root"));
    window.unmountFixture=()=>root.unmount();
    root.render(React.createElement(Fixture));
  `;
  const bundled = await build({
    configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
      name: "conversation-grid-boundaries", enforce:"pre",
      resolveId(id,importer) {
        if(id.endsWith("resourceEvents.ts"))return "\0grid-resources";
        if(!importer?.includes("/src/"))return;
        if(id.endsWith("TerminalPane.tsx"))return "\0grid-terminal";
        if(id==="./api.ts")return "\0grid-api";
      },
      load(id) {
        if(id==="\0grid-resources")return `export const RESOURCE_RECONCILE_MS=30000;
          export const resourceEvents={subscribe(_key,_change,health){health(false);return()=>{};}};`;
        if(id==="\0grid-terminal")return `import{createElement,useEffect}from"react";
          export function TerminalPane(){useEffect(()=>{window.terminals++;return()=>{window.terminals--;};},[]);
          return createElement("div",{className:"terminal-pane-mock"});}`;
        if(id!=="\0grid-api")return;
        return `export * from "/src/api.ts?grid-original";
          export const listHistorySessions=async(machine,{q})=>({ok:true,truncated:false,latestMessagePaging:true,
            sessions:[{id:"history-"+q,machine,provider:"codex",provider_session_id:q,title:"Tile",
            cwd:"/workspace",created_at:"2026-10-11T00:00:00Z",updated_at:"2026-10-11T00:00:00Z",resumable:true}]});
          export const listHistoryMessages=async()=>({ok:true,messages:Array.from({length:24},(_,index)=>({
            id:"message-"+index,role:index%2?"assistant":"user",text:"Message "+index+" is a complete history response.",
            timestamp:"2026-10-11T00:00:00Z"}))});`;
      },
    }, {
      name: "conversation-grid-fixture",
      resolveId(id) { if (id.endsWith("conversation-grid-fixture")) return "\0conversation-grid-fixture"; },
      load(id) { if (id === "\0conversation-grid-fixture") return fixture; },
    }],
    build: { write: false, minify: false, lib: { entry: "conversation-grid-fixture", name: "FocusFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = ["styles.css", "sessionCardRows.css"].map(name => readFileSync(join(process.cwd(), "src", name), "utf8")).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "agent-console-conversation-grid-"));
  const browser = spawn(process.env.CHROME_BIN ?? "google-chrome", [
    "--headless", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${temp}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let socket: WebSocket | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("Chrome debugging endpoint timed out")), 10_000);
      browser.stderr.on("data", data => {
        stderr += data.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]!); }
      });
      browser.once("error", error => { clearTimeout(timeout); reject(error); });
      browser.once("exit", () => { clearTimeout(timeout); reject(new Error("Chrome exited before debugging was ready")); });
    });
    const pages = await (await fetch(new URL("/json/list", endpoint.replace("ws:", "http:")))).json() as Array<{type:string;webSocketDebuggerUrl:string}>;
    const page = pages.find(item => item.type === "page"); assert.ok(page);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once:true }); socket!.addEventListener("error", reject, { once:true }); });
    let id = 0;
    const pending = new Map<number, {resolve:(result:any)=>void;reject:(error:Error)=>void}>();
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data)), waiter = pending.get(reply.id);
      if (waiter) { pending.delete(reply.id); reply.error ? waiter.reject(new Error(JSON.stringify(reply.error))) : waiter.resolve(reply.result); }
    });
    const send = (method:string, params:object = {}) => new Promise<any>((resolve,reject) => {
      const request = ++id; pending.set(request,{resolve,reject}); socket!.send(JSON.stringify({id:request,method,params}));
    });
    const evaluate = async (expression:string) => {
      const result = await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
      assert.equal(result.exceptionDetails,undefined,"browser fixture executes successfully");
      return result.result.value;
    };
    for (const scheme of ["dark","light"]) {
      await send("Emulation.setDeviceMetricsOverride",{width:1440,height:800,deviceScaleFactor:1,mobile:false});
      await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:scheme}]});
      const {frameTree}=await send("Page.getFrameTree");
      await send("Page.setDocumentContent",{frameId:frameTree.frame.id,html:`<!doctype html><style>${css}</style><div id="root"></div>`});
      await evaluate(code);
      const waitFor=async(condition:string)=>evaluate(`new Promise((resolve,reject)=>{let remaining=200;function check(){if(${condition})resolve(true);else if(--remaining)setTimeout(check,10);else reject(new Error("grid fixture did not settle"));}check();})`);
      await waitFor("window.terminals===2 && document.querySelectorAll('.reference-panel .history-message').length===24");
      const geometry=`[...document.querySelectorAll('.session-workspace .terminal-slot')].map(slot=>({
        width:slot.getBoundingClientRect().width,height:slot.getBoundingClientRect().height,
        header:slot.querySelector('.slot-head').getBoundingClientRect().height,
        content:(slot.querySelector('.slot-terminal-wrap,.slot-conversation-pane,.slot-empty').getBoundingClientRect().top-slot.getBoundingClientRect().top)
      }))`;
      const before=await evaluate(geometry);
      await evaluate("window.setDisplay('conversation')");
      await waitFor("document.querySelectorAll('.slot-conversation-pane .history-message').length===48");
      assert.equal(await evaluate("window.terminals"),0,"Conversation leaves no mounted terminal");
      assert.deepEqual(await evaluate(geometry),before,`${scheme}: grid and two-row geometry stays the same`);
      const measured=await evaluate(`(()=>{
        const pane=document.querySelector('.slot-conversation-pane');
        const reference=document.querySelector('.reference-panel .history-viewer');
        const style=node=>{const s=getComputedStyle(node);return{background:s.backgroundColor,color:s.color,
          font:s.fontSize,padding:s.padding,maxWidth:s.maxWidth,lineHeight:s.lineHeight};};
        const user=pane.querySelector('.is-user .history-bubble'),assistant=pane.querySelector('.is-assistant .history-bubble');
        const viewport=pane.querySelector('.history-messages');
        return{headerBackground:getComputedStyle(document.querySelector('.session-workspace .slot-head')).backgroundColor,
          paneBackground:getComputedStyle(pane).backgroundColor,referenceBackground:getComputedStyle(reference).backgroundColor,
          user:style(user),referenceUser:style(reference.querySelector('.is-user .history-bubble')),
          assistant:style(assistant),referenceAssistant:style(reference.querySelector('.is-assistant .history-bubble')),
          userLeft:user.getBoundingClientRect().left,assistantLeft:assistant.getBoundingClientRect().left,
          timestamps:pane.querySelectorAll('time').length,composer:pane.querySelector('.conversation-composer')!==null,
          scrollable:viewport.scrollHeight>viewport.clientHeight,
          bottom:viewport.scrollTop+viewport.clientHeight>=viewport.scrollHeight-1};
      })()`);
      assert.notEqual(measured.headerBackground,measured.paneBackground,"status header differs from the pane");
      assert.equal(measured.paneBackground,measured.referenceBackground,"pane uses the full panel background token");
      assert.deepEqual(measured.user,measured.referenceUser,"user bubble matches the existing docked panel");
      assert.deepEqual(measured.assistant,measured.referenceAssistant,"assistant bubble matches the existing docked panel");
      assert.ok(measured.userLeft>measured.assistantLeft,"You aligns right and assistant aligns left");
      assert.equal(measured.timestamps,24);
      assert.equal(measured.composer,true, "Conversation tiles include the shared reply composer");
      assert.equal(measured.scrollable,true);
      assert.equal(measured.bottom,true,"newest messages start at the bottom");
      assert.equal(await evaluate("window.unexpectedRequests"),0,"fixture makes no live network requests");
      await evaluate("window.setDisplay('terminal')");
      await waitFor("window.terminals===2 && document.querySelector('.slot-conversation-pane')===null");
      assert.deepEqual(await evaluate(geometry),before,"switching back keeps geometry unchanged");
      await evaluate("window.unmountFixture()");
    }
  } finally {
    socket?.close();
    const exited = new Promise<void>(resolve => browser.once("exit",()=>resolve()));
    browser.kill();
    await exited;
    rmSync(temp,{recursive:true,force:true});
  }
});
