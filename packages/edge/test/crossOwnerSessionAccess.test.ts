import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import type { BoardRecord } from "../src/board/record.ts";
import { BoardStore } from "../src/board/store.ts";
import { loadConfig } from "../src/config.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const NOW = Date.parse("2030-01-10T00:00:00Z");
const rule = {
  owner: "owner-a",
  viewer: "viewer-b",
  sessions: [{ machine: "host-a", session_id: "resident" }, { machine: "host-a", session_id: "selected" }],
};
const machines = ["host-a", "host-b"].map(name => ({ name, url: "https://daemon.example.test", token: name }));
const principals = ["owner-a", "viewer-b", "other-c"].map(id => ({ id, token: id, machines: machines.map(m => m.name), permissions: [] }));
const env = { AGENT_CONSOLE_MACHINES: JSON.stringify(machines), AGENT_CONSOLE_PRINCIPALS: JSON.stringify(principals), AGENT_CONSOLE_STATE_DB: "/private/access.sqlite" };
const configured = (value: unknown) => loadConfig({ ...env, AGENT_CONSOLE_CROSS_OWNER_SESSION_ACCESS: JSON.stringify(value) });

test("cross-owner session access config is opt-in and rejects ambiguous or unconfigured rules", () => {
  assert.deepEqual(loadConfig(env).crossOwnerSessionAccess, []);
  assert.deepEqual(configured([rule]).crossOwnerSessionAccess, [rule]);
  for (const rules of [
    {}, [null], [{ ...rule, owner: "unknown" }], [{ ...rule, viewer: "unknown" }], [{ ...rule, viewer: rule.owner }],
    [{ ...rule, sessions: [] }], [{ ...rule, sessions: {} }], [{ ...rule, sessions: [null] }],
    [{ ...rule, sessions: [{ machine: "host-a" }] }], [{ ...rule, sessions: [{ session_id: "resident" }] }],
    [{ ...rule, sessions: [{ repo_name: "project" }] }],
    [{ ...rule, sessions: [{ machine: "host-a", session_id: "resident", repo_name: "project" }] }],
    [{ ...rule, sessions: [{ machine: "unknown", session_id: "resident" }] }],
    [{ ...rule, sessions: [{ machine: "host-a", session_id: " " }] }],
    [{ ...rule, sessions: [{ machine: "host-a", session_id: "a".repeat(257) }] }],
    [{ ...rule, sessions: [rule.sessions[0], rule.sessions[0]] }],
    [{ ...rule, wildcard: true }], [rule, rule],
  ]) assert.throws(() => configured(rules), /CROSS_OWNER_SESSION_ACCESS/);
});

type Row = Record<string, unknown>;

