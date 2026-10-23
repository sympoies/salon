import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { test } from "node:test";
import { createEdgeServer } from "../src/server.ts";
import { matchApiRoute } from "../src/apiRoutes.ts";
import { normalizeClaudeResetResult, resetClaudeLimit } from "../src/claudeReset.ts";
import { normalizeProviders } from "../src/usage.ts";
import { closeServers, listenOnLoopback, makeEdgeConfig } from "./support.ts";

const IDEMPOTENCY_KEY = "123e4567-e89b-42d3-a456-426614174000";
const SCHEMA = "agent-console.claude-limit-reset.v1";

function claudeEntry(limitResets: unknown) {
  return normalizeProviders({
    providers: [{ provider: "claude", account: "a@example.com", profile: "work", windows: [], limit_resets: limitResets }],
  })[0];
}

test("Claude limit resets normalize both programs and drop ids and unknown fields", () => {
  const entry = claudeEntry({
    juniper_tide: {
      available: true,
      ineligible_reason: null,
      resets_per_week: 1,
      next_available_at: null,
      weekly_resets_at: "2026-10-07T01:00:00+00:00",
      arm: "reset",
      event_props: { tier: "claude_max_20x" },
    },
    cedar_ember: {
      available: true,
      ineligible_reason: null,
      next_grant_id: "grant_a",
      grants: [
        {
          id: "grant_a",
          label: "Launch week",
          resets_left: 1,
          resets_total: 1,
          starts_at: "2026-10-01T00:00:00Z",
          expires_at: 1791763200,
          clears: ["five_hour", "seven_day"],
          usable_now: true,
        },
        { id: "grant_b", label: "", resets_left: 2, resets_total: null, ends_at: "2026-10-30T00:00:00Z", clears: "x", usable_now: "yes" },
      ],
      cooldown_until: null,
      weekly_resets_at: 1791334800,
    },
  });
  assert.deepEqual(entry?.limit_resets, {
    juniper_tide: {
      available: true,
      ineligible_reason: null,
      resets_per_week: 1,
      next_available_at: null,
      weekly_resets_at: 1791334800,
    },
    cedar_ember: {
      available: true,
      ineligible_reason: null,
      grants: [
        {
          label: "Launch week",
          resets_left: 1,
          resets_total: 1,
          starts_at: 1790812800,
          expires_at: 1791763200,
          clears: ["five_hour", "seven_day"],
          usable_now: true,
        },
        { label: null, resets_left: 2, resets_total: null, starts_at: null, expires_at: 1793318400, clears: [], usable_now: false },
      ],
      cooldown_until: null,
      weekly_resets_at: 1791334800,
    },
  });
  assert.doesNotMatch(JSON.stringify(entry), /grant_a|grant_b|claude_max_20x/);
});

test("Claude limit resets degrade a malformed program to unknown without breaking the card", () => {
  const entry = claudeEntry({
    juniper_tide: { available: "yes", ineligible_reason: "not_at_wall" },
    cedar_ember: {
      available: false,
      ineligible_reason: "Tenure; <script>",
      grants: [{ label: "bad", resets_left: -1 }, { label: "frac", resets_left: 1.5 }, "x"],
    },
  });
  assert.equal(entry?.account, "a@example.com");
  assert.deepEqual(entry?.limit_resets, {
    juniper_tide: null,
    cedar_ember: {
      available: false,
      ineligible_reason: "unknown",
      grants: [],
      cooldown_until: null,
      weekly_resets_at: null,
    },
  });
  for (const value of [null, "nope", [], 7]) assert.equal(claudeEntry(value)?.limit_resets, null);
  assert.deepEqual(claudeEntry({})?.limit_resets, { juniper_tide: null, cedar_ember: null });
  // An older reader that sends no field keeps the entry shape unchanged.
  const legacy = normalizeProviders({ providers: [{ provider: "claude", windows: [] }] })[0];
  assert.equal(Object.hasOwn(legacy, "limit_resets"), false);
});

test("Claude limit resets bound the grant list", () => {
  const grants = Array.from({ length: 40 }, (_, index) => ({ label: `g${index}`, resets_left: 1 }));
  const entry = claudeEntry({ cedar_ember: { available: true, grants } });
  assert.equal(entry?.limit_resets?.cedar_ember?.grants.length, 16);
});

test("Claude reset result normalization accepts only stable outcomes and drops extras", () => {
  for (const outcome of ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"]) {
    assert.deepEqual(normalizeClaudeResetResult({
      schema_version: SCHEMA,
      program: "cedar_ember",
      outcome,
      posted: true,
      reason: "not_next_grant",
      resets_left: 1,
      next_available_at: null,
      cooldown_until: "2026-10-02T00:00:00Z",
      weekly_resets_at: 1791334800,
      replayed: false,
      machine: "summit",
      grant_id: "must-not-pass",
    }), {
      schema_version: SCHEMA,
      program: "cedar_ember",
      outcome,
      reason: "not_next_grant",
      resets_left: 1,
      next_available_at: null,
      cooldown_until: 1790899200,
      weekly_resets_at: 1791334800,
    });
  }
  for (const value of [
    { schema_version: "future", program: "juniper_tide", outcome: "reset" },
    { schema_version: SCHEMA, program: "other", outcome: "reset" },
    { schema_version: SCHEMA, program: "juniper_tide", outcome: "future" },
    { schema_version: SCHEMA, program: "juniper_tide", outcome: "reset", resets_left: -1 },
    null,
  ]) assert.equal(normalizeClaudeResetResult(value), null);
  assert.deepEqual(normalizeClaudeResetResult({ schema_version: SCHEMA, program: "juniper_tide", outcome: "already_used" }), {
    schema_version: SCHEMA,
    program: "juniper_tide",
    outcome: "already_used",
    reason: null,
    resets_left: null,
    next_available_at: null,
    cooldown_until: null,
    weekly_resets_at: null,
  });
});

