import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createEdgeServer } from "../../packages/edge/src/server.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "../../packages/edge/test/support.ts";
import { launchPage, type Page } from "../../packages/ui/test/support/browserPage.ts";
import { consoleViteConfig } from "../../packages/ui/vite.shared.ts";

const uiRequire = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const { build } = await import(uiRequire.resolve("vite"));
let uiDir: string;
before(async () => {
  uiDir = mkdtempSync(join(tmpdir(), "salon-idle-link-"));
  await build({ ...consoleViteConfig({ root: fileURLToPath(new URL("../../packages/ui/", import.meta.url)), outDir: uiDir }),
    configFile: false, logLevel: "error", resolve: { conditions: ["source"] } });
});
after(() => { if (uiDir) rmSync(uiDir, { recursive: true, force: true }); });

const stamp = "2026-01-01T00:00:00Z";
const socketOutput = Buffer.from("\x1b[H" + "fixture terminal status ".repeat(90));
const terminalFrame = Buffer.alloc(4 + socketOutput.length);
terminalFrame[0] = 0x82; // FIN, binary frame
terminalFrame[1] = 126;
terminalFrame.writeUInt16BE(socketOutput.length, 2);
socketOutput.copy(terminalFrame, 4);

function fixtureSessions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`, title: `Example session ${index}`, agent: "codex", status: "running",
    updated_at: stamp, cwd: "/workspace/sample", repo_name: "sample",
    last_message: { role: "assistant", text: "Example status line. ".repeat(24), submitted_at: stamp },
    last_prompt: { text: "Example work request. ".repeat(24), submitted_at: stamp },
    turn_state: { schema_version: "agent-session.turn-state.v1", phase: "idle", revision: 1, phase_changed_at: stamp,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" } },
  }));
}

async function startFixture(count: number, terminalTraffic = false) {
  const sessions = fixtureSessions(count);
  const bytes = new Map<string, number>();
  const add = (key: string, chunk: string | Uint8Array) =>
    bytes.set(key, (bytes.get(key) ?? 0) + Buffer.byteLength(chunk));
  const sockets = new Set<Duplex>();
  const activity = new Set<import("node:http").ServerResponse>();
  let sequence = 0;
  const snapshot = () => {
    const frame = `event: snapshot\ndata: ${JSON.stringify({
      schema_version: "agent-session.activity-stream.event.v1", type: "snapshot", machine: "fixture",
      stream_id: "fixture", sequence: ++sequence, observed_at: new Date().toISOString(),
      sessions: sessions.map(({ id, turn_state }) => ({ id, turn_state })),
    })}\n\n`;
    for (const response of activity) response.write(frame);
  };
  const daemon = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (data: unknown) => {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true, data }));
    };
    if (path === "/sessions") return json({ sessions, capabilities: { last_prompt: true, last_message: true } });
    if (path === "/activity/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      activity.add(res);
      res.once("close", () => activity.delete(res));
      snapshot();
      return;
    }
    if (path === "/usage") return json({ providers: [] });
    res.writeHead(404).end();
  });
  daemon.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on("data", (frame: Buffer) => {
      if ((frame[0]! & 0x0f) === 8) socket.end(Buffer.from([0x88, 0]));
    });
    const id = req.url!.split("/")[2]!;
    const timer = id !== "session-0" && terminalTraffic ? setInterval(() => {
      add("terminal WebSocket", terminalFrame);
      socket.write(terminalFrame);
    }, 140) : undefined;
    socket.once("close", () => { clearInterval(timer); sockets.delete(socket); });
  });
  const daemonAddress = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({
    openAccess: false, clientToken: "fixture-token", uiDir,
    machines: [{ name: "fixture", url: daemonAddress.base, token: "fixture-daemon" }],
    usage: { url: daemonAddress.base, token: null, path: "/usage" },
  }));
  edge.prependListener("request", (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (!path.startsWith("/api/")) return;
    const observe = (chunk: unknown) => {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return;
      const heartbeat = typeof chunk === "string" && (/(?:^|\n)event: heartbeat\n/.test(chunk) || chunk.startsWith(":"));
      add(heartbeat ? `${path} keep-alive` : path, chunk);
    };
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    res.write = ((chunk: unknown, ...args: unknown[]) => { observe(chunk); return Reflect.apply(write, res, [chunk, ...args]); }) as typeof res.write;
    res.end = ((chunk: unknown, ...args: unknown[]) => { observe(chunk); return Reflect.apply(end, res, [chunk, ...args]); }) as typeof res.end;
  });
  const { base } = await listenOnLoopback(edge);
  const timer = setInterval(snapshot, 1_000);
  return {
    base, bytes, sessions, snapshot, sockets,
    async close() {
      clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await Promise.all([edge, daemon].map(server => {
        server.closeAllConnections();
        return new Promise<void>(resolve => server.close(() => resolve()));
      }));
    },
  };
}

async function signIn(page: Page, base: string) {
  const cookie = await loginCookie(base, "fixture-token");
  await page.addInitScript(`if (location.origin === ${JSON.stringify(base)}) {
    document.cookie = ${JSON.stringify(cookie + "; path=/; SameSite=Lax")};
    localStorage.setItem("agent-console.principal.legacy.agent-console.layout.auto", "0");
    localStorage.setItem("agent-console.principal.legacy.agent-console.layout.mode", "6");
  }`);
}

async function until(page: Page, expression: string, message: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  do {
    if (await page.evaluate<boolean>(`Boolean(${expression})`)) return;
    await sleep(100);
  } while (Date.now() < deadline);
  assert.fail(message);
}

test("a signed-in idle focused client stays within its downstream byte budget", { timeout: 95_000 }, async t => {
  const fixture = await startFixture(6, true);
  const page = await launchPage();
  try {
    await signIn(page, fixture.base);
    await page.setViewport(1500, 1000, 1);
    await page.navigate(fixture.base);
    await until(page, 'document.querySelectorAll(".terminal-slot[data-slot-key]").length === 6', "six slots appear");
    const attachDeadline = Date.now() + 5_000;
    while (fixture.sockets.size < 6 && Date.now() < attachDeadline) await sleep(50);
    assert.equal(fixture.sockets.size, 6, "all six visible terminals attached before focus");
    await page.evaluate('document.querySelector(\'[aria-label="Open Example session 0"]\').click()');
    await until(page, 'document.querySelector(".terminal-slot.is-focused")', "one terminal is focused");
    await sleep(800);
    fixture.bytes.clear();
    const windowMs = process.env.SALON_IDLE_MEASURE ? 60_000 : 12_000;
    await sleep(windowMs);
    const downstream = [...fixture.bytes.values()].reduce((total, value) => total + value, 0);
    t.diagnostic(`${downstream} bytes in ${windowMs} ms: ${JSON.stringify(Object.fromEntries(fixture.bytes))}`);
    assert.ok(downstream <= 7_500 * windowMs / 1_000, "downstream traffic exceeds the idle byte budget");
    assert.equal(fixture.bytes.get("terminal WebSocket") ?? 0, 0, "the hidden terminals send no frames");
    assert.equal(fixture.bytes.get("/api/activity/events") ?? 0, 0, "unchanged activity only sends keep-alives");
    assert.equal(fixture.sockets.size, 1, "only the focused terminal stays connected");
  } finally {
    await page.close();
    await fixture.close();
  }
});

test("the signed-in session list loads and receives live updates on a throttled link", { timeout: 65_000 }, async t => {
  const fixture = await startFixture(140);
  const page = await launchPage();
  try {
    await signIn(page, fixture.base);
    await page.setViewport(390, 850, 1, true);
    await page.throttleNetwork(`${fixture.base}/api/*`, 2_000, 20_000);
    await page.navigate(fixture.base);
    await until(page, 'document.querySelector(".mobile-session-card")', "the session list did not load on a slow link", 30_000);
    const label = await page.evaluate<string>('document.querySelector(".mobile-session-card-open-action").getAttribute("aria-label")');
    const updated = fixture.sessions.find(session => `Open ${session.title}` === label);
    assert.ok(updated, "a fixture session is visible");
    updated.turn_state.revision += 1;
    updated.turn_state.phase = "working";
    updated.turn_state.phase_changed_at = new Date().toISOString();
    Object.assign(updated.turn_state, { current_turn: { started_at: updated.turn_state.phase_changed_at } });
    fixture.snapshot();
    await until(page, `[...document.querySelectorAll(".mobile-session-card")].some(card =>
      card.querySelector(".mobile-session-card-open-action")?.getAttribute("aria-label") === ${JSON.stringify(label)}
      && card.querySelector(".activity-working"))`,
      "the live activity update did not arrive on a slow link", 14_000);
    t.diagnostic("Throttled browser loaded the list and applied a live activity update");
  } finally {
    await page.close();
    await fixture.close();
  }
});
