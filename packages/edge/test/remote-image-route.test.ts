import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "../src/remoteImage/service.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";


const daemon = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, data: { messages: [{ id: "row", role: "assistant", text: ["image.png", "a", "b", "hold", "another", "refuse"].map(name => `![image](https://example.invalid/${name})`).join(" ") }] } }));
});
let upstream: string;
before(async () => { upstream = (await listenOnLoopback(daemon)).base; });
after(async () => { daemon.closeAllConnections(); await new Promise<void>(resolve => daemon.close(() => resolve())); });

test("remote image route refuses cross-origin and serves fetched bytes", async () => {
  let calls = 0;
  const dir = mkdtempSync(join(tmpdir(), "remote-image-test-"));
  const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "fixture", url: upstream, token: "fixture" }], remoteImage: { ...defaults, stateDir: dir } }), {
    remoteImageFetch: async () => { calls++; return { ok: true, contentType: "image/png", bytes: Buffer.from("image") }; },
  });
  const { base } = await listenOnLoopback(edge);
  const path = `${base}/api/history/sessions/fixture/history/remote-image?url=${encodeURIComponent("https://example.invalid/image.png")}`;
  try {
    assert.equal((await fetch(path, { headers: { origin: "https://other.invalid" } })).status, 403);
    const response = await fetch(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(await response.text(), "image");
    assert.equal(calls, 1);
  } finally { edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("remote image cache, refusals and concurrency", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { defaults } = await import("../src/remoteImage/service.ts");
  const dir = mkdtempSync(join(tmpdir(), "remote-image-test-"));
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { started = r; });
  const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "fixture", url: upstream, token: "fixture" }],
    remoteImage: { ...defaults, stateDir: dir, cacheBytes: 170, cacheTtlMs: 30, principalConcurrency: 1 } }), {
    remoteImageFetch: async url => { calls++; if (url.endsWith("hold")) { started(); await pending; } if (url.endsWith("refuse")) return { ok: false, reason: "blocked-address" }; return { ok: true, contentType: "image/png", bytes: Buffer.from(url.slice(-1)) }; },
  });
  const { base } = await listenOnLoopback(edge);
  const request = (name: string) => fetch(`${base}/api/history/sessions/fixture/history/remote-image?url=${encodeURIComponent(`https://example.invalid/${name}`)}`);
  try {
    assert.equal(await (await request("a")).text(), "a");
    assert.equal(await (await request("a")).text(), "a");
    assert.equal(calls, 1);
    await request("b"); await request("a");
    assert.equal(calls, 3, "size eviction refetches oldest entry");
    await new Promise(resolve => setTimeout(resolve, 40));
    await request("a"); assert.equal(calls, 4, "expired entry is refetched");
    const refused = await request("refuse");
    assert.equal(refused.status, 422);
    assert.equal((await refused.json() as {error: {reason: string}}).error.reason, "blocked-address");
    const held = request("hold"); await entered;
    const busy = await request("another");
    assert.equal(busy.status, 429);
    assert.equal((await busy.json() as {error: {reason: string}}).error.reason, "busy");
    release(); await held;
  } finally { release(); edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("invalid remote image configuration fails at startup", async () => {
  const { loadConfig } = await import("../src/config.ts");
  for (const env of [{ AGENT_CONSOLE_REMOTE_IMAGE_ALLOW_LIST: "*.invalid" }, { AGENT_CONSOLE_REMOTE_IMAGE_CACHE_BYTES: "0" }, { AGENT_CONSOLE_REMOTE_IMAGE_TIMEOUT_MS: "abc" }]) {
    assert.throws(() => loadConfig({ AGENT_CONSOLE_NO_AUTH: "1", ...env }), /AGENT_CONSOLE_REMOTE_IMAGE_/);
  }
});

test("remote image requires history read access", async () => {
  const { AccessStore } = await import("../src/accessStore.ts");
  const dir = mkdtempSync(join(tmpdir(), "remote-image-access-"));
  const db = join(dir, "access.sqlite");
  const store = new AccessStore(db);
  store.claimHistory("a", "fixture", "owned", "codex", "provider"); store.close();
  let calls = 0;
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, multiUser: true, accessDbPath: db,
    principals: ["a", "b"].map(id => ({ id, token: `token-${id}`, machines: ["fixture"], permissions: [] })),
    machines: [{ name: "fixture", url: upstream, token: "fixture" }], remoteImage: { ...defaults, stateDir: dir } }), {
    remoteImageFetch: async () => { calls++; return { ok: false, reason: "not-image" }; },
  });
  const { base } = await listenOnLoopback(edge);
  const url = `${base}/api/history/sessions/fixture/owned/remote-image?url=https%3A%2F%2Fexample.invalid%2Fa`;
  try {
    assert.equal((await fetch(url, { headers: { authorization: "Bearer token-b" } })).status, 404);
    assert.equal(calls, 0);
    const response = await fetch(url, { headers: { authorization: "Bearer token-a" } });
    assert.equal(response.status, 422);
    assert.equal((await response.json() as {error: {reason: string}}).error.reason, "not-image");
    assert.equal(calls, 1);
  } finally { edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("global concurrency is enforced independently of the principal limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-image-global-"));
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "fixture", url: upstream, token: "fixture" }],
    remoteImage: { ...defaults, stateDir: dir, globalConcurrency: 1, principalConcurrency: 2 } }), {
    remoteImageFetch: async () => { entered.resolve(); await release.promise; return { ok: false, reason: "network" }; },
  });
  const { base } = await listenOnLoopback(edge);
  const url = `${base}/api/history/sessions/fixture/history/remote-image?url=https%3A%2F%2Fexample.invalid%2Fa`;
  try {
    const first = fetch(url); await entered.promise;
    const busy = await fetch(url); assert.equal(busy.status, 429);
    assert.equal((await busy.json() as {error: {reason: string}}).error.reason, "busy");
    release.resolve(); await first;
  } finally { release.resolve(); edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("a corrupt cached entry is refetched", async () => {
  const { readdirSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "remote-image-corrupt-")); let calls = 0;
  const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "fixture", url: upstream, token: "fixture" }],
    remoteImage: { ...defaults, stateDir: dir } }), {
    remoteImageFetch: async () => { calls++; return { ok: true, contentType: "image/png", bytes: Buffer.from("image") }; },
  });
  const { base } = await listenOnLoopback(edge);
  const url = `${base}/api/history/sessions/fixture/history/remote-image?url=https%3A%2F%2Fexample.invalid%2Fa`;
  try {
    await fetch(url); const cacheDir = join(dir, "remote-images");
    writeFileSync(join(cacheDir, readdirSync(cacheDir)[0]!), "corrupt");
    assert.equal(await (await fetch(url)).text(), "image"); assert.equal(calls, 2);
  } finally { edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
