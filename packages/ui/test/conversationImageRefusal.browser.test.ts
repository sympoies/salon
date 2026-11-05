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
test("outside-folder image fallback fits phone and desktop conversations",async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const bundled = await build({configFile:false,logLevel:"silent",resolve:{conditions:["source"]},
    define:{"process.env.NODE_ENV":JSON.stringify("production")},plugins:[react(),{
      name:"image-refusal-fixture",
      resolveId(id) { if (id.endsWith("image-refusal-fixture")) return "\0image-refusal-fixture"; },
      load(id) {
        if (id !== "\0image-refusal-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {HistoryConversationView} from '/src/HistoryConversation.tsx';
          const requests=[];
          window.fetch=async path=>{requests.push(path);return new Response(JSON.stringify({ok:false,error:{
            code:'history-image-unavailable',reason:'outside-allowed-roots'}}),{status:422})};
          window.IntersectionObserver=class{constructor(cb){this.cb=cb}observe(){this.cb([{isIntersecting:true}])}disconnect(){}};
          createRoot(document.querySelector('#root')).render(React.createElement(HistoryConversationView,{
            conversation:{session:{id:'sample',machine:'fixture',provider:'codex'},
              messages:[{id:'reply',role:'assistant',text:'![](/restricted/mock.png)',
                images:[{id:'a'.repeat(16)+'.0.0.'+'b'.repeat(32)}]}],
              latestMessagePaging:true,loading:false,viewportRef:{current:null}},onJumpToLatest(){}}));
          const inspect=()=>{
            const status=document.querySelector('.conversation-image-thumbnail [role=status]');
            if(!status || status.textContent==='Loading image…'){setTimeout(inspect,10);return}
            const button=status.closest('button'),s=status.getBoundingClientRect(),b=button.getBoundingClientRect();
            parent.document.querySelector('#result').textContent=JSON.stringify({text:status.textContent,
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
  const measurements: Array<{text:string;privatePathVisible:boolean;requests:string[];width:number;fits:boolean;overflow:boolean}> = [];
  try {
    for (const width of [390,600,601,1280]) {
      const frame = `<!doctype html><html data-theme="dark"><style>${css}html,body{margin:0}#root{height:800px}</style><div id="root"></div><script>${code}</script></html>`;
      const file = join(temp,`refusal-${width}.html`);
      writeFileSync(file,`<!doctype html><style>body{margin:0}iframe{border:0;display:block}</style><pre id="result" style="display:none"></pre>
        <iframe width="${width}" height="800"></iframe><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<","\\u003c")}</script>`);
      if (evidence) mkdirSync(evidence,{recursive:true});
      const browser = spawnSync(process.env.CHROME_BIN ?? "google-chrome",["--headless","--disable-gpu","--no-sandbox","--hide-scrollbars","--allow-file-access-from-files",
        `--window-size=${Math.max(800,width)},900`,"--virtual-time-budget=5000",...(evidence ? [`--screenshot=${join(evidence,`refusal-${width}.png`)}`] : []),"--dump-dom",`file://${file}`],
      {encoding:"utf8",timeout:20000});
      assert.equal(browser.status,0,browser.error?.message ?? browser.stderr);
      const json = browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1];
      assert.ok(json,"conversation publishes its loaded fallback");
      const measured = JSON.parse(json.replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">"));
      assert.equal(measured.width,width);
      if (evidence) writeFileSync(join(evidence,`refusal-${width}.json`),JSON.stringify(measured,null,2));
      measurements.push(measured);
    }
    for (const measured of measurements) {
      assert.equal(measured.text,"Not shared: outside the session folder · mock.png",`${measured.width}px fallback`);
      assert.equal(measured.privatePathVisible,false);
      assert.equal(measured.fits,true,`${measured.width}px fallback fits the thumbnail`);
      assert.equal(measured.overflow,false);
      assert.deepEqual(measured.requests,[`/api/history/sessions/fixture/sample/images/${"a".repeat(16)}.0.0.${"b".repeat(32)}`]);
    }
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
