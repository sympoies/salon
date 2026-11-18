import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { cookieFrom, listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

const inbox = "/api/prompter/v1/messages";
const ingress = "/api/coordination/prompter/v1/messages";
const day = 86_400_000;
const initialTime = Date.UTC(2026, 0, 1, 12);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "companion-inbox-"));
  const db = join(directory, "access.sqlite");
  const sessions = [
    { id: "source-session", session_incarnation: "source-inc", owner: "owner-a" },
    { id: "coordinator-session", session_incarnation: "coordinator-inc", owner: "owner-a" },
    { id: "other-session", session_incarnation: "other-inc", owner: "owner-b" },
    { id: "unclaimed-session", session_incarnation: "unclaimed-inc" },
  ];
  const access = new AccessStore(db);
  for (const session of sessions) {
    if (!session.owner) continue;
    access.claimSession({ principalId: session.owner, machine: "workstation",
      sessionId: session.id, incarnation: session.session_incarnation,
      ...(session.id === "coordinator-session" ? { consoleRole: "coordinator" } : {}) });
  }
  access.close();
  const daemon = createServer((req, res) => {
    if (req.url !== "/sessions" || req.headers.authorization !== "Bearer daemon-fixture") {
      res.writeHead(403); res.end(); return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: { coordination: { remote_messaging_supported: true },
      sessions: sessions.map(({ id, session_incarnation }) => ({
        id, session_incarnation, status: "running", coordination_mode: "advisory", coordination_available: true,
      })) } }));
  });
  const { base: daemonBase } = await listenOnLoopback(daemon);
  const config = makeEdgeConfig({
    openAccess: false, multiUser: true, accessDbPath: db,
    principals: [
      { id: "owner-a", token: "owner-a-fixture", machines: ["workstation", "other-machine"], permissions: ["debug"] },
      { id: "owner-b", token: "owner-b-fixture", machines: ["workstation"], permissions: [] },
    ],
    machines: ["workstation", "other-machine"].map(name => ({ name, url: daemonBase, token: "daemon-fixture" })),
    coordinationRelays: [
      { machine: "workstation", token: "relay-fixture", ingress_token: "ingress-fixture" },
      { machine: "other-machine", token: "other-relay-fixture", ingress_token: "other-ingress-fixture" },
    ],
    crossOwnerMessaging: [{ from: "owner-a", to: "owner-b", recipients: [{ role: "coordinator" }] }],
  });
  let now = initialTime;
  let edge = createEdgeServer(config, { authNow: () => now });
  let { base } = await listenOnLoopback(edge);
  t.after(async () => {
    await Promise.all([stop(edge), stop(daemon)]);
    rmSync(directory, { recursive: true });
  });

  async function call<Data = unknown>(path: string, headers: Record<string, string> = {}, payload?: unknown,
    method = payload === undefined ? "GET" : "POST") {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, body: await response.json() as { data: Data }, response };
  }
  async function pair(owner = "owner-a", delivery: "native" | "browser" = "native") {
    const auth = bearer(`${owner}-fixture`);
    const created = await call<{ id: string; code: string }>("/api/auth/pairings", auth, {});
    assert.equal(created.status, 201);
    const { id, code } = created.body.data;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("hex");
    assert.equal((await call("/api/auth/pairings/claim", {}, { code, challenge, name: "Fixture device", delivery })).status, 200);
    assert.equal((await call(`/api/auth/pairings/${id}/approve`, auth, { code, challenge })).status, 200);
    const exchanged = await call<{ id: string; credential: string }>("/api/auth/pairings/exchange", {},
      { code, verifier, challenge, delivery, principal: owner, origin: base, confirmed: true });
    assert.equal(exchanged.status, 200);
    const headers = delivery === "browser" ? { cookie: cookieFrom(exchanged.response) } : bearer(exchanged.body.data.credential);
    return { id: exchanged.body.data.id, headers };
  }
  const submit = (fields: Record<string, unknown> = {}, token = "relay-fixture") =>
    call<{ id: string }>(ingress, bearer(token), {
      source_session_id: "source-session", source_incarnation: "source-inc", body: "Fixture message", ...fields,
    });
  const list = (headers: Record<string, string>, query = "") =>
    call<{ messages: { id: string }[]; next_cursor: string | null }>(inbox + query, headers);
  const ack = (headers: Record<string, string>, id: string, key: string, state = "displayed") =>
    call(`${inbox}/${id}/ack`, headers, { state, idempotency_key: key });
  return {
    call, pair, submit, list, ack, sessions,
    advance(ms: number) { now += ms; },
    async restart() {
      await stop(edge);
      edge = createEdgeServer(config, { authNow: () => now });
      ({ base } = await listenOnLoopback(edge));
    },
    mainCookie: () => loginCookie(base, "owner-a-fixture"),
  };
}

