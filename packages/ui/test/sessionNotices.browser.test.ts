import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("session notices show a centered heading and three plain-text lines with keyboard raw copy", async () => {
  assert.ok(hasHeadlessChrome(), "headless Chrome is required for notice acceptance");
  const body = "First synthetic line\n**Second synthetic line**\nThird synthetic line";
  const raw = `<!-- agent-notice:v1 kind=mailbox source=fixture id=sample-1 -->\n\n${body}`;
  const fixture = `import '/src/styles.css';
    import React from 'react';
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
  const css=output.output.filter(item=>item.type==='asset' && item.fileName.endsWith('.css')).map(item=>String(item.source)).join('\n');
  assert.ok(css.length > 0, 'fixture uses emitted production CSS');
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
      browser.once("exit", () => { clearTimeout(timeout); reject(new Error(`Chrome exited before debugging was ready: ${stderr}`)); });
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
      const measured=await evaluate(`(()=>{const row=document.querySelector('[data-history-message-id="notice"]');
        const notice=row.querySelector('.session-notice'),title=row.querySelector('.session-notice-title');
        const body=row.querySelector('.session-notice-body'),time=row.querySelector('time').getBoundingClientRect();
        const r=row.getBoundingClientRect(),style=title&&getComputedStyle(title),bodyStyle=body&&getComputedStyle(body);
        const br=body?.getBoundingClientRect(),footer=row.querySelector('.session-notice-meta'),fr=footer?.getBoundingClientRect(),fs=footer&&getComputedStyle(footer);
        const lines=[];
        if(body?.firstChild?.nodeType===Node.TEXT_NODE){
          let start=0;for(const line of body.firstChild.textContent.split('\\n')){
            const range=document.createRange();range.setStart(body.firstChild,start);range.setEnd(body.firstChild,start+line.length);
            lines.push([...range.getClientRects()].map(rect=>({x:rect.x,y:rect.y,h:rect.height})));start+=line.length+1;
          }
        }
        return {width:innerWidth,notice:!!notice,headerVisible:row.textContent.includes('<!-- agent-notice:'),
          centered:style?.textAlign==='center'||(style?.display==='flex'&&style?.justifyContent==='center'),
          weight:Number(style?.fontWeight),body:body?.textContent,bodyAlign:bodyStyle?.textAlign,lines,
          lineHeight:parseFloat(bodyStyle?.lineHeight),
          rowLeft:r.left,rowRight:r.right,
          bodyLeft:br&&br.left+parseFloat(bodyStyle.paddingLeft),bodyRight:br&&br.right-parseFloat(bodyStyle.paddingRight),
          footerLeft:fr&&fr.left+parseFloat(fs.paddingLeft),footerRight:fr&&fr.right-parseFloat(fs.paddingRight),
          copyRight:row.querySelector('.session-notice-copy')?.getBoundingClientRect().right,
          bubble:!!row.querySelector('.history-bubble'),background:getComputedStyle(notice).backgroundColor,
          timeVisible:time.x>=r.x&&time.right<=r.right,overflow:document.documentElement.scrollWidth>innerWidth||row.scrollWidth>row.clientWidth,
          footer:row.querySelector('.session-notice-meta > span')?.textContent};})()`);
      results.push(measured);
      if(evidence){
        const shot=await send('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(evidence,`notices-${width}.png`),Buffer.from(shot.data,'base64'));
        writeFileSync(join(evidence,`notices-${width}.json`),JSON.stringify(measured,null,2));
      }
      const copy='document.querySelector(".session-notice-copy")';
      if(await evaluate(`${copy}!==null`)){
        await evaluate(`${copy}.focus()`);
        assert.equal(await evaluate(`document.activeElement===${copy}`),true,'Copy raw accepts keyboard focus');
        await key('Enter','Enter',13);
        await waitFor('window.copies.length===1');
        await key(' ','Space',32);
        await waitFor('window.copies.length===2');
        assert.deepEqual(await evaluate('window.copies'),[raw,raw]);
      }
      await evaluate('window.fixtureRoot.unmount()');
    }
    for(const measured of results){
      assert.equal(measured.notice,true,'enveloped message renders as a notice');
      assert.equal(measured.headerVisible,false);
      assert.equal(measured.overflow,false,`${measured.width}px fits the viewport`);
      assert.equal(measured.timeVisible,true);
      assert.equal(measured.centered,true,`${measured.width}px title is centered`);
      assert.ok(measured.weight>=600,'title has heading weight');
      assert.equal(measured.body,body,'full body is always visible without Markdown reflow');
      assert.equal(measured.bodyAlign,'left');
      assert.ok(measured.bodyLeft>measured.rowLeft,'body content is inset from the left edge');
      assert.ok(measured.bodyRight<measured.rowRight,'body content is inset from the right edge');
      assert.ok(Math.abs((measured.bodyLeft-measured.rowLeft)-(measured.rowRight-measured.bodyRight))<1,'body inset is symmetric');
      assert.ok(Math.abs(measured.footerLeft-measured.bodyLeft)<1,'footer shares the body left inset');
      assert.ok(Math.abs(measured.footerRight-measured.bodyRight)<1,'footer shares the body right inset');
      assert.ok(Math.abs(measured.copyRight-measured.bodyRight)<1,'Copy raw stays inside the right inset');
      assert.equal(measured.lines.length,3,'three source lines');
      for(const line of measured.lines)assert.equal(line.length,1,'each source line occupies one visual line');
      assert.ok(Math.abs(measured.lines[0][0].x-measured.bodyLeft)<1,'text starts at the inset content edge');
      for(let i=1;i<3;i++){
        assert.ok(Math.abs(measured.lines[i][0].y-measured.lines[i-1][0].y-measured.lineHeight)<1,'line breaks advance exactly one line');
        assert.ok(Math.abs(measured.lines[i][0].x-measured.lines[0][0].x)<1,'lines share the left edge');
      }
      assert.equal(measured.bubble,false);
      assert.equal(measured.background,'rgba(0, 0, 0, 0)','row has no bubble background');
      assert.equal(measured.footer,'mailbox · fixture');
    }
  } finally {
    socket?.close();
    if(browser.exitCode===null && browser.signalCode===null){
      const exited=new Promise<void>(resolve=>browser.once('exit',()=>resolve()));
      browser.kill();await exited;
    }
    rmSync(temp,{recursive:true,force:true});
  }
});
