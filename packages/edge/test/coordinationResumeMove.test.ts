import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import * as relay from "../src/coordinationRelay.ts";
import type { ResumeMoveDestination } from "../src/resumeMove.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const schema = "agent-session.console-resume-move.v1";
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

async function fixture(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "resume-move-relay-"));
  const db = join(dir, "access.sqlite");
  let store = new AccessStore(db);
  store.claimSession({ principalId: "owner", machine: "source", sessionId: "caller", incarnation: callerInc });
  store.claimSession({ principalId: "other", machine: "source", sessionId: "other-caller", incarnation: callerInc });
  const calls: { request: unknown; originMachine: string; callerId: string; callerIncarnation: string; owner: string }[] = [];
  let connections = 0;
  let reads = 0;
  const state = {
    enabled: true, proofExpiresAt: Math.floor(Date.now() / 1000) + 600,
    reply: created as { status: number; body: unknown } | null,
    outcome: null as { status: number; body: unknown } | null,
    dropReply: false, useDefaultAdapter: false,
  };
  const destination: ResumeMoveDestination = {
    async connect(machine, binding) {
      connections++;
      if (!state.enabled) return null;
      return {
        signer: `${machine.name}-signer`,
        async inspect(id) {
          assert.equal(id, moveId);
          reads++;
          return { proofExpiresAt: state.proofExpiresAt, outcome: state.outcome };
        },
        async forward(body) {
          calls.push({ request: body, ...binding });
          if (state.dropReply) throw new Error("fixture reply dropped");
          return state.reply;
        },
      };
    },
  };
  const machines = ["source", "target", "alternative", "forbidden"];
  const config = makeEdgeConfig({
    openAccess: false, multiUser: true, accessDbPath: db,
    machines: machines.map(name => ({ name, url: "http://127.0.0.1:1", token: "fixture-operator" })),
    principals: ["owner", "other"].map(id => ({ id, token: `browser-${id}`, machines: machines.slice(0, 3), permissions: [] })),
    coordinationRelays: [{ machine: "source", token: "fixture-relay", ingress_token: "fixture-ingress" }],
  });
  const edge = createEdgeServer(config);
  const handler = createServer((req, res) => {
    void Promise.resolve().then(() => relay.handleResumeMoveStart(config, store, req, res, state.useDefaultAdapter ? undefined : destination)).catch(error => {
      res.writeHead(500).end(JSON.stringify({ fixture_error: String(error) }));
    });
  });
  t.after(async () => {
    await Promise.all([handler, edge].map(server => new Promise<void>(resolve => {
      server.closeAllConnections(); server.close(() => resolve());
    })));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const [{ base }, { base: edgeBase }] = await Promise.all([listenOnLoopback(handler), listenOnLoopback(edge)]);
  async function post(input: object | string = request, token = "fixture-relay", publicEdge = false) {
    const result = await fetch(`${publicEdge ? edgeBase : base}/api/coordination/resume-move/v1`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: typeof input === "string" ? input : JSON.stringify(input),
    });
    return { status: result.status, body: await result.json() };
  }
  return { post, calls, state, get reads() { return reads; }, get connections() { return connections; },
    get store() { return store; }, restart() { store.close(); store = new AccessStore(db); } };
}

test("the edge does not register the move route and an unavailable fixture sends no start", async t => {
  const f = await fixture(t);
  assert.equal((await f.post(request, "fixture-relay", true)).status, 404);
  f.state.enabled = false;
  for (const useDefaultAdapter of [false, true]) {
    f.state.useDefaultAdapter = useDefaultAdapter;
    const result = await f.post();
    assert.equal(result.body.error.code, "resume-move-unavailable");
    assert.equal(result.body.error.details.session_created, undefined);
  }
  assert.equal(f.reads, 0);
  assert.deepEqual(f.calls, []);
});

test("move start preserves values and grants the exact returned incarnation to the derived owner", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.post(), created);
  assert.deepEqual(f.calls, [{ request, owner: "owner", originMachine: "source", callerId: "caller", callerIncarnation: callerInc }]);
  assert.equal(f.store.sessionIncarnation("owner", "target", sessionId), resultInc);
  assert.deepEqual(f.store.sessionGrant("target", sessionId)?.launcher, { machine: "source", sessionId: "caller" });
  const reordered = { session: { cwd: request.session.cwd, account: request.session.account, ...request.session },
    caller: request.caller, machine: request.machine, operation_id: repeat.operation_id, schema_version: schema };
  assert.deepEqual(await f.post(JSON.stringify(reordered, null, 2)), created);
  assert.equal(f.calls.length, 1);
});

test("invalid and unauthorized moves cannot reach the destination adapter", async t => {
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
  assert.equal(f.connections, 0);
});

test("retained typed refusal, changed binding, retarget and operation reuse never re-forward", async t => {
  const f = await fixture(t);
  f.state.reply = terminal;
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
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.sessionGrant("target", sessionId), undefined);
});

test("a dropped or malformed reply stays unknown until read-only recovery, including after compaction", async t => {
  const f = await fixture(t);
  f.state.dropReply = true;
  const first = await f.post();
  assert.deepEqual(first.body.error, { code: "resume-move-outcome-unknown",
    details: { move_id: moveId, safe_to_retry: false, next_action: "reconcile_destination" } });
  f.restart();
  f.state.outcome = { ...created, body: { ...created.body, data: { ...created.body.data, session_id: "not-the-move" } } };
  assert.deepEqual(await f.post(repeat), first);
  assert.equal(f.reads, 2);
  f.store.compactResumeMoveReceipts(f.state.proofExpiresAt + 1);
  f.state.proofExpiresAt = 1;
  f.state.outcome = created;
  assert.deepEqual(await f.post(repeat), created);
  assert.equal(f.reads, 3);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.sessionIncarnation("owner", "target", sessionId), resultInc);
});

test("unconfirmed typed and unknown destination refusals do not become no-create claims", async t => {
  const f = await fixture(t);
  const unconfirmed = { status: 423, body: { ...terminal.body, error: { code: "resume-move-destination-writer-present", details: {
    state: "writer_admitted", move_id: moveId, safe_to_retry: false, next_action: "reconcile_destination",
  } } } };
  f.state.reply = unconfirmed;
  assert.deepEqual(await f.post(), unconfirmed);
  f.state.outcome = { ...terminal, body: { ...terminal.body, error: { ...terminal.body.error, code: "resume-move-unlisted", message: "raw diagnostic" } } };
  const next = await f.post(repeat);
  assert.deepEqual(next.body.error, { code: "resume-move-outcome-unknown",
    details: { move_id: moveId, safe_to_retry: false, next_action: "reconcile_destination" } });
  assert.equal(f.calls.length, 1);
});

test("a verified expired proof with no receipt cannot start", async t => {
  const f = await fixture(t);
  f.state.proofExpiresAt = 1;
  assert.equal((await f.post()).body.error.code, "resume-move-proof-expired");
  assert.equal(f.calls.length, 0);
});

test("concurrent submissions claim one start without replacing a foreign owner or different incarnation", async t => {
  for (const principalId of ["other", "owner"]) {
    const f = await fixture(t);
    f.store.claimSession({ principalId, machine: "target", sessionId, incarnation: callerInc });
    const results = await Promise.all([f.post(), f.post(repeat)]);
    assert.deepEqual(results.map(result => result.body.error.code), ["resume-move-outcome-unknown", "resume-move-outcome-unknown"]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.sessionIncarnation(principalId, "target", sessionId), callerInc);
  }
});
