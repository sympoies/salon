import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("Activity details support genuine text selection and exact keyboard ID copy", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { SessionSlot } from "/src/SessionSlot.tsx";
    import { makeSession, makeSessionSlotProps } from "/test/support/fixtures.ts";
    window.copies = [];
    window.sessionActions = [];
    window.activityManagedId = "managed-" + window.activityAgent + "-" + "a".repeat(140);
    window.activityProviderId = "provider-" + window.activityAgent + "-" + "b".repeat(160);
    Object.defineProperty(navigator, "clipboard", {configurable:true,value:{
      writeText: async text => {
        window.copies.push(text);
        if (window.copies.length === 1) await new Promise(resolve => setTimeout(resolve, 500));
      }
    }});
    const root = createRoot(document.querySelector("#root"));
    window.unmountFixture = () => root.unmount();
    const mobile = innerWidth <= 900;
    const props = makeSessionSlotProps({session:makeSession({
      id:window.activityManagedId,agent:window.activityAgent,status:"running",machine:"fixture",
      provider_resume:{provider:window.activityAgent,session_id:window.activityProviderId}
    }),slotNativeDragEnabled:!mobile,viewport:{mobile},now:1780000000000,
      handleSlotDragStart(){window.sessionActions.push("drag");},
      onKill(){window.sessionActions.push("kill");},
      onFocusSession(){window.sessionActions.push("focus");}});
    root.render(React.createElement("ul", {className:"session-workspace " + (mobile ? "mobile" : "desktop"),style:{margin:20,width:280}},
      React.createElement(SessionSlot,props)));
  `;
  const bundled = await build({
    configFile:false,logLevel:"silent",define:{"process.env.NODE_ENV":JSON.stringify("production")},
    plugins:[react(),{name:"activity-terminal-fixture",enforce:"pre",
      resolveId(id,importer){if(id==="./TerminalPane.tsx" && importer?.endsWith("/src/SessionSlot.tsx"))return "\0activity-terminal-fixture";},
      load(id){if(id==="\0activity-terminal-fixture")return 'import React from "react";export function TerminalPane(){return React.createElement("div",{className:"terminal-pane-mock"});}';}
    },{name:"activity-identity-fixture",
      resolveId(id){if(id.endsWith("activity-identity-fixture"))return "\0activity-identity-fixture";},
      load(id){if(id==="\0activity-identity-fixture")return fixture;}
    }],
    build:{write:false,minify:false,lib:{entry:"activity-identity-fixture",name:"ActivityFixture",formats:["iife"]}}
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = ["styles.css", "sessionCardRows.css"].map(name => readFileSync(join(process.cwd(), "src", name), "utf8")).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "agent-console-activity-identities-"));
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
    const key = async (name:string, code:string, virtualKey:number) => {
      await send("Input.dispatchKeyEvent",{type:"keyDown",key:name,code,windowsVirtualKeyCode:virtualKey,
        ...(code === "Enter" ? {text:"\r"} : code === "Space" ? {text:" "} : {})});
      await send("Input.dispatchKeyEvent",{type:"keyUp",key:name,code,windowsVirtualKeyCode:virtualKey});
    };
    for (const width of [360,1440]) {
      for (const agent of ["codex","claude"]) {
        for (const mode of width === 1440 && agent === "codex" ? ["pinned", "preview"] : ["pinned"]) {
        await send("Emulation.setDeviceMetricsOverride",{width,height:800,deviceScaleFactor:1,mobile:false});
        const {frameTree} = await send("Page.getFrameTree");
        await send("Page.setDocumentContent",{frameId:frameTree.frame.id,html:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div>`});
        await evaluate(`window.activityAgent = ${JSON.stringify(agent)}`);
        await evaluate(code);
        const waitFor = async (condition:string) => evaluate(`new Promise((resolve,reject)=>{let remaining=200;function check(){if(${condition})resolve(true);else if(--remaining)setTimeout(check,10);else reject(new Error("fixture condition timed out"));}check();})`);
        const trigger = `document.querySelector(".session-activity-trigger")`;
        const panel = `document.querySelector(".session-activity-popover")`;
        await waitFor(`${trigger} !== null`);
        assert.equal(await evaluate('document.querySelector(".slot-head").draggable'),width>900,"closed slot retains native drag eligibility");
        if (mode === "preview") {
          const position = await evaluate(`(()=>{const r=${trigger}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
          await send("Input.dispatchMouseEvent",{type:"mouseMoved",...position});
          await waitFor(`${panel}?.getAttribute("role") === "tooltip"`);
        }
        await evaluate(`${trigger}.focus()`);
        assert.equal(await evaluate(`document.activeElement === ${trigger}`),true,"keyboard reaches Activity trigger");
        if (mode === "pinned") {
          await key("Enter","Enter",13);
          await waitFor(`${panel} !== null && document.activeElement === ${panel}`);
        }
        assert.equal(await evaluate('document.querySelector(".slot-head").draggable'),false,"open Activity panel prevents native header drag");
        if (mode === "pinned") {
        // Grid labels stretch to the long ID's row height; target the text line itself.
        const label = await evaluate(`(()=>{const element=${panel}.querySelector(".session-activity-label");const range=document.createRange();range.selectNodeContents(element);const r=range.getClientRects()[0];return {left:r.left,right:r.right,y:r.top+r.height/2};})()`);
        await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x:label.left+1,y:label.y});
        await send("Input.dispatchMouseEvent",{type:"mouseMoved",button:"left",buttons:1,x:label.right-1,y:label.y});
        await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x:label.right-1,y:label.y});
        assert.ok((await evaluate("window.getSelection().toString()")).length>0,`${width}px ${agent} ordinary panel text is selectable`);
        assert.equal(await evaluate(`${panel} !== null`),true,"selection preserves pinned popup");
        await evaluate(`window.getSelection().removeAllRanges();${panel}.focus()`);
        }
        await key("Tab","Tab",9);
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"),"Copy Agent-session ID");
        await key("Enter","Enter",13);
        await waitFor("window.copies.length === 1");
        await evaluate("new Promise(resolve => setTimeout(resolve, 200))");
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"),"Copy Agent-session ID",`${mode} pending clipboard write retains keyboard focus`);
        await key("Enter","Enter",13);
        assert.equal(await evaluate("window.copies.length"),1,"pending copy cannot repeat");
        await waitFor(`${panel}.textContent.includes("Copied")`);
        await key("Tab","Tab",9);
        assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"),`Copy ${agent === "codex" ? "Codex" : "Claude"} provider session ID`);
        await key(" ","Space",32);
        await waitFor("window.copies.length === 2");
        assert.deepEqual(await evaluate("window.copies"),await evaluate("[window.activityManagedId,window.activityProviderId]"));
        const layout = await evaluate(`(()=>{const p=${panel};return {panelOverflow:p.scrollWidth-p.clientWidth,buttons:[...p.querySelectorAll(".session-activity-id-copy")].map(b=>({overflow:b.scrollWidth-b.clientWidth,height:b.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(b).lineHeight)}))};})()`);
        assert.ok(layout.panelOverflow<=1,`${width}px full IDs do not overflow the panel`);
        assert.equal(layout.buttons.length,2);
        for(const button of layout.buttons){assert.ok(button.overflow<=1,"ID wraps without horizontal clipping");assert.ok(button.height>button.lineHeight,"long ID is readable over multiple lines");}
        await key("Escape","Escape",27);
        await waitFor(`${panel} === null`);
        assert.equal(await evaluate(`document.activeElement === ${trigger}`),true,"Escape restores Activity trigger focus");
        assert.equal(await evaluate('document.querySelector(".slot-head").draggable'),width>900,"closing Activity restores native header drag");
        assert.deepEqual(await evaluate("window.sessionActions"),[],"selection and clipboard never initiate another session action");
        await evaluate("window.unmountFixture()");
        }
      }
    }
  } finally {
    socket?.close();
    const exited = new Promise<void>(resolve => browser.once("exit",()=>resolve()));
    browser.kill();
    await exited;
    rmSync(temp,{recursive:true,force:true});
  }
});
