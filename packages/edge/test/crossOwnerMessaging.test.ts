import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { loadConfig } from "../src/config.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const rule = { from: "owner-a", to: "owner-b", recipients: [{ role: "coordinator" }, { repo_name: "steward" }] };
const machines = ["host-a", "host-b"].map(name => ({ name, url: "https://daemon.example.test", token: name }));
const principals = ["owner-a", "owner-b"].map((id, i) => ({ id, token: id, machines: [machines[i]!.name], permissions: [] }));
const env = { AGENT_CONSOLE_MACHINES: JSON.stringify(machines), AGENT_CONSOLE_PRINCIPALS: JSON.stringify(principals), AGENT_CONSOLE_STATE_DB: "/private/access.sqlite" };

test("cross-owner messaging config is opt-in and rejects ambiguous or unconfigured rules", () => {
  assert.deepEqual(loadConfig(env).crossOwnerMessaging, []);
  assert.deepEqual(loadConfig({ ...env, AGENT_CONSOLE_CROSS_OWNER_MESSAGING: JSON.stringify([rule]) }).crossOwnerMessaging, [rule]);
  const restricted = { ...rule, senders: [{ role: "coordinator" }, { repo_name: "control" }] };
  assert.deepEqual(loadConfig({ ...env, AGENT_CONSOLE_CROSS_OWNER_MESSAGING: JSON.stringify([restricted]) }).crossOwnerMessaging, [restricted]);
  for (const senders of [null, {}, [], [null], [{}], [{ role: "worker" }], [{ repo_name: "" }],
    [{ repo_name: " " }], [{ repo_name: "a".repeat(257) }], [{ role: "coordinator", repo_name: "control" }], [{ machine: "host-a" }]]) {
    assert.throws(() => loadConfig({ ...env, AGENT_CONSOLE_CROSS_OWNER_MESSAGING: JSON.stringify([{ ...rule, senders }]) }), /CROSS_OWNER_MESSAGING/);
  }
  for (const rules of [
    {}, [null], [{ ...rule, from: "unknown" }], [{ ...rule, to: rule.from }],
    [{ ...rule, recipients: [] }], [{ ...rule, recipients: [{}] }],
    [{ ...rule, recipients: [{ role: "worker" }] }],
    [{ ...rule, recipients: [{ repo_name: "" }] }],
    [{ ...rule, recipients: [{ role: "coordinator", repo_name: "steward" }] }],
    [{ ...rule, recipients: [{ machine: "host-b" }] }], [{ ...rule, wildcard: true }],
    [rule, rule],
  ]) assert.throws(() => loadConfig({ ...env, AGENT_CONSOLE_CROSS_OWNER_MESSAGING: JSON.stringify(rules) }), /CROSS_OWNER_MESSAGING/);
});

async function fixture(rules: unknown[] = [], sharedMachine = false, coordinatorSender = false) {
  const dir = mkdtempSync(join(tmpdir(), "cross-owner-message-"));
  const db = join(dir, "access.sqlite");
  const access = new AccessStore(db);
  access.claimSession({ principalId: "owner-a", machine: "host-a", sessionId: "sender", incarnation: "sender-inc", ...(coordinatorSender ? { consoleRole: "coordinator" } : {}) });
  access.claimSession({ principalId: "owner-b", machine: "host-b", sessionId: "coordinator", incarnation: "coordinator-inc", consoleRole: "coordinator" });
  for (const id of ["resident", "ordinary", "spoofed"]) {
    access.claimSession({ principalId: "owner-b", machine: "host-b", sessionId: id, incarnation: id + "-inc" });
  }
  access.close();
  let writes = 0;
  let destinationSnapshots = 0;
  const hooks = { beforeSnapshot: () => {}, destinationAvailable: true };
  const sessions: Record<string, unknown>[] = [
    { id: "coordinator", repo_name: "control", role: "coordinator" },
    { id: "resident", repo_name: "steward" },
    { id: "ordinary", repo_name: "project" },
    { id: "spoofed", repo_name: "project", role: "coordinator" },
    { id: "unowned", repo_name: "steward" },
  ].map(s => ({ ...s, session_incarnation: s.id + "-inc", status: "running", coordination_mode: "advisory", coordination_available: true }));
  const sourceSessions: Record<string, unknown>[] = [{ id: "sender", repo_name: "control", session_incarnation: "sender-inc", status: "running", coordination_mode: "advisory", coordination_available: true }];
  const daemons = [sourceSessions, sessions].map(rows => createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      if (rows === sessions) {
        destinationSnapshots++;
        hooks.beforeSnapshot();
        if (!hooks.destinationAvailable) { res.statusCode = 503; res.end("{}"); return; }
      }
      res.end(JSON.stringify({ ok: true, data: { coordination: { remote_messaging_supported: true }, sessions: rows } }));
    } else {
      assert.equal(req.url, "/coordination/messages/receive/v1");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      writes++;
      res.end(JSON.stringify({ schema_version: "agent-session.remote-delivery.v1", message_id: body.message_id, state: "delivered", recipient: body.to, persisted_at_epoch: Math.floor(Date.now() / 1000) }));
    }
  }));
  const addresses = await Promise.all(daemons.map(listenOnLoopback));
  const edge = createEdgeServer(makeEdgeConfig({
    multiUser: true, openAccess: false, accessDbPath: db,
    principals: principals.map(p => sharedMachine && p.id === "owner-a" ? { ...p, machines: ["host-a", "host-b"] } : p),
    machines: machines.map((m, i) => ({ ...m, url: addresses[i]!.base })),
    ...{ crossOwnerMessaging: rules },
    coordinationRelays: machines.map((m, i) => ({ machine: m.name, token: "relay-" + i, ingress_token: "ingress-" + i })),
  }));
  const { base } = await listenOnLoopback(edge);
  const peers = async () => {
    const res = await fetch(base + "/api/coordination/peers/v1?source_session_id=sender&source_incarnation=sender-inc", { headers: { authorization: "Bearer relay-0" } });
    assert.equal(res.status, 200);
    return (await res.json() as { peers: { session_id: string }[] }).peers.map(p => p.session_id);
  };
  const send = async (id: string, reply = false, reverse = false, recipientIncarnation = id + "-inc") => {
    const now = Math.floor(Date.now() / 1000);
    const sender = { machine: "host-a", session_id: "sender", session_incarnation: "sender-inc" };
    const recipient = { machine: "host-b", session_id: id, session_incarnation: recipientIncarnation };
    return fetch(base + "/api/coordination/relay/v1", { method: "POST", headers: { authorization: "Bearer relay-" + (reverse ? 1 : 0), "content-type": "application/json" }, body: JSON.stringify({
      schema_version: "agent-session.remote-message.v1", message_id: "7f502746-1a36-45b6-83aa-484f370e280a",
      from: reverse ? recipient : sender, to: reverse ? sender : recipient,
      body: "fixture", body_sha256: createHash("sha256").update("fixture").digest("hex"),
      created_at_epoch: now, expires_at_epoch: now + 3600, reply_to: reply ? "parent" : null, reply_depth: reply ? 1 : 0,
    }) });
  };
  return { db, base, sessions, sourceSessions, hooks, peers, send, destinationSnapshots: () => destinationSnapshots, writes: () => writes, cleanup: async () => {
    await Promise.all([edge, ...daemons].map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
    rmSync(dir, { recursive: true, force: true });
  } };
}

