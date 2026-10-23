import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { updateHeaderCountAvailability, sameHeaderCountAvailability } from "../src/headerCountAvailability.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { CLEAR_SESSION_FILTERS } from "../src/sessionFilters.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const online = [{ name: "fixture-a", ok: true }, { name: "fixture-b", ok: true }];
const lost = [{ name: "fixture-a", ok: true }, { name: "fixture-b", ok: false }];

test("all-online counts retain both machines without a partial marker", () => {
  const state = updateHeaderCountAvailability(new Map(), online, true, 0);
  assert.equal(state.available, true);
  assert.deepEqual([...state.includedMachines], ["fixture-a", "fixture-b"]);
  assert.deepEqual(state.offlineMachines, []);
});

test("offline counts are held through the grace boundary, then only reachable contributions remain", () => {
  const initial = updateHeaderCountAvailability(new Map(), online, true, 0);
  const dropped = updateHeaderCountAvailability(initial.observations, lost, true, 1000);
  const held = updateHeaderCountAvailability(dropped.observations, lost, true, 61000);
  assert.deepEqual([...held.includedMachines], ["fixture-a", "fixture-b"]);
  assert.deepEqual(held.offlineMachines, [{ name: "fixture-b", since: 1000, held: true }]);
  const partial = updateHeaderCountAvailability(held.observations, lost, true, 61001);
  assert.equal(partial.available, true);
  assert.deepEqual([...partial.includedMachines], ["fixture-a"]);
  assert.deepEqual(partial.offlineMachines, [{ name: "fixture-b", since: 1000, held: false }]);
});

test("explicitly retired machines never affect availability or the partial marker", () => {
  const prior = updateHeaderCountAvailability(new Map(), online, true, 0);
  const retired = updateHeaderCountAvailability(prior.observations, [online[0]!, { name: "fixture-b", ok: false, active: false }], true, 70000);
  assert.equal(retired.available, true);
  assert.deepEqual([...retired.includedMachines], ["fixture-a"]);
  assert.deepEqual(retired.offlineMachines, []);
  assert.equal(retired.observations.has("fixture-b"), false);
});

test("first-time offline machines do not invent held zero counts", () => {
  const state = updateHeaderCountAvailability(new Map(), [{ name: "fixture-b", ok: false }], true, 1000);
  assert.equal(state.available, false);
  assert.equal(state.includedMachines.size, 0);
  assert.deepEqual(state.offlineMachines, [{ name: "fixture-b", since: 1000, held: false }]);
});

test("whole-request failures age held counts and recovery starts a fresh outage clock", () => {
  const initial = updateHeaderCountAvailability(new Map(), online, true, 0);
  const failed = updateHeaderCountAvailability(initial.observations, [], false, 1000);
  assert.equal(failed.includedMachines.size, 2);
  const expired = updateHeaderCountAvailability(failed.observations, [], false, 61001);
  assert.equal(expired.available, false);
  assert.equal(expired.includedMachines.size, 0);
  const recovered = updateHeaderCountAvailability(expired.observations, online, true, 62000);
  assert.deepEqual(recovered.offlineMachines, []);
  const lostAgain = updateHeaderCountAvailability(recovered.observations, lost, true, 63000);
  assert.deepEqual(lostAgain.offlineMachines, [{ name: "fixture-b", since: 63000, held: true }]);
});

test("host scope changes prune old observations and unchanged polls preserve render equality", () => {
  const initial = updateHeaderCountAvailability(new Map(), online, true, 0);
  const unchanged = updateHeaderCountAvailability(initial.observations, online, true, 1000);
  assert.equal(sameHeaderCountAvailability(initial, unchanged), true);
  const scoped = updateHeaderCountAvailability(unchanged.observations, [online[0]!], true, 2000);
  assert.equal(scoped.observations.size, 1);
  assert.equal(sameHeaderCountAvailability(initial, scoped), false);
  const empty = updateHeaderCountAvailability(scoped.observations, [], true, 3000);
  assert.equal(empty.available, true);
  assert.equal(empty.includedMachines.size, 0);
});

test("actual header renders reachable counts with a tap detail, and all-online rendering stays unmarked", async () => {
  const harness = createUiSsrHarness();
  try {
    const { SessionFiltersBar } = await harness.loadModule<typeof import("../src/SessionFiltersBar.tsx")>("/src/SessionFiltersBar.tsx");
    const rows = online.map((machine, i) => ({ machine: machine.name, session_id: `session-${i}`, created_at: "2030-01-01T00:00:00Z", status: "running", turn_state: { phase: "working" } }));
    const props = { filters: CLEAR_SESSION_FILTERS, records: rows, countsAvailable: true, onChange() {}, machines: online.map(m => m.name), harnesses: [], resultCount: 2, compactHeader: true, mobile: true };
    const partial = renderComponent(SessionFiltersBar, { ...props, countRecords: rows.slice(0, 1), offlineCountMachines: [{ name: "fixture-b", since: 1000, held: false }] });
    assert.match(partial, /Working: 1 session \(partial counts\)/);
    assert.match(partial, /<span>1<\/span>/);
    assert.doesNotMatch(partial, /<span>\d+\*<\/span>/);
    assert.match(partial, /<summary[^>]*aria-label="Partial session counts"/);
    assert.match(partial, /fixture-b/);
    assert.match(partial, /dateTime="1970-01-01T00:00:01\.000Z"/);
    assert.match(partial, /\(excluded\)/);
    const full = renderComponent(SessionFiltersBar, props);
    assert.match(full, /Working: 2 sessions/);
    assert.doesNotMatch(full, /Partial session counts|partial counts|header-counts-notice/);
    const source = readFileSync(new URL("../src/Dashboard.tsx", import.meta.url), "utf8");
    assert.match(source, /updateHeaderCountAvailability\(counted, res\.machines, res\.ok, nowMs\)/);
    assert.match(source, /countRecords=\{overviewCountRecords\}/);
    assert.match(source, /headerCounts\.includedMachines\.has\(session\.machine\)/);
  } finally { await harness.close(); }
});

