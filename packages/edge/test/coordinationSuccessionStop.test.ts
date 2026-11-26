import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { OutboxStore } from "../src/outboxStore.ts";
import { loadConfig } from "../src/config.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const MEDIA = "application/vnd.agent-session.console-succession-stop.v1";
const STOP_SCHEMA = "agent-session.console-succession-stop.v1";
const GRANT_SCHEMA = "agent-session.console-succession-stop-delegation.v1";
const CALLER_INC = "e6153b07-f8c8-462c-92c2-2711683923c2";
const PRED_INC = "a5158fa3-8a3d-4fc4-aaad-e01548905353";
const OTHER_INC = "5d2f0c6a-3c7e-4d34-9f5e-1d6a1b9f3a10";
const caller = { machine: "source", session_id: "successor", session_incarnation: CALLER_INC };
const predecessor = { machine: "dest", session_id: "predecessor", session_incarnation: PRED_INC };
const STOP_PATH = "/api/coordination/sessions/dest/predecessor/stop/v1";
const GRANT_PATH = "/api/coordination/succession-stop-delegations/v1";

function operation(): string {
  const time = Date.now().toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-${Math.random().toString(16).slice(2).padEnd(12, "0").slice(0, 12)}`;
}
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const callerHeader = (inc = CALLER_INC) => b64({ session_id: "successor", session_incarnation: inc });

type PostMode = "normal" | "lost" | "drop" | "already" | "mailbox" | "unavailable" | "wrong-operation" | "wrong-predecessor" | "wrong-caller" | "wrong-deadline"
  | "stopped-without-result" | "extra-member" | "not-json" | "wrong-type" | "redirect" | "oversized" | "unsupported" | "pending" | "unknown-code" | "typed-unknown";
interface Native { state: string; stop_result: string | null; code: string | null; binding: Record<string, unknown> }

async function fixture(t: TestContext, options: { enabled?: boolean; reconcileMs?: number; destinations?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "succession-stop-"));
  const db = join(dir, "access.sqlite");
  const access = new AccessStore(db);
  access.claimSession({ principalId: "owner", ...sid(caller) });
  access.claimSession({ principalId: "owner", ...sid(predecessor) });
  access.claimSession({ principalId: "other", machine: "dest", sessionId: "foreign", incarnation: PRED_INC });
  access.claimSession({ principalId: "other", machine: "source", sessionId: "foreign-caller", incarnation: CALLER_INC });
  access.close();
  function sid(identity: typeof caller) { return { machine: identity.machine, sessionId: identity.session_id, incarnation: identity.session_incarnation }; }

  const native = new Map<string, Native>();
  const seen = { posts: [] as { body: string; headers: Record<string, unknown> }[], gets: [] as { scope: string; url: string; headers: Record<string, unknown> }[], effects: 0 };
  let mode: PostMode = "normal";
  let supported = true;
  const projection = (op: string, entry: Native, overrides: Record<string, unknown> = {}) => ({
    operation_id: op, caller: { machine: entry.binding.caller_machine, session_id: entry.binding.caller_session_id, session_incarnation: entry.binding.caller_session_incarnation },
    predecessor: { machine: entry.binding.machine, session_id: entry.binding.session_id, session_incarnation: entry.binding.session_incarnation },
    state: entry.state, stop_result: entry.stop_result, code: entry.code, retry_until_epoch: Number(entry.binding.retry_until_epoch), ...overrides });
  const destination = createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = MEDIA) => void res.writeHead(status, { "content-type": type }).end(typeof body === "string" ? body : JSON.stringify(body));
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const count = (name: string) => req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
    const error = (status: number, code: string) => send(status, { schema_version: STOP_SCHEMA, ok: false, error: { code } });
    if (!supported) return void error(404, "route-not-found");
    if (req.headers.authorization !== "Bearer dest-machine" || count("authorization") !== 1
      || req.headers["x-agent-session-relay-token"] !== "ingress-dest" || count("x-agent-session-relay-token") !== 1) return void error(401, "unauthorized");
    let binding: Record<string, unknown>;
    try {
      assert.equal(count("x-agent-session-succession-stop-binding"), 1);
      const encoded = req.headers["x-agent-session-succession-stop-binding"] as string;
      assert.match(encoded, /^[A-Za-z0-9_-]{1,2730}$/);
      binding = JSON.parse(Buffer.from(encoded, "base64url").toString());
      assert.deepEqual(Object.keys(binding).sort(), ["schema_version", "scope", "delegation_id", "owner", "caller_machine", "caller_session_id", "caller_session_incarnation",
        "machine", "session_id", "session_incarnation", "operation_id", "retry_until_epoch", "body_sha256"].sort());
      assert.equal(binding.schema_version, "agent-session.console-succession-stop-binding.v1");
      assert.equal(binding.body_sha256, createHash("sha256").update(raw).digest("hex"));
      assert.equal(typeof binding.retry_until_epoch, "string");
    } catch { return void error(403, "succession-stop-delegation-mismatch"); }
    const url = new URL(req.url ?? "/", "http://destination");
    const match = /^\/sessions\/predecessor\/succession-stop\/v1(?:\/([0-9a-f-]+))?$/.exec(url.pathname);
    if (!match) return void error(404, "route-not-found");
    if (req.method === "POST" && !match[1]) {
      seen.posts.push({ body: raw.toString("utf8"), headers: { ...req.headers } });
      if (mode === "unsupported" || req.headers["content-type"] !== MEDIA) return void error(415, "unsupported-media-type");
      assert.equal(binding.scope, "stop");
      const op = JSON.parse(raw.toString("utf8")).operation_id as string;
      if (mode === "lost") { mode = "normal"; return void req.socket.destroy(); }
      const existing = native.get(op);
      if (existing) return void send(200, { schema_version: STOP_SCHEMA, ok: true, data: projection(op, existing) });
      if (mode === "mailbox") return void error(409, "session-mailbox-not-empty");
      if (mode === "unavailable") return void error(503, "session-mailbox-unknown");
      if (mode === "unknown-code") return void error(409, "something-else");
      if (mode === "typed-unknown") return void error(503, "session-stop-outcome-unknown");
      if (mode === "redirect") return void res.writeHead(307, { location: "/elsewhere" }).end();
      const already = mode === "already";
      const entry: Native = { state: mode === "pending" ? "pending" : "stopped", stop_result: mode === "pending" ? null : already ? "already_stopped" : "exited", code: null, binding };
      native.set(op, entry); if (!already && mode !== "pending") seen.effects++;
      if (mode === "drop") return void req.socket.destroy();
      if (already) return void send(409, { schema_version: STOP_SCHEMA, ok: false, error: { code: "session-already-stopped", details: { receipt: projection(op, entry) } } });
      const data = projection(op, entry, mode === "wrong-operation" ? { operation_id: operation() } : mode === "wrong-predecessor" ? { predecessor: { ...predecessor, session_incarnation: OTHER_INC } }
        : mode === "wrong-caller" ? { caller: { ...caller, session_id: "someone" } } : mode === "wrong-deadline" ? { retry_until_epoch: Number(binding.retry_until_epoch) + 1 }
        : mode === "stopped-without-result" ? { stop_result: null } : mode === "extra-member" ? { extra: true } : {});
      if (mode === "not-json") return void send(200, "<html>ok</html>");
      if (mode === "wrong-type") return void send(200, { schema_version: STOP_SCHEMA, ok: true, data }, "application/json");
      if (mode === "oversized") { res.writeHead(200, { "content-type": MEDIA }); res.write(JSON.stringify({ schema_version: STOP_SCHEMA, ok: true, data })); for (let i = 0; i < 20; i++) res.write(" ".repeat(65536)); return void res.end(); }
      return void send(200, { schema_version: STOP_SCHEMA, ok: true, data });
    }
    if (req.method === "GET" && match[1]) {
      seen.gets.push({ scope: String(binding.scope), url: req.url ?? "", headers: { ...req.headers } });
      assert.equal(raw.length, 0);
      const entry = native.get(match[1]);
      if (!entry) return void error(404, "stop-operation-not-found");
      return void send(200, { schema_version: STOP_SCHEMA, ok: true, data: projection(match[1], entry) });
    }
    return void error(404, "route-not-found");
  });
  const destinationBase = (await listenOnLoopback(destination)).base;
  const config = makeEdgeConfig({ openAccess: false, multiUser: true, accessDbPath: db,
    successionStopEnabled: options.enabled ?? true, successionStopDestinations: options.destinations ?? ["dest"], successionStopIssuerToken: "issuer-token",
    principals: [{ id: "owner", token: "owner-token", machines: ["source", "dest"], permissions: [] }, { id: "other", token: "other-token", machines: ["source", "dest"], permissions: [] }],
    machines: [{ name: "source", url: "http://127.0.0.1:9", token: "source-machine" }, { name: "dest", url: destinationBase, token: "dest-machine" }],
    coordinationRelays: [{ machine: "source", token: "relay-token", ingress_token: "ingress-source" }, { machine: "dest", token: "relay-dest", ingress_token: "ingress-dest" }] });
  let edge = createEdgeServer(config, { successionStopReconcileIntervalMs: options.reconcileMs ?? 3_600_000 });
  let base = (await listenOnLoopback(edge)).base;
  async function restart() {
    await new Promise<void>(resolve => { edge.closeAllConnections(); edge.close(() => resolve()); });
    edge = createEdgeServer(config, { successionStopReconcileIntervalMs: options.reconcileMs ?? 3_600_000 }); base = (await listenOnLoopback(edge)).base;
  }
  t.after(async () => { await Promise.all([edge, destination].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); rmSync(dir, { recursive: true, force: true }); });
  const read = async (response: Response) => ({ status: response.status, type: response.headers.get("content-type"), cache: response.headers.get("cache-control"), body: await response.json() as any });
  const grantBody = (over: Record<string, unknown> = {}) => ({ schema_version: GRANT_SCHEMA, delegation_id: randomUUID(), operation_id: operation(), caller, predecessor, ...over });
  const issue = async (body: unknown = grantBody(), headers: Record<string, string> = {}, token = "issuer-token") => read(await fetch(`${base}${GRANT_PATH}`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": MEDIA, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const revoke = async (id: string, token = "issuer-token", suffix = "") => read(await fetch(`${base}${GRANT_PATH}/${id}${suffix}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }));
  const stopBody = (op: string, inc = PRED_INC) => ({ schema_version: STOP_SCHEMA, operation_id: op, expected_session_incarnation: inc });
  const stop = async (op: string, o: { body?: unknown; headers?: Record<string, string>; path?: string; token?: string } = {}) => read(await fetch(`${base}${o.path ?? STOP_PATH}`, { method: "POST",
    headers: { authorization: `Bearer ${o.token ?? "relay-token"}`, "content-type": MEDIA, "x-agent-session-succession-caller": callerHeader(), ...o.headers },
    body: typeof o.body === "string" ? o.body : JSON.stringify(o.body ?? stopBody(op)) }));
  const receipt = async (op: string, o: { inc?: string; headers?: Record<string, string>; query?: string } = {}) => read(await fetch(`${base}${STOP_PATH}/${op}?${o.query ?? `expected_session_incarnation=${o.inc ?? PRED_INC}`}`,
    { headers: { authorization: "Bearer relay-token", "x-agent-session-succession-caller": callerHeader(), ...o.headers } }));
  const granted = async () => { const body = grantBody(); const result = await issue(body); assert.equal(result.status, 200, JSON.stringify(result.body)); return body; };
  const sql = (fn: (db: DatabaseSync) => void) => { const handle = new DatabaseSync(db); try { fn(handle); } finally { handle.close(); } };
  return { issue, revoke, stop, receipt, grantBody, granted, sql, restart, seen, native, db, config, set mode(value: PostMode) { mode = value; }, set supported(value: boolean) { supported = value; },
    get base() { return base; }, destinationBase };
}

