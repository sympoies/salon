import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_RETITLE_CAPABILITY,
  SESSION_RETITLE_READINESS_SCHEMA_VERSION,
  SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
  SESSION_RETITLE_SCHEMA_VERSION,
  SESSION_RETITLE_V3_CAPABILITY,
  SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION,
  SESSION_RETITLE_V3_RECEIPTS_SCHEMA_VERSION,
  SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION,
  SESSION_RETITLE_V3_SCHEMA_VERSION,
} from "@agent-console/shared/session-retitle";
import {
  SESSION_RETITLE_PROVIDER_MAX_TIMEOUT_MS,
  SESSION_RETITLE_READINESS_TIMEOUT_MS,
  SESSION_RETITLE_TIMEOUT_MS,
  createEdgeServer,
} from "../src/server.ts";
import { closeServers, listenOnLoopback, makeEdgeConfig } from "./support.ts";

const daemonBodies: unknown[] = [];
const daemonV3Bodies: unknown[] = [];
const operationHash = `sha256:${"b".repeat(64)}`;
const uiDir = mkdtempSync(join(tmpdir(), "ac-retitle-v2-"));
let daemon: Server;
let legacyDaemon: Server;
let edge: Server;
let base = "";
let nextRetitleErrorCode: string | null = null;

const PRODUCER_ERROR_CODES = [
  "invalid-retitle-request",
  "retitle-provider-not-configured",
  "retitle-config-invalid",
  "retitle-queue-saturated",
  "retitle-context-unavailable",
  "retitle-account-missing",
  "retitle-api-key-missing",
  "retitle-provider-timeout",
  "retitle-provider-unavailable",
  "retitle-provider-rate-limited",
  "retitle-provider-quota-exceeded",
  "retitle-provider-malformed-response",
  "idempotency-key-reused",
  "session-incarnation-conflict",
  "title-revision-conflict",
  "retitle-turn-conflict",
  "retitle-state-conflict",
  "retitle-worker-failed",
  "title-revision-overflow",
] as const;

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of req) body += chunk.toString("utf8");
  return body ? JSON.parse(body) : undefined;
}

const readiness = {
  schema_version: SESSION_RETITLE_READINESS_SCHEMA_VERSION,
  capability: SESSION_RETITLE_CAPABILITY,
  status: "ready",
  reason_code: "ready",
  next_action: "none",
  provider_kind: "codex_subscription",
  model_label: "gpt-5-codex",
  account: "work",
  plan: "pro",
  context_capabilities: {
    codex: "provider_transcript",
    claude: "provider_transcript",
    hermes: "unavailable",
  },
  access_token: "must-not-cross-edge",
};

const retitle = {
  schema_version: SESSION_RETITLE_SCHEMA_VERSION,
  outcome: "committed",
  changed: true,
  trigger: "manual",
  provider_kind: "codex_subscription",
  diagnostic_code: "accepted",
  // Manual requests have no expected provider turn; the daemon serializes None as null.
  processed_turn_id_hash: null,
  coverage: { source: "provider_transcript", complete: true, truncated: false, turn_count: 6 },
  session: {
    title: "Durable retitle context - Verify fallback",
    title_state: {
      topic: "Durable retitle context",
      topic_source: "auto",
      references: [],
      activity: "Verify fallback",
    },
    title_revision: 8,
    session_incarnation: "launch-s1",
  },
  model_output: "must-not-cross-edge",
};

const v3Readiness = {
  schema_version: SESSION_RETITLE_V3_READINESS_SCHEMA_VERSION,
  capability: SESSION_RETITLE_V3_CAPABILITY,
  status: "stale",
  provider_status: "ready",
  context_status: "stale",
  title_status: "stale",
  reason_code: "history_advanced",
  next_action: "refresh_memory",
  memory_revision: 41,
  usable_memory: true,
  pending_operation: false,
  cursor_fence_hash: `sha256:${"a".repeat(64)}`,
  transcript: "must-not-cross-edge",
};

