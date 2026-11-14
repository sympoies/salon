import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const uiRequire = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const { build } = await import(uiRequire.resolve("vite"));
const { default: react } = await import(uiRequire.resolve("@vitejs/plugin-react"));
import { createEdgeServer } from "../../packages/edge/src/server.ts";
import { loadConfig } from "../../packages/edge/src/config.ts";
import { listenOnLoopback } from "../../packages/edge/test/support.ts";
import { launchPage, type Page } from "../readme-previews/chrome.ts";

const dir = mkdtempSync(join(tmpdir(), "device-pairing-browser-"));
before(async () => {
  const previous = process.env.NODE_ENV;
  try {
    const result = await build({ root: fileURLToPath(new URL("../../packages/ui/", import.meta.url)), configFile: false, logLevel: "silent", resolve: { conditions: ["source"] },
      plugins: [react(), { name: "pairing-app-entry",
        resolveId(id: string) { if (id.endsWith("pairing-app-entry")) return "\0pairing-app-entry"; },
        load(id: string) { if (id === "\0pairing-app-entry") return 'import {mountApp} from "/src/mountApp.tsx"; mountApp(document.querySelector("#root"),{appName:"Example Console"});'; },
      }], define: { "process.env.NODE_ENV": JSON.stringify("production"), __AGENT_CONSOLE_APP_VERSION__: JSON.stringify("0.0.0"), __AGENT_CONSOLE_BUILD_SHA__: JSON.stringify("fixture") },
      build: { write: false, target: "esnext", lib: { entry: "pairing-app-entry", name: "PairingApp", formats: ["iife"] } },
    });
    const bundle = Array.isArray(result) ? result[0] : result;
    assert.ok(bundle && "output" in bundle);
    let head = "";
    for (const item of bundle.output) {
      const path = join(dir, item.fileName); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, item.type === "chunk" ? item.code : item.source);
      if (item.type === "chunk" && item.isEntry) head += `<script defer src="/${item.fileName}"></script>`;
      if (item.type === "asset" && item.fileName.endsWith(".css")) head += `<link rel="stylesheet" href="/${item.fileName}">`;
    }
    writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<div id="root"></div>`);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});
after(() => rmSync(dir, { recursive: true }));

async function until(page: Page, expression: string, description: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const visible = await page.evaluate<string[]>("Array.from(document.querySelectorAll('h1,h2,button')).map(element=>element.textContent.trim()).filter(Boolean)");
  assert.fail(`Timed out waiting for ${description}; visible controls: ${JSON.stringify(visible)}`);
}
async function click(page: Page, label: string): Promise<void> {
  const target = `Array.from(document.querySelectorAll('button,summary')).find(button => button.textContent.trim() === ${JSON.stringify(label)} || button.getAttribute('aria-label') === ${JSON.stringify(label)})`;
  await until(page, target, label);
  const point = await page.evaluate<{ x: number; y: number }>(`(() => { const button=${target};button.scrollIntoView({block:'center'});const rect=button.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`);
  await page.click(point.x, point.y);
}
async function capture(page: Page, name: string, selector: string): Promise<void> {
  await page.evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'start'});
    const overlay=element.closest('.page-overlay');if(overlay)overlay.scrollTop=Math.max(0,overlay.scrollTop-80); })()`);
  assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false, "no horizontal overflow");
  if (process.env.SALON_UI_EVIDENCE_DIR) {
    mkdirSync(process.env.SALON_UI_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.SALON_UI_EVIDENCE_DIR, `${name}.png`), await page.screenshot());
  }
}

