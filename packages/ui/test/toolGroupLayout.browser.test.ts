import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";

// This fixture owns its isolated headless browser, including the raster used to
// distinguish a painted rounded border from a square toggle background.
async function launch(profile: string) {
  const browser = spawn(process.env.CHROME_BIN ?? "google-chrome", ["--headless", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--force-color-profile=srgb", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let socket: WebSocket | undefined;
  const close = async () => {
    socket?.close();
    if (browser.exitCode !== null || browser.signalCode !== null) return;
    const exited = new Promise<void>(resolve => browser.once("exit", () => resolve()));
    browser.kill(); await exited;
  };
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("Chrome endpoint timed out")), 10000);
      browser.stderr.on("data", data => {
        stderr += data.toString(); const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]!); }
      });
      browser.once("error", error => { clearTimeout(timeout); reject(error); });
      browser.once("exit", () => { clearTimeout(timeout); reject(new Error("Chrome exited before connecting")); });
    });
    const pages = await (await fetch(new URL("/json/list", endpoint.replace("ws:", "http:")))).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = pages.find(item => item.type === "page"); assert.ok(page);
    const connection = new WebSocket(page.webSocketDebuggerUrl); socket = connection;
    await new Promise<void>((resolve, reject) => { connection.onopen = () => resolve(); connection.onerror = () => reject(new Error("Chrome connection failed")); });
    let id = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    connection.onmessage = event => {
      const reply = JSON.parse(String(event.data)), waiter = pending.get(reply.id);
      if (waiter) { pending.delete(reply.id); reply.error ? waiter.reject(new Error(reply.error.message)) : waiter.resolve(reply.result); }
    };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
      const request = ++id; pending.set(request, { resolve, reject }); connection.send(JSON.stringify({ id: request, method, params }));
    });
    const evaluate = async <T,>(expression: string): Promise<T> => {
      const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(reply.exceptionDetails, undefined, "layout fixture executes"); return reply.result.value;
    };
    return { send, evaluate, close };
  } catch (error) { await close(); throw error; }
}

