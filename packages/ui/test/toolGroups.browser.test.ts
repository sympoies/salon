import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";

test("consecutive tool rows collapse and retain their state as live content grows", async t => {
  const built = await build({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
      name: "tool-group-fixture", enforce: "pre", resolveId(id, importer) { if (id.endsWith("tool-group-fixture")) return "\0tool-group-fixture"; if (id === "./api.ts" && importer?.endsWith("HistoryConversation.tsx")) return "\0history-api-fixture"; },
      load(id) { if (id === "\0history-api-fixture") return "export const listHistoryMessages=(...args)=>window.fixtureFetch(...args)"; if (id !== "\0tool-group-fixture") return; return `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {HistoryConversationView,useHistoryConversation} from '/src/HistoryConversation.tsx'; import {saveShowToolCalls} from '/src/toolCallPreference.ts'; import '/src/styles.css';
        const tool=(i)=>({id:'m'+i,role:'assistant',text:'',timestamp:'2026-01-01T12:'+String(13+Math.floor(i/6)).padStart(2,'0')+':00',tool_parts:[{kind:'tool_call',id:'t'+i,call_id:'c'+i,name:i<11?'Bash':i<13?'Read':'Edit',input_summary:'preview '+i,status:i===3?'error':'ok'}]});
        const initial=[{...tool(99),timestamp:'2025-12-31T12:00:00'},{id:'intro',role:'user',text:'Start',timestamp:'2025-12-31T12:12:00'},...Array.from({length:14},(_,i)=>tool(i))];
        function App(){const [messages,setMessages]=React.useState(initial);window.append=()=>setMessages([...initial,tool(14)]);window.clearErrors=()=>setMessages(initial.map(m=>m.tool_parts?{...m,tool_parts:m.tool_parts.map(p=>({...p,status:'ok'}))}:m));return React.createElement(HistoryConversationView,{conversation:{session:{id:'synthetic',machine:'fixture',provider:'codex'},latestMessagePaging:!parent.location.search.includes('saved'),loading:false,viewportRef:{current:null},messages},onJumpToLatest(){},working:!parent.location.search.includes('saved')});}
        let reads=0; window.fixtureFetch=async (_machine,_id,options)=>{if(options.direction==='latest') return {ok:true,messages:[{id:'latest',role:'user',text:'Latest'}],olderCursor:'1'};reads++;return {ok:true,messages:[...Array.from({length:70},(_,i)=>({...tool(1000+reads*100+i),id:'p'+reads+'t'+i})),...Array.from({length:10},(_,i)=>({id:'p'+reads+'v'+i,role:'user',text:'Visible '+reads+' '+i}))],olderCursor:reads<4?String(reads+1):undefined};};
        function Paging(){const c=useHistoryConversation(()=>{});React.useEffect(()=>{void c.open({id:'paging',machine:'fixture',provider:'codex'},true)},[]);return React.createElement('section',{'data-paging':true},React.createElement(HistoryConversationView,{conversation:c,onJumpToLatest(){}}));}
        createRoot(document.querySelector('#root')).render(React.createElement(React.Fragment,null,React.createElement('section',{'data-main':true},React.createElement(App)),React.createElement(Paging)));
        const pause=()=>new Promise(r=>setTimeout(r,100));
        (async()=>{await pause();const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('14 tool calls'));if(parent.location.search.includes('capture'))return;const summary=button?.textContent;const name=button?.getAttribute('aria-label');const collapsed=button?.getAttribute('aria-expanded');const days=[...document.querySelectorAll('[data-main] .history-day-separator')].filter(e=>e.getClientRects().length).length;window.clearErrors();await pause();const noErrors=[...document.querySelectorAll('[data-main] button')].find(b=>b.textContent.includes('14 tool calls'))?.getAttribute('aria-label');button?.click();await pause();const expanded=button?.getAttribute('aria-expanded');const count=document.querySelectorAll('[data-main] .conversation-tool-toggle').length;const single=[...document.querySelectorAll('[data-main] .conversation-tool-toggle')].some(b=>b.textContent.includes('preview 99')); window.append();await pause();const updated=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('15 tool calls'));const kept=updated?.getAttribute('aria-expanded');const preview=updated?.textContent;updated?.click();await pause();const closed=updated?.getAttribute('aria-expanded');saveShowToolCalls(false);await pause();document.querySelector('[data-paging] .history-load-older')?.click();await pause();await pause();const visible=document.querySelectorAll('[data-paging] .history-bubble').length-1;window.publish({missing:!button,summary,name,collapsed,expanded,count,single,kept,closed,preview,days,noErrors,reads,visible,viewport:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth});})().catch(e=>window.publish({error:String(e)}));`;} }],
    build: { write: false, minify: false, target: "esnext", lib: { entry: "tool-group-fixture", name: "Fixture", formats: ["iife"] } } });
  const output = Array.isArray(built) ? built[0] : built; assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = output.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "tool-groups-"));
  try { for (const [width,height] of [[384,832],[1280,900]]) for (const theme of ["dark","paper"]) for (const view of ["live", "saved"]) {
    const file=join(temp, `${width}-${theme}-${view}.html`);
    const frame = `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}html,body{margin:0}</style><div id="root"></div><script>window.publish=v=>parent.document.querySelector('#result').textContent=JSON.stringify(v);${code.replaceAll("</script", "<\\/script")}</script>`;
    writeFileSync(file, `<!doctype html><style>html,body{margin:0}iframe{border:0;display:block}</style><iframe width="${width}" height="${height}"></iframe><pre id="result" hidden></pre><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frame).replaceAll("<", "\\u003c")}</script>`);
    const browser=spawnSync(process.env.CHROME_BIN ?? "google-chrome", ["--headless","--disable-gpu","--no-sandbox","--hide-scrollbars",`--window-size=${Math.max(width,800)},${height}`,"--virtual-time-budget=5000","--dump-dom",`file://${file}?${view}`],{encoding:"utf8",timeout:20000,maxBuffer:16*1024*1024});
    if (process.env.SALON_UI_EVIDENCE_DIR) {
      mkdirSync(process.env.SALON_UI_EVIDENCE_DIR, { recursive: true });
      const shot=spawnSync(process.env.CHROME_BIN ?? "google-chrome", ["--headless","--disable-gpu","--no-sandbox","--hide-scrollbars",`--window-size=${Math.max(width,800)},${height}`,"--virtual-time-budget=1000",`--screenshot=${join(process.env.SALON_UI_EVIDENCE_DIR, `${width}-${theme}-${view}.png`)}`,`file://${file}?${view}&capture`],{encoding:"utf8",timeout:20000});
      assert.equal(shot.status,0,shot.stderr);
    }
    assert.equal(browser.status,0,browser.stderr); const json=browser.stdout.match(/<pre id="result"[^>]*>(.+?)<\/pre>/s)?.[1]; assert.ok(json); const result=JSON.parse(json.replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">"));
    await t.test(`${width} ${theme} ${view}`,()=>{assert.equal(result.viewport,width);assert.equal(result.overflow,false);assert.equal(result.missing,false);assert.match(result.summary,/14 tool calls.*Bash 11.*Read 2.*Edit 1.*12:13–12:15/);assert.match(result.summary,/1 error/);assert.match(result.name,/14 tool calls.*1 error/);assert.equal(result.collapsed,"false");assert.equal(result.days,2);assert.match(result.noErrors,/0 errors/);assert.equal(result.expanded,"true");assert.equal(result.count,15);assert.equal(result.single,true);assert.equal(result.kept,"true");if (view === "live") assert.match(result.preview,/preview 14/);assert.equal(result.closed,"false");});
    await t.test(`${width} ${theme} ${view} hidden paging`,()=>{assert.equal(result.reads,2,JSON.stringify(result));assert.equal(result.visible,20);});
  }} finally { rmSync(temp,{recursive:true,force:true}); }
});
