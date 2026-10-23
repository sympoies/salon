import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

// A midpoint-only range assertion misses a partially painted sixth line.
// The explicit line-height cases model divergence from the font-size formula;
// they do not claim to reproduce Android's native font metrics.
for (const width of [360]) {
  test(`${width}px prompt clipping follows computed lines and paints no sixth-line pixels`, async (t) => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    const temp = mkdtempSync(join(tmpdir(), "agent-console-prompt-clipping-"));
    const browser = spawn(process.env.CHROME_BIN ?? "google-chrome", [
      "--headless", "--disable-gpu", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${temp}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let socket: WebSocket | undefined;
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
      const pages = await (await fetch(new URL("/json/list", endpoint.replace("ws:", "http:")))).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = pages.find(item => item.type === "page"); assert.ok(page);
      socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket!.addEventListener("open", () => resolve(), { once: true });
        socket!.addEventListener("error", reject, { once: true });
      });
      let id = 0;
      const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
      socket.addEventListener("message", event => {
        const reply = JSON.parse(String(event.data)), waiter = pending.get(reply.id);
        if (waiter) { pending.delete(reply.id); reply.error ? waiter.reject(new Error(JSON.stringify(reply.error))) : waiter.resolve(reply.result); }
      });
      const send = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
        const request = ++id; pending.set(request, { resolve, reject }); socket!.send(JSON.stringify({ id: request, method, params }));
      });
      const evaluate = async (expression: string) => {
        const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        assert.equal(result.exceptionDetails, undefined, "browser fixture executes successfully");
        return result.result.value;
      };
      await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 3, mobile: width === 360 });
      const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
      const selector = "mobile-session-card-prompt";
      const prompt = Array.from({ length: 8 }, () => "MMMMMMMMMMMM").join("\n");
      for (const lineHeight of [null, 15, 17]) {
        const { frameTree } = await send("Page.getFrameTree");
        await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>
          html,body{margin:0;background:#000}.capture{width:280px;margin:20px}
          .${selector}{color:#fff;background:#000;${lineHeight ? `line-height:${lineHeight}px;` : ""}}
          </style><div class="capture"><span class="${selector}">${prompt}</span></div>` });
        await evaluate("document.fonts.ready");
        const box = await evaluate(`(()=>{const el=document.querySelector('.${selector}'),r=el.getBoundingClientRect(),css=getComputedStyle(el);
          return {x:r.x,y:r.y,width:r.width,height:r.height,lineHeight:parseFloat(css.lineHeight),overflow:css.overflow,clamp:css.webkitLineClamp,text:el.textContent,viewport:innerWidth}})()`);
        assert.equal(box.viewport, width);
        const shot = await send("Page.captureScreenshot", { clip: { x: box.x, y: box.y, width: box.width, height: Math.max(box.height, 5 * box.lineHeight) + 20, scale: 1 } });
        // Decode Chrome's own raster in a canvas; no PNG library or pixel approximation.
        const raster = await evaluate(`(async()=>{const image=new Image();image.src='data:image/png;base64,${shot.data}';await image.decode();
          const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
          const context=canvas.getContext('2d');context.drawImage(image,0,0);const data=context.getImageData(0,0,image.width,image.height).data;
          const scale=image.width/${box.width},boundary=Math.ceil(${5 * box.lineHeight}*scale),rows=[];let below=0;
          for(let y=0;y<image.height;y++){let ink=0;for(let x=0;x<image.width;x++){const i=(y*image.width+x)*4;if(data[i]>64&&data[i+1]>64&&data[i+2]>64)ink++;}
            if(ink){rows.push(y);if(y>=boundary)below+=ink;}}
          let bands=0,previous=-2;for(const y of rows){if(y>previous+1)bands++;previous=y;}return {below,bands,boundary,width:image.width,height:image.height};})()`);
        const artifact = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
        if (artifact) {
          mkdirSync(artifact, { recursive: true });
          const stem = `prompt-clipping-${width}-${lineHeight ?? "default"}`;
          writeFileSync(join(artifact, `${stem}.png`), Buffer.from(shot.data, "base64"));
          writeFileSync(join(artifact, `${stem}.json`), JSON.stringify({ box, raster }, null, 2));
        }
        assert.equal(raster.below, 0, `no glyph pixels below line five: ${JSON.stringify({ box, raster })}`);
        assert.ok(Math.abs(box.height - 5 * box.lineHeight) <= 1 / 64, `height follows five computed lines: ${JSON.stringify(box)}`);
        assert.equal(box.overflow, "hidden");
        assert.equal(box.clamp, "5");
        assert.equal(raster.bands, 5, "five whole glyph bands remain visible with the ellipsis");
        assert.equal(box.text, prompt, "clipping keeps the underlying prompt intact");
      }
    } finally {
      socket?.close();
      if (browser.exitCode === null && browser.signalCode === null) {
        const exited = new Promise<void>(resolve => browser.once("exit", () => resolve()));
        browser.kill(); await exited;
      }
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
