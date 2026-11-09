import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("saved drafts show, read and restore with confirmation without sending", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  let fixture = `
    import React from "react";
    import {createRoot} from "react-dom/client";
    import {ConversationComposer} from "/src/ConversationComposer.tsx";
    import {SessionTitleMenu} from "/src/SessionTitleMenu.tsx";
    const event={event:"stale_draft_stashed",draft_id:"draft-1",session_id:"session-1",saved_at:"2026-11-01T12:00:00Z",bytes:12,cleared:true};
    const session={id:"session-1",machine:"fixture",agent:"codex",status:"running",title:"Example",session_incarnation:"inc-1",stale_draft:event};
    window.calls=[]; window.allow=false; window.confirm=()=>{window.calls.push("confirm");return window.allow;};
    window.unsupported=false; window.text="Unicode 雪  "; window.deferReads=false; window.pending={}; window.settled={};
    window.fetch=async()=>{throw new Error("unexpected network");};
    const root=createRoot(document.querySelector("#root"));
    root.render(React.createElement(React.Fragment,null,
      React.createElement(SessionTitleMenu,{session,options:[],machineColors:{},accounts:[],accountPendingKey:null,currentKey:null,open:false,onOpenChange(){},beginTitleEdit(){},onAccount:async()=>{},onSelect(){},onNewSession(){}}),
      React.createElement(ConversationComposer,{session,machineReachable:true,onBusyChange(){},onVoiceOpenChange(){}})));
    let step="mount saved-draft controls";
    const wait=async(name,f)=>{
      step=name;parent.document.querySelector("#result").dataset.step=step;
      const deadline=performance.now()+10000;
      while(!f()){
        if(performance.now()>=deadline)throw new Error("timed out: "+step);
        await new Promise(r=>setTimeout(r,10));
      }
    };
    // Await the mocked response, then cross a paint boundary before inspecting
    // absence: a stale response must have had a chance to reach React.
    const settle=async(draft,text)=>{
      window.pending[draft](text);
      await wait("settle "+draft+" read",()=>window.settled[draft]);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    };
    const button=text=>[...document.querySelectorAll("button")].find(b=>b.textContent===text);
    (async()=>{try{
      // Click at the first observable commit, before passive mount effects.
      // Timer polling makes that ordering depend on scheduler load (#325).
      let initialCalls;
      const mountedObserver=new MutationObserver(()=>{
        const saved=button("Saved drafts");
        if(saved){mountedObserver.disconnect();initialCalls=[...window.calls];saved.click();}
      });
      mountedObserver.observe(document.querySelector("#root"),{childList:true,subtree:true});
      await wait("mount saved-draft controls",()=>initialCalls&&document.querySelector(".saved-draft-marker"));
      const result={marker:document.querySelector(".saved-draft-marker").textContent, initialCalls};
      await wait("open initial draft list",()=>document.querySelector('[aria-label="Saved drafts"] button'));
      result.listCalls=[...window.calls]; document.querySelector('[aria-label="Saved drafts"] button').click();
      await wait("read initial draft preview",()=>document.querySelector("pre")); result.preview=document.querySelector("pre").textContent;
      button("Restore").click(); await wait("restore into empty composer",()=>document.querySelector("textarea").value); result.empty=document.querySelector("textarea").value;
      button("Saved drafts").click(); await wait("reopen list for confirmation",()=>document.querySelector('[aria-label="Saved drafts"] button'));
      document.querySelector('[aria-label="Saved drafts"] button').click(); await wait("read draft for cancelled restore",()=>document.querySelector("pre"));
      button("Restore").click(); result.cancel=document.querySelector("textarea").value;
      window.allow=true;window.text="Replacement  ";document.querySelector('[aria-label="Saved drafts"] button').click();
      await wait("read replacement preview",()=>document.querySelector("pre")?.textContent===window.text);button("Restore").click();
      await wait("confirm replacement restore",()=>document.querySelector("textarea").value===window.text);result.replaced=document.querySelector("textarea").value;
      window.text="Earlier preview";button("Saved drafts").click();
      await wait("open list for stale-read selection",()=>document.querySelectorAll('[aria-label="Saved drafts"] button').length>=2);
      document.querySelectorAll('[aria-label="Saved drafts"] button')[0].click();await wait("read earlier preview",()=>document.querySelector("pre"));
      window.deferReads=true;
      document.querySelectorAll('[aria-label="Saved drafts"] button')[0].click();
      await wait("start deferred draft-1 read",()=>window.pending["draft-1"]);
      result.oldPreviewHidden=!document.querySelector("pre")&&!button("Restore");
      document.querySelectorAll('[aria-label="Saved drafts"] button')[1].click();
      await wait("start deferred draft-2 read",()=>window.pending["draft-2"]);
      window.pending["draft-2"]("Selected B");await wait("show selected draft-2 preview",()=>document.querySelector("pre")?.textContent==="Selected B");
      await settle("draft-1","Earlier A");
      result.latestPreview=document.querySelector("pre")?.textContent;
      button("Restore").click();await wait("restore selected draft-2",()=>document.querySelector("textarea").value!=="Replacement  ");
      result.latestRestored=document.querySelector("textarea").value;
      window.pending={};window.settled={};button("Saved drafts").click();await wait("reopen list before closing read",()=>document.querySelector('[aria-label="Saved drafts"] button'));
      document.querySelector('[aria-label="Saved drafts"] button').click();await wait("start read before closing",()=>window.pending["draft-1"]);
      button("Close").click();await settle("draft-1","Closed selection");
      button("Saved drafts").click();await wait("reopen closed draft list",()=>document.querySelector('[aria-label="Saved drafts"] button'));
      result.closedPreviewHidden=!document.querySelector("pre")&&!button("Restore");button("Close").click();
      await wait("close draft panel",()=>!document.querySelector('[aria-label="Saved drafts"]'));
      result.restoreCalls=[...window.calls];
      window.deferReads=false;button("Saved drafts").click();
      await wait("reopen list for discard",()=>document.querySelector('[aria-label="Saved drafts"] button'));
      document.querySelector('[aria-label="Saved drafts"] button').click();
      await wait("open draft for discard",()=>button("Discard"));
      window.discardMode="failure";button("Discard").click();
      await wait("show discard error",()=>document.querySelector('[role="alert"]')?.textContent.includes("Could not discard"));
      window.discardMode="unsupported";button("Discard").click();
      await wait("show unsupported discard",()=>document.querySelector('[role="alert"]')?.textContent.includes("unsupported by this runtime"));
      result.discardUnsupported=!!button("Restore")&&!!button("Close")&&button("Discard").disabled;
      root.render(React.createElement(ConversationComposer,{session:{...session,session_incarnation:"inc-2"},machineReachable:true,onBusyChange(){},onVoiceOpenChange(){}}));
      await wait("remount saved drafts",()=>button("Saved drafts")&&!document.querySelector('[aria-label="Saved drafts"]'));
      button("Saved drafts").click();await wait("open list for successful discard",()=>document.querySelector('[aria-label="Saved drafts"] button'));
      document.querySelector('[aria-label="Saved drafts"] button').click();await wait("open draft for successful discard",()=>button("Discard"));
      window.discardMode="success";button("Discard").click();
      await wait("hide last discarded draft",()=>!button("Saved drafts"));
      result.discarded=!document.querySelector("pre")&&!document.querySelector('[aria-label="Saved drafts"]');
      const newDraft={...event,draft_id:"draft-new"};
      root.render(React.createElement(ConversationComposer,{session:{...session,session_incarnation:"inc-2",stale_draft:newDraft},machineReachable:true,onBusyChange(){},onVoiceOpenChange(){}}));
      await wait("show newly saved draft",()=>button("Saved drafts"));
      result.newDraftVisible=true;
      root.render(null);await wait("unmount before unsupported inventory",()=>!button("Saved drafts"));
      root.render(React.createElement(ConversationComposer,{session:{...session,session_incarnation:"inc-3"},machineReachable:true,onBusyChange(){},onVoiceOpenChange(){}}));
      await wait("remount for unsupported inventory",()=>button("Saved drafts"));
      window.unsupported=true;button("Saved drafts").click();await wait("hide unsupported saved drafts",()=>!button("Saved drafts"));
      result.unsupported=!document.querySelector('[role="alert"]');result.calls=[...window.calls];
      const older={...session,stale_draft:undefined};
      root.render(React.createElement(React.Fragment,null,
        React.createElement(SessionTitleMenu,{session:older,options:[],machineColors:{},accounts:[],accountPendingKey:null,currentKey:null,open:false,onOpenChange(){},beginTitleEdit(){},onAccount:async()=>{},onSelect(){},onNewSession(){}}),
        React.createElement(ConversationComposer,{session:older,machineReachable:true,onBusyChange(){},onVoiceOpenChange(){}})));
      await wait("remove absent saved-draft marker",()=>!document.querySelector(".saved-draft-marker"));
      result.absent=!button("Saved drafts")&&!document.querySelector('[role="alert"]');
      parent.document.querySelector("#result").textContent=JSON.stringify(result);
    }catch(e){parent.document.querySelector("#result").textContent=JSON.stringify({error:step+": "+String(e)});}})();
  `;
  if (process.env.SAVED_DRAFT_CAPTURE) fixture = fixture.replace("(async()=>{try{", "if(false)(async()=>{try{");
  const bundle = await build({ configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
    name: "saved-draft-api", enforce: "pre",
    resolveId(id, importer) { if (importer?.includes("/src/ConversationComposer.tsx") && id === "./api.ts") return "\0saved-api"; },
    load(id) { if (id === "\0saved-api") return `export * from "/src/api.ts?saved-original";
      export const fetchSavedDrafts=async()=>{window.calls.push("list");return window.unsupported?null:[{draft_id:"draft-1",saved_at:"2026-11-01T12:00:00Z",bytes:12},{draft_id:"draft-2",saved_at:"2026-11-01T13:00:00Z",bytes:13}]};
      export const discardSavedDraft=async()=>{if(window.discardMode==="unsupported")return null;if(window.discardMode==="failure")throw Error("failed");return {remaining:0,stale_draft:null}};
      export const fetchSavedDraftText=async(_machine,_id,draft)=>{window.calls.push("read");return window.deferReads?new Promise(resolve=>{window.settled[draft]=false;window.pending[draft]=text=>{resolve(text);queueMicrotask(()=>{window.settled[draft]=true;});}}):window.text};`; },
  }, { name: "saved-fixture", resolveId(id) { if (id.endsWith("saved-fixture")) return "\0saved-fixture"; }, load(id) { if (id === "\0saved-fixture") return fixture; } }],
    build: { write: false, minify: false, lib: { entry: "saved-fixture", name: "Fixture", formats: ["iife"] } } });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = ["styles.css", "sessionCardRows.css"].map(name => readFileSync(join(process.cwd(), "src", name), "utf8")).join("\n");
  const dir = mkdtempSync("/tmp/sd-");
  const browser = spawn(process.env.CHROME_BIN ?? "google-chrome", [
    "--headless", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0",
    `--user-data-dir=${dir}/profile`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: "/tmp" } });
  let socket: WebSocket | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("timed out: start Chrome debugging")), 10_000);
      browser.stderr.on("data", data => {
        stderr += String(data);
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]!); }
      });
      browser.once("error", error => { clearTimeout(timeout); reject(error); });
      browser.once("exit", () => { clearTimeout(timeout); reject(new Error("Chrome exited before debugging was ready")); });
    });
    const targets = await (await fetch(new URL("/json/list", endpoint.replace("ws:", "http:")), {signal:AbortSignal.timeout(10_000)})).json() as Array<{type:string;webSocketDebuggerUrl:string}>;
    const target = targets.find(item => item.type === "page"); assert.ok(target, "Chrome provides a fixture page");
    const connection = new WebSocket(target.webSocketDebuggerUrl);
    socket = connection;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out: connect Chrome debugging")), 10_000);
      connection.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      connection.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Chrome debugging connection failed")); }, { once: true });
    });
    let nextId = 0;
    const pending = new Map<number, {resolve:(result:any)=>void;reject:(error:Error)=>void}>();
    connection.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data)), waiter = pending.get(reply.id);
      if (waiter) {
        pending.delete(reply.id);
        reply.error ? waiter.reject(new Error(reply.error.message)) : waiter.resolve(reply.result);
      }
    });
    connection.addEventListener("close", () => {
      for (const waiter of pending.values()) waiter.reject(new Error("Chrome debugging connection closed"));
      pending.clear();
    });
    const send = (method:string, params:object = {}) => new Promise<any>((resolve, reject) => {
      if (connection.readyState !== WebSocket.OPEN) return reject(new Error("Chrome debugging connection unavailable: " + method));
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error("timed out: " + method)); }, 90_000);
      pending.set(id, {
        resolve(result) { clearTimeout(timeout); resolve(result); },
        reject(error) { clearTimeout(timeout); reject(error); },
      });
      connection.send(JSON.stringify({id, method, params}));
    });
    const evaluate = async (expression:string) => {
      const result = await send("Runtime.evaluate", {expression, awaitPromise:true, returnByValue:true});
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description ?? "browser script completes");
      return result.result.value;
    };
    for (const width of [384, 1280]) {
      const frame = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${code}</script>`;
      const html = `<!doctype html><style>body{margin:0}#result{display:none}</style><pre id="result"></pre><iframe style="border:0;width:${width}px;height:800px" srcdoc="${frame.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`;
      const capture = process.env.SAVED_DRAFT_CAPTURE;
      await send("Emulation.setDeviceMetricsOverride", {width:Math.max(width, 800), height:900, deviceScaleFactor:1, mobile:false});
      const { frameTree } = await send("Page.getFrameTree");
      await send("Page.setDocumentContent", {frameId:frameTree.frame.id, html});
      if (capture) {
        await evaluate(`new Promise((resolve,reject)=>{
          const frame=document.querySelector("iframe");
          const deadline=performance.now()+10000;
          const check=()=>{
            if(frame.contentDocument.querySelector(".saved-draft-marker"))return resolve();
            if(performance.now()>=deadline)return reject(Error("timed out: mount capture controls"));
            setTimeout(check,10);
          };check();
        })`);
        await evaluate(`new Promise((resolve,reject)=>{
          const doc=document.querySelector("iframe").contentDocument;
          const deadline=performance.now()+10000;
          const wait=(condition,action)=>{if(condition())return action();if(performance.now()>deadline)return reject(Error("capture timed out"));setTimeout(()=>wait(condition,action),10)};
          [...doc.querySelectorAll("button")].find(b=>b.textContent==="Saved drafts").click();
          wait(()=>doc.querySelector('[aria-label="Saved drafts"] button'),()=>{
            doc.querySelector('[aria-label="Saved drafts"] button').click();
            wait(()=>[...doc.querySelectorAll("button")].some(b=>b.textContent==="Discard"),resolve);
          });
        })`);
        const screenshot = await send("Page.captureScreenshot", {format:"png"});
        writeFileSync(`${capture}-${width}.png`, Buffer.from(screenshot.data, "base64"));
        continue;
      }
      // Keep the browser on its real clock: virtual timers can outrun React's
      // MessageChannel work under load even when no product operation is slow.
      const result = await evaluate(`new Promise((resolve,reject)=>{
        const output=document.querySelector("#result");
        const timeout=setTimeout(()=>{
          observer.disconnect();reject(Error("timed out: "+(output.dataset.step||"load fixture")));
        },60000);
        const observer=new MutationObserver(check);
        function check(){if(output.textContent){clearTimeout(timeout);observer.disconnect();resolve(JSON.parse(output.textContent));}}
        observer.observe(output,{childList:true,characterData:true,subtree:true});check();
      })`);
      assert.ok(result, "the browser finished the interaction fixture");
      assert.equal(result.error, undefined, `${width}px: ${result.error ?? "interaction completes"}`);
      assert.match(result.marker, /Saved draft/);
      assert.deepEqual(result.initialCalls, []);
      assert.deepEqual(result.listCalls, ["list"]);
      assert.equal(result.preview, "Unicode 雪  ");
      assert.equal(result.empty, "Unicode 雪  ");
      assert.equal(result.cancel, "Unicode 雪  ");
      assert.equal(result.replaced, "Replacement  ");
      assert.equal(result.oldPreviewHidden, true);
      assert.equal(result.latestPreview, "Selected B");
      assert.equal(result.latestRestored, "Selected B");
      assert.equal(result.closedPreviewHidden, true);
      assert.deepEqual(result.restoreCalls, ["list", "read", "list", "read", "confirm", "read", "confirm", "list", "read", "read", "read", "confirm", "list", "read", "list"]);
      assert.equal(result.discardUnsupported, true);
      assert.equal(result.discarded, true);
      assert.equal(result.newDraftVisible, true);
      assert.equal(result.unsupported, true);
      assert.equal(result.absent, true);
    }
  } finally {
    socket?.close();
    if (browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise<void>(resolve => browser.once("exit", () => resolve()));
      browser.kill("SIGKILL"); await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