test("grant routes refuse every caller but the configured service before parsing", async t => {
  const f = await fixture(t);
  for (const token of ["relay-token", "dest-machine", "owner-token", "wrong", ""]) {
    assert.equal((await f.issue("{not json", { "content-type": "text/plain" }, token)).status, 401, token);
    assert.equal((await f.revoke("not-a-uuid", token)).status, 401, token);
  }
  assert.equal((await f.issue("{not json", {}, "")).body.error.code, "unauthorized");
  const response = await fetch(`${f.base}${GRANT_PATH}`, { method: "POST", body: "{}" });
  assert.equal(response.status, 401);
  assert.equal((await f.issue(f.grantBody(), { authorization: "Bearer issuer-token, Bearer other" })).status, 401);
});

test("issue records the exact grant, derives the owner and replays an exact repeat", async t => {
  const f = await fixture(t);
  const body = f.grantBody();
  const first = await f.issue(body);
  assert.equal(first.status, 200);
  assert.equal(first.type, MEDIA); assert.equal(first.cache, "no-store");
  assert.deepEqual(Object.keys(first.body).sort(), ["data", "ok", "schema_version"]);
  assert.equal(first.body.schema_version, GRANT_SCHEMA); assert.equal(first.body.ok, true);
  const data = first.body.data;
  const { schema_version: _schema, ...members } = body;
  assert.deepEqual(data, { ...members, scope: "succession_stop", owner: "owner", state: "active", issued_at_epoch: data.issued_at_epoch,
    retry_until_epoch: data.issued_at_epoch + 86_400, revoked_at_epoch: null });
  assert.ok(Math.abs(data.issued_at_epoch - Date.now() / 1000) < 10);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const repeat = await f.issue({ ...body, caller: { session_incarnation: CALLER_INC, machine: "source", session_id: "successor" } });
  assert.deepEqual(repeat.body, first.body);
});

