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

const replies = "/api/prompter/v1/replies";
const sourceTarget = { machine: "workstation", session_id: "source-session", incarnation: "source-inc" };
type ReplyReceipt = { receipt_id: string; status: string };

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
  const promptCalls: Record<string, unknown>[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  let promptMode: "sent" | "busy" | "lost" | "replaced" = "sent";
  let receiptVisible = false;
  let beforePrompt: (() => Promise<void>) | undefined;
  let beforeSnapshot: (() => Promise<void>) | undefined;
  const promptPath = "/sessions/source-session/prompt/v2";
  const daemon = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.example");
    if (req.headers.authorization !== "Bearer daemon-fixture") {
      res.writeHead(403); res.end(); return;
    }
    const respond = (status: number, envelope: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(envelope));
    };
    if (req.method === "POST" && url.pathname === promptPath) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      promptCalls.push(body);
      await beforePrompt?.();
      const code = promptMode === "busy" ? "busy" : promptMode === "replaced" ? "session-incarnation-conflict" : null;
      const receipt = { request_id: body.request_id, session_id: sourceTarget.session_id,
        session_incarnation: body.expected_session_incarnation, outcome: code ? "refused" : "submitted", code };
      receipts.set(String(body.request_id), receipt);
      if (promptMode === "lost") return void res.destroy();
      if (code) return respond(409, { ok: false, error: { code, details: { receipt } } });
      return respond(200, { ok: true, data: { submitted: true, session_incarnation: receipt.session_incarnation, receipt } });
    }
    if (req.method === "GET" && url.pathname.startsWith(promptPath + "/receipts/")) {
      const receipt = receipts.get(url.pathname.split("/").at(-1) ?? "");
      if (!receiptVisible || !receipt || url.searchParams.get("expected_session_incarnation") !== receipt.session_incarnation) {
        return respond(404, { ok: false, error: { code: "prompt-receipt-not-found" } });
      }
      return respond(200, { ok: true, data: { receipt } });
    }
    if (url.pathname !== "/sessions") return respond(404, { ok: false });
    await beforeSnapshot?.();
    respond(200, { ok: true, data: { coordination: { remote_messaging_supported: true },
      sessions: sessions.map(({ id, session_incarnation }) => ({
        id, session_incarnation, status: "running", coordination_mode: "advisory", coordination_available: true,
      })) } });
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
  const reply = (headers: Record<string, string>, id: string, fields: Record<string, unknown> = {}) =>
    call<ReplyReceipt>(replies, headers, { idempotency_key: "fixture-reply", message_id: id, target: sourceTarget,
      text: "Use the second draft.", confirmation: "physical", ...fields });
  const status = (headers: Record<string, string>, selector: string) =>
    call<ReplyReceipt>(replies + "/status?" + selector, headers);
  return {
    call, pair, submit, list, ack, sessions, reply, status, promptCalls,
    setPromptMode(mode: typeof promptMode) { promptMode = mode; },
    revealReceipt() { receiptVisible = true; },
    onPrompt(hook: typeof beforePrompt) { beforePrompt = hook; },
    onSnapshot(hook: typeof beforeSnapshot) { beforeSnapshot = hook; },
    revoke: (id: string) => call(`/api/auth/devices/${id}`, bearer("owner-a-fixture"), undefined, "DELETE"),
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

test("concurrent companion replies share one receipt and one fenced owner prompt", async t => {
  const f = await fixture(t);
  const device = await f.pair();
  const message = await f.submit();
  assert.equal(message.status, 201);
  const id = message.body.data.id;
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.onPrompt(async () => { received.resolve(); await release.promise; });
  const first = f.reply(device.headers, id);
  try {
    // On a server without the reply route the first request returns before dispatch.
    const dispatched = await Promise.race([received.promise.then(() => true), first.then(() => false)]);
    assert.equal(dispatched, true, "reply must dispatch the originating prompt");
    const duplicate = await f.reply(device.headers, id);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.data.status, "uncertain");
    assert.equal(f.promptCalls.length, 1);
    assert.deepEqual(f.promptCalls[0], {
      request_id: duplicate.body.data.receipt_id, expected_session_incarnation: "source-inc", require_idle: true,
      text: "[Companion reply]\nUse the second draft.",
    });
    expectError(await f.reply(device.headers, id, { text: "Use the first draft." }), 409, "idempotency-key-conflict");
    release.resolve();
    const original = await first;
    assert.equal(original.status, 200);
    assert.deepEqual(original.body.data, { receipt_id: duplicate.body.data.receipt_id, status: "sent" });
    await f.restart();
    assert.deepEqual((await f.reply(device.headers, id)).body.data, original.body.data);
    assert.equal(f.promptCalls.length, 1);
  } finally {
    release.resolve();
    await first;
  }
});

