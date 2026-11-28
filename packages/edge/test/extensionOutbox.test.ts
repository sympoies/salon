import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SHARED_OUTBOX_MAX_ITEMS } from "@agent-console/shared/shared-outbox";
import test, { type TestContext } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { credentialHash, DeviceCredentialStore } from "../src/deviceCredentials.ts";
import type { EdgeOutboxInput, EdgeOutboxResult, EdgeExtension, EdgeRoute } from "../src/extensions.ts";
import { OutboxStore } from "../src/outboxStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const input: EdgeOutboxInput = {
  inputId: "fixture-input",
  target: { machine: "fixture", sessionId: "fixture-session", sessionIncarnation: "fixture-incarnation" },
  text: "(untrusted) Example reply",
  source: { channel: "companion", label: "Companion device", prefix: "(companion) " },
};
const key = { inputId: input.inputId, channel: input.source.channel };
const primaryToken = "primary-fixture";
const secondaryToken = "secondary-fixture";
const bridgeToken = "bridge-fixture";

interface Variant {
  /** Whether the relay route declares the on-behalf capability. */
  readonly capability?: boolean;
  /** The bridge principal's configuration; `null` removes it. */
  readonly bridge?: { readonly machines?: string[]; readonly dispatchMachines?: string[]; readonly permissions?: string[] } | null;
  readonly ownerPermissions?: string[];
}

