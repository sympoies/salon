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

test("remote fetch is bound to history text and rejects cross-site ambient requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-security-"));
  const daemon = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, data: { messages: _req.url?.includes("/empty/") ? [] : [{ id: "row", role: "assistant", text: "![image](https://example.invalid/allowed) ![proxy](https://public.invalid/render?next=(https://private.invalid/secret)) ![other](https://example.invalid/it's.png) https://public.invalid/path/https://private.invalid/path https://public.invalid/#(https://private.invalid/fragment) prefixhttps://private.invalid/longer [link](https://example.invalid/link) <https://example.invalid/angle> https://example.invalid/bare" }, { id: "ref", role: "assistant", text: "![x][ref]\n[ref]: https://public.invalid/image \"title https://private.invalid/reference rest\"" }, { id: "title", role: "assistant", text: "![x](https://public.invalid/image (title https://private.invalid/parenthesized rest))" }, { id: "multi", role: "assistant", text: "![x](https://public.invalid/image (title\nhttps://private.invalid/multiline rest))" }, { id: "double", role: "assistant", text: "![x](https://public.invalid/image \"title\nhttps://private.invalid/double rest\")" }, { id: "single", role: "assistant", text: "![x](https://public.invalid/image 'title\nhttps://private.invalid/single rest')" }, { id: "html", role: "assistant", text: "<img src=\"https://public.invalid/image\" title=\"note https://private.invalid/html rest\">" }] } })); });
  const upstream = await listenOnLoopback(daemon); let calls = 0;
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, clientToken: "client-secret", machines: [{ name: "fixture", url: upstream.base, token: "fixture" }], remoteImage: { ...defaults, stateDir: dir } }), {
    remoteImageFetch: async () => { calls++; return { ok: true, contentType: "image/png", bytes: Buffer.from("image") }; },
  });
  const { base } = await listenOnLoopback(edge);
  const cookie = await loginCookie(base);
  const request = (url: string, headers: Record<string, string> = {}, history = "history") => fetch(`${base}/api/history/sessions/fixture/${history}/remote-image?url=${encodeURIComponent(url)}`, { headers: { cookie, ...headers } });
  try {
    assert.equal((await request("https://example.invalid/allowed", { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" })).status, 403);
    assert.equal(calls, 0);
    assert.equal((await request("https://example.invalid/unrelated", {}, "empty")).status, 404);
    assert.equal((await request("https://example.invalid/allow")).status, 404);
    assert.equal((await request("https://private.invalid/secret")).status, 404);
    for (const suffix of ["path", "fragment", "longer", "reference", "parenthesized", "html", "multiline", "double", "single"]) assert.equal((await request(`https://private.invalid/${suffix}`)).status, 404);
    assert.equal((await request("https://example.invalid/it")).status, 404);
    assert.equal(calls, 0);

    assert.equal((await request("https://example.invalid/allowed", { "sec-fetch-site": "same-origin" })).status, 200);
    assert.equal(calls, 1);
    assert.equal((await request("https://public.invalid/render?next=(https://private.invalid/secret)")).status, 200);
    assert.equal((await request("https://example.invalid/it's.png")).status, 200);
    assert.equal(calls, 3);
    for (const suffix of ["link", "angle", "bare"]) assert.equal((await request(`https://example.invalid/${suffix}`)).status, 200);
    assert.equal(calls, 6);
    assert.equal((await request("https://example.invalid/allowed", { authorization: "Bearer client-secret", "sec-fetch-site": "cross-site" })).status, 200);
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