test("issue rejects wrong media, malformed shape and non-canonical values", async t => {
  const f = await fixture(t);
  const body = f.grantBody(); const text = JSON.stringify(body);
  assert.equal((await f.issue(body, { "content-type": `${MEDIA}; charset=utf-8` })).status, 415);
  assert.equal((await f.issue(body, { "content-type": "application/json" })).body.error.code, "unsupported-media-type");
  const duplicated = await new Promise<number>(resolve => { const req = httpRequest(`${f.base}${GRANT_PATH}`, { method: "POST",
    headers: { authorization: "Bearer issuer-token", "content-type": [MEDIA, MEDIA] } }, res => { res.resume(); resolve(res.statusCode ?? 0); }); req.end(text); });
  assert.equal(duplicated, 415);
  const invalid: unknown[] = [text.replace('"caller"', '"caller":{},"caller"'), { ...body, extra: 1 }, { ...body, schema_version: "x" }, { ...body, owner: "owner" },
    { ...body, delegation_id: "00000000-0000-0000-0000-000000000000" }, { ...body, delegation_id: randomUUID().toUpperCase() }, { ...body, operation_id: randomUUID() },
    { ...body, caller: null }, { ...body, caller: { ...caller, extra: 1 } }, { ...body, predecessor: { ...predecessor, session_incarnation: null } },
    { ...body, predecessor: caller }, "[]"];
  for (const value of invalid) { const result = await f.issue(value); assert.equal(result.status, 400, JSON.stringify(value)); assert.equal(result.body.error.code, "invalid-request"); }
});

