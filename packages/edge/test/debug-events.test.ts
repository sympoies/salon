import { strict as assert } from "node:assert";
import { after } from "node:test";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createEdgeServer } from "../src/server.ts";
import { DebugEventBuffer, redactDebugPath } from "../src/debugEvents.ts";
import { cookieFrom, listenOnLoopback, makeEdgeConfig } from "./support.ts";

const uiDir = mkdtempSync(join(tmpdir(), "ac-debug-ui-"));
writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>ac</title>");

after(() => {
  rmSync(uiDir, { recursive: true, force: true });
});

test("only the layout revision conflict is recorded as neutral", () => {
  const buffer = new DebugEventBuffer();
  const envelope = { ok: false, error: { message: "layout revision conflict" } };
  const record = (route: string, status: number, errorEnvelope: unknown) => buffer.record({
    source: "edge", method: "PUT", route, status, ok: false, errorEnvelope,
  });
  assert.equal(record("/api/layout", 409, envelope).ok, true);
  assert.equal(record("/api/other", 409, envelope).ok, false);
  assert.equal(record("/api/layout", 500, envelope).ok, false);
  assert.equal(record("/api/layout", 409, { ok: false, error: { message: "other conflict" } }).ok, false);
});

test("redactDebugPath keeps route shape without sensitive path or query values", () => {
  assert.equal(
    redactDebugPath("/api/sessions/summit/hs-codex-1/attachments?filename=secret.png&token=abc"),
    "/api/sessions/:machine/:id/attachments",
  );
  assert.equal(redactDebugPath("/api/machines/mesa/workdirs?q=/private&limit=20"), "/api/machines/:machine/workdirs");
  assert.equal(redactDebugPath("/sessions/hs-codex-1/send"), "/sessions/:id/send");
});

test("debug endpoint returns redacted edge and daemon events correlated by request id", async () => {
  const daemon = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: { sessions: [] } }));
  });
  const { base: daemonBase } = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({
    clientToken: "client-secret",
    machines: [{ name: "build host@example", url: daemonBase, token: "machine-secret" }],
    uiDir,
    openAccess: false,
  }));
  const { base: edgeBase } = await listenOnLoopback(edge);

  try {
    const login = await fetch(`${edgeBase}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "client-secret" }),
    });
    const cookie = cookieFrom(login);
    const requestId = "acreq_test_debug";
    const sessions = await fetch(`${edgeBase}/api/sessions`, {
      headers: { cookie, "x-agent-console-request-id": requestId },
    });
    assert.equal(sessions.status, 200);

    const privatePrompt = "investigate private init title input";
    const publicSessionId = `session @${"x".repeat(130)} ${["TOKEN", "private-value"].join("=")}`;
    const titleSummary = await fetch(`${edgeBase}/api/title-summary`, {
      method: "POST",
      headers: { cookie, origin: edgeBase, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: privatePrompt,
        trace: {
          attemptId: "title_opaque123",
          machine: "build host@example",
          sessionId: publicSessionId,
          phase: "initial",
          attempt: 1,
        },
      }),
    });
    assert.equal(titleSummary.status, 200);
    assert.equal((await titleSummary.json()).data.diagnosticReason, "fallback_not_configured");
    const untrustedTrace = await fetch(`${edgeBase}/api/title-summary`, {
      method: "POST",
      headers: { cookie, origin: edgeBase, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: privatePrompt,
        trace: {
          attemptId: "title_unknown123",
          machine: "unknown-machine",
          sessionId: "fabricated-session",
          phase: "initial",
          attempt: 1,
        },
      }),
    });
    assert.equal(untrustedTrace.status, 200);

    const debugRes = await fetch(`${edgeBase}/api/debug/events`, { headers: { cookie } });
    assert.equal(debugRes.status, 200);
    const body = await debugRes.json();
    const events = body.data.events as Array<Record<string, unknown>>;
    assert.ok(events.some((event) => event.source === "edge" && event.route === "/api/sessions"));
    assert.ok(events.some((event) => event.source === "daemon" && event.route === "/sessions"));
    assert.ok(events.some((event) => event.request_id === requestId));
    assert.ok(events.some((event) => (
      event.route === "/title-lifecycle"
      && event.operation === "title"
      && event.phase === "initial"
      && event.outcome === "fallback_not_configured"
      && event.provenance === "client_supplied"
      && event.ok === null
      && event.attempt_id === "title_opaque123"
      && event.attempt === 1
    )));
    assert.equal(events.some((event) => event.attempt_id === "title_unknown123"), false);
    assert.ok(events.some((event) => /^trace_[a-f0-9]{16}$/.test(String(event.session_id))));
    assert.equal(JSON.stringify(body).includes(publicSessionId), false);
    assert.equal(JSON.stringify(body).includes("client-secret"), false);
    assert.equal(JSON.stringify(body).includes("machine-secret"), false);
    assert.equal(JSON.stringify(body).includes(privatePrompt), false);
    assert.equal(events.some((event) => event.route === "/api/debug/events"), false);
  } finally {
    edge.close();
    daemon.close();
  }
});

test("a failed response keeps its projected envelope and survives routine polling", async () => {
  const daemon = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [] } }));
      return;
    }
    res.end(JSON.stringify({ ok: true, data: {} }));
  });
  const { base: daemonBase } = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({
    clientToken: "client-secret",
    machines: [{ name: "maple", url: daemonBase, token: "machine-secret" }],
    uiDir,
    openAccess: false,
  }));
  const { base: edgeBase } = await listenOnLoopback(edge);

  try {
    const login = await fetch(`${edgeBase}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "client-secret" }),
    });
    const cookie = cookieFrom(login);

    // A 200 carrying `ok:false`: the shape that made the retitle investigation
    // hard, because the transport looked healthy.
    const rejected = await fetch(`${edgeBase}/api/sessions/maple/s1/retitle-v3`, {
      method: "POST",
      headers: { cookie, origin: edgeBase, "content-type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });
    assert.equal(rejected.status, 422);

    for (let i = 0; i < 1100; i += 1) {
      await fetch(`${edgeBase}/api/machines`, { headers: { cookie } });
    }

    const debugRes = await fetch(`${edgeBase}/api/debug/events`, { headers: { cookie } });
    const body = await debugRes.json();
    const events = body.data.events as Array<Record<string, unknown>>;
    assert.equal(typeof body.data.max_signal_events, "number");
    const failure = events.find((event) => event.route === "/api/sessions/:machine/:id/retitle-v3");
    assert.ok(failure, "the failed mutation was evicted by routine polling");
    assert.equal(failure?.ok, false);
    assert.equal(failure?.code, "invalid-retitle-request");
    assert.equal(
      events.filter((event) => event.route === "/api/machines").length,
      body.data.max_events,
    );
    assert.deepEqual(events.map((event) => event.seq), [...events].sort((a, b) => Number(a.seq) - Number(b.seq)).map((event) => event.seq));
    assert.equal(JSON.stringify(body).includes("Session retitle request is invalid"), false);
  } finally {
    edge.close();
    daemon.close();
  }
});
