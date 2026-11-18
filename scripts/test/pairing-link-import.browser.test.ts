import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createEdgeServer } from "../../packages/edge/src/server.ts";
import { loadConfig } from "../../packages/edge/src/config.ts";
import { listenOnLoopback } from "../../packages/edge/test/support.ts";
import { createUiSsrHarness } from "../../packages/ui/test/support/ssr.ts";
import { launchPage, type Page } from "../../packages/ui/test/support/browserPage.ts";

const uiRequire = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const { build } = await import(uiRequire.resolve("vite"));
const { default: react } = await import(uiRequire.resolve("@vitejs/plugin-react"));
const dir = mkdtempSync(join(tmpdir(), "pairing-link-browser-"));
let base: string;
let edge: ReturnType<typeof createEdgeServer>;

before(async () => {
  const previous = process.env.NODE_ENV;
  try {
    const result = await build({ root: fileURLToPath(new URL("../../packages/ui/", import.meta.url)), configFile: false,
      logLevel: "silent", resolve: { conditions: ["source"] }, plugins: [react(), {
        name: "pairing-link-browser-fixture", enforce: "pre",
        resolveId(id: string) {
          if (id.endsWith("pairing-link-entry")) return "\0pairing-link-entry";
          if (id === "@tauri-apps/plugin-http") return "\0pairing-link-transport";
        },
        load(id: string) {
          if (id === "\0pairing-link-transport") return "export const fetch=(url,init)=>window.pairingLinkFixture.fetch(url,init)";
          if (id === "\0pairing-link-entry") return `
            import {mountApp} from '/src/mountApp.tsx';
            window.__TAURI_INTERNALS__={};
            window.pairingLinkFixture={claims:0,exchanges:0,fetch:async(url,init)=>{
              if(url.endsWith('/claim')){window.pairingLinkFixture.claims++;const body=JSON.parse(init.body);
                return Response.json({data:{id:'fixture',principal:'example-principal',origin:new URL(url).origin,
                  challenge:body.challenge,delivery:'native',verification:'ABCDEFGH',expires_at:Date.now()+300000}});}
              if(url.endsWith('/exchange'))window.pairingLinkFixture.exchanges++;
              return Response.json({authenticated:false,openAccess:false});
            }};
            mountApp(document.querySelector('#root'),{appName:'Example Console',
              scanPairingLink:async()=>'https://pairing.example.test:9443/#pair=ABCDEFGHJKLMNPQRSTUV'});
          `;
        },
      }], define: { "process.env.NODE_ENV": JSON.stringify("production"),
        __AGENT_CONSOLE_APP_VERSION__: JSON.stringify("0.0.0"), __AGENT_CONSOLE_BUILD_SHA__: JSON.stringify("fixture") },
      build: { write: false, target: "esnext", lib: { entry: "pairing-link-entry", name: "PairingLinkFixture", formats: ["iife"] } },
    });
    const bundle = Array.isArray(result) ? result[0] : result;
    assert.ok(bundle && "output" in bundle);
    let styles = "", scripts = "";
    for (const item of bundle.output) {
      const path = join(dir, item.fileName); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, item.type === "chunk" ? item.code : item.source);
      if (item.type === "chunk" && item.isEntry) scripts += `<script defer src="/${item.fileName}"></script>`;
      if (item.type === "asset" && item.fileName.endsWith(".css")) styles += `<link rel="stylesheet" href="/${item.fileName}">`;
    }
    writeFileSync(join(dir, "index.html"), `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${styles}${scripts}<div id="root"></div>`);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const window = new (uiRequire("happy-dom").Window)({ url: "https://pairing.example.test/#pair=ABCDEFGHJKLMNPQRSTUV" });
    const harness = createUiSsrHarness();
    try {
      Object.defineProperty(globalThis, "window", { configurable: true, value: window });
      const { PairingLinkContext } = await harness.loadModule<typeof import("../../packages/ui/src/PairingLinkActions.tsx")>("/src/PairingLinkActions.tsx");
      const { PairingRecipient } = await harness.loadModule<typeof import("../../packages/ui/src/PairingRecipient.tsx")>("/src/PairingRecipient.tsx");
      const { createElement } = uiRequire("react"), { renderToStaticMarkup } = uiRequire("react-dom/server");
      const markup = renderToStaticMarkup(createElement(PairingLinkContext.Provider,
        { value: { openPairingLinkInApp() {} } }, createElement(PairingRecipient, { onCancel() {}, onSignedIn() {} })));
      writeFileSync(join(dir, "browser-landing.html"), `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${styles}${markup}`);
    } finally {
      descriptor ? Object.defineProperty(globalThis, "window", descriptor) : Reflect.deleteProperty(globalThis, "window");
      await harness.close(); await window.happyDOM.close();
    }
    edge = createEdgeServer(loadConfig({ AGENT_CONSOLE_TOKEN: "synthetic-fixture-token", AGENT_CONSOLE_UI_DIR: dir }));
    ({ base } = await listenOnLoopback(edge));
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});
after(async () => {
  if (edge) { edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); }
  rmSync(dir, { recursive: true, force: true });
});

async function until(page: Page, expression: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await page.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(`pairing fixture did not reach the expected visible state: ${await page.evaluate(`JSON.stringify({
    claims:window.pairingLinkFixture?.claims,exchanges:window.pairingLinkFixture?.exchanges,
    error:document.querySelector('[role=alert]')?.textContent,subtle:Boolean(crypto.subtle),pageErrors:window.fixtureErrors})`)}`);
}
async function capture(page: Page, name: string): Promise<void> {
  assert.equal(await page.evaluate("document.documentElement.scrollWidth > innerWidth"), false);
  assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('.login-card button,.device-origin')).some(node=>{
    const box=node.getBoundingClientRect();return box.left<0||box.right>innerWidth;})`), false, "new actions and origin remain inside the viewport");
  if (process.env.SALON_UI_EVIDENCE_DIR) {
    mkdirSync(process.env.SALON_UI_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.SALON_UI_EVIDENCE_DIR, `${name}.png`), await page.screenshot());
  }
}

for (const width of [390, 760, 761, 1280]) test(`scan connection, native consent and browser handoff fit at ${width}px`, async () => {
  const page = await launchPage();
  try {
    await page.setViewport(width, 844, 1);
    await page.addInitScript("window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',()=>fixtureErrors.push('unhandled rejection'));");
    await page.navigate(base);
    await until(page, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Scan QR')");
    await capture(page, `link-connection-${width}`);
    await page.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Scan QR').click()");
    await until(page, "document.body.textContent.includes('Sign in as example-principal')");
    assert.equal(await page.evaluate("window.pairingLinkFixture.claims"), 1, "StrictMode cannot duplicate imported claims");
    assert.equal(await page.evaluate("window.pairingLinkFixture.exchanges"), 0, "scan cannot bypass explicit consent");
    assert.equal(await page.evaluate("localStorage.getItem('ac:token')"), null);
    assert.equal(await page.evaluate("document.querySelector('[aria-label=\"Pairing code\"]')===null"), true);
    await capture(page, `link-consent-${width}`);
    assert.deepEqual(await page.evaluate("window.fixtureErrors"), []);
    await page.navigate(`${base}/browser-landing.html`);
    assert.equal(await page.evaluate("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Open in app')"), true);
    await capture(page, `link-browser-handoff-${width}`);
  } finally { await page.close(); }
});
