import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEdge } from "@agent-console/edge/start";
import type { EdgeExtension } from "@agent-console/edge/extensions";
import { normalizeOrder, projectPublicAgentSession } from "@agent-console/shared/api";
import { normalizeConversationImages, type ConversationImage } from "@agent-console/shared/conversation-images";
import { normalizeRefusedOutboxAction, type RefusedOutboxAction } from "@agent-console/shared/shared-outbox";

assert.deepEqual(normalizeOrder({ order: ["a", "a", ""] }), ["a"]);
const launch_env = { AGENT_RUNTIME_SUPPRESS_MEMORY: "1", AGENT_RUNTIME_SUPPRESS_HEALTH: "", AGENT_RUNTIME_CUSTOM_SWITCH: "a=b" };
assert.deepEqual(projectPublicAgentSession({ launch_env, env: { PRIVATE_TOKEN: "fixture-only" } }), { launch_env });
const refusedAction: RefusedOutboxAction = {
  operation: "discard_refused", expected_session_incarnation: "fixture-incarnation", base_revision: 1,
};
assert.deepEqual(normalizeRefusedOutboxAction(refusedAction), refusedAction);
assert.equal(normalizeRefusedOutboxAction({ ...refusedAction, base_revision: 0 }), null);
assert.equal(normalizeRefusedOutboxAction({ ...refusedAction, operation: "cancel" }), null);
const image: ConversationImage = { id: `${"a".repeat(16)}.0.u0-0.${"b".repeat(32)}` };
assert.deepEqual(normalizeConversationImages([{ ...image, path: "/workspace/image.png" }, { id: "https://example.invalid/image.png" }]), [image]);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const imageCredentials: Array<string | undefined> = [];
const upstream = createServer((request, response) => {
  if (request.url?.includes("/images/")) {
    imageCredentials.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "image/png", "content-disposition": "inline; filename*=UTF-8''original%20plot.png", "set-cookie": "upstream=fixture" });
    response.end(png);
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ sessions: [] }));
  }
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamAddress = upstream.address();
assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
const extension: EdgeExtension = {
  id: "fixture",
  routes: [{ id: "ping", pattern: "/api/ext/fixture/ping", methods: ["GET"], permission: "debug",
    handle: context => context.sendJson(200, { fixture: true }) }],
};
const server = startEdge({
  AGENT_CONSOLE_EDGE_HOST: "127.0.0.1", AGENT_CONSOLE_EDGE_PORT: "0",
  AGENT_CONSOLE_MACHINES: JSON.stringify([{ name: "fixture", url: `http://127.0.0.1:${upstreamAddress.port}`, token: "fixture-daemon-token" }]),
  AGENT_CONSOLE_TOKEN: "fixture-token", AGENT_CONSOLE_UI_DIR: fileURLToPath(new URL("./dist", import.meta.url)),
}, { extensions: [extension] });

