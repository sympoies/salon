import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { fetchRemoteImage } from "../src/remoteImage/fetch.ts";
import { parseAllowList } from "../src/remoteImage/address.ts";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const images = [
  ["image/png", png],
  ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0x00])],
  ["image/gif", Buffer.from("GIF89a")],
  ["image/webp", Buffer.from("RIFF\x00\x00\x00\x00WEBP")],
] as const;

async function fixture(handler: http.RequestListener, run: (url: string, options: any, seen: string[]) => Promise<void>) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const seen: string[] = [];
  const options = {
    allowList: parseAllowList([`images.example:${port}`]),
    resolver: async () => ["8.8.8.8"],
    connector: (options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
      const lookup = options.lookup!;
      return http.request({ ...options, lookup: (hostname, opts, cb) => {
        lookup(hostname, opts, ((error: Error | null, address: string) => {
          if (error) return (cb as any)(error);
          seen.push(Array.isArray(address) ? address[0].address : address);
          if (typeof opts === "object" && opts.all) (cb as any)(null, [{ address: "127.0.0.1", family: 4 }]);
          else (cb as any)(null, "127.0.0.1", 4);
        }) as any);
      } }, callback);
    },
  };
  try { await run(`http://images.example:${port}`, options, seen); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("blocks loopback and mixed answers before connecting", async () => {
  let hits = 0;
  await fixture((_req, res) => { hits++; res.end(png); }, async (url, options) => {
    assert.deepEqual(await fetchRemoteImage(url, { ...options, resolver: async () => ["127.0.0.1"] }), { ok: false, reason: "blocked-address" });
    assert.deepEqual(await fetchRemoteImage(url, { ...options, resolver: async () => ["8.8.8.8", "127.0.0.1"] }), { ok: false, reason: "blocked-address" });
    assert.deepEqual(await fetchRemoteImage(url, { allowList: options.allowList, resolver: async () => ["127.0.0.1"] }), { ok: false, reason: "blocked-address" });
    assert.equal(hits, 0);
  });
});

test("follows relative redirects, blocks unsafe hops and limits redirects", async () => {
  await fixture((req, res) => {
    if (req.url === "/relative") { res.writeHead(302, { location: "/image" }); res.end(); }
    else if (req.url === "/blocked") { res.writeHead(302, { location: "http://blocked.example/image" }); res.end(); }
    else if (req.url?.startsWith("/chain")) { const n = Number(req.url.slice(6)); res.writeHead(302, { location: `/chain${n + 1}` }); res.end(); }
    else res.end(png);
  }, async (url, options) => {
    assert.equal((await fetchRemoteImage(`${url}/relative`, options)).ok, true);
    assert.deepEqual(await fetchRemoteImage(`${url}/blocked`, { ...options, resolver: async (host: string) => host === "blocked.example" ? ["127.0.0.1"] : ["8.8.8.8"] }), { ok: false, reason: "blocked-address" });
    assert.deepEqual(await fetchRemoteImage(`${url}/chain0`, options), { ok: false, reason: "too-many-redirects" });
  });
});

test("pins one resolution and sends only fixed request headers", async () => {
  let calls = 0;
  await fixture((req, res) => {
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["user-agent"], "Salon-Remote-Image/1.0");
    assert.equal(req.headers.accept, "image/*");
    assert.equal(req.headers.host?.startsWith("images.example:"), true);
    res.end(png);
  }, async (url, options, seen) => {
    const result = await fetchRemoteImage(url, { ...options, resolver: async () => ++calls === 1 ? ["8.8.8.8"] : ["127.0.0.1"] });
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    assert.deepEqual(seen, ["8.8.8.8"]);
  });
});

test("enforces body size, deadline and image signatures", async () => {
  await fixture((req, res) => {
    if (req.url === "/slow") { res.write(png); setTimeout(() => res.end(), 200); return; }
    if (req.url === "/large") { res.end(Buffer.alloc(100)); return; }
    if (req.url === "/svg") { res.end("<svg></svg>"); return; }
    if (req.url === "/text") { res.end("hello"); return; }
    if (req.url === "/status") { res.writeHead(404); res.end(); return; }
    res.end(images[Number(req.url?.slice(1))]?.[1]);
  }, async (url, options) => {
    assert.deepEqual(await fetchRemoteImage(`${url}/large`, { ...options, maxBytes: 20 }), { ok: false, reason: "too-large" });
    assert.deepEqual(await fetchRemoteImage(`${url}/slow`, { ...options, timeoutMs: 30 }), { ok: false, reason: "timeout" });
    for (const path of ["svg", "text"]) assert.deepEqual(await fetchRemoteImage(`${url}/${path}`, options), { ok: false, reason: "not-image" });
    assert.deepEqual(await fetchRemoteImage(`${url}/status`, options), { ok: false, reason: "upstream-status" });
    for (const [i, [contentType, bytes]] of images.entries()) assert.deepEqual(await fetchRemoteImage(`${url}/${i}`, options), { ok: true, contentType, bytes });
    assert.deepEqual(await fetchRemoteImage("file:///image", options), { ok: false, reason: "invalid-url" });
  });
});

test("each fetch connects to its newly approved address", async () => {
  await fixture((_req, res) => res.end(png), async (url, options, seen) => {
    let count = 0;
    const resolver = async () => [++count === 1 ? "8.8.8.8" : "9.9.9.9"];
    assert.equal((await fetchRemoteImage(url, { ...options, resolver })).ok, true);
    assert.equal((await fetchRemoteImage(url, { ...options, resolver })).ok, true);
    assert.deepEqual(seen, ["8.8.8.8", "9.9.9.9"]);
  });
});
