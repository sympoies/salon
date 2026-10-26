import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

// Real component and CSS; raster bytes are generated locally, with no live data.
test("image-only messages shrink to previews and contain readable metadata", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const bundled = await build({
    resolve:{conditions:["source"]}, configFile:false, logLevel:"silent", define:{"process.env.NODE_ENV":JSON.stringify("production")},
    plugins:[react(),{
      name:"image-bubble-fixture",
      resolveId(id) { if (id.endsWith("image-bubble-fixture")) return "\0image-bubble-fixture"; },
      load(id) {
        if (id !== "\0image-bubble-fixture") return;
        return `import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {HistoryConversationView} from '/src/HistoryConversation.tsx';
          const sizes=[[1600,600],[600,1000],[32,24]];
          const blobs=sizes.map(([w,h],i)=>{
            const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
            const c=canvas.getContext('2d');c.fillStyle=['#f8fafc','#172554','#166534'][i];c.fillRect(0,0,w,h);
            c.fillStyle=i===0?'#172554':'white';c.font='40px sans-serif';c.fillText('Synthetic screenshot — full width',24,60);
            for(let x=24;x<w;x+=180)c.fillRect(x,100,120,12);
            return new Blob([Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0))],{type:'image/png'});
          });
          window.IntersectionObserver=class {constructor(callback){this.callback=callback}
            observe(){this.callback([{isIntersecting:true}])}disconnect(){}};
          window.fetch=async path=>new Response(blobs[Number(path.split('/').pop().split('.')[2])],{headers:{'content-type':'image/png'}});
          const image=i=>({id:'a'.repeat(16)+'.0.'+i+'.'+'b'.repeat(32)});
          const messages=[
            {id:'landscape',role:'user',text:'',images:[image(0)]},
            {id:'portrait',role:'user',text:'',images:[image(1)]},
            {id:'mixed',role:'user',text:'Synthetic caption wider than a tiny image',images:[image(2)]},
          ].map(m=>({...m,timestamp:'2026-01-01T12:00:00'}));
          createRoot(document.querySelector('#root')).render(React.createElement(HistoryConversationView,{
            conversation:{session:{machine:'fixture',id:'sample'},messages,latestMessagePaging:true,
              loading:false,viewportRef:{current:null}},onJumpToLatest(){}}));
          const wait=condition=>new Promise((resolve,reject)=>{let attempts=200;function check(){if(condition())resolve();
            else if(--attempts)setTimeout(check,10);else reject(Error('fixture did not settle'));}check()});
          const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
          void (async()=>{try {
            await wait(()=>document.querySelectorAll('.conversation-image-thumbnail img').length===3 &&
              [...document.images].every(img=>img.complete && img.naturalWidth));
            await new Promise(resolve=>setTimeout(resolve,50));
            const boxes=[...document.querySelectorAll('article')].map(article=>{
              const bubble=article.querySelector('.history-bubble');
              const image=bubble.querySelector('img');const time=article.querySelector('time');
              const style=getComputedStyle(bubble),metadata=getComputedStyle(time);
              return {bubble:rect(bubble),image:rect(image),time:rect(time),
                text:rect(bubble.querySelector('.message-markdown')),
                background:style.backgroundColor,border:style.borderWidth,radius:style.borderRadius,
                imageRadius:getComputedStyle(image.parentElement).borderRadius,
                metadataColor:metadata.color,metadataBackground:metadata.backgroundColor};
            });
            document.querySelector('#measurement').textContent=JSON.stringify({boxes,
              overflow:document.documentElement.scrollWidth>innerWidth,viewportWidth:innerWidth});
          } catch(error){document.querySelector('#measurement').textContent=JSON.stringify({error:String(error)})}})();
        `;
      },
    }],
    build:{write:false,minify:false,target:"esnext",lib:{entry:"image-bubble-fixture",name:"ImageBubbleFixture",formats:["iife"]}},
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item=>item.type === "chunk").map(item=>item.code).join("\n");
  const css = ["styles.css","ConversationImages.css"].map(name=>readFileSync(new URL(`../src/${name}`,import.meta.url),"utf8")).join("\n");
  const temp = mkdtempSync(join(tmpdir(),"conversation-image-sizing-"));
  const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  try {
    for (const width of [1440,360]) {
      const frame = `<!doctype html><style>${css}html,body{margin:0}#measurement{display:none}</style>
        <div id="root"></div><pre id="measurement"></pre><script>window.onerror=(message)=>document.querySelector("#measurement").textContent=JSON.stringify({error:String(message)});${code.replaceAll("</script", "<\\/script")}</script>`;
      const file = join(temp,`fixture-${width}.html`);
      // An iframe gives narrow tests the exact width (Chrome clamps its window).
      writeFileSync(file,`<!doctype html><style>body{margin:0}iframe{border:0}</style><iframe width="${width}" height="1500"></iframe>
        <pre id="result" style="display:none"></pre><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<","\\u003c")};
        setInterval(()=>{document.querySelector('#result').textContent=document.querySelector('iframe').contentDocument.querySelector('#measurement')?.textContent||''},50)</script>`);
      if (evidence) mkdirSync(evidence,{recursive:true});
      const browser = spawnSync(process.env.CHROME_BIN ?? "google-chrome",[
        "--headless","--disable-gpu","--no-sandbox","--hide-scrollbars","--allow-file-access-from-files",
        `--window-size=${Math.max(width,800)},1600`,"--virtual-time-budget=5000",
        ...(evidence ? [`--screenshot=${join(evidence,`conversation-bubbles-${width}.png`)}`] : []),
        "--dump-dom",`file://${file}`,
      ],{encoding:"utf8",timeout:20000,maxBuffer:16*1024*1024});
      assert.equal(browser.status,0,browser.stderr);
      const json=browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1];
      assert.ok(json,"fixture returns rendered measurements");
      const measured=JSON.parse(json.replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">"));
      if (evidence) writeFileSync(join(evidence,`conversation-bubbles-${width}.json`),JSON.stringify(measured,null,2));
      await t.test(`${width}px column`,()=>{
        assert.equal(measured.error,undefined);
        assert.equal(measured.viewportWidth,width);
        assert.equal(measured.overflow,false,"attachments never overflow the column");
        for (const box of measured.boxes.slice(0,2)) {
          assert.ok(Math.abs(box.bubble.w-box.image.w)<1,"image-only bubble width equals image");
          assert.ok(Math.abs(box.bubble.h-box.image.h)<1,"image-only bubble height equals image");
          assert.equal(box.background,"rgba(0, 0, 0, 0)","no colored bubble frame");
          assert.equal(box.border,"0px");
          assert.equal(box.radius,box.imageRadius,"corners match the preview");
          assert.ok(box.time.x>=box.image.x && box.time.y>=box.image.y &&
            box.time.x+box.time.w<=box.image.x+box.image.w+1 &&
            box.time.y+box.time.h<=box.image.y+box.image.h+1,"timestamp sits inside image");
          assert.equal(box.metadataColor,"rgb(255, 255, 255)");
          assert.equal(box.metadataBackground,"rgba(0, 0, 0, 0.75)","contrast on light and dark pixels");
        }
        const mixed=measured.boxes[2];
        assert.ok(Math.abs(mixed.bubble.w-Math.max(mixed.text.w,mixed.image.w))<1,"mixed bubble fits wider child");
        assert.ok(mixed.text.w>mixed.image.w,"caption is wider than tiny preview");

      });
    }
  } finally {rmSync(temp,{recursive:true,force:true});}
});