// owner-a owns every session except `own` (viewer-b) and `foreign-child`
// (other-c). resident -> child -> grandchild is a dispatch chain; `launched`
// was only launched by the resident; `stale` has an outdated grant.
const ownedByA = [
  ["host-a", "resident", undefined, undefined], ["host-a", "child", "resident", undefined],
  ["host-a", "grandchild", "child", undefined], ["host-a", "launched", undefined, "resident"],
  ["host-a", "selected", undefined, undefined], ["host-a", "unselected", undefined, undefined],
  ["host-a", "unselected-child", "unselected", undefined], ["host-a", "stale", "resident", undefined],
  ["host-b", "resident", undefined, undefined],
] as const;

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cross-owner-session-access-"));
  const accessPath = join(dir, "access.sqlite");
  const boardPath = join(dir, "board.sqlite");
  const access = new AccessStore(accessPath);
  for (const [machine, sessionId, dispatcher, launcher] of ownedByA) {
    access.claimSession({ principalId: "owner-a", machine, sessionId, incarnation: `${sessionId}-inc`,
      ...(dispatcher ? { dispatcher: { machine, sessionId: dispatcher } } : {}),
      ...(launcher ? { launcher: { machine, sessionId: launcher } } : {}) });
  }
  access.claimSession({ principalId: "viewer-b", machine: "host-a", sessionId: "own", incarnation: "own-inc" });
  access.claimSession({ principalId: "other-c", machine: "host-a", sessionId: "foreign-child", incarnation: "foreign-child-inc",
    dispatcher: { machine: "host-a", sessionId: "resident" } });
  access.close();

  const board = new BoardStore(boardPath);
  const record = (id: string): BoardRecord => ({
    machine: "host-a", session_id: id, session_incarnation: `${id}-inc`, messaging_supported: true, repo_name: "project",
    cwd: "~/project", provider: "codex", agent_profile: null, title: `title-${id}`, title_state: null, turn_state: null,
    state: "live", runtime_status: "running", created_at: "2030-01-01T00:00:00Z", updated_at: new Date(NOW - 3600_000).toISOString(),
    closed_at: null, close_reason: null, summary: null,
  } as BoardRecord);
  board.applySnapshot("host-a", ["resident", "child", "unselected", "own"].map(record), true, NOW - 10_000);
  board.close();

  const calls: string[] = [];
  const prompts: Row[] = [];
  const daemonFor = (machine: string) => createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      const ids = machine === "host-a"
        ? [...ownedByA.filter(s => s[0] === "host-a").map(s => s[1]), "own", "foreign-child"] : ["resident"];
      res.end(JSON.stringify({ ok: true, data: { sessions: ids.map(id => ({
        id, repo_name: "project", agent: "codex", status: "running",
        session_incarnation: id === "stale" ? "stale-moved" : `${id}-inc`,
        runtime_started_at: "2030-01-01T00:00:00Z",
        // The viewer's own session reports no provider so its normal binding stays out of the snapshot.
        ...(id === "own" ? {} : { provider_resume: { provider: "codex", session_id: `provider-${id}` } }),
      })) } }));
      return;
    }
    calls.push(`${machine} ${req.method} ${req.url}`);
    let text = ""; for await (const chunk of req) text += String(chunk);
    if (req.url?.endsWith("/prompt/v2")) {
      const body = JSON.parse(text) as Row; prompts.push(body);
      const receipt = { request_id: body.request_id, session_id: "resident", session_incarnation: body.expected_session_incarnation, outcome: "submitted", code: null };
      res.end(JSON.stringify({ ok: true, data: { receipt } }));
      return;
    }
    res.end(JSON.stringify({ ok: true, data: { lines: [], text: "fixture" } }));
  });
  const daemons = [daemonFor("host-a"), daemonFor("host-b")];
  const addresses = await Promise.all(daemons.map(listenOnLoopback));
  const config = makeEdgeConfig({
    openAccess: false, multiUser: true, accessDbPath: accessPath,
    principals: [
      { id: "owner-a", token: "owner-a", machines: ["host-a", "host-b"], permissions: [] },
      { id: "viewer-b", token: "viewer-b", machines: ["host-a", "offline"], permissions: [] },
      { id: "other-c", token: "other-c", machines: ["host-a"], permissions: [] },
    ],
    machines: [
      { name: "host-a", url: addresses[0]!.base, token: "a" }, { name: "host-b", url: addresses[1]!.base, token: "b" },
      { name: "offline", url: "http://127.0.0.1:9", token: "off" },
    ],
    board: { dbPath: boardPath, retention: "3d" },
    ...{ crossOwnerSessionAccess: [{ owner: "owner-a", viewer: "viewer-b", sessions: [
      { machine: "host-a", session_id: "resident" }, { machine: "host-a", session_id: "selected" },
      { machine: "host-b", session_id: "resident" },
    ] }] },
  });
  const edge: Server = createEdgeServer(config, { board: { autoStart: false, now: () => NOW } });
  const { base } = await listenOnLoopback(edge);
  const snapshot = () => {
    const db = new DatabaseSync(accessPath);
    try {
      return JSON.stringify(["session_ownership", "provider_ownership", "history_ownership"].map(table =>
        db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all()));
    } finally { db.close(); }
  };
  const call = (token: string, path: string, init: RequestInit = {}) => fetch(base + path, { ...init,
    headers: { authorization: `Bearer ${token}`, "x-console-expected-principal": token, "content-type": "application/json", ...init.headers } });
  const listed = async (token: string) => {
    const res = await call(token, "/api/sessions");
    assert.equal(res.status, 200);
    return (await res.json() as { data: { sessions: { id: string; machine: string }[] } }).data.sessions.map(s => `${s.machine}/${s.id}`).sort();
  };
  return { call, listed, snapshot, calls, prompts, cleanup: async () => {
    await new Promise<void>(resolve => { edge.closeAllConnections(); edge.close(() => resolve()); });
    await Promise.all(daemons.map(d => new Promise<void>(resolve => { d.closeAllConnections(); d.close(() => resolve()); })));
    rmSync(dir, { recursive: true, force: true });
  } };
}

