import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { after, before, test } from "node:test";
import { parseSpeechProviders } from "../src/config.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const providerToken = "synthesis-provider-fixture";
const owner = { authorization: "Bearer speech-owner-fixture" };
const input = { text: "The timer is ready.", format: "pcm_s16le", sample_rate: 8000, channels: 1 };
const mediaType = "audio/pcm; rate=8000; channels=1";
const audio = Buffer.from("pcm-fixture!");
const maxBytes = 480_000;
const calls: { path: string | undefined; authorization: string | undefined; body: string }[] = [];
let providerBase: string;
let edgeBase: string;
let providerStatus = 200;
let providerType = mediaType;
let providerAudio = audio;
let chunkedAudio = false;

const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  calls.push({ path: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
  const canary = `${providerBase} ${providerToken} ${input.text} ${audio}`;
  res.setHeader("x-provider-detail", canary);
  if (providerStatus !== 200) {
    res.writeHead(providerStatus, {
      "content-type": "application/json",
      location: `${providerBase}/unexpected`,
    }).end(JSON.stringify({ error: { message: canary } }));
    return;
  }
  res.setHeader("content-type", providerType);
  if (chunkedAudio) res.write(providerAudio.subarray(0, 1000));
  else res.setHeader("content-length", providerAudio.length);
  res.end(chunkedAudio ? providerAudio.subarray(1000) : providerAudio);
});
let edge: ReturnType<typeof createEdgeServer>;
let config: ReturnType<typeof makeEdgeConfig>;

before(async () => {
  providerBase = (await listenOnLoopback(upstream)).base;
  const machines = [{ name: "speech-machine", url: providerBase, token: "daemon-fixture" }];
  config = makeEdgeConfig({
    openAccess: false,
    multiUser: true,
    machines,
    principals: [
      { id: "owner", token: "speech-owner-fixture", machines: ["speech-machine"], permissions: ["debug"] },
      { id: "other", token: "speech-other-fixture", machines: [], permissions: [] },
    ],
    speechProviders: parseSpeechProviders(JSON.stringify([
      { id: "primary", label: "Speech", url: providerBase, token: providerToken, machine: "speech-machine", synthesis: true },
      { id: "transcription", label: "Transcription", url: providerBase, token: providerToken },
    ]), machines),
  });
  edge = createEdgeServer(config);
  edgeBase = (await listenOnLoopback(edge)).base;
});

after(() => {
  edge?.close();
  upstream.close();
});

const path = "/api/speech/v1/primary/syntheses";
function synthesize(body: unknown, auth: Record<string, string> = owner, url = `${edgeBase}${path}`) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });
}

async function assertError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
}

test("synthesis requires an active paired device or owner credential", async () => {
  const count = calls.length;
  assert.equal((await synthesize(input, {})).status, 401);
  assert.equal(calls.length, count);

  async function pair(route: string, body: unknown, status: number, auth = {}) {
    const result = await fetch(`${edgeBase}/api/auth/pairings${route}`, {
      method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body),
    });
    assert.equal(result.status, status);
    return (await result.json()).data;
  }
  const { id: pairingId, code } = await pair("", {}, 201, owner);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("hex");
  const proof = { code, challenge, delivery: "native" };
  const { principal } = await pair("/claim", { ...proof, name: "Test device" }, 200);
  await pair(`/${pairingId}/approve`, { code, challenge }, 200, owner);
  const { id, credential } = await pair("/exchange", { ...proof, principal, verifier, origin: edgeBase, confirmed: true }, 200);
  const device = { authorization: `Bearer ${credential}` };
  const successful = await synthesize(input, device);
  assert.equal(successful.status, 200);
  assert.deepEqual(Buffer.from(await successful.arrayBuffer()), audio);
  assert.equal((await fetch(`${edgeBase}/api/auth/devices/${id}`, { method: "DELETE", headers: owner })).status, 200);
  assert.equal((await synthesize(input, device)).status, 401);
  assert.equal(calls.length, count + 1);
});

test("synthesis requires a credential on an open edge", async () => {
  const openEdge = createEdgeServer({ ...config, openAccess: true, multiUser: false });
  try {
    const { base } = await listenOnLoopback(openEdge);
    const count = calls.length;
    assert.equal((await synthesize(input, {}, `${base}${path}`)).status, 401);
    assert.equal(calls.length, count);
  } finally {
    openEdge.close();
  }
});

