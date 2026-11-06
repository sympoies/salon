import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

// A real conversation view, with a synthetic daemon refusal and no file access.
test("image refusals and external links fit phone and desktop conversations",async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const bundled = await build({configFile:false,logLevel:"silent",resolve:{conditions:["source"]},
    define:{"process.env.NODE_ENV":JSON.stringify("production")},plugins:[react(),{
      name:"image-refusal-fixture",
      resolveId(id) { if (id.endsWith("image-refusal-fixture")) return "\0image-refusal-fixture"; },
      load(id) {
        if (id !== "\0image-refusal-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {HistoryConversationView} from '/src/HistoryConversation.tsx';
          const requests=[];const external=window.externalImages;const count=external?6:1;
          window.fetch=async path=>{requests.push(path);return new Response(JSON.stringify({ok:false,error:{
            code:'history-image-unavailable',...(external?{}:{reason:'outside-allowed-roots'})}}),{status:422})};
          window.IntersectionObserver=class{constructor(cb){this.cb=cb}observe(){this.cb([{isIntersecting:true}])}disconnect(){}};
          createRoot(document.querySelector('#root')).render(React.createElement(HistoryConversationView,{
            conversation:{session:{id:'sample',machine:'fixture',provider:'codex'},
              messages:[{id:'reply',role:'assistant',text:external?Array.from({length:count},(_,i)=>'![](https://images.example.invalid/chart-'+i+'.png)').join(' '):'![](/restricted/mock.png)',
                images:Array.from({length:count},(_,i)=>({id:'a'.repeat(16)+'.0.'+i+'.'+'b'.repeat(32),origin:external?'tool_result':undefined}))}],
              latestMessagePaging:true,loading:false,viewportRef:{current:null}},onJumpToLatest(){}}));
          const inspect=()=>{
            const statuses=[...document.querySelectorAll('.conversation-image-thumbnail [role=status]')];
            if(statuses.length!==count || statuses.some(s=>s.textContent==='Loading image…')){setTimeout(inspect,10);return}
            const status=statuses[0],button=status.closest('.conversation-image-thumbnail'),s=status.getBoundingClientRect(),b=button.getBoundingClientRect();
            const links=[...document.querySelectorAll('.conversation-image-thumbnail a')];
            parent.document.querySelector('#result').textContent=JSON.stringify({external,text:status.textContent,statuses:statuses.map(s=>s.textContent),links:links.map(a=>a.href),
              linksFit:links.every(a=>{const r=a.getBoundingClientRect(),b=a.closest('.conversation-image-thumbnail').getBoundingClientRect();return r.left>=b.left && r.right<=b.right && r.top>=b.top && r.bottom<=b.bottom}),
              privatePathVisible:document.querySelector('#root').innerHTML.includes('/restricted/'),requests,width:innerWidth,
              fits:s.left>=b.left && s.right<=b.right && s.top>=b.top && s.bottom<=b.bottom,
              overflow:document.documentElement.scrollWidth>innerWidth});
          };inspect();`;
      },
    }],build:{write:false,minify:false,target:"esnext",lib:{entry:"image-refusal-fixture",name:"ImageRefusalFixture",formats:["iife"]}}});
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = ["styles.css","ConversationImages.css"].map(name => readFileSync(new URL(`../src/${name}`,import.meta.url),"utf8")).join("\n");
  const temp = mkdtempSync(join(tmpdir(),"image-refusal-"));
  const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  const measurements: Array<{external:boolean;statuses:string[];links:string[];linksFit:boolean;text:string;privatePathVisible:boolean;requests:string[];width:number;fits:boolean;overflow:boolean}> = [];
  try {
    for (const external of [false,true]) for (const width of [390,600,601,1280]) {
      const frame = `<!doctype html><html data-theme="dark"><style>${css}html,body{margin:0}#root{height:800px}</style><div id="root"></div><script>window.externalImages=${external};${code}</script></html>`;
      const file = join(temp,`refusal-${external ? "remote" : "local"}-${width}.html`);
      writeFileSync(file,`<!doctype html><style>body{margin:0}iframe{border:0;display:block}</style><pre id="result" style="display:none"></pre>
        <iframe width="${width}" height="800"></iframe><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<","\\u003c")}</script>`);
      if (evidence) mkdirSync(evidence,{recursive:true});
      const browser = spawnSync(process.env.CHROME_BIN ?? "google-chrome",["--headless","--disable-gpu","--no-sandbox","--hide-scrollbars","--allow-file-access-from-files",
        `--window-size=${Math.max(800,width)},900`,"--virtual-time-budget=5000",...(evidence ? [`--screenshot=${join(evidence,`refusal-${external ? "remote" : "local"}-${width}.png`)}`] : []),"--dump-dom",`file://${file}`],
      {encoding:"utf8",timeout:20000});
      assert.equal(browser.status,0,browser.error?.message ?? browser.stderr);
      const json = browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1];
      assert.ok(json,"conversation publishes its loaded fallback");
      const measured = JSON.parse(json.replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">"));
      assert.equal(measured.width,width);
      if (evidence) writeFileSync(join(evidence,`refusal-${external ? "remote" : "local"}-${width}.json`),JSON.stringify(measured,null,2));
      measurements.push(measured);
    }
    for (const measured of measurements) {
      assert.equal(measured.text,measured.external ? "External image, not loaded · https://images.example.invalid" : "Not shared: outside the session folder · mock.png",`${measured.width}px fallback`);
      assert.equal(measured.linksFit,true);
      assert.equal(measured.statuses.length,measured.external ? 6 : 1);
      assert.deepEqual(measured.links,measured.external ? Array.from({length:6},(_,i) => `https://images.example.invalid/chart-${i}.png`) : []);
      assert.equal(measured.privatePathVisible,false);
      assert.equal(measured.fits,true,`${measured.width}px fallback fits the thumbnail`);
      assert.equal(measured.overflow,false);
      assert.deepEqual([...measured.requests].sort(),Array.from({length:measured.external ? 6 : 1},(_,i) => `/api/history/sessions/fixture/sample/images/${"a".repeat(16)}.0.${i}.${"b".repeat(32)}`).sort());
    }
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
