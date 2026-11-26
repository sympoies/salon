import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const incarnation = "e6153b07-f8c8-462c-92c2-2711683923c2";
const stale = "a5158fa3-8a3d-4fc4-aaad-e01548905353";
const sessionId = "0194f350-aa43-7dbd-831e-ac16766f74c2";
const media = "application/vnd.agent-session.console-attested-create.v1";
function operation(): string {
  const time = Date.now().toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-${Math.random().toString(16).slice(2).padEnd(12, "0").slice(0, 12)}`;
}
const input = { source_session_id: "caller", source_incarnation: incarnation, machine: "target", attest_role: true, no_parent: true, session: { id: sessionId, agent: "codex", cwd: "/workspace" } };
const context = { initiator: "console-relay", role: "steward", attested_role: "steward" };

type Mode = "normal" | "drop" | "wrong-id" | "wrong-role" | "wrong-context" | "strip-binding" | "rewrite-type" | "strip-all" | "unsupported" | "oversized" | "redirect";
async function fixture(t: TestContext, enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "attested-relay-"));
  const db = join(dir, "access.sqlite");
  const store = new AccessStore(db);
  store.claimSession({ principalId: "owner", machine: "source", sessionId: "caller", incarnation });
  store.claimSession({ principalId: "owner", machine: "source", sessionId: "ungranted", incarnation });
  store.close();
  const grants = [{ machine: "source", session_id: "caller", role: "steward" as const }];
  const credentials: Record<string, string> = { target: "target-attested", alternative: "alternative-attested" };
  let sourceIncarnation = incarnation;
  const source = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, data: { sessions: [
    { id: "caller", session_incarnation: sourceIncarnation, status: "running" },
    { id: "ungranted", session_incarnation: incarnation, status: "running", role: "steward" },
  ] } })));
  const sourceUrl = (await listenOnLoopback(source)).base;
  function destination(name: string) {
    const seen: { body: string; headers: Record<string, unknown>; raw: string[] }[] = [];
    const records: Record<string, unknown>[] = [];
    let mode: Mode = "normal";
    let configured = true;
    let holdRead: Promise<void> | undefined;
    let notifyRead: (() => void) | undefined;
    const server = createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/sessions") {
        notifyRead?.(); if (holdRead) await holdRead;
        return void res.end(JSON.stringify({ ok: true, data: { sessions: records } }));
      }
      if (req.method !== "POST" || req.url !== "/sessions") return void res.writeHead(404).end();
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ body, headers: { ...req.headers }, raw: req.rawHeaders });
      const reject = (status: number, code: string) => res.writeHead(status).end(JSON.stringify({ ok: false, error: { code } }));
      const count = (name: string) => req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
      if (req.headers.authorization !== "Bearer target-machine" || count("authorization") !== 1) return void reject(401, "unauthorized");
      if (mode === "strip-all") {
        assert.equal(req.headers["x-agent-session-attested-create-token"], undefined);
        assert.equal(req.headers["x-agent-session-console-create-binding"], undefined);
        return void res.writeHead(201).end(JSON.stringify({ ok: true, data: { session: { id: JSON.parse(body).id } } }));
      }
      if (!configured) return void reject(503, "token-not-configured");
      if (req.headers["x-agent-session-attested-create-token"] !== `${name}-attested` || count("x-agent-session-attested-create-token") !== 1) return void reject(401, "unauthorized");
      if (req.headers["content-type"] !== media || mode === "unsupported") return void reject(415, "unsupported-media-type");
      let binding: Record<string, unknown>;
      try {
        const encoded = req.headers["x-agent-session-console-create-binding"];
        if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(encoded) || count("x-agent-session-console-create-binding") !== 1) throw new Error();
        binding = JSON.parse(Buffer.from(encoded, "base64url").toString());
        assert.deepEqual(Object.keys(binding).sort(), ["schema_version", "scope", "origin_machine", "caller_session_id", "caller_session_incarnation", "destination_machine", "attested_role", "body_sha256"].sort());
        assert.equal(binding.schema_version, "agent-session.console-create-binding.v1"); assert.equal(binding.scope, "create");
        assert.equal(binding.origin_machine, "source"); assert.equal(binding.caller_session_id, "caller");
        assert.equal(binding.caller_session_incarnation, incarnation); assert.equal(binding.destination_machine, name);
        assert.equal(binding.body_sha256, createHash("sha256").update(body).digest("hex"));
      } catch { return void reject(403, "console-create-binding-mismatch"); }
      if (binding.attested_role !== "steward") return void reject(403, "console-create-role-forbidden");
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(body);
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !value.id
          || ["attest_role", "no_parent", "lineage", "role"].some(key => Object.hasOwn(value, key))) throw new Error();
      } catch { return void reject(400, "console-create-invalid-body"); }
      const result = { id: mode === "wrong-id" ? "other" : value.id, agent: value.agent, status: "running", session_incarnation: stale,
        role: mode === "wrong-role" ? "other" : "steward", lineage: { forge_context: mode === "wrong-context" ? { ...context, initiator: "other" } : context } };
      records.push(result);
      if (mode === "drop") return void req.socket.destroy();
      res.writeHead(201).end(JSON.stringify({ ok: true, data: { session: result } }));
    });
    let upstream = "";
    const proxy = createServer((req, res) => {
      const headers = { ...req.headers };
      if (req.method === "POST" && mode === "redirect") return void res.writeHead(307, { location: "/sessions" }).end();
      if (req.method === "POST" && mode === "oversized") { res.writeHead(200); for (let i = 0; i < 20; i++) res.write("x".repeat(65536)); return void res.end(); }
      if (req.method === "POST") {
        if (mode === "strip-binding" || mode === "strip-all") delete headers["x-agent-session-console-create-binding"];
        if (mode === "rewrite-type" || mode === "strip-all") headers["content-type"] = "application/json";
        if (mode === "strip-all") delete headers["x-agent-session-attested-create-token"];
      }
      const outgoing = httpRequest(`${upstream}${req.url}`, { method: req.method, headers }, incoming => {
        res.writeHead(incoming.statusCode ?? 500, incoming.headers); incoming.pipe(res);
      });
      outgoing.on("error", () => res.destroy()); req.pipe(outgoing);
    });
    return { server, proxy, seen, records, set mode(value: Mode) { mode = value; }, set upstream(value: string) { upstream = value; }, get upstream() { return upstream; }, set configured(value: boolean) { configured = value; },
      hold(promise: Promise<void>, notify: () => void) { holdRead = promise; notifyRead = notify; } };
  }
  const target = destination("target"), alternative = destination("alternative");
  const [targetUpstream, alternativeUpstream] = await Promise.all([listenOnLoopback(target.server), listenOnLoopback(alternative.server)]);
  target.upstream = targetUpstream.base; alternative.upstream = alternativeUpstream.base;
  const [targetUrl, alternativeUrl] = await Promise.all([listenOnLoopback(target.proxy), listenOnLoopback(alternative.proxy)]);
  const config = makeEdgeConfig({ openAccess: false, multiUser: true, accessDbPath: db,
    attestedCreateEnabled: enabled, attestedCreateGrants: grants, attestedCreateCredentials: credentials,
    principals: [{ id: "owner", token: "browser-token", machines: ["source", "target", "alternative"], permissions: [] }],
    machines: [{ name: "source", url: sourceUrl, token: "source-machine" }, { name: "target", url: targetUrl.base, token: "target-machine" }, { name: "alternative", url: alternativeUrl.base, token: "target-machine" }, { name: "forbidden", url: targetUrl.base, token: "target-machine" }],
    coordinationRelays: [{ machine: "source", token: "relay-token", ingress_token: "ingress-token" }],
  });
  let edge = createEdgeServer(config);
  let base = (await listenOnLoopback(edge)).base;
  async function restart() { await new Promise<void>(resolve => { edge.closeAllConnections(); edge.close(() => resolve()); }); edge = createEdgeServer(config); base = (await listenOnLoopback(edge)).base; }
  t.after(async () => { await Promise.all([edge, source, target.server, alternative.server, target.proxy, alternative.proxy].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); rmSync(dir, { recursive: true, force: true }); });
  async function post(value: unknown = input, op = operation(), headers: Record<string, string> = {}) {
    const response = await fetch(`${base}/api/coordination/sessions/v1`, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json", "x-agent-session-operation-id": op, ...headers }, body: typeof value === "string" ? value : JSON.stringify(value) });
    return { status: response.status, body: await response.json() as any };
  }
  return { post, grants, credentials, target, alternative, restart, setIncarnation(value: string) { sourceIncarnation = value; }, get base() { return base; }, db };
}

test("grant admits a verified root and revocation is checked before receipt replay", async t => {
  const f = await fixture(t); const op = operation();
  const first = await f.post(input, op); assert.equal(first.status, 201); assert.equal(first.body.data.session.id, sessionId);
  assert.equal(f.target.seen.length, 1);
  f.grants.length = 0;
  assert.equal((await f.post(input, op)).body.error.code, "console-create-attestation-forbidden");
  assert.equal(f.target.seen.length, 1);
});

test("stale and unknown incarnations, ungranted stewards and forbidden destinations are refused", async t => {
  const f = await fixture(t);
  for (const request of [{ ...input, source_incarnation: stale }, { ...input, source_session_id: "ungranted" }, { ...input, source_session_id: "missing" }, { ...input, machine: "forbidden" }]) {
    assert.equal((await f.post(request)).body.error.code, "console-create-attestation-forbidden");
  }
  f.setIncarnation(stale);
  assert.equal((await f.post()).body.error.code, "console-create-attestation-forbidden");
  assert.equal(f.target.seen.length, 0);
});

test("invalid intent, identity and lineage are rejected without dispatch", async t => {
  const f = await fixture(t);
  const invalid: [unknown, string][] = [
    [{ ...input, Attest_role: true }, "console-create-invalid-body"],
    [{ ...input, attest_role: "true" }, "console-create-invalid-body"],
    [{ ...input, session: { ...input.session, attest_role: true } }, "console-create-invalid-body"],
    [{ ...input, session: { ...input.session, id: undefined } }, "console-create-invalid-body"],
    [JSON.stringify(input).replace('"attest_role":true', '"attest_role":true,"attest_role":true'), "console-create-invalid-body"],
    [{ ...input, session: { ...input.session, role: null } }, "identity_session_binding_untrusted"],
    [{ ...input, session: { ...input.session, forge_context: null } }, "identity_session_binding_untrusted"],
    [{ ...input, no_parent: false }, "role-requires-root"],
    [{ ...input, session: { ...input.session, lineage: { parent: {} } } }, "role-requires-root"],
    [{ ...input, session: { ...input.session, resume: "existing" } }, "resume-unsupported"],
  ];
  for (const [body, code] of invalid) assert.equal((await f.post(body)).body.error.code, code, JSON.stringify(body));
  for (const header of ["x-agent-session-attested-create-token", "x-agent-session-console-create-binding"]) assert.equal((await f.post(input, operation(), { [header]: "forged" })).body.error.code, "identity_session_binding_untrusted");
  assert.equal(f.target.seen.length, 0);
});

test("unverified replies and stripped or rewritten markers never confirm ownership", async t => {
  for (const mode of ["wrong-id", "wrong-role", "wrong-context", "strip-binding", "rewrite-type", "strip-all", "unsupported"] as const) {
    const f = await fixture(t); f.target.mode = mode;
    const result = await f.post();
    assert.notEqual(result.status, 201, mode);
    if (mode !== "strip-binding") assert.equal(result.body.error.code, "console-create-attestation-unavailable", mode);
    const store = new AccessStore(f.db); assert.equal(store.sessionGrant("target", sessionId), undefined, mode); store.close();
  }
});

test("dropped reply and restart reconcile exact retries without a second create", async t => {
  const f = await fixture(t); f.target.mode = "drop"; const op = operation();
  assert.equal((await f.post(input, op)).body.error.code, "console-create-attestation-unavailable");
  await f.restart();
  await f.post(input, op);
  assert.equal(f.target.seen.length, 1);
  const changed = await f.post({ ...input, session: { ...input.session, title: "changed" } }, op);
  assert.equal(changed.status, 409);
  await f.post(input, operation());
  assert.equal(f.target.seen.length, 1);
});

test("credentials are scoped to destinations and disabled configuration never dispatches", async t => {
  const f = await fixture(t); f.credentials.alternative = f.credentials.target;
  const result = await f.post({ ...input, machine: "alternative" });
  assert.equal(result.body.error.code, "console-create-attestation-unavailable");
  assert.equal(f.alternative.seen.length, 0);
  const disabled = await fixture(t, false);
  assert.notEqual((await disabled.post()).status, 201);
  assert.equal(disabled.target.seen.length, 0);
});


test("expired receipts and destination fences survive receipt expiry", async t => {
  const f = await fixture(t); const op = operation(); assert.equal((await f.post(input, op)).status, 201);
  const db = new DatabaseSync(f.db); db.prepare("UPDATE attested_create_fence SET created_epoch = 1").run(); db.close();
  assert.equal((await f.post(input, op)).body.error.code, "console-start-operation-expired");
  assert.equal((await f.post(input, operation())).body.error.code, "console-create-attestation-unavailable");
  assert.equal(f.target.seen.length, 1);
});

test("oversized responses and redirects cannot confirm a create", async t => {
  for (const mode of ["oversized", "redirect"] as const) {
    const f = await fixture(t); f.target.mode = mode;
    assert.equal((await f.post()).body.error.code, "console-create-attestation-unavailable");
    assert.equal(f.target.seen.length, 0);
    const store = new AccessStore(f.db); assert.equal(store.sessionGrant("target", sessionId), undefined); store.close();
  }
});


test("an incarnation changed during account discovery cannot dispatch", async t => {
  const f = await fixture(t);
  let release!: () => void; let observed!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const read = new Promise<void>(resolve => { observed = resolve; });
  f.target.hold(held, observed);
  const pending = f.post({ ...input, session: { ...input.session, account: "example" } });
  await read; f.setIncarnation(stale); release();
  assert.equal((await pending).body.error.code, "console-create-attestation-forbidden");
  assert.equal(f.target.seen.length, 0);
});


test("destination fixture enforces attested admission in order", async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ id: sessionId, agent: "codex" });
  const binding = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ schema_version: "agent-session.console-create-binding.v1", scope: "create", origin_machine: "source", caller_session_id: "caller", caller_session_incarnation: incarnation, destination_machine: "target", attested_role: "steward", body_sha256: createHash("sha256").update(body).digest("hex"), ...overrides })).toString("base64url");
  const headers: Record<string, string> = { authorization: "Bearer target-machine", "content-type": media, "x-agent-session-attested-create-token": "target-attested", "x-agent-session-console-create-binding": binding() };
  async function send(changes: Record<string, string>, payload = body) { const response = await fetch(`${f.target.upstream}/sessions`, { method: "POST", headers: { ...headers, ...changes }, body: payload }); return { status: response.status, body: await response.json() as any }; }
  f.target.configured = false;
  assert.equal((await send({ authorization: "Bearer invalid" })).status, 401);
  assert.equal((await send({})).body.error.code, "token-not-configured");
  f.target.configured = true;
  assert.equal((await send({ "x-agent-session-attested-create-token": "invalid", "content-type": "application/json" })).status, 401);
  assert.equal((await send({ "content-type": `${media}; charset=utf-8`, "x-agent-session-console-create-binding": "invalid" })).status, 415);
  assert.equal((await send({ "x-agent-session-console-create-binding": "invalid" })).body.error.code, "console-create-binding-mismatch");
  assert.equal((await send({ "x-agent-session-console-create-binding": binding({ attested_role: "other" }) })).body.error.code, "console-create-role-forbidden");
  const invalid = "{}";
  assert.equal((await send({ "x-agent-session-console-create-binding": binding({ body_sha256: createHash("sha256").update(invalid).digest("hex") }) }, invalid)).body.error.code, "console-create-invalid-body");
  assert.equal(f.target.records.length, 0);
});