test("viewer sees the selected sessions and their dispatch descendants, and nothing else of the owner", async () => {
  const f = await fixture();
  try {
    // `stale` carries an outdated incarnation: only the owner may repair it.
    // The unreachable `offline` machine in the viewer's scope hides nothing.
    assert.deepEqual(await f.listed("viewer-b"), [
      "host-a/child", "host-a/grandchild", "host-a/launched", "host-a/own", "host-a/resident", "host-a/selected",
    ]);
    assert.ok((await f.listed("owner-a")).includes("host-a/unselected"));
    assert.ok((await f.listed("owner-a")).includes("host-a/resident"));
    assert.deepEqual(await f.listed("other-c"), ["host-a/foreign-child"]);
    // host-b is outside the viewer's machine scope even though its session is selected.
    const board = await (await f.call("viewer-b", "/api/board")).json() as { data: { board: { records: { session_id: string }[] } } };
    assert.deepEqual(board.data.board.records.map(r => r.session_id).sort(), ["child", "own", "resident"]);
  } finally { await f.cleanup(); }
});

test("viewer reads and messages selected sessions only, without changing or claiming ownership", async () => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    for (const id of ["resident", "child", "grandchild", "selected"]) {
      assert.equal((await f.call("viewer-b", `/api/sessions/host-a/${id}/glance`)).status, 200, id);
      assert.equal((await f.call("viewer-b", `/api/sessions/host-a/${id}/buffer`)).status, 200, id);
      const sent = await f.call("viewer-b", `/api/sessions/host-a/${id}/send`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
      assert.equal(sent.status, 200, id);
    }
    const intent = "3b9a6a3e-6a0a-4a2a-9d0b-6f9a2f6a6a01";
    const admitted = await f.call("viewer-b", `/api/sessions/host-a/resident/outbox/${intent}`, { method: "PUT",
      body: JSON.stringify({ text: "queued reply", expected_session_incarnation: "resident-inc" }) });
    assert.equal(admitted.status, 201);
    for (let n = 0; n < 200 && !f.prompts.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.prompts.length, 1, "the viewer's queued message reaches the owner's session");
    assert.equal(f.prompts[0]!.text, "queued reply");
    const snapshot = await f.call("viewer-b", "/api/sessions/host-a/resident/outbox?expected_session_incarnation=resident-inc");
    assert.equal(snapshot.status, 200);

    // Unselected, stale, other-owner, machine-scope and owner-only routes stay closed.
    for (const id of ["unselected", "unselected-child", "stale", "foreign-child"]) {
      for (const [method, suffix] of [["GET", "glance"], ["GET", "buffer"], ["POST", "send"], ["POST", "prompt"]] as const) {
        const res = await f.call("viewer-b", `/api/sessions/host-a/${id}/${suffix}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
        assert.equal(res.status, 404, `${id} ${suffix}`);
      }
      const put = await f.call("viewer-b", `/api/sessions/host-a/${id}/outbox/${intent}`, { method: "PUT",
        body: JSON.stringify({ text: "no", expected_session_incarnation: `${id}-inc` }) });
      assert.equal(put.status, 404, `${id} outbox`);
    }
    assert.equal((await f.call("viewer-b", "/api/sessions/host-b/resident/glance")).status, 404);
    for (const [method, path] of [
      ["POST", "attach-ticket"], ["POST", "resume"], ["POST", "archive"], ["DELETE", ""], ["PATCH", ""],
      ["POST", "retitle"], ["POST", "display-metadata"], ["PUT", "account"], ["PUT", "auto-resume"], ["POST", "attachments"],
    ] as const) {
      const res = await f.call("viewer-b", `/api/sessions/host-a/resident${path ? `/${path}` : ""}`, { method, body: "{}" });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    assert.equal(f.calls.some(call => /unselected|stale|foreign|attach|archive|retitle/.test(call)), false);
    assert.equal(f.snapshot(), before, "viewer reads and sends leave every ownership row unchanged");
  } finally { await f.cleanup(); }
});
