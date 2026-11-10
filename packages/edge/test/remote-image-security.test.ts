import { strict as assert } from "node:assert";
import { test, mock } from "node:test";
import { createServer } from "node:http";
import fs, { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEdgeServer } from "../src/server.ts";
import { createRemoteImageService, defaults } from "../src/remoteImage/service.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

test("remote image rejects cross-site ambient requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-security-")); let calls = 0;
  const daemon = createServer((_req, res) => { res.writeHead(422, {"content-type":"application/json"}); res.end(JSON.stringify({error:{code:"history-image-unavailable",reason:"remote-url-not-fetched",source_url:"https://example.invalid/image"}})); });
  const upstream = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, clientToken: "client-secret", machines: [{ name: "fixture", url: upstream.base, token: "fixture" }], remoteImage: { ...defaults, stateDir: dir } }), {
    remoteImageFetch: async () => { calls++; return { ok: true, contentType: "image/png", bytes: Buffer.from("image") }; },
  });
  const { base } = await listenOnLoopback(edge); const cookie = await loginCookie(base);
  const image = `${"a".repeat(16)}.0.0.${"b".repeat(32)}`;
  const url = `${base}/api/history/sessions/fixture/history/remote-image/${image}`;
  try {
    assert.equal((await fetch(url, {headers:{cookie,"sec-fetch-site":"same-site"}})).status,403); assert.equal(calls,0);
    assert.equal((await fetch(url, {headers:{cookie,"sec-fetch-site":"same-origin"}})).status,200); assert.equal(calls,1);
    assert.equal((await fetch(url, {headers:{authorization:"Bearer client-secret","sec-fetch-site":"cross-site"}})).status,200);
  } finally { edge.closeAllConnections(); daemon.closeAllConnections(); await Promise.all([edge, daemon].map(server => new Promise<void>(resolve => server.close(() => resolve())))); rmSync(dir, { recursive: true, force: true }); }
});

test("partial cache writes do not exceed the cache bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-cache-failure-"));
  const service = createRemoteImageService({ ...defaults, stateDir: dir, cacheBytes: 200 }, async () => ({ ok: true, contentType: "image/png", bytes: Buffer.from("image") }));
  try {
    await service("a", "https://example.invalid/a");
    const original = fs.writeFileSync;
    mock.method(fs, "writeFileSync", ((path: fs.PathOrFileDescriptor) => { original(path, Buffer.alloc(100)); throw Object.assign(new Error("full"), { code: "ENOSPC" }); }) as typeof fs.writeFileSync);
    syncBuiltinESMExports();
    try { assert.equal((await service("a", "https://example.invalid/b")).ok, true); }
    finally { mock.restoreAll(); syncBuiltinESMExports(); }
    const cache = join(dir, "remote-images");
    assert.ok(readdirSync(cache).reduce((sum, name) => sum + statSync(join(cache, name)).size, 0) <= 200);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
});
