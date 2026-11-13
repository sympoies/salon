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

test("shared conversation tools align with text and disclose results in live and saved views, themes and tiers", async t => {
  assert.equal(hasHeadlessChrome(), true, "headless Chrome is required for this acceptance fixture");
  const built = await build({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "history-tools-fixture",
      resolveId(id) { if (id.endsWith("history-tools-fixture")) return "\0history-tools-fixture"; },
      load(id) {
        if (id !== "\0history-tools-fixture") return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {HistoryConversationView} from '/src/HistoryConversation.tsx'; import '/src/styles.css';
          const messages=[
            {id:'call',role:'assistant',text:'',tool_parts:[{kind:'tool_call',id:'call-item',call_id:'command',name:'exec_command',input_summary:'pnpm test '+('long-argument-'.repeat(35)),...(window.ownerTools?{owner_input_summary:'cat /work/example/notes.txt'}:{}),status:'ok'}]},
            {id:'result',role:'assistant',text:'',tool_parts:[{kind:'tool_result',id:'result-item',call_id:'command',summary:'12 tests passed <script>unsafe()</script>',...(window.ownerTools?{owner_summary:'Read /work/example: 12 tests passed <script>unsafe()</script>'}:{}),status:'ok'}]},
            {id:'edit',role:'assistant',text:'Updated the example.',tool_parts:[
              {kind:'tool_call',id:'edit-item',call_id:'edit',name:'apply_patch',input_summary:'[path]',status:'ok'},
              {kind:'tool_result',id:'diff-item',call_id:'edit',summary:'--- a/example.txt\\n+++ b/example.txt\\n@@ -1 +1 @@\\n-old example\\n+new example',status:'ok',truncated:true}]},
            {id:'orphan',role:'assistant',text:'',tool_parts:[{kind:'tool_result',id:'orphan-item',call_id:'outside-page',summary:'Earlier call failed',status:'error'}]},
            {id:'reply',role:'assistant',text:'The example is ready.'}].map(message=>({...message,timestamp:'2026-01-01T12:00:00Z'}));
          const conversation={session:{id:'history',machine:'fixture',provider:'codex'},latestMessagePaging:window.liveConversation,loading:false,viewportRef:{current:null},messages};
          createRoot(document.querySelector('#root')).render(React.createElement(HistoryConversationView,{conversation,onJumpToLatest(){}}));
          setTimeout(()=>{const buttons=[...document.querySelectorAll('.conversation-tool-toggle')];
            const collapsed=buttons.every(button=>button.getAttribute('aria-expanded')==='false');
            if(window.expandTools) buttons.forEach(button=>button.click());
            setTimeout(()=>{const pre=document.querySelector('.conversation-tool-diff'); const add=pre?.querySelector('.is-added'); const remove=pre?.querySelector('.is-removed');
              const bounds=node=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom}};
              const timestamps=[...document.querySelectorAll('.conversation-tools')].map(node=>{
                const row=node.closest('article'),time=row.querySelector('time');
                return {content:bounds(node),time:time ? bounds(time) : null,count:row.querySelectorAll('time').length};
              });
              const reply=document.querySelector('[data-history-message-id="reply"]');
              window.publish({width:innerWidth,height:innerHeight,collapsed,count:buttons.length,timestamps,
                reply:{content:bounds(reply.querySelector('.history-bubble')),time:bounds(reply.querySelector('time'))},
                tools:[...document.querySelectorAll('.conversation-tools')].map(node=>node.getBoundingClientRect().left),
                bubbles:[...document.querySelectorAll('.history-bubble')].map(node=>node.getBoundingClientRect().left),
                labels:buttons.map(button=>button.getAttribute('aria-label')),
                open:[...document.querySelectorAll('.conversation-tool-toggle')].every(button=>button.getAttribute('aria-expanded')==='true'),
                command:document.querySelector(".conversation-tool-command")?.textContent,
                ownerResult:document.querySelector(".conversation-tool-result")?.textContent.includes("Read /work/example"),
                result:document.querySelector('#root').textContent.includes('12 tests passed <script>unsafe()</script>'),
                diff:!!pre,added:add?.textContent,removed:remove?.textContent,
                distinctColors:!!add&&getComputedStyle(add).backgroundColor!==getComputedStyle(remove).backgroundColor,
                truncated:document.querySelector('#root').textContent.includes('Result truncated'),
                error:document.querySelector('#root').textContent.includes('Earlier call failed'),
                unsafe:!!document.querySelector('#root script'),
                overflow:document.documentElement.scrollWidth>innerWidth,
                within:[...document.querySelectorAll('.conversation-tools')].every(node=>node.getBoundingClientRect().right<=innerWidth),
                focusable:buttons.every(button=>button.tagName==='BUTTON'&&button.tabIndex===0),
                emptyBubbles:[...document.querySelectorAll('.history-bubble')].filter(node=>!node.textContent.trim()).length});
            },100);
          },150);`;
      },
    }],
    build: { write: false, minify: false, target: "esnext", lib: { entry: "history-tools-fixture", name: "Fixture", formats: ["iife"] } },
  });
  const output = Array.isArray(built) ? built[0] : built;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "history-tools-"));
  const evidence = process.env.SALON_UI_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  try {
    for (const width of [384, 1280]) for (const live of [true, false]) for (const theme of ["dark", "paper"]) for (const expanded of [false, true]) {
      const height = width === 384 ? 832 : 900;
      const name = `tools-${live ? "live" : "saved"}-${width}-${theme}-${expanded ? "expanded" : "collapsed"}`;
      const file = join(temp, `${name}.html`);
      const frame = `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}html,body{margin:0}#root{padding:12px}.history-messages{height:auto;overflow:visible}</style><div id="root"></div><script>
        window.ownerTools=${theme === "dark"};window.liveConversation=${live};window.expandTools=${expanded};window.publish=value=>parent.document.querySelector('#result').textContent=JSON.stringify(value);
        window.onerror=error=>window.publish({error:String(error)});${code.replaceAll("</script", "<\\/script")}</script>`;
      writeFileSync(file, `<!doctype html><style>html,body{margin:0}iframe{border:0;display:block}</style><iframe width="${width}" height="${height}"></iframe><pre id="result" hidden></pre><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<", "\\u003c")}</script>`);
      const browser = spawnSync(process.env.CHROME_BIN ?? "google-chrome", [
        "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files",
        `--window-size=${Math.max(width, 800)},${height}`, "--virtual-time-budget=5000",
        ...(evidence ? [`--screenshot=${join(evidence, `${name}.png`)}`] : []), "--dump-dom", `file://${file}`,
      ], { encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(browser.status, 0, browser.error?.message ?? browser.stderr);
      const json = browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1];
      assert.ok(json, "browser publishes the rendered fixture result");
      const result = JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
      if (evidence) writeFileSync(join(evidence, `${name}.json`), JSON.stringify(result, null, 2));
      await t.test(name, () => {
        assert.equal(result.error, expanded ? true : false, "orphan result remains inspectable when its call is outside the page");
        assert.equal(result.width, width);
        assert.equal(result.height, height);
        for (const row of [...result.timestamps, result.reply]) {
          assert.equal(row.time !== null, true, "content has a timestamp");
          assert.equal(row.time.left >= row.content.right, true, "timestamp sits to the right after content");
          assert.equal(row.time.top >= row.content.top && row.time.bottom <= row.content.bottom, true, "timestamp stays alongside content, not on a line above it");
        }
        for (const row of result.timestamps) assert.equal(row.count, 1, "tool timestamp appears once");
        assert.equal(result.tools.length, 3);
        assert.equal(result.bubbles.length, 2, "mixed tool/text row and final reply remain visible");
        for (const left of result.tools) assert.equal(left, result.bubbles[1], "every tool row shares the final reply content column");
        assert.equal(result.bubbles[0], result.bubbles[1], "mixed tool/text row uses the same content column");
        assert.equal(result.count, 3, "one disclosure per call and one unmatched result");
        assert.equal(result.labels[0], "exec_command");
        assert.equal(result.labels[1], "apply_patch");
        assert.equal(result.collapsed, true);
        assert.equal(result.focusable, true);
        assert.equal(result.result, expanded);
        assert.equal(result.diff, expanded);
        assert.equal(result.truncated, expanded);
        assert.equal(result.unsafe, false);
        assert.equal(result.overflow, false);
        assert.equal(result.within, true);
        assert.equal(result.emptyBubbles, 0);
        if (expanded) {
          assert.equal(result.open, true);
          assert.equal(result.command, theme === "dark" ? "cat /work/example/notes.txt" : "pnpm test " + "long-argument-".repeat(35));
          assert.equal(result.ownerResult, theme === "dark");
          assert.equal(result.added, "+new example");
          assert.equal(result.removed, "-old example\n");
          assert.equal(result.distinctColors, true);
        }
      });
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
