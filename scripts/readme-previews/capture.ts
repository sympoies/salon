/**
 * Regenerates the README UI previews from synthetic data only.
 *
 *   pnpm build && pnpm capture:readme
 *
 * It starts a stand-in daemon that serves the "fernlight" scenario in
 * fixture.ts, runs the real edge (from source) against it with the UI built in
 * apps/workspace/dist, and drives headless Chrome (CHROME_BIN, default
 * google-chrome) to take two screenshots: desktop 1280 px wide in the Dark
 * theme and phone 390 px wide in the Paper theme. The clock, time zone and
 * language are fixed so the output does not depend on the machine or the day.
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { startEdge } from "../../packages/edge/src/start.ts";
import { startFakeDaemon } from "./daemon.ts";
import { launchPage, type Page } from "./chrome.ts";
import { MACHINE, NOW } from "./fixture.ts";

const root = new URL("../../", import.meta.url);
const outDir = process.argv[2] ?? fileURLToPath(new URL("docs/assets/readme/", root));
const only = process.env.PREVIEW_ONLY;
const MAX_BYTES = 300 * 1024;

/** Keys the app stores per principal; open access uses the fixed "open-access" principal. */
const scoped = (key: string) => `agent-console.principal.open-access.${key}`;
const desktopSettings = {
  "ac.themeMode": "dark",
  [scoped("ac.sessionListDisplay")]: "conversation",
  [scoped("agent-console.layout.mode")]: "3",
  [scoped("agent-console.layout.auto")]: "0",
};
const phoneSettings = {
  "ac.themeMode": "paper",
  [scoped("ac.phoneSessionOpen")]: "conversation",
};

/** Time keeps flowing, but starts at NOW, so elapsed-time labels and clock times are stable. */
const fixedClock = `(() => {
  const RealDate = Date, offset = RealDate.parse(${JSON.stringify(NOW)}) - RealDate.now();
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
    static now() { return RealDate.now() + offset; }
  }
  globalThis.Date = FixedDate;
})();`;
const seedStorage = (settings: Record<string, string>) => `(() => {
  try { localStorage.clear(); for (const [key, value] of Object.entries(${JSON.stringify(settings)})) localStorage.setItem(key, value); } catch {}
})();`;

async function until(page: Page, check: string, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate<boolean>(`Boolean(${check})`).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const seen = await page.evaluate<string>(`document.body.innerText.slice(0, 400)`).catch(() => "(page unavailable)");
  throw new Error(`Timed out waiting for ${what}. The page showed: ${seen}`);
}
const settle = (ms = 700) => new Promise(resolve => setTimeout(resolve, ms));

/** The broker-connections chart the #412 conversation attaches, drawn here so no binary asset is committed. */
async function renderChart(page: Page): Promise<Buffer> {
  const before = "40,170 90,168 140,40 190,30 240,60 290,90 340,120 390,140 440,150 490,150 540,152 600,150";
  const after = "40,170 90,168 140,150 190,142 240,138 290,140 340,142 390,144 440,146 490,148 540,150 600,150";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="220" viewBox="0 0 640 220" font-family="DejaVu Sans, Arial, sans-serif">
    <rect width="640" height="220" rx="8" fill="#0b1a2b"/>
    <text x="40" y="26" font-size="14" fill="#d6deeb">Broker connections after restart</text>
    <g stroke="#27405c" stroke-width="1"><line x1="40" y1="40" x2="600" y2="40"/><line x1="40" y1="105" x2="600" y2="105"/><line x1="40" y1="170" x2="600" y2="170"/></g>
    <line x1="120" y1="40" x2="120" y2="170" stroke="#7c8da4" stroke-dasharray="4 4"/>
    <text x="126" y="56" font-size="11" fill="#9fb0c6">restart</text>
    <polyline fill="none" stroke="#ef8f6b" stroke-width="2.5" points="${before}"/>
    <polyline fill="none" stroke="#6aa9ff" stroke-width="2.5" points="${after}"/>
    <text x="40" y="200" font-size="11" fill="#9fb0c6">0</text><text x="28" y="45" font-size="11" fill="#9fb0c6">500</text>
    <rect x="400" y="205" width="14" height="4" fill="#ef8f6b"/><text x="420" y="211" font-size="11" fill="#d6deeb">before</text>
    <rect x="490" y="205" width="14" height="4" fill="#6aa9ff"/><text x="510" y="211" font-size="11" fill="#d6deeb">after</text>
  </svg>`;
  await page.setViewport(640, 220, 1);
  await page.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:0">${svg}</body>`)}`);
  return page.screenshot();
}

async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
  });
}

const save = (name: string, bytes: Buffer) => {
  const path = fileURLToPath(new URL(name, `file://${outDir.replace(/\/?$/, "/")}`));
  writeFileSync(path, bytes);
  const size = statSync(path).size;
  console.log(`${path} ${(size / 1024).toFixed(0)} KB`);
  if (size > MAX_BYTES) throw new Error(`${name} is ${size} bytes; the limit is about ${MAX_BYTES}`);
};

