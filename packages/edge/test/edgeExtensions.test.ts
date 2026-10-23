import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, type EdgeConfig, type PrincipalConfig } from "../src/config.ts";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeExtensionRegistry, type EdgeExtension, type EdgeRoute } from "../src/extensions.ts";
import { createEdgeServer } from "../src/server.ts";
import { closeServers, jsonReader, listenOnLoopback, makeEdgeConfig } from "./support.ts";

// A private-distribution-style extension: read and write routes guarded by
// permissions it declares itself, plus machine- and session-scoped routes.
const probe: EdgeExtension = {
  id: "probe",
  permissions: ["probe_read", "probe_write"],
  routes: [
    {
      id: "read",
      pattern: "/api/ext/probe/items/:item",
      methods: ["GET"],
      permission: "probe_read",
      handle(ctx) {
        ctx.sendJson(200, { ok: true, data: { item: ctx.params.item, principal: ctx.principal.id } });
      },
    },
    {
      id: "machine",
      pattern: "/api/ext/probe/machines/:machine/state",
      methods: ["GET"],
      permission: "probe_read",
      handle(ctx) {
        ctx.sendJson(200, { ok: true, data: { machine: ctx.params.machine } });
      },
    },
    {
      id: "session",
      pattern: "/api/ext/probe/sessions/:machine/:id/note",
      methods: ["GET"],
      permission: "probe_read",
      handle(ctx) {
        ctx.sendJson(200, { ok: true, data: { machine: ctx.params.machine, id: ctx.params.id } });
      },
    },
    {
      id: "write",
      pattern: "/api/ext/probe/items/:item",
      methods: ["PUT"],
      permission: "probe_write",
      async handle(ctx) {
        ctx.sendJson(200, { ok: true, data: { item: ctx.params.item, body: await ctx.readJsonBody() } });
      },
    },
  ],
};

test("the registry rejects malformed, duplicate, shadowing and undeclared extension surfaces", () => {
  const build = (extensions: readonly EdgeExtension[]) => createEdgeExtensionRegistry(extensions);
  assert.throws(() => build([{ id: "Bad Id" }]), /invalid edge extension id/);
  assert.throws(() => build([probe, probe]), /duplicate edge extension id "probe"/);
  assert.throws(
    () => build([{ id: "x", routes: [{ id: "r", pattern: "/healthz", methods: ["GET"], handle() {} }] }]),
    /must start with \/api\//,
  );
  assert.throws(
    () => build([{ id: "x", routes: [{ id: "r", pattern: "/api/sessions", methods: ["GET"], permission: "usage", handle() {} }] }]),
    /collides with core route/,
  );
  assert.throws(
    () => build([{ id: "x", routes: [{ id: "r", pattern: "/api/machines/:machine/:provider/accounts", methods: ["POST"], permission: "usage", handle() {} }] }]),
    /collides with core route/,
  );
  assert.throws(
    () => build([probe, { id: "y", routes: [{ id: "r", pattern: "/api/ext/probe/items/:other", methods: ["GET"], permission: "usage", handle() {} }] }]),
    /collides with extension route probe:read/,
  );
  assert.throws(
    () => build([{ id: "x", routes: [{ id: "r", pattern: "/api/ext/x", methods: ["GET"], permission: "nope", handle() {} }] }]),
    /undeclared permission "nope"/,
  );
  // An omitted permission would let every authenticated principal in.
  assert.throws(
    () => build([{ id: "x", routes: [{ id: "r", pattern: "/api/ext/x", methods: ["GET"], handle() {} } as unknown as EdgeRoute] }]),
    /x:r: permission is required/,
  );
  assert.throws(() => build([{ id: "x", permissions: ["usage"] }]), /permission "usage" is a core permission/);
  assert.throws(() => build([{ id: "x", permissions: ["Bad-Perm"] }]), /invalid permission/);
  assert.throws(() => build([{ id: "x", clientPermissions: ["undeclared"] }]), /undeclared client permission/);
  const registry = build([probe]);
  assert.deepEqual(registry.permissions, ["probe_read", "probe_write"]);
  assert.equal(registry.match("/api/ext/probe/items/a", "GET")?.route.key, "probe:read");
  assert.equal(registry.match("/api/ext/probe/items/a", "PUT")?.route.key, "probe:write");
  assert.equal(registry.match("/api/ext/probe/items/a", "DELETE")?.route, undefined);
  assert.equal(registry.match("/api/ext/probe/items/a", "DELETE")?.methodAllowed, false);
  assert.equal(registry.match("/api/ext/other", "GET"), null);
});