test("issue refuses other owners, unknown identities and unavailable registries", async t => {
  const f = await fixture(t);
  const refused = async (over: Record<string, unknown>, code: string, status = 403) => { const result = await f.issue(f.grantBody(over)); assert.deepEqual([result.status, result.body.error.code], [status, code], JSON.stringify(over)); };
  await refused({ predecessor: { ...predecessor, session_id: "foreign" } }, "succession-stop-owner-mismatch");
  await refused({ caller: { ...caller, session_id: "foreign-caller" } }, "succession-stop-owner-mismatch");
  await refused({ predecessor: { ...predecessor, session_id: "ghost" } }, "succession-stop-delegation-mismatch");
  await refused({ caller: { ...caller, session_incarnation: OTHER_INC } }, "succession-stop-delegation-mismatch");
  await refused({ predecessor: { ...predecessor, session_incarnation: OTHER_INC } }, "succession-stop-delegation-mismatch");
  await refused({ predecessor: { ...predecessor, machine: "unconfigured" } }, "succession-stop-delegation-mismatch");
  await refused({ caller: { ...caller, machine: "dest" } }, "succession-stop-delegation-mismatch");
  f.sql(db => db.exec("DROP TABLE succession_stop_grant"));
  await refused({}, "succession-stop-unavailable", 503);
});

test("operation and grant IDs conflict and one active grant binds a predecessor tuple", async t => {
  const f = await fixture(t);
  const body = await f.granted();
  const differentBody = await f.issue({ ...body, operation_id: operation() });
  assert.deepEqual([differentBody.status, differentBody.body.error.code], [409, "operation-id-conflict"]);
  const reusedOperation = await f.issue(f.grantBody({ operation_id: body.operation_id }));
  assert.deepEqual([reusedOperation.status, reusedOperation.body.error.code], [409, "operation-id-conflict"]);
  const second = await f.issue(f.grantBody());
  assert.deepEqual([second.status, second.body.error.code], [403, "succession-stop-delegation-mismatch"]);
});

test("revoke retains the record, repeats the original time and cannot reactivate", async t => {
  const f = await fixture(t);
  const body = await f.granted();
  const revoked = await f.revoke(body.delegation_id);
  assert.equal(revoked.status, 200); assert.equal(revoked.type, MEDIA);
  assert.equal(revoked.body.data.state, "revoked"); assert.equal(typeof revoked.body.data.revoked_at_epoch, "number");
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual((await f.revoke(body.delegation_id)).body, revoked.body);
  assert.deepEqual((await f.issue(body)).body, revoked.body);
  const missing = await f.revoke(randomUUID());
  assert.deepEqual([missing.status, missing.body.error.code], [403, "succession-stop-delegation-missing"]);
  assert.equal((await f.revoke(body.delegation_id, "issuer-token", "?x=1")).status, 400);
  assert.equal((await f.revoke("not-a-uuid")).status, 400);
  assert.equal((await f.issue(f.grantBody())).status, 200);
});

test("a delegated stop dispatches the exact body once with the relay-built binding and records the receipt", async t => {
  const f = await fixture(t);
  const grant = await f.granted();
  const op = grant.operation_id;
  const body = JSON.stringify({ operation_id: op, expected_session_incarnation: PRED_INC, schema_version: STOP_SCHEMA });
  const result = await f.stop(op, { body });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.type, MEDIA); assert.equal(result.cache, "no-store");
  assert.deepEqual(Object.keys(result.body).sort(), ["data", "ok", "schema_version"]);
  const issued = (await f.issue(grant)).body.data;
  assert.deepEqual(result.body.data, { operation_id: op, caller, predecessor, state: "stopped", stop_result: "exited", code: null, retry_until_epoch: issued.retry_until_epoch });
  assert.equal(f.seen.posts.length, 1); assert.equal(f.seen.effects, 1);
  assert.equal(f.seen.posts[0]!.body, body);
  const binding = JSON.parse(Buffer.from(f.seen.posts[0]!.headers["x-agent-session-succession-stop-binding"] as string, "base64url").toString());
  assert.deepEqual(binding, { schema_version: "agent-session.console-succession-stop-binding.v1", scope: "stop", delegation_id: grant.delegation_id, owner: "owner",
    caller_machine: "source", caller_session_id: "successor", caller_session_incarnation: CALLER_INC, machine: "dest", session_id: "predecessor", session_incarnation: PRED_INC,
    operation_id: op, retry_until_epoch: String(issued.retry_until_epoch), body_sha256: createHash("sha256").update(body).digest("hex") });
  assert.equal(f.seen.posts[0]!.headers["x-agent-session-succession-caller"], undefined);
  // The terminal receipt retains an admission block for every principal and refuses a fresh operation ID.
  const outbox = new OutboxStore(f.db);
  try {
    for (const principalId of ["owner", "other"]) assert.throws(() => outbox.admit({ principalId, machine: "dest", sessionId: "predecessor", incarnation: PRED_INC }, "intent", "message", "generation"), /outbox-lifecycle-pending/);
    assert.throws(() => outbox.beginStop({ principalId: "owner", machine: "dest", sessionId: "predecessor", incarnation: PRED_INC }, operation(),
      { delegationId: randomUUID(), callerMachine: "source", callerSessionId: "successor", callerIncarnation: CALLER_INC, retryUntilEpoch: issued.retry_until_epoch }), /outbox-lifecycle-pending/);
  } finally { outbox.close(); }
  const replay = await f.stop(op);
  assert.deepEqual(replay.body, result.body); assert.equal(f.seen.posts.length, 1);
  const read = await f.receipt(op);
  assert.deepEqual([read.status, read.body.data], [200, result.body.data]);
});

