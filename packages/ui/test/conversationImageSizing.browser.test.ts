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
test("image previews fit column, natural dimensions and viewport without cropping", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const bundled = await build({
    resolve:{conditions:["source"]}, configFile:false, logLevel:"silent", define:{"process.env.NODE_ENV":JSON.stringify("production")},
    plugins:[react(),{
      name:"image-sizing-fixture",
      resolveId(id) { if (id.endsWith("image-sizing-fixture")) return "\0image-sizing-fixture"; },
      load(id) {
        if (id !== "\0image-sizing-fixture") return;
        return `import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {ConversationImages} from '/src/ConversationImages.tsx';
          const sizes=[[1600,600],[600,1000],[32,24],[200,4000]];
          const blobs=sizes.map(([w,h],i)=>{
            const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
            const c=canvas.getContext('2d');c.fillStyle=['#164e63','#6b21a8','#166534','#9a3412'][i];c.fillRect(0,0,w,h);
            c.fillStyle='white';c.font='40px sans-serif';c.fillText('Synthetic screenshot — full width',24,60);
            for(let x=24;x<w;x+=180)c.fillRect(x,100,120,12);
            return new Blob([Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0))],{type:'image/png'});
          });
          let observers=[];
          window.IntersectionObserver=class {constructor(callback){this.callback=callback;observers.push(this)}
            observe(){this.callback([{isIntersecting:true}])}disconnect(){}};
          window.fetch=async path=>new Response(blobs[Number(path.split('/').pop().split('.')[2])],{headers:{'content-type':'image/png'}});
          const image=i=>({id:'a'.repeat(16)+'.0.'+i+'.'+'b'.repeat(32)});
          const attachments=indices=>React.createElement(ConversationImages,{machine:'fixture',history:'sample',images:indices.map(image)});
          createRoot(document.querySelector('#root')).render(React.createElement(React.Fragment,null,
            ...[[0],[1],[2],[3],[0,1,2]].map((indices,i)=>React.createElement('article',{
              key:i,className:'history-message is-user'},React.createElement('time',null,'12:00'),
              React.createElement('div',{className:'history-bubble'},
                React.createElement('div',{className:'message-markdown'},'Synthetic attachment '+(i+1)),attachments(indices))))));
          const wait=condition=>new Promise((resolve,reject)=>{let attempts=200;function check(){if(condition())resolve();
            else if(--attempts)setTimeout(check,10);else reject(Error('fixture did not settle'));}check()});
          const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
          void (async()=>{try {
            await wait(()=>document.querySelectorAll('.conversation-image-thumbnail img').length===7 &&
              [...document.images].every(img=>img.complete && img.naturalWidth));
            await new Promise(resolve=>setTimeout(resolve,50));
            const boxes=[...document.querySelectorAll('.conversation-image-thumbnail')].map(button=>({
              ...rect(button),image:rect(button.querySelector('img')),natural:[button.querySelector('img').naturalWidth,button.querySelector('img').naturalHeight]}));
            const before=rect(document.querySelector('.conversation-image-thumbnail'));
            observers.forEach(o=>o.callback([{isIntersecting:false}]));
            await wait(()=>document.querySelector('.conversation-image-thumbnail [role=status]'));
            const loading=rect(document.querySelector('.conversation-image-thumbnail'));
            observers.forEach(o=>o.callback([{isIntersecting:true}]));
            await wait(()=>document.querySelectorAll('.conversation-image-thumbnail img').length===7 && [...document.images].every(img=>img.complete));
            document.querySelector('#measurement').textContent=JSON.stringify({boxes,before,loading,
              column:rect(document.querySelector('article')),overflow:document.documentElement.scrollWidth>innerWidth,viewportWidth:innerWidth});
          } catch(error){document.querySelector('#measurement').textContent=JSON.stringify({error:String(error)})}})();
        `;
      },
    }],
    build:{write:false,minify:false,target:"esnext",lib:{entry:"image-sizing-fixture",name:"ImageSizingFixture",formats:["iife"]}},
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item=>item.type === "chunk").map(item=>item.code).join("\n");
  const css = ["styles.css","ConversationImages.css"].map(name=>readFileSync(new URL(`../src/${name}`,import.meta.url),"utf8")).join("\n");
  const temp = mkdtempSync(join(tmpdir(),"conversation-image-sizing-"));
  const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  try {
    for (const width of [1440,360,600,601]) {
      const frame = `<!doctype html><style>${css}html,body{margin:0}#measurement{display:none}</style>
        <div id="root"></div><pre id="measurement"></pre><script>${code}</script>`;
      const file = join(temp,`fixture-${width}.html`);
      // An iframe gives narrow tests the exact width (Chrome clamps its window).
      writeFileSync(file,`<!doctype html><style>body{margin:0}iframe{border:0}</style><iframe width="${width}" height="1000"></iframe>
        <pre id="result" style="display:none"></pre><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<","\\u003c")};
        setInterval(()=>{document.querySelector('#result').textContent=document.querySelector('iframe').contentDocument.querySelector('#measurement')?.textContent||''},50)</script>`);
      if (evidence) mkdirSync(evidence,{recursive:true});
      const browser = spawnSync(process.env.CHROME_BIN ?? "google-chrome",[
        "--headless","--disable-gpu","--no-sandbox","--hide-scrollbars","--allow-file-access-from-files",
        `--window-size=${Math.max(width,800)},1100`,"--virtual-time-budget=5000",
        ...(evidence ? [`--screenshot=${join(evidence,`conversation-images-${width}.png`)}`] : []),
        "--dump-dom",`file://${file}`,
      ],{encoding:"utf8",timeout:20000});
      assert.equal(browser.status,0,browser.stderr);
      const json=browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1];
      assert.ok(json,"fixture returns rendered measurements");
      const measured=JSON.parse(json.replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">"));
      if (evidence) writeFileSync(join(evidence,`conversation-images-${width}.json`),JSON.stringify(measured,null,2));
      await t.test(`${width}px column`,()=>{
        assert.equal(measured.error,undefined);
        assert.equal(measured.viewportWidth,width);
        assert.equal(measured.overflow,false,"attachments never overflow the column");
        const [wide,portrait,tiny,tall,...grid]=measured.boxes;
        for(const box of measured.boxes) {
          assert.ok(Math.abs(box.w/box.h-box.natural[0]/box.natural[1])<0.02,"preview preserves natural ratio");
          assert.ok(box.w<=box.natural[0]+1 && box.h<=box.natural[1]+1,"never upscale");
          assert.ok(box.h<=550.1,"height fits 55% of the viewport");
          assert.ok(Math.abs(box.image.w-box.w)<1 && Math.abs(box.image.h-box.h)<1,"no padded frame or crop");
        }
        assert.ok(wide.w>measured.column.w*(width<=600?0.8:0.6),"wide screenshot fills the intended column share");
        assert.ok(wide.w<measured.column.w*(width<=600?1:0.7),"desktop leaves column breathing room");
        assert.ok(portrait.h>portrait.w && tall.h>tall.w,"portrait and tall remain upright");
        assert.equal(tiny.w,32);assert.equal(tiny.h,24);
        assert.ok(Math.abs(tall.h-550)<1,"very tall image reaches the height cap");
        assert.ok(grid[1].x>grid[0].x && Math.abs(grid[1].y-grid[0].y)<1,"multiple images share two tracks");
        assert.ok(grid[2].y>grid[0].y,"third image wraps to a new row");
        assert.deepEqual(measured.loading,measured.before,"known dimensions reserve the box during a later load");
      });
    }
  } finally {rmSync(temp,{recursive:true,force:true});}
});