const v3Terminal = {
  schema_version: SESSION_RETITLE_V3_SCHEMA_VERSION,
  capability: SESSION_RETITLE_V3_CAPABILITY,
  status: "terminal",
  outcome: "degraded_cached",
  changed: false,
  failure_class: "timeout",
  failure_stage: "provider_call",
  provider_attempts: [{
    provider_kind: "codex_subscription",
    model_label: "gpt-5.6",
    outcome: "timeout",
    failure_class: "timeout",
    failure_stage: "provider_call",
    started_at: "2026-09-10T00:00:00Z",
    finished_at: "2026-09-10T00:00:01Z",
    duration_bucket: "1_4_s",
    response: "must-not-cross-edge",
  }],
  operation_hash: operationHash,
  memory_revision: 41,
  title_revision: 7,
  session_incarnation: "launch-s1",
  readiness: "degraded",
  title: "Old title",
  admission_fence: { session_incarnation: "launch-s1", title_revision: 7, memory_revision: 41 },
  result_fence: { session_incarnation: "launch-s1", title_revision: 7, memory_revision: 41 },
  current_fence: { session_incarnation: "launch-s1", title_revision: 7, memory_revision: 41 },
  result_is_current: true,
  started_at: "2026-09-10T00:00:00Z",
  finished_at: "2026-09-10T00:00:01Z",
  duration_bucket: "1_4_s",
  semantic_memory: "must-not-cross-edge",
};


const v3Receipts = {
  schema_version: SESSION_RETITLE_V3_RECEIPTS_SCHEMA_VERSION,
  capability: SESSION_RETITLE_V3_CAPABILITY,
  readiness: "degraded",
  current_fence: { session_incarnation: "launch-s1", title_revision: 7, memory_revision: 41 },
  max_receipts: 8,
  selected_operation_hash: operationHash,
  receipts: [{
    operation_hash: operationHash,
    trigger: "manual",
    state: "degraded_cached",
    terminal: true,
    outcome: "degraded_cached",
    changed: false,
    failure_class: "timeout",
    failure_stage: "provider_call",
    provider_attempts: [{
      provider_kind: "codex_subscription",
      model_label: "gpt-5.6",
      outcome: "timeout",
      failure_class: "timeout",
      failure_stage: "provider_call",
      started_at: "2026-09-10T00:00:00Z",
      finished_at: "2026-09-10T00:00:01Z",
      duration_bucket: "1_4_s",
      response: "must-not-cross-edge",
    }],
    admission_fence: { session_incarnation: "launch-s1", title_revision: 7, memory_revision: 41 },
    result_fence: { session_incarnation: "launch-s1", title_revision: 7, memory_revision: 41 },
    result_is_current: true,
    attempt_generation: 1,
    execution_claim_held: false,
    started_at: "2026-09-10T00:00:00Z",
    updated_at: "2026-09-10T00:00:01Z",
    duration_bucket: "1_4_s",
    title: "must-not-cross-edge",
  }],
  semantic_memory: "must-not-cross-edge",
};

