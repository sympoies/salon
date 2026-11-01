import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

const ui = new URL("..", import.meta.url).pathname;

test("overview filters open on demand with expanded toggleable facets and staged Apply/Clear", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {SessionListNavigator} from '/src/SessionListNavigator.tsx';
    import {CLEAR_SESSION_FILTERS} from '/src/sessionFilters.ts';
    window.commits=[];
    function Fixture(){
      const [filters,setFilters]=useState(CLEAR_SESSION_FILTERS);
      window.refreshFilters=()=>setFilters(current=>({...current,hosts:current.hosts?[...current.hosts]:null,roles:current.roles?[...current.roles]:null}));
      return React.createElement('main',{className:'dash workspace-shell'},
        React.createElement('header',{className:'workspace-head'},
          React.createElement('div',{className:'workspace-head-start'},
            React.createElement('div',{className:'brand-title'},React.createElement('button',{className:'brand-title-mark'}),React.createElement('h1',{},'Agent Console')),
            React.createElement(SessionListNavigator,{filters,mobile:innerWidth<=760,machines:['host-a','host-b'],roles:['role-a','role-b'],harnesses:[{id:'codex',label:'Codex'},{id:'claude',label:'Claude'}],resultCount:4,countsAvailable:true,
              page:1,pageCount:2,onPageChange(){},onChange(next){window.commits.push(next);setFilters(next);}})),
          React.createElement('div',{className:'dash-actions'},React.createElement('button',{className:'btn'},'New'))),
        React.createElement('section',{className:'fixture-grid'},'Session grid'));
    }
    createRoot(document.querySelector('#root')).render(React.createElement(Fixture));
  `;
  const bundle = await build({ root: ui, configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), {
    name: "overview-filter-fixture",
    resolveId(id) { if (id.endsWith("overview-filter-fixture")) return "\0overview-filter-fixture"; },
    load(id) { if (id === "\0overview-filter-fixture") return fixture; },
  }], build: { write: false, minify: false, lib: { entry: "overview-filter-fixture", name: "OverviewFixture", formats: ["iife"] } } });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = readFileSync(join(ui, "src/styles.css"), "utf8");
  for (const width of [1280, 1440, 412]) await t.test(`${width}x900`, () => {
    const temp = mkdtempSync(join(tmpdir(), "agent-console-overview-filters-"));
    try {
      const probe = `
        const wait=()=>new Promise(resolve=>setTimeout(resolve,30));
        const check=(value,message)=>{if(!value)throw new Error(message)};
        const query=selector=>{const node=document.querySelector(selector);check(node,'missing '+selector);return node};
        const panel=()=>document.querySelector('.session-filter-panel');
        const click=async node=>{node.click();await wait()};
        const select=async (label,value)=>{const node=query('select[aria-label="'+label+'"]');node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));await wait()};
        async function run(){
          for(let i=0;i<80&&!document.querySelector('.session-list-navigator');i++)await wait();
          check(!panel(),'overview must have no inline filter form by default');
          const trigger=query('.session-filters-trigger');
          check(trigger.getAttribute('aria-label').startsWith('Filter sessions.'),'existing Filter sessions control remains');
          check(trigger.getAttribute('aria-expanded')==='false','trigger starts collapsed');
          const gridTop=query('.fixture-grid').getBoundingClientRect().top;
          await click(trigger);
          check(panel()?.getAttribute('role')==='dialog','opening Filters shows Session filters dialog');
          check(trigger.getAttribute('aria-expanded')==='true','trigger reports open panel');
          for(const dimension of ['hosts','roles']){
            const section=query('[data-filter-dimension="'+dimension+'"]');
            check(section.open,dimension+' starts expanded inside the panel');
            check(section.querySelector('input').getBoundingClientRect().height>0,dimension+' checkbox list is visible');
            await click(section.querySelector('summary'));
            check(!section.open,dimension+' can collapse');
            await click(section.querySelector('summary'));
            check(section.open,dimension+' can expand again');
          }
          check(query('.fixture-grid').getBoundingClientRect().top===gridTop,'opening panel does not move session grid');
          await click(query('[data-filter-dimension="harnesses"] input[value="codex"]'));
          await click(query('[data-filter-dimension="hosts"] input[value="host-a"]'));
          await click(query('[data-filter-dimension="roles"] input[value="role-b"]'));
          const repo=query('input[aria-label="Repository"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(repo,' staged-repo ');
          repo.dispatchEvent(new Event('input',{bubbles:true}));await wait();
          check(window.commits.length===0,'field edits remain staged');
          window.refreshFilters();await wait();
          check(repo.value===' staged-repo '&&query('[data-filter-dimension="harnesses"] input[value="codex"]').checked,'unchanged polling preserves staged values');
          await click(query('[data-status-group="working"]'));
          check(repo.value===' staged-repo ','immediate status change preserves staged repository');
          const actions=()=>query('.session-filter-panel-actions');
          await click(actions().querySelector('.primary'));
          check(!panel(),'Apply closes panel');
          const applied=window.commits.at(-1);
          check(applied.harnesses.join()==='codex'&&applied.repo==='staged-repo'&&applied.hosts.join()==='host-a'&&applied.roles.join()==='role-b'&&applied.statusGroup==='working','Apply commits complete preserved draft');
          check(document.querySelectorAll('.session-filter-search-chips .session-filter-chip').length===5,'closed control shows compact active-filter chips');
          await click(trigger);
          check(query('input[aria-label="Repository"]').value==='staged-repo','reopening shows applied values');
          await click(query('[data-filter-dimension="hosts"] .session-filter-facet-all'));
          window.refreshFilters();await wait();
          await click(actions().querySelector('.primary'));
          check(window.commits.at(-1).hosts===null,'All hosts reset stays staged through cloned arrays and Apply');
          await click(trigger);
          await click(query('[data-filter-dimension="harnesses"] .session-filter-facet-all'));
          await click(actions().querySelector('.btn'));
          check(!panel(),'Clear closes panel');
          const cleared=window.commits.at(-1);
          check(cleared.hosts===null&&cleared.roles===null&&cleared.harnesses===null&&cleared.repo===''&&cleared.statusGroup===null,'Clear resets every applied dimension');
          check(document.querySelectorAll('.session-filter-search-chips .session-filter-chip').length===0,'Clear removes active indication');
          await click(trigger);
          await click(query('[data-filter-dimension="harnesses"] input[value="codex"]'));
          await click(actions().querySelector('.btn'));
          await click(trigger);
          check(!query('[data-filter-dimension="harnesses"] input[value="codex"]').checked,'Clear discards draft even when applied filters already clear');
          await click(query('.session-filter-panel-heading button'));
          check(!panel(),'close control dismisses panel');
          check(document.documentElement.scrollWidth<=innerWidth,'overview has no horizontal overflow');
          parent.document.querySelector('#measurement').textContent=JSON.stringify({passed:true,width:innerWidth});
        }
        run().catch(error=>parent.document.querySelector('#measurement').textContent=JSON.stringify({error:error.message}));
      `;
      const frame = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${code};${probe}</script>`;
      const path = join(temp, "fixture.html");
      writeFileSync(path, `<!doctype html><pre id="measurement"></pre><script>const frame=document.createElement('iframe');frame.style.cssText='border:0;width:${width}px;height:900px';frame.srcdoc=${JSON.stringify(frame).replaceAll("<", "\\u003c")};document.body.append(frame);</script>`);
      const result = spawnSync(process.env.CHROME_BIN ?? "google-chrome", ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--window-size=1600,1100", "--virtual-time-budget=6000", "--dump-dom", `file://${path}`], { encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 0, result.stderr);
      const raw = result.stdout.match(/<pre id="measurement">(.+?)<\/pre>/s)?.[1];
      assert.ok(raw, "mounted browser fixture finishes");
      const measured = JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
      assert.equal(measured.error, undefined, measured.error);
      assert.equal(measured.passed, true);
      assert.equal(measured.width, width);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
