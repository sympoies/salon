import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderUsage } from "../src/api.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

const now = 1_800_000_000_000;
const providers: ProviderUsage[] = [{
  provider: "codex", account: "fixture", label: "Codex", ok: true, stale: false, plan: "pro",
  windows: [{ key: "5h", label: "5h", used_percent: 8, window_minutes: 300, resets_at: now / 1000 + 7200 }],
  updated_at: now / 1000, note: null, error: null, reason_code: null,
}];

interface CdpResponse { id?: number; result?: Record<string, unknown>; error?: { message?: string } }

const waitForExit = (child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
  const onExit = () => {
    clearTimeout(timeout);
    resolve(true);
  };
  const timeout = setTimeout(() => {
    child.off("exit", onExit);
    resolve(false);
  }, timeoutMs);
  child.once("exit", onExit);
});

test("pressing the in-flow quota bar preserves its hit target and opens anchored Usage", async t => {
  const probe = spawnSync(process.env.CHROME_BIN ?? "google-chrome", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) { t.skip("headless Chrome unavailable"); return; }

  const userData = mkdtempSync(join(tmpdir(), "agent-console-usage-press-chrome-"));
  const chrome = spawn(process.env.CHROME_BIN ?? "google-chrome", [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${userData}`,
    "--window-size=2000,1300", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chrome.stderr?.on("data", () => {});
  const harness = createUiSsrHarness();
  let socket: WebSocket | null = null;
  try {
    const { HeaderUsageReadout } = await harness.loadModule<typeof import("../src/HeaderUsage.tsx")>("/src/HeaderUsage.tsx");
    const usage = renderComponent(HeaderUsageReadout, { providers, now, onOpen() {} })
      .replace('class="header-usage"', 'class="header-usage" style="display:inline-flex;left:50vw;top:28px"');
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const frameHtml = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
      <main class="dash workspace-shell"><header class="dash-head workspace-head">
        <div class="workspace-head-start"><div class="brand-title"><span class="brand-title-mark">A</span><h1>Agent Console</h1></div></div>
        ${usage}<div class="dash-actions"><button>New</button></div>
      </header></main><script>
        window.__usageClickTarget = "none";
        document.querySelector(".header-usage").addEventListener("click", event => {
          window.__usageClickTarget = event.target.closest(".header-usage") ? "button" : "other";
          const anchor = event.currentTarget.getBoundingClientRect();
          const panel = document.createElement("section");
          panel.className = "modal page-overlay usage-anchored";
          panel.style.setProperty("--usage-anchor-center", (anchor.left + anchor.width / 2) + "px");
          panel.style.setProperty("--usage-anchor-bottom", anchor.bottom + "px");
          panel.setAttribute("role", "dialog");
          panel.textContent = "Usage details";
          document.body.append(panel);
        });
      </script>`;
    const outerHtml = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body><script>
      const frame = document.createElement("iframe");
      frame.id = "fixture";
      frame.style.cssText = "display:block;border:0;width:1800px;height:1169px";
      frame.srcdoc = ${JSON.stringify(frameHtml).replaceAll("<", "\\u003c")};
      document.body.append(frame);
    </script>`;
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(outerHtml)}`;

    const activePortFile = join(userData, "DevToolsActivePort");
    const deadline = Date.now() + 8_000;
    let port = "";
    let wsPath = "";
    while (Date.now() < deadline) {
      try {
        [port, wsPath] = readFileSync(activePortFile, "utf8").trim().split("\n");
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(port && wsPath, "Chrome exposes its local DevTools endpoint");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find(target => target.type === "page");
    assert.ok(page, "Chrome creates a page target");

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket!.addEventListener("open", () => resolve(), { once: true });
      socket!.addEventListener("error", () => reject(new Error("Chrome DevTools WebSocket failed")), { once: true });
    });
    let commandId = 0;
    const pending = new Map<number, (response: CdpResponse) => void>();
    socket.addEventListener("message", event => {
      const response = JSON.parse(String(event.data)) as CdpResponse;
      if (response.id !== undefined) pending.get(response.id)?.(response);
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<CdpResponse> => new Promise((resolve, reject) => {
      const id = ++commandId;
      pending.set(id, response => {
        pending.delete(id);
        if (response.error) reject(new Error(response.error.message ?? `${method} failed`));
        else resolve(response);
      });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string): Promise<unknown> => {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return (response.result?.result as { value?: unknown } | undefined)?.value;
    };
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: dataUrl });
    let fixtureReady = false;
    const readyDeadline = Date.now() + 5_000;
    while (Date.now() < readyDeadline) {
      fixtureReady = await evaluate("Boolean(document.querySelector('#fixture')?.contentDocument?.querySelector('.header-usage'))") as boolean;
      if (fixtureReady) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(fixtureReady, `production header fixture loads at 1800px: ${JSON.stringify(await evaluate("({state:document.readyState,frameCount:document.querySelectorAll('iframe').length,frameError:document.querySelector('#fixture')?.contentDocument?.location?.href ?? 'inaccessible'})"))}`);

    const before = await evaluate(`(() => {
      const frame=document.querySelector('#fixture'), doc=frame.contentDocument, button=doc.querySelector('.header-usage');
      const r=button.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height,cx:frame.getBoundingClientRect().left+frame.clientLeft+r.left+r.width/2,cy:frame.getBoundingClientRect().top+frame.clientTop+r.top+r.height/2,localCx:r.left+r.width/2,localCy:r.top+r.height/2,
        target:doc.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('.header-usage') ? 'button' : 'other'};
    })()`);
    assert.ok(before && typeof before === "object", "button geometry is available");
    const initial = before as { x: number; y: number; width: number; height: number; cx: number; cy: number; localCx: number; localCy: number; target: string };
    assert.equal(initial.target, "button", "pointer starts over the quota button");

    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: initial.cx, y: initial.cy });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: initial.cx, y: initial.cy, button: "left", clickCount: 1 });
    const pressed = await evaluate(`(() => {
      const doc=document.querySelector('#fixture').contentDocument, button=doc.querySelector('.header-usage'), r=button.getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height,
        target:doc.elementFromPoint(${initial.localCx},${initial.localCy})?.closest('.header-usage') ? 'button' : 'other',
        active:button.matches(':active')};
    })()`);
    assert.ok(pressed && typeof pressed === "object", "pressed geometry is available");
    const held = pressed as { x: number; y: number; width: number; height: number; target: string; active: boolean };
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: initial.cx, y: initial.cy, button: "left", clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const after = await evaluate(`(() => {
      const frame=document.querySelector('#fixture'), doc=frame.contentDocument, button=doc.querySelector('.header-usage');
      const r=button.getBoundingClientRect(), panel=doc.querySelector('[role="dialog"]');
      return {x:r.x,y:r.y,width:r.width,height:r.height,clickTarget:doc.defaultView.__usageClickTarget,
        panelTop:panel?.getBoundingClientRect().top ?? null};
    })()`);
    assert.ok(after && typeof after === "object", "released geometry is available");
    const released = after as { x: number; y: number; width: number; height: number; clickTarget: string; panelTop: number | null };
    assert.equal(held.active, true, "real pointer press activates the quota button");
    assert.equal(held.target, "button", `press keeps the initial pointer over the quota button (held rect ${held.x},${held.y},${held.width}x${held.height})`);
    assert.equal(released.clickTarget, "button", "pointer release dispatches click to the quota button");
    assert.ok(released.panelTop !== null, "click opens Usage details");
    assert.deepEqual(
      { x: released.x, y: released.y, width: released.width, height: released.height },
      { x: initial.x, y: initial.y, width: initial.width, height: initial.height },
      "after release, the quota button returns to its original bounding box",
    );
  } finally {
    socket?.close();
    chrome.kill("SIGTERM");
    if (!await waitForExit(chrome, 5_000)) {
      chrome.kill("SIGKILL");
      await waitForExit(chrome, 5_000);
    }
    await harness.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
