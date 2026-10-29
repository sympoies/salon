import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as chrome from "../readme-previews/chrome.ts";

// The preview capture owns a headless Chrome and its profile directory. These
// tests use a stand-in executable and short-lived children, so no browser runs.
let directory = "";
let fake = "";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 3000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return check();
};

before(() => {
  directory = mkdtempSync(join(tmpdir(), "readme-chrome-test-"));
  fake = join(directory, "fake-chrome.mjs");
  // FAKE_MODE=hang stays alive without ever exposing a DevTools port; exit leaves at once.
  writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const profile = process.argv.find(argument => argument.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ?? "";
writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ pid: process.pid, profile }));
if (process.env.FAKE_MODE === "exit") process.exit(3);
if (process.env.FAKE_MODE === "devtools") writeFileSync(profile + "/DevToolsActivePort", process.env.FAKE_PORT + "\\n/devtools/browser/fake\\n");
setTimeout(() => {}, 60_000);
`);
  chmodSync(fake, 0o755);
});
after(() => { rmSync(directory, { recursive: true, force: true }); });

async function launchFailure(mode: "hang" | "exit", portWaitMs: number) {
  const record = join(directory, `${mode}.json`);
  rmSync(record, { force: true });
  Object.assign(process.env, { CHROME_BIN: fake, FAKE_MODE: mode, FAKE_RECORD: record });
  const started = Date.now();
  const error = await chrome.launchPage({ portWaitMs }).then(() => undefined, (cause: unknown) => cause as Error);
  const { pid, profile } = JSON.parse(readFileSync(record, "utf8")) as { pid: number; profile: string };
  return { error, pid, profile, elapsed: Date.now() - started };
}

test("a launch that cannot reach the DevTools port reaps Chrome and removes its profile", async () => {
  const { error, pid, profile } = await launchFailure("hang", 400);
  assert.match(error?.message ?? "", /DevTools port/);
  assert.equal(await until(() => !alive(pid)), true, "the Chrome child is gone");
  assert.equal(existsSync(profile), false, "the generated profile directory is removed");
});

test("a Chrome that exits before exposing DevTools fails at once and leaves no profile", async () => {
  const { error, profile, elapsed } = await launchFailure("exit", 5000);
  assert.match(error?.message ?? "", /exited/);
  assert.ok(elapsed < 2500, `failed fast, not after the port wait (${elapsed} ms)`);
  assert.equal(existsSync(profile), false);
});

test("stopping a browser that has already exited finishes, and stopping twice is harmless", async () => {
  const profile = mkdtempSync(join(directory, "profile-"));
  mkdirSync(join(profile, "Default"));
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise(resolve => child.once("exit", resolve));
  const finished = (promise: Promise<void>) => Promise.race([promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000))]);
  assert.equal(await finished(chrome.stopBrowser(child, profile)), true, "does not wait for an exit event that already happened");
  assert.equal(existsSync(profile), false);
  assert.equal(await finished(chrome.stopBrowser(child, profile)), true);
});

test("stopping a live browser kills and reaps it before removing the profile", async () => {
  const profile = mkdtempSync(join(directory, "profile-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await chrome.stopBrowser(child, profile);
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(alive(child.pid!), false);
  assert.equal(existsSync(profile), false);
});

/** The smallest DevTools stand-in: one page target and a WebSocket that answers every command with an undefined result. */
async function startFakeDevTools(): Promise<{ port: number; sockets: Set<Duplex>; close(): Promise<void> }> {
  const sockets = new Set<Duplex>();
  let port = 0;
  const server: Server = createServer((request, response) => {
    if (request.url === "/json/list") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/fake` }]));
    } else { response.statusCode = 404; response.end(); }
  });
  server.on("upgrade", (request, socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (chunk: Buffer) => {
      // Client frames are masked text frames shorter than 126 bytes in this test.
      if ((chunk[0]! & 0x0f) !== 1) return;
      const length = chunk[1]! & 0x7f, mask = chunk.subarray(2, 6);
      const text = Buffer.from(chunk.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4]!)).toString();
      const reply = Buffer.from(JSON.stringify({ id: (JSON.parse(text) as { id: number }).id, result: { result: { type: "undefined" } } }));
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  return { port, sockets, close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }) };
}

test("a request made after the DevTools connection closed is rejected at once instead of waiting forever", async () => {
  const devtools = await startFakeDevTools();
  const record = join(directory, "devtools.json");
  Object.assign(process.env, { CHROME_BIN: fake, FAKE_MODE: "devtools", FAKE_RECORD: record, FAKE_PORT: String(devtools.port) });
  const page = await chrome.launchPage({ portWaitMs: 3000 });
  try {
    assert.equal(await page.evaluate("1"), undefined, "the stand-in answers while the connection is open");
    for (const socket of devtools.sockets) socket.destroy();
    // Let the client observe the close, as the capture's retry loop does between attempts.
    await new Promise(resolve => setTimeout(resolve, 150));
    const outcome = await Promise.race([
      page.evaluate("2").then(() => "answered", (error: Error) => `rejected: ${error.message}`),
      new Promise<string>(resolve => setTimeout(() => resolve("still waiting after 2 s"), 2000)),
    ]);
    assert.match(outcome, /^rejected: .*closed/);
    const navigation = await Promise.race([
      page.navigate("http://127.0.0.1:1/").then(() => "answered", (error: Error) => `rejected: ${error.message}`),
      new Promise<string>(resolve => setTimeout(() => resolve("still waiting after 2 s"), 2000)),
    ]);
    assert.match(navigation, /^rejected: .*closed/);
  } finally {
    await page.close(); await devtools.close();
  }
});