before(async () => {
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>retitle</title>");
  daemon = createHttpServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/sessions") {
      res.end(JSON.stringify({
        ok: true,
        data: {
          capabilities: { session_retitle_v2: true, session_retitle_v3: true },
          sessions: [{
            id: "s1",
            agent: "codex",
            status: "running",
            title: "Old title",
            title_revision: 7,
            session_incarnation: "launch-s1",
            title_state_supported: true,
          }],
        },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/retitle/readiness") {
      res.end(JSON.stringify({ ok: true, data: { machine: "maple", retitle: readiness } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/s1/retitle-v3/readiness") {
      res.end(JSON.stringify({ ok: true, data: { machine: "maple", retitle: v3Readiness } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s1/retitle-v3") {
      daemonV3Bodies.push(await readJson(req));
      res.statusCode = 202;
      res.end(JSON.stringify({
        ok: true,
        data: { machine: "maple", retitle: { ...v3Terminal, status: "accepted", outcome: undefined, changed: undefined, finished_at: undefined } },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/s1/retitle-v3/operations") {
      res.end(JSON.stringify({ ok: true, data: { machine: "maple", retitle: v3Receipts } }));
      return;
    }
    if (req.method === "GET" && req.url === `/sessions/s1/retitle-v3/operations/${encodeURIComponent(operationHash)}`) {
      res.end(JSON.stringify({ ok: true, data: { machine: "maple", retitle: v3Terminal } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/s1/retitle") {
      daemonBodies.push(await readJson(req));
      if (nextRetitleErrorCode) {
        res.statusCode = 409;
        res.end(JSON.stringify({
          ok: false,
          error: {
            code: nextRetitleErrorCode,
            message: "producer wording must not cross the edge",
            details: {
              retryable: true,
              next_action: "retry",
              recovery: { strategy: "retry_provider", safe_to_retry: true, prompt: "drop" },
              transcript: "drop",
            },
          },
        }));
        return;
      }
      res.end(JSON.stringify({ ok: true, data: { machine: "maple", retitle } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: { message: "not found" } }));
  });
  legacyDaemon = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [] } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  const daemonAddress = await listenOnLoopback(daemon);
  const legacyAddress = await listenOnLoopback(legacyDaemon);
  edge = createEdgeServer(makeEdgeConfig({
    openAccess: true,
    uiDir,
    machines: [
      { name: "maple", url: daemonAddress.base, token: "daemon-secret" },
      { name: "old", url: legacyAddress.base, token: "old-secret" },
    ],
  }));
  base = (await listenOnLoopback(edge)).base;
});

after(async () => {
  await closeServers(edge, daemon, legacyDaemon);
  rmSync(uiDir, { recursive: true, force: true });
});

test("sessions advertise v2 and v3 support independently for each machine", async () => {
  const response = await fetch(`${base}/api/sessions`);
  const body = await response.json();
  assert.equal(body.data.capabilities.session_retitle_v2, true);
  assert.equal(body.data.capabilities.session_retitle_v3, true);
  assert.equal(body.data.machines.find((machine: { name: string }) => machine.name === "maple").capabilities.session_retitle_v2, true);
  assert.equal(body.data.machines.find((machine: { name: string }) => machine.name === "maple").capabilities.session_retitle_v3, true);
  assert.equal(body.data.machines.find((machine: { name: string }) => machine.name === "old").capabilities?.session_retitle_v2, undefined);
});

test("v3 proxy keeps requests content-free and reconciles a bounded operation", async () => {
  const readinessResponse = await fetch(`${base}/api/sessions/maple/s1/retitle-v3/readiness`);
  assert.equal(readinessResponse.status, 200);
  const readinessBody = await readinessResponse.json();
  assert.equal(readinessBody.data.retitle.memory_revision, 41);
  assert.equal(JSON.stringify(readinessBody).includes("transcript"), false);

  const request = {
    schema_version: SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION,
    trigger: "manual",
    idempotency_key: "console-manual-v3-1234",
    expected: { session_incarnation: "launch-s1", title_revision: 7, memory_revision: 41 },
  };
  const rejected = await fetch(`${base}/api/sessions/maple/s1/retitle-v3`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ ...request, transcript: "must not cross" }),
  });
  assert.equal(rejected.status, 422);
  assert.equal(daemonV3Bodies.length, 0);

  const accepted = await fetch(`${base}/api/sessions/maple/s1/retitle-v3`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(daemonV3Bodies, [request]);
  assert.equal((await accepted.json()).data.retitle.status, "accepted");

  const terminal = await fetch(`${base}/api/sessions/maple/s1/retitle-v3/operations/${operationHash}`);
  assert.equal(terminal.status, 200);
  const terminalBody = await terminal.json();
  assert.equal(terminalBody.data.retitle.outcome, "degraded_cached");
  assert.equal(JSON.stringify(terminalBody).includes("response"), false);
  assert.equal(JSON.stringify(terminalBody).includes("semantic_memory"), false);
});

test("readiness proxy retains actionable metadata and strips daemon internals", async () => {
  assert.equal(SESSION_RETITLE_READINESS_TIMEOUT_MS, 15_000);
  const response = await fetch(`${base}/api/machines/maple/retitle/readiness`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data, {
    machine: "maple",
    retitle: {
      schema_version: SESSION_RETITLE_READINESS_SCHEMA_VERSION,
      capability: SESSION_RETITLE_CAPABILITY,
      status: "ready",
      reason_code: "ready",
      next_action: "none",
      provider_kind: "codex_subscription",
      model_label: "gpt-5-codex",
      account: "work",
      plan: "pro",
      context_capabilities: {
        codex: "provider_transcript",
        claude: "provider_transcript",
      },
    },
  });
  assert.equal(JSON.stringify(body).includes("access_token"), false);
});

test("manual retitle proxy forwards only the strict content-free request", async () => {
  const request = {
    schema_version: SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
    trigger: "manual",
    idempotency_key: "console-manual-1234",
    expected_session_incarnation: "launch-s1",
    expected_title_revision: 7,
  };
  const rejected = await fetch(`${base}/api/sessions/maple/s1/retitle`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ ...request, prompt: "must not cross the edge" }),
  });
  assert.equal(rejected.status, 422);
  assert.equal(daemonBodies.length, 0);

  const response = await fetch(`${base}/api/sessions/maple/s1/retitle`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(daemonBodies, [request]);
  const body = await response.json();
  const { model_output: _modelOutput, processed_turn_id_hash: _turnHash, ...publicRetitle } = retitle;
  assert.deepEqual(body.data, { machine: "maple", retitle: publicRetitle });
  assert.equal(JSON.stringify(body).includes("model_output"), false);
});

test("retitle proxy preserves every stable producer error with bounded recovery", async () => {
  assert.equal(SESSION_RETITLE_PROVIDER_MAX_TIMEOUT_MS, 120_000);
  assert.ok(SESSION_RETITLE_TIMEOUT_MS > SESSION_RETITLE_PROVIDER_MAX_TIMEOUT_MS);
  for (const code of PRODUCER_ERROR_CODES) {
    nextRetitleErrorCode = code;
    const response = await fetch(`${base}/api/sessions/maple/s1/retitle`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
        trigger: "manual",
        idempotency_key: `error-${code}`,
        expected_session_incarnation: "launch-s1",
        expected_title_revision: 7,
      }),
    });
    assert.equal(response.status, 409, code);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.deepEqual(body.error.details, {
      retryable: true,
      next_action: "retry",
      recovery: { strategy: "retry_provider", safe_to_retry: true },
    });
    assert.equal(JSON.stringify(body).includes("producer wording"), false);
    assert.equal(JSON.stringify(body).includes("transcript"), false);
  }
  nextRetitleErrorCode = null;
});

test("daemon retitle outcomes reach the edge lifecycle log and debug ring", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await fetch(`${base}/api/sessions/maple/s1/retitle-v3/operations/${operationHash}`);
    await fetch(`${base}/api/sessions/maple/s1/retitle`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
        trigger: "manual",
        idempotency_key: "console-manual-lifecycle",
        expected_session_incarnation: "launch-s1",
        expected_title_revision: 7,
      }),
    });
  } finally {
    console.log = original;
  }

  const lifecycle = lines
    .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
    .filter((event): event is Record<string, unknown> => event?.event === "agent-console.title-lifecycle.v1");
  const v3 = lifecycle.find((event) => event.path === "daemon_v3");
  assert.equal(v3?.outcome, "degraded_cached");
  assert.equal(v3?.failure_class, "timeout");
  assert.equal(v3?.failure_stage, "provider_call");
  assert.equal(v3?.provider_kind, "codex_subscription");
  assert.equal(v3?.duration_bucket, "1_4_s");
  assert.equal(v3?.machine, "maple");
  assert.equal(v3?.session_id, "s1");
  const v2 = lifecycle.find((event) => event.path === "daemon_v2");
  assert.equal(v2?.outcome, "committed");
  assert.equal(v2?.provider_kind, "codex_subscription");
  assert.equal(v2?.trigger, "manual");
  // The log explains an outcome; it never carries the title or session content.
  assert.equal(JSON.stringify(lifecycle).includes("Old title"), false);
  assert.equal(JSON.stringify(lifecycle).includes("Durable retitle context"), false);

  const events = await (await fetch(`${base}/api/debug/events`)).json();
  const ring = (events.data.events as Array<Record<string, unknown>>)
    .filter((event) => event.route === "/title-lifecycle");
  assert.ok(ring.some((event) => event.outcome === "daemon_v3_degraded_cached:timeout"));
  assert.ok(ring.some((event) => event.outcome === "daemon_v2_committed"));
});