test("speech discovery advertises synthesis only for enabled and accessible providers", async () => {
  const list = async (headers: Record<string, string>) => {
    const response = await fetch(`${edgeBase}/api/speech/providers`, { headers });
    assert.equal(response.status, 200);
    return (await response.json()).data.providers;
  };
  const transcription = { id: "transcription", label: "Transcription", max_duration_seconds: 90, max_bytes: 8388608 };
  assert.deepEqual(await list(owner), [
    { id: "primary", label: "Speech", max_duration_seconds: 90, max_bytes: 8388608, synthesis: {
      formats: ["pcm_s16le"], sample_rates: [8000], channels: 1,
      max_text_length: 1000, max_duration_seconds: 30, max_bytes: maxBytes,
    } },
    transcription,
  ]);
  const other = { authorization: "Bearer speech-other-fixture" };
  assert.deepEqual(await list(other), [transcription]);
  await assertError(await synthesize(input, other), 404, "speech-provider-not-found");
  await assertError(await synthesize(input, owner, `${edgeBase}/api/speech/v1/transcription/syntheses`), 404, "synthesis-not-offered");
});

test("synthesis negotiates mono 8 kHz PCM16 and returns only audio", async () => {
  const count = calls.length;
  for (const unsupported of [{ format: "wav" }, { sample_rate: 16000 }, { channels: 2 }]) {
    await assertError(await synthesize({ ...input, ...unsupported }), 415, "unsupported-synthesis-format");
  }
  await assertError(await synthesize(input, { ...owner, "content-type": "text/plain" }), 415, "unsupported-synthesis-format");
  await assertError(await synthesize({ ...input, text: "  " }), 400, "invalid-synthesis-request");
  const response = await synthesize(input);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), mediaType);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  assert.deepEqual(calls.slice(count), [{ path: "/v1/syntheses", authorization: `Bearer ${providerToken}`, body: JSON.stringify(input) }]);
});

test("synthesis bounds text, both request body framing modes, and provider duration", async () => {
  const count = calls.length;
  await assertError(await synthesize({ ...input, text: "a".repeat(1001) }), 413, "synthesis-input-too-large");
  await assertError(await synthesize({ ...input, text: "a".repeat(8193) }), 413, "synthesis-input-too-large");
  const chunked = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(`${edgeBase}${path}`, {
      method: "POST", headers: { ...owner, "content-type": "application/json" },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject);
    req.write("a".repeat(4096));
    req.end("b".repeat(4097));
  });
  assert.equal(chunked, 413);
  assert.equal(calls.length, count);

  try {
    providerAudio = Buffer.alloc(maxBytes);
    assert.equal((await (await synthesize(input)).arrayBuffer()).byteLength, maxBytes);
    providerAudio = Buffer.alloc(maxBytes + 2);
    await assertError(await synthesize(input), 502, "invalid-provider-audio");
    chunkedAudio = true;
    await assertError(await synthesize(input), 502, "invalid-provider-audio");
    providerAudio = Buffer.alloc(3);
    await assertError(await synthesize(input), 502, "invalid-provider-audio");
    chunkedAudio = false;
    providerAudio = audio;
    providerType = "audio/pcm; rate=16000; channels=1";
    await assertError(await synthesize(input), 502, "invalid-provider-audio");
  } finally {
    providerAudio = audio;
    providerType = mediaType;
    chunkedAudio = false;
  }
});

test("synthesis maps provider errors without leaking credentials or media into errors and logs", async (t) => {
  const logs = (["debug", "error", "info", "log", "warn"] as const).map((method) => t.mock.method(console, method, () => {}));
  const count = calls.length;
  const observed: string[] = [];
  try {
    const success = await synthesize(input);
    assert.equal(success.status, 200);
    observed.push(JSON.stringify([...success.headers]));
    await success.arrayBuffer();
    for (const [upstreamStatus, status, code] of [
      [307, 502, "speech-provider-rejected"],
      [401, 502, "speech-provider-rejected"],
      [429, 429, "speech-provider-busy"],
      [503, 503, "speech-provider-unavailable"],
    ] as const) {
      providerStatus = upstreamStatus;
      const response = await synthesize(input);
      observed.push(await response.clone().text(), JSON.stringify([...response.headers]));
      await assertError(response, status, code);
    }
    assert.equal(calls.length, count + 5, "the upstream redirect was not followed");
    const debug = await fetch(`${edgeBase}/api/debug/events`, { headers: owner });
    assert.equal(debug.status, 200);
    observed.push(await debug.text(), JSON.stringify(logs.flatMap((log) => log.mock.calls.map((call) => call.arguments))));
    for (const secret of [providerBase, providerToken, input.text, audio.toString(), JSON.stringify(audio)]) {
      assert.ok(observed.every((entry) => !entry.includes(secret)), "provider details and synthesis media stay out of errors and logs");
    }
  } finally {
    providerStatus = 200;
  }
});
