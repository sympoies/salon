import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("non-image file cards retain names, extensions and stacking at phone and desktop widths", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const descriptor = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/history-file-part-v1.json", import.meta.url), "utf8"));
  const built = await build({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "file-cards-fixture",
      resolveId(id) { if (id.endsWith("file-cards-fixture")) return "\0file-cards-fixture"; },
      load(id) {
        if (id !== "\0file-cards-fixture") return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {OutgoingBubble} from '/src/OutgoingBubble.tsx';
          import {HistoryConversationView} from '/src/HistoryConversation.tsx';
          import '/src/styles.css';
          const root='/fixture/sessions/sample/attachments/';
          const video={path:root+'stored-video.mp4',original_name:'Demo recording.mp4',bytes:2097152};
          const doc={path:root+'stored-document.pdf',original_name:'Project proposal.pdf',bytes:1024};
          const long={path:root+'stored-long.pdf',original_name:'Quarterly project proposal with detailed implementation notes and supporting appendices for review.pdf',bytes:10240};
          const archive={path:root+'stored-archive.zip'};
          const generic={path:root+'stored-generic.bin',original_name:'Build output.bin'};
          const quote=file=>"'"+file.path+"'";
          const rows=[['Video',[video],''],['Document',[doc],''],['Long name',[long],''],['Several files',[video,archive],'Review these files.'],['Text plus file',[generic],'Build output for review.']];
          const elements=rows.map(([label,attachments,text])=>React.createElement('article',{key:label,className:'history-message is-user history-outgoing-reply'},
            React.createElement('time',null,'12:00'),React.createElement('div',{className:'history-outgoing-body'},
              React.createElement(OutgoingBubble,{uploadSessionId:'sample',text:attachments.map(quote).join('\\n')+(text?'\\n'+text:''),attachments}))));
          elements.push(React.createElement(HistoryConversationView,{key:'history',onJumpToLatest(){},conversation:{
            session:{id:'history',machine:'fixture',provider:'codex'},latestMessagePaging:true,loading:false,viewportRef:{current:null},
            messages:[{id:'message',role:'user',text:quote({path:doc.path}),files:[${JSON.stringify(descriptor)}],timestamp:'2026-11-01T12:00:00Z'}]}}));
          createRoot(document.querySelector('#root')).render(React.createElement(React.Fragment,null,React.createElement('h2',null,'Synthetic file cards'),React.createElement('section',{className:'history-messages'},elements)));
          const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right}};
          setTimeout(()=>{const cards=[...document.querySelectorAll('.file-card')];
            window.publish({charset:document.characterSet,parentCharset:parent.document.characterSet,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
              literal:document.querySelector('#root').textContent.includes('[File')||document.querySelector('#root').textContent.includes('stored-'),
              cards:cards.map(card=>{const name=card.querySelector('.file-card-name'),stem=card.querySelector('.file-card-stem'),extension=card.querySelector('.file-card-extension');
                return {name:name?.textContent,details:card.querySelector('.file-card-details')?.textContent,box:rect(card),bubble:rect(card.closest('.history-bubble')),time:rect(card.closest('article').querySelector('time')),
                  icon:rect(card.querySelector('.file-card-kind')),radius:getComputedStyle(card).borderRadius,border:getComputedStyle(card).borderWidth,
                  stem:stem?{overflow:stem.scrollWidth>stem.clientWidth,ellipsis:getComputedStyle(stem).textOverflow,nowrap:getComputedStyle(stem).whiteSpace}:null,
                  extension:extension?{text:extension.textContent,box:rect(extension)}:null};}),
              textFirst:[...document.querySelectorAll('.history-outgoing-body')].slice(3).every(body=>!body.textContent.trim().startsWith('Demo recording')&&!body.textContent.trim().startsWith('Build output.bin'))});
          },150);`;
      },
    }],
    build: { write: false, minify: false, target: "esnext", lib: { entry: "file-cards-fixture", name: "Fixture", formats: ["iife"] } },
  });
  const output = Array.isArray(built) ? built[0] : built;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  let html = "";
  // Omit transport charset so the documents must declare their own encoding.
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const width of [384, 1280]) {
      const frame = `<!doctype html><meta charset="utf-8"><style>${css}html,body{margin:0}h2{padding:8px;font-size:16px}.history-messages{height:auto;overflow:visible}#root{padding:8px}</style><div id="root"></div><script>
        window.publish=value=>parent.document.querySelector('#result').textContent=JSON.stringify(value);
        window.onerror=error=>window.publish({error:String(error)});${code.replaceAll("</script", "<\\/script")}</script>`;
      html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}iframe{border:0;display:block}</style><iframe width="${width}" height="1050"></iframe><pre id="result" hidden></pre><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<", "\\u003c")}</script>`;
      const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
      if (evidence) mkdirSync(evidence, { recursive: true });
      const browser = await promisify(execFile)(process.env.CHROME_BIN ?? "google-chrome", [
        "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
        `--window-size=${Math.max(width, 800)},1050`, "--virtual-time-budget=5000",
        ...(evidence ? [`--screenshot=${join(evidence, `file-cards-${width}.png`)}`] : []),
        "--dump-dom", `http://127.0.0.1:${address.port}/`,
      ], { encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
      const json = browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1];
      assert.ok(json, "browser publishes the rendered fixture result");
      const result = JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
      await t.test(`${width}px`, () => {
        assert.equal(result.error, undefined);
        assert.equal(result.width, width);
        assert.equal(result.overflow, false);
        assert.equal(result.literal, false);
        assert.equal(result.cards.length, 7);
        const details = ["Video · 2 MB", "Document · 1 KB", "Document · 10 KB", "Video · 2 MB", "Archive", "File", "Document · 5 B"];
        for (const [index, expected] of details.entries()) assert.equal(result.cards[index].details, expected);
        assert.equal(result.parentCharset, "UTF-8");
        assert.equal(result.charset, "UTF-8");
        assert.equal(result.cards.at(-1).name, "notes.txt", "delivered history reads the frozen descriptor name");
        assert.equal(result.textFirst, true);
        for (const card of result.cards) {
          assert.ok(card.box.w <= 320 && card.box.right <= width);
          assert.ok(card.bubble.w <= 320, "file-only bubbles stay at the requested maximum width");
          assert.ok(card.time.right <= card.bubble.x, "timestamp stays left of the file-card bubble");
          assert.equal(card.icon.w, 20);
          assert.equal(card.radius, "8px");
          assert.equal(card.border, "0px");
        }
        const long = result.cards[2];
        assert.equal(long.stem.overflow, true);
        assert.equal(long.stem.ellipsis, "ellipsis");
        assert.equal(long.stem.nowrap, "nowrap");
        assert.equal(long.extension.text, ".pdf");
        assert.ok(long.extension.box.right <= long.box.right);
        assert.ok(Math.abs(result.cards[4].box.y - (result.cards[3].box.y + result.cards[3].box.h) - 6) < 1);
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
