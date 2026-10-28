import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const schema = "cli.agent-session.resume-preflight.v1";
const providerId = "a18a563c-3913-4f21-a82a-7ca859b94a04";
const caller = { source_session_id: "caller", source_incarnation: "caller-inc" };
const session = { agent: "claude", resume: providerId, cwd: "/work/project", claude_account: "work", agent_args: ["--model", "opus"] };
const terminal = { session_created: false, safe_to_retry: false };
const refusal = { schema_version: schema, ok: false, error: { code: "resume-source-live", message: "a managed source conversation still has a live or busy writer", details: terminal } };

async function fixture(providerOwner: string | null = "owner") {
  const dir = mkdtempSync(join(tmpdir(), "resume-relay-"));
  const db = join(dir, "access.sqlite");
  const calls: { machine: string; path: string; body: any }[] = [];
  const state = { status: 200, body: { schema_version: schema, ok: true, data: { agent: "claude", provider_session_id: providerId, machine: "target", account: "work", history_scope: "shared" } } as any, raw: false };
  const daemons = await Promise.all(["source", "target", "forbidden"].map(async machine => {
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${machine}-operator`);
      if (req.method === "GET") {
        res.end(JSON.stringify({ ok: true, data: { sessions: machine === "source" ? [{ id: "caller", session_incarnation: "caller-inc", status: "running" }] : [] } }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ machine, path: req.url!, body });
      if (req.url === "/resume-preflight/v1" || state.status !== 200) {
        res.writeHead(state.status);
        res.end(state.raw ? "" : JSON.stringify(state.body));
        return;
      }
      const created = { id: body.id, agent: body.agent, session_incarnation: "created-inc", status: "running",
        provider_resume: { provider: "claude", session_id: providerId },
        claude_account: { schema_version: "agent-session.claude-account.v1", supported: true, state: "bound", selected_account: "work", revision: 1, applied_runtime_id: "created-inc" },
      };
      res.writeHead(201);
      res.end(JSON.stringify({ ok: true, data: { session: created } }));
    });
    return { name: machine, token: `${machine}-operator`, url: (await listenOnLoopback(server)).base, server };
  }));
  const access = new AccessStore(db);
  access.claimSession({ principalId: "owner", machine: "source", sessionId: "caller", incarnation: "caller-inc" });
  if (providerOwner) access.claimProvider(providerOwner, "target", "claude", providerId);
  access.close();
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, multiUser: true, accessDbPath: db,
    principals: [{ id: "owner", token: "browser-owner", machines: ["source", "target"], permissions: [] }],
    machines: daemons.map(({ server: _server, ...machine }) => machine),
    coordinationRelays: [{ machine: "source", token: "source-relay", ingress_token: "source-ingress" }],
  }));
  const { base } = await listenOnLoopback(edge);
  const post = async (path: string, body: unknown, token = "source-relay") => {
    const result = await fetch(`${base}/api/coordination/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() as any };
  };
  return { calls, state, db, post, cleanup: async () => {
    await Promise.all([edge, ...daemons.map(d => d.server)].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    rmSync(dir, { recursive: true, force: true });
  } };
}

test("resume preflight relays only the check to the selected daemon without changing ownership", async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.db);
    for (const scope of [undefined, "account", "shared"]) {
      f.state.body.data.history_scope = scope;
      const result = await f.post("resume-preflight/v1", { ...caller, machine: "target", session });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, JSON.parse(JSON.stringify(f.state.body)));
      assert.deepEqual(f.calls.at(-1), { machine: "target", path: "/resume-preflight/v1", body: session });
    }
    assert.equal(f.calls.length, 3);
    assert.deepEqual(readFileSync(f.db), before);
  } finally { await f.cleanup(); }
});

