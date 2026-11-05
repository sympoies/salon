import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

// Keep this fixture's Chrome transport inside the UI package, like the other
// interactive browser fixtures. The profile directory is owned by this test.
async function launchImageFixture(profile: string) {
  const browser = spawn(process.env.CHROME_BIN ?? "google-chrome",[
    "--headless","--disable-gpu","--no-sandbox","--hide-scrollbars","--mute-audio",
    "--remote-debugging-port=0",`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check",
    "--force-color-profile=srgb","--lang=en-US","about:blank",
  ],{stdio:["ignore","ignore","pipe"]});
  let socket: WebSocket | undefined;
  const close = async () => {
    socket?.close();
    if (browser.exitCode !== null || browser.signalCode !== null) return;
    const exited = new Promise<void>(resolve => browser.once("exit",() => resolve()));
    browser.kill("SIGKILL"); await exited;
  };
  try {
    const endpoint = await new Promise<string>((resolve,reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("Chrome debugging endpoint timed out")),10000);
      browser.stderr.on("data",data => {
        stderr += data.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]!); }
      });
      browser.once("error",error => { clearTimeout(timeout); reject(error); });
      browser.once("exit",() => { clearTimeout(timeout); reject(new Error("Chrome exited before debugging was ready")); });
    });
    const pages = await (await fetch(new URL("/json/list",endpoint.replace("ws:","http:")))).json() as Array<{type:string;webSocketDebuggerUrl:string}>;
    const page = pages.find(item => item.type === "page"); assert.ok(page);
    const connection = new WebSocket(page.webSocketDebuggerUrl); socket = connection;
    await new Promise<void>((resolve,reject) => { connection.onopen = () => resolve(); connection.onerror = () => reject(new Error("Chrome connection failed")); });
    let id = 0;
    let loaded: (() => void) | undefined;
    const pending = new Map<number,{resolve:(value:any) => void;reject:(error:Error) => void}>();
    connection.onmessage = event => {
      const reply = JSON.parse(String(event.data)), waiter = pending.get(reply.id);
      if (waiter) { pending.delete(reply.id); reply.error ? waiter.reject(new Error(reply.error.message)) : waiter.resolve(reply.result); }
      if (reply.method === "Page.loadEventFired") { loaded?.(); loaded = undefined; }
    };
    connection.onclose = () => { pending.forEach(waiter => waiter.reject(new Error("Chrome connection closed"))); pending.clear(); };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve,reject) => {
      const request = ++id; pending.set(request,{resolve,reject}); connection.send(JSON.stringify({id:request,method,params}));
    });
    await send("Page.enable");
    return {
      setViewport:(width: number,height: number,scale: number) => send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:scale,mobile:false}),
      navigate:async (url: string) => {
        const done = new Promise<void>(resolve => { loaded = resolve; });
        await send("Page.navigate",{url}); await done;
      },
      evaluate:async <T,>(expression: string): Promise<T> => {
        const result = await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
        assert.equal(result.exceptionDetails,undefined,"image fixture executes successfully"); return result.result.value;
      },
      send,
      screenshot:async () => Buffer.from((await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"),
      close,
    };
  } catch (error) { await close(); throw error; }
}

// A real scroll through thirteen synthetic image messages; production component,
// observer and CSS. Only image HTTP is substituted, with a recoverable 503.
test("conversation images retain loaded previews and Retry works through real browser input",async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const bundled = await build({
    resolve:{conditions:["source"]},configFile:false,logLevel:"silent",define:{"process.env.NODE_ENV":JSON.stringify("production")},
    plugins:[react(),{
      name:"image-retention-fixture",
      resolveId(id) { if (id.endsWith("image-retention-fixture")) return "\0image-retention-fixture"; },
      load(id) {
        if (id !== "\0image-retention-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {ConversationImages} from '/src/ConversationImages.tsx';
          const canvas=document.createElement('canvas');canvas.width=640;canvas.height=300;
          const c=canvas.getContext('2d');c.fillStyle='#16354d';c.fillRect(0,0,640,300);
          c.fillStyle='#b8e1f0';c.font='24px sans-serif';c.fillText('Synthetic chart',28,42);
          for(let i=0;i<9;i++){c.fillStyle=['#61afcf','#87bfa0','#deb56f'][i%3];c.fillRect(28+i*66,95+(i%3)*18,42,170-(i%3)*18)}
          const blob=new Blob([Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),x=>x.charCodeAt(0))],{type:'image/png'});
          window.imageRequests={};
          window.fetch=async path=>{
            const index=Number(path.split('/').pop().split('.')[2]);
            window.imageRequests[index]=(window.imageRequests[index]||0)+1;
            if(index===0&&!window.recoverImage)return new Response('',{status:503});
            // Hold any redundant read so the regression's loading flash is observable.
            if(index!==0&&window.imageRequests[index]>1)return new Promise(()=>{});
            return new Response(blob,{headers:{'content-type':'image/png'}});
          };
          const image=i=>({id:'a'.repeat(16)+'.0.'+i+'.'+'b'.repeat(32)});
          createRoot(document.querySelector('#root')).render(React.createElement(React.Fragment,null,
            ...Array.from({length:13},(_,i)=>React.createElement('article',{key:i,className:'history-message is-user','data-image-index':i},
              React.createElement('div',{className:'history-bubble'},React.createElement('div',{className:'message-markdown'},
                i===0?'An attachment with a temporary load failure':'Synthetic attachment '+(i+1)),
                React.createElement(ConversationImages,{machine:'fixture',history:'sample',images:[image(i)]}))))));`;
      },
    }],build:{write:false,minify:false,target:"esnext",lib:{entry:"image-retention-fixture",name:"ImageRetentionFixture",formats:["iife"]}},
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = readFileSync(new URL("../src/styles.css",import.meta.url),"utf8") + output.output
    .filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => item.source).join("\n");
  const temp = mkdtempSync(join(tmpdir(),"conversation-image-retention-"));
  const page = await launchImageFixture(temp);
  const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  const until = async (expression: string) => {
    for (let i = 0; i < 400; i++) {
      if (await page.evaluate<boolean>(expression)) return;
      await new Promise(resolve => setTimeout(resolve,25));
    }
    assert.fail(`Image fixture did not settle: ${expression}`);
  };
  try {
    const file = join(temp,"fixture.html");
    writeFileSync(file,`<!doctype html><html data-theme="dark"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${css}html,body{margin:0}body{padding:16px}header,#root{max-width:960px;margin:auto}header{padding:8px 0 20px}h1{font-size:20px;margin:0 0 8px}article{margin-bottom:24px}</style>
      <header><h1>Conversation attachments</h1><p>Synthetic conversation · 13 images</p></header><div id="root"></div><script>${code}</script></html>`);
    for (const [width,reducedMotion] of [[384,false],[1280,false],[1280,true]] as const) {
      const scenario = `${width}${reducedMotion ? "-reduced-motion" : ""}`;
      await page.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:reducedMotion ? "reduce" : "no-preference"}]});
      await page.setViewport(width,960,1);
      await page.navigate(`file://${file}`);
      await until(`document.querySelector('[data-image-index="1"] img')?.complete && document.querySelector('[data-image-index="1"] img')?.naturalWidth>0`);
      await page.evaluate(`document.querySelector('[data-image-index="12"]').scrollIntoView()`);
      await until(`document.querySelector('[data-image-index="1"]').getBoundingClientRect().bottom < -128`);
      await new Promise(resolve => setTimeout(resolve,100));
      await page.evaluate("scrollTo(0,0)");
      await new Promise(resolve => setTimeout(resolve,150));
      const measured = await page.evaluate<{width:number;images:number;ready:boolean;requests:number;error:string;overflow:boolean}>(`({
        width:innerWidth,images:document.querySelectorAll('article').length,
        ready:!!document.querySelector('[data-image-index="1"] img'),requests:window.imageRequests[1],
        error:document.querySelector('[data-image-index="0"] [role=status]')?.textContent,
        overflow:document.documentElement.scrollWidth>innerWidth})`);
      if (evidence) {
        mkdirSync(evidence,{recursive:true});
        writeFileSync(join(evidence,`conversation-images-${scenario}.png`),await page.screenshot());
        writeFileSync(join(evidence,`conversation-images-${scenario}.json`),JSON.stringify(measured,null,2));
      }
      await t.test(`${width}px${reducedMotion ? " reduced motion" : ""} scroll retention`,() => {
        assert.equal(measured.width,width); assert.equal(measured.images,13); assert.equal(measured.overflow,false);
        assert.equal(measured.ready,true,"a loaded thumbnail stays visible after scrolling back");
        assert.equal(measured.requests,1,"scrolling does not refetch the image");
        assert.match(measured.error,/Couldn't load/);
      });
      for (const input of ["mouse","touch","Enter","Space"] as const) {
        await t.test(`${width}px${reducedMotion ? " reduced motion" : ""} Retry via ${input}`,async () => {
          await page.navigate(`file://${file}`);
          // Exhaust automatic backoff before recovery so it cannot mask a lost click.
          await until(`window.imageRequests[0]===3 && !!document.querySelector('[data-image-index="0"] .conversation-image-retry')`);
          const before = await page.evaluate<number>("window.imageRequests[0]");
          await page.evaluate("window.recoverImage=true");
          const selector = '[data-image-index="0"] .conversation-image-retry';
          const point = await page.evaluate<{x:number;y:number}>(`(() => {
            const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
            return {x:r.x+r.width/2,y:r.y+r.height/2};
          })()`);
          if (evidence && input === "mouse") {
            writeFileSync(join(evidence,`image-retry-${scenario}-before.png`),await page.screenshot());
          }
          if (input === "mouse") {
            await page.send("Input.dispatchMouseEvent",{type:"mouseMoved",...point});
            await page.send("Input.dispatchMouseEvent",{type:"mousePressed",...point,button:"left",buttons:1,clickCount:1});
            // Capture the pressed hit target before releasing the same pointer.
            const pressed = await page.evaluate<string>(`document.elementFromPoint(${point.x},${point.y})?.className`);
            if (evidence) writeFileSync(join(evidence,`image-retry-${scenario}-pressed.json`),JSON.stringify({point,pressed}));
            await page.send("Input.dispatchMouseEvent",{type:"mouseReleased",...point,button:"left",buttons:0,clickCount:1});
          } else if (input === "touch") {
            await page.send("Emulation.setTouchEmulationEnabled",{enabled:true});
            await page.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{...point,id:1}]});
            await page.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
            await page.send("Emulation.setTouchEmulationEnabled",{enabled:false});
          } else {
            await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
            const key = input === "Enter" ? {key:"Enter",code:"Enter",windowsVirtualKeyCode:13} : {key:" ",code:"Space",windowsVirtualKeyCode:32};
            await page.send("Input.dispatchKeyEvent",{type:"keyDown",...key,text:input === "Enter" ? "\r" : " "});
            await page.send("Input.dispatchKeyEvent",{type:"keyUp",...key});
          }
          await until(`document.querySelector('[data-image-index="0"] img')?.naturalWidth>0`);
          const recovered = await page.evaluate<{requests:number;ready:boolean;viewer:boolean}>(`({
            requests:window.imageRequests[0],
            ready:!!document.querySelector('[data-image-index="0"] img')?.naturalWidth,
            viewer:!!document.querySelector('[role="dialog"]')})`);
          if (evidence && input === "mouse") {
            writeFileSync(join(evidence,`image-retry-${scenario}-after.png`),await page.screenshot());
          }
          assert.equal(recovered.requests,before+1,"one user activation sends exactly one new image request");
          assert.equal(recovered.ready,true,"the recovered image renders");
          assert.equal(recovered.viewer,false,"Retry does not open the viewer");
          const imagePoint = await page.evaluate<{x:number;y:number}>(`(() => {
            const r=document.querySelector('[data-image-index="0"] img').getBoundingClientRect();
            return {x:r.x+r.width/2,y:r.y+r.height/2};
          })()`);
          await page.send("Input.dispatchMouseEvent",{type:"mousePressed",...imagePoint,button:"left",clickCount:1});
          await page.send("Input.dispatchMouseEvent",{type:"mouseReleased",...imagePoint,button:"left",clickCount:1});
          await until(`document.querySelector('.conversation-image-canvas img')?.naturalWidth>0`);
          assert.equal(await page.evaluate<number>("window.imageRequests[0]"),before+1,"opening the viewer reuses the loaded image");
        });
      }
    }
  } finally { await page.close(); rmSync(temp,{recursive:true,force:true}); }
});