async function checkSubmittedUi(base: string) {
  const profile = mkdtempSync(join(tmpdir(), "packed-ui-chrome-"));
  const chrome = spawn(process.env.CHROME_BIN ?? "google-chrome", ["--headless", "--no-sandbox", "--disable-gpu",
    "--no-first-run", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
  let socket: WebSocket | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(Error(`Chrome endpoint timeout: ${output.slice(-2000)}`)), 10_000);
      chrome.once("error", error => { clearTimeout(timeout); reject(error); });
      chrome.stderr.on("data", bytes => {
        output += bytes;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timeout); resolve(match[1]!); }
      });
    });
    socket = new WebSocket(endpoint);
    await once(socket, "open");
    let sequence = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    socket.addEventListener("message", event => {
      const value = JSON.parse(String(event.data)), call = pending.get(value.id);
      if (call) { pending.delete(value.id); value.error ? call.reject(Error(value.error.message)) : call.resolve(value.result); }
    });
    const rpc = (method: string, params = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await rpc("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await rpc("Target.attachToTarget", { targetId, flatten: true });
    await rpc("Page.enable", {}, sessionId);
    await rpc("Page.addScriptToEvaluateOnNewDocument", { source: `window.fixtureErrors=[]; window.imageDownload=null;
      const nativeFetch=window.fetch.bind(window), nativeAnchorClick=HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click=function(){ if(!this.download){nativeAnchorClick.call(this);return;}
        const name=this.download; void nativeFetch(this.href).then(response=>response.arrayBuffer())
          .then(buffer=>window.imageDownload={name,bytes:Array.from(new Uint8Array(buffer))}); };
      // Inspect as soon as the fixture is published, before React initializes
      // the journal. An observer must not create a schema-less database.
      let submittedFixture;
      Object.defineProperty(window, 'submittedFixture', { configurable: true,
        get: () => submittedFixture,
        set: value => { submittedFixture = value; void value.inspect(); } });
      addEventListener('error',event=>fixtureErrors.push(event.message));
      addEventListener('unhandledrejection',event=>fixtureErrors.push(String(event.reason)));` }, sessionId);
    const evaluate = async (expression: string) => {
      const result = await rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      assert.equal(result.exceptionDetails, undefined, "browser fixture evaluation completes");
      return result.result.value;
    };
    let expectedWrites = 0;
    const wait = async (matches: (value: any) => boolean) => {
      const deadline = Date.now() + 15_000;
      let value;
      do {
        value = await evaluate("window.submittedFixture?.inspect()");
        if (value?.ready && value.submittedRows === 1 && matches(value)) {
          assert.equal(value.writes, expectedWrites); assert.deepEqual(value.unexpected, []);
          assert.deepEqual(await evaluate("window.fixtureErrors"), []);
          return value;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      const fixtureErrors = await evaluate("window.fixtureErrors");
      assert.fail(`public UI did not reach expected state: ${JSON.stringify({ value, fixtureErrors })}`);
    };
    const displayReadsBefore = imageCredentials.length;
    await rpc("Page.navigate", { url: `${base}/?submitted-fixture` }, sessionId);
    const before = await wait(value => value.outboxReads > 0);
    assert.equal(before.visibleEchoes, 0, "another client's submitted reply is not a local echo before history arrives");
    expectedWrites = 1;
    const theme = await evaluate("window.themeFixture.inspect()");
    assert.ok(theme.hook === "dark" || theme.hook === "paper", `the packed theme hook resolves a theme: ${JSON.stringify(theme)}`);
    assert.deepEqual(theme, { hook: theme.hook, attribute: theme.hook, meta: theme.hook === "paper" ? "#f4f3ed" : "#011627" },
      "the installed consumer sees the resolved theme on the root element and in theme-color");
    await evaluate("window.submittedFixture.send()");
    const sent = await wait(value => value.writes === 1 && value.visibleEchoes === 1);
    assert.equal(sent.visibleEchoes, 1, "the sender's submitted echo stays visible until matching history");
    await evaluate("window.submittedFixture.handover()");
    const handed = await wait(value => value.historyReads > before.historyReads && value.proofCount === 1);
    assert.equal(handed.visibleEchoes, 0, "matching history takes over the outgoing echo");
    assert.equal(handed.matchingHistoryTurns, 1, "exactly one matching history turn remains visible");
    await evaluate("document.querySelector('[aria-label=\\\"Open image 1\\\"]')?.click()");
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = async () => {
        try {
          const loaded = await evaluate("document.querySelector('[aria-label=\\\"Conversation images\\\"] img')?.naturalWidth > 0");
          if (loaded) { resolve(); return; }
          if (Date.now() >= deadline) { reject(Error("packed UI image did not load")); return; }
          setTimeout(poll, 50);
        } catch (error) { reject(error); }
      };
      void poll();
    });
    assert.ok(imageCredentials.length > displayReadsBefore, "display uses an authenticated image read");
    const downloadReadsBefore = imageCredentials.length;
    await evaluate("document.querySelector('[aria-label=\\\"Download image\\\"]')?.click()");
    const imageDownload = await new Promise<any>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = async () => {
        try {
          const value = await evaluate("window.imageDownload");
          if (value) { resolve(value); return; }
          if (Date.now() >= deadline) { reject(Error("packed UI did not complete the image save")); return; }
          setTimeout(poll, 50);
        } catch (error) { reject(error); }
      };
      void poll();
    });
    assert.ok(imageCredentials.length > downloadReadsBefore, "download uses an authenticated image read");
    assert.deepEqual(imageDownload, { name: "original plot.png", bytes: [...png] }, "compiled UI saves the authenticated original bytes and filename");
    expectedWrites = 0;
    await rpc("Page.navigate", { url: `${base}/?submitted-fixture&later` }, sessionId);
    const remounted = await wait(value => value.outboxReads > 0 && value.proofCount === 1);
    assert.equal(remounted.visibleEchoes, 0, "fresh document with a later history window preserves durable handover");
    console.log(`packed public UI: PASS ${JSON.stringify({ before, handed, remounted })}`);
  } finally {
    socket?.close();
    if (chrome.exitCode === null && chrome.signalCode === null) {
      const exited = once(chrome, "exit"); chrome.kill("SIGTERM");
      const escalate = setTimeout(() => chrome.kill("SIGKILL"), 5_000);
      await exited; clearTimeout(escalate);
    }
    rmSync(profile, { recursive: true, force: true });
  }
}
try {
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: "Bearer fixture-token" };
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${base}/api/sessions`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/ext/fixture/ping`)).status, 401);
  const ping = await fetch(`${base}/api/ext/fixture/ping`, { headers });
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { fixture: true });
  const imageUrl = `${base}/api/history/sessions/fixture/history/images/${image.id}`;
  assert.equal((await fetch(imageUrl)).status, 401);
  assert.equal(imageCredentials.length, 0, "unauthenticated image reads never contact upstream");
  const imageResponse = await fetch(imageUrl, { headers });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.equal(imageResponse.headers.get("content-disposition"), "inline; filename*=UTF-8''original%20plot.png");
  assert.equal(imageResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(imageResponse.headers.get("set-cookie"), null);
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  assert.deepEqual(imageCredentials, ["Bearer fixture-daemon-token"]);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html\b/);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="\.\/([^"?]+\.(?:js|css|png|svg))"/g)].map(match => match[1]!);
  assert.ok(assets.some(path => path.endsWith(".js")));
  assert.ok(assets.some(path => path.endsWith(".css")));
  let fontsFetched = 0;
  for (const path of assets) {
    const response = await fetch(`${base}/${path}`);
    assert.equal(response.status, 200, path);
    const mime = path.endsWith(".js") ? /^text\/javascript\b/
      : path.endsWith(".css") ? /^text\/css\b/ : path.endsWith(".png") ? /^image\/png\b/ : /^image\/svg\+xml\b/;
    assert.match(response.headers.get("content-type") ?? "", mime,
      `${path} must be an asset, not the SPA fallback`);
    if (path.endsWith(".css")) {
      const css = await response.text();
      const fonts = [...css.matchAll(/url\(["']?([^)'" ]+\.woff2)["']?\)/g)].map(match => match[1]!);
      for (const font of fonts) {
        const response = await fetch(new URL(font, `${base}/${path}`));
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /^font\/woff2\b/);
        assert.ok((await response.arrayBuffer()).byteLength > 0);
        fontsFetched += 1;
      }
    }
  }
  assert.ok(fontsFetched >= 2, "both font assets survive packing and composition");
  await checkSubmittedUi(base);
  assert.ok(imageCredentials.every(credential => credential === "Bearer fixture-daemon-token"), "all image reads use the daemon credential");
  console.log("packed edge and generic UI: PASS (auth, extension route, shared runtime/refused action, authenticated image bytes, page, JS, CSS, fonts)");
} catch (error) {
  // The server deliberately catches uncaught errors; the probe must still fail.
  process.exitCode = 1;
  throw error;
} finally {
  server.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([server, upstream].map(server => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))));
}