test("companion replies fence stale snapshots and replacement at daemon admission", async t => {
  const f = await fixture(t);
  const device = await f.pair();
  const message = await f.submit();
  assert.equal(message.status, 201);
  const id = message.body.data.id;
  expectError(await f.reply(device.headers, id, { target: { ...sourceTarget, incarnation: "replaced-inc" } }),
    409, "reply-target-mismatch");
  f.sessions[0]!.session_incarnation = "replaced-inc";
  const stale = await f.reply(device.headers, id);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.data.status, "refused");
  assert.equal(f.promptCalls.length, 0);

  f.sessions[0]!.session_incarnation = "source-inc";
  f.setPromptMode("replaced");
  const fenced = await f.reply(device.headers, id, { idempotency_key: "admission-race" });
  assert.equal(fenced.status, 200);
  assert.equal(fenced.body.data.status, "refused");
  assert.equal(f.promptCalls.length, 1);
  assert.equal(f.promptCalls[0]?.expected_session_incarnation, "source-inc");
});

test("companion status lookup recovers a lost reply acknowledgement without resending", async t => {
  const f = await fixture(t);
  const device = await f.pair();
  const message = await f.submit();
  assert.equal(message.status, 201);
  f.setPromptMode("lost");
  const marker = "fixture-reply-text-marker";
  const logged = t.mock.method(console, "error", () => {});
  const reply = await f.reply(device.headers, message.body.data.id, { text: marker });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.data.status, "uncertain");
  const { receipt_id: receiptId } = reply.body.data;
  const unavailable = await f.status(device.headers, "idempotency_key=fixture-reply");
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.body.data, reply.body.data);
  await f.restart();
  f.revealReceipt();
  const resolved = await f.status(device.headers, `receipt_id=${receiptId}`);
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body.data, { receipt_id: receiptId, status: "sent" });
  assert.deepEqual((await f.status(device.headers, "idempotency_key=fixture-reply")).body.data, resolved.body.data);
  assert.equal(f.promptCalls.length, 1);
  const debug = await f.call("/api/debug/events", bearer("owner-a-fixture"));
  assert.equal(debug.status, 200);
  const diagnostics = JSON.stringify(debug.body);
  assert.equal(diagnostics.includes(marker), false);
  assert.equal(diagnostics.includes(device.headers.authorization!), false);
  assert.equal(logged.mock.callCount(), 0);
});

test("companion replies and receipt lookups refuse other owners and revoked devices", async t => {
  const f = await fixture(t);
  const device = await f.pair();
  const other = await f.pair("owner-b");
  const message = await f.submit();
  assert.equal(message.status, 201);
  const id = message.body.data.id;
  expectError(await f.reply(other.headers, id), 404, "message-not-found");
  expectError(await f.reply(bearer("owner-a-fixture"), id), 403, "device-required");
  const accepted = await f.reply(device.headers, id);
  assert.equal(accepted.status, 200);
  const selector = `receipt_id=${accepted.body.data.receipt_id}`;
  expectError(await f.status(other.headers, selector), 404, "receipt-not-found");
  expectError(await f.status(other.headers, "idempotency_key=fixture-reply"), 404, "receipt-not-found");
  assert.equal((await f.revoke(device.id)).status, 200);
  expectError(await f.reply(device.headers, id, { idempotency_key: "revoked" }), 401, "unauthorized");
  expectError(await f.status(device.headers, selector), 401, "unauthorized");
  assert.equal(f.promptCalls.length, 1);
});

test("companion reply rechecks device revocation after the session snapshot", async t => {
  const f = await fixture(t);
  const device = await f.pair();
  const message = await f.submit();
  assert.equal(message.status, 201);
  const observed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.onSnapshot(async () => { observed.resolve(); await release.promise; });
  const reply = f.reply(device.headers, message.body.data.id);
  try {
    const checked = await Promise.race([observed.promise.then(() => true), reply.then(() => false)]);
    assert.equal(checked, true, "reply must check the live session");
    assert.equal((await f.revoke(device.id)).status, 200);
    release.resolve();
    expectError(await reply, 401, "unauthorized");
    assert.equal(f.promptCalls.length, 0);
  } finally {
    release.resolve();
    await reply;
  }
});

test("companion reply refuses test confirmation and unsafe text and reports busy", async t => {
  const f = await fixture(t);
  const device = await f.pair();
  const message = await f.submit();
  assert.equal(message.status, 201);
  const id = message.body.data.id;
  expectError(await f.reply(device.headers, id, { confirmation: "test" }), 403, "confirmation-required");
  expectError(await f.reply(device.headers, id, { text: "unsafe\u001b" }), 400, "invalid-request");
  expectError(await f.reply(device.headers, id, { text: "é".repeat(2049) }), 413, "body-too-large");
  assert.equal(f.promptCalls.length, 0);
  f.setPromptMode("busy");
  const busy = await f.reply(device.headers, id);
  assert.equal(busy.status, 200);
  assert.equal(busy.body.data.status, "busy");
  assert.deepEqual((await f.reply(device.headers, id)).body.data, busy.body.data);
  assert.equal(f.promptCalls.length, 1);
});