test("configured discovery and send allow only selected recipients on the recipient owner's machines", async () => {
  const f = await fixture([rule]);
  try {
    assert.deepEqual(await f.peers(), ["sender", "coordinator", "resident"]);
    for (const id of ["coordinator", "resident"]) assert.equal((await f.send(id)).status, 200);
    for (const id of ["ordinary", "spoofed"]) assert.equal((await f.send(id)).status, 403);
    assert.equal((await f.send("unowned")).status, 403);
    assert.equal((await f.send("resident", false, true)).status, 403);
    assert.equal(f.writes(), 2);
    // Browser session lists and direct session/transcript access retain owner isolation.
    const headers = { authorization: "Bearer owner-a" };
    const listed = await fetch(f.base + "/api/sessions", { headers });
    assert.equal(listed.status, 200);
    assert.equal(JSON.stringify(await listed.json()).includes("resident"), false);
    const hidden = await fetch(f.base + "/api/sessions/host-b/resident/glance", { headers });
    assert.equal(hidden.status, 404);
  } finally { await f.cleanup(); }
});

test("sender role restriction denies an ordinary worker sending to a foreign coordinator", async () => {
  // The source has no coordinator grant, while the destination has a trusted
  // coordinator grant.
  const f = await fixture([{ ...rule, senders: [{ role: "coordinator" }] }]);
  try {
    const result = await f.send("coordinator");
    assert.equal(result.status, 403);
    assert.equal((await result.json() as { error: { code: string } }).error.code, "principal-forbidden");
    assert.equal(f.writes(), 0);
    assert.deepEqual(await f.peers(), ["sender"]);
  } finally { await f.cleanup(); }
});

test("sender denial precedes foreign recipient lifecycle diagnostics and snapshot requests", async () => {
  const f = await fixture([{ ...rule, senders: [{ role: "coordinator" }] }]);
  try {
    f.hooks.destinationAvailable = false;
    for (const [id, incarnation] of [["coordinator", "coordinator-inc"], ["coordinator", "stale"], ["unowned", "unowned-inc"]]) {
      const result = await f.send(id!, false, false, incarnation!);
      assert.equal(result.status, 403);
      assert.equal((await result.json() as { error: { code: string } }).error.code, "principal-forbidden");
    }
    assert.deepEqual(await f.peers(), ["sender"]);
    assert.equal(f.destinationSnapshots(), 0);
    assert.equal(f.writes(), 0);
  } finally { await f.cleanup(); }
});

