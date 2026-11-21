import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { launchPage } from "./support/browserPage.ts";

test("clients with different visible sessions settle without idle layout writes", { timeout: 330000 }, async () => {
  const built = await build({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    logLevel: "silent", resolve: { conditions: ["source"] },
    define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [{
      name: "layout-idle-fixture", enforce: "pre",
      resolveId(source, importer) {
        if (source.endsWith("layout-idle-fixture")) return "\0layout-idle-fixture";
        if (source.endsWith("resourceEvents.ts")) return "\0layout-events";
        if (source.endsWith("api.ts") && importer?.includes("/src/useLayoutSync.ts")) return "\0layout-api";
      },
      load(id) {
        if (id === "\0layout-events") return `export const RESOURCE_RECONCILE_MS=30000; export const resourceEvents={subscribe(_s,change,health){window.changes.push(change);health(true);return ()=>{};}};`;
        if (id === "\0layout-api") return `export const fetchLayoutOrder=async()=>({...window.store});
          export const putLayoutOrder=async(order,options)=>{window.writes.push({order:[...order],reason:options.reason});
            if(options.baseRevision!==window.store.revision)return {...window.store,conflict:true};
            window.store={reachable:true,conflict:false,order:order.slice(0,256),revision:window.store.revision+1};
            setTimeout(()=>window.changes.forEach(fn=>fn()),0);return {...window.store};};`;
        if (id !== "\0layout-idle-fixture") return;
        return `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {useLayoutSync} from '/src/useLayoutSync.ts';
          window.changes=[];window.writes=[];const shared=Array.from({length:2},(_,i)=>({machine:'common',id:'s'+i}));
          window.store={reachable:true,conflict:false,order:Array.from({length:256},(_,i)=>'retired/s'+i),revision:1};window.clients=[];
          const a=[...shared,{machine:'alpha',id:'extra'}],b=[...shared,{machine:'beta',id:'extra'}];
          function Client({sessions,index}){const [slots,setSlots]=useState([]);const result=useLayoutSync({sessions,visible:sessions,slotCount:2,reachableMachineNames:new Set(['common',index?'beta':'alpha']),getKnownMachineNames:()=>new Set(['common',index?'beta':'alpha']),setSlots});window.clients[index]=result;return React.createElement('div');}
          createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(Client,{sessions:a,index:0}),React.createElement(Client,{sessions:b,index:1})));`;
      },
    }], build: { write: false, minify: false, target: "esnext", lib: { entry: "layout-idle-fixture", formats: ["iife"], name: "Fixture" } } });
  const output = Array.isArray(built) ? built[0] : built;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const page = await launchPage({ protocolWaitMs: 320000 });
  try {
    await page.navigate(`data:text/html,${encodeURIComponent(`<div id="root"></div><script>${code}</script>`)}`);
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 7000))");
    const before = await page.evaluate<number>("window.writes.length");
    await page.evaluate(`new Promise(resolve => setTimeout(resolve, ${process.env.LAYOUT_IDLE_LONG ? 300000 : 5000}))`);
    const after = await page.evaluate<number>("window.writes.length");
    assert.equal(after, before, `idle clients continued writing: ${before} to ${after}`);
    assert.equal(after, 0);
    await page.evaluate("window.store={...window.store,order:[],revision:window.store.revision+1};window.changes.forEach(fn=>fn())");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 7000))");
    const settled = await page.evaluate<{writes: number; order: string[]}>("({writes:window.writes.length,order:window.store.order})");
    assert.ok(settled.order.includes("alpha/extra"), "a new live session enters the ranking after cleanup");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 5000))");
    assert.equal(await page.evaluate<number>("window.writes.length"), settled.writes, "clients stay quiet after cleanup");
    await page.evaluate("window.clients[0].applyLayoutLocalOrder(['common/s1','common/s0'], 'overview-reorder')");
    await page.evaluate("new Promise(resolve => setTimeout(resolve, 2000))");
    const result = await page.evaluate<{ writes: number; first: string[]; second: string[] }>(
      "({writes:window.writes.length,first:window.clients[0].orderedSessionKeys.slice(0,2),second:window.clients[1].orderedSessionKeys.slice(0,2)})",
    );
    assert.ok(result.writes > settled.writes && result.writes <= settled.writes + 3, `reorder writes: ${result.writes - settled.writes}`);
    assert.deepEqual(result.first, ["common/s1", "common/s0"]);
    assert.deepEqual(result.second, result.first);
  } finally { await page.close(); }
});
