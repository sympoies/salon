import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { launchPage } from "../readme-previews/chrome.ts";

const uiRequire = createRequire(new URL("../../packages/ui/package.json",import.meta.url));
const { build } = await import(uiRequire.resolve("vite"));
const { default: react } = await import(uiRequire.resolve("@vitejs/plugin-react"));

// A real pointer press must follow the link instead of starting the viewer's pan gesture.
test("a real pointer opens the external image link from the mixed-source viewer",async () => {
  const bundle = await build({root:fileURLToPath(new URL("../../packages/ui/",import.meta.url)),configFile:false,logLevel:"silent",resolve:{conditions:["source"]},
    define:{"process.env.NODE_ENV":JSON.stringify("production")},plugins:[react(),{
      name:"external-link-fixture",
      resolveId(id: string) { if (id.endsWith("external-link-fixture")) return "\0external-link-fixture"; },
      load(id: string) {
        if (id !== "\0external-link-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {HistoryConversationView} from '/src/HistoryConversation.tsx';
          window.opened=[];window.requests=[];window.open=(...args)=>{opened.push(args);return null};
          window.fetch=async path=>{requests.push(path);return path.includes('.0.0.')
            ? new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII='),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png'}})
            : new Response(JSON.stringify({error:{code:'history-image-unavailable'}}),{status:422})};
          window.IntersectionObserver=class{constructor(cb){this.cb=cb}observe(){this.cb([{isIntersecting:true}])}disconnect(){}};
          createRoot(document.querySelector('#root')).render(React.createElement(HistoryConversationView,{
            conversation:{session:{id:'sample',machine:'fixture',provider:'claude'},latestMessagePaging:true,
              loading:false,viewportRef:{current:null},messages:[{id:'reply',role:'assistant',
                text:'![](/charts/local.png) ![](https://images.example.invalid/remote.png)',
                images:[0,1].map(i=>({id:'a'.repeat(16)+'.0.'+i+'.'+'b'.repeat(32)}))}]},onJumpToLatest(){}}));`;
      },
    }],build:{write:false,minify:false,target:"esnext",lib:{entry:"external-link-fixture",name:"ExternalLinkFixture",formats:["iife"]}}});
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = (output.output as Array<{type:string;code?:string}>).filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = readFileSync(new URL("../../packages/ui/src/ConversationImages.css",import.meta.url),"utf8");
  const temp = mkdtempSync(join(tmpdir(),"external-image-link-"));
  const file = join(temp,"viewer.html");
  writeFileSync(file,`<!doctype html><style>${css}</style><div id="root"></div><script>${code}</script>`);
  const page = await launchPage();
  try {
    await page.navigate(`file://${file}`);
    const until = async (expression: string) => {
      for (let i = 0; i < 100; i++) { if (await page.evaluate(expression)) return; await sleep(50); }
      assert.fail(`Viewer did not reach: ${expression}`);
    };
    await until(`Boolean(document.querySelector('[aria-label="Open image 1"]'))`);
    await page.evaluate(`document.querySelector('[aria-label="Open image 1"]').click()`);
    await until(`document.querySelector('[role="dialog"] img')?.naturalWidth === 1`);
    await until(`Boolean(document.querySelector('[aria-label="Next image"]'))`);
    await page.evaluate(`document.querySelector('[aria-label="Next image"]').click()`);
    await until(`Boolean(document.querySelector('[role="dialog"] a'))`);
    assert.deepEqual(await page.evaluate("window.opened"),[]);
    const point = await page.evaluate<{x:number;y:number}>(`(() => {
      const r = document.querySelector('[role="dialog"] a').getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    await page.click(point.x,point.y);
    assert.deepEqual(await page.evaluate("window.opened"),[["https://images.example.invalid/remote.png","_blank","noopener,noreferrer"]]);
    const requests = await page.evaluate<string[]>("window.requests");
    assert.ok(requests.every(path => path.startsWith("/api/history/sessions/fixture/sample/images/")),"only opaque image reads are sent");
  } finally { await page.close(); rmSync(temp,{recursive:true,force:true}); }
});