async function fixture(t: TestContext, outboxPollIntervalMs = 60_000, initial: Variant = {}) {
  const directory = mkdtempSync(join(tmpdir(), "extension-outbox-"));
  const path = join(directory, "state.sqlite");
  const ownership = new AccessStore(path);
  const devices = new DeviceCredentialStore(path, principal => principal === "primary" ? primaryToken : principal === "bridge" ? bridgeToken : undefined, () => true);
  ownership.claimSession({ principalId: "primary", machine: input.target.machine, sessionId: input.target.sessionId,
    incarnation: input.target.sessionIncarnation });
  let running = false;
  let observation: { entered(): void; resume: Promise<void> } | undefined;
  const posts: string[] = [];
  let sessionReads = 0;
  const initialDispatchObserved = Promise.withResolvers<void>();
  const daemon = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      if (++sessionReads === 2) initialDispatchObserved.resolve();
      const pending = observation;
      observation = undefined;
      pending?.entered();
      await pending?.resume;
      return res.end(JSON.stringify({ ok: true, data: { sessions: [{
        id: input.target.sessionId, status: running ? "running" : "stopped", agent: "codex",
        session_incarnation: input.target.sessionIncarnation,
      }] } }));
    }
    if (req.method === "POST" && req.url === "/sessions/fixture-session/prompt/v2") {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw);
      posts.push(body.text);
      return res.end(JSON.stringify({ ok: true, data: { submitted: true, session_incarnation: input.target.sessionIncarnation,
        receipt: { request_id: body.request_id, session_id: input.target.sessionId,
          session_incarnation: input.target.sessionIncarnation, outcome: "submitted", code: null } } }));
    }
    res.writeHead(404).end("{}");
  });
  const upstream = await listenOnLoopback(daemon);
  const results: EdgeOutboxResult<200 | 201>[] = [];
  const handle: EdgeRoute["handle"] = async ctx => {
    const result = ctx.method === "PUT" ? await ctx.outbox.admit(await ctx.readJsonBody() as EdgeOutboxInput)
      : await ctx.outbox.get({ channel: input.source.channel, inputId: ctx.params.inputId! });
    results.push(result);
    ctx.sendJson(result.status, result);
  };
  const startEdge = async (variant: Variant) => {
    const extension: EdgeExtension = { id: "fixture", permissions: ["relay"], routes: [
      { id: "inputs", pattern: "/api/ext/fixture/inputs/:inputId", methods: ["PUT", "GET"], permission: "debug", handle },
      { id: "relay", pattern: "/api/ext/fixture/relay/:inputId", methods: ["PUT", "GET"], permission: "relay",
        ...(variant.capability !== false && { outboxOwnerDispatch: true }), handle },
      { id: "plain-relay", pattern: "/api/ext/fixture/plain-relay/:inputId", methods: ["PUT", "GET"], permission: "relay", handle },
      { id: "reply", pattern: "/api/ext/fixture/reply/:intent", methods: ["GET"], permission: "relay",
        outboxOwnerDispatch: true, async handle(ctx) {
          ctx.sendJson(200, await ctx.conversation.firstReplyAfter({ outboxIntentId: ctx.params.intent!,
            target: { ...input.target, sessionCreatedAt: "2026-01-01T00:00:00Z" } }));
        } },
    ] };
    const bridge = variant.bridge === undefined ? {} : variant.bridge;
    const config = makeEdgeConfig({ openAccess: false, multiUser: true, accessDbPath: path,
      principals: [
        { id: "primary", token: primaryToken, machines: ["fixture"], permissions: ["debug", ...variant.ownerPermissions ?? []] },
        { id: "secondary", token: secondaryToken, machines: ["fixture"], permissions: ["debug"] },
        ...(bridge ? [{ id: "bridge", token: bridgeToken, machines: bridge.machines ?? ["fixture"],
          permissions: bridge.permissions ?? ["relay"], ...(bridge.dispatchMachines && { dispatchMachines: bridge.dispatchMachines }) }] : []),
        { id: "root", token: "root-fixture", machines: ["fixture"], permissions: [] },
        { id: "viewer", token: "viewer-fixture", machines: ["fixture"], permissions: [] },
      ],
      machines: [{ name: "fixture", url: upstream.base, token: "upstream-fixture" }] });
    const server = createEdgeServer(config, { extensions: [extension], outboxPollIntervalMs });
    return { server, base: (await listenOnLoopback(server)).base };
  };
  const stop = async (server: Server) => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  let edge = await startEdge(initial);
  t.after(async () => {
    for (const server of [edge.server, daemon]) await stop(server);
    ownership.close();
    devices.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (method: string, token: string, value?: EdgeOutboxInput, route = "inputs") => fetch(
    `${edge.base}/api/ext/fixture/${route}/${value?.inputId ?? key.inputId}`, {
      method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: value && JSON.stringify(value),
    });
  return {
    base: async () => edge.base, call, path, posts, results, initialDispatchObserved: initialDispatchObserved.promise, startSession: () => { running = true; },
    /** Stop the edge and start another over the same state, as after a configuration change. */
    async restart(variant: Variant) {
      await stop(edge.server);
      edge = await startEdge(variant);
    },
    issueDevice(principal = "primary", token = primaryToken) {
      const { id, code } = devices.create(principal, token, undefined, 60_000);
      const verifier = "a".repeat(43);
      const claim = { code, challenge: credentialHash(verifier), origin: edge.base, name: "Fixture device", delivery: "native" } as const;
      devices.claim(claim);
      devices.approve(id, principal, code, claim.challenge);
      const device = devices.exchange({ ...claim, verifier, principal, confirmed: true });
      return { ...device, revoke: () => devices.revoke(device.id, principal) };
    },
    transferSession() {
      const other = new DatabaseSync(path);
      try { other.prepare("UPDATE session_ownership SET principal_id=? WHERE machine=? AND session_id=?")
        .run("secondary", input.target.machine, input.target.sessionId); }
      finally { other.close(); }
    },
    pauseObservation() {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      observation = { entered: entered.resolve, resume: resume.promise };
      return { entered: entered.promise, resume: resume.resolve };
    },
  };
}

async function expectError(response: Response, status: number, code: string) {
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  assert.deepEqual(result, { ok: false, status, error: { status, code } });
}

test("extension admission uses one durable record, returns 200 on replay and rejects changed content", async t => {
  const f = await fixture(t, 50);
  const responses = await Promise.all([f.call("PUT", primaryToken, input), f.call("PUT", primaryToken, input)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const records = await Promise.all(responses.map(async response => (await response.json()).record));
  const [first, duplicate] = records;
  assert.deepEqual(duplicate, first);
  assert.deepEqual(first.source, input.source);
  assert.deepEqual(first.target, input.target);
  assert.equal(first.inputId, input.inputId);
  assert.equal(first.state, "queued");
  await expectError(await f.call("PUT", primaryToken, { ...input, text: "Changed" }), 409, "input-id-conflict");
  await expectError(await f.call("PUT", primaryToken, { ...input, source: { ...input.source, label: "Changed" } }), 409, "input-id-conflict");
  await expectError(await f.call("PUT", primaryToken, {
    ...input, target: { ...input.target, sessionIncarnation: "different-incarnation" },
  }), 409, "input-id-conflict");

  f.startSession();
  const deadline = Date.now() + 3000;
  for (;;) {
    const read = await f.call("GET", primaryToken);
    assert.equal(read.status, 200);
    const { record } = await read.json();
    assert.deepEqual(record.source, input.source, "source metadata survives delivery");
    if (record.state === "submitted") {
      assert.equal(record.outboxIntentId, first.outboxIntentId);
      assert.equal(record.receipt.outcome, "submitted");
      break;
    }
    assert.ok(Date.now() < deadline, "the durable record must expose the delivery receipt");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(f.posts, [input.source.prefix + input.text], "the dispatcher submits the prefix once");
});

test("extension outbox binds the principal and exact session and rechecks ownership after a read awaits", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.call("PUT", "viewer-fixture", input)).status, 403);
  await expectError(await f.call("PUT", secondaryToken, input), 403, "forbidden");
  const admitted = await f.call("PUT", primaryToken, input);
  assert.equal(admitted.status, 201);
  await admitted.json();
  await expectError(await f.call("GET", secondaryToken), 404, "input-not-found");
  await f.initialDispatchObserved;
  const paused = f.pauseObservation();
  const pendingRead = f.call("GET", primaryToken);
  try {
    await paused.entered;
    f.transferSession();
  } finally { paused.resume(); }
  await expectError(await pendingRead, 403, "forbidden");
  await expectError(await f.call("GET", primaryToken), 403, "forbidden");
  await expectError(await f.call("GET", secondaryToken), 404, "input-not-found");
});

test("device revocation during outbox admission prevents any durable input", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const device = f.issueDevice();
  const paused = f.pauseObservation();
  const pending = f.call("PUT", device.credential, input);
  const disconnected = assert.rejects(pending, /fetch failed/);
  try {
    await paused.entered;
    device.revoke();
  } finally { paused.resume(); }
  // Core closes an authenticated device response once its credential is revoked.
  await disconnected;
  assert.deepEqual(f.results.at(-1), { ok: false, status: 401, error: { status: 401, code: "unauthenticated" } });
  assert.equal((await f.call("PUT", device.credential, input)).status, 401);
  await expectError(await f.call("GET", primaryToken), 404, "input-not-found");
});

