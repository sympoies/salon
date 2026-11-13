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

test("Show tool calls defaults on, toggles both conversation views immediately and survives reload", async t => {
  assert.equal(hasHeadlessChrome(), true, "headless Chrome is required");
  const built = await build({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "show-tool-calls-fixture",
      resolveId(id) { if (id.endsWith("show-tool-calls-fixture")) return "\0show-tool-calls-fixture"; },
      load(id) {
        if (id !== "\0show-tool-calls-fixture") return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {MailboxRowSettings} from '/src/MailboxRowSettings.tsx';
          import {HistoryConversationView} from '/src/HistoryConversation.tsx';
          import {syncPhoneTier} from '/src/phoneTier.ts'; import '/src/styles.css';
          syncPhoneTier();
          const messages=[
            {id:'call',role:'assistant',text:'',tool_parts:[{kind:'tool_call',id:'call-item',call_id:'command',name:'exec_command',input_summary:'pnpm test',status:'ok'}]},
            {id:'result',role:'assistant',text:'',tool_parts:[{kind:'tool_result',id:'result-item',call_id:'command',summary:'12 tests passed',status:'ok'}]},
            {id:'user',role:'user',text:'Check the example.'},
            {id:'mixed',role:'assistant',text:'Updated the example.',tool_parts:[{kind:'tool_call',id:'edit-item',call_id:'edit',name:'apply_patch',input_summary:'example.txt',status:'ok'}]},
            {id:'orphan',role:'assistant',text:'',tool_parts:[{kind:'tool_result',id:'orphan-item',summary:'Earlier call finished',status:'ok'}]},
            {id:'attachment',role:'user',text:"See the file.\\n'/fixture/sessions/sample/attachments/stored.txt'",files:[{kind:'file',id:'file',original_name:'example.txt',mime:'text/plain',bytes:12}]},
            {id:'reply',role:'assistant',text:'The example is ready.'}
          ].map(message=>({...message,timestamp:'2026-01-01T12:00:00Z'}));
          const original=JSON.stringify(messages);let requests=0;
          window.fetch=()=>{requests++;return Promise.reject(new Error('No network expected'));};
          const conversation=live=>({session:{id:live?'live':'saved',machine:'fixture',provider:'codex'},latestMessagePaging:live,loading:false,viewportRef:{current:null},messages});
          createRoot(document.querySelector('#root')).render(React.createElement(React.Fragment,null,
            React.createElement(MailboxRowSettings),...[true,false].map(live=>React.createElement('section',{'data-view':live?'live':'saved',key:String(live)},
              React.createElement('h2',null,live?'Live conversation':'Saved conversation'),
              React.createElement(HistoryConversationView,{conversation:conversation(live),onJumpToLatest(){}})))));
          const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
          const toggle=()=>document.querySelector('[role="switch"][aria-label="Show tool calls"]');
          const measure=()=>({checked:toggle()?.getAttribute('aria-checked'),focusable:toggle()?.tabIndex===0,
            switchWithin:!!toggle()&&toggle().getBoundingClientRect().right<=innerWidth,
            labelWithin:[...document.querySelectorAll('.settings-preference-label')].every(node=>node.getBoundingClientRect().right<=innerWidth),
            overflow:document.documentElement.scrollWidth>innerWidth,
            views:[...document.querySelectorAll('[data-view]')].map(view=>({
              tools:view.querySelectorAll('.conversation-tool-toggle').length,
              rows:[...view.querySelectorAll('article')].map(node=>node.dataset.historyMessageId).join(','),
              text:[...view.querySelectorAll('article:not([data-history-message-id="attachment"]) .history-bubble')].map(node=>node.textContent).join('|'),
              times:[...view.querySelectorAll('article:not([data-history-message-id="call"]):not([data-history-message-id="orphan"]) time')].map(node=>node.dateTime).join(','),
              days:view.querySelectorAll('.history-day-separator').length,
              attachment:view.querySelector('.file-card-name')?.textContent,
              aligned:[...view.querySelectorAll('.history-bubble')].filter(node=>node.closest('article').getAttribute('aria-label')==='codex').map(node=>node.getBoundingClientRect().left)
            }))});
          (async()=>{await pause();const initial=measure();const capture=parent.capture;
            if(!toggle()){window.publish({missing:true,initial});return;}
            if(parent.reloaded){window.publish({reloaded:initial,requests,unchanged:original===JSON.stringify(messages)});return;}
            toggle().click();await pause();const off=measure();
            if(capture==='reload'){parent.location.search='?reloaded=1';return;}
            if(capture==='off'){window.publish({initial,off,requests,unchanged:original===JSON.stringify(messages)});return;}
            toggle().click();await pause();const restored=measure();
            window.publish({initial,off,restored,requests,unchanged:original===JSON.stringify(messages)});
          })().catch(error=>window.publish({error:String(error)}));`;
      },
    }],
    build: { write: false, minify: false, target: "esnext", lib: { entry: "show-tool-calls-fixture", name: "Fixture", formats: ["iife"] } },
  });
  const output = Array.isArray(built) ? built[0] : built;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "show-tool-calls-"));
  const evidence = process.env.SALON_UI_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  try {
    for (const width of [384, 760, 761, 1280]) for (const capture of ["restored", "off", "reload"]) {
      const height = 1400;
      const name = `show-tools-${width}-${capture}`;
      const file = join(temp, `${name}.html`);
      const frame = `<!doctype html><html data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}html,body{margin:0}#root{padding:12px}.history-messages{height:auto;overflow:visible}</style><div id="root"></div><script>window.publish=value=>parent.document.querySelector('#result').textContent=JSON.stringify(value);window.onerror=error=>window.publish({error:String(error)});${code.replaceAll("</script", "<\\/script")}</script>`;
      writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0}iframe{border:0;display:block}</style><iframe width="${width}" height="${height}"></iframe><pre id="result" hidden></pre><script>window.capture=${JSON.stringify(capture)};window.reloaded=location.search.includes('reloaded=1');document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<", "\\u003c")}</script>`);
      const browser = spawnSync(process.env.CHROME_BIN ?? "google-chrome", [
        "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files",
        `--window-size=${Math.max(width, 800)},${height}`, "--virtual-time-budget=5000",
        ...(evidence ? [`--screenshot=${join(evidence, `${name}.png`)}`] : []), "--dump-dom", `file://${file}`,
      ], { encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(browser.status, 0, browser.error?.message ?? browser.stderr);
      const json = browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1];
      assert.ok(json, "browser publishes acceptance measurements");
      const result = JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
      if (evidence) writeFileSync(join(evidence, `${name}.json`), JSON.stringify(result, null, 2));
      await t.test(name, () => {
        assert.equal(result.error, undefined);
        assert.equal(result.missing, undefined, "Conversation settings exposes the named Show tool calls switch");
        assert.equal(result.requests, 0, "toggling never fetches history");
        assert.equal(result.unchanged, true, "source messages are unchanged");
        const off = capture === "reload" ? result.reloaded : result.off;
        assert.equal(off.checked, "false");
        for (const state of capture === "reload" ? [off] : [result.initial, off, ...(result.restored ? [result.restored] : [])]) {
          assert.equal(state.focusable, true);
          assert.equal(state.switchWithin, true);
          assert.equal(state.labelWithin, true);
          assert.equal(state.overflow, false);
          assert.equal(state.views.length, 2);
          for (const view of state.views) {
            assert.equal(view.tools, state.checked === "true" ? 3 : 0);
            assert.equal(view.days, 1, "a hidden leading tool row does not remove the day separator");
            assert.equal(view.text, "Check the example.|Updated the example.|The example is ready.");
            assert.equal(view.times.split(',').length, 4);
            assert.equal(view.attachment, "example.txt");
            assert.equal(view.aligned.length, 2);
            assert.equal(view.aligned[0], view.aligned[1]);
          }
        }
        for (const view of off.views) assert.equal(view.rows, "user,mixed,attachment,reply", "no empty tool rows or timestamps remain");
        if (capture !== "reload") {
          assert.equal(result.initial.checked, "true", "default on");
          if (result.restored) assert.equal(result.restored.checked, "true", "on restores all tool rows immediately");
        }
      });
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
