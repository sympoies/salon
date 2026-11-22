import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("session notices render Markdown bodies that stay selectable and wrap at phone width", async (t) => {
  assert.ok(hasHeadlessChrome(), "headless Chrome is required for notice acceptance");
  const long = "A".repeat(160);
  const body = [
    "Intro with `inline code`, a [safe link](https://example.com/a) and a [bad link](javascript:alert(1)).",
    "",
    "- Parent one",
    "  - Nested child",
    "- Parent two ![remote](https://example.com/x.png)",
    "",
    long,
  ].join("\n");
  const raw = `<!-- agent-notice:v1 kind=mailbox source=fixture id=sample-1 -->\n\n${body}`;
  const fixture = `import '/src/styles.css';
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {HistoryConversationView} from '/src/HistoryConversation.tsx';
    const messages=[{id:'human',role:'user',text:'Synthetic human message'},
      {id:'agent',role:'assistant',text:'Synthetic agent reply'},
      {id:'notice',role:'user',row_class:'notice',text:${JSON.stringify(raw)}},
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
    const waitFor=async(condition:string)=>evaluate(`new Promise((resolve,reject)=>{let remaining=200;function check(){if(${condition})resolve(true);else if(--remaining)setTimeout(check,10);else reject(Error('fixture timed out'));}check();})`);
    async function renderFixture(width: number, theme = "dark", touch = false) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:touch});
      await send('Emulation.setTouchEmulationEnabled',{enabled:touch});
      const {frameTree}=await send('Page.getFrameTree');
      await send('Page.setDocumentContent',{frameId:frameTree.frame.id,html:`<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div>`});
      await evaluate(code);
      await waitFor('document.querySelectorAll("article").length===4');
    }

    const results=[];
    for(const width of [360,1440]) {
      await renderFixture(width);
      const collapsed = await evaluate(`(()=>{const row=document.querySelector('[data-history-message-id="notice"]'); const button=row.querySelector('button[aria-expanded]'); const preview=row.querySelector('.session-notice-preview'); return {expanded:button?.getAttribute('aria-expanded'), text:row.textContent, height:preview.getBoundingClientRect().height, textHeight:row.querySelector('.session-notice-first-line').getBoundingClientRect().height, overflow:row.scrollWidth>row.clientWidth};})()`);
      assert.equal(collapsed.expanded, 'false');
      assert.ok(!collapsed.text.includes('Parent one'));
      assert.equal(collapsed.overflow, false);
      assert.ok(collapsed.textHeight <= 24, `${width}px preview stays on one line`);
      if(evidence){
        const shot=await send('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(evidence,`notices-${width}.png`),Buffer.from(shot.data,'base64'));
      }
      await evaluate(`document.querySelector('[data-history-message-id="notice"] button[aria-expanded]').click()`);
      await waitFor(`document.querySelector('[data-history-message-id="notice"] button[aria-expanded="true"]')`);
      const measured=await evaluate(`(()=>{const row=document.querySelector('[data-history-message-id="notice"]');
        const notice=row.querySelector('.session-notice'),title=row.querySelector('.session-notice-preview');
        const body=row.querySelector('.session-notice-body'),time=row.querySelector('time').getBoundingClientRect();
        const r=row.getBoundingClientRect(),style=title&&getComputedStyle(title),bodyStyle=body&&getComputedStyle(body);
        const br=body?.getBoundingClientRect(),footer=row.querySelector('.session-notice-meta'),fr=footer?.getBoundingClientRect(),fs=footer&&getComputedStyle(footer);
        return {width:innerWidth,notice:!!notice,headerVisible:row.textContent.includes('<!-- agent-notice:'),
          centered:style?.textAlign==='center'||(style?.display==='flex'&&style?.justifyContent==='center'),
          weight:Number(style?.fontWeight),text:body?.textContent,bodyAlign:bodyStyle?.textAlign,
          nested:!!body?.querySelector('ul ul li'),topItems:body?.querySelectorAll('.message-markdown > ul > li').length,code:[...body.querySelectorAll('code')].map(c=>c.textContent),
          links:[...body.querySelectorAll('a')].map(a=>a.getAttribute('href')),images:body.querySelectorAll('img').length,
          bodyOverflow:body.scrollWidth>body.clientWidth,
          lineHeight:parseFloat(bodyStyle?.lineHeight),
          rowLeft:r.left,rowRight:r.right,
          bodyLeft:br&&br.left+parseFloat(bodyStyle.paddingLeft),bodyRight:br&&br.right-parseFloat(bodyStyle.paddingRight),
          footerLeft:fr&&fr.left+parseFloat(fs.paddingLeft),footerRight:fr&&fr.right-parseFloat(fs.paddingRight),
          copyButton:!!row.querySelector('.session-notice button'),bodySelect:bodyStyle?.userSelect,
          bubble:!!row.querySelector('.history-bubble'),background:getComputedStyle(notice).backgroundColor,
          timeVisible:time.x>=r.x&&time.right<=r.right,overflow:document.documentElement.scrollWidth>innerWidth||row.scrollWidth>row.clientWidth,
          footer:row.querySelector('.session-notice-meta > span')?.textContent};})()`);
      results.push(measured);
      if(evidence) writeFileSync(join(evidence,`notices-${width}.json`),JSON.stringify(measured,null,2));
      const drag=await evaluate(`(()=>{const items=[...document.querySelectorAll('[data-history-message-id="notice"] .session-notice-body .message-markdown > ul > li')];
        const first=items[0].getBoundingClientRect(),last=items[items.length-1].getBoundingClientRect();
        return {x:first.left+2,y:first.top+2,toX:last.right-2,toY:last.bottom-2};})()`);
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:drag.x,y:drag.y,button:'left',buttons:1,clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.toX,y:drag.toY,button:'left',buttons:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:drag.toX,y:drag.toY,button:'left',buttons:0,clickCount:1});
      const selected=await evaluate('getSelection().toString()');
      for(const part of ['Parent one','Nested child','Parent two'])assert.ok(selected.includes(part),`dragging across list items selects "${part}"`);
      await evaluate('window.fixtureRoot.unmount()');
    }
    for(const measured of results){
      assert.equal(measured.notice,true,'enveloped message renders as a notice');
      assert.equal(measured.headerVisible,false);
      assert.equal(measured.overflow,false,`${measured.width}px fits the viewport`);
      assert.equal(measured.timeVisible,true);
      assert.equal(measured.nested,true,'nested list keeps its structure');
      assert.equal(measured.topItems,2);
      assert.ok(!measured.text.includes('- Parent')&&!measured.text.includes('`'),'Markdown syntax is not shown literally');
      assert.deepEqual(measured.code,['inline code']);
      assert.deepEqual(measured.links,['https://example.com/a'],'only the http link becomes an anchor');
      assert.equal(measured.images,0,'notice images never load');
      assert.ok(measured.text.includes('Image unavailable'));
      assert.ok(measured.text.includes(long));
      assert.equal(measured.bodyOverflow,false,'a long unbroken token wraps inside the body');
      assert.equal(measured.bodyAlign,'left');
      assert.ok(measured.bodyLeft>measured.rowLeft,'body content is inset from the left edge');
      assert.ok(measured.bodyRight<measured.rowRight,'body content is inset from the right edge');
      assert.ok(Math.abs((measured.bodyLeft-measured.rowLeft)-(measured.rowRight-measured.bodyRight))<1,'body inset is symmetric');
      assert.ok(Math.abs(measured.footerLeft-measured.bodyLeft)<1,'footer shares the body left inset');
      assert.ok(Math.abs(measured.footerRight-measured.bodyRight)<1,'footer shares the body right inset');
      assert.equal(measured.copyButton,true,'the notice has an expander');
      assert.notEqual(measured.bodySelect,'none','the notice body stays selectable');
      assert.equal(measured.bubble,false);
      assert.equal(measured.background,'rgba(0, 0, 0, 0)','row has no bubble background');
      assert.equal(measured.footer,'mailbox · fixture');
    }
    await t.test("notice expander uses themed text and a transparent background", async () => {
      const styles = [];
      for (const width of [360, 1440]) {
        const touch = width === 360;
        for (const theme of ["dark", "paper"]) {
          await renderFixture(width, theme, touch);
          const style = await evaluate(`(() => {
            const button = document.querySelector('.session-notice-preview button[aria-expanded]');
            const computed = getComputedStyle(button);
            const probe = document.createElement('span');
            probe.style.color = 'var(--conversation-agent-text)';
            probe.style.outlineColor = 'var(--accent)';
            button.after(probe);
            const { color, outlineColor } = getComputedStyle(probe);
            probe.remove();
            button.focus();
            const rect = button.getBoundingClientRect();
            return {
              themed: button.classList.contains('session-notice-toggle'),
              background: computed.backgroundColor,
              color: computed.color,
              themeColor: color,
              focused: button.matches(':focus-visible'),
              outline: computed.outlineStyle,
              outlineWidth: computed.outlineWidth,
              outlineColor: computed.outlineColor,
              themeOutlineColor: outlineColor,
              touch: matchMedia('(pointer: coarse)').matches,
              width: rect.width,
              height: rect.height,
            };
          })()`);
          if (evidence) {
            const shot = await send('Page.captureScreenshot', {format:'png'});
            writeFileSync(join(evidence, `expander-${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
          }
          styles.push({theme, viewport: width, touch, style});
          await evaluate('window.fixtureRoot.unmount()');
        }
      }

      if (evidence) writeFileSync(join(evidence, 'expander-styles.json'), JSON.stringify(styles, null, 2));
      for (const {theme, viewport, touch, style} of styles) {
        const context = `${theme} at ${viewport}px`;
        assert.equal(style.background, 'rgba(0, 0, 0, 0)', `${context} expander has a transparent background`);
        assert.equal(style.themed, true, `${context} expander carries the themed class`);
        assert.equal(style.color, style.themeColor, `${context} expander uses the conversation text token`);
        assert.equal(style.focused, true, `${context} expander receives visible focus`);
        assert.equal(style.outline, 'solid', `${context} expander has a solid focus outline`);
        assert.equal(style.outlineWidth, '2px', `${context} expander has a 2px focus outline`);
        assert.equal(style.outlineColor, style.themeOutlineColor, `${context} focus uses the accent token`);
        assert.equal(style.touch, touch, `${context} fixture uses the expected pointer type`);
        if (touch) assert.ok(style.width >= 44 && style.height >= 44, `${context} expander has a 44px touch target`);
      }
    });
  } finally {
    socket?.close();
    if(browser.exitCode===null && browser.signalCode===null){
      const exited=new Promise<void>(resolve=>browser.once('exit',()=>resolve()));
      browser.kill();await exited;
    }
    rmSync(temp,{recursive:true,force:true});
  }
});