test("an accepted v3 operation is not an outcome and is never recorded", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const accepted = await fetch(`${base}/api/sessions/maple/s1/retitle-v3`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: SESSION_RETITLE_V3_REQUEST_SCHEMA_VERSION,
        trigger: "manual",
        idempotency_key: "console-manual-v3-accepted",
        expected: { session_incarnation: "launch-s1", title_revision: 7, memory_revision: 41 },
      }),
    });
    assert.equal((await accepted.json()).data.retitle.status, "accepted");
  } finally {
    console.log = original;
  }

  assert.equal(lines.some((line) => line.includes("title-lifecycle")), false);
  const events = await (await fetch(`${base}/api/debug/events`)).json();
  const ring = (events.data.events as Array<Record<string, unknown>>)
    .filter((event) => event.route === "/title-lifecycle");
  assert.equal(ring.some((event) => String(event.outcome).startsWith("daemon_v3_accepted")), false);
});

test("a rejected v2 mutation is recorded under its own producer error code", async () => {
  const lines: string[] = [];
  const original = console.log;
  nextRetitleErrorCode = "retitle-provider-timeout";
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const rejected = await fetch(`${base}/api/sessions/maple/s1/retitle`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: SESSION_RETITLE_REQUEST_SCHEMA_VERSION,
        trigger: "manual",
        idempotency_key: "console-manual-lifecycle-error",
        expected_session_incarnation: "launch-s1",
        expected_title_revision: 7,
      }),
    });
    assert.equal(rejected.status, 409);
  } finally {
    console.log = original;
    nextRetitleErrorCode = null;
  }

  const lifecycle = lines
    .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
    .filter((event): event is Record<string, unknown> => event?.event === "agent-console.title-lifecycle.v1");
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]?.path, "daemon_v2");
  assert.equal(lifecycle[0]?.outcome, "retitle-provider-timeout");
  assert.equal(lifecycle[0]?.trigger, "manual");
  assert.equal(JSON.stringify(lifecycle).includes("producer wording"), false);

  const events = await (await fetch(`${base}/api/debug/events`)).json();
  const ring = (events.data.events as Array<Record<string, unknown>>)
    .filter((event) => event.route === "/title-lifecycle");
  assert.ok(ring.some((event) => event.outcome === "daemon_v2_retitle-provider-timeout"));
});

