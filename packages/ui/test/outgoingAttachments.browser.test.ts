import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

test("outgoing attachments show original names and local raster previews at phone and desktop widths", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const built = await build({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "outgoing-attachments-fixture",
      resolveId(id) { if (id.endsWith("outgoing-attachments-fixture")) return "\0outgoing-attachments-fixture"; },
      load(id) {
        if (id !== "\0outgoing-attachments-fixture") return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {OutgoingBubble} from '/src/OutgoingBubble.tsx';
          import {HistoryConversationView} from '/src/HistoryConversation.tsx';
          import '/src/styles.css';
          const canvas=document.createElement('canvas');canvas.width=240;canvas.height=100;
          const c=canvas.getContext('2d');c.fillStyle='#dbeafe';c.fillRect(0,0,240,100);
          c.fillStyle='#1e3a8a';c.font='18px sans-serif';c.fillText('Synthetic design draft',16,55);
          const blob=new Blob([Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0))],{type:'image/png'});
          window.IntersectionObserver=class{constructor(callback){this.callback=callback}observe(){this.callback([{isIntersecting:true}])}disconnect(){}};
          window.fetch=async()=>new Response(blob,{headers:{'content-type':'image/png'}});
          const path='/fixture/sessions/sample/attachments/stored.png';
          const attachment={path,original_name:'Design draft.png',preview:blob};
          const image=(i,name)=>({id:'a'.repeat(16)+'.0.'+i+'.'+'b'.repeat(32),...(name?{original_name:name}:{})});
          const messages=[{id:'named',role:'user',text:'',images:[image(0,'Design draft.png')]},
            {id:'unnamed',role:'user',text:'Caption with no filename metadata',images:[image(1)]}];
          const outgoing=(status,text,attachments)=>React.createElement('article',{key:status,className:'history-message is-user history-outgoing-reply','data-status':status},
            React.createElement('div',{className:'history-outgoing-body'},
              React.createElement(OutgoingBubble,{uploadSessionId:'sample',text,attachments}),
              React.createElement('p',{className:'history-outgoing-note'},status)));
          createRoot(document.querySelector('#root')).render(React.createElement(React.Fragment,null,
            React.createElement('h2',null,'Outgoing attachments'),
            React.createElement('section',{className:'history-messages'},
              outgoing('Pending',"'"+path+"'",[attachment]),
              outgoing('Refused',"'"+path+"'\\nPlease review this draft.",[attachment]),
              outgoing('Document',"'/fixture/sessions/sample/attachments/stored.txt'",[{path:'/fixture/sessions/sample/attachments/stored.txt',original_name:'Project notes.txt'}])),
            React.createElement('h2',null,'History'),
            React.createElement(HistoryConversationView,{conversation:{session:{machine:'fixture',id:'sample'},messages,latestMessagePaging:true,loading:false,viewportRef:{current:null}},onJumpToLatest(){}})));
          const wait=condition=>new Promise((resolve,reject)=>{let left=200;function check(){if(condition())resolve();else if(--left)setTimeout(check,10);else reject(Error('fixture did not settle'));}check()});
          void(async()=>{try{
            await wait(()=>document.querySelectorAll('.conversation-image-thumbnail img').length===2);
            await new Promise(resolve=>setTimeout(resolve,100));
            const previews=[...document.querySelectorAll('.outgoing-attachment-preview')];
            window.publish({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,
              chips:[...document.querySelectorAll('.attachment-chip')].map(n=>n.textContent),
              history:[...document.querySelectorAll('.history-image-label')].map(n=>n.textContent),
              files:[...document.querySelectorAll('.file-card-name')].map(n=>n.textContent),
              previews:previews.length,decoded:previews.every(n=>n.complete&&n.naturalWidth>0)});
          }catch(error){window.publish({error:String(error)})}})();`;
      },
    }],
    build: { write: false, minify: false, target: "esnext", lib: { entry: "outgoing-attachments-fixture", name: "Fixture", formats: ["iife"] } },
  });
  const output = Array.isArray(built) ? built[0] : built;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "outgoing-attachments-"));
  try {
    for (const width of [384, 1280]) {
      const file = join(temp, `fixture-${width}.html`);
      const frame = `<!doctype html><style>${css}html,body{margin:0}h2{padding:8px;font-size:16px}.history-messages{height:auto;overflow:visible}#root{padding:8px}</style><div id="root"></div><script>
        window.publish=value=>parent.document.querySelector('#result').textContent=JSON.stringify(value);
        window.onerror=error=>window.publish({error:String(error)});${code.replaceAll("</script", "<\\/script")}</script>`;
      writeFileSync(file, `<!doctype html><style>html,body{margin:0}iframe{border:0;display:block}</style><iframe width="${width}" height="1050"></iframe><pre id="result" hidden></pre><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<", "\\u003c")}</script>`);
      const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
      if (evidence) mkdirSync(evidence, { recursive: true });
      const browser = spawnSync(process.env.CHROME_BIN ?? "google-chrome", [
        "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files",
        `--window-size=${Math.max(width, 800)},1050`, "--virtual-time-budget=5000",
        ...(evidence ? [`--screenshot=${join(evidence, `outgoing-attachments-${width}.png`)}`] : []),
        "--dump-dom", `file://${file}`,
      ], { encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(browser.status, 0, browser.error?.message ?? browser.stderr);
      const json = browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1];
      assert.ok(json, "browser publishes the rendered fixture result");
      const result = JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
      await t.test(`${width}px`, () => {
        assert.equal(result.error, undefined);
        assert.equal(result.width, width);
        assert.equal(result.overflow, false);
        assert.deepEqual(result.chips, ["Design draft.png", "Design draft.png"]);
        assert.deepEqual(result.files, ["Project notes.txt"]);
        assert.deepEqual(result.history, ["Design draft.png", "Image"]);
        assert.equal(result.previews, 2);
        assert.equal(result.decoded, true);
      });
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
