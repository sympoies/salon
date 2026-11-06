import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

// Frozen nils-cli 7beccf32 shape, with a synthetic valid opaque selector.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/history-image-descriptor-v1.json", import.meta.url), "utf8"));

test("image-block path menu copies the supplied path without overflowing the conversation", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const bundled = await build({
    resolve:{conditions:["source"]}, configFile:false, logLevel:"silent",
    define:{"process.env.NODE_ENV":JSON.stringify("production")},
    plugins:[react(), {
      name:"image-path-fixture",
      resolveId(id) { if (id.endsWith("image-path-fixture")) return "\0image-path-fixture"; },
      load(id) {
        if (id !== "\0image-path-fixture") return;
        return `import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {HistoryConversationView} from '/src/HistoryConversation.tsx';
          import {listHistoryMessages} from '/src/api.ts';
          import '/src/styles.css';
          const fixture=${JSON.stringify(fixture)};
          const canvas=document.createElement('canvas');canvas.width=480;canvas.height=240;
          const ctx=canvas.getContext('2d');ctx.fillStyle='#164e63';ctx.fillRect(0,0,480,240);
          ctx.fillStyle='white';ctx.font='24px sans-serif';ctx.fillText('Synthetic attachment',24,128);
          const png=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
          const requests=[],writes=[];
          window.IntersectionObserver=class {constructor(callback){this.callback=callback}observe(){this.callback([{isIntersecting:true}])}disconnect(){}};
          window.fetch=async path=>{requests.push(String(path));return String(path).includes('/images/')
            ? new Response(png,{headers:{'content-type':'image/png','content-disposition':'inline; filename="photo 1.png"'}})
            : new Response(JSON.stringify({ok:true,data:{messages:[{id:'message-1',role:'user',text:'Synthetic caption',...fixture}]}}),{headers:{'content-type':'application/json'}})};
          const wait=condition=>new Promise((resolve,reject)=>{let attempts=200;function check(){if(condition())resolve();else if(--attempts)setTimeout(check,10);else reject(Error('fixture did not settle'));}check()});
          void (async()=>{try {
            const page=await listHistoryMessages('fixture','history');
            createRoot(document.querySelector('#root')).render(React.createElement(HistoryConversationView,{
              conversation:{session:{machine:'fixture',id:'history'},messages:page.messages,latestMessagePaging:true,loading:false,viewportRef:{current:null}},onJumpToLatest(){}}));
            await wait(()=>document.querySelector('.conversation-image-thumbnail img')?.naturalWidth);
          window.__TAURI_INTERNALS__={invoke:async(command,args)=>{if(command==='write_macos_clipboard_text')writes.push(args.text)}};
            const openMenu=()=>document.querySelector('.conversation-image-thumbnail').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-20,clientY:180}));
            openMenu();await wait(()=>document.querySelector('[role=menu]'));
            const buttons=()=>[...document.querySelectorAll('[role=menuitem]')];
            const copy=buttons().find(button=>button.textContent==='Copy file path');
            if(copy){copy.click();await wait(()=>writes.length===1);openMenu();await wait(()=>document.querySelector('[role=menu]'));}
            const menu=document.querySelector('[role=menu]').getBoundingClientRect();
            window.publishFixtureResult({items:buttons().map(b=>b.textContent),writes,requests,viewportWidth:innerWidth,
              focused:document.activeElement?.textContent,menu:{left:menu.left,right:menu.right,bottom:menu.bottom},
              overflow:document.documentElement.scrollWidth>innerWidth});
          }catch(error){window.publishFixtureResult({error:String(error)})}})();`;
      },
    }],
    build:{write:false,minify:false,target:"esnext",lib:{entry:"image-path-fixture",name:"ImagePathFixture",formats:["iife"]}},
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "conversation-image-path-"));
  const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  try {
    for (const width of [384,1280]) {
      const frame = `<!doctype html><style>${css}body{margin:0;padding:16px}</style><div id="root"></div><script>
        window.publishFixtureResult=value=>parent.postMessage({type:'image-path-result',json:JSON.stringify(value)},'*');
        window.onerror=message=>window.publishFixtureResult({error:String(message)});${code.replaceAll("</script", "<\\/script")}</script>`;
      const file = join(temp,`fixture-${width}.html`);
      writeFileSync(file,`<!doctype html><style>body{margin:0}iframe{border:0}</style><iframe width="${width}" height="900"></iframe>
        <pre id="result" style="display:none"></pre><script>const frame=document.querySelector('iframe');
        window.addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.data?.type==='image-path-result')document.querySelector('#result').textContent=event.data.json});
        frame.srcdoc=${JSON.stringify(frame).replaceAll("<", "\\u003c")}</script>`);
      if (evidence) mkdirSync(evidence,{recursive:true});
      const browser = spawnSync(process.env.CHROME_BIN ?? "google-chrome",[
        "--headless","--disable-gpu","--no-sandbox","--hide-scrollbars","--allow-file-access-from-files",
        `--window-size=${Math.max(width,800)},920`,"--virtual-time-budget=5000",
        ...(evidence ? [`--screenshot=${join(evidence,`image-path-${width}.png`)}`] : []),"--dump-dom",`file://${file}`,
      ],{encoding:"utf8",timeout:20000,maxBuffer:16*1024*1024});
      assert.equal(browser.status,0, browser.error?.message ?? browser.stderr);
      const json = browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1];
      assert.ok(json,"browser fixture publishes its result");
      const result = JSON.parse(json.replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">"));
      if (evidence) writeFileSync(join(evidence,`image-path-${width}.json`),JSON.stringify(result,null,2)+"\n");
      await t.test(`${width} x 900`, () => {
        assert.equal(result.error,undefined);
        assert.equal(result.viewportWidth,width);
        assert.equal(result.overflow,false);
        assert.ok(result.menu.left >= 0 && result.menu.right <= width && result.menu.bottom <= 900);
        assert.equal(result.focused,"Copy image");
        assert.ok(result.items.includes("Copy file path"),"image-block history exposes the supplied path");
        assert.deepEqual(result.writes,[fixture.images[0].upload_path]);
        assert.ok(result.requests.filter((path: string) => path.includes('/images/')).every((path: string) => path.endsWith(fixture.images[0].id)),"bytes use only the opaque selector");
      });
    }
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