test("principals may hold extension permissions only when the extension declares them", () => {
  const env = {
    AGENT_CONSOLE_STATE_DB: "/tmp/edge-extensions-access.sqlite",
    AGENT_CONSOLE_PRINCIPALS: JSON.stringify([{ id: "owner", token: "owner-token", machines: [], permissions: ["usage", "probe_write"] }]),
  };
  assert.throws(() => loadConfig(env), /unknown permission: probe_write/);
  const config = loadConfig(env, { extraPermissions: ["probe_write"] });
  assert.deepEqual(config.principals[0]?.permissions, ["usage", "probe_write"]);
});

async function multiUserEdge(
  principals: readonly PrincipalConfig[],
  machines: EdgeConfig["machines"] = [],
  seed?: (access: AccessStore) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "edge-extensions-"));
  const accessDbPath = join(dir, "access.sqlite");
  if (seed) {
    const access = new AccessStore(accessDbPath);
    seed(access);
    access.close();
  }
  const edge = createEdgeServer(makeEdgeConfig({
    openAccess: false, multiUser: true, accessDbPath, principals, machines,
  }), { extensions: [probe] });
  const { base } = await listenOnLoopback(edge);
  return { base, close: async () => { await closeServers(edge); rmSync(dir, { recursive: true, force: true }); } };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const extensionPermissions = (...permissions: string[]) => permissions as unknown as PrincipalConfig["permissions"];

test("extension routes run after authentication with params and the principal", async () => {
  const edge = await multiUserEdge([
    { id: "owner", token: "owner-token", machines: [], permissions: extensionPermissions("probe_read") },
    { id: "none", token: "none-token", machines: [], permissions: [] },
  ]);
  try {
    // Every extension route names a permission, so a principal holding none is refused.
    assert.equal((await fetch(`${edge.base}/api/ext/probe/items/a`, { headers: bearer("none-token") })).status, 403);
    assert.equal((await fetch(`${edge.base}/api/ext/probe/items/a`)).status, 401);
    const read = await fetch(`${edge.base}/api/ext/probe/items/a%20b`, { headers: bearer("owner-token") });
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).data, { item: "a b", principal: "owner" });
    assert.equal((await fetch(`${edge.base}/api/ext/probe/items/a`, { method: "DELETE", headers: bearer("owner-token") })).status, 405);
    assert.equal((await fetch(`${edge.base}/api/ext/probe/missing`, { headers: bearer("owner-token") })).status, 404);
  } finally {
    await edge.close();
  }
});