test("extension records retain their receipt and idempotency after outbox compaction and restart", t => {
  const directory = mkdtempSync(join(tmpdir(), "extension-outbox-compaction-"));
  const path = join(directory, "state.sqlite");
  let store = new OutboxStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const target = { principalId: "primary", machine: input.target.machine, sessionId: input.target.sessionId,
    incarnation: input.target.sessionIncarnation };
  const identity = { ...key, principalId: target.principalId, extensionId: "fixture" };
  const admission = { target, source: input.source, grant: { routeKey: "fixture:inputs", permission: "debug" } };
  store.admitExtensionInput(identity, admission, input.text, "fixture-generation", null);
  const attempt = store.claim(store.candidate(target)!)!;
  store.settle(attempt, { request_id: attempt.item.request_id, session_id: target.sessionId,
    session_incarnation: target.incarnation, outcome: "submitted", code: null });
  const submitted = store.extensionInput(identity);
  assert.equal(submitted?.item.state, "submitted");
  for (let i = 0; i < SHARED_OUTBOX_MAX_ITEMS; i++) {
    store.admit(target, `other-${i}`, "Queued reply", "fixture-generation");
  }
  assert.equal(store.get(target, attempt.item.id), undefined);
  store.close();
  store = new OutboxStore(path);
  assert.deepEqual(store.extensionInput(identity), submitted);
  assert.deepEqual(store.admitExtensionInput(identity, admission, input.text, "fixture-generation", null),
    { created: false, entry: submitted });
  assert.throws(() => store.admitExtensionInput(identity, admission, "Changed text", "fixture-generation", null),
    /outbox-intent-conflict/);
});

const owned = { ...input, ownerPrincipalId: "primary" };
type OwnerInput = EdgeOutboxInput & { ownerPrincipalId?: string };
const relay = (f: Awaited<ReturnType<typeof fixture>>, method: string, token: string, value?: OwnerInput, route = "relay") =>
  f.call(method, token, value as EdgeOutboxInput | undefined, route);
