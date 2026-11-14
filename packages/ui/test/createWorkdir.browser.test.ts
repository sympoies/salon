import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { launchPage } from "../../../scripts/readme-previews/chrome.ts";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

const explanation = "Review folder trust for /work/example before retrying.";

test("New session preserves typed directories and shows startup refusals at phone and desktop widths", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import React, {useState} from "react";
    import {createRoot} from "react-dom/client";
    import {CreateDialog} from "/src/CreateDialog.tsx";
    import {createSession} from "/src/api.ts";
    window.creates=[];
    window.fetch=async (url, init) => {
      if (init?.method === "POST") {
        window.creates.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ok:false,error:{code:"start-failed",message:"session creation failed",
          details:{reason:"startup-trust-required",message:${JSON.stringify(explanation)}}}}),{status:500});
      }
      return new Response(JSON.stringify({ok:true,data:{items:[]}}),{status:200});
    };
    function Fixture() {
      const [error,setError]=useState();
      return React.createElement(CreateDialog, {machines:["fixture"],busy:false,error,onClose(){},
        async onCreate(machine,body) { const result=await createSession(machine,body); setError(result.error); }});
    }
    createRoot(document.querySelector("#root")).render(React.createElement(Fixture));
  `;
  const bundled = await build({
    configFile: false, logLevel: "silent", define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "create-workdir-fixture",
      resolveId(id) { if (id.endsWith("create-workdir-fixture")) return "\0create-workdir-fixture"; },
      load(id) { if (id === "\0create-workdir-fixture") return fixture; },
    }],
    build: { write: false, minify: false, lib: { entry: "create-workdir-fixture", name: "CreateWorkdirFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const page = await launchPage();
  const results: Array<{ width: number; cwd?: string; error: string; relativeError: string; relativeDisabled: boolean; count: number; overflow: number }> = [];
  const wait = (condition: string) => page.evaluate(`new Promise((resolve,reject)=>{
    let attempts=300; const check=()=>{if(${condition})resolve(true);else if(--attempts)setTimeout(check,10);else reject(new Error("fixture timed out"));}; check();
  })`);
  const typeDirectory = (value: string) => page.evaluate(`(()=>{
    const input=document.querySelector('input[role="combobox"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event("input",{bubbles:true}));
  })()`);
  try {
    for (const width of [390, 1280]) {
      await page.setViewport(width, 900, 1);
      await page.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div>`)}`);
      await page.evaluate(code);
      await wait(`document.querySelector('input[role="combobox"]')`);
      await typeDirectory("/work/example");
      await wait(`document.querySelector('input[role="combobox"]').value === "/work/example"`);
      await page.evaluate(`document.querySelector('.modal-actions .btn:not(.ghost)').click()`);
      await wait(`document.querySelector('.err')`);
      await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const directory = process.env.CREATE_DIALOG_CAPTURE_DIR;
      if (directory) writeFileSync(join(directory, `create-workdir-${width}.png`), await page.screenshot());
      const submitted = await page.evaluate<{cwd?: string; error: string; overflow: number}>(`({
        cwd:window.creates[0]?.cwd,error:document.querySelector('.err').textContent,
        overflow:document.documentElement.scrollWidth-innerWidth
      })`);
      await typeDirectory("work/example");
      await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const relative = await page.evaluate<{relativeError:string; relativeDisabled:boolean; count:number}>(`({
        relativeError:document.querySelector('[role="alert"]')?.textContent??"",
        relativeDisabled:document.querySelector('.modal-actions .btn:not(.ghost)').disabled,
        count:window.creates.length
      })`);
      results.push({width,...submitted,...relative});
    }
  } finally { await page.close(); }
  for (const result of results) {
    await t.test(`${result.width}px dialog`, () => {
      assert.equal(result.cwd, "/work/example");
      assert.equal(result.error, `start-failed / startup-trust-required: ${explanation}`);
      assert.equal(result.relativeError, "Working directory must be an absolute path starting with /.");
      assert.equal(result.relativeDisabled, true);
      assert.equal(result.count, 1);
      assert.equal(result.overflow, 0);
    });
  }
});