test("a stop is refused before any dispatch unless one active grant matches the exact tuples and operation", async t => {
  const f = await fixture(t);
  const grant = await f.granted(); const op = grant.operation_id;
  const code = async (result: { status: number; body: any }, expected: string, status = 403) => { assert.deepEqual([result.status, result.body.error.code], [status, expected]); };
  await code(await f.stop(operation()), "succession-stop-delegation-mismatch");
  await code(await f.stop(op, { headers: { "x-agent-session-succession-caller": callerHeader(OTHER_INC) } }), "succession-stop-delegation-mismatch");
  await code(await f.stop(op, { headers: { "x-agent-session-succession-caller": "!!" } }), "succession-stop-delegation-mismatch");
  await code(await f.stop(op, { body: f_body(op, OTHER_INC) }), "succession-stop-delegation-mismatch");
  await code(await f.stop(op, { path: "/api/coordination/sessions/dest/unknown/stop/v1" }), "succession-stop-delegation-mismatch");
  await code(await f.stop(op, { path: "/api/coordination/sessions/dest/foreign/stop/v1" }), "succession-stop-owner-mismatch");
  await code(await f.stop(op, { token: "wrong" }), "unauthorized", 401);
  await code(await f.stop(op, { token: "issuer-token" }), "unauthorized", 401);
  assert.equal(f.seen.posts.length, 0);
  await f.revoke(grant.delegation_id);
  await code(await f.stop(op), "succession-stop-delegation-revoked");
  assert.equal((await f.receipt(op)).body.error.code, "succession-stop-delegation-revoked");
  const fresh = await f.revoke(randomUUID()); assert.equal(fresh.status, 403);
  await code(await f.stop(operation()), "succession-stop-delegation-revoked");
  f.sql(db => db.exec("DELETE FROM succession_stop_grant"));
  await code(await f.stop(op), "succession-stop-delegation-missing");
  assert.equal(f.seen.posts.length, 0);
  function f_body(operationId: string, inc: string) { return { schema_version: STOP_SCHEMA, operation_id: operationId, expected_session_incarnation: inc }; }
});

test("a stop validates media, members and query before the authority check", async t => {
  const f = await fixture(t);
  const grant = await f.granted(); const op = grant.operation_id; const good = { schema_version: STOP_SCHEMA, operation_id: op, expected_session_incarnation: PRED_INC };
  assert.equal((await f.stop(op, { headers: { "content-type": "application/json" } })).status, 415);
  assert.equal((await f.stop(op, { headers: { "content-type": `${MEDIA};x=1` } })).body.error.code, "unsupported-media-type");
  const invalid: unknown[] = [JSON.stringify(good).replace("{", `{"operation_id":"${op}",`), { ...good, extra: 1 }, { ...good, machine: "dest" }, { ...good, expected_session_incarnation: null },
    { ...good, operation_id: randomUUID() }, { ...good, expected_session_incarnation: PRED_INC.toUpperCase() }, { ...good, schema_version: "x" }, "[]", "{"];
  for (const body of invalid) assert.equal((await f.stop(op, { body })).body.error.code, "invalid-request", JSON.stringify(body));
  assert.equal((await f.stop(op, { path: `${STOP_PATH}?x=1` })).body.error.code, "invalid-request");
  assert.equal((await f.receipt(op, { query: "" })).body.error.code, "invalid-request");
  assert.equal((await f.receipt(op, { query: `expected_session_incarnation=${PRED_INC}&machine=dest` })).body.error.code, "invalid-request");
  assert.equal((await f.receipt(op, { inc: PRED_INC.toUpperCase() })).body.error.code, "invalid-request");
  assert.equal(f.seen.posts.length, 0);
});

