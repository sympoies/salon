import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("portaled title-bar status counts are inert while the Repair confirmation blocks the app", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { Dashboard } from "/src/Dashboard.tsx";
    import { MacTitleBar } from "/src/MacTitleBar.tsx";
    window.actions = [];
    // No real network, terminal session, or native device is used by this fixture.
    window.fetch = async () => { throw new Error("unexpected fixture network request"); };
    const titleHost = document.createElement("div");
    document.body.prepend(titleHost);
    const titleRoot = createRoot(titleHost);
    const root = createRoot(document.querySelector("#root"));
    window.unmountFixture = () => { root.unmount(); titleRoot.unmount(); };
    // The entry mounts the title bar before the app, so the counts target exists
    // when the Dashboard first resolves it.
    titleRoot.render(React.createElement(MacTitleBar));
    setTimeout(() => root.render(React.createElement(Dashboard, {
      active:true, machines:["fixture"], enabledMachines:["fixture"], machineColors:{},
      onDebug(){}, onUsage(){}, onSettings(){}
    })), 50);
  `;
  const bundled = await build({
    configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
      name: "title-modal-api-fixture", enforce: "pre",
      resolveId(id, importer) {
        if (id === "./api.ts" && importer?.includes("/src/")) return "\0title-modal-api-fixture";
      },
      load(id) {
        if (id !== "\0title-modal-api-fixture") return;
        return `
          export * from "/src/api.ts?fixture-original";
          const base = {agent:"codex",title:"Fixture",title_revision:0,created_at:"2026-07-06T00:00:00Z",
            cwd:"/workspace/agent-console",repo_name:"agent-console",updated_at:"2026-07-06T00:00:00Z",machine:"fixture"};
          const response = {ok:true,machines:[{name:"fixture",ok:true}],sessions:[
            {...base,id:"stopped-1",session_incarnation:"launch-stopped-1",status:"stopped",resumable:true},
            {...base,id:"running-1",session_incarnation:"launch-running-1",status:"running",turn_state:{schema_version:"agent-session.turn-state.v1",phase:"waiting",phase_changed_at:"2026-07-06T00:00:00Z",revision:1,source:{kind:"runtime",confidence:"authoritative"},last_turn:{completed_at:"2026-07-06T00:00:00Z",outcome:"completed"}}},
          ]};
          export const listSessions = async () => response;
          export const resetSessionPollRequests = () => {};
          export const listAccounts = async () => ({accounts:[]});
          export const usage = async () => ({providers:[],reachable:false});
          export const fetchLayoutOrder = async () => ({order:[],revision:null,reachable:false,conflict:false});
          export const putLayoutOrder = async order => ({order,revision:null,reachable:false,conflict:false});
          export const resumeSession = async (...args) => { window.actions.push(args); return {ok:true}; };
        `;
      },
    }, {
      name: "title-modal-fixture",
      resolveId(id) { if (id.endsWith("title-modal-fixture")) return "\0title-modal-fixture"; },
      load(id) { if (id === "\0title-modal-fixture") return fixture; },
    }],
    build: { write: false, minify: false, lib: { entry: "title-modal-fixture", name: "TitleModalFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = ["styles.css", "sessionCardRows.css"].map(name => readFileSync(join(process.cwd(), "src", name), "utf8")).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "agent-console-title-modal-"));
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
    const waitFor = async (condition:string) => evaluate(`new Promise((resolve,reject)=>{let remaining=200;function check(){if(${condition})resolve(true);else if(--remaining)setTimeout(check,10);else reject(new Error("fixture condition timed out: "+${JSON.stringify(condition)}));}check();})`);
    const clickCount = async (group:string) => {
      const point = await evaluate(`(()=>{const r=document.querySelector('.mac-titlebar [data-status-group="${group}"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
      await send("Input.dispatchMouseEvent",{type:"mousePressed",x:point.x,y:point.y,button:"left",clickCount:1});
      await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:point.x,y:point.y,button:"left",clickCount:1});
    };
    const pressed = `[...document.querySelectorAll('.mac-titlebar [data-status-group]')].map(button => button.getAttribute("aria-pressed"))`;
    const dialog = `document.querySelector('[aria-labelledby=repair-session-title]')`;
    await send("Emulation.setDeviceMetricsOverride",{width:1100,height:800,deviceScaleFactor:1,mobile:false});
    const {frameTree} = await send("Page.getFrameTree");
    await send("Page.setDocumentContent",{frameId:frameTree.frame.id,html:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div>`});
    // Model the native desktop shell: macOS title chrome with portaled status counts.
    await evaluate(`window.__TAURI_INTERNALS__ = {}; document.documentElement.dataset.macTitlebar = "true";`);
    await evaluate(code);
    const icon = `document.querySelector('button[aria-label="Check and repair sessions"]')`;
    await waitFor(`${icon} && !${icon}.disabled && document.querySelectorAll('.mac-titlebar [data-status-group]').length === 4`);
    assert.deepEqual(await evaluate(pressed),["false","false","false","false"],"no filter is active before Repair opens");

    await evaluate(`${icon}.click()`);
    await waitFor(`${dialog} !== null`);
    const planText = await evaluate(`${dialog}.textContent`);
    assert.match(planText,/Check 2 sessions matching the current filters/);
    assert.equal(await evaluate(`${dialog}.getAttribute("aria-modal")`),"true");

    for (const group of ["working","waiting","attention","stopped"]) {
      await clickCount(group);
      assert.deepEqual(await evaluate(pressed),["false","false","false","false"],`clicking the ${group} title-bar count cannot change the filter behind the modal`);
      const hit = await evaluate(`(()=>{const r=document.querySelector('.mac-titlebar [data-status-group="${group}"]').getBoundingClientRect();
        const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit?.closest('.mac-titlebar [data-status-group]') !== null;})()`);
      assert.equal(hit,false,`${group} title-bar count must not receive pointer hits while the confirmation is modal`);
    }
    assert.equal(await evaluate(`${dialog}.textContent`),planText,"the confirmation still describes the plan it will execute");

    await evaluate(`${dialog}.querySelector('.modal-actions .btn:not(.ghost)').click()`);
    await waitFor(`${dialog} === null`);
    assert.deepEqual(await evaluate("window.actions"),[["fixture","stopped-1"]],"confirmation executes the saved plan");
    // The resumed session has no turn state yet, so a "State unknown" count may
    // appear (#873); no count is pressed either way.
    assert.ok((await evaluate(pressed)).every((value: string) => value === "false"),"filter is unchanged after the repair runs");

    // The counts remain usable once no blocking dialog is open.
    await clickCount("stopped");
    await waitFor(`${pressed}.includes("true")`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.mac-titlebar [data-status-group][aria-pressed="true"]')].map(button => button.dataset.statusGroup)`),
      ["stopped"],"title-bar counts filter again after the modal closes");
    await evaluate("window.unmountFixture()");
  } finally {
    socket?.close();
    const exited = new Promise<void>(resolve => browser.once("exit",()=>resolve()));
    browser.kill();
    await exited;
    rmSync(temp,{recursive:true,force:true});
  }
});
