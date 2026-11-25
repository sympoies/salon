import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

// Keep this fixture's Chrome transport inside the UI package, like the other
// interactive browser fixtures. The profile directory is owned by this test.
async function launchToolFixture(profile: string) {
  const browser = spawn(process.env.CHROME_BIN ?? "google-chrome",[
    "--headless","--disable-gpu","--no-sandbox","--hide-scrollbars","--mute-audio",
    "--remote-debugging-port=0",`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check",
    "--force-color-profile=srgb","--lang=en-US","about:blank",
  ],{stdio:["ignore","ignore","pipe"]});
  let socket: WebSocket | undefined;
  const close = async () => {
    socket?.close();
    if (browser.exitCode !== null || browser.signalCode !== null) return;
    const exited = new Promise<void>(resolve => browser.once("exit",() => resolve()));
    browser.kill("SIGKILL"); await exited;
  };
  try {
    const endpoint = await new Promise<string>((resolve,reject) => {
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("Chrome debugging endpoint timed out")),10000);
      browser.stderr.on("data",data => {
        stderr += data.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]!); }
      });
      browser.once("error",error => { clearTimeout(timeout); reject(error); });
      browser.once("exit",() => { clearTimeout(timeout); reject(new Error(`Chrome exited before debugging was ready: ${stderr}`)); });
    });
    const pages = await (await fetch(new URL("/json/list",endpoint.replace("ws:","http:")))).json() as Array<{type:string;webSocketDebuggerUrl:string}>;
    const page = pages.find(item => item.type === "page"); assert.ok(page);
    const connection = new WebSocket(page.webSocketDebuggerUrl); socket = connection;
    await new Promise<void>((resolve,reject) => { connection.onopen = () => resolve(); connection.onerror = () => reject(new Error("Chrome connection failed")); });
    let id = 0;
    let loaded: (() => void) | undefined;
    const pending = new Map<number,{resolve:(value:any) => void;reject:(error:Error) => void}>();
    connection.onmessage = event => {
      const reply = JSON.parse(String(event.data)), waiter = pending.get(reply.id);
      if (waiter) { pending.delete(reply.id); reply.error ? waiter.reject(new Error(reply.error.message)) : waiter.resolve(reply.result); }
      if (reply.method === "Page.loadEventFired") { loaded?.(); loaded = undefined; }
    };
    connection.onclose = () => { pending.forEach(waiter => waiter.reject(new Error("Chrome connection closed"))); pending.clear(); };
    const send = (method: string, params: object = {}) => new Promise<any>((resolve,reject) => {
      const request = ++id; pending.set(request,{resolve,reject}); connection.send(JSON.stringify({id:request,method,params}));
    });
    await send("Page.enable");
    return {
      setViewport:(width: number,height: number,mobile: boolean) => send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile}),
      navigate:async (url: string) => {
        const done = new Promise<void>(resolve => { loaded = resolve; });
        await send("Page.navigate",{url}); await done;
      },
      evaluate:async <T,>(expression: string): Promise<T> => {
        const result = await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
        assert.equal(result.exceptionDetails,undefined,"tool fixture executes successfully"); return result.result.value;
      },
      send,
      screenshot:async () => Buffer.from((await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false})).data,"base64"),
      close,
    };
  } catch (error) { await close(); throw error; }
}

// Exercise hit testing and native pointer input; button.click() bypasses both.
test("tool rows toggle from the chevron and left padding with pointer input in live and saved conversations", { timeout: 60000 }, async t => {
  assert.equal(hasHeadlessChrome(), true, "headless Chrome is required");
  const bundled = await build({
    root: fileURLToPath(new URL("..", import.meta.url)), resolve: { conditions: ["source"] }, configFile: false, logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "tool-chevron-fixture",
      resolveId(id) { if (id.endsWith("tool-chevron-fixture")) return "\0tool-chevron-fixture"; },
      load(id) {
        if (id !== "\0tool-chevron-fixture") return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {HistoryConversationView} from '/src/HistoryConversation.tsx';
          const tool=(id,text)=>({id,role:'assistant',text,timestamp:'2026-01-01T12:00:00Z',tool_parts:[
            {kind:'tool_call',id:id+'-call',call_id:id,name:'exec_command',input_summary:'pnpm test '+('example-'.repeat(40)),status:'ok'},
            {kind:'tool_result',id:id+'-result',call_id:id,summary:'12 tests passed',status:'ok'}]});
          const messages=[tool('first',''),tool('continuation',''),tool('mixed','Checked the example.'),
            {id:'reply',role:'assistant',text:'The example is ready.',timestamp:'2026-01-01T12:00:00Z'}];
          const conversation={session:{id:'history',machine:'fixture',provider:'codex'},latestMessagePaging:location.hash==='#live',loading:false,viewportRef:{current:null},messages};
          createRoot(document.querySelector('#root')).render(React.createElement(HistoryConversationView,{conversation,onJumpToLatest(){}}));`;
      },
    }],
    build: { write: false, minify: false, target: "esnext", lib: { entry: "tool-chevron-fixture", name: "Fixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8") + output.output
    .filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => item.source).join("\n");
  const temp = mkdtempSync(join(tmpdir(), "tool-chevron-"));
  const page = await launchToolFixture(temp);
  const evidence = process.env.SALON_UI_EVIDENCE_DIR;
  const until = async (expression: string) => {
    for (let i = 0; i < 200; i++) {
      if (await page.evaluate<boolean>(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`Tool fixture did not settle: ${expression}`);
  };
  try {
    const file = join(temp, "fixture.html");
    writeFileSync(file, `<!doctype html><html data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${css}html,body{margin:0}#root{padding:12px}.history-messages{height:auto;overflow:visible}</style><div id="root"></div><script>${code.replaceAll("</script", "<\\/script")}</script>`);
    for (const [width, height] of [[384, 832], [390, 844], [1280, 900]] as const) {
      for (const live of [true, false]) for (const input of ["mouse", "touch"]) {
        await t.test(`${live ? "live" : "saved"} ${width}x${height} ${input}`, async t => {
          await page.setViewport(width, height, width < 600 && input === "touch");
          await page.send("Emulation.setTouchEmulationEnabled", { enabled: input === "touch", maxTouchPoints: 1 });
          await page.navigate(`file://${file}?${width}-${input}#${live ? "live" : "saved"}`);
          const group = ".conversation-tool-group-toggle";
          await until(`document.querySelector('${group}') && document.querySelectorAll('.conversation-tool-toggle').length===3`);

          const checkToggle = async (selector: string, edge: "chevron" | "left padding", capture = false) => {
            for (const expanded of [true, false]) {
              // Chrome can keep :active briefly after a tap. Measure the idle
              // hit area, not the previous tap's pressed bounds.
              await until(`!document.querySelector('${selector}').matches(':active')`);
              const point = await page.evaluate<{x:number;y:number;hit:boolean;target:string}>(`(() => {
                const button = document.querySelector('${selector}');
                const box = (${edge === "chevron" ? "button.querySelector('svg')" : "button"}).getBoundingClientRect();
                const x = ${edge === "chevron" ? "box.left + box.width / 2" : "Math.ceil(box.left) + 1"};
                const y = box.top + box.height / 2;
                const target = document.elementFromPoint(x, y);
                return {x, y, hit: button.contains(target), target: target?.tagName ?? 'none'};
              })()`);
              const { x, y } = point;
              assert.equal(point.hit, true, `${edge} hits its toggle before pressing: ${point.target}`);
              if (input === "mouse") {
                await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
              } else {
                await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
              }
              const pressedHit = await page.evaluate<boolean>(`document.querySelector('${selector}').contains(document.elementFromPoint(${x}, ${y}))`);
              if (input === "mouse") {
                await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
              } else {
                await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
              }
              const state = await page.evaluate<{expanded:string;hidden:boolean}>(`new Promise(resolve => {
                const start = performance.now(), button = document.querySelector('${selector}');
                function read() {
                  const expanded = button.getAttribute('aria-expanded');
                  if (expanded === '${expanded}' || performance.now() - start >= 500) {
                    resolve({expanded, hidden: document.getElementById(button.getAttribute('aria-controls')).hidden});
                  } else requestAnimationFrame(read);
                }
                read();
              })`);
              if (capture && evidence && expanded) {
                mkdirSync(evidence, { recursive: true });
                writeFileSync(join(evidence, `${live ? "live" : "saved"}-${width}-after-release.png`), await page.screenshot());
              }
              assert.deepEqual({ pressedHit, ...state }, { pressedHit: true, expanded: String(expanded), hidden: !expanded },
                `${edge} stays within its toggle during the press and ${expanded ? "opens" : "closes"} its content on release`);
            }
          };

          for (const edge of ["chevron", "left padding"] as const) {
            await t.test(`group ${edge}`, () => checkToggle(group, edge, width === 390 && input === "touch" && edge === "left padding"));
          }
          // Open the group if necessary to expose the individual controls.
          await page.evaluate(`if (document.querySelector('${group}').getAttribute('aria-expanded') === 'false') document.querySelector('${group}').click()`);
          await until(`document.querySelector('${group}').getAttribute('aria-expanded')==='true'`);
          for (const id of ["first", "continuation", "mixed"]) {
            const selector = `[data-history-message-id="${id}"] .conversation-tool-toggle`;
            await t.test(`${id} chevron`, () => checkToggle(selector, "chevron"));
          }
          await t.test("mixed single row left padding", () =>
            checkToggle('[data-history-message-id="mixed"] .conversation-tool-toggle', "left padding"));
        });
      }
    }
  } finally { await page.close(); rmSync(temp, { recursive: true, force: true }); }
});