function stored(path: string) {
  const db = new DatabaseSync(path);
  try {
    const admission = db.prepare("SELECT admission FROM outbox_extension_inputs").all() as Array<{ admission: string }>;
    const items = db.prepare("SELECT scope, value, device_id FROM outbox_items").all() as Array<{ scope: string; value: string; device_id: string | null }>;
    return { admissions: admission.map(row => JSON.parse(row.admission)), items: items.map(row => ({ scope: row.scope, deviceId: row.device_id, ...JSON.parse(row.value) })) };
  } finally { db.close(); }
}
async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("an on-behalf route admits for the true owner, dispatches in the owner's scope and stores owner and caller", async t => {
  const f = await fixture(t, 50);
  const admitted = await relay(f, "PUT", bridgeToken, owned);
  assert.equal(admitted.status, 201, JSON.stringify(await admitted.clone().json()));
  const { record } = await admitted.json();
  assert.deepEqual(record.target, input.target);
  const [admission] = stored(f.path).admissions;
  assert.equal(admission.target.principalId, "primary", "the dispatch principal is the owner");
  assert.deepEqual(admission.grant, { routeKey: "fixture:relay", permission: "relay", callerPrincipalId: "bridge" });
  assert.equal(stored(f.path).items[0]!.scope, JSON.stringify(["primary", input.target.machine, input.target.sessionId, input.target.sessionIncarnation]));
  assert.equal((await relay(f, "PUT", bridgeToken, owned)).status, 200, "replay by the same caller");
  await expectError(await relay(f, "PUT", bridgeToken, { ...owned, text: "Changed" }), 409, "input-id-conflict");

  f.startSession();
  await until(() => f.posts.length > 0, "the owner-bound item must dispatch");
  assert.deepEqual(f.posts, [input.source.prefix + input.text]);
  const read = await relay(f, "GET", bridgeToken);
  assert.equal((await read.json()).record.state, "submitted");
});

test("an on-behalf route refuses a wrong owner, a stale incarnation, a missing owner and a caller without the route permission", async t => {
  const f = await fixture(t);
  await expectError(await relay(f, "PUT", bridgeToken, { ...owned, ownerPrincipalId: "secondary" }), 403, "forbidden");
  await expectError(await relay(f, "PUT", bridgeToken, { ...owned, ownerPrincipalId: "bridge" }), 403, "forbidden");
  await expectError(await relay(f, "PUT", bridgeToken, { ...owned, target: { ...input.target, sessionIncarnation: "stale-incarnation" } }), 403, "forbidden");
  await expectError(await relay(f, "PUT", bridgeToken, input), 400, "invalid-request");
  await expectError(await relay(f, "PUT", bridgeToken, { ...owned, ownerPrincipalId: "*" }), 403, "forbidden");
  // Core refuses a principal without the route permission before the extension runs.
  assert.equal((await relay(f, "PUT", secondaryToken, owned)).status, 403);
  assert.equal((await relay(f, "PUT", primaryToken, owned)).status, 403);
  // Root passes the ordinary owner check for dispatch, so the capability must refuse it itself.
  await expectError(await relay(f, "PUT", bridgeToken, { ...owned, ownerPrincipalId: "root" }), 403, "forbidden");
  assert.deepEqual(stored(f.path).admissions, [], "no refused request leaves a record");
});

test("a route without the capability refuses an asserted owner and keeps plain admission unchanged", async t => {
  const f = await fixture(t);
  await expectError(await relay(f, "PUT", bridgeToken, owned, "plain-relay"), 403, "forbidden");
  await expectError(await relay(f, "PUT", bridgeToken, input, "plain-relay"), 403, "forbidden");
  await expectError(await relay(f, "PUT", primaryToken, owned, "inputs"), 403, "forbidden");
  assert.equal((await f.call("PUT", primaryToken, input)).status, 201);
  assert.deepEqual(stored(f.path).admissions, [{
    target: { machine: input.target.machine, sessionId: input.target.sessionId, incarnation: input.target.sessionIncarnation, principalId: "primary" },
    source: input.source, grant: { routeKey: "fixture:inputs", permission: "debug" },
  }]);
});

test("dispatch stops after the owner changes", async t => {
  const f = await fixture(t, 50);
  assert.equal((await relay(f, "PUT", bridgeToken, owned)).status, 201);
  f.transferSession();
  f.startSession();
  await until(() => stored(f.path).items[0]?.state === "refused", "ownership change must refuse the queued item");
  assert.equal(stored(f.path).items[0]!.error_code, "outbox-authorization-changed");
  assert.deepEqual(f.posts, []);
  await expectError(await relay(f, "GET", bridgeToken), 403, "forbidden");
});

