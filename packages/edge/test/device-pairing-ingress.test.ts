import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, request } from "node:https";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback } from "./support.ts";

for (const peers of [undefined, "192.0.2.1"]) test(`production pairing refuses plaintext and spoofed HTTPS (${peers ? "unmatched proxy" : "no proxy"})`, async () => {
  const edge = createEdgeServer(loadConfig({ AGENT_CONSOLE_TOKEN: "main-fixture", AGENT_CONSOLE_PAIRING_TRUSTED_PROXY_PEERS: peers }));
  const { base } = await listenOnLoopback(edge);
  try {
    for (const extra of [{}, { "x-forwarded-proto": "https" }, { origin: base.replace("http:", "https:") }]) {
      const response = await fetch(`${base}/api/auth/pairings`, { method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer main-fixture", ...extra }, body: "{}" });
      assert.equal(response.status, 403, "untrusted plaintext must never return a pairing code");
      assert.deepEqual(await response.json(), { ok: false, error: { message: "Secure pairing transport required." } });
    }
  } finally { edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); }
});

test("insecure-cookie development opt-in cannot authorize a nonlocal request host", async () => {
  const edge = createEdgeServer(loadConfig({ AGENT_CONSOLE_TOKEN: "main-fixture", AGENT_CONSOLE_INSECURE_COOKIE: "1" }));
  const { base } = await listenOnLoopback(edge);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/api/auth/pairings`, { method: "POST", headers: {
        "content-type": "application/json", authorization: "Bearer main-fixture", host: "edge.example.test" } }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(status, 403);
  } finally { edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); }
});

test("actual TLS qualifies without forwarded headers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pairing-tls-"));
  const edge = createEdgeServer(loadConfig({ AGENT_CONSOLE_TOKEN: "main-fixture" }));
  let tls: ReturnType<typeof createHttpsServer> | undefined;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"),
      "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    tls = createHttpsServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
      (req, res) => { edge.emit("request", req, res); });
    const { port } = await listenOnLoopback(tls);
    const status = await new Promise<number>((resolve, reject) => {
      // This synthetic loopback server uses a throwaway certificate; production TLS validation is unchanged.
      const req = request({ hostname: "127.0.0.1", port, path: "/api/auth/pairings", method: "POST", rejectUnauthorized: false,
        headers: { "content-type": "application/json", authorization: "Bearer main-fixture" } }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(status, 201);
  } finally {
    if (tls) { tls.closeAllConnections(); await new Promise<void>(resolve => tls!.close(() => resolve())); }
    await new Promise<void>(resolve => edge.close(() => resolve()));
    rmSync(dir, { recursive: true });
  }
});

test("trusted proxy requires one exact HTTPS signal throughout pairing and exchange", async () => {
  const edge = createEdgeServer(loadConfig({ AGENT_CONSOLE_TOKEN: "main-fixture",
    AGENT_CONSOLE_PAIRING_TRUSTED_PROXY_PEERS: "127.0.0.1" }));
  const { base } = await listenOnLoopback(edge);
  const call = (route: string, body: unknown, proto?: string, main = false) => fetch(`${base}/api/auth/${route}`, {
    method: "POST", headers: { "content-type": "application/json", ...(proto ? { "x-forwarded-proto": proto } : {}),
      ...(main ? { authorization: "Bearer main-fixture" } : {}) }, body: JSON.stringify(body),
  });
  try {
    for (const proto of [undefined, "http", "HTTPS", "https, http", "http, https"]) {
      assert.equal((await call("pairings", {}, proto, true)).status, 403);
    }
    const created = await call("pairings", {}, "https", true);
    assert.equal(created.status, 201);
    const pair = (await created.json()).data;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("hex");
    const claim = { code: pair.code, challenge, name: "Fixture device", delivery: "native" };
    assert.equal((await call("pairings/claim", claim)).status, 403);
    const claimed = await call("pairings/claim", claim, "https");
    assert.equal(claimed.status, 200);
    const recipient = (await claimed.json()).data;
    assert.equal((await call(`pairings/${pair.id}/approve`, { code: pair.code, challenge }, "https", true)).status, 200);
    const exchange = { ...claim, verifier, principal: recipient.principal,
      origin: base.replace("http:", "https:"), confirmed: true };
    assert.equal((await call("pairings/exchange", exchange)).status, 403);
    const issued = await call("pairings/exchange", exchange, "https");
    assert.equal(issued.status, 200, "refused plaintext exchange must not consume approval");
    assert.equal(typeof (await issued.json()).data.credential, "string");
  } finally { edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); }
});

test("trusted proxy configuration accepts IP literals and rejects names, ranges and empty entries", () => {
  for (const value of ["proxy.example.test", "127.0.0.0/8", "127.0.0.1,", "127.0.0.1,,::1"]) {
    assert.throws(() => loadConfig({ AGENT_CONSOLE_TOKEN: "main-fixture", AGENT_CONSOLE_PAIRING_TRUSTED_PROXY_PEERS: value }),
      /AGENT_CONSOLE_PAIRING_TRUSTED_PROXY_PEERS/);
  }
});