test("sender coordinator grants allow selected recipients and cannot be spoofed by daemon roles", async () => {
  const restricted = { ...rule, senders: [{ role: "coordinator" }] };
  for (const trusted of [false, true]) {
    const f = await fixture([restricted], false, trusted);
    try {
      f.sourceSessions[0]!.role = "coordinator";
      assert.deepEqual(await f.peers(), trusted ? ["sender", "coordinator", "resident"] : ["sender"]);
      for (const reply of [false, true]) assert.equal((await f.send("coordinator", reply)).status, trusted ? 200 : 403);
      assert.equal((await f.send("ordinary")).status, 403);
      assert.equal(f.writes(), trusted ? 2 : 0);
    } finally { await f.cleanup(); }
  }
});

test("sender selectors match any exact repository or trusted role while preserving recipient restrictions", async () => {
  const f = await fixture([{ ...rule, senders: [{ role: "coordinator" }, { repo_name: "control" }] }]);
  try {
    assert.equal((await f.send("resident")).status, 200);
    assert.deepEqual(await f.peers(), ["sender", "coordinator", "resident"]);
    assert.equal((await f.send("ordinary")).status, 403);
    f.sourceSessions[0]!.repo_name = "control-other";
    assert.equal((await f.send("coordinator")).status, 403);
    assert.deepEqual(await f.peers(), ["sender"]);
    delete f.sourceSessions[0]!.repo_name;
    assert.equal((await f.send("resident", true)).status, 403);
    assert.equal(f.writes(), 1);
  } finally { await f.cleanup(); }
});

test("sender coordinator revocation during asynchronous snapshots denies discovery and delivery", async () => {
  const f = await fixture([{ ...rule, senders: [{ role: "coordinator" }] }], false, true);
  try {
    assert.equal((await f.send("coordinator")).status, 200);
    f.hooks.beforeSnapshot = () => {
      const db = new DatabaseSync(f.db);
      db.prepare("UPDATE session_ownership SET console_role = NULL WHERE session_id = ?").run("sender");
      db.close();
    };
    assert.equal((await f.send("coordinator")).status, 403);
    assert.deepEqual(await f.peers(), ["sender"]);
    assert.equal(f.writes(), 1);
  } finally { await f.cleanup(); }
});

test("allowances do not grant transcript access or list foreign sessions on a shared machine", async () => {
  const f = await fixture([rule], true);
  try {
    assert.equal((await f.send("resident")).status, 200);
    const headers = { authorization: "Bearer owner-a" };
    for (const suffix of ["glance", "buffer"]) {
      assert.equal((await fetch(f.base + "/api/sessions/host-b/resident/" + suffix, { headers })).status, 404);
    }
    const listed = await fetch(f.base + "/api/sessions", { headers });
    assert.equal(listed.status, 200);
    assert.equal(JSON.stringify(await listed.json()).includes("resident"), false);
  } finally { await f.cleanup(); }
});

test("coordinator permission is rechecked from the ownership store after asynchronous snapshots", async () => {
  const f = await fixture([rule]);
  try {
    f.hooks.beforeSnapshot = () => {
      const db = new DatabaseSync(f.db);
      db.prepare("UPDATE session_ownership SET console_role = NULL WHERE session_id = ?").run("coordinator");
      db.close();
    };
    assert.equal((await f.send("coordinator")).status, 403);
    assert.equal(f.writes(), 0);
  } finally { await f.cleanup(); }
});

test("an explicit reverse rule enables new messages and replies to selected original senders", async () => {
  const f = await fixture([rule, { from: "owner-b", to: "owner-a", recipients: [{ repo_name: "control" }] }]);
  try {
    assert.equal((await f.send("resident", false, true)).status, 200);
    assert.equal((await f.send("resident", true, true)).status, 200);
    assert.equal(f.writes(), 2);
  } finally { await f.cleanup(); }
});

test("no allowance denies both new cross-owner messages and forged replies", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.peers(), ["sender"]);
    for (const reply of [false, true]) assert.equal((await f.send("resident", reply)).status, 403);
    assert.equal(f.writes(), 0);
  } finally { await f.cleanup(); }
});

test("unselected foreign sessions reveal no live state through relay errors", async () => {
  const f = await fixture([rule]);
  try {
    const ordinary = f.sessions.find(s => s.id === "ordinary")!;
    const variants = [
      { ...ordinary },
      { ...ordinary, coordination_available: false },
      { ...ordinary, session_incarnation: "replacement" },
      null,
    ];
    for (const variant of variants) {
      f.sessions.splice(f.sessions.findIndex(s => s.id === "ordinary"), 1);
      if (variant) f.sessions.push(variant);
      const result = await f.send("ordinary");
      assert.equal(result.status, 403);
      assert.equal((await result.json() as { error: { code: string } }).error.code, "principal-forbidden");
    }
    assert.equal(f.writes(), 0);
  } finally { await f.cleanup(); }
});

test("recipient incarnation and coordination availability remain mandatory with an allowance", async () => {
  const f = await fixture([rule]);
  try {
    f.sessions.find(s => s.id === "resident")!.session_incarnation = "replacement";
    assert.equal((await f.send("resident")).status, 409);
    assert.deepEqual(await f.peers(), ["sender", "coordinator"]);
    f.sessions.find(s => s.id === "coordinator")!.coordination_available = false;
    assert.equal((await f.send("coordinator")).status, 422);
    assert.equal(f.writes(), 0);
  } finally { await f.cleanup(); }
});