test("partial header counters and tap detail stay inside phone and desktop widths", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `import React from 'react';import {createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{SessionFiltersBar}from'/src/SessionFiltersBar.tsx';import{CLEAR_SESSION_FILTERS}from'/src/sessionFilters.ts';
    flushSync(()=>createRoot(document.querySelector('#root')).render(React.createElement(SessionFiltersBar,{filters:CLEAR_SESSION_FILTERS,countsAvailable:true,onChange(){},machines:['fixture-a','fixture-b'],harnesses:[],resultCount:39,compactHeader:true,mobile:innerWidth<=760,statusCounts:{working:12,waiting:24,attention:2,stopped:1},offlineCountMachines:[{name:'fixture-b',since:1000,held:false}]})));`;
  // The preceding SSR harness can set NODE_ENV=development. Keep React's
  // runtime mode aligned with the JSX mode Vite chooses in that environment.
  const bundle = await build({root:new URL("..",import.meta.url).pathname,configFile:false,logLevel:"silent",define:{"process.env.NODE_ENV":JSON.stringify(process.env.NODE_ENV ?? "production")},plugins:[react(),{
    name:"partial-count-mounted",resolveId(id){if(id.endsWith("partial-count-mounted"))return"\0partial-count-mounted";},load(id){if(id==="\0partial-count-mounted")return fixture;},
  }],build:{write:false,minify:false,lib:{entry:"partial-count-mounted",name:"PartialCountFixture",formats:["iife"]}}});
  const output=Array.isArray(bundle)?bundle[0]:bundle;assert.ok(output&&"output"in output);
  const code=output.output.filter(x=>x.type==="chunk").map(x=>x.code).join("\n");
    for (const [width, mobile] of [[320, true], [412, true], [761, false], [1280, false]] as const) {
      const m = measureUiMarkup<{ bounded: boolean; detailBounded: boolean; markerHeight: number; counts: string[]; partialTitles: boolean; partialAria: boolean; marker: string; diagnostic?: string }>(`<div id="root"></div><script>window.addEventListener('error',e=>window.fixtureError=e.message);${code}</script>`, width, `
        const result={};let tries=80;function sample(){const row=document.querySelector('.session-status-counts'),notice=row?.querySelector('details');if(!notice){if(--tries)setTimeout(sample,20);else parent.document.querySelector('#measurement').textContent=JSON.stringify({viewportWidth:innerWidth,diagnostic:'mounted count notice unavailable',pageError:window.fixtureError,html:document.querySelector('#root').innerHTML});return;}notice.querySelector('summary').click();setTimeout(()=>{
          const summary=notice.querySelector('summary').getBoundingClientRect(),detail=notice.querySelector('.header-counts-detail').getBoundingClientRect();
          parent.document.querySelector('#measurement').textContent=JSON.stringify({viewportWidth:innerWidth,counts:[...row.querySelectorAll('.session-status-count')].map(button=>button.querySelector('span').textContent),partialTitles:[...row.querySelectorAll('.session-status-count')].every(button=>button.title.includes('(partial counts)')),partialAria:[...row.querySelectorAll('.session-status-count')].every(button=>button.getAttribute('aria-label').includes('(partial counts)')),marker:notice.querySelector('summary').textContent,bounded:[...row.querySelectorAll('button,summary')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),detailBounded:notice.open&&detail.left>=0&&detail.right<=innerWidth,markerHeight:summary.height});
        },50);}sample();
      `, false, 800, mobile ? ["--blink-settings=primaryPointerType=2,availablePointerTypes=2"] : []);
      console.log(JSON.stringify(m));
      assert.equal(m.diagnostic, undefined);
      assert.deepEqual(m.counts, ["12", "24", "2", "1"], `${width}: offline counts have no trailing asterisk`);
      assert.equal(m.partialTitles, true, `${width}: partial-count tooltip retained`);
      assert.equal(m.partialAria, true, `${width}: partial-count accessible text retained`);
      assert.equal(m.marker, "!", `${width}: offline indicator retained`);
      assert.equal(m.bounded, true, `${width}: complete targets fit`);
      assert.equal(m.detailBounded, true, `${width}: offline detail fits`);
      assert.equal(m.markerHeight, mobile ? 40 : 34);
    }
});
