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
  assert.deepEqual(await response.json(), { ok: true, data: { text: "不要刪除 src/main.ts", language: "Chinese", engine: null, label: null, provider: "primary" } });
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

let engineHeader: string | undefined;
let engineListStatus = 200;
let engineMode = "ok";
const engineUpstream = createServer((req, res) => {
  if (req.url === "/v1/engines") {
    if (engineListStatus === 404) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      engines: [
        { id: "qwen", label: "Qwen", available: true, shutdown_date: null },
        { id: "gpt-transcribe", label: "GPT Transcribe", available: false, shutdown_date: "2030-01-01" },
      ],
      default: "qwen",
    }));
    return;
  }
  engineHeader = req.headers["x-speech-engine"] as string | undefined;
  req.resume();
  req.on("end", () => {
    const failure = engineMode === "400" ? 400 : engineMode === "503" ? 503 : 0;
    res.writeHead(failure || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(failure
      ? { error: { message: `engine ${engineMode} message` } }
      : { text: "ok", language: null, engine: engineHeader ?? "qwen", ...(engineMode === "label" ? { label: " Fast · local " } : engineMode === "emptylabel" ? { label: "" } : {}) }));
  });
});

test("speech engines are forwarded, the selector header is validated and forwarded, and upstream messages survive", async () => {
  const upstreamBase = (await listenOnLoopback(engineUpstream)).base;
  const engineEdge = createEdgeServer(makeEdgeConfig({
    openAccess: false,
    clientToken: "client-secret",
    speechProviders: [{ id: "primary", label: "Summit", url: upstreamBase, token: "host-secret" }],
  }));
  const engineBase = (await listenOnLoopback(engineEdge)).base;
  try {
    const auth = { authorization: "Bearer client-secret" };
    assert.equal((await fetch(`${engineBase}/api/speech/primary/engines`)).status, 401);
    const list = await fetch(`${engineBase}/api/speech/primary/engines`, { headers: auth });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { ok: true, data: {
      engines: [{ id: "qwen", label: "Qwen", available: true }, { id: "gpt-transcribe", label: "GPT Transcribe", available: false }],
      default: "qwen",
    } });
    engineListStatus = 404;
    assert.equal((await fetch(`${engineBase}/api/speech/primary/engines`, { headers: auth })).status, 404);
    engineListStatus = 200;

    const post = (extra: Record<string, string>) => fetch(`${engineBase}/api/speech/primary/transcriptions`, {
      method: "POST", headers: { ...auth, "content-type": "audio/webm", ...extra }, body: Buffer.from("a"),
    });
    const bare = await post({});
    assert.equal(engineHeader, undefined);
    assert.equal(((await bare.json()) as { data: { engine: string | null } }).data.engine, "qwen");
    engineHeader = "unset";
    const chosen = await post({ "x-speech-engine": "gpt-transcribe" });
    assert.equal(engineHeader, "gpt-transcribe");
    assert.equal(((await chosen.json()) as { data: { engine: string } }).data.engine, "gpt-transcribe");

    assert.equal(((await (await post({})).json()) as { data: { label: string | null } }).data.label, null, "an upstream without label gives null");
    engineMode = "label";
    assert.equal(((await (await post({})).json()) as { data: { label: string | null } }).data.label, " Fast · local ", "the upstream label passes through verbatim");
    engineMode = "emptylabel";
    assert.equal(((await (await post({})).json()) as { data: { label: string | null } }).data.label, null, "an empty label is absent");
    engineMode = "ok";

    engineHeader = "unset";
    assert.equal((await post({ "x-speech-engine": "bad engine!" })).status, 400);
    assert.equal(engineHeader, "unset");

    for (const status of [400, 503]) {
      engineMode = String(status);
      const failed = await post({ "x-speech-engine": "nope" });
      assert.equal(failed.status, status);
      assert.deepEqual(await failed.json(), { ok: false, error: { message: `engine ${status} message` } });
    }
  } finally {
    engineEdge.close();
    engineUpstream.close();
  }
});
