import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import { hasHeadlessChrome } from "./support/browserLayout.ts";

// Real xterm in a real browser: programs set only a background (ESC[40m..ESC[107m)
// and keep the default foreground, which on Paper is the same ink as ANSI black.
test("Paper terminal text stays readable on every ANSI background cell and on reverse video", async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const fixture = `
    import { Terminal } from "@xterm/xterm";
    import { terminalAppearanceFor } from "/src/terminalTheme.ts";
    const appearance = terminalAppearanceFor("paper");
    const host = document.querySelector("#host");
    const term = new Terminal({ cols: 40, rows: 20, theme: appearance.theme, minimumContrastRatio: appearance.minimumContrastRatio });
    term.open(host);
    const codes = [40, 41, 42, 43, 44, 45, 46, 47, 100, 101, 102, 103, 104, 105, 106, 107, 7];
    const lines = codes.map(code => "\\x1b[" + code + "mCASE" + code + "\\x1b[0m").join("\\r\\n");
    term.write(lines, () => setTimeout(() => {
      const channels = text => text.match(/[\\d.]+/g).map(Number);
      const lum = ([r, g, b]) => { const c = [r, g, b].map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722; };
      const ratio = (a, b) => { const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y); return (hi + 0.05) / (lo + 0.05); };
      const canvas = [244, 243, 237];
      const out = {};
      for (const span of host.querySelectorAll(".xterm-rows span")) {
        const match = /CASE(\\d+)/.exec(span.textContent);
        if (!match) continue;
        const style = getComputedStyle(span);
        const background = channels(style.backgroundColor);
        const bg = background.length > 3 && background[3] === 0 || style.backgroundColor === "rgba(0, 0, 0, 0)" ? canvas : background.slice(0, 3);
        out[match[1]] = Math.round(ratio(channels(style.color).slice(0, 3), bg) * 100) / 100;
      }
      document.querySelector("#result").textContent = JSON.stringify(out);
    }, 300));
  `;
  const bundle = await build({ root: new URL("..", import.meta.url).pathname, configFile: false, logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [{ name: "paper-contrast-fixture", enforce: "pre",
      resolveId(id) { if (id.endsWith("paper-contrast-fixture")) return "\0paper-contrast-fixture"; },
      load(id) { if (id === "\0paper-contrast-fixture") return fixture; } }],
    build: { write: false, minify: false, lib: { entry: "paper-contrast-fixture", name: "PaperContrast", formats: ["iife"] } } });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = output.output.filter(item => item.type === "chunk").map(item => item.code).join("\n");
  const xtermCss = readFileSync(new URL("../node_modules/@xterm/xterm/css/xterm.css", import.meta.url), "utf8");
  const temp = mkdtempSync(join(tmpdir(), "terminal-paper-contrast-"));
  const chrome = spawn(process.env.CHROME_BIN ?? "google-chrome", ["--headless", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--remote-debugging-port=0", `--user-data-dir=${join(temp, "profile")}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: "/tmp" } });
  let socket: WebSocket | undefined;
  try {
    const file = join(temp, "fixture.html");
    writeFileSync(file, `<!doctype html><style>${xtermCss}html,body{margin:0;background:#f4f3ed}</style><div id="host"></div><pre id="result"></pre><script>${code}</script>`);
    // xterm paints on animation frames and only while visible, which a one-shot --dump-dom page never is.
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(Error(`Chrome endpoint timeout: ${output.slice(-1000)}`)), 10_000);
      chrome.once("error", error => { clearTimeout(timer); reject(error); });
      chrome.stderr.on("data", bytes => {
        output += String(bytes);
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]!); }
      });
    });
    socket = new WebSocket(endpoint);
    await once(socket, "open");
    let nextId = 0;
    const pending = new Map<number, (message: { result?: Record<string, unknown>; error?: unknown }) => void>();
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
      if (message.id !== undefined) pending.get(message.id)?.(message);
    });
    const rpc = (method: string, params: object = {}, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, message => message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result ?? {}));
      socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await rpc("Target.createTarget", { url: `file://${file}` }) as { targetId: string };
    const { sessionId } = await rpc("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    let json = "";
    for (let attempt = 0; attempt < 100 && !json; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const evaluated = await rpc("Runtime.evaluate", { expression: "document.querySelector('#result')?.textContent ?? ''", returnByValue: true }, sessionId) as { result: { value: string } };
      json = evaluated.result.value;
    }
    assert.ok(json, "the fixture published its measurements");
    const ratios = JSON.parse(json) as Record<string, number>;
    assert.equal(Object.keys(ratios).length, 17, `every case was rendered: ${json}`);
    for (const [code, measured] of Object.entries(ratios)) {
      assert.ok(measured >= 4.5, `SGR ${code}: default foreground on that cell is ${measured}:1, below 4.5:1`);
    }
  } finally {
    socket?.close();
    if (chrome.exitCode === null && chrome.signalCode === null) { const exited = once(chrome, "exit"); chrome.kill("SIGTERM"); await exited; }
    rmSync(temp, { recursive: true, force: true });
  }
});
