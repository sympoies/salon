import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import * as relay from "../src/coordinationRelay.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const schema = "agent-session.console-resume-move.v1";
const statusSchema = "agent-session.console-resume-move-status.v1";
const moveId = "a104eeba-a046-4b7b-87fb-12dcdafea110";
const callerInc = "e6153b07-f8c8-462c-92c2-2711683923c2";
const resultInc = "a5158fa3-8a3d-4fc4-aaad-e01548905353";
const sessionId = `move-${moveId}`;
const request = {
  schema_version: schema,
  operation_id: "0194f350-aa43-7dbd-831e-ac16766f74c1",
  machine: "target",
  caller: { session_id: "caller", session_incarnation: callerInc, owner: "owner" },
  session: { move_id: moveId, agent: "codex", resume: "783683ba-a24b-4342-a6f4-b571cb26a022", account: "example", cwd: "example-checkout" },
};
const repeat = { ...request, operation_id: "0194f350-aa43-7dbd-831e-ac16766f74c2" };
const created = { status: 201, body: { schema_version: schema, ok: true,
  data: { machine: "target", move_id: moveId, state: "created", session_id: sessionId, session_incarnation: resultInc } } };
const terminal = { status: 409, body: { schema_version: schema, ok: false,
  error: { code: "resume-source-live", details: { state: "staged", move_id: moveId, safe_to_retry: false, session_created: false, next_action: "inspect_source" } } } };
const unknown = { code: "resume-move-outcome-unknown",
  details: { move_id: moveId, safe_to_retry: false, next_action: "reconcile_destination" } };
const statusPath = `/sessions/resume-move/${moveId}/status/v1`;
const now = () => Math.floor(Date.now() / 1000);

type Wire = { status: number; body: unknown };
interface Seen { method: string; path: string; headers: IncomingMessage["headers"]; raw: readonly string[]; body: string }
type Fixed = { state: string; proof_freshness: string; proof_expires_at_epoch: number | null; session_id: string | null; session_incarnation: string | null };
const staged = (overrides: Partial<Fixed> = {}): Fixed => ({
  state: "staged", proof_freshness: "fresh", proof_expires_at_epoch: now() + 600, session_id: null, session_incarnation: null, ...overrides,
});
const statusBody = (data: Fixed, machine = "target") => ({ schema_version: statusSchema, ok: true, data: { machine, move_id: moveId, ...data } });
const readRefusal = (status: number, code: string, details: object = {}): Wire => ({ status, body: { schema_version: statusSchema, ok: false,
  error: { code, details: { safe_to_retry: false, next_action: "inspect_destination", ...details } } } });
const sessions = (machine: string, capabilities: unknown = { resume_move_start_v1: true }): Wire => ({ status: 200, body: { ok: true, data: { machine, capabilities, sessions: [] } } });

