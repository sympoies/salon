import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { test } from "node:test";
import { createEdgeServer } from "../src/server.ts";
import { matchApiRoute } from "../src/apiRoutes.ts";
import { normalizeCodexResetResult } from "../src/codexReset.ts";
import { closeServers, listenOnLoopback, makeEdgeConfig } from "./support.ts";

const IDEMPOTENCY_KEY = "123e4567-e89b-42d3-a456-426614174000";

test("Codex reset response normalization accepts only the four stable domain outcomes", () => {
  for (const outcome of ["reset", "nothing_to_reset", "no_credit", "already_redeemed"]) {
    assert.deepEqual(normalizeCodexResetResult({
      schema_version: "agent-console.codex-rate-limit-reset.v1",
      outcome,
      windows_reset: 0,
      private: "drop-me",
    }), {
      schema_version: "agent-console.codex-rate-limit-reset.v1",
      outcome,
      windows_reset: 0,
    });
  }
  for (const value of [
    { schema_version: "future", outcome: "reset" },
    { schema_version: "agent-console.codex-rate-limit-reset.v1", outcome: "future" },
    { schema_version: "agent-console.codex-rate-limit-reset.v1", outcome: "reset", windows_reset: -1 },
    { schema_version: "agent-console.codex-rate-limit-reset.v1", outcome: "reset", windows_reset: 1.5 },
  ]) assert.equal(normalizeCodexResetResult(value), null);
});

test("Codex reset API route is POST-only", () => {
  assert.equal(matchApiRoute("/api/codex/rate-limit-reset", "POST")?.methodAllowed, true);
  assert.equal(matchApiRoute("/api/codex/rate-limit-reset", "GET")?.methodAllowed, false);
});

test("Codex reset route forwards one authenticated exact request and strips unknown response fields", async () => {
  const seen: Array<{ url?: string; method?: string; authorization?: string; body?: unknown }> = [];
  const controller = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    seen.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      schema_version: "agent-console.codex-rate-limit-reset.v1",
      outcome: "reset",
      windows_reset: 2,
      secret: "must-not-pass",
    }));
  });
  const { base: controllerBase } = await listenOnLoopback(controller);
  const edge = createEdgeServer({
    ...makeEdgeConfig(),
    codexReset: { url: controllerBase, token: "controller-secret" },
  });
  const { base } = await listenOnLoopback(edge);
  try {
    const response = await fetch(`${base}/api/codex/rate-limit-reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ account: "sym", idempotency_key: IDEMPOTENCY_KEY }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      data: {
        schema_version: "agent-console.codex-rate-limit-reset.v1",
        outcome: "reset",
        windows_reset: 2,
      },
    });
    assert.deepEqual(seen, [{
      url: "/reset",
      method: "POST",
      authorization: "Bearer controller-secret",
      body: { account: "sym", idempotency_key: IDEMPOTENCY_KEY },
    }]);
  } finally {
    closeServers(edge, controller);
  }
});

test("Codex reset route posts to agent-session serve's reset path and keeps only the stable result", async () => {
  const seen: string[] = [];
  const serve = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      schema_version: "agent-console.codex-rate-limit-reset.v1",
      outcome: "nothing_to_reset",
      replayed: true,
      machine: "summit",
      usage: { schema_version: "agent-session.provider-usage.v1", providers: [] },
    }));
  });
  const { base: serveBase } = await listenOnLoopback(serve);
  const edge = createEdgeServer({
    ...makeEdgeConfig(),
    codexReset: { url: serveBase, token: "serve-secret", path: "/codex/reset/v1" },
  });
  const { base } = await listenOnLoopback(edge);
  try {
    const response = await fetch(`${base}/api/codex/rate-limit-reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ account: "sym", idempotency_key: IDEMPOTENCY_KEY }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      data: { schema_version: "agent-console.codex-rate-limit-reset.v1", outcome: "nothing_to_reset" },
    });
    assert.deepEqual(seen, ["POST /codex/reset/v1"]);
  } finally {
    closeServers(edge, serve);
  }
});

test("Codex reset route rejects cross-origin and malformed input before reaching the controller", async () => {
  let calls = 0;
  const controller = createServer((_req, res) => {
    calls += 1;
    res.writeHead(500).end();
  });
  const { base: controllerBase } = await listenOnLoopback(controller);
  const edge = createEdgeServer({
    ...makeEdgeConfig(),
    codexReset: { url: controllerBase, token: null },
  });
  const { base } = await listenOnLoopback(edge);
  try {
    const cases = [
      { origin: "https://evil.example", body: { account: "sym", idempotency_key: IDEMPOTENCY_KEY }, status: 403 },
      { origin: base, body: { account: "../sym", idempotency_key: IDEMPOTENCY_KEY }, status: 422 },
      { origin: base, body: { account: "sym", idempotency_key: IDEMPOTENCY_KEY.toUpperCase() }, status: 422 },
      { origin: base, body: { account: "sym", idempotency_key: IDEMPOTENCY_KEY, extra: true }, status: 422 },
    ];
    for (const item of cases) {
      const response = await fetch(`${base}/api/codex/rate-limit-reset`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: item.origin },
        body: JSON.stringify(item.body),
      });
      assert.equal(response.status, item.status);
    }
    assert.equal(calls, 0);
  } finally {
    closeServers(edge, controller);
  }
});

test("Codex reset route fails closed when the dedicated controller is unavailable", async () => {
  const edge = createEdgeServer(makeEdgeConfig());
  const { base } = await listenOnLoopback(edge);
  try {
    const response = await fetch(`${base}/api/codex/rate-limit-reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ account: "sym", idempotency_key: IDEMPOTENCY_KEY }),
    });
    assert.equal(response.status, 503);
    assert.match(JSON.stringify(await response.json()), /controller not configured/);
  } finally {
    closeServers(edge);
  }
});
