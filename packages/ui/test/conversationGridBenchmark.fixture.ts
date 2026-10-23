import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("controlled six-session client CPU and payload comparison uses real TerminalPane and Conversation readers", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import React from "react";
    import {createRoot} from "react-dom/client";
    import {SessionSlot} from "/src/SessionSlot.tsx";
    import {makeSession,makeSessionSlotProps} from "/test/support/fixtures.ts";
    window.stats={active:0,created:0,frames:0,streamBytes:0,controlBytes:0,lookups:0,reads:0,historyBytes:0,unexpected:0};
    const payload=new TextEncoder().encode("\\x1b[H"+("Controlled terminal output ".repeat(80)+"\\r\\n").repeat(2));
    class FixtureSocket extends EventTarget {
      static OPEN=1;static CONNECTING=0;static CLOSED=3;
      readyState=0;binaryType="arraybuffer";onopen=null;onmessage=null;onclose=null;onerror=null;
      constructor(url){super();if(!url.startsWith("ws://fixture.invalid/attach/"))throw new Error("unexpected socket");
        window.stats.created++;this.openTimer=setTimeout(()=>{if(this.readyState===3)return;
          this.readyState=1;window.stats.active++;this.onopen?.({});
          this.onmessage?.({data:JSON.stringify({schema_version:"agent-session.attach.v1",type:"capability",
            capability:"provider-prompt.v1",supported:false,provider:null,prompt_max_bytes:16384})});
          this.emit();this.outputTimer=setInterval(()=>this.emit(),125);
        },5);
      }
      emit(){if(this.readyState!==1)return;window.stats.frames++;window.stats.streamBytes+=payload.byteLength;
        this.onmessage?.({data:payload.slice().buffer});}
      send(data){window.stats.controlBytes+=new TextEncoder().encode(data).byteLength;}
      close(){clearTimeout(this.openTimer);clearInterval(this.outputTimer);
        if(this.readyState===1)window.stats.active--;this.readyState=3;this.onclose?.({code:1000});}
    }
    window.WebSocket=FixtureSocket;
    window.fetch=async()=>{window.stats.unexpected++;throw new Error("unexpected fixture network");};
    const sessions=Array.from({length:6},(_,index)=>makeSession({id:"tile-"+index,machine:"fixture",title:"Tile "+index,
      provider_resume:{provider:"codex",session_id:"thread-"+index}}));
    function Fixture(){const[mode,setMode]=React.useState("terminal");window.setDisplay=setMode;
      return React.createElement("ol",{className:"session-workspace desktop mode-6 slots-6",style:{height:"600px"}},
        ...sessions.map((session,index)=>{const props=makeSessionSlotProps({index,session,slot:"fixture/"+session.id,
          options:[session],viewport:{mobile:false}});
          return React.createElement(SessionSlot,{...props,key:index,view:{...props.view,sessionListDisplay:mode},
            terminal:{...props.terminal,terminalRenderMode:"realtime",terminalSelectedPaneRealtime:true,onReconnect(){}}});}));}
    const root=createRoot(document.querySelector("#root"));window.unmountFixture=()=>root.unmount();
    root.render(React.createElement(Fixture));
  `;
  const bundled = await build({
    configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
      name: "conversation-grid-boundaries", enforce:"pre",
      resolveId(id,importer) {
        if(id.endsWith("resourceEvents.ts"))return "\0grid-resources";
        if(!importer?.includes("/src/"))return;
        if(id==="./api.ts")return "\0grid-api";
      },
      load(id) {
        if(id==="\0grid-resources")return `export const RESOURCE_RECONCILE_MS=30000;
          export const resourceEvents={subscribe(_key,_change,health){health(false);return()=>{};}};`;
        if(id!=="\0grid-api")return;
        return `export * from "/src/api.ts?grid-original";
          export const attachTarget=async(machine,id)=>({url:"ws://fixture.invalid/attach/"+id});
          export const listHistorySessions=async(machine,{q})=>{window.stats.lookups++;return{ok:true,truncated:false,
            latestMessagePaging:true,sessions:[{id:"history-"+q,machine,provider:"codex",provider_session_id:q,
            title:"Tile",cwd:"/workspace",created_at:"2026-10-11T00:00:00Z",updated_at:"2026-10-11T00:00:00Z",resumable:true}]};};
          export const listHistoryMessages=async()=>{window.stats.reads++;
            const result={ok:true,messages:Array.from({length:24},(_,index)=>({id:"message-"+index,
              role:index%2?"assistant":"user",text:"Message "+index+" is a complete history response.",
              timestamp:"2026-10-11T00:00:00Z"}))};
            window.stats.historyBytes+=new TextEncoder().encode(JSON.stringify(result)).byteLength;return result;}
`;
      },
    }, {
      name: "conversation-benchmark-fixture",
      resolveId(id) { if (id.endsWith("conversation-benchmark-fixture")) return "\0conversation-benchmark-fixture"; },
      load(id) { if (id === "\0conversation-benchmark-fixture") return fixture; },
    }],
    build: { write: false, minify: false, lib: { entry: "conversation-benchmark-fixture", name: "FocusFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const bundledCss = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const css = ["styles.css", "sessionCardRows.css"].map(name => readFileSync(join(process.cwd(), "src", name), "utf8")).join("\n") + bundledCss;
  const temp = mkdtempSync(join(tmpdir(), "agent-console-conversation-benchmark-"));
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
    await send("Emulation.setDeviceMetricsOverride",{width:1440,height:800,deviceScaleFactor:1,mobile:false});
    const {frameTree}=await send("Page.getFrameTree");
    await send("Page.setDocumentContent",{frameId:frameTree.frame.id,html:`<!doctype html><style>${css}</style><div id="root"></div>`});
    await send("Performance.enable");
    await evaluate(code);
    const waitFor=async(condition:string)=>evaluate(`new Promise((resolve,reject)=>{let remaining=400;function check(){if(${condition})resolve(true);else if(--remaining)setTimeout(check,10);else reject(new Error("benchmark fixture did not settle"));}check();})`);
    const cpu=async()=>{const result=await send("Performance.getMetrics");return result.metrics.find((m:any)=>m.name==="TaskDuration").value;};
    const sample=async(mode:string)=>{
      const before=await evaluate("({...window.stats})");const started=await cpu();
      await evaluate("new Promise(resolve=>setTimeout(resolve,6000))");
      const ended=await cpu();const after=await evaluate("({...window.stats})");
      return {mode,seconds:6,mainThreadCpuSeconds:Number((ended-started).toFixed(6)),
        frames:after.frames-before.frames,streamPayloadBytes:after.streamBytes-before.streamBytes,
        historyLookups:after.lookups-before.lookups,historyReads:after.reads-before.reads,
        historyPayloadBytes:after.historyBytes-before.historyBytes,controlBytes:after.controlBytes-before.controlBytes,
        activeTerminalSockets:after.active,unexpectedRequests:after.unexpected};
    };
    await waitFor("window.stats.active===6 && document.querySelectorAll('.xterm-screen').length===6");
    await evaluate("new Promise(resolve=>setTimeout(resolve,500))");
    const terminal=await sample("terminal");
    await evaluate("window.setDisplay('conversation')");
    await waitFor("window.stats.active===0 && document.querySelectorAll('.slot-conversation-pane .history-message').length===144");
    const conversationStartup=await evaluate("({lookups:window.stats.lookups,reads:window.stats.reads})");
    const conversation=await sample("conversation");
    assert.equal(terminal.activeTerminalSockets,6);
    assert.ok(terminal.frames>0);
    assert.equal(conversation.activeTerminalSockets,0);
    assert.equal(conversation.frames,0,"unmounted terminal sockets deliver no output frames");
    assert.equal(conversation.streamPayloadBytes,0);
    assert.equal(conversation.historyLookups,0,"resolved history entries are reused while polling");
    assert.ok(conversation.historyReads<=18,"three-second fallback polling stays bounded for six sessions");
    assert.equal(terminal.unexpectedRequests,0);assert.equal(conversation.unexpectedRequests,0);
    t.diagnostic(JSON.stringify({scope:"controlled headless client, real TerminalPane and history reader; synthetic payload bytes exclude HTTP headers/compression and server CPU",
      sessions:6,terminalOutputHzPerSession:8,resourceEventsHealthy:false,conversationStartup,terminal,conversation}));
    await evaluate("window.unmountFixture()");
  } finally {
    socket?.close();
    const exited = new Promise<void>(resolve => browser.once("exit",()=>resolve()));
    browser.kill();
    await exited;
    rmSync(temp,{recursive:true,force:true});
  }
});