// A strict destination: it verifies both credentials, then the single binding
// header's exact members and scope, as the transport supplement requires.
async function destination(machine: string, t: import("node:test").TestContext) {
  const seen: Seen[] = [];
  const state = {
    ingress: `${machine}-ingress`,
    discovery: sessions(machine) as Wire | "drop" | "redirect",
    read: null as Wire | "drop" | null,
    fixed: staged(),
    start: created as Wire | "drop",
  };
  let origin = "";
  const count = (entry: Seen, name: string) => entry.raw.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
  function authorize(entry: Seen, scope: "read" | "start"): Wire | null {
    const refuse = (status: number, code: string): Wire => scope === "read" ? readRefusal(status, code)
      : { status, body: { schema_version: schema, ok: false, error: { code, details: { safe_to_retry: false, next_action: "inspect_destination" } } } };
    if (entry.headers.authorization !== "Bearer fixture-operator" || count(entry, "authorization") !== 1
      || entry.headers["x-agent-session-relay-token"] !== state.ingress || count(entry, "x-agent-session-relay-token") !== 1) {
      return refuse(401, "resume-move-unavailable");
    }
    const header = entry.headers["x-agent-session-resume-move-binding"];
    try {
      assert.equal(count(entry, "x-agent-session-resume-move-binding"), 1);
      assert.match(String(header), /^[A-Za-z0-9_-]{1,2048}$/);
      assert.deepStrictEqual(JSON.parse(Buffer.from(String(header), "base64url").toString("utf8")), {
        schema_version: "agent-session.console-resume-move-binding.v1", origin_machine: "source", caller_session_id: "caller",
        caller_session_incarnation: callerInc, owner: "owner", destination_machine: machine, move_id: moveId, scope,
        ...(scope === "start" ? { operation_id: (JSON.parse(entry.body) as { operation_id: string }).operation_id } : {}),
      });
    } catch { return refuse(403, "resume-move-binding-mismatch"); }
    return null;
  }
  function answer(entry: Seen): Wire | "drop" | "redirect" {
    if (entry.method === "GET" && entry.path === "/sessions") return state.discovery;
    const read = entry.method === "GET" && entry.path === statusPath;
    if (!read && !(entry.method === "POST" && entry.path === "/sessions/resume-move/v1")) return { status: 404, body: { ok: false } };
    return authorize(entry, read ? "read" : "start") ?? (read ? state.read ?? { status: 200, body: statusBody(state.fixed, machine) } : state.start);
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer)).on("end", () => {
      const entry = { method: req.method!, path: req.url!, headers: req.headers, raw: req.rawHeaders, body: Buffer.concat(chunks).toString() };
      seen.push(entry);
      const reply = answer(entry);
      if (reply === "drop") return void req.socket.destroy();
      if (reply === "redirect") return void res.writeHead(307, { location: `${origin}${statusPath}` }).end();
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  origin = (await listenOnLoopback(server)).base;
  return { seen, state, origin, paths: () => seen.map(entry => `${entry.method} ${entry.path}`), reset: () => { seen.length = 0; } };
}

async function fixture(t: import("node:test").TestContext, resumeMove = true) {
  const dir = mkdtempSync(join(tmpdir(), "resume-move-relay-"));
  const db = join(dir, "access.sqlite");
  let store = new AccessStore(db);
  store.claimSession({ principalId: "owner", machine: "source", sessionId: "caller", incarnation: callerInc });
  store.claimSession({ principalId: "other", machine: "source", sessionId: "other-caller", incarnation: callerInc });
  const [target, alternative] = await Promise.all([destination("target", t), destination("alternative", t)]);
  const names = ["source", "target", "alternative", "forbidden"];
  const urls: Record<string, string> = { target: target.origin, alternative: alternative.origin };
  const options = {
    openAccess: false, multiUser: true, accessDbPath: db, resumeMove,
    machines: names.map(name => ({ name, url: urls[name] ?? "http://127.0.0.1:1", token: "fixture-operator" })),
    principals: ["owner", "other"].map(id => ({ id, token: `browser-${id}`, machines: names.slice(0, 3), permissions: [] })),
    coordinationRelays: [
      { machine: "source", token: "fixture-relay", ingress_token: "fixture-ingress" },
      { machine: "target", token: "target-relay", ingress_token: target.state.ingress },
      { machine: "alternative", token: "alternative-relay", ingress_token: alternative.state.ingress },
    ],
  };
  let config = makeEdgeConfig(options);
  const handler = createServer((req, res) => {
    void relay.handleCoordinationRelay(config, store, req, res, new URL(req.url!, "http://relay.test")).catch(error => {
      res.writeHead(500).end(JSON.stringify({ fixture_error: String(error) }));
    });
  });
  const edge = createEdgeServer(config);
  t.after(async () => {
    await Promise.all([handler, edge].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const [{ base }, { base: edgeBase }] = await Promise.all([listenOnLoopback(handler), listenOnLoopback(edge)]);
  async function send(method: string, input?: object | string, token = "fixture-relay", headers: Record<string, string> = {}, publicEdge = false, query = "") {
    const result = await fetch(`${publicEdge ? edgeBase : base}/api/coordination/resume-move/v1${query}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(input === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(input === undefined ? {} : { body: typeof input === "string" ? input : JSON.stringify(input) }),
    });
    return { status: result.status, body: await result.json() };
  }
  const post = (input: object | string = request, token = "fixture-relay", headers: Record<string, string> = {}, publicEdge = false) =>
    send("POST", input, token, headers, publicEdge);
  return { post, send, target, alternative, get store() { return store; },
    configure(overrides: Partial<typeof options>) { config = makeEdgeConfig({ ...options, ...overrides }); },
    restart() { store.close(); store = new AccessStore(db); } };
}

const posts = (d: { paths(): string[] }) => d.paths().filter(path => path.startsWith("POST ")).length;

test("the edge registers the move routes only when the operator enables the capability", async t => {
  const disabled = await fixture(t, false);
  for (const method of ["GET", "POST"]) {
    const result = await disabled.send(method, method === "POST" ? request : undefined, "fixture-relay", {}, true);
    assert.equal(result.status, 404);
  }
  assert.equal((await disabled.send("POST", request)).status, 404);
  assert.deepEqual(disabled.target.seen, []);
  const enabled = await fixture(t);
  assert.deepEqual(await enabled.send("GET", undefined, "fixture-relay", {}, true), { status: 200, body: {
    schema_version: "agent-session.console-resume-move-capability.v1", ok: true,
    data: { machine: "source", capability: "resume-move-start/v1" } } });
  assert.equal((await enabled.post("{}", "fixture-relay", {}, true)).body.error.code, "resume-unsupported");
});

test("the origin handshake authenticates the origin and takes no query or caller-supplied relay header", async t => {
  const f = await fixture(t);
  assert.equal((await f.send("GET", undefined, "browser-owner")).status, 401);
  assert.equal((await f.send("GET", undefined, "fixture-ingress")).status, 401);
  assert.equal((await f.send("GET", undefined, "fixture-relay", {}, false, "?machine=target")).body.error.code, "resume-unsupported");
  for (const header of ["x-agent-session-relay-token", "x-agent-session-resume-move-binding"]) {
    assert.equal((await f.send("GET", undefined, "fixture-relay", { [header]: "forged" })).body.error.code, "resume-unsupported");
    assert.equal((await f.post(request, "fixture-relay", { [header]: "forged" })).body.error.code, "resume-unsupported");
  }
  assert.equal((await f.send("GET")).body.data.machine, "source");
  assert.deepEqual(f.target.seen, []);
});

test("discovery and both destination routes carry the credentials and exact binding, and the start body is unchanged", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.post(), created);
  assert.deepEqual(f.target.paths(), ["GET /sessions", `GET ${statusPath}`, "POST /sessions/resume-move/v1"]);
  const [discovery, read, start] = f.target.seen;
  for (const entry of f.target.seen) {
    assert.equal(entry.headers.authorization, "Bearer fixture-operator");
    const wire = JSON.stringify([entry.headers, entry.body]);
    assert.ok(!wire.includes("fixture-relay") && !wire.includes("fixture-ingress") && !wire.includes("browser-"), "no inbound credential leaves the relay");
  }
  assert.equal(discovery.headers["x-agent-session-relay-token"], undefined);
  assert.equal(discovery.headers["x-agent-session-resume-move-binding"], undefined);
  const binding = (entry: Seen) => JSON.parse(Buffer.from(String(entry.headers["x-agent-session-resume-move-binding"]), "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(binding(read).scope, "read");
  assert.ok(!Object.hasOwn(binding(read), "operation_id"));
  assert.equal(binding(start).scope, "start");
  assert.equal(binding(start).operation_id, request.operation_id);
  assert.ok(!String(read.headers["x-agent-session-resume-move-binding"]).includes("="));
  assert.deepEqual(JSON.parse(start.body), request);
  assert.equal(start.headers["x-agent-session-relay-token"], "target-ingress");
});

test("a derived owner, never the body's assertion, is bound for the destination", async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ ...request, caller: { ...request.caller, owner: "other" } })).body.error.code, "resume-move-binding-mismatch");
  assert.deepEqual(f.target.seen, []);
});

test("a forged, dropped, misdirected or redirected discovery sends no status read, start or fallback", async t => {
  const f = await fixture(t);
  const variants: [string, Wire | "drop" | "redirect"][] = [
    ["capability false", sessions("target", { resume_move_start_v1: false })],
    ["capability as a string", sessions("target", { resume_move_start_v1: "true" })],
    ["capability missing", sessions("target", {})],
    ["no capabilities", sessions("target", null)],
    ["version string instead", { status: 200, body: { ok: true, data: { machine: "target", version: "99.0.0", sessions: [] } } }],
    ["another machine", sessions("alternative")],
    ["not ok", { status: 200, body: { ok: false, data: { machine: "target", capabilities: { resume_move_start_v1: true } } } }],
    ["non-200", { ...sessions("target"), status: 503 }],
    ["malformed", { status: 200, body: null }],
    ["dropped", "drop"],
    ["redirected", "redirect"],
  ];
  for (const [name, discovery] of variants) {
    f.target.reset(); f.alternative.reset();
    f.target.state.discovery = discovery;
    const result = await f.post();
    assert.equal(result.status, 503, name);
    assert.equal(result.body.error.code, "resume-move-unavailable", name);
    assert.equal(result.body.error.details.session_created, undefined, name);
    assert.deepEqual(f.target.paths(), ["GET /sessions"], name);
    assert.deepEqual(f.alternative.seen, [], name);
  }
});

test("a positive discovery is never reused by a later operation", async t => {
  const f = await fixture(t);
  f.target.state.fixed = staged({ proof_freshness: "expired", proof_expires_at_epoch: 1 });
  assert.equal((await f.post()).body.error.code, "resume-move-proof-expired");
  f.target.state.discovery = sessions("target", { resume_move_start_v1: false });
  assert.equal((await f.post(repeat)).body.error.code, "resume-move-unavailable");
  assert.deepEqual(f.target.paths(), ["GET /sessions", `GET ${statusPath}`, "GET /sessions"]);
});

test("a missing or wrong relay token never reaches the start route", async t => {
  const f = await fixture(t);
  f.configure({ coordinationRelays: [{ machine: "source", token: "fixture-relay", ingress_token: "fixture-ingress" }] });
  assert.equal((await f.post()).body.error.code, "resume-move-unavailable");
  assert.deepEqual(f.target.seen, []);
  f.configure({});
  f.target.state.ingress = "rotated-ingress";
  const result = await f.post();
  assert.equal(result.status, 401);
  assert.deepEqual(result.body.error, { code: "resume-move-unavailable",
    details: { move_id: moveId, safe_to_retry: false, next_action: "inspect_destination" } });
  assert.equal(posts(f.target), 0);
});

test("a destination refusal of the read binding is projected and never forwards", async t => {
  const f = await fixture(t);
  const cases: [Wire, number, string][] = [
    [readRefusal(403, "resume-move-binding-mismatch"), 403, "resume-move-binding-mismatch"],
    [readRefusal(404, "resume-move-proof-missing", { move_id: moveId }), 404, "resume-move-proof-missing"],
    [readRefusal(422, "resume-move-target-mismatch", { move_id: moveId, state: "staged" }), 422, "resume-move-target-mismatch"],
    [readRefusal(422, "resume-move-session-mismatch", { move_id: moveId, next_action: "inspect_source" }), 422, "resume-move-session-mismatch"],
    [readRefusal(503, "resume-move-state-unavailable"), 503, "resume-move-state-unavailable"],
    [readRefusal(503, "resume-move-unavailable"), 503, "resume-move-unavailable"],
    [readRefusal(400, "resume-unsupported"), 400, "resume-unsupported"],
  ];
  for (const [read, status, code] of cases) {
    f.target.state.read = read;
    const result = await f.post();
    assert.equal(result.status, status);
    assert.equal(result.body.error.code, code);
    assert.equal(result.body.error.details.session_created, undefined);
    assert.equal(result.body.error.details.safe_to_retry, false);
  }
  const invalid: Wire[] = [
    readRefusal(404, "resume-move-unavailable"), readRefusal(503, "resume-move-proof-missing"),
    readRefusal(404, "resume-move-proof-missing", { session_created: false }),
    readRefusal(404, "resume-move-proof-missing", { safe_to_retry: true }),
    readRefusal(404, "resume-move-proof-missing", { next_action: "reconcile_destination" }),
    readRefusal(404, "resume-move-proof-missing", { move_id: "9aef6f79-28dd-43f9-a65b-2abb28c75d5b" }),
    readRefusal(404, "resume-move-proof-missing", { message: "raw diagnostic" }),
    readRefusal(404, "resume-move-listed-elsewhere"),
    { status: 404, body: { ...(readRefusal(404, "resume-move-proof-missing").body as object), schema_version: schema } },
    { status: 200, body: statusBody(staged(), "alternative") },
    { status: 200, body: { ...statusBody(staged()), extra: true } },
    { status: 500, body: null },
  ];
  for (const read of invalid) {
    f.target.state.read = read;
    const result = await f.post();
    assert.equal(result.body.error.code, "resume-move-unavailable", JSON.stringify(read));
    assert.equal(result.body.error.details.session_created, undefined);
  }
  assert.equal(posts(f.target), 0);
  f.target.state.read = null;
  assert.deepEqual(await f.post(), created);
  assert.equal(posts(f.target), 1);
});

test("only a fresh staged observation forwards, and the other observations follow the decision table", async t => {
  const expired = staged({ proof_freshness: "expired", proof_expires_at_epoch: 1 });
  const notCreated = { move_id: moveId, safe_to_retry: false, session_created: false };
  const table: [string, Fixed, number, string, object][] = [
    ["staged expired", expired, 409, "resume-move-proof-expired", { ...notCreated, next_action: "inspect_destination" }],
    ["prepared", staged({ state: "prepared", proof_freshness: "missing", proof_expires_at_epoch: null }), 409, "resume-move-proof-missing", { ...notCreated, next_action: "inspect_destination" }],
    ["prepared with fresh proof", staged({ state: "prepared" }), 409, "resume-move-proof-missing", { ...notCreated, next_action: "inspect_destination" }],
    ["staged missing", staged({ proof_freshness: "missing", proof_expires_at_epoch: null }), 409, "resume-move-proof-missing", { ...notCreated, next_action: "inspect_destination" }],
    ["staged unverified", staged({ proof_freshness: "unverified", proof_expires_at_epoch: null }), 503, "resume-move-unavailable", { move_id: moveId, safe_to_retry: false, next_action: "reconcile_destination" }],
    ["writer admitted", staged({ state: "writer_admitted" }), 502, "resume-move-outcome-unknown", { move_id: moveId, safe_to_retry: false, next_action: "reconcile_destination" }],
    ["created with expired proof", { ...expired, state: "created", session_id: sessionId, session_incarnation: resultInc }, 409, "resume-move-destination-writer-present", { move_id: moveId, safe_to_retry: false, next_action: "reconcile_destination" }],
    ["aborted", staged({ state: "aborted_no_writer", proof_freshness: "missing", proof_expires_at_epoch: null }), 409, "resume-move-aborted", { ...notCreated, next_action: "obtain_no_writer_receipt" }],
  ];
  for (const [name, fixed, status, code, details] of table) {
    const f = await fixture(t);
    f.target.state.fixed = fixed;
    const result = await f.post();
    assert.equal(result.status, status, name);
    assert.deepEqual(result.body.error, { code, details }, name);
    assert.equal(posts(f.target), 0, name);
    assert.equal(f.store.sessionGrant("target", sessionId), undefined, name);
    // A refusal before dispatch reserves nothing: a later fresh observation may still forward once.
    f.target.state.fixed = staged();
    assert.deepEqual(await f.post(repeat), created, name);
    assert.equal(posts(f.target), 1, name);
  }
});

test("a malformed status never permits the first start", async t => {
  const f = await fixture(t);
  const fresh = staged();
  const malformed: Wire[] = [
    { status: 200, body: statusBody({ ...fresh, state: "writer" }) },
    { status: 200, body: statusBody({ ...fresh, proof_freshness: "stale" }) },
    { status: 200, body: statusBody({ ...fresh, proof_expires_at_epoch: null }) },
    { status: 200, body: statusBody({ ...fresh, proof_expires_at_epoch: 1.5 }) },
    { status: 200, body: statusBody({ ...staged({ proof_freshness: "missing" }), proof_expires_at_epoch: now() }) },
    { status: 200, body: statusBody({ ...fresh, session_id: sessionId }) },
    { status: 200, body: statusBody({ ...fresh, state: "created", session_id: "not-the-move", session_incarnation: resultInc }) },
    { status: 200, body: statusBody({ ...fresh, state: "created", session_id: sessionId, session_incarnation: "not-a-uuid" }) },
    { status: 200, body: statusBody({ ...fresh, state: "created", session_id: sessionId, session_incarnation: null }) },
    { status: 200, body: { ...statusBody(fresh), data: { ...statusBody(fresh).data, move_id: "9aef6f79-28dd-43f9-a65b-2abb28c75d5b" } } },
    { status: 200, body: { ...statusBody(fresh), schema_version: schema } },
    { status: 200, body: { ...statusBody(fresh), ok: false } },
    { status: 200, body: { ...statusBody(fresh), data: (({ proof_freshness: _, ...rest }) => rest)(statusBody(fresh).data) } },
    { status: 202, body: statusBody(fresh) },
    { status: 200, body: null },
  ];
  for (const read of malformed) {
    f.target.state.read = read;
    assert.equal((await f.post()).body.error.code, "resume-move-unavailable", JSON.stringify(read));
  }
  f.target.state.read = "drop";
  assert.equal((await f.post()).body.error.code, "resume-move-unavailable");
  assert.equal(posts(f.target), 0);
});

test("move start grants the exact returned incarnation to the derived owner, and an exact repeat never re-forwards", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.post(), created);
  assert.equal(f.store.sessionIncarnation("owner", "target", sessionId), resultInc);
  assert.deepEqual(f.store.sessionGrant("target", sessionId)?.launcher, { machine: "source", sessionId: "caller" });
  const reordered = { session: { cwd: request.session.cwd, account: request.session.account, ...request.session },
    caller: request.caller, machine: request.machine, operation_id: repeat.operation_id, schema_version: schema };
  assert.deepEqual(await f.post(JSON.stringify(reordered, null, 2)), created);
  assert.equal(posts(f.target), 1);
});

test("invalid and unauthorized moves cannot reach the destination", async t => {
  const f = await fixture(t);
  const body = JSON.stringify(request);
  for (const invalid of [
    { ...request, extra: true }, { ...request, session: { ...request.session, prompt: "no" } },
    { ...request, caller: { ...request.caller, extra: true } },
    { ...request, session: { ...request.session, resume: request.session.resume.toUpperCase() } },
    { ...request, operation_id: moveId }, { ...request, operation_id: null },
    body.replace('"machine":"target"', '"machine":"target","machine":"target"'),
    body.replace('"owner":"owner"', '"owner":"owner","ow\\u006eer":"owner"'),
    body.replace('"account":"example"', '"account":"example","account":"example"'),
  ]) assert.equal((await f.post(invalid)).body.error.code, "resume-unsupported");
  const badToken = await f.post(request, "browser-owner");
  assert.equal(badToken.status, 401);
  assert.equal(badToken.body.error.details?.move_id, undefined);
  for (const [input, code] of [
    [{ ...request, caller: { ...request.caller, session_incarnation: resultInc } }, "resume-move-unavailable"],
    [{ ...request, caller: { ...request.caller, session_id: "not-owned" } }, "resume-move-unavailable"],
    [{ ...request, caller: { ...request.caller, owner: "other" } }, "resume-move-binding-mismatch"],
    [{ ...request, machine: "forbidden" }, "resume-move-unavailable"],
  ] as const) assert.equal((await f.post(input)).body.error.code, code);
  assert.deepEqual([f.target.seen, f.alternative.seen], [[], []]);
});

test("retained typed refusal, changed binding, retarget and operation reuse never re-forward", async t => {
  const f = await fixture(t);
  f.target.state.start = terminal;
  assert.deepEqual(await f.post(), terminal);
  f.restart();
  assert.deepEqual(await f.post(repeat), terminal);
  for (const changed of [
    { ...repeat, session: { ...request.session, cwd: "other-checkout" } },
    { ...repeat, machine: "alternative" },
    { ...repeat, session: { ...request.session, move_id: "9aef6f79-28dd-43f9-a65b-2abb28c75d5b" } },
  ]) assert.equal((await f.post(changed)).body.error.code, "resume-move-binding-mismatch");
  const foreign = await f.post({ ...repeat, caller: { ...request.caller, session_id: "other-caller", owner: "other" } });
  assert.equal(foreign.body.error.code, "resume-move-unavailable");
  assert.equal(posts(f.target) + posts(f.alternative), 1);
  assert.equal(f.store.sessionGrant("target", sessionId), undefined);
});

test("a lost reply stays unknown until a read returns the exact recorded identity, with no second dispatch", async t => {
  const f = await fixture(t);
  f.target.state.start = "drop";
  const first = await f.post();
  assert.deepEqual(first.body.error, unknown);
  f.restart();
  const unresolved: (Wire | "drop")[] = [
    { status: 200, body: statusBody(staged()) },
    { status: 200, body: statusBody(staged({ state: "writer_admitted" })) },
    { status: 200, body: statusBody(staged({ state: "prepared" })) },
    readRefusal(404, "resume-move-proof-missing", { move_id: moveId }),
    readRefusal(403, "resume-move-binding-mismatch"),
    "drop",
    { status: 200, body: statusBody(staged({ state: "created", session_id: "not-the-move", session_incarnation: resultInc })) },
    { status: 200, body: statusBody(staged({ state: "created", session_id: sessionId, session_incarnation: "not-a-uuid" })) },
    { status: 200, body: statusBody(staged({ state: "created", session_id: sessionId, session_incarnation: resultInc }), "alternative") },
  ];
  for (const read of unresolved) {
    f.target.state.read = read;
    assert.deepEqual((await f.post(repeat)).body.error, unknown, JSON.stringify(read));
  }
  assert.equal(f.store.sessionGrant("target", sessionId), undefined);
  f.store.compactResumeMoveReceipts(now() + 10_000);
  f.target.state.read = { status: 200, body: statusBody(staged({ state: "created", proof_freshness: "expired", proof_expires_at_epoch: 1, session_id: sessionId, session_incarnation: resultInc })) };
  assert.deepEqual(await f.post(repeat), created);
  assert.equal(f.store.sessionIncarnation("owner", "target", sessionId), resultInc);
  f.target.state.read = { status: 200, body: statusBody(staged({ state: "writer_admitted" })) };
  assert.deepEqual(await f.post({ ...repeat, operation_id: "0194f350-aa43-7dbd-831e-ac16766f74c3" }), created);
  assert.equal(posts(f.target), 1);
});

test("a durable no-writer abort after a lost reply is retained and never re-forwarded", async t => {
  const f = await fixture(t);
  f.target.state.start = "drop";
  assert.deepEqual((await f.post()).body.error, unknown);
  f.target.state.read = { status: 200, body: statusBody(staged({ state: "aborted_no_writer", proof_freshness: "missing", proof_expires_at_epoch: null })) };
  const aborted = await f.post(repeat);
  assert.equal(aborted.body.error.code, "resume-move-aborted");
  assert.deepEqual(aborted.body.error.details, { move_id: moveId, safe_to_retry: false, session_created: false, next_action: "obtain_no_writer_receipt" });
  f.target.state.read = { status: 200, body: statusBody(staged()) };
  assert.deepEqual(await f.post({ ...repeat, operation_id: "0194f350-aa43-7dbd-831e-ac16766f74c3" }), aborted);
  assert.equal(posts(f.target), 1);
  assert.equal(f.store.sessionGrant("target", sessionId), undefined);
});

test("unconfirmed typed and unlisted destination replies do not become no-create claims", async t => {
  const f = await fixture(t);
  const unconfirmed = { status: 423, body: { ...terminal.body, error: { code: "resume-move-destination-writer-present", details: {
    state: "writer_admitted", move_id: moveId, safe_to_retry: false, next_action: "reconcile_destination",
  } } } };
  f.target.state.start = unconfirmed;
  assert.deepEqual(await f.post(), unconfirmed);
  const other = await fixture(t);
  other.target.state.start = { ...terminal, body: { ...terminal.body, error: { ...terminal.body.error, code: "resume-move-unlisted", message: "raw diagnostic" } } };
  assert.deepEqual((await other.post()).body.error, unknown);
  assert.equal(posts(other.target), 1);
});

test("concurrent submissions claim one start without replacing a foreign owner or different incarnation", async t => {
  for (const principalId of ["other", "owner"]) {
    const f = await fixture(t);
    f.store.claimSession({ principalId, machine: "target", sessionId, incarnation: callerInc });
    const results = await Promise.all([f.post(), f.post(repeat)]);
    assert.deepEqual(results.map(result => result.body.error.code), ["resume-move-outcome-unknown", "resume-move-outcome-unknown"]);
    assert.equal(posts(f.target), 1);
    assert.equal(f.store.sessionIncarnation(principalId, "target", sessionId), callerInc);
  }
});