test("Claude reset API route is POST-only", () => {
  assert.equal(matchApiRoute("/api/claude/limit-reset", "POST")?.methodAllowed, true);
  assert.equal(matchApiRoute("/api/claude/limit-reset", "GET")?.methodAllowed, false);
});

test("Claude reset route forwards one exact request to serve and keeps only the stable result", async () => {
  const seen: Array<{ url?: string; method?: string; authorization?: string; body?: unknown }> = [];
  const serve = createServer(async (req, res) => {
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
      schema_version: SCHEMA,
      program: "juniper_tide",
      outcome: "reset",
      posted: true,
      reason: null,
      next_available_at: "2026-10-08T00:00:00Z",
      weekly_resets_at: null,
      replayed: false,
      machine: "summit",
      secret: "must-not-pass",
    }));
  });
  const { base: serveBase } = await listenOnLoopback(serve);
  const edge = createEdgeServer({
    ...makeEdgeConfig(),
    claudeReset: { url: serveBase, token: "serve-secret" },
  });
  const { base } = await listenOnLoopback(edge);
  try {
    const response = await fetch(`${base}/api/claude/limit-reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ account: "work", program: "juniper_tide", idempotency_key: IDEMPOTENCY_KEY }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      data: {
        schema_version: SCHEMA,
        program: "juniper_tide",
        outcome: "reset",
        reason: null,
        resets_left: null,
        next_available_at: 1791417600,
        cooldown_until: null,
        weekly_resets_at: null,
      },
    });
    assert.deepEqual(seen, [{
      url: "/claude/reset/v1",
      method: "POST",
      authorization: "Bearer serve-secret",
      body: { account: "work", program: "juniper_tide", idempotency_key: IDEMPOTENCY_KEY },
    }]);
  } finally {
    closeServers(edge, serve);
  }
});

test("Claude reset route rejects cross-origin and malformed input before reaching serve", async () => {
  let calls = 0;
  const serve = createServer((_req, res) => {
    calls += 1;
    res.writeHead(500).end();
  });
  const { base: serveBase } = await listenOnLoopback(serve);
  const edge = createEdgeServer({
    ...makeEdgeConfig(),
    claudeReset: { url: serveBase, token: null },
  });
  const { base } = await listenOnLoopback(edge);
  const valid = { account: "work", program: "cedar_ember", idempotency_key: IDEMPOTENCY_KEY };
  try {
    const cases = [
      { origin: "https://evil.example", body: valid, status: 403 },
      { origin: base, body: { ...valid, account: "../work" }, status: 422 },
      { origin: base, body: { ...valid, program: "other" }, status: 422 },
      { origin: base, body: { ...valid, idempotency_key: IDEMPOTENCY_KEY.toUpperCase() }, status: 422 },
      { origin: base, body: { ...valid, grant_id: "grant_a" }, status: 422 },
      { origin: base, body: { account: "work", idempotency_key: IDEMPOTENCY_KEY }, status: 422 },
    ];
    for (const entry of cases) {
      const response = await fetch(`${base}/api/claude/limit-reset`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: entry.origin },
        body: JSON.stringify(entry.body),
      });
      assert.equal(response.status, entry.status, JSON.stringify(entry.body));
    }
    assert.equal(calls, 0);
  } finally {
    closeServers(edge, serve);
  }
});

test("Claude reset route fails closed when serve is unset or returns an invalid result", async () => {
  const body = JSON.stringify({ account: "work", program: "juniper_tide", idempotency_key: IDEMPOTENCY_KEY });
  const unset = createEdgeServer(makeEdgeConfig());
  const { base: unsetBase } = await listenOnLoopback(unset);
  const serve = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ schema_version: SCHEMA, program: "juniper_tide", outcome: "maybe" }));
  });
  const { base: serveBase } = await listenOnLoopback(serve);
  const edge = createEdgeServer({ ...makeEdgeConfig(), claudeReset: { url: serveBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const notConfigured = await fetch(`${unsetBase}/api/claude/limit-reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: unsetBase },
      body,
    });
    assert.equal(notConfigured.status, 503);
    const invalid = await fetch(`${base}/api/claude/limit-reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body,
    });
    assert.equal(invalid.status, 502);
    assert.equal(((await invalid.json()) as { ok: boolean }).ok, false);
  } finally {
    closeServers(unset, edge, serve);
  }
});

test("Claude reset waits for serve's redemption deadline instead of the shared reader timeout", async () => {
  // serve runs the CLI's status read and POST for up to 35 seconds; an edge
  // timeout shorter than that would report a failure for a reset that landed.
  const serve = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schema_version: SCHEMA, program: "juniper_tide", outcome: "reset" }));
    }, 25);
  });
  const { base } = await listenOnLoopback(serve);
  try {
    const result = await resetClaudeLimit(
      { url: base, token: null, timeoutMs: 1 },
      { account: "work", program: "juniper_tide", idempotency_key: IDEMPOTENCY_KEY },
    );
    assert.equal(result.outcome, "reset");
  } finally {
    closeServers(serve);
  }
});
