import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

let upstreamAuthorization = "";
let upstreamBody = Buffer.alloc(0);
let upstreamContentType = "";
const upstream = createServer((req, res) => {
  upstreamAuthorization = String(req.headers.authorization ?? "");
  upstreamContentType = String(req.headers["content-type"] ?? "");
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    upstreamBody = Buffer.concat(chunks);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "不要刪除 src/main.ts", language: "Chinese" }));
  });
});
let edge: ReturnType<typeof createEdgeServer>;
let base = "";

before(async () => {
  const upstreamBase = (await listenOnLoopback(upstream)).base;
  edge = createEdgeServer(makeEdgeConfig({
    openAccess: false,
    clientToken: "client-secret",
    speechProviders: [{ id: "primary", label: "Summit", url: upstreamBase, token: "host-secret" }],
  }));
  base = (await listenOnLoopback(edge)).base;
});

after(() => {
  edge?.close();
  upstream.close();
});

test("speech providers expose labels but not host credentials", async () => {
  const unauthorized = await fetch(`${base}/api/speech/providers`);
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`${base}/api/speech/providers`, {
    headers: { authorization: "Bearer client-secret" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, data: { providers: [{ id: "primary", label: "Summit", max_duration_seconds: 90, max_bytes: 8388608 }] } });
  assert.equal(JSON.stringify(body).includes("host-secret"), false);
  assert.equal(JSON.stringify(body).includes("127.0.0.1"), false);
});

test("speech upload requires client auth and injects only the selected host token", async () => {
  const audio = Buffer.from("synthetic-audio");
  const headers = { "content-type": "audio/webm", authorization: "Bearer client-secret" };
  const unauthenticated = await fetch(`${base}/api/speech/primary/transcriptions`, {
    method: "POST", headers: { "content-type": "audio/webm" }, body: audio,
  });
  assert.equal(unauthenticated.status, 401);
  const response = await fetch(`${base}/api/speech/primary/transcriptions`, {
    method: "POST", headers, body: audio,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, data: { text: "不要刪除 src/main.ts", language: "Chinese", provider: "primary" } });
  assert.equal(upstreamAuthorization, "Bearer host-secret");
  assert.equal(upstreamContentType, "audio/webm");
  assert.deepEqual(upstreamBody, audio);
});

test("speech upload rejects unsupported types and oversized bodies before upstream", async () => {
  upstreamBody = Buffer.alloc(0);
  const headers = { authorization: "Bearer client-secret" };
  const badType = await fetch(`${base}/api/speech/primary/transcriptions`, {
    method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "hello",
  });
  assert.equal(badType.status, 415);
  const tooLarge = await fetch(`${base}/api/speech/primary/transcriptions`, {
    method: "POST", headers: { ...headers, "content-type": "audio/webm" }, body: Buffer.alloc(8 * 1024 * 1024 + 1),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(upstreamBody.length, 0);
});
