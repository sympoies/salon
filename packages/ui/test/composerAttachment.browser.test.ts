import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("composer attachments preserve the delivered text and restore as chips", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  let fixture = `
    import React from "react";
    import {createRoot} from "react-dom/client";
    import {ConversationComposer} from "/src/ConversationComposer.tsx";
    const saved={event:"stale_draft_stashed",draft_id:"draft-1",session_id:"session-1",saved_at:"2026-11-01T12:00:00Z",bytes:12,cleared:true};
    const session={id:"session-1",machine:"fixture",agent:"codex",status:"running",title:"Example",session_incarnation:"inc-1",stale_draft:saved};
    window.calls=[]; window.confirm=()=>true; window.fetch=async()=>{throw Error("unexpected network")};
    const root=createRoot(document.querySelector("#root"));
    const wait=async(f)=>{const end=Date.now()+2000;while(!f()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));};
    const button=label=>document.querySelector('[aria-label="'+label+'"]');
    const textButton=label=>[...document.querySelectorAll('button')].find(b=>b.textContent===label);
    const type=text=>{const el=document.querySelector('textarea');el.focus();el.setSelectionRange(el.value.length,el.value.length);document.execCommand('insertText',false,text);};
    const mount=async()=>{root.render(React.createElement(ConversationComposer,{session,machineReachable:true,onBusyChange(){},onVoiceOpenChange(){}}));await wait(()=>document.querySelector('textarea'));};
    const upload=async(name)=>{const input=document.querySelector('input[type=file]');const dt=new DataTransfer();dt.items.add(new File(['hello'],name,{type:'text/plain'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,150));};
    (async()=>{try{
      await mount(); await upload('example.txt');
      if (window.captureOnly) { parent.document.querySelector('#result').textContent='ready'; return; }
      const result={uploadChip:!!button('Remove example.txt'),uploadText:document.querySelector('textarea').value};
      type('hello'); await new Promise(r=>setTimeout(r,30)); button('Send reply')?.click();await wait(()=>window.calls.length);result.sent=window.calls.at(-1)?.text;
      await upload('remove.txt');button('Remove remove.txt')?.focus();button('Remove remove.txt')?.click();result.focus=document.activeElement===document.querySelector('textarea');type('remaining');await new Promise(r=>setTimeout(r,30));button('Send reply')?.click();await wait(()=>window.calls.length>=2);result.removed=window.calls.at(-1)?.text;
      await upload('only.txt');button('Send reply')?.click();await wait(()=>window.calls.length>=3);result.only=window.calls.at(-1)?.text;await wait(()=>!button('Send reply'));
      const imageTransfer=new DataTransfer();imageTransfer.items.add(new File(['image'],'image.png',{type:'image/png'}));
      document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:imageTransfer}));await wait(()=>button('Remove image.png'));
      await wait(()=>document.querySelector('.composer-attachment img'));result.thumbnail=!!document.querySelector('.composer-attachment img');
      const dropTransfer=new DataTransfer();dropTransfer.items.add(new File(['document'],'document.txt',{type:'text/plain'}));
      document.querySelector('footer').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dropTransfer}));await wait(()=>button('Remove document.txt'));
      result.drop=!!button('Remove document.txt');result.size=document.querySelector('[aria-label="Attachment document.txt"]')?.textContent.includes('8 B');
      button('Remove image.png')?.click();button('Remove document.txt')?.click();
      textButton('Saved drafts').click();await wait(()=>document.querySelector('[aria-label="Saved drafts"] button'));document.querySelector('[aria-label="Saved drafts"] button').click();await wait(()=>textButton('Restore'));textButton('Restore').click();await new Promise(r=>setTimeout(r,100));result.restored=!!button('Remove saved.txt');result.restoreText=document.querySelector('textarea').value;
      parent.document.querySelector('#result').textContent=JSON.stringify(result);
    }catch(e){parent.document.querySelector('#result').textContent=JSON.stringify({error:String(e)});}})();
  `;
  if (process.env.COMPOSER_CAPTURE) fixture = "window.captureOnly=true;\n" + fixture;
  const bundle = await build({ configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
    name: "saved-draft-api", enforce: "pre",
    resolveId(id, importer) { if (importer?.includes("/src/ConversationComposer.tsx") && id === "./api.ts") return "\0saved-api"; if (importer?.includes("/src/ConversationComposer.tsx") && id === "./sharedOutboxClient.ts") return "\0composer-shared"; },
    load(id) {
      if (id === "\0composer-shared") return `const client={targets:()=>[],outgoingItems:()=>[],enqueue:async(_session,text,attachments)=>{window.calls.push({text,attachments})}};export const useSharedOutbox=()=>client;export const usesSharedOutbox=()=>true;`;
      if (id === "\0saved-api") return `export * from "/src/api.ts?saved-original";
        export const uploadAttachment=async(_machine,id,file)=>{return {ok:true,path:'/state/sessions/'+id+'/attachments/'+file.name,original_name:file.name,bytes:file.size}};
        export const fetchSavedDrafts=async()=>[{draft_id:'draft-1',saved_at:'2026-11-01T12:00:00Z',bytes:12}];
        export const fetchSavedDraftText=async()=>"'/state/sessions/session-1/attachments/saved.txt'\\n\\nhello";
        export const discardSavedDraft=async()=>null;`;
    },
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
    const observations = [];
    for (const [width, theme] of [[384, "dark"], [384, "paper"], [1280, "dark"], [1280, "paper"]] as const) {
      const frame = `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${code}</script>`;
      const html = `<!doctype html><style>body{margin:0;overflow:hidden}#result{display:none}iframe{display:block}</style><pre id="result"></pre><iframe style="border:0;width:${width}px;height:${width === 384 ? 832 : 900}px" srcdoc="${frame.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`;
      const capture = process.env.COMPOSER_CAPTURE;
      await send("Emulation.setDeviceMetricsOverride", {width, height:width === 384 ? 832 : 900, deviceScaleFactor:1, mobile:false});
      const { frameTree } = await send("Page.getFrameTree");
      await send("Page.setDocumentContent", {frameId:frameTree.frame.id, html});
      if (capture) {
        await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+10000;const check=()=>{if(document.querySelector("#result").textContent)return resolve();if(Date.now()>end)return reject(Error("capture timed out"));setTimeout(check,20)};check()})`);
        const screenshot = await send("Page.captureScreenshot", {format:"png"});
        writeFileSync(`${capture}-${width}-${theme}.png`, Buffer.from(screenshot.data, "base64"));
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
      observations.push({width, theme, ...result});
    }
    for (const {width, theme, ...result} of observations) {
      assert.deepEqual(result, {
        uploadChip: true, uploadText: "", sent: "'/state/sessions/session-1/attachments/example.txt'\nhello",
        focus: true, removed: "remaining", only: "'/state/sessions/session-1/attachments/only.txt'",
        thumbnail: true, drop: true, size: true, restored: true, restoreText: "hello",
      }, `${width} ${theme}`);
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
