import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { closeServers, listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

async function fixture(reused = false) {
  const dir = mkdtempSync(join(tmpdir(), "console-root-"));
  const path = join(dir, "access.sqlite");
  const access = new AccessStore(path);
  access.claimSession({ principalId: "tess", machine: "cedar", sessionId: "tess-session", incarnation: "tess-inc" });
  access.claimSession({ principalId: "dana", machine: "cedar", sessionId: "dana-session", incarnation: "dana-inc" });
  access.claimSession({ principalId: "dana", machine: "maple", sessionId: "dana-session", incarnation: "dana-inc" });
  if (reused) access.claimSession({ principalId: "dana", machine: "maple", sessionId: "reused-session", incarnation: "old-inc" });
  access.claimProvider("dana", "maple", "codex", "dana-provider");
  access.close();
  const requests: string[] = [];
  const servers: Server[] = [];
  const machines = [];
  for (const name of ["cedar", "maple"]) {
    const sessions = [
      ...(name === "cedar" ? [{ id: "tess-session", session_incarnation: "tess-inc" }] : []),
      { id: "dana-session", session_incarnation: "dana-inc" },
      { id: "unowned-session", session_incarnation: "unknown-inc" },
      ...(reused && name === "maple" ? [{ id: "reused-session", session_incarnation: "new-inc" }] : []),
    ].map(session => ({ ...session, agent: "codex", status: "running", agent_env: { TOKEN: "private-sentinel" } }));
    const daemon = createServer((req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${name}-operator`);
      requests.push(`${name} ${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/sessions") res.end(JSON.stringify({ ok: true, data: { sessions } }));
      else if (req.url?.endsWith("/archive")) {
        const id = req.url.split("/")[2]!;
        res.end(JSON.stringify({ ok: true, data: {
          archived: { history_id: `${id}-history`, provider: "codex", provider_session_id: `${id.replace("-session", "")}-provider`,
            cwd: "/work", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", archived_at: "2026-10-03T00:00:00Z" },
          deleted: { id, deleted: true, killed: true, cleanup_pending: false },
        } }));
      }
      else res.end(JSON.stringify({ ok: true, data: { text: `${name} private conversation` } }));
    });
    servers.push(daemon);
    const { base } = await listenOnLoopback(daemon);
    machines.push({ name, url: base, token: `${name}-operator` });
  }
  const edge = createEdgeServer(makeEdgeConfig({
    openAccess: false, multiUser: true, accessDbPath: path, machines,
    principals: [
      { id: "tess", token: "tess-token", machines: ["cedar"], permissions: [] },
      { id: "dana", token: "dana-token", machines: ["cedar", "maple"], permissions: [] },
      // Root's scope follows the configured machines, not a second host roster.
      { id: "root", token: "root-token", machines: [], permissions: [] },
    ],
  }));
  const { base } = await listenOnLoopback(edge);
  return { base, path, requests, cleanup: async () => {
    await closeServers(edge, ...servers);
    rmSync(dir, { recursive: true, force: true });
  } };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("root lists every configured host and owner without claiming sessions; Tess stays isolated", async () => {
  const f = await fixture();
  try {
    const root = await fetch(`${f.base}/api/sessions`, { headers: auth("root-token") });
    assert.equal(root.status, 200);
    const data = (await root.json()).data;
    assert.deepEqual(data.machines.map((m: any) => m.name).sort(), ["cedar", "maple"]);
    assert.deepEqual(data.sessions.map((s: any) => `${s.machine}/${s.id}`).sort(), [
      "cedar/dana-session", "cedar/tess-session", "cedar/unowned-session", "maple/dana-session", "maple/unowned-session",
    ]);
    assert.equal(JSON.stringify(data).includes("private-sentinel"), false);
    const selected = (await (await fetch(`${f.base}/api/sessions?machines=maple`, { headers: auth("root-token") })).json()).data;
    assert.equal(selected.sessions.length, 2);
    assert.ok(selected.sessions.every((s: any) => s.machine === "maple"));
    const tess = (await (await fetch(`${f.base}/api/sessions`, { headers: auth("tess-token") })).json()).data;
    assert.deepEqual(tess.sessions.map((s: any) => s.id), ["tess-session"]);
    assert.deepEqual(tess.machines.map((m: any) => m.name), ["cedar"]);
    const access = new AccessStore(f.path);
    try {
      assert.equal(access.sessionGrant("maple", "dana-session")?.principalId, "dana");
      assert.equal(access.sessionGrant("cedar", "dana-session")?.principalId, "dana");
      assert.equal(access.sessionGrant("maple", "unowned-session"), undefined);
    } finally { access.close(); }
  } finally { await f.cleanup(); }
});

test("root reads and sends on shared and collaborator hosts; Tess cannot reach Dana or unowned sessions", async () => {
  const f = await fixture();
  try {
    for (const machine of ["cedar", "maple"]) {
      for (const id of ["dana-session", "unowned-session"]) {
        for (const suffix of ["glance", "buffer", "send"]) {
          const options = suffix === "send" ? { method: "POST", body: JSON.stringify({ text: "test prompt" }) } : {};
          const route = `${f.base}/api/sessions/${machine}/${id}/${suffix}`;
          assert.equal((await fetch(route, { ...options, headers: auth("root-token") })).status, 200, route);
          const before = f.requests.length;
          assert.equal((await fetch(route, { ...options, headers: auth("tess-token") })).status, 404, route);
          assert.ok(f.requests.slice(before).every(request => request.endsWith("GET /sessions")), "denied requests never forward conversation reads or writes");
        }
      }
    }
    assert.ok(f.requests.includes("maple POST /sessions/dana-session/send"));
    const cookie = await loginCookie(f.base, "root-token");
    const ticket = await fetch(`${f.base}/api/sessions/maple/dana-session/attach-ticket`, {
      method: "POST", headers: auth("root-token"),
    });
    assert.equal(ticket.status, 403, "global visibility does not grant a terminal ticket");
    const read = await fetch(`${f.base}/api/sessions/maple/dana-session/glance`, { headers: { cookie } });
    assert.equal(read.status, 200);
    const denied = await fetch(`${f.base}/api/sessions/maple/dana-session/send`, {
      method: "POST", headers: { cookie, origin: "https://foreign.example" }, body: "{}",
    });
    assert.equal(denied.status, 403, "root cookies retain the same-origin write boundary");
    assert.equal((await fetch(`${f.base}/api/sessions/maple/missing/glance`, { headers: auth("root-token") })).status, 404);
  } finally { await f.cleanup(); }
});


test("root archive keeps the existing history owner and leaves unowned sessions unclaimed", async () => {
  const f = await fixture();
  try {
    for (const id of ["dana-session", "unowned-session"]) {
      const response = await fetch(`${f.base}/api/sessions/maple/${id}/archive`, {
        method: "POST", headers: auth("root-token"),
        body: JSON.stringify({ expected_session_incarnation: id === "dana-session" ? "dana-inc" : "unknown-inc" }),
      });
      assert.equal(response.status, 200, id);
    }
    const access = new AccessStore(f.path);
    try {
      assert.equal(access.ownsHistory("dana", "maple", "dana-session-history"), true);
      assert.equal(access.ownsHistory("root", "maple", "dana-session-history"), false);
      assert.equal(access.hasProviderOwner("maple", "codex", "unowned-provider"), false);
      assert.equal(access.ownsHistory("root", "maple", "unowned-session-history"), false);
    } finally { access.close(); }
  } finally { await f.cleanup(); }
});


test("root archive does not assign a reused runtime's history to its stale prior owner", async () => {
  const f = await fixture(true);
  try {
    const response = await fetch(`${f.base}/api/sessions/maple/reused-session/archive`, {
      method: "POST", headers: auth("root-token"), body: JSON.stringify({ expected_session_incarnation: "new-inc" }),
    });
    assert.equal(response.status, 200);
    const access = new AccessStore(f.path);
    try {
      assert.equal(access.sessionGrant("maple", "reused-session")?.incarnation, "old-inc");
      assert.equal(access.hasProviderOwner("maple", "codex", "reused-provider"), false);
      assert.equal(access.ownsHistory("dana", "maple", "reused-session-history"), false);
      assert.equal(access.ownsHistory("root", "maple", "reused-session-history"), false);
    } finally { access.close(); }
  } finally { await f.cleanup(); }
});