test("resume preflight returns typed terminal refusal and rejects older or malformed targets without fallback", async () => {
  const f = await fixture();
  try {
    f.state.status = 409; f.state.body = refusal;
    const denied = await f.post("resume-preflight/v1", { ...caller, machine: "target", session });
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.body, refusal);
    f.state.status = 422;
    f.state.body = { ...refusal, error: { ...refusal.error, code: "resume-account-transition-pending", message: "untrusted target diagnostic" } };
    const pending = await f.post("resume-preflight/v1", { ...caller, machine: "target", session });
    assert.equal(pending.body.error.code, "resume-account-transition-pending");
    assert.deepEqual(pending.body.error.details, terminal);
    assert.doesNotMatch(JSON.stringify(pending.body), /untrusted target diagnostic/);
    for (const [status, body, raw] of [[404, null, true], [405, { ok: false }, false], [200, { ok: true }, false]] as const) {
      f.state.status = status; f.state.body = body; f.state.raw = raw;
      const result = await f.post("resume-preflight/v1", { ...caller, machine: "target", session });
      assert.equal(result.body.schema_version, schema);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.error.code, "resume-unsupported");
      assert.deepEqual(result.body.error.details, terminal);
    }
    f.state.status = 200; f.state.raw = false;
    const data = { agent: "claude", provider_session_id: providerId, machine: "target", account: "work" };
    for (const patch of [{ agent: "codex" }, { provider_session_id: "other" }, { machine: "source" }, { account: "other" }, { account: "" }, { history_scope: "unknown" }]) {
      f.state.body = { schema_version: schema, ok: true, data: { ...data, ...patch } };
      const result = await f.post("resume-preflight/v1", { ...caller, machine: "target", session });
      assert.equal(result.body.error.code, "resume-unsupported");
    }
    assert.equal(f.calls.length, 11);
    assert.ok(f.calls.every(call => call.path === "/resume-preflight/v1"));
  } finally { await f.cleanup(); }
});

test("resume preflight refuses unauthenticated, unowned, stale, forbidden and create-bearing checks before target I/O", async () => {
  const f = await fixture();
  try {
    for (const [body, token, status] of [
      [{ ...caller, machine: "target", session }, "browser-owner", 401],
      [{ ...caller, source_session_id: "unknown", machine: "target", session }, "source-relay", 403],
      [{ ...caller, source_incarnation: "stale", machine: "target", session }, "source-relay", 409],
      [{ ...caller, machine: "forbidden", session }, "source-relay", 403],
      [{ ...caller, machine: "target", session: { ...session, prompt: "never read a prompt" } }, "source-relay", 400],
      [{ ...caller, machine: "target", session: { ...session, resume: "" } }, "source-relay", 400],
    ] as const) {
      const result = await f.post("resume-preflight/v1", body, token);
      assert.equal(result.status, status);
      assert.equal(result.body.schema_version, schema);
      assert.deepEqual(result.body.error.details, terminal);
    }
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test("owned resume creates use the dedicated target route and preserve ordinary launch context", async () => {
  const f = await fixture();
  try {
    const lineage = { schema_version: "agent-session.session-lineage.v1", parent: null, root: null, depth: 0, starter: { kind: "operator", via: "console" } };
    const context = { ...session, workspace: "project.alpha", origin: { parent: { machine: "source", session_id: "caller" } }, lineage, role: "reviewer", title_mode: "pinned", title: "Resumed task", prompt: "Recall the synthetic fact", work: { program: null, issues: [], inherited: true } };
    const result = await f.post("sessions/v1", { ...caller, machine: "target", session: context });
    assert.equal(f.calls[0]?.path, "/sessions/resume/v1");
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(f.calls.length, 1);
    const call = f.calls[0]!;
    assert.equal(call.path, "/sessions/resume/v1");
    const { id, ...forwarded } = call.body;
    assert.deepEqual(forwarded, context);
    const access = new AccessStore(f.db);
    try { assert.equal(access.sessionGrant("target", id)?.principalId, "owner"); }
    finally { access.close(); }
  } finally { await f.cleanup(); }
});

test("resume create preserves terminal admission refusals and never falls back to legacy create", async () => {
  const f = await fixture();
  try {
    for (const [status, body, raw] of [[409, refusal, false], [422, { ...refusal, error: { ...refusal.error, code: "resume-account-transition-pending" } }, false], [404, null, true], [405, null, true]] as const) {
      f.state.status = status; f.state.body = body; f.state.raw = raw;
      const result = await f.post("sessions/v1", { ...caller, machine: "target", session });
      assert.equal(result.body.ok, false);
      assert.equal(result.body.error.code, status === 409 ? "resume-source-live" : status === 422 ? "resume-account-transition-pending" : "resume-unsupported");
      assert.deepEqual(result.body.error.details, terminal);
    }
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.every(call => call.path === "/sessions/resume/v1"));
  } finally { await f.cleanup(); }
});

test("resume checks and creates preserve provider ownership before target I/O", async () => {
  for (const providerOwner of ["other-owner", null]) {
    const f = await fixture(providerOwner);
    try {
      for (const route of ["resume-preflight/v1", "sessions/v1"]) {
        const result = await f.post(route, { ...caller, machine: "target", session });
        assert.equal(result.status, 404);
      }
      assert.deepEqual(f.calls, []);
    } finally { await f.cleanup(); }
  }
});