test("an already stopped predecessor keeps its status and receipt, with the block recorded first", async t => {
  const f = await fixture(t); f.mode = "already";
  const grant = await f.granted(); const op = grant.operation_id;
  const result = await f.stop(op);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "session-already-stopped");
  assert.equal(result.body.error.details.receipt.state, "stopped"); assert.equal(result.body.error.details.receipt.stop_result, "already_stopped");
  assert.deepEqual(Object.keys(result.body.error).sort(), ["code", "details"]);
  const replay = await f.stop(op);
  assert.deepEqual([replay.status, replay.body], [409, result.body]); assert.equal(f.seen.posts.length, 1);
  const read = await f.receipt(op);
  assert.deepEqual([read.status, read.body.data.stop_result], [200, "already_stopped"]);
  const outbox = new OutboxStore(f.db);
  try { assert.throws(() => outbox.admit({ principalId: "other", machine: "dest", sessionId: "predecessor", incarnation: PRED_INC }, "intent", "message", "generation"), /outbox-lifecycle-pending/); } finally { outbox.close(); }
});

test("relay refusals map store codes, leave no operation entry and allow the same ID later", async t => {
  const f = await fixture(t);
  const grant = await f.granted(); const op = grant.operation_id;
  const outbox = new OutboxStore(f.db);
  t.after(() => outbox.close());
  const target = { principalId: "other", machine: "dest", sessionId: "predecessor", incarnation: PRED_INC };
  outbox.admit(target, "intent", "private-message", "generation");
  const pending = await f.stop(op);
  assert.deepEqual([pending.status, pending.body.error.code], [409, "outbox-pending-replies"]);
  assert.doesNotMatch(JSON.stringify(pending.body), /private-message|other/);
  const missing = await f.receipt(op);
  assert.deepEqual([missing.status, missing.body.error.code], [404, "stop-operation-not-found"]);
  f.sql(db => db.exec("DELETE FROM outbox_items"));
  const fence = outbox.beginLifecycle("dest", "predecessor", PRED_INC, "archive");
  const lifecycle = await f.stop(op);
  assert.deepEqual([lifecycle.status, lifecycle.body.error.code], [409, "outbox-lifecycle-pending"]);
  outbox.releaseLifecycle(fence);
  assert.equal(f.seen.posts.length, 0);
  assert.equal((await f.stop(op)).status, 200); assert.equal(f.seen.posts.length, 1);
});

test("a refused destination attempt is recorded, replayed and releases only its own claim", async t => {
  for (const [mode, status, code] of [["mailbox", 409, "session-mailbox-not-empty"], ["unavailable", 503, "session-mailbox-unknown"]] as const) {
    const f = await fixture(t); f.mode = mode;
    const grant = await f.granted(); const op = grant.operation_id;
    const first = await f.stop(op);
    assert.deepEqual([first.status, first.body.error.code], [status, code]);
    f.mode = "normal";
    const replay = await f.stop(op);
    assert.deepEqual([replay.status, replay.body.error.code], [status, code]); assert.equal(f.seen.posts.length, 1);
    const read = await f.receipt(op);
    assert.deepEqual([read.status, read.body.data.state, read.body.data.code], [200, "refused", code]);
    const outbox = new OutboxStore(f.db);
    try { assert.equal(outbox.admit({ principalId: "owner", machine: "dest", sessionId: "predecessor", incarnation: PRED_INC }, "intent", "message", "generation").created, true); } finally { outbox.close(); }
  }
});

test("a wrong, unverifiable or unsupported reply never confirms and a retry adds no second effect", async t => {
  for (const mode of ["wrong-operation", "wrong-predecessor", "wrong-caller", "wrong-deadline", "stopped-without-result", "extra-member", "not-json", "wrong-type", "redirect", "oversized",
    "unsupported", "pending", "unknown-code", "typed-unknown"] as const) {
    const f = await fixture(t); f.mode = mode;
    const grant = await f.granted(); const op = grant.operation_id;
    const result = await f.stop(op);
    assert.deepEqual([result.status, result.body.error.code], [503, "session-stop-outcome-unknown"], mode);
    assert.equal(f.seen.posts.length, 1, mode);
    const outbox = new OutboxStore(f.db);
    try {
      assert.throws(() => outbox.admit({ principalId: "owner", machine: "dest", sessionId: "predecessor", incarnation: PRED_INC }, "intent", "message", "generation"), /outbox-lifecycle-pending/, mode);
      assert.throws(() => outbox.beginStop({ principalId: "owner", machine: "dest", sessionId: "predecessor", incarnation: PRED_INC }, operation(),
        { delegationId: randomUUID(), callerMachine: "source", callerSessionId: "successor", callerIncarnation: CALLER_INC, retryUntilEpoch: 9_999_999_999 }), /session-stop-busy/, mode);
    } finally { outbox.close(); }
    let state = ""; f.sql(db => { state = (db.prepare("SELECT state FROM outbox_stop_operations WHERE operation_id = ?").get(op) as any).state; });
    assert.ok(["pending", "unknown"].includes(state), `${mode}: ${state}`);
    f.mode = "normal";
    await f.stop(op);
    assert.ok(f.seen.effects <= 1, mode);
  }
});

test("a redirect is never followed and the destination sees one request", async t => {
  const f = await fixture(t); f.mode = "redirect";
  const grant = await f.granted();
  assert.equal((await f.stop(grant.operation_id)).body.error.code, "session-stop-outcome-unknown");
  assert.equal(f.seen.posts.length, 1); assert.equal(f.seen.gets.length, 0);
});

