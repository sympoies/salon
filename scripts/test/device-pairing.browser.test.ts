import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
      plugins: [react(), { name: "pairing-app-entry", enforce: "pre",
        resolveId(id: string) { if (id === "@tauri-apps/plugin-http") return "\0pairing-native-http"; if (id.endsWith("pairing-app-entry")) return "\0pairing-app-entry"; },
        load(id: string) { if (id === "\0pairing-native-http") return 'export const fetch=(url,init)=>window.fetch(url,{...init,credentials:"omit"})'; if (id === "\0pairing-app-entry") return 'import {mountApp} from "/src/mountApp.tsx"; import {appFetch} from "/src/runtime.ts"; window.authFixtureRequest=async(path)=>(await appFetch(path)).status; mountApp(document.querySelector("#root"),{appName:"Example Console"});'; },
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

for (const native of [false, true]) for (const width of [390, 1280]) test(`${native ? "native adapter" : "two browsers"} pair, confirm, renew and revoke through the real edge at ${width}px`, async () => {
  let now = Date.now();
  const edge = createEdgeServer(loadConfig({ AGENT_CONSOLE_INSECURE_COOKIE: "1", AGENT_CONSOLE_UI_DIR: dir,
    AGENT_CONSOLE_STATE_DB: join(dir, `state-${native}-${width}.sqlite`), AGENT_CONSOLE_PRINCIPALS: JSON.stringify([
      { id: "example-principal", token: "main-fixture", machines: [], permissions: [] },
    ]) }), { authNow: () => now });
  // Capture only the synthetic device cookie in memory so the same issued credential
  // can exercise the native bearer adapter without weakening HTTPS pairing rules.
  let deviceCredential = "";
  edge.prependListener("request", (_req, res) => {
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      if (name.toLowerCase() === "set-cookie" && typeof value === "string") {
        const match = /^ac_session=(salon_device_[A-Za-z0-9_-]+)/.exec(value);
        if (match) deviceCredential = match[1]!;
      }
      return setHeader(name, value);
    };
  });
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

    if (width === 390 && !native) {
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
    assert.equal(await recipient.evaluate(`fetch('/api/auth/status',{headers:localStorage.getItem('ac:token') ? {Authorization:'Bearer '+localStorage.getItem('ac:token')}: {}}).then(response=>response.json()).then(value=>value.authenticated)`), true);
    await until(recipient, "!document.querySelector('.login-card')", "authenticated dashboard");
    if (native) {
      assert.ok(deviceCredential, "real pairing issued a synthetic device credential");
      await recipient.addInitScript(`window.__TAURI_INTERNALS__={};`);
      await recipient.evaluate(`localStorage.setItem('ac:server-url',location.origin);localStorage.setItem('ac:token',${JSON.stringify(deviceCredential)});`);
      await recipient.navigate(base);
      await until(recipient, "!document.querySelector('.login-card') && document.querySelector('header')", "native authenticated dashboard");
    }
    // Fail real dashboard polling without replacing the credential or reloading the App.
    await recipient.evaluate(`window.savedCredential=localStorage.getItem('ac:token');window.transportDown=true;
      const transport=window.fetch;window.fetch=(input,init)=>window.transportDown && String(input).includes('/api/sessions')
        ? Promise.reject(new TypeError('Synthetic offline transport')):transport(input,init);window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'));`);
    await until(recipient, "document.body.textContent.includes('Console server is unreachable')", "temporary network failure");
    assert.equal(await recipient.evaluate("Boolean(document.querySelector('.login-card'))"), false);
    assert.equal(await recipient.evaluate("localStorage.getItem('ac:token') === window.savedCredential"), true, "network failure retains credential");
    await recipient.evaluate("window.transportDown=false;window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'))");
    await until(recipient, "!document.body.textContent.includes('Console server is unreachable')", "network recovery");
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
    const statuses = await recipient.evaluate<Record<string, number>>(`Promise.all(
      ['/api/sessions','/api/machines','/api/auth/devices','/api/auth/status'].map(async path=>
        [path,(await fetch(path,{headers:localStorage.getItem('ac:token') ? {Authorization:'Bearer '+localStorage.getItem('ac:token')}: {}})).status])).then(Object.fromEntries)`);
    assert.equal(statuses['/api/sessions'], 401);
    assert.equal(statuses['/api/machines'], 401);
    assert.equal(statuses['/api/auth/devices'], 401);
    assert.equal(await recipient.evaluate("fetch('/api/auth/status').then(response=>response.json()).then(value=>value.authenticated)"), false);
    await until(recipient, "document.body.textContent.includes('Session list unavailable') || document.querySelector('.login-card')", "revocation outcome");
    console.log(JSON.stringify({ native, width, statuses, unavailable: await recipient.evaluate("document.body.textContent.includes('Session list unavailable')"), login: await recipient.evaluate("Boolean(document.querySelector('.login-card'))") }));
    if (process.env.SALON_UI_EVIDENCE_DIR) writeFileSync(join(process.env.SALON_UI_EVIDENCE_DIR, `revoked-${native ? "native" : "browser"}-${width}.png`), await recipient.screenshot());
    await until(recipient, "document.querySelector('.login-card') && document.body.textContent.includes('This device was signed out')", "revoked device returns to sign-in with a reason");
    if (native) {
      assert.equal(await recipient.evaluate("localStorage.getItem('ac:token') || ''"), "", "revoked credential is cleared");
      assert.equal(await recipient.evaluate("localStorage.getItem('ac:server-url')"), base, "server URL is retained");
    }
    if (process.env.SALON_UI_EVIDENCE_DIR) writeFileSync(join(process.env.SALON_UI_EVIDENCE_DIR, `signed-out-${native ? "native" : "browser"}-${width}.png`), await recipient.screenshot());
  } finally {
    const browsers = await Promise.allSettled([recipient.close(), sender.close()]);
    edge.closeAllConnections();
    await new Promise<void>(resolve => edge.close(() => resolve()));
    for (const browser of browsers) if (browser.status === "rejected") throw browser.reason;
  }
});

test("browser pairing refuses redirects before forwarding its claim body", async () => {
  const forwarded: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/api/auth/pairings/claim" || req.url === "/redirect-control") {
      res.writeHead(307, { location: "/redirected-claim" }); res.end(); return;
    }
    if (req.url === "/redirected-claim") {
      let body = ""; for await (const chunk of req) body += String(chunk);
      forwarded.push(body);
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, data: {} })); return;
    }
    if (req.url?.startsWith("/api/")) {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, authenticated: false })); return;
    }
    const name = req.url === "/" ? "index.html" : req.url?.slice(1);
    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) { res.writeHead(404); res.end(); return; }
    try {
      res.setHeader("content-type", name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
      res.end(readFileSync(join(dir, name)));
    } catch { res.writeHead(404); res.end(); }
  });
  const { base } = await listenOnLoopback(server);
  const page = await launchPage();
  try {
    await page.navigate(base);
    assert.equal(await page.evaluate("fetch('/redirect-control',{method:'POST',body:'control'}).then(response=>response.status)"), 200);
    assert.deepEqual(forwarded, ["control"], "the fixture and browser can follow a 307 and forward a POST body");
    forwarded.length = 0;
    await click(page, "Use a pairing code");
    await page.evaluate(`document.querySelector('[aria-label="Pairing code"]').value='ABCD-EFGH-JKLM-NPQR-STUV'`);
    await click(page, "Continue");
    await until(page, "document.querySelector('[role=alert]')", "redirect refusal");
    assert.match(await page.evaluate<string>("document.querySelector('[role=alert]').textContent"), /Pairing unavailable/);
    assert.deepEqual(forwarded, [], "the pairing code and verifier challenge never reach the redirected endpoint");
    assert.equal(await page.evaluate("Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes('Sign in as'))"), false);
  } finally {
    await page.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


for (const native of [false, true]) test(`upstream 401 keeps a valid ${native ? "native bearer" : "browser cookie"} signed in`, async () => {
  const daemon = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = _req.url?.startsWith("/workdirs") ? 401 : 200;
    res.end(JSON.stringify(res.statusCode === 401 ? { ok: false, error: { message: "upstream refused" } }
      : { ok: true, data: { sessions: [] } }));
  });
  const upstream = await listenOnLoopback(daemon);
  const edge = createEdgeServer(loadConfig({ AGENT_CONSOLE_TOKEN: "main-fixture", AGENT_CONSOLE_UI_DIR: dir,
    AGENT_CONSOLE_MACHINES: JSON.stringify([{ name: "fixture", url: upstream.base, token: "upstream-fixture" }]) }));
  const { base } = await listenOnLoopback(edge);
  const page = await launchPage();
  try {
    await page.setViewport(1280, 1000, 1);
    if (native) await page.addInitScript(`window.__TAURI_INTERNALS__={};localStorage.setItem('ac:server-url',location.origin);localStorage.setItem('ac:token','main-fixture');`);
    await page.navigate(base);
    if (!native) {
      assert.equal(await page.evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'main-fixture'})}).then(response=>response.status)`), 200);
      await page.navigate(base);
    }
    await until(page, "document.querySelector('header')", "authenticated dashboard");
    assert.equal(await page.evaluate("window.authFixtureRequest('/api/machines/fixture/workdirs')"), 401);
    assert.equal(await page.evaluate("Boolean(document.querySelector('.login-card'))"), false, "upstream refusal does not end edge authentication");
    if (native) assert.equal(await page.evaluate("localStorage.getItem('ac:token')"), "main-fixture");
    assert.equal(await page.evaluate(`fetch('/api/auth/status',{headers:${native ? "{Authorization:'Bearer main-fixture'}" : "{}"}}).then(response=>response.json()).then(value=>value.authenticated)`), true);
  } finally {
    await page.close();
    for (const server of [edge, daemon]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test("delayed browser logout cannot overwrite a replacement login cookie", { timeout: 30_000 }, async () => {
  let now = Date.now();
  const edge = createEdgeServer(loadConfig({ AGENT_CONSOLE_TOKEN: "main-fixture", AGENT_CONSOLE_UI_DIR: dir }), { authNow: () => now });
  let releaseLogout = () => {};
  let received!: () => void;
  const logoutReceived = new Promise<void>(resolve => { received = resolve; });
  edge.prependListener("request", (req, res) => {
    if (req.url !== "/api/auth/logout") return;
    const end = res.end;
    res.end = (...args: any[]) => {
      releaseLogout = () => { Reflect.apply(end, res, args); };
      received(); return res;
    };
  });
  const { base } = await listenOnLoopback(edge);
  const page = await launchPage();
  try {
    await page.navigate(base);
    assert.equal(await page.evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'main-fixture'})}).then(response=>response.status)`), 200);
    await page.navigate(base);
    await until(page, "document.querySelector('header')", "authenticated dashboard");
    await page.evaluate(`window.replacementRequests=0;const transport=window.fetch;window.fetch=(path,init)=>{
      if(String(path)==='/api/auth/login')window.replacementRequests++;return transport(path,init);};`);
    now += 13 * 3_600_000;
    assert.equal(await page.evaluate("window.authFixtureRequest('/api/machines')"), 401);
    await until(page, "document.querySelector('.login-card')", "private UI cleared before cleanup completes");
    await logoutReceived;
    await page.evaluate(`const input=document.querySelector('[data-testid=console-access-token]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'main-fixture');
      input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await click(page, "Sign in");
    assert.equal(await page.evaluate("window.replacementRequests"), 0, "replacement login waits for old cookie cleanup");
    releaseLogout();
    await until(page, "document.querySelector('header') && !document.querySelector('.login-card')", "replacement authenticated dashboard");
    assert.equal(await page.evaluate("fetch('/api/auth/status').then(response=>response.json()).then(value=>value.authenticated)"), true, "replacement cookie remains authorized");
  } finally {
    releaseLogout(); await page.close(); edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve()));
  }
});