mkdirSync(outDir, { recursive: true });
const page = await launchPage();
let daemon: Awaited<ReturnType<typeof startFakeDaemon>> | undefined;
let edge: ReturnType<typeof startEdge> | undefined;
try {
  await page.setEnvironment("UTC", "en-US");
  daemon = await startFakeDaemon(await renderChart(page));
  const port = await freePort();
  edge = startEdge({
    AGENT_CONSOLE_EDGE_HOST: "127.0.0.1", AGENT_CONSOLE_EDGE_PORT: String(port),
    AGENT_CONSOLE_UI_DIR: fileURLToPath(new URL("apps/workspace/dist", root)),
    AGENT_CONSOLE_NO_AUTH: "1", AGENT_CONSOLE_INSECURE_COOKIE: "1",
    AGENT_CONSOLE_MACHINES: JSON.stringify([{ name: MACHINE, url: daemon.url, token: "synthetic-daemon-token" }]),
  });
  await page.addInitScript(fixedClock);
  const origin = `http://127.0.0.1:${port}/`;

  if (!only || only === "desktop") {
    await page.addInitScript(`if (location.search === "?preview=desktop") { ${seedStorage(desktopSettings)} }`);
    await page.setViewport(1280, 1000, 1);
    await page.navigate(`${origin}?preview=desktop`);
    await until(page, `document.body.innerText.includes("CI for #412 passed")`, "the #412 conversation");
    await until(page, `[...document.querySelectorAll(".history-bubble img")].some(image => image.complete && image.naturalWidth > 0)`, "the chart image");
    await page.evaluate(`document.querySelectorAll(".history-messages").forEach(pane => { pane.scrollTop = pane.scrollHeight; })`);
    await settle();
    save("desktop-dark-1280.png", await page.screenshot());
  }

  if (!only || only === "phone") {
    await page.addInitScript(`if (location.search === "?preview=phone") { ${seedStorage(phoneSettings)} }`);
    await page.setViewport(390, 720, 2, true);
    await page.navigate(`${origin}?preview=phone`);
    await until(page, `document.body.innerText.includes("fernlight#398 flaky rollup compaction test")`, "the session list");
    await settle();
    await page.evaluate(`(() => {
      [...document.querySelectorAll("button")].find(button => (button.getAttribute("aria-label") || "").startsWith("Open fernlight#398")).click();
    })()`);
    await until(page, `document.body.innerText.includes("Opened PR #415.")`, "the #398 conversation");
    await settle();
    save("phone-paper-390.png", await page.screenshot());
  }

  const stray = [...new Set(daemon.unhandled)].filter(entry => !/\/(activity\/events|codex\/accounts)\b|\/attach\b/.test(entry));
  if (stray.length) console.warn("The UI asked the stand-in daemon for something it does not serve:", stray.join(", "));
} finally {
  await page.close(); edge?.close(); await daemon?.close();
}
process.exit(0);
