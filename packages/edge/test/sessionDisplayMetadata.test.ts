import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import { createEdgeServer } from "../src/server.ts";
import { closeServers, listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

test("display metadata uses client auth/CSRF and forwards only title-mode fences with daemon credentials", async () => {
  const seen: {path: string; auth: string | undefined; body: unknown}[] = [];
  const daemon = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    seen.push({path: req.url!, auth: req.headers.authorization, body: JSON.parse(body)});
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ok: true, data: {session: {id: "s1", agent: "codex", title_mode: "pinned", display_revision: 1, runtime: {launch_command: "private-fixture"}, extra: {future_field: "private-fixture"}}}}));
  });
  const daemonAddress = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({
    clientToken: "fixture-client", openAccess: false,
    machines: [{name: "fixture", url: daemonAddress.base, token: "fixture-daemon"}],
  }));
  const {base} = await listenOnLoopback(edge);
  try {
    const path = `${base}/api/sessions/fixture/s1/display-metadata`;
    const body = {title_mode: "pinned", expected_revision: 0, expected_session_created_at: "2026-10-07T00:00:00Z"};
    assert.equal((await fetch(path, {method: "POST", headers: {origin: base, "content-type": "application/json"}, body: JSON.stringify(body)})).status, 401);
    const cookie = await loginCookie(base, "fixture-client");
    assert.equal((await fetch(path, {method: "POST", headers: {cookie, origin: "https://other.invalid", "content-type": "application/json"}, body: JSON.stringify(body)})).status, 403);
    assert.equal((await fetch(path, {method: "POST", headers: {cookie, origin: base, "content-type": "application/json"}, body: JSON.stringify({...body, title_mode: "other"})})).status, 422);
    assert.equal(seen.length, 0);
    const response = await fetch(path, {method: "POST", headers: {cookie, origin: base, "content-type": "application/json"}, body: JSON.stringify({...body, role: "coordinator"})});
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [{path: "/sessions/s1/display-metadata", auth: "Bearer fixture-daemon", body}]);
    const result = await response.json();
    assert.equal(result.data.session.title_mode, "pinned");
    assert.equal(Object.hasOwn(result.data.session, "runtime"), false);
    assert.equal(Object.hasOwn(result.data.session, "extra"), false);
  } finally {
    await closeServers(edge, daemon);
  }
});

test("display metadata preserves daemon revision conflicts and rejects invalid success responses", async () => {
  let daemonStatus = 200;
  let daemonBody: unknown = {ok: true, data: {session: {id: "s1", agent: "codex", title_mode: "pinned", display_revision: 1}}};
  const daemon = createServer(async (_req, res) => {
    res.statusCode = daemonStatus;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(daemonBody));
  });
  const daemonAddress = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({
    clientToken: "fixture-client", openAccess: false,
    machines: [{name: "fixture", url: daemonAddress.base, token: "fixture-daemon"}],
  }));
  const {base} = await listenOnLoopback(edge);
  try {
    const path = `${base}/api/sessions/fixture/s1/display-metadata`;
    const cookie = await loginCookie(base, "fixture-client");
    const request = () => fetch(path, {
      method: "POST",
      headers: {cookie, origin: base, "content-type": "application/json"},
      body: JSON.stringify({title_mode: "pinned", expected_revision: 0, expected_session_created_at: "2026-10-07T00:00:00Z"}),
    });

    daemonStatus = 409;
    daemonBody = {ok: false, error: {code: "display-revision-conflict"}};
    const conflict = await request();
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      ok: false,
      error: {code: "display-revision-conflict", message: "Session display metadata changed; refresh and retry."},
    });

    daemonStatus = 200;
    daemonBody = {ok: false, error: {code: "display-revision-conflict"}};
    const falseSuccess = await request();
    assert.equal(falseSuccess.status, 502);
    assert.deepEqual(await falseSuccess.json(), {
      ok: false,
      error: {code: "display-revision-conflict", message: "Session display metadata changed; refresh and retry."},
    });

    daemonBody = {ok: true, data: {session: {id: "different-session", agent: "codex", title_mode: "pinned", display_revision: 1}}};
    const mismatchedSession = await request();
    assert.equal(mismatchedSession.status, 502);
    assert.deepEqual(await mismatchedSession.json(), {
      ok: false,
      error: {message: "Invalid title mode daemon response."},
    });
  } finally {
    await closeServers(edge, daemon);
  }
});
