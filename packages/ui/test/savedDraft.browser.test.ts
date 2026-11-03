import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
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
    window.unsupported=false; window.text="Unicode 雪  "; window.deferReads=false; window.pending={};
    window.fetch=async()=>{throw new Error("unexpected network");};
    const root=createRoot(document.querySelector("#root"));
    root.render(React.createElement(React.Fragment,null,
      React.createElement(SessionTitleMenu,{session,options:[],machineColors:{},accounts:[],accountPendingKey:null,currentKey:null,open:false,onOpenChange(){},beginTitleEdit(){},onAccount:async()=>{},onSelect(){},onNewSession(){}}),
      React.createElement(ConversationComposer,{session,machineReachable:true,onBusyChange(){},onVoiceOpenChange(){}})));
    const wait=async f=>{for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,10));}throw new Error("timed out");};
    const button=text=>[...document.querySelectorAll("button")].find(b=>b.textContent===text);
    (async()=>{try{
      await wait(()=>document.querySelector(".saved-draft-marker")&&button("Saved drafts"));
      const result={marker:document.querySelector(".saved-draft-marker").textContent, initialCalls:[...window.calls]};
      button("Saved drafts").click(); await wait(()=>document.querySelector('[aria-label="Saved drafts"] button'));
      result.listCalls=[...window.calls]; document.querySelector('[aria-label="Saved drafts"] button').click();
      await wait(()=>document.querySelector("pre")); result.preview=document.querySelector("pre").textContent;
      button("Restore").click(); await wait(()=>document.querySelector("textarea").value); result.empty=document.querySelector("textarea").value;
      button("Saved drafts").click(); await wait(()=>document.querySelector('[aria-label="Saved drafts"] button'));
      document.querySelector('[aria-label="Saved drafts"] button').click(); await wait(()=>document.querySelector("pre"));
      button("Restore").click(); result.cancel=document.querySelector("textarea").value;
      window.allow=true;window.text="Replacement  ";document.querySelector('[aria-label="Saved drafts"] button').click();
      await wait(()=>document.querySelector("pre").textContent===window.text);button("Restore").click();
      await wait(()=>document.querySelector("textarea").value===window.text);result.replaced=document.querySelector("textarea").value;
      window.text="Earlier preview";button("Saved drafts").click();
      await wait(()=>document.querySelectorAll('[aria-label="Saved drafts"] button').length>=2);
      document.querySelectorAll('[aria-label="Saved drafts"] button')[0].click();await wait(()=>document.querySelector("pre"));
      window.deferReads=true;
      document.querySelectorAll('[aria-label="Saved drafts"] button')[0].click();
      await wait(()=>window.pending["draft-1"]);
      result.oldPreviewHidden=!document.querySelector("pre")&&!button("Restore");
      document.querySelectorAll('[aria-label="Saved drafts"] button')[1].click();
      await wait(()=>window.pending["draft-2"]);
      window.pending["draft-2"]("Selected B");await wait(()=>document.querySelector("pre")?.textContent==="Selected B");
      window.pending["draft-1"]("Earlier A");await new Promise(resolve=>setTimeout(resolve,50));
      result.latestPreview=document.querySelector("pre")?.textContent;
      button("Restore").click();await wait(()=>document.querySelector("textarea").value!=="Replacement  ");
      result.latestRestored=document.querySelector("textarea").value;
      window.pending={};button("Saved drafts").click();await wait(()=>document.querySelector('[aria-label="Saved drafts"] button'));
      document.querySelector('[aria-label="Saved drafts"] button').click();await wait(()=>window.pending["draft-1"]);
      button("Close").click();window.pending["draft-1"]("Closed selection");await new Promise(resolve=>setTimeout(resolve,50));
      button("Saved drafts").click();await wait(()=>document.querySelector('[aria-label="Saved drafts"] button'));
      result.closedPreviewHidden=!document.querySelector("pre")&&!button("Restore");button("Close").click();
      window.unsupported=true;button("Saved drafts").click();await wait(()=>!button("Saved drafts"));
      result.unsupported=!document.querySelector('[role="alert"]');result.calls=[...window.calls];
      const older={...session,stale_draft:undefined};
      root.render(React.createElement(React.Fragment,null,
        React.createElement(SessionTitleMenu,{session:older,options:[],machineColors:{},accounts:[],accountPendingKey:null,currentKey:null,open:false,onOpenChange(){},beginTitleEdit(){},onAccount:async()=>{},onSelect(){},onNewSession(){}}),
        React.createElement(ConversationComposer,{session:older,machineReachable:true,onBusyChange(){},onVoiceOpenChange(){}})));
      await wait(()=>!document.querySelector(".saved-draft-marker"));
      result.absent=!button("Saved drafts")&&!document.querySelector('[role="alert"]');
      parent.document.querySelector("#result").textContent=JSON.stringify(result);
    }catch(e){parent.document.querySelector("#result").textContent=JSON.stringify({error:String(e)});}})();
  `;
  if (process.env.SAVED_DRAFT_CAPTURE) fixture = fixture.replace("(async()=>{try{", "if(false)(async()=>{try{");
  const bundle = await build({ configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
    name: "saved-draft-api", enforce: "pre",
    resolveId(id, importer) { if (importer?.includes("/src/ConversationComposer.tsx") && id === "./api.ts") return "\0saved-api"; },
    load(id) { if (id === "\0saved-api") return `export * from "/src/api.ts?saved-original";
      export const fetchSavedDrafts=async()=>{window.calls.push("list");return window.unsupported?null:[{draft_id:"draft-1",saved_at:"2026-11-01T12:00:00Z",bytes:12},{draft_id:"draft-2",saved_at:"2026-11-01T13:00:00Z",bytes:13}]};
      export const fetchSavedDraftText=async(_machine,_id,draft)=>{window.calls.push("read");return window.deferReads?new Promise(resolve=>{window.pending[draft]=resolve}):window.text};`; },
  }, { name: "saved-fixture", resolveId(id) { if (id.endsWith("saved-fixture")) return "\0saved-fixture"; }, load(id) { if (id === "\0saved-fixture") return fixture; } }],
    build: { write: false, minify: false, lib: { entry: "saved-fixture", name: "Fixture", formats: ["iife"] } } });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = ["styles.css", "sessionCardRows.css"].map(name => readFileSync(join(process.cwd(), "src", name), "utf8")).join("\n");
  const dir = mkdtempSync("/tmp/sd-");
  try {
    for (const width of [384, 1280]) {
      const path = join(dir, `fixture-${width}.html`);
      const frame = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${code}</script>`;
      writeFileSync(path, `<!doctype html><style>body{margin:0}#result{display:none}</style><pre id="result"></pre><iframe style="border:0;width:${width}px;height:800px" srcdoc="${frame.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`);
      const capture = process.env.SAVED_DRAFT_CAPTURE;
      const run = spawnSync(process.env.CHROME_BIN ?? "google-chrome", ["--headless", "--disable-gpu", "--no-sandbox", `--user-data-dir=${dir}/profile`, `--window-size=${Math.max(width, 800)},900`, "--virtual-time-budget=8000", ...(capture ? [`--screenshot=${capture}-${width}.png`] : ["--dump-dom"]), `file://${path}`], { encoding: "utf8", timeout: 30000, env: { ...process.env, TMPDIR: "/tmp" } });
      assert.equal(run.status, 0, run.stderr);
      if (capture) continue;
      const raw = run.stdout.match(/<pre id="result">(.*?)<\/pre>/s)?.[1];
      assert.ok(raw, "the browser finished the interaction fixture");
      const result = JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
      assert.equal(result.error, undefined);
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
      assert.equal(result.unsupported, true);
      assert.equal(result.absent, true);
      assert.deepEqual(result.calls, ["list", "read", "list", "read", "confirm", "read", "confirm", "list", "read", "read", "read", "confirm", "list", "read", "list", "list"]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