for (const width of [390, 1280]) test(`two browsers pair, confirm, renew and revoke through the real edge at ${width}px`, async () => {
  let now = Date.now();
  const edge = createEdgeServer(loadConfig({ AGENT_CONSOLE_INSECURE_COOKIE: "1", AGENT_CONSOLE_UI_DIR: dir,
    AGENT_CONSOLE_STATE_DB: join(dir, `state-${width}.sqlite`), AGENT_CONSOLE_PRINCIPALS: JSON.stringify([
      { id: "example-principal", token: "main-fixture", machines: [], permissions: [] },
    ]) }), { authNow: () => now });
  const { base } = await listenOnLoopback(edge);
  const sender = await launchPage();
  const recipient = await launchPage();
  try {
    for (const page of [sender, recipient]) {
      await page.setViewport(width, 1000, 1);
      await page.setEnvironment("UTC", "en-US");
      await page.addInitScript(`localStorage.setItem('ac.themeMode','paper');window.exchangeCount=0;window.authHashClean=true;
        const originalFetch=window.fetch;window.fetch=(input,init)=>{const route=String(input);if(route.includes('/api/auth/'))window.authHashClean&&=!location.hash;
        if(route.endsWith('/pairings/exchange'))window.exchangeCount++;return originalFetch(input,init);};`);
    }
    await sender.navigate(base);
    assert.equal(await sender.evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'main-fixture'})}).then(response=>response.status)`), 200);
    await sender.navigate(base);
    await click(sender, "More"); await click(sender, "Settings");
    await click(sender, "Sign in another device");
    await until(sender, "document.querySelector('.pairing-code')?.textContent", "pairing code");
    const code = await sender.evaluate<string>("document.querySelector('.pairing-code').textContent");
    assert.equal(await sender.evaluate("document.querySelectorAll('.pairing-qr path').length"), 1);
    await capture(sender, `sender-code-${width}`, ".device-pairing");

    if (width === 390) {
      await recipient.navigate(base);
      await until(recipient, "document.querySelector('[data-testid=console-sign-in]')", "existing new-device login page");
      await recipient.evaluate(`location.hash=${JSON.stringify(`pair=${encodeURIComponent(code)}`)}`);
    } else await recipient.navigate(`${base}/#pair=${encodeURIComponent(code)}`);
    await until(recipient, "document.querySelector('[aria-label=\"Pairing code\"]')", "new-device landing");
    assert.equal(await recipient.evaluate("location.hash"), "");
    assert.equal(await recipient.evaluate("window.authHashClean"), true, "fragment is removed before auth/debug requests");
    assert.equal(await recipient.evaluate("document.querySelector('[aria-label=\"Pairing code\"]').value"), code);
    await capture(recipient, `recipient-landing-${width}`, ".login-card");
    await recipient.evaluate("document.querySelector('[aria-label=\"Device name\"]').value='Example tablet'");
    await click(recipient, "Continue");
    await until(recipient, "document.body.textContent.includes('Sign in as example-principal')", "recipient account confirmation");
    assert.equal(await recipient.evaluate("document.querySelector('.device-origin').textContent"), base);
    await until(sender, "document.querySelector('.pairing-verification')", "sender comparison");
    assert.equal(await sender.evaluate("document.querySelector('.pairing-verification').textContent"),
      await recipient.evaluate("document.querySelector('.pairing-verification').textContent"));
    await capture(sender, `sender-approval-${width}`, ".pairing-sender p:has(strong)");
    await capture(recipient, `recipient-consent-${width}`, ".login-card");
    await click(sender, "Approve device");
    assert.equal(await recipient.evaluate("window.exchangeCount"), 0, "remote approval cannot install before recipient consent");
    assert.equal(await recipient.evaluate("fetch('/api/auth/status').then(response=>response.json()).then(value=>value.authenticated)"), false);
    await click(recipient, "Sign in as example-principal");
    await until(recipient, "!document.querySelector('[aria-label=\"New device sign-in\"]')", "recipient sign-in completion");
    assert.equal(await recipient.evaluate("fetch('/api/auth/status').then(response=>response.json()).then(value=>value.authenticated)"), true);
    assert.equal(await recipient.evaluate("document.cookie.includes('ac_session')"), false, "device secret is HttpOnly");
    await until(sender, "document.querySelectorAll('.device-list li').length === 1", "device list refresh");
    await capture(sender, `device-list-${width}`, ".device-pairing");
    const expiry = await sender.evaluate<number>("fetch('/api/auth/devices').then(response=>response.json()).then(value=>value.data.devices[0].expires_at)");
    now += 86_400_000;
    // The main session expires after 12 hours; use the original login path to regain main authority.
    await sender.evaluate("fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'main-fixture'})})");
    await click(sender, "Renew");
    await until(sender, "document.body.textContent.includes('Device renewed for 30 days.')", "explicit renewal");
    assert.equal(await sender.evaluate("fetch('/api/auth/devices').then(response=>response.json()).then(value=>value.data.devices[0].expires_at)"), expiry + 86_400_000);
    await click(sender, "Revoke");
    await until(sender, "document.querySelector('.device-list').textContent.includes('Revoked')", "revocation metadata");
    assert.equal(await recipient.evaluate("fetch('/api/auth/status').then(response=>response.json()).then(value=>value.authenticated)"), false);
  } finally {
    const browsers = await Promise.allSettled([recipient.close(), sender.close()]);
    edge.closeAllConnections();
    await new Promise<void>(resolve => edge.close(() => resolve()));
    for (const browser of browsers) if (browser.status === "rejected") throw browser.reason;
  }
});