test("tool group rows preserve agent columns, visible avatars, timestamp insets and painted corners", { timeout: 120000 }, async t => {
  const built = await build({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent",
    resolve: { conditions: ["source"] }, define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
      name: "group-layout-fixture",
      resolveId(id) { if (id.endsWith("group-layout-fixture")) return "\0group-layout-fixture"; },
      load(id) {
        if (id !== "\0group-layout-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {HistoryConversationView} from '/src/HistoryConversation.tsx';import '/src/styles.css';
          const text=(id,role='assistant',text='Fernlight sample project. '.repeat(6))=>({id,role,text,timestamp:'2026-01-01T12:00:00'});
          const tool=(id,error=false)=>({...text(id,'assistant',''),timestamp:id.endsWith('2')?'2026-01-01T12:02:00':'2026-01-01T12:01:00',tool_parts:[{kind:'tool_call',id:id+'-call',name:'Read',input_summary:'sample.txt',status:error?'error':'ok'}]});
          const messages=[text('reference'),text('request','user','Inspect the sample.'),tool('normal1'),tool('normal2'),text('after-normal'),tool('error1'),tool('error2',true),text('after-error','assistant','The missing sample needs attention.'),text('single-request','user','Inspect one file.'),tool('single'),text('after-single','assistant','The sample is ready.')];
          createRoot(document.querySelector('#root')).render(React.createElement(HistoryConversationView,{conversation:{session:{id:'sample',machine:'fixture',provider:'codex'},messages,latestMessagePaging:window.live,loading:false,viewportRef:{current:null}},onJumpToLatest(){}}));`;
      },
    }], build: { write: false, minify: false, target: "esnext", lib: { entry: "group-layout-fixture", name: "Fixture", formats: ["iife"] } } });
  const output = Array.isArray(built) ? built[0] : built; assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "tool-group-layout-"));
  const page = await launch(join(temp, "profile"));
  const evidence = process.env.SALON_UI_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  try {
    for (const [width, height] of [[384, 832], [1280, 900]]) for (const theme of ["dark", "paper"]) for (const view of ["live", "saved"]) {
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      const { frameTree } = await page.send("Page.getFrameTree");
      await page.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}html,body{margin:0}#root{display:flex;flex-direction:column;height:100vh}.history-messages{min-height:0}</style><div id="root"></div><script>window.live=${view === "live"};${code.replaceAll("</script", "<\\/script")}</script></html>` });
      await page.evaluate(`new Promise(resolve=>setTimeout(resolve,100))`);
      for (const expanded of [false, true]) {
        const name = `${width}-${theme}-${view}-${expanded ? "expanded" : "collapsed"}`;
        if (expanded) await page.evaluate(`(()=>{document.querySelectorAll('.conversation-tool-group-toggle').forEach(button=>button.click())})()`);
        await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        const measured = await page.evaluate<any>(`(()=>{
          const box=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
          const row=id=>document.querySelector('[data-history-message-id="'+id+'"]');
          const viewport=document.querySelector('.history-messages'),reference=row('reference');
          const edge=box(viewport).left+viewport.clientLeft+viewport.clientWidth;
          const rightGap=time=>{let right=edge;for(let parent=time.parentElement;parent&&parent!==viewport;parent=parent.parentElement){const r=box(parent);if(parseFloat(getComputedStyle(parent).borderRightWidth)>0&&r.right>=box(time).right)right=Math.min(right,r.right-parseFloat(getComputedStyle(parent).borderRightWidth))}return right-box(time).right};
          const groups=[...document.querySelectorAll('.conversation-tool-group-toggle')].map(button=>{
            const article=button.closest('.history-message'),content=button;
            return {content:box(content),time:box(article?.querySelector('time')),end:article?.querySelector('time')?.getAttribute('datetime'),avatar:!!article?.querySelector('.agent-badge'),expanded:button.getAttribute('aria-expanded')};
          });
          return {width:innerWidth,height:innerHeight,reference:{content:box(reference.querySelector('.history-bubble')),time:box(reference.querySelector('time'))},groups,
            after:['after-normal','after-error'].map(id=>!!row(id).querySelector('.agent-badge')),
            single:{content:box(row('single').querySelector('.conversation-tools')),time:box(row('single').querySelector('time'))},
            times:[...viewport.querySelectorAll('time')].filter(node=>node.getClientRects().length).map(node=>({...box(node),rightGap:rightGap(node)})),edge,
            overflow:viewport.scrollWidth>viewport.clientWidth,
            expandedRows:['normal1','normal2','error1','error2'].map(id=>({content:box(row(id).querySelector('.conversation-tools')),time:box(row(id).querySelector('time')),avatar:!!row(id).querySelector('.agent-badge')}))};})()`);
        if (evidence) writeFileSync(join(evidence, `${name}.json`), JSON.stringify(measured, null, 2));
        await t.test(`${name} row layout`, () => {
          assert.equal(measured.width, width); assert.equal(measured.height, height); assert.equal(measured.overflow, false);
          for (const [index, group] of measured.groups.entries()) {
            assert.ok(Math.abs(group.content.left - measured.reference.content.left) <= 1, "summary keeps the agent bubble left edge");
            assert.ok(Math.abs(group.content.right - measured.reference.content.right) <= 1, "summary keeps the agent bubble right edge");
            assert.ok(group.time, "summary has a timestamp column");
            assert.ok(Math.abs(group.time.left - measured.reference.time.left) <= 1, "summary time matches the text timestamp column");
            assert.equal(group.end, "2026-01-01T12:02:00"); assert.equal(group.avatar, index === 0, "summary keeps the avatar gutter and starts a new agent run with its avatar");
          }
          assert.equal(measured.single.content.left, measured.reference.content.left, "single tool keeps its content column");
          if (expanded) assert.deepEqual(measured.expandedRows.map((row: any) => row.avatar), [true, false, false, false], "expanded rows retain their avatar rule");
          if (expanded) for (const row of measured.expandedRows) {
            assert.equal(row.content.left, measured.single.content.left, "expanded tools keep the single-row content column");
            assert.equal(row.time.left, measured.single.time.left, "expanded tools keep their timestamp column");
          }
        });
        await t.test(`${name} following avatar`, () => {
          assert.deepEqual(measured.after, expanded ? [false, false] : [true, true], "visible text after collapsed tools starts with its avatar");
        });
        await t.test(`${name} timestamp inset`, () => {
          const inset = measured.edge - measured.reference.time.right;
          assert.ok(inset >= 15, "text reference retains conversation padding");
          for (const time of measured.times) {
            assert.ok(measured.edge - time.right >= inset - 1, "every timestamp retains at least the text-bubble inset");
            assert.ok(time.rightGap >= inset - 1, "an expanded group border cannot crowd the timestamp column");
          }
        });
        // Sample the four rounded diagonals from Chrome's painted output. An
        // 2×2 patch near r-r/sqrt(2) must contain border ink in every corner,
        // allowing fractional CSS coordinates to straddle raster pixels.
        for (let index = 0; index < 2; index++) {
          const corner = await page.evaluate<any>(`(()=>{const button=document.querySelectorAll('.conversation-tool-group-toggle')[${index}];button.scrollIntoView({block:'center'});const parent=button.closest('.conversation-tool-group');const target=getComputedStyle(button).borderTopWidth!=='0px'?button:parent;const r=target.getBoundingClientRect(),s=getComputedStyle(target);return {x:r.x,y:r.y,width:r.width,height:r.height,radius:parseFloat(s.borderTopLeftRadius),border:s.borderTopColor,background:getComputedStyle(button).backgroundColor};})()`);
          const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          const raster = await page.evaluate<any>(`(async()=>{const image=new Image();image.src='data:image/png;base64,${shot.data}';await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d');c.drawImage(image,0,0);const rgb=color=>{c.fillStyle=color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3)};const border=rgb(${JSON.stringify(corner.border)}),bg=rgb(${JSON.stringify(corner.background)}),r=${JSON.stringify(corner)},offset=Math.max(1,Math.round(r.radius*(1-Math.SQRT1_2)));const points=[[r.x+offset,r.y+offset],[r.x+r.width-offset,r.y+offset],[r.x+offset,r.y+r.height-offset],[r.x+r.width-offset,r.y+r.height-offset]];const distance=(p,color)=>Math.hypot(...p.map((v,i)=>v-color[i]));return {border,bg,pixels:points.map(([x,y])=>{const candidates=[];for(const dx of [-1,0])for(const dy of [-1,0])candidates.push([...c.getImageData(Math.floor(x)+dx,Math.floor(y)+dy,1,1).data].slice(0,3));return candidates.sort((a,b)=>(distance(a,border)-distance(a,bg))-(distance(b,border)-distance(b,bg)))[0]})};})()`);
          if (evidence) {
            writeFileSync(join(evidence, `${name}-${index ? "error" : "normal"}.png`), Buffer.from(shot.data, "base64"));
            writeFileSync(join(evidence, `${name}-${index ? "error" : "normal"}-corners.json`), JSON.stringify({ corner, raster }, null, 2));
          }
          await t.test(`${name} ${index ? "error" : "normal"} corners`, () => {
            assert.ok(corner.radius > 0);
            for (const pixel of raster.pixels) {
              const distance = (color: number[]) => Math.hypot(...pixel.map((value: number, i: number) => value - color[i]!));
              assert.ok(distance(raster.border) < distance(raster.bg), `rounded corner paints border rather than toggle background: ${JSON.stringify(raster)}`);
            }
          });
        }
        // Real Tab input establishes :focus-visible and tests both themes.
        await page.evaluate(`document.activeElement?.blur();document.querySelector('.conversation-tool-group-toggle').focus()`);
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
        const focus = await page.evaluate<any>(`(()=>{const el=document.activeElement,s=getComputedStyle(el);return {visible:el.matches('.conversation-tool-group-toggle:focus-visible'),width:s.outlineWidth,style:s.outlineStyle}})()`);
        await t.test(`${name} keyboard focus`, () => { assert.equal(focus.visible, true); assert.equal(focus.width, "2px"); assert.equal(focus.style, "solid"); });
        if (evidence) {
          const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          writeFileSync(join(evidence, `${name}-focus.png`), Buffer.from(shot.data, "base64"));
        }
        await page.evaluate(`document.activeElement?.blur()`);
      }
    }
  } finally { await page.close(); rmSync(temp, { recursive: true, force: true }); }
});
