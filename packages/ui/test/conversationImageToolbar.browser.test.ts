import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("viewer clears title chrome and uses shared themed icon controls", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const bundled=await build({configFile:false,logLevel:"silent",resolve:{conditions:["source"]},
    define:{"process.env.NODE_ENV":JSON.stringify("production")},plugins:[react(),{
      name:"viewer-toolbar-fixture",
      resolveId(id){if(id.endsWith("viewer-toolbar-fixture"))return "\0viewer-toolbar-fixture";},
      load(id){if(id!=="\0viewer-toolbar-fixture")return;
        return `import React from 'react';import{createRoot}from'react-dom/client';
          import{ConversationImages}from'/src/ConversationImages.tsx';
          import{IconButton}from'/src/IconButton.tsx';import{CloseIcon}from'/src/icons.tsx';
          const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=600;
          const ctx=canvas.getContext('2d');ctx.fillStyle='#e2e8f0';ctx.fillRect(0,0,1200,600);
          ctx.fillStyle='#164e63';ctx.fillRect(40,40,1120,520);ctx.fillStyle='white';ctx.font='40px sans-serif';ctx.fillText('Synthetic attachment',80,120);
          const blob=new Blob([Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0))],{type:'image/png'});
          window.fetch=async()=>new Response(blob,{headers:{'content-type':'image/png'}});
          window.IntersectionObserver=class{constructor(cb){this.cb=cb}observe(){this.cb([{isIntersecting:true}])}disconnect(){}};
          createRoot(document.querySelector('#root')).render(React.createElement(React.Fragment,null,
            React.createElement(IconButton,{className:'btn reference','aria-label':'Reference control'},React.createElement(CloseIcon)),
            React.createElement(ConversationImages,{machine:'fixture',history:'sample',images:[{id:'a'.repeat(16)+'.0.0.'+'b'.repeat(32)}]})));
          const wait=condition=>new Promise((resolve,reject)=>{let n=200;function check(){if(condition())resolve();else if(--n)setTimeout(check,10);else reject(Error('fixture timeout'));}check()});
          const style=node=>{const s=getComputedStyle(node);return Object.fromEntries(['width','height','padding','borderRadius','color','backgroundColor','borderColor','opacity','cursor','outline','outlineOffset'].map(k=>[k,s[k]]))};
          void(async()=>{try{
            await wait(()=>document.querySelector('.conversation-image-thumbnail img')?.complete);
            document.querySelector('.conversation-image-thumbnail').click();
            await wait(()=>document.querySelector('.conversation-image-canvas img')?.naturalWidth);
            const viewer=document.querySelector('.conversation-image-viewer'),toolbar=viewer.querySelector('.conversation-image-toolbar');
            const reference=document.querySelector('.reference'),fit=viewer.querySelector('[aria-label="Fit image"]');
            const controls=[...viewer.querySelectorAll('button')].map(b=>({label:b.getAttribute('aria-label'),shared:b.classList.contains('control-icon'),style:style(b),glyph:b.querySelector('svg').getBoundingClientRect().width}));
            const normal=style(reference);reference.disabled=true;const disabled=style(reference);reference.disabled=false;
            reference.focus();const focus=style(reference);fit.focus();const viewerFocus=style(fit);
            const counter=toolbar.querySelector('[aria-live]'),cs=getComputedStyle(counter);
            const textReference=document.createElement('span');textReference.style.fontSize='var(--text-sm)';document.body.append(textReference);
            document.querySelector('#measurement').textContent=JSON.stringify({controls,normal,disabled,focus,viewerFocus,
              top:fit.getBoundingClientRect().top,titleHeight:document.querySelector('.mac-titlebar')?.getBoundingClientRect().height??0,
              counterTop:counter.getBoundingClientRect().top,counterColor:cs.color,counterFont:cs.fontSize,
              expectedFont:getComputedStyle(textReference).fontSize,
              scrim:getComputedStyle(toolbar).backgroundImage,viewportWidth:innerWidth,overflow:viewer.scrollWidth>innerWidth});
          }catch(error){document.querySelector('#measurement').textContent=JSON.stringify({error:String(error)})}})();`;
      },
    }],build:{write:false,minify:false,target:"esnext",lib:{entry:"viewer-toolbar-fixture",name:"ViewerFixture",formats:["iife"]}}});
  const output=Array.isArray(bundled)?bundled[0]:bundled;
  assert.ok(output && "output" in output);
  const code=output.output.filter(item=>item.type==="chunk").map(item=>item.code).join("\n");
  const css=["styles.css","ConversationImages.css"].map(name=>readFileSync(new URL(`../src/${name}`,import.meta.url),"utf8")).join("\n");
  const temp=mkdtempSync(join(tmpdir(),"viewer-toolbar-")),evidence=process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  try{
    for(const [width,mac] of [[1440,true],[360,false],[760,false],[761,false]] as const){
      const frame=`<!doctype html><html ${mac?'data-mac-titlebar="true"':''}><style>${css}html,body{margin:0}#measurement{display:none}</style>
        ${mac?'<div class="mac-titlebar">Synthetic title bar</div>':''}<div id="root"></div><pre id="measurement"></pre><script>${code}</script></html>`;
      const file=join(temp,`viewer-${width}.html`);
      writeFileSync(file,`<!doctype html><style>body{margin:0}iframe{border:0;display:block}</style><iframe width="${width}" height="900"></iframe><pre id="result" style="display:none"></pre>
        <script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<","\\u003c")};setInterval(()=>{document.querySelector('#result').textContent=document.querySelector('iframe').contentDocument.querySelector('#measurement')?.textContent||''},50)</script>`);
      if(evidence)mkdirSync(evidence,{recursive:true});
      const browser=spawnSync(process.env.CHROME_BIN??"google-chrome",["--headless","--disable-gpu","--no-sandbox","--hide-scrollbars","--allow-file-access-from-files",
        `--window-size=${Math.max(width,800)},1000`,"--virtual-time-budget=5000",...(evidence?[`--screenshot=${join(evidence,`viewer-${width}.png`)}`]:[]),"--dump-dom",`file://${file}`],{encoding:"utf8",timeout:20000});
      assert.equal(browser.status,0,browser.stderr);
      const json=browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1];assert.ok(json,"real viewer returns measurements");
      const m=JSON.parse(json.replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">"));
      if(evidence)writeFileSync(join(evidence,`viewer-${width}.json`),JSON.stringify(m,null,2));
      await t.test(`${width}px ${mac?"macOS title layout":"web layout"}`,async t=>{
        assert.equal(m.error,undefined);assert.equal(m.viewportWidth,width);assert.equal(m.overflow,false);
        await t.test("toolbar clears title area",()=>{
          assert.ok(m.top>=m.titleHeight+8,`control top ${m.top} clears title height ${m.titleHeight}`);
          assert.ok(m.counterTop>=m.titleHeight+8,"counter clears title chrome");
        });
        await t.test("shared control and text styling",()=>{
          assert.equal(m.controls.length,5);
          for(const c of m.controls){assert.equal(c.shared,true,c.label);assert.deepEqual(c.style,c.label==='Zoom out'?m.disabled:m.normal,c.label);assert.equal(c.glyph,18,`${c.label} shared glyph`);}
          assert.deepEqual(m.viewerFocus,m.focus,"shared keyboard focus styling");
          assert.equal(m.counterColor,m.normal.color,"theme foreground");assert.equal(m.counterFont,m.expectedFont,"small text token");
          assert.notEqual(m.scrim,"none","scrim protects toolbar over images");
        });
      });
    }
  }finally{rmSync(temp,{recursive:true,force:true});}
});