test("extension write routes enforce declared permissions and cross-origin refusal", async () => {
  const edge = await multiUserEdge([
    { id: "owner", token: "owner-token", machines: [], permissions: ["probe_write"] as unknown as PrincipalConfig["permissions"] },
    { id: "viewer", token: "viewer-token", machines: [], permissions: [] },
  ]);
  const put = (token: string, headers: Record<string, { source: string }> = {}) => fetch(`${edge.base}/api/ext/probe/items/a`, {
    method: "PUT",
    headers: { ...bearer(token), "content-type": "application/json", ...headers },
    body: JSON.stringify({ value: 1 }),
  });
  try {
    assert.equal((await put("viewer-token")).status, 403);
    const ok = await put("owner-token");
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).data, { item: "a", body: { value: 1 } });
    // A cookie session from a foreign origin is refused; bearer-token requests are exempt as for core routes.
    const login = await fetch(`${edge.base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "owner-token" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const foreign = await fetch(`${edge.base}/api/ext/probe/items/a`, {
      method: "PUT",
      headers: { cookie, origin: "https://elsewhere.example", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(foreign.status, 403);
  } finally {
    await edge.close();
  }
});

test("extension routes get core machine and session scoping", async () => {
  const daemon = jsonReader((url) => url.pathname === "/sessions"
    ? { status: 200, body: { ok: true, data: { sessions: [
      { id: "alice-session", agent: "codex", status: "running", session_incarnation: "alice-inc" },
      { id: "bob-session", agent: "codex", status: "running", session_incarnation: "bob-inc" },
    ] } } }
    : null);
  const daemonBase = (await listenOnLoopback(daemon)).base;
  const read = extensionPermissions("probe_read");
  const edge = await multiUserEdge(
    [
      { id: "alice", token: "alice-token", machines: ["host-a"], permissions: read },
      { id: "bob", token: "bob-token", machines: ["host-a", "host-b"], permissions: read },
      { id: "root", token: "root-token", machines: [], permissions: read },
    ],
    [
      { name: "host-a", url: daemonBase, token: "daemon-token" },
      { name: "host-b", url: daemonBase, token: "daemon-token" },
    ],
    (access) => {
      access.claimSession({ principalId: "alice", machine: "host-a", sessionId: "alice-session", incarnation: "alice-inc" });
      access.claimSession({ principalId: "bob", machine: "host-a", sessionId: "bob-session", incarnation: "bob-inc" });
    },
  );
  const get = async (token: string, path: string) => (await fetch(`${edge.base}${path}`, { headers: bearer(token) })).status;
  try {
    assert.equal(await get("alice-token", "/api/ext/probe/machines/host-a/state"), 200);
    assert.equal(await get("alice-token", "/api/ext/probe/machines/host-b/state"), 404);
    assert.equal(await get("alice-token", "/api/ext/probe/machines/host-z/state"), 404);
    const own = await fetch(`${edge.base}/api/ext/probe/sessions/host-a/alice-session/note`, { headers: bearer("alice-token") });
    assert.equal(own.status, 200);
    assert.deepEqual((await own.json()).data, { machine: "host-a", id: "alice-session" });
    assert.equal(await get("alice-token", "/api/ext/probe/sessions/host-a/bob-session/note"), 404);
    assert.equal(await get("alice-token", "/api/ext/probe/sessions/host-b/zzz/note"), 404);
    // Same answer as the core route for the same target.
    assert.equal(await get("alice-token", "/api/sessions/host-b/zzz/glance"), 404);
    assert.equal(await get("bob-token", "/api/ext/probe/sessions/host-a/bob-session/note"), 200);
    assert.equal(await get("root-token", "/api/ext/probe/sessions/host-a/bob-session/note"), 200);
    assert.equal(await get("root-token", "/api/ext/probe/sessions/host-a/missing/note"), 404);
  } finally {
    await edge.close();
    closeServers(daemon);
  }
});

test("the UI still receives only core permissions", async () => {
  const edge = await multiUserEdge([
    { id: "owner", token: "owner-token", machines: [], permissions: ["usage", "probe_write"] as unknown as PrincipalConfig["permissions"] },
  ]);
  try {
    const status = await (await fetch(`${edge.base}/api/auth/status`, { headers: bearer("owner-token") })).json();
    assert.deepEqual(status.principal.permissions, ["usage"]);
  } finally {
    await edge.close();
  }
});

test("extensions add session list capabilities without overriding core ones (#918)", async () => {
  const seen: boolean[] = [];
  const caps: EdgeExtension = {
    id: "caps",
    permissions: ["caps_use"],
    sessionCapabilities({ can }) {
      seen.push(can("caps_use"));
      return can("caps_use") ? { caps_machine: "summit", history: false } : undefined;
    },
  };
  const edge = createEdgeServer(makeEdgeConfig(), { extensions: [caps] });
  const { base } = await listenOnLoopback(edge);
  try {
    const body = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(body.data.capabilities.caps_machine, "summit");
    assert.equal(body.data.capabilities.history, true, "core keys win");
    assert.deepEqual(seen, [true], "a single-user principal holds every permission");
  } finally {
    closeServers(edge);
  }
});

test("the edge package exports the extension contract", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports?: Record<string, { source: string }> };
  assert.equal(manifest.exports?.["./extensions"]?.source, "./src/extensions.ts");
  // Private host integrations reuse core's host reader client (#918).
  assert.equal(manifest.exports?.["./host-reader"]?.source, "./src/hostReader.ts");
});
