import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("repair icon or compact More action restores keyboard focus after delayed preview cancellation", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { Dashboard } from "/src/Dashboard.tsx";
    window.previewPending = false;
    window.releasePreview = null;
    window.actions = [];
    window.deferMenuInitialFocus = false;
    window.deferredMenuTasks = [];
    const originalSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      // Model a deferred browser task, rather than assuming a zero-delay timer
      // has run when React has only made the menu visible.
      const defer = window.deferMenuInitialFocus && delay === 0;
      if (defer) window.deferredMenuTasks.push(String(callback).slice(0, 160));
      return originalSetTimeout(callback, defer ? 250 : delay, ...args);
    };
    // No real network, terminal session, or native device is used by this fixture.
    window.fetch = async () => { throw new Error("unexpected fixture network request"); };
    const root = createRoot(document.querySelector("#root"));
    window.unmountFixture = () => { window.setTimeout = originalSetTimeout; root.unmount(); };
    root.render(React.createElement(Dashboard, {
      active:true, machines:["fixture"], enabledMachines:["fixture"], machineColors:{},
      onDebug(){}, onUsage(){}, onSettings(){}
    }));
  `;
  const bundled = await build({
    configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
      name: "repair-api-fixture", enforce: "pre",
      resolveId(id, importer) {
        if (id === "./api.ts" && importer?.includes("/src/")) return "\0repair-api-fixture";
      },
      load(id) {
        if (id !== "\0repair-api-fixture") return;
        return `
          export * from "/src/api.ts?fixture-original";
          const response = {ok:true,sessions:[],machines:[{name:"fixture",ok:true}]};
          export const listSessions = async () => {
            if (!window.previewPending) return response;
            return new Promise(resolve => { window.releasePreview = () => resolve(response); });
          };
          export const resetSessionPollRequests = () => {};
          export const listAccounts = async () => ({accounts:[]});
          export const usage = async () => ({providers:[],reachable:false});
          export const fetchLayoutOrder = async () => ({order:[],revision:null,reachable:false,conflict:false});
          export const putLayoutOrder = async order => ({order,revision:null,reachable:false,conflict:false});
          export const resumeSession = async (...args) => { window.actions.push(args); return {ok:true}; };
        `;
      },
    }, {
      name: "repair-focus-fixture",
      resolveId(id) { if (id.endsWith("repair-focus-fixture")) return "\0repair-focus-fixture"; },
      load(id) { if (id === "\0repair-focus-fixture") return fixture; },
    }],
    build: { write: false, minify: false, lib: { entry: "repair-focus-fixture", name: "FocusFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = ["styles.css", "sessionCardRows.css"].map(name => readFileSync(join(process.cwd(), "src", name), "utf8")).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "agent-console-repair-focus-"));
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
      for (const dismissal of ["Cancel", "Escape"]) {
        await send("Emulation.setDeviceMetricsOverride",{width,height:800,deviceScaleFactor:1,mobile:false});
        const {frameTree} = await send("Page.getFrameTree");
        await send("Page.setDocumentContent",{frameId:frameTree.frame.id,html:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div>`});
        await evaluate(code);
        const waitFor = async (condition:string) => evaluate(`new Promise((resolve,reject)=>{let remaining=200;function check(){if(${condition})resolve(true);else if(--remaining)setTimeout(check,10);else reject(new Error("fixture condition timed out"));}check();})`);
        const icon = `document.querySelector('button[aria-label="Check and repair sessions"]')`;
        await waitFor(`${icon} && !${icon}.disabled`);
        await evaluate("window.previewPending = true");
        const opener=width<=760 ? `document.querySelector('.header-menu-trigger')` : icon;
        for(let step=0;step<30 && !await evaluate(`document.activeElement === ${opener}`);step++) await key("Tab","Tab",9);
        assert.equal(await evaluate(`document.activeElement === ${opener}`),true,`${width}px keyboard reaches repair entry`);
        if(width<=760) await evaluate("window.deferMenuInitialFocus = true");
        await key("Enter","Enter",13);
        if(width<=760) {
          await waitFor("document.querySelector('details.header-menu[open]') !== null");
          // Opening details precedes the menu's scheduled initial-focus task.
          // Arrow keys belong to the menu only after that task transfers focus.
          await waitFor("document.querySelector('details.header-menu[open] [role=menu]')?.contains(document.activeElement) === true");
          await evaluate("window.deferMenuInitialFocus = false");
          for(let step=0;step<15 && !await evaluate("document.activeElement.textContent.trim()==='Repair'");step++) await key("ArrowDown","ArrowDown",40);
          const entryState = await evaluate(`({width:${width},dismissal:${JSON.stringify(dismissal)},activeTag:document.activeElement.tagName,activeLabel:document.activeElement.getAttribute('aria-label'),menuOpen:!!document.querySelector('details.header-menu[open]'),deferredTasks:window.deferredMenuTasks})`);
          assert.equal(await evaluate("document.activeElement.textContent.trim()"),"Repair",JSON.stringify(entryState));
          await key("Enter","Enter",13);
        }
        await waitFor("window.releasePreview !== null");
        // Force a genuine browser task boundary while the focused icon is disabled.
        await evaluate("new Promise(resolve => setTimeout(resolve,200))");
        assert.equal(await evaluate(`${icon}.disabled`),true,"preview keeps the icon disabled");
        assert.equal(await evaluate("document.querySelector('[aria-labelledby=repair-session-title]') === null"),true,"confirmation waits for preview");
        await evaluate("window.previewPending = false; window.releasePreview()");
        // Modal's initial-focus effect may run after the dialog enters the DOM.
        await waitFor("document.querySelector('[aria-labelledby=repair-session-title]') !== null && document.activeElement === document.querySelector('[aria-labelledby=repair-session-title]')");
        if (dismissal === "Cancel") {
          await key("Tab","Tab",9);
          assert.equal(await evaluate("document.activeElement.textContent"),"Cancel","Tab reaches Cancel");
          await key("Enter","Enter",13);
        } else {
          await key("Escape","Escape",27);
        }
        await waitFor("document.querySelector('[aria-labelledby=repair-session-title]') === null");
        assert.equal(await evaluate(`document.activeElement === ${opener}`),true,`${width}px ${dismissal} returns keyboard focus to repair entry`);
        assert.equal(await evaluate(`${icon}.disabled`),false,"dismissal re-enables icon");
        assert.deepEqual(await evaluate("window.actions"),[],"dismissal performs no repair action");
        await evaluate("window.unmountFixture()");
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