test("a dropped reply reconciles an exact retry read-only with one destination effect", async t => {
  const f = await fixture(t); f.mode = "drop";
  const grant = await f.granted(); const op = grant.operation_id;
  assert.equal((await f.stop(op)).body.error.code, "session-stop-outcome-unknown");
  assert.equal(f.seen.effects, 1);
  const retry = await f.stop(op);
  assert.equal(retry.status, 200, JSON.stringify(retry.body)); assert.equal(retry.body.data.state, "stopped");
  assert.equal(f.seen.posts.length, 1); assert.equal(f.seen.effects, 1);
  assert.ok(f.seen.gets.length >= 1); assert.ok(f.seen.gets.every(get => get.scope === "receipt"));
});

test("revoking an unknown stop then restarting settles from the native receipt without disclosing it", async t => {
  const f = await fixture(t); f.mode = "drop";
  const grant = await f.granted(); const op = grant.operation_id;
  await f.stop(op);
  await f.revoke(grant.delegation_id);
  const getsBefore = f.seen.gets.length;
  await f.restart();
  await waitFor(() => f.seen.gets.length > getsBefore);
  assert.ok(f.seen.gets.slice(getsBefore).every(get => get.scope === "reconcile"));
  const binding = JSON.parse(Buffer.from(f.seen.gets.at(-1)!.headers["x-agent-session-succession-stop-binding"] as string, "base64url").toString());
  assert.equal(binding.delegation_id, grant.delegation_id); assert.equal(binding.operation_id, op); assert.equal(binding.owner, "owner");
  await waitFor(() => { const outbox = new OutboxStore(f.db); try { outbox.admit({ principalId: "owner", machine: "dest", sessionId: "predecessor", incarnation: PRED_INC }, "i", "m", "g"); return false; } catch { return true; } finally { outbox.close(); } });
  const state = new DatabaseSync(f.db); const row = state.prepare("SELECT state, stop_result FROM outbox_stop_operations WHERE operation_id = ?").get(op) as any; state.close();
  assert.deepEqual({ ...row }, { state: "stopped", stop_result: "exited" });
  assert.equal(f.seen.posts.length, 1);
  assert.equal((await f.receipt(op)).body.error.code, "succession-stop-delegation-revoked");
  assert.equal((await f.stop(op)).body.error.code, "succession-stop-delegation-revoked");
  assert.equal(f.seen.posts.length, 1);
});

test("periodic reconcile never settles by absence or sends a stop", async t => {
  const f = await fixture(t, { reconcileMs: 50 });
  f.mode = "drop";
  const grant = await f.granted(); const op = grant.operation_id;
  await f.stop(op);
  f.native.clear();
  const state = () => { let row: any; f.sql(db => { row = { ...(db.prepare("SELECT state, code FROM outbox_stop_operations WHERE operation_id = ?").get(op) as any) }; }); return row; };
  f.sql(db => db.prepare("UPDATE outbox_stop_operations SET retry_until_epoch = ? WHERE operation_id = ?").run(Math.floor(Date.now() / 1000) - 1, op));
  const reads = f.seen.gets.length;
  await waitFor(() => f.seen.gets.length >= reads + 3);
  assert.ok(f.seen.gets.slice(reads).every(get => get.scope === "reconcile"));
  assert.deepEqual(state(), { state: "unknown", code: null });
  assert.equal(f.seen.posts.length, 1);
});

test("a retry whose first request never reached the destination reads the receipt, then sends the stop once", async t => {
  const f = await fixture(t); f.mode = "lost";
  const grant = await f.granted(); const op = grant.operation_id;
  assert.equal((await f.stop(op)).body.error.code, "session-stop-outcome-unknown");
  assert.equal(f.seen.effects, 0);
  const retry = await f.stop(op);
  assert.equal(retry.status, 200, JSON.stringify(retry.body)); assert.equal(retry.body.data.state, "stopped");
  assert.equal(f.seen.posts.length, 2); assert.equal(f.seen.effects, 1);
  assert.equal(f.seen.gets.at(-1)!.scope, "receipt");
  assert.equal(f.seen.posts[1]!.body, f.seen.posts[0]!.body);
  assert.equal((await f.stop(op)).status, 200); assert.equal(f.seen.posts.length, 2);
});

test("a destination the operator has not listed is only read, never sent another copy", async t => {
  const f = await fixture(t, { destinations: [] }); f.mode = "lost";
  const grant = await f.granted(); const op = grant.operation_id;
  await f.stop(op);
  assert.equal((await f.stop(op)).body.error.code, "session-stop-outcome-unknown");
  assert.equal(f.seen.posts.length, 1); assert.equal(f.seen.effects, 0);
  assert.ok(f.seen.gets.length >= 1);
});