function expectError(result: { status: number; body: unknown }, status: number, code: string): void {
  assert.equal(result.status, status);
  assert.partialDeepStrictEqual(result.body, { ok: false, error: { code } });
}

test("pages replay stable message IDs and survive restart until the retention boundary", async t => {
  const f = await fixture(t);
  const device = await f.pair();
  const first = await f.submit({ body: "Choose the next step.", color: "#C2E5F2", urgent: true });
  const second = await f.submit({ body: "Review the updated draft." });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const id = first.body.data.id;
  const secondId = second.body.data.id;
  assert.match(id, /^(0|[1-9][0-9]{0,19})$/);
  assert.ok(BigInt(id) <= 0xffffffffffffffffn);
  assert.notEqual(id, secondId);
  assert.equal((await f.ack(device.headers, id, "shown")).status, 200);
  const page = await f.list(device.headers, "?limit=1");
  assert.equal(page.status, 200);
  assert.equal(page.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(page.body.data, { messages: [{
    id, sender: "source-session", body: "Choose the next step.", created_at: new Date(initialTime).toISOString(),
    color: "#C2E5F2", urgent: true,
    target: { machine: "workstation", session_id: "source-session", incarnation: "source-inc" },
  }], next_cursor: id });
  await f.restart();
  assert.deepEqual((await f.list(device.headers, "?limit=1")).body, page.body);
  const continuation = await f.list(device.headers, `?cursor=${id}`);
  assert.deepEqual(continuation.body.data, { messages: [{
    id: secondId, sender: "source-session", body: "Review the updated draft.", created_at: new Date(initialTime).toISOString(),
    target: { machine: "workstation", session_id: "source-session", incarnation: "source-inc" },
  }], next_cursor: secondId });
  assert.deepEqual((await f.list(device.headers, `?cursor=${secondId}`)).body.data,
    { messages: [], next_cursor: secondId });
  f.advance(7 * day);
  expectError(await f.list(device.headers, `?cursor=${id}`), 410, "cursor-expired");
  expectError(await f.ack(device.headers, id, "shown"), 404, "message-not-found");
  assert.deepEqual((await f.list(device.headers)).body.data, { messages: [], next_cursor: null });
});

test("device credential kind, origin and owner fence message reads and acknowledgements", async t => {
  const f = await fixture(t);
  const owner = await f.pair("owner-a", "browser");
  const other = await f.pair("owner-b");
  const source = await f.submit();
  const theirs = await f.submit({ source_session_id: "other-session", source_incarnation: "other-inc" });
  assert.equal(source.status, 201);
  assert.equal(theirs.status, 201);
  const id = source.body.data.id;
  assert.deepEqual((await f.list(owner.headers)).body.data.messages.map(message => message.id), [id]);
  assert.deepEqual((await f.list(other.headers)).body.data.messages.map(message => message.id), [theirs.body.data.id]);
  expectError(await f.list(other.headers, `?cursor=${id}`), 410, "cursor-expired");
  expectError(await f.ack(other.headers, id, "foreign", "read"), 404, "message-not-found");
  expectError(await f.list({ cookie: await f.mainCookie() }), 403, "device-required");
  expectError(await f.list({ ...owner.headers, ...bearer("owner-a-fixture") }), 403, "device-required");
  expectError(await f.ack(bearer("owner-a-fixture"), id, "main"), 403, "device-required");
  expectError(await f.ack({ ...owner.headers, origin: "https://other.example" }, id, "foreign-origin"), 403, "cross-origin");
  assert.deepEqual((await f.ack(owner.headers, id, "shown")).body.data, { id, state: "displayed" });
});

test("expired and revoked device credentials cannot list or acknowledge", async t => {
  const f = await fixture(t);
  const expired = await f.pair();
  f.advance(day);
  const revoked = await f.pair();
  const active = await f.pair();
  const removal = await f.call(`/api/auth/devices/${revoked.id}`, bearer("owner-a-fixture"), undefined, "DELETE");
  assert.equal(removal.status, 200);
  f.advance(29 * day);
  for (const device of [expired, revoked]) {
    expectError(await f.list(device.headers), 401, "unauthorized");
    expectError(await f.ack(device.headers, "1", "retired"), 401, "unauthorized");
  }
  assert.equal((await f.list(active.headers)).status, 200);
});

test("concurrent identical acknowledgements keep their receipt and read state is monotonic", async t => {
  const f = await fixture(t);
  const device = await f.pair();
  const first = await f.submit();
  const second = await f.submit();
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const id = first.body.data.id;
  const displayed = { id, state: "displayed" };
  const read = { id, state: "read" };
  for (const receipt of await Promise.all([f.ack(device.headers, id, "shown"), f.ack(device.headers, id, "shown")])) {
    assert.equal(receipt.status, 200);
    assert.deepEqual(receipt.body.data, displayed);
  }
  expectError(await f.ack(device.headers, id, "shown", "read"), 409, "idempotency-key-conflict");
  expectError(await f.ack(device.headers, second.body.data.id, "shown"), 409, "idempotency-key-conflict");
  assert.deepEqual((await f.ack(device.headers, id, "opened", "read")).body.data, read);
  await f.restart();
  assert.deepEqual((await f.ack(device.headers, id, "shown")).body.data, displayed);
  assert.deepEqual((await f.ack(device.headers, id, "shown-again")).body.data, read);
});

test("producer ingress requires a relay and an exact owned live session", async t => {
  const f = await fixture(t);
  const device = await f.pair();
  expectError(await f.submit({}, "owner-a-fixture"), 401, "unauthorized");
  expectError(await f.call(ingress, device.headers, {
    source_session_id: "source-session", source_incarnation: "source-inc", body: "Fixture message",
  }), 401, "unauthorized");
  expectError(await f.submit({}, "other-relay-fixture"), 403, "source-forbidden");
  expectError(await f.submit({ owner: "owner-b" }), 400, "invalid-request");
  expectError(await f.submit({ source_session_id: "unclaimed-session", source_incarnation: "unclaimed-inc" }), 403,
    "source-forbidden");
  f.sessions[0]!.session_incarnation = "replaced-inc";
  expectError(await f.submit(), 409, "session-incarnation-conflict");
  const coordinator = await f.submit({ source_session_id: "coordinator-session", source_incarnation: "coordinator-inc" });
  assert.equal(coordinator.status, 201);
  const page = await f.list(device.headers);
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.data.messages, [{
    id: coordinator.body.data.id, sender: "coordinator-session", body: "Fixture message",
    created_at: new Date(initialTime).toISOString(),
    target: { machine: "workstation", session_id: "coordinator-session", incarnation: "coordinator-inc" },
  }]);
});

test("inbox validates byte limits and keeps rejected bodies out of diagnostics", async t => {
  const f = await fixture(t);
  const device = await f.pair();
  const marker = "fixture-body-marker";
  const logged = t.mock.method(console, "error", () => {});
  const accepted = await f.submit({ body: "é".repeat(2048) });
  assert.equal(accepted.status, 201);
  expectError(await f.submit({ body: "é".repeat(2049) }), 413, "body-too-large");
  expectError(await f.submit({ body: marker.repeat(3000) }), 413, "body-too-large");
  expectError(await f.submit({ body: "   " }), 400, "invalid-request");
  expectError(await f.submit({ color: marker }), 400, "invalid-request");
  expectError(await f.ack(device.headers, accepted.body.data.id, marker.repeat(100)), 413, "body-too-large");
  expectError(await f.list(device.headers, "?limit=101"), 400, "invalid-request");
  const debug = await f.call("/api/debug/events", bearer("owner-a-fixture"));
  assert.equal(debug.status, 200);
  assert.equal(JSON.stringify(debug.body).includes(marker), false);
  assert.equal(logged.mock.callCount(), 0);
});
