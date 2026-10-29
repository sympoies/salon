import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { test } from "node:test";
import { createEdgeServer } from "../src/server.ts";
import { closeServers, listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

const daemonRefresh = (session: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    machine: "fixture",
    refresh: {
      session_id: "s1",
      changed: ["model", "title"],
      unavailable: ["account"],
      session: {
        id: "s1", agent: "codex", model: "model-b", reasoning_effort: "high", title: "Renamed",
        context_usage: { used_tokens: 1200, window_tokens: 100000, source: "codex-rollout", observed_at: "2026-10-07T00:00:00Z", model: "model-b" },
        runtime: { launch_command: "private-fixture" },
        ...session,
      },
    },
  },
});

async function fixture(reply: (req: { method?: string; url?: string; auth?: string; body: string }) => { status: number; body?: unknown }) {
  const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const daemon = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const request = { method: req.method, url: req.url, auth: req.headers.authorization, body };
    seen.push(request);
    const { status, body: payload } = reply(request);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(payload === undefined ? "" : JSON.stringify(payload));
  });
  const daemonAddress = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({
    clientToken: "fixture-client", openAccess: false,
    machines: [{ name: "fixture", url: daemonAddress.base, token: "fixture-daemon" }],
  }));
  const { base } = await listenOnLoopback(edge);
  const cookie = await loginCookie(base, "fixture-client");
  const refresh = (headers: Record<string, string> = { cookie, origin: base }) =>
    fetch(`${base}/api/sessions/fixture/s1/refresh`, { method: "POST", headers });
  return { seen, refresh, cookie, base, daemon, close: () => closeServers(edge, daemon) };
}

test("session refresh requires client auth and same-origin CSRF, then posts a bodiless request with daemon credentials", async () => {
  const f = await fixture(() => ({ status: 200, body: daemonRefresh() }));
  try {
    assert.equal((await f.refresh({ origin: f.base })).status, 401);
    assert.equal((await f.refresh({ cookie: f.cookie, origin: "https://other.invalid" })).status, 403);
    assert.equal(f.seen.length, 0, "refused requests never reach the daemon");

    const response = await f.refresh();
    assert.equal(response.status, 200);
    assert.deepEqual(f.seen, [{ method: "POST", url: "/sessions/s1/refresh", auth: "Bearer fixture-daemon", body: "" }]);
    const { data } = await response.json();
    assert.equal(data.machine, "fixture");
    assert.deepEqual(data.refresh.changed, ["model", "title"]);
    assert.deepEqual(data.refresh.unavailable, ["account"]);
    assert.equal(data.refresh.session.model, "model-b");
    assert.equal(data.refresh.session.context_usage.used_tokens, 1200);
    assert.equal(Object.hasOwn(data.refresh.session, "runtime"), false, "only the public session projection is returned");
  } finally {
    await f.close();
  }
});

test("session refresh reports a daemon without the route as a typed unsupported error and never falls back", async () => {
  for (const status of [404, 405, 501]) {
    const f = await fixture(() => ({ status }));
    try {
      const response = await f.refresh();
      assert.equal(response.status, 501, `daemon ${status}`);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: { code: "session-refresh-unsupported", message: "This host cannot refresh session info yet." },
      });
      assert.deepEqual(f.seen.map(request => request.url), ["/sessions/s1/refresh"], "no other endpoint is tried");
    } finally {
      await f.close();
    }
  }
});

test("session refresh keeps daemon error codes distinct from an unsupported route", async () => {
  const cases: [number, string, string][] = [
    [404, "session-not-found", "session-not-found"],
    [422, "refresh-unsupported-agent", "refresh-unsupported-agent"],
    [500, "some-new-daemon-code", "some-new-daemon-code"],
  ];
  for (const [status, code, expected] of cases) {
    const f = await fixture(() => ({ status, body: { ok: false, error: { code, message: "private daemon text", details: { path: "/private" } } } }));
    try {
      const response = await f.refresh();
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, expected);
      assert.equal(JSON.stringify(body).includes("private"), false, "daemon text and details stay private");
    } finally {
      await f.close();
    }
  }
});

test("session refresh rejects a success that names another machine, another session or a bad session", async () => {
  const wrongMachine = daemonRefresh();
  wrongMachine.data.machine = "other";
  const wrongRefreshId = daemonRefresh();
  wrongRefreshId.data.refresh.session_id = "s2";
  for (const body of [wrongMachine, wrongRefreshId, daemonRefresh({ id: "s2" }), daemonRefresh({ agent: undefined }), { ok: true, data: {} }]) {
    const f = await fixture(() => ({ status: 200, body }));
    try {
      const response = await f.refresh();
      assert.equal(response.status, 502, JSON.stringify(body));
      assert.equal((await response.json()).error.code, "invalid-session-refresh-response");
    } finally {
      await f.close();
    }
  }
});

test("session refresh answers an unreachable daemon with a retryable gateway error", async () => {
  const f = await fixture(() => ({ status: 200, body: daemonRefresh() }));
  try {
    await new Promise<void>(resolve => { f.daemon.closeAllConnections(); f.daemon.close(() => resolve()); });
    const response = await f.refresh();
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "session-refresh-unavailable");
  } finally {
    await f.close();
  }
});
