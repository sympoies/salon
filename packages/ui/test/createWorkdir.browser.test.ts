import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
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
  const temp = mkdtempSync(join(tmpdir(), "salon-create-workdir-"));
  const browser = spawn(process.env.CHROME_BIN ?? "google-chrome", [
    "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${temp}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let socket: WebSocket | undefined;
  const results: Array<{ width: number; cwd?: string; error: string; relativeError: string; relativeDisabled: boolean; count: number; overflow: number }> = [];
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("Chrome debugging endpoint timed out")), 10_000);
      browser.stderr.on("data", data => {
        stderr += data.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]!); }
      });
      browser.once("error", error => { clearTimeout(timeout); reject(error); });
      browser.once("exit", () => { clearTimeout(timeout); reject(new Error("Chrome exited before debugging was ready")); });
    });
    const pages = await (await fetch(new URL("/json/list", endpoint.replace("ws:", "http:")))).json() as Array<{type:string;webSocketDebuggerUrl:string}>;
    const page = pages.find(item => item.type === "page"); assert.ok(page);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once:true }); socket!.addEventListener("error", reject, { once:true }); });
    let id = 0;
    const pending = new Map<number, {resolve:(result:any)=>void;reject:(error:Error)=>void}>();
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data)), waiter = pending.get(reply.id);
      if (waiter) { pending.delete(reply.id); reply.error ? waiter.reject(new Error(JSON.stringify(reply.error))) : waiter.resolve(reply.result); }
    });
    const send = (method:string, params:object = {}) => new Promise<any>((resolve,reject) => {
      const request = ++id; pending.set(request,{resolve,reject}); socket!.send(JSON.stringify({id:request,method,params}));
    });
    const evaluate = async (expression:string) => {
      const result = await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
      assert.equal(result.exceptionDetails,undefined,"browser fixture executes successfully");
      return result.result.value;
    };
    const wait = (condition: string) => evaluate(`new Promise((resolve,reject)=>{
      let attempts=300; const check=()=>{if(${condition})resolve(true);else if(--attempts)setTimeout(check,10);else reject(new Error("fixture timed out"));}; check();
    })`);
    const typeDirectory = (value: string) => evaluate(`(()=>{
      const input=document.querySelector('input[role="combobox"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event("input",{bubbles:true}));
    })()`);
    for (const width of [390, 1280]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div>`)}` });
      await wait(`document.querySelector('#root') && !document.querySelector('input[role="combobox"]')`);
      await evaluate(code);
      await wait(`document.querySelector('input[role="combobox"]')`);
      await typeDirectory("/work/example");
      await wait(`document.querySelector('input[role="combobox"]').value === "/work/example"`);
      await evaluate(`document.querySelector('.modal-actions .btn:not(.ghost)').click()`);
      await wait(`document.querySelector('.err')`);
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const directory = process.env.CREATE_DIALOG_CAPTURE_DIR;
      if (directory) {
        const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        writeFileSync(join(directory, `create-workdir-${width}.png`), Buffer.from(data, "base64"));
      }
      const submitted = await evaluate(`({
        cwd:window.creates[0]?.cwd,error:document.querySelector('.err').textContent,
        overflow:document.documentElement.scrollWidth-innerWidth
      })`);
      await typeDirectory("work/example");
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const relative = await evaluate(`({
        relativeError:document.querySelector('[role="alert"]')?.textContent??"",
        relativeDisabled:document.querySelector('.modal-actions .btn:not(.ghost)').disabled,
        count:window.creates.length
      })`);
      results.push({width,...submitted,...relative});
    }
  } finally {
    socket?.close();
    if (browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise<void>(resolve => browser.once("exit", () => resolve()));
      browser.kill();
      await exited;
    }
    rmSync(temp, { recursive: true, force: true });
  }
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