test("dispatch-only grants admit owner input without machine or terminal access", async t => {
  const f = await fixture(t, 50, { bridge: { machines: [], dispatchMachines: ["fixture"] } });
  const admitted = await relay(f, "PUT", bridgeToken, owned);
  assert.equal(admitted.status, 201);
  f.startSession();
  await until(() => f.posts.length > 0, "dispatch-only input must reach the owner session");
  const base = await f.base();
  const headers = { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" };
  for (const [method, path] of [
    ["POST", "/api/sessions/fixture"],
    ["POST", "/api/sessions/fixture/fixture-session/send"],
    ["POST", "/api/sessions/fixture/fixture-session/attach-ticket"],
    ["GET", "/api/sessions/fixture/fixture-session/buffer"],
    ["GET", "/api/machines/fixture/runtime/health"],
    ["POST", "/api/shells/fixture"],
  ]) {
    const response = await fetch(`${base}${path}`, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
    assert.equal(response.status, 403, `${method} ${path}`);
    await response.arrayBuffer();
  }
  const listing = await fetch(`${base}/api/sessions`, { headers });
  assert.equal(listing.status, 200);
  assert.deepEqual((await listing.json()).data.sessions, []);
  const url = new URL(base);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path: "/api/sessions/fixture/fixture-session/attach",
      headers: { ...headers, connection: "Upgrade", upgrade: "websocket" } });
    req.once("response", res => { res.resume(); resolve(res.statusCode!); });
    req.once("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
    req.once("error", reject); req.end();
  });
  assert.equal(status, 403);
});

test("removing a dispatch-only grant refuses queued input", async t => {
  const f = await fixture(t, 50, { bridge: { machines: [], dispatchMachines: ["fixture"] } });
  assert.equal((await relay(f, "PUT", bridgeToken, owned)).status, 201);
  await f.restart({ bridge: { machines: [], dispatchMachines: [] } });
  f.startSession();
  await until(() => stored(f.path).items[0]?.state === "refused", "removed grant must refuse queued input");
  assert.deepEqual(f.posts, []);
});

test("an on-behalf route refuses a caller whose machine allowlist excludes the target", async t => {
  const f = await fixture(t, 60_000, { bridge: { machines: [] } });
  await expectError(await relay(f, "PUT", bridgeToken, owned), 403, "forbidden");
  assert.deepEqual(stored(f.path).admissions, []);
});

test("on-behalf items store no caller device identity", async t => {
  const f = await fixture(t);
  const device = f.issueDevice("bridge", bridgeToken);
  assert.equal((await relay(f, "PUT", device.credential, owned)).status, 201);
  assert.equal(stored(f.path).items[0]!.deviceId, null);
});

for (const [name, variant] of [
  ["the route loses the capability", { capability: false }],
  ["the caller loses the route permission", { bridge: { permissions: [] } }],
  ["the caller is no longer configured", { bridge: null }],
  ["the caller loses access to the machine", { bridge: { machines: [] } }],
] as const satisfies ReadonlyArray<readonly [string, Variant]>) {
  test(`a queued on-behalf item is refused without a daemon post when ${name}`, async t => {
    const f = await fixture(t, 50);
    assert.equal((await relay(f, "PUT", bridgeToken, owned)).status, 201);
    await f.restart(variant);
    f.startSession();
    await until(() => stored(f.path).items[0]?.state === "refused", "the dispatcher must refuse the queued item");
    assert.equal(stored(f.path).items[0]!.error_code, "outbox-authorization-changed");
    assert.deepEqual(f.posts, []);
  });
}

test("reading an on-behalf record uses its stored grant, not the current route", async t => {
  const f = await fixture(t);
  assert.equal((await relay(f, "PUT", bridgeToken, owned)).status, 201);
  // The owner now holds the permission, so only the stored on-behalf grant can refuse a read without the capability.
  await f.restart({ capability: false, ownerPermissions: ["relay"] });
  await expectError(await relay(f, "GET", bridgeToken), 403, "forbidden");
});

test("on-behalf records are not readable through the conversation facade", async t => {
  const f = await fixture(t);
  const admitted = await relay(f, "PUT", bridgeToken, owned);
  const { record } = await admitted.json();
  const read = await fetch(`${await f.base()}/api/ext/fixture/reply/${record.outboxIntentId}`, {
    headers: { authorization: `Bearer ${bridgeToken}` },
  });
  assert.deepEqual(await read.json(), { status: "forbidden" });
});
