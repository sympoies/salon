import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("session notices stay one line and support keyboard expansion and raw copy", async () => {
  assert.ok(hasHeadlessChrome(), "headless Chrome is required for notice acceptance");
  const raw = "<!-- agent-notice:v1 kind=mailbox source=fixture id=sample-1 -->\n\nSynthetic update with a long preview that should truncate on a phone while keeping the timestamp visible\n\n**Full Markdown body** with [safe link](https://example.com).";
  const fixture = `import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {HistoryConversationView} from '/src/HistoryConversation.tsx';
    window.copies=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copies.push(text)}});
    const messages=[{id:'human',role:'user',text:'Synthetic human message'},
      {id:'agent',role:'assistant',text:'Synthetic agent reply'},
      {id:'notice',role:'user',text:${JSON.stringify(raw)}},
      {id:'next',role:'assistant',text:'Conversation continues.'}].map(m=>({...m,timestamp:'2026-01-01T12:00:00'}));
    window.fixtureRoot=createRoot(document.querySelector('#root'));
    window.fixtureRoot.render(React.createElement(HistoryConversationView,{conversation:{
      session:{machine:'fixture',id:'sample',provider:'codex'},messages,latestMessagePaging:true,
      loading:false,viewportRef:{current:null}},onJumpToLatest(){}}));`;
  const bundled=await build({configFile:false,logLevel:'silent',resolve:{conditions:['source']},
    define:{'process.env.NODE_ENV':JSON.stringify('production')},plugins:[react(),{
      name:'notice-fixture',resolveId(id){if(id.endsWith('notice-fixture'))return '\0notice-fixture';},
      load(id){if(id==='\0notice-fixture')return fixture;}}],
    build:{write:false,minify:false,lib:{entry:'notice-fixture',name:'NoticeFixture',formats:['iife']}}});
  const output=Array.isArray(bundled)?bundled[0]:bundled;
  assert.ok(output && 'output' in output);
  const code=output.output.filter(item=>item.type==='chunk').map(item=>item.code).join('\n');
  const css=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
  const temp=mkdtempSync(join(tmpdir(),'salon-notices-'));
  const evidence=process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  if(evidence)mkdirSync(evidence,{recursive:true});
  const browser=spawn(process.env.CHROME_BIN??'google-chrome',[
    '--headless','--disable-gpu','--no-sandbox','--hide-scrollbars','--remote-debugging-port=0',`--user-data-dir=${temp}`,'about:blank'
  ],{stdio:['ignore','ignore','pipe']});
  let socket:WebSocket|undefined;
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
    const key = async (name:string, code:string, virtualKey:number) => {
      await send("Input.dispatchKeyEvent",{type:"keyDown",key:name,code,windowsVirtualKeyCode:virtualKey,
        ...(code === "Enter" ? {text:"\r"} : code === "Space" ? {text:" "} : {})});
      await send("Input.dispatchKeyEvent",{type:"keyUp",key:name,code,windowsVirtualKeyCode:virtualKey});
    };
    const results=[];
    for(const width of [360,1440]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
      const {frameTree}=await send('Page.getFrameTree');
      await send('Page.setDocumentContent',{frameId:frameTree.frame.id,html:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div>`});
      await evaluate(code);
      const waitFor=async(condition:string)=>evaluate(`new Promise((resolve,reject)=>{let remaining=200;function check(){if(${condition})resolve(true);else if(--remaining)setTimeout(check,10);else reject(Error('fixture timed out'));}check();})`);
      await waitFor('document.querySelectorAll("article").length===4');
      const trigger='document.querySelector(".session-notice-toggle")';
      const found=await evaluate(`${trigger}!==null`);
      for(const state of ['collapsed','expanded']) {
        if(state==='expanded' && found) {
          await evaluate(`${trigger}.focus()`);
          await key('Enter','Enter',13);
          await waitFor(`${trigger}.getAttribute('aria-expanded')==='true'`);
        }
        const measured=await evaluate(`(()=>{const row=document.querySelector('[data-history-message-id="notice"]');
          const button=row.querySelector('.session-notice-toggle');const preview=row.querySelector('.session-notice-preview');
          const r=row.getBoundingClientRect(),p=preview?.getBoundingClientRect(),time=row.querySelector('time').getBoundingClientRect();
          return {width:innerWidth,state:${JSON.stringify(state)},notice:!!button,headerVisible:row.textContent.includes('<!-- agent-notice:'),
            row:{x:r.x,w:r.width,h:r.height},preview:p?{h:p.height,lineHeight:parseFloat(getComputedStyle(preview).lineHeight),truncated:preview.scrollWidth>preview.clientWidth}:null,
            timeVisible:time.x>=r.x&&time.right<=r.right,overflow:document.documentElement.scrollWidth>innerWidth,
            expanded:button?.getAttribute('aria-expanded'),bodyReadable:row.textContent.includes('Full Markdown body')};})()`);
        results.push(measured);
        if(evidence){
          const shot=await send('Page.captureScreenshot',{format:'png'});
          writeFileSync(join(evidence,`notices-${width}-${state}.png`),Buffer.from(shot.data,'base64'));
          writeFileSync(join(evidence,`notices-${width}-${state}.json`),JSON.stringify(measured,null,2));
        }
      }
      if(found){
        await evaluate(`document.querySelector('.session-notice-copy').click()`);
        await waitFor('window.copies.length===1');
        assert.deepEqual(await evaluate('window.copies'),[raw]);
        await evaluate(`${trigger}.focus()`);
        await key(' ','Space',32);
        await waitFor(`${trigger}.getAttribute('aria-expanded')==='false'`);
        assert.equal(await evaluate('document.querySelector(".session-notice-body")===null'),true);
      }
      await evaluate('window.fixtureRoot.unmount()');
    }
    for(const measured of results){
      assert.equal(measured.notice,true,'enveloped message renders as a notice');
      assert.equal(measured.headerVisible,false);
      assert.equal(measured.overflow,false);
      assert.equal(measured.timeVisible,true);
      assert.ok(Math.abs(measured.preview.h-measured.preview.lineHeight)<1,'preview occupies exactly one line');
      assert.equal(measured.expanded,measured.state==='expanded'?'true':'false');
      if(measured.state==='expanded')assert.equal(measured.bodyReadable,true);
    }
  } finally {
    socket?.close();
    const exited=new Promise<void>(resolve=>browser.once('exit',()=>resolve()));
    browser.kill();await exited;rmSync(temp,{recursive:true,force:true});
  }
});