test("a retry after the deadline or with an unverifiable receipt read never sends again", async t => {
  const f = await fixture(t); f.mode = "lost";
  const grant = await f.granted(); const op = grant.operation_id;
  await f.stop(op);
  f.sql(db => db.prepare("UPDATE outbox_stop_operations SET retry_until_epoch = ? WHERE operation_id = ?").run(Math.floor(Date.now() / 1000) - 1, op));
  f.sql(db => db.prepare("UPDATE succession_stop_grant SET retry_until_epoch = ? WHERE delegation_id = ?").run(Math.floor(Date.now() / 1000) - 1, grant.delegation_id));
  assert.equal((await f.stop(op)).body.error.code, "session-stop-outcome-unknown");
  assert.equal(f.seen.posts.length, 1); assert.equal(f.seen.effects, 0);
  const g = await fixture(t); g.mode = "lost";
  const second = await g.granted();
  await g.stop(second.operation_id);
  g.supported = false;
  assert.equal((await g.stop(second.operation_id)).body.error.code, "session-stop-outcome-unknown");
  assert.equal(g.seen.posts.length, 1);
});

test("a first effect is refused once the recorded deadline is reached and leaves no operation", async t => {
  const f = await fixture(t);
  const grant = await f.granted();
  f.sql(db => db.prepare("UPDATE succession_stop_grant SET retry_until_epoch = ? WHERE delegation_id = ?").run(Math.floor(Date.now() / 1000), grant.delegation_id));
  const result = await f.stop(grant.operation_id);
  assert.deepEqual([result.status, result.body.error.code], [409, "stop-operation-expired"]);
  assert.equal(f.seen.posts.length, 0);
  assert.equal((await f.receipt(grant.operation_id)).body.error.code, "stop-operation-not-found");
});

test("receipt access needs the exact live caller and survives predecessor removal only for its own binding", async t => {
  const f = await fixture(t);
  const grant = await f.granted(); const op = grant.operation_id;
  await f.stop(op);
  assert.equal((await f.receipt(op, { headers: { "x-agent-session-succession-caller": callerHeader(OTHER_INC) } })).body.error.code, "succession-stop-delegation-mismatch");
  assert.equal((await f.receipt(op, { headers: { "x-agent-session-succession-caller": "" } })).body.error.code, "succession-stop-delegation-mismatch");
  assert.equal((await f.receipt(operation())).body.error.code, "succession-stop-delegation-mismatch");
  f.sql(db => db.prepare("DELETE FROM session_ownership WHERE machine = 'dest' AND session_id = 'predecessor'").run());
  assert.equal((await f.receipt(op)).status, 200);
  const access = new AccessStore(f.db);
  access.claimSession({ principalId: "owner", machine: "dest", sessionId: "predecessor", incarnation: OTHER_INC });
  access.close();
  assert.equal((await f.receipt(op)).body.error.code, "succession-stop-delegation-mismatch");
  const access2 = new AccessStore(f.db);
  access2.claimSession({ principalId: "owner", machine: "dest", sessionId: "predecessor", incarnation: PRED_INC });
  access2.close();
  assert.equal((await f.receipt(op)).status, 200);
});

test("the feature is off by default and needs a dedicated service credential", async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.issue()).status, 401);
  assert.equal((await f.stop(operation())).status, 404);
  const env = {
    AGENT_CONSOLE_MACHINES: JSON.stringify([{ name: "source", url: "https://source.example.test", token: "machine-source" }]),
    AGENT_CONSOLE_PRINCIPALS: JSON.stringify([{ id: "owner", token: "browser", machines: ["source"], permissions: [] }]),
    AGENT_CONSOLE_STATE_DB: "/tmp/relay-config-test.sqlite",
    AGENT_CONSOLE_COORDINATION_RELAYS: JSON.stringify([{ machine: "source", token: "r".repeat(32), ingress_token: "i".repeat(32) }]),
  } as Record<string, string>;
  assert.equal(loadConfig(env).successionStopEnabled, false);
  assert.deepEqual(loadConfig(env).successionStopDestinations, []);
  assert.deepEqual(loadConfig({ ...env, AGENT_CONSOLE_SUCCESSION_STOP_DESTINATIONS: '["source"]' }).successionStopDestinations, ["source"]);
  for (const bad of ["{", '"source"', '["ghost"]', '["source","source"]', "[1]"]) assert.throws(() => loadConfig({ ...env, AGENT_CONSOLE_SUCCESSION_STOP_DESTINATIONS: bad }), /succession stop destinations/, bad);
  assert.throws(() => loadConfig({ ...env, AGENT_CONSOLE_SUCCESSION_STOP: "1" }), /succession stop/);
  assert.throws(() => loadConfig({ ...env, AGENT_CONSOLE_SUCCESSION_STOP: "1", AGENT_CONSOLE_SUCCESSION_STOP_ISSUER_TOKEN: "r".repeat(32) }), /succession stop/);
  assert.equal(loadConfig({ ...env, AGENT_CONSOLE_SUCCESSION_STOP: "1", AGENT_CONSOLE_SUCCESSION_STOP_ISSUER_TOKEN: "x".repeat(32) }).successionStopIssuerToken, "x".repeat(32));
});

async function waitFor(condition: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