test("retitle receipts are projected content-free and a legacy host reports unsupported", async () => {
  const response = await fetch(`${base}/api/sessions/maple/s1/retitle-v3/operations`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.supported, true);
  assert.equal(body.data.retitle.schema_version, SESSION_RETITLE_V3_RECEIPTS_SCHEMA_VERSION);
  assert.equal(body.data.retitle.max_receipts, 8);
  assert.equal(body.data.retitle.selected_operation_hash, operationHash);
  const receipt = body.data.retitle.receipts[0];
  assert.equal(receipt.operation_hash, operationHash);
  assert.equal(receipt.trigger, "manual");
  assert.equal(receipt.outcome, "degraded_cached");
  assert.equal(receipt.failure_class, "timeout");
  assert.equal(receipt.failure_stage, "provider_call");
  assert.equal(receipt.result_is_current, true);
  assert.equal(receipt.execution_claim_held, false);
  assert.equal(receipt.provider_attempts[0].provider_kind, "codex_subscription");
  // Anything the daemon added beyond the contract is dropped at the edge, so a
  // future daemon field can never reach the multi-principal debug surface
  // before this console has agreed to it.
  assert.equal(JSON.stringify(body).includes("must-not-cross-edge"), false);
  assert.equal(receipt.title, undefined);

  const legacy = await fetch(`${base}/api/sessions/old/s1/retitle-v3/operations`);
  assert.equal(legacy.status, 200);
  const legacyBody = await legacy.json();
  assert.equal(legacyBody.ok, true);
  assert.equal(legacyBody.data.supported, false);
  assert.equal(legacyBody.data.retitle, null);
});
