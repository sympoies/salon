import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("phone Open action visibly focuses its preview and native Enter/Space open exactly once", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MobileSessionList } from "/src/MobileSessionList.tsx";
    import { makeSession } from "/test/support/fixtures.ts";
    window.opens = [];
    const sessions = [makeSession({id:"first",title:"First session"}),makeSession({id:"second",title:"A long session title that must truncate within the remaining header space"})];
    createRoot(document.querySelector("#root")).render(React.createElement(MobileSessionList,{
      sessions, options:sessions, editingTitleKey:null, beginTitleEdit(){}, saveTitleEdit:async()=>{}, cancelTitleEdit(){},
      onRetitle(){}, onNewSession(){}, onSelectSession(){}, machineColors:{}, reachableMachineNames:new Set(["summit"]),
      activityDeliveryByMachine:new Map(), clockActive:false, resumingKey:null, autoResumePendingKey:null, accountPendingKey:null,
      accountsByProvider:{codex:{},claude:{}}, initialScrollTop:0, onScrollTopChange(){},
      onOpen:key=>window.opens.push(key), onResume(){}, onAutoResume:async()=>true, onAccount:async()=>{}
    }));
  `;
  const bundled = await build({
    configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
      name: "open-focus-fixture",
      resolveId(id) { if (id.endsWith("open-focus-fixture")) return "\0open-focus-fixture"; },
      load(id) { if (id === "\0open-focus-fixture") return fixture; },
    }],
    build: { write: false, minify: false, lib: { entry: "open-focus-fixture", name: "FocusFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = ["styles.css", "sessionCardRows.css"].map(name => readFileSync(join(process.cwd(), "src", name), "utf8")).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "agent-console-open-focus-"));
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
    for (const width of [360,384,412]) {
      await send("Emulation.setDeviceMetricsOverride",{width,height:800,deviceScaleFactor:1,mobile:false});
      const {frameTree} = await send("Page.getFrameTree");
      await send("Page.setDocumentContent",{frameId:frameTree.frame.id,html:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}html,body{margin:0}#root{height:800px}</style><div id="root"></div>`});
      await evaluate(code);
      await evaluate(`new Promise((resolve,reject)=>{let remaining=100;function check(){if(document.querySelector('button[aria-label^="Open "]'))resolve(true);else if(--remaining)setTimeout(check,20);else reject(new Error("card not mounted"));}check();})`);
      const before = await evaluate(`[...document.querySelectorAll('.mobile-session-card')].map(card=>({outline:getComputedStyle(card).outline,previewOutline:getComputedStyle(card.querySelector('.mobile-session-card-open-action')).outline,rect:JSON.stringify(card.getBoundingClientRect().toJSON())}))`);
      // The preview follows the header controls in native tab order.
      for (let step = 0; step < 20; step++) {
        await key("Tab","Tab",9);
        if (await evaluate("document.activeElement?.matches('.mobile-session-card-open-action')")) break;
      }
      const focused = await evaluate(`(()=>{const button=document.querySelector('button[aria-label^="Open "]');return {active:document.activeElement===button,visible:button.matches(':focus-visible'),cards:[...document.querySelectorAll('.mobile-session-card')].map(card=>({outline:getComputedStyle(card).outline,previewOutline:getComputedStyle(card.querySelector('.mobile-session-card-open-action')).outline,rect:JSON.stringify(card.getBoundingClientRect().toJSON())}))}})()`);
      assert.equal(focused.active,true,`${width}px Tab reaches Open`);
      assert.equal(focused.visible,true,`${width}px native keyboard focus uses focus-visible`);
      await key("Enter","Enter",13);
      assert.deepEqual(await evaluate("window.opens"),["summit/first"],`${width}px Enter opens once`);
      await key(" ","Space",32);
      assert.deepEqual(await evaluate("window.opens"),["summit/first","summit/first"],`${width}px Space opens once`);
      assert.notEqual(focused.cards[0].previewOutline,before[0].previewOutline,`${width}px focused Open visibly outlines its preview`);
      assert.equal(focused.cards[0].outline,before[0].outline,`${width}px header/card stays unhighlighted`);
      assert.equal(focused.cards[1].previewOutline,before[1].previewOutline,`${width}px other card is not highlighted`);
      assert.deepEqual(focused.cards.map((card:any)=>card.rect),before.map((card:any)=>card.rect),"focus leaves card geometry unchanged");
      const points = await evaluate(`(()=>{const p=document.querySelector('.mobile-session-card-prompt-open').getBoundingClientRect();const h=document.querySelector('.mobile-session-card-toolbar').getBoundingClientRect();return {preview:[[p.left+2,(p.top+p.bottom)/2],[(p.left+p.right)/2,p.top+2],[(p.left+p.right)/2,(p.top+p.bottom)/2],[p.right-2,(p.top+p.bottom)/2],[(p.left+p.right)/2,p.bottom-2]],header:[[h.left+2,h.top+2],[h.right-2,h.bottom-2]]}})()`);
      await evaluate("window.opens=[]");
      for (const [x,y] of points.header) {
        await send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
        await send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});
      }
      assert.deepEqual(await evaluate("window.opens"),[],`${width}px header padding does not open`);
      for (const [index,[x,y]] of points.preview.entries()) {
        assert.equal(await evaluate(`Boolean(document.elementFromPoint(${x},${y})?.closest('.mobile-session-card-prompt-open'))`),true,`preview padding hit ${x},${y}`);
        await send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
        await send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});
        await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        assert.deepEqual(await evaluate("window.opens"),Array(index+1).fill("summit/first"),`${width}px each preview point opens once`);
      }
      if (width === 384 && process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR) {
        mkdirSync(process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR,{recursive:true});
        const screenshot = await send("Page.captureScreenshot");
        writeFileSync(join(process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR,"session-open-focus-384.png"),Buffer.from(screenshot.data,"base64"));
      }
      await key("Tab","Tab",9);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.mobile-session-card-open-action')).outline"),before[0].previewOutline,"indicator clears when Open loses focus");
      await evaluate("window.opens=[]");
      const titles = await evaluate(`([...document.querySelectorAll('.mobile-session-card-row-one')].map(row=>{
        const trigger=row.querySelector('summary'), label=row.querySelector('.mobile-session-card-title');
        const r=trigger.getBoundingClientRect(), l=label.getBoundingClientRect(), h=row.getBoundingClientRect();
        return {width:r.width,labelWidth:l.width,height:r.height,right:r.right,rowRight:h.right,
          blank:[h.right-2,(r.top+r.bottom)/2],title:[r.left+Math.min(r.width/2,16),(r.top+r.bottom)/2]};
      }))`);
      for (const title of titles) {
        assert.ok(title.width <= Math.max(title.labelWidth+12,32)+1,`${width}px title hit area follows visible label plus 6px inline padding or explicit 32px touch target: ${JSON.stringify(title)}`);
        assert.ok(title.width >= 32 && title.height >= 32,`${width}px title retains minimum touch target`);
        assert.ok(title.right <= title.rowRight+1,`${width}px long title fits header`);
      }
      const click = async ([x,y]:number[]) => {
        await send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
        await send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});
        await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      };
      await click(titles[0].blank);
      assert.equal(await evaluate("Boolean(document.querySelector('.slot-title-menu[open]'))"),false,`${width}px blank title-row space does not open menu`);
      assert.deepEqual(await evaluate("window.opens"),[],`${width}px blank title-row space does not open session`);
      await click(titles[0].title);
      assert.equal(await evaluate("Boolean(document.querySelector('.slot-title-menu[open]'))"),true,`${width}px visible title opens menu`);
      await click(titles[0].title);
      await click(titles[1].title);
      assert.equal(await evaluate("Boolean(document.querySelectorAll('.slot-title-menu')[1].open)"),true,`${width}px truncated title opens menu`);
      await click(titles[1].title);
    }
  } finally {
    socket?.close();
    const exited = new Promise<void>(resolve => browser.once("exit",()=>resolve()));
    browser.kill();
    await exited;
    rmSync(temp,{recursive:true,force:true});
  }
});
