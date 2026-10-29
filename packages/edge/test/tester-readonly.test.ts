import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { loadConfig, parsePrincipals } from "../src/config.ts";
import { MachinePreferencesStore } from "../src/machinePreferences.ts";
import type { EdgeExtension } from "../src/extensions.ts";
import { createEdgeServer } from "../src/server.ts";
import { TestCredentialStore } from "../src/testCredentials.ts";
import { listenOnLoopback, loginCookie } from "./support.ts";

test("managed testers cannot be configured with optional operator or terminal powers", () => {
  for (const permission of ["terminal", "usage", "debug", "extension_control", "provider_import"]) {
    assert.throws(() => parsePrincipals(JSON.stringify([
      { id: "tester-fixture", managedCredential: true, machines: [], permissions: [permission] },
    ]), []), /read-only/);
  }
});

test("managed testers can view granted sessions but cannot invoke daemon, terminal, settings or account actions", { timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "console-readonly-"));
  const path = join(dir, "access.sqlite");
  const owner = new TestCredentialStore(path);
  const preferences = new MachinePreferencesStore(path);
  let token = "";
  owner.issue("tester-fixture", value => { token = value; });
  const upstreamRequests: string[] = [];
  const daemon = createServer((req, res) => {
    upstreamRequests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, "Bearer daemon-fixture", "serve receives only its daemon credential");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: { sessions: [
      { id: "granted", session_incarnation: "granted-inc", agent: "codex", status: "running" },
      { id: "private", session_incarnation: "private-inc", agent: "codex", status: "running" },
    ] } }));
  });
  daemon.on("upgrade", (_req, socket) => {
    upstreamRequests.push("upgrade");
    socket.on("error", () => {});
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.end();
  });
  const upstream = await listenOnLoopback(daemon);
  const config = loadConfig({
    AGENT_CONSOLE_STATE_DB: path, AGENT_CONSOLE_INSECURE_COOKIE: "1",
    AGENT_CONSOLE_MACHINES: JSON.stringify([{ name: "fixture", url: upstream.base, token: "daemon-fixture" }]),
    AGENT_CONSOLE_PRINCIPALS: JSON.stringify([
      { id: "tester-fixture", managedCredential: true, machines: ["fixture"], permissions: [] },
      { id: "owner", token: "owner-fixture", machines: ["fixture"], permissions: [] },
    ]),
  });
  const access = new AccessStore(path);
  access.claimSession({ principalId: "tester-fixture", machine: "fixture", sessionId: "granted", incarnation: "granted-inc" });
  access.claimSession({ principalId: "owner", machine: "fixture", sessionId: "private", incarnation: "private-inc" });
  access.claimHistory("tester-fixture", "fixture", "granted-history", "codex", "granted-provider");
  access.close();
  const edge = createEdgeServer(config, { extensions: [{ id: "account-control", permissions: ["extension_control"], routes: [{
    id: "default", pattern: "/api/ext/account-control/:provider/default", methods: ["GET", "PUT"], permission: "extension_control",
    handle(ctx) { ctx.sendJson(200, { ok: true }); },
  }] }] });
  const { base, port } = await listenOnLoopback(edge);
  const actions: Array<[string, string]> = [
    ["POST", "/api/sessions/fixture"],
    ["POST", "/api/sessions/fixture/granted/resume"],
    ["POST", "/api/sessions/fixture/granted/archive"],
    ["DELETE", "/api/sessions/fixture/granted"],
    ["PATCH", "/api/sessions/fixture/granted"],
    ["POST", "/api/sessions/fixture/granted/send"],
    ["POST", "/api/sessions/fixture/granted/prompt"],
    ["POST", "/api/sessions/fixture/granted/prompt/v2"],
    ["POST", "/api/sessions/fixture/granted/attach-ticket"],
    ["GET", "/api/shells/fixture"],
    ["POST", "/api/shells/fixture"],
    ["DELETE", "/api/shells/fixture"],
    ["POST", "/api/shells/fixture/shell-inc/attach-ticket"],
    ["POST", "/api/sessions/fixture/granted/maintenance/actions"],
    ["PUT", "/api/sessions/fixture/granted/auto-resume"],
    ["DELETE", "/api/sessions/fixture/granted/auto-resume"],
    ["PUT", "/api/sessions/fixture/granted/account"],
    ["POST", "/api/sessions/fixture/granted/attachments"],
    ["POST", "/api/sessions/fixture/granted/display-metadata"],
    ["POST", "/api/sessions/fixture/granted/retitle"],
    ["POST", "/api/sessions/fixture/granted/refresh"],
    ["POST", "/api/sessions/fixture/granted/retitle-v3"],
    ["POST", "/api/history/sessions/fixture/granted/star"],
    ["POST", "/api/history/sessions/fixture/granted/resume"],
    ["GET", "/api/layout"], ["PUT", "/api/layout"],
    ["GET", "/api/machine-preferences"],
    ["PUT", "/api/machine-preferences/fixture"],
    ["GET", "/api/machines/fixture/codex/accounts"],
    ["GET", "/api/machines/fixture/claude/accounts"],
    ["GET", "/api/ext/account-control/codex/default"], ["PUT", "/api/ext/account-control/codex/default"],
    ["PUT", "/api/ext/account-control/claude/default"],
    ["POST", "/api/codex/rate-limit-reset"], ["POST", "/api/claude/limit-reset"],
    ["POST", "/api/title-summary"], ["POST", "/api/speech/fixture/transcriptions"],
    ["GET", "/api/usage"], ["GET", "/api/debug/events"],
    ["GET", "/api/machines/fixture/workdirs"],
    ["GET", "/api/machines/fixture/repo-url"],
    ["GET", "/api/machines/fixture/runtime/health"],
    ["GET", "/api/sessions/fixture/granted/maintenance?operation=resume"],
    ["GET", "/api/sessions/fixture/granted/auto-resume"],
    ["GET", "/api/resources/events?resources=layout"],
  ];
  try {
    const cookie = await loginCookie(base, token);
    for (const headers of [{ authorization: `Bearer ${token}` }, { cookie }]) {
      const response = await fetch(`${base}/api/sessions`, { headers });
      assert.equal(response.status, 200);
      const sessions = (await response.json()).data.sessions;
      assert.deepEqual(sessions.map((session: { id: string }) => session.id), ["granted"]);
      assert.equal((await fetch(`${base}/api/sessions/fixture/granted/buffer`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/api/sessions/fixture/private/buffer`, { headers })).status, 404);
      const image = `${"a".repeat(16)}.0.0.${"b".repeat(32)}`;
      const beforeImage = upstreamRequests.length;
      assert.equal((await fetch(`${base}/api/history/sessions/fixture/private-history/images/${image}`, { headers })).status, 404);
      assert.equal(upstreamRequests.length,beforeImage,"ungranted history image reads never reach serve");
      assert.equal((await fetch(`${base}/api/history/sessions/fixture/granted-history/images/${image}`, { headers })).status, 422);
      assert.equal(upstreamRequests.at(-1),`GET /history/sessions/granted-history/images/${image}`,
        "read-only testers can inspect granted images with either auth transport");
      for (const [method, endpoint] of actions) await t.test(`${Object.hasOwn(headers, "cookie") ? "cookie" : "bearer"} denies ${method} ${endpoint}`, async () => {
        const before = upstreamRequests.length;
        const denied = await fetch(`${base}${endpoint}`, {
          method, headers: { ...headers, "content-type": "application/json" },
          ...(method === "GET" ? {} : { body: endpoint === "/api/machine-preferences/fixture"
            ? JSON.stringify({ enabled: false, reason: "fixture denial check" }) : "{}" }), signal: AbortSignal.timeout(2000),
        });
        if (denied.status === 403) await denied.arrayBuffer();
        else await denied.body?.cancel();
        assert.equal(denied.status, 403);
        assert.equal(upstreamRequests.length, before, "denied actions must not reach serve");
        assert.equal(preferences.read("tester-fixture").size, 0, "denied actions must not write local preferences");
        assert.equal(preferences.audit("tester-fixture").length, 0, "denied actions must not write preference audit rows");
      });
      // Daemon relay ingress is outside the browser route switch and must not
      // accept either tester auth transport as its separate relay credential.
      const beforeRelay = upstreamRequests.length;
      const relay = await fetch(`${base}/api/coordination/sessions/v1`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
      });
      assert.equal(relay.status, 401);
      assert.equal(upstreamRequests.length, beforeRelay);
      for (const endpoint of ["/api/sessions/fixture/granted/attach", "/api/shells/fixture/shell-inc/attach"]) {
        const before = upstreamRequests.length;
        const status = await new Promise<number>((resolve, reject) => {
          const req = request({ hostname: "127.0.0.1", port, path: endpoint,
            headers: { ...headers, connection: "Upgrade", upgrade: "websocket" } });
          req.once("response", res => { res.resume(); resolve(res.statusCode!); });
          req.once("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
          req.once("error", reject); req.end();
        });
        assert.equal(status, 403, `${endpoint} must refuse tester upgrades`);
        assert.equal(upstreamRequests.length, before);
      }
    }
    // Existing ordinary principals keep their base powers; the restriction is
    // the managed tester kind, not an interpretation of empty permissions.
    const before = upstreamRequests.length;
    await fetch(`${base}/api/shells/fixture`, {
      method: "POST", headers: { authorization: "Bearer owner-fixture", "content-type": "application/json" }, body: "{}",
    });
    assert.equal(upstreamRequests.length, before + 1);
    assert.equal(upstreamRequests.at(-1), "POST /shells/owner");
  } finally {
    await new Promise<void>(resolve => edge.close(() => resolve()));
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    owner.close(); preferences.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("managed testers are refused on edge extension routes by core, whatever their permissions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "console-tester-ext-"));
  const path = join(dir, "access.sqlite");
  const owner = new TestCredentialStore(path);
  let token = "";
  owner.issue("tester-fixture", value => { token = value; });
  let handled = 0;
  const probe: EdgeExtension = {
    id: "probe",
    permissions: ["probe_read"],
    routes: [{
      id: "read", pattern: "/api/ext/probe/items/:item", methods: ["GET"], permission: "probe_read",
      handle(ctx) { handled += 1; ctx.sendJson(200, { ok: true }); },
    }],
  };
  const loaded = loadConfig({
    AGENT_CONSOLE_STATE_DB: path, AGENT_CONSOLE_INSECURE_COOKIE: "1",
    AGENT_CONSOLE_PRINCIPALS: JSON.stringify([
      { id: "tester-fixture", managedCredential: true, machines: [], permissions: [] },
      { id: "owner", token: "owner-fixture", machines: [], permissions: ["probe_read"] },
    ]),
  }, { extraPermissions: ["probe_read"] });
  // Config validation keeps tester permissions empty; core must refuse testers
  // on extension routes even when a principal reaches it with a permission.
  const config = {
    ...loaded,
    principals: loaded.principals.map(principal => principal.managedCredential
      ? { ...principal, permissions: ["probe_read"] as unknown as typeof principal.permissions } : principal),
  };
  const edge = createEdgeServer(config, { extensions: [probe] });
  const { base } = await listenOnLoopback(edge);
  try {
    const owned = await fetch(`${base}/api/ext/probe/items/a`, { headers: { authorization: "Bearer owner-fixture" } });
    assert.equal(owned.status, 200);
    await owned.arrayBuffer();
    assert.equal(handled, 1);
    const cookie = await loginCookie(base, token);
    for (const headers of [{ authorization: `Bearer ${token}` }, { cookie }]) {
      const denied = await fetch(`${base}/api/ext/probe/items/a`, { headers });
      await denied.arrayBuffer();
      assert.equal(denied.status, 403);
    }
    assert.equal(handled, 1, "tester requests must not reach the extension handler");
  } finally {
    await new Promise<void>(resolve => edge.close(() => resolve()));
    owner.close(); rmSync(dir, { recursive: true, force: true });
  }
});
