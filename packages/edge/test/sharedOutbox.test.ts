import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

const target = "/api/sessions/fixture/session-a/outbox";
const incarnation = "incarnation-a";
const admission = { text: "Synthetic shared pending reply", expected_session_incarnation: incarnation };
async function stop(server: Server) {
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// Independent authenticated HTTP clients are the server boundary. The UI slice
// additionally uses isolated browser contexts; no browser store is shared here.
test("two independently authenticated clients read the same durable admitted intent after edge restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "console-shared-outbox-"));
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [{ id: "session-a", status: "running", agent: "codex",
        session_incarnation: incarnation, provider_resume: { provider: "codex", session_id: "provider-a" },
        turn_state: { schema_version: "agent-session.turn-state.v1", phase: "needs_input", revision: 1,
          phase_changed_at: "2030-01-01T00:00:00Z", source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
          current_turn: { started_at: "2030-01-01T00:00:00Z",
            attention: { kind: "approval", requested_at: "2030-01-01T00:00:00Z", pending_count: 1, certainty: "exact" } } },
      }] } }));
    } else {
      res.writeHead(404); res.end(JSON.stringify({ ok: false, error: { code: "not-found" } }));
    }
  });
  const upstream = await listenOnLoopback(daemon);
  const config = makeEdgeConfig({ openAccess: false, clientToken: "client-secret", accessDbPath: join(directory, "state.sqlite"),
    machines: [{ name: "fixture", url: upstream.base, token: "synthetic-upstream" }] });
  let edge = createEdgeServer(config);
  try {
    let { base } = await listenOnLoopback(edge);
    const cookieA = await loginCookie(base), cookieB = await loginCookie(base);
    assert.notEqual(cookieA, cookieB, "clients authenticate independently");
    const response = await fetch(`${base}${target}/intent-a`, { method: "PUT",
      headers: { "x-console-expected-principal": "legacy", cookie: cookieA, origin: base, "content-type": "application/json" }, body: JSON.stringify(admission) });
    assert.equal(response.status, 201, "edge durably admits the pending reply before acknowledging it");
    const created = await response.json() as { data: { item: { id: string; text: string; state: string } } };
    assert.equal(created.data.item.id, "intent-a");
    assert.equal(created.data.item.text, admission.text);
    const list = async (cookie: string) => {
      const result = await fetch(`${base}${target}?expected_session_incarnation=${incarnation}`, { headers: { cookie, "x-console-expected-principal": "legacy" } });
      assert.equal(result.status, 200);
      return (await result.json() as { data: { items: typeof created.data.item[] } }).data.items;
    };
    // Direct dispatch may advance the row between consecutive client reads.
    // Let this unsupported fixture endpoint settle, then compare both views.
    for (let n = 0; n < 100 && (await list(cookieA))[0]?.state !== "unknown"; n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await list(cookieA))[0]?.state, "unknown");
    assert.deepEqual(await list(cookieB), await list(cookieA), "another client sees the same authoritative item");
    await stop(edge);
    edge = createEdgeServer(config);
    ({ base } = await listenOnLoopback(edge));
    const reconnected = await list(await loginCookie(base));
    assert.equal(reconnected.length, 1, "restart retains exactly one intent");
    assert.equal(reconnected[0]!.id, "intent-a");
    assert.equal(reconnected[0]!.text, admission.text);
  } finally {
    await stop(edge); await stop(daemon);
    rmSync(directory, { recursive: true, force: true });
  }
});

import { OutboxStore } from "../src/outboxStore.ts";
import { AccessStore } from "../src/accessStore.ts";
import type { SharedOutboxItem, SharedOutboxSnapshot } from "@agent-console/shared/shared-outbox";

async function fixture(t: import("node:test").TestContext, multiUser = false) {
  t.mock.timers.enable({ apis: ["Date"], now: 1_900_000_000_000 });
  const directory = mkdtempSync(join(tmpdir(), "console-shared-delivery-"));
  const statePath = join(directory, "state.sqlite");
  const state = { incarnation, provider: "codex", phase: "working", revision: 1, mode: "busy", posts: [] as Record<string, unknown>[],
    lookups: [] as string[], receipts: new Map<string, unknown>(), submitted: 0, lookup: "normal", lookupWait: undefined as Promise<void> | undefined };
  const daemon = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") return void res.end(JSON.stringify({ ok: true, data: { sessions: [
      { id: "session-a", status: "running", agent: state.provider, session_incarnation: state.incarnation,
        provider_resume: { provider: state.provider, session_id: "provider-a" },
        turn_state: { schema_version: "agent-session.turn-state.v1", phase: state.phase, revision: state.revision,
          phase_changed_at: new Date(Date.now() - 10_000).toISOString(),
          ...(state.phase === "working" ? { current_turn: { started_at: new Date(Date.now() - 10_000).toISOString() } } : {}),
          source: { kind: "provider_hook", provider: state.provider, confidence: "authoritative" } } },
    ] } }));
    if (req.method === "POST" && req.url === "/sessions/session-a/prompt/v2") {
      let text = ""; for await (const chunk of req) text += String(chunk);
      const body = JSON.parse(text) as Record<string, unknown>; state.posts.push(body);
      const receipt = { request_id: body.request_id, session_id: "session-a", session_incarnation: body.expected_session_incarnation,
        outcome: state.mode === "busy" ? "refused" : state.mode.startsWith("command") ? "command_dispatched" : "submitted",
        code: state.mode === "busy" ? "busy" : null };
      if (state.mode === "busy") {
        state.receipts.set(String(body.request_id), receipt);
        res.writeHead(409); return void res.end(JSON.stringify({ ok: false, error: { code: "busy", details: { receipt } } }));
      }
      if (state.mode === "conflict") {
        res.writeHead(409); return void res.end(JSON.stringify({ ok: false, error: { code: "request-id-conflict" } }));
      }
      if (!state.receipts.has(String(body.request_id))) state.submitted++;
      state.receipts.set(String(body.request_id), receipt);
      if (state.mode === "lost" || state.mode === "command-lost") return void req.socket.destroy();
      if (state.mode === "command") return void res.end(JSON.stringify({ ok: true, data: { receipt, submitted: false, command_dispatched: true, session_incarnation: state.incarnation } }));
      if (state.mode === "malformed") return void res.end(JSON.stringify({ ok: true, data: { receipt } }));
      return void res.end(JSON.stringify({ ok: true, data: { receipt, submitted: true, session_incarnation: state.incarnation } }));
    }
    if (req.url?.startsWith("/sessions/session-a/prompt/v2/receipts/")) {
      const id = req.url.split("/receipts/")[1]!.split("?")[0]!; state.lookups.push(id);
      await state.lookupWait;
      const receipt = state.lookup === "missing" ? undefined : state.receipts.get(id);
      if (receipt) return void res.end(JSON.stringify({ ok: true, data: { receipt } }));
      res.writeHead(404); return void res.end(JSON.stringify({ ok: false, error: { code: "prompt-receipt-not-found" } }));
    }
    res.writeHead(404); res.end(JSON.stringify({ ok: false, error: { code: "not-found" } }));
  });
  const upstream = await listenOnLoopback(daemon);
  const config = makeEdgeConfig({ openAccess: false, clientToken: multiUser ? "" : "client-secret", accessDbPath: statePath,
    multiUser, principals: multiUser ? [
      { id: "alice", token: "alice-secret", machines: ["fixture"], permissions: [] },
      { id: "bob", token: "bob-secret", machines: ["fixture"], permissions: [] },
    ] : [], machines: [{ name: "fixture", url: upstream.base, token: "synthetic-upstream" }] });
  if (multiUser) {
    const ownership = new AccessStore(statePath);
    ownership.claimSession({ principalId: "alice", machine: "fixture", sessionId: "session-a", incarnation }); ownership.close();
  }
  let edge = createEdgeServer(config, { outboxPollIntervalMs: 20 });
  let { base } = await listenOnLoopback(edge);
  let cookie = await loginCookie(base, multiUser ? "alice-secret" : "client-secret");
  const request = (suffix = "", method = "GET", body?: unknown, auth = cookie, origin = base) =>
    fetch(`${base}${target}${suffix}`, { method, headers: { "x-console-expected-principal": multiUser ? "alice" : "legacy", cookie: auth, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const list = async () => {
    const res = await request(`?expected_session_incarnation=${incarnation}`); assert.equal(res.status, 200);
    return (await res.json() as { data: SharedOutboxSnapshot }).data;
  };
  const admit = async (id = "intent-a", text = admission.text) => {
    const res = await request(`/${id}`, "PUT", { ...admission, text }); assert.equal(res.status, 201);
    return (await res.json() as { data: { item: SharedOutboxItem } }).data.item;
  };
  const until = async (check: () => Promise<boolean> | boolean) => {
    for (let n = 0; n < 150; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail("expected outbox transition did not occur");
  };
  t.after(async () => { await stop(edge); await stop(daemon); rmSync(directory, { recursive: true, force: true }); });
  return { state, request, admit, list, until, config, statePath,
    lifecycle: (suffix: string, method: string, body?: unknown) => fetch(`${base}/api/sessions/fixture/session-a${suffix}`,
      { method, headers: { cookie, origin: base, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    advance: () => t.mock.timers.tick(6_000),
    otherCookie: () => loginCookie(base, "bob-secret"),
    restart: async (duringStop?: () => void) => {
      await stop(edge); duringStop?.(); edge = createEdgeServer(config, { outboxPollIntervalMs: 20 });
      ({ base } = await listenOnLoopback(edge)); cookie = await loginCookie(base, multiUser ? "alice-secret" : "client-secret");
    },
  };
}

// This boundary proves Console dispatch behavior against a controlled daemon;
// it is not proof of a real provider's native acceptance or steering.
test("immediate native handoff forwards both working providers without an idle condition or grace period", async t => {
  for (const provider of ["claude", "codex"]) await t.test(provider, async t => {
    const f = await fixture(t);
    f.state.provider = provider;
    f.state.mode = "submitted";
    await f.admit();
    // The fixture clock stays frozen: no cancellation grace or idle transition.
    await f.until(async () => (await f.list()).items[0]?.state === "submitted");
    assert.equal(f.state.phase, "working");
    assert.equal(f.state.posts.length, 1);
    assert.equal(f.state.posts[0]!.require_idle, false);
    assert.equal(f.state.posts[0]!.expected_session_incarnation, incarnation);
    assert.equal(typeof f.state.posts[0]!.request_id, "string");
    await f.restart();
    await f.list();
    assert.equal(f.state.posts.length, 1, "restart must not repeat native handoff");
  });
});

test("immediate native handoff sends a distinct follow-up without resolving or replaying an earlier unknown", async t => {
  const f = await fixture(t);
  f.state.mode = "lost"; f.state.lookup = "missing";
  await f.admit("original"); f.advance();
  await f.until(async () => (await f.list()).items[0]?.state === "unknown");
  const original = (await f.list()).items[0]!;
  f.state.mode = "submitted";
  await f.admit("follow-up", "A separate correction during active work");
  await f.until(async () => (await f.list()).items[1]?.state === "submitted");
  const snapshot = await f.list();
  assert.equal(snapshot.items[0]!.state, "unknown");
  assert.equal(snapshot.items[0]!.request_id, original.request_id);
  assert.equal(f.state.posts.length, 2);
  assert.notEqual(f.state.posts[1]!.request_id, original.request_id);
  assert.equal(f.state.posts[1]!.require_idle, false);
});

test("an unresolved receipt lookup cannot delay native handoff of a new deliberate input", async t => {
  const f = await fixture(t);
  f.state.mode = "lost"; f.state.lookup = "missing";
  await f.admit("original");
  await f.until(async () => (await f.list()).items[0]?.state === "unknown");
  let release = () => {};
  f.state.lookupWait = new Promise<void>(resolve => { release = resolve; });
  try {
    const previousLookups = f.state.lookups.length;
    await f.until(() => f.state.lookups.length > previousLookups);
    f.state.mode = "submitted";
    await f.admit("new-input", "Correction while receipt lookup is unavailable");
    await f.until(() => f.state.posts.length === 2);
    assert.notEqual(f.state.posts[0]!.request_id, f.state.posts[1]!.request_id);
    assert.equal((await f.list()).items[0]!.state, "unknown");
  } finally { release(); }
});

test("retired post-send editing and pause APIs cannot mutate an admitted reply", async t => {
  const f = await fixture(t);
  const original = await f.admit();
  for (const operation of ["begin_edit", "save_edit", "release_edit", "cancel", "begin_compose", "release_compose"]) {
    const collection = operation.endsWith("compose");
    const response = await f.request(collection ? "" : "/intent-a", "PATCH", {
      expected_session_incarnation: incarnation, base_revision: original.revision,
      operation, ...(operation === "cancel" ? {} : { hold_id: "retired-edit" }),
      ...(operation === "save_edit" ? { text: "must not replace submitted content" } : {}),
    });
    assert.equal(response.status, 410, `${operation} must be retired, not merely hidden`);
  }
  const snapshot = await f.list();
  assert.equal(snapshot.items[0]!.text, original.text);
  assert.equal(snapshot.items[0]!.edit_hold, null);
  assert.deepEqual(snapshot.compose_holds, []);
});

test("a definite refusal remains terminal while a distinct working-turn follow-up dispatches once", async t => {
  const f = await fixture(t); await f.admit();
  assert.equal((await f.request("/intent-a", "PUT", admission)).status, 200);
  assert.equal((await f.request("/intent-a", "PUT", { ...admission, text: "different" })).status, 409);
  f.advance(); await f.until(() => f.state.posts.length === 1);
  await f.until(async () => (await f.list()).items[0]?.state === "refused");
  assert.equal(f.state.submitted, 0);
  f.state.mode = "submitted";
  await f.admit("intent-b", "A separate follow-up");
  await f.until(async () => (await f.list()).items[1]?.state === "submitted");
  assert.equal((await f.list()).items[0]?.state, "refused", "no automatic retry of the refused original");
  assert.equal(f.state.posts.length, 2); assert.equal(f.state.submitted, 1);
  assert.notEqual(f.state.posts[0]!.request_id, f.state.posts[1]!.request_id);
  assert.ok(f.state.posts.every(p => p.require_idle === false && p.expected_session_incarnation === incarnation));
  await f.restart(); f.advance(); await f.list();
  assert.equal(f.state.posts.length, 2, "a submitted item must never be replayed after restart");
});

test("lost or malformed acknowledgement reconciles the original key without a second POST", async t => {
  for (const mode of ["lost", "malformed"]) await t.test(mode, async t => {
    const f = await fixture(t); f.state.mode = mode; f.state.lookup = "missing";
    await f.admit(); f.advance();
    await f.until(async () => (await f.list()).items[0]?.state === "unknown");
    const first = f.state.posts[0]!.request_id;
    await f.restart(); f.advance();
    await f.until(() => f.state.lookups.length > 0);
    assert.equal(f.state.posts.length, 1); assert.equal(f.state.submitted, 1);
    const uncertain = (await f.list()).items[0]!;
    assert.equal((await f.request("/intent-a", "PATCH", { expected_session_incarnation: incarnation,
      base_revision: uncertain.revision, operation: "retry" })).status, 410);
    f.state.lookup = "normal";
    await f.until(async () => (await f.list()).items[0]?.state === "submitted");
    assert.ok(f.state.lookups.every(key => key === first)); assert.equal(f.state.posts.length, 1);
  });
});

test("a command_dispatched receipt completes the reply without transcript proof, retry or a second POST", async t => {
  for (const mode of ["command", "command-lost"]) await t.test(mode, async t => {
    const f = await fixture(t); f.state.mode = mode;
    // While the receipt is not yet readable the lost acknowledgement stays unknown.
    if (mode === "command-lost") f.state.lookup = "missing";
    await f.admit(); f.advance();
    await f.until(async () => (await f.list()).items[0]?.state === (mode === "command" ? "command_dispatched" : "unknown"));
    if (mode === "command-lost") {
      await f.restart(); f.advance();
      await f.until(() => f.state.lookups.length > 0);
      f.state.lookup = "normal";
      await f.until(async () => (await f.list()).items[0]?.state === "command_dispatched");
    } else assert.equal(f.state.lookups.length, 0);
    const done = (await f.list()).items[0]!;
    assert.equal(done.receipt?.outcome, "command_dispatched"); assert.equal(done.error_code, null);
    assert.equal((await f.request("/intent-a", "PATCH", { expected_session_incarnation: incarnation,
      base_revision: done.revision, operation: "retry_refused" })).status, 409);
    await f.restart(); f.advance(); await f.list();
    assert.equal(f.state.posts.length, 1); assert.equal(f.state.submitted, 1);
    assert.equal((await f.list()).items[0]?.state, "command_dispatched");
    assert.equal((await f.request("/intent-a", "PUT", { ...admission })).status, 200);
    assert.equal(f.state.posts.length, 1);
  });
});

test("request-ID conflict is retained without looking up another payload's receipt", async t => {
  const f = await fixture(t); f.state.mode = "conflict"; await f.admit(); f.advance();
  await f.until(async () => (await f.list()).items[0]?.state === "refused");
  await f.restart(); f.advance(); await f.list();
  assert.equal(f.state.posts.length, 1); assert.equal(f.state.lookups.length, 0);
});

test("a durable claim before POST survives restart as unknown and is never sent", async t => {
  const f = await fixture(t); await f.admit();
  await f.restart(() => {
    const db = new OutboxStore(f.statePath);
    const scope = { principalId: "legacy", machine: "fixture", sessionId: "session-a", incarnation };
    const candidate = db.candidate(scope, Date.now() + 6_000)!;
    assert.ok(db.claim(candidate, Date.now() + 6_000)); db.close();
  });
  f.advance(); await f.until(async () => (await f.list()).items[0]?.state === "unknown");
  assert.equal(f.state.posts.length, 0); assert.ok(f.state.lookups.length > 0);
});

test("ownership, CSRF and actual incarnation fence admission and subsequent delivery", async t => {
  const f = await fixture(t, true); const bob = await f.otherCookie();
  assert.equal((await f.request("/intent-a", "PUT", admission, bob)).status, 404);
  assert.equal((await f.request(`?expected_session_incarnation=${incarnation}`, "GET", undefined, bob)).status, 404);
  assert.equal((await f.request("/intent-a", "PUT", admission, undefined, "https://invalid.example")).status, 403);
  assert.equal((await f.request("/intent-a", "PUT", { ...admission, expected_session_incarnation: "old" })).status, 409);
  await f.admit(); f.state.incarnation = "replacement"; f.advance();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.state.posts.length, 0);
});

test("retained admitted replies still protect lifecycle operations after action retirement", async t => {
  const f = await fixture(t); await f.admit();
  assert.equal((await f.lifecycle("", "DELETE")).status, 409);
  assert.equal((await f.lifecycle("/archive", "POST", { expected_session_incarnation: incarnation })).status, 409);
  assert.equal((await f.list()).items[0]!.text, admission.text);
});

test("a second edge process sharing the DB cannot POST an already claimed intent", async t => {
  const f = await fixture(t); f.state.mode = "submitted";
  const other = createEdgeServer(f.config, { outboxPollIntervalMs: 20 });
  await listenOnLoopback(other); t.after(() => stop(other));
  await f.admit(); f.advance();
  await f.until(async () => (await f.list()).items[0]?.state === "submitted");
  assert.equal(f.state.posts.length, 1); assert.equal(f.state.submitted, 1);
});

test("changed machine credentials do not inherit queued submission", async t => {
  const f = await fixture(t); await f.admit();
  // Same principal ID after an operator changes its token is a new admission
  // authority. Preserve text, but do not submit the old authorized intention.
  Object.assign(f.config.machines[0]!, { token: "rotated-synthetic-upstream" });
  f.advance(); await f.until(async () => (await f.list()).items[0]?.state === "refused");
  assert.equal(f.state.posts.length, 0);
  assert.equal((await f.list()).items[0]?.error_code, "outbox-authorization-changed");
});

test("an unavailable durable DB does not acknowledge an in-memory shared queue", async t => {
  const edge = createEdgeServer(makeEdgeConfig({ accessDbPath: null }));
  const { base } = await listenOnLoopback(edge); t.after(() => stop(edge));
  const response = await fetch(`${base}${target}/intent-a`, { method: "PUT", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(admission) });
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "outbox-durability-unavailable");
});

test("client-supplied authority and stale compose targets are rejected before storage", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/intent-a", "PUT", { ...admission, principal_id: "another-owner" })).status, 400);
  assert.equal((await f.request("", "PATCH", { expected_session_incarnation: "stale", base_revision: 0,
    operation: "begin_compose", hold_id: "draft-a" })).status, 410);
  assert.equal((await f.list()).items.length, 0);
});

test("discard of a refused reply is durable and shared, including an old incarnation, and sends nothing", async t => {
  for (const multiUser of [false, true]) await t.test(multiUser ? "session owner" : "legacy principal", async t => {
    const f = await fixture(t, multiUser);
    await f.admit();
    await f.until(async () => (await f.list()).items[0]?.state === "refused");
    const refused = (await f.list()).items[0]!;
    f.state.incarnation = "replacement";
    if (multiUser) {
      const ownership = new AccessStore(f.statePath);
      ownership.claimSession({ principalId: "alice", machine: "fixture", sessionId: "session-a", incarnation: "replacement" });
      ownership.close();
    }
    const posts = f.state.posts.length;
    const response = await f.request("/intent-a", "PATCH", { operation: "discard_refused", base_revision: refused.revision,
      expected_session_incarnation: incarnation });
    assert.equal(response.status, 200);
    assert.equal((await f.list()).items[0]?.state, "cancelled");
    await f.restart();
    assert.equal((await f.list()).items[0]?.state, "cancelled", "another authenticated viewer after restart sees the recorded discard");
    assert.equal(f.state.posts.length, posts);
  });
});

test("retry of a refused reply is incarnation fenced, revision fenced, and uses a new provider request once", async t => {
  const f = await fixture(t);
  await f.admit();
  await f.until(async () => (await f.list()).items[0]?.state === "refused");
  const refused = (await f.list()).items[0]!;
  const action = { operation: "retry_refused", base_revision: refused.revision, expected_session_incarnation: incarnation };
  f.state.incarnation = "replacement";
  assert.equal((await f.request("/intent-a", "PATCH", action)).status, 409);
  assert.equal(f.state.posts.length, 1);
  f.state.incarnation = incarnation; f.state.mode = "submitted";
  assert.equal((await f.request("/intent-a", "PATCH", action)).status, 200);
  assert.equal((await f.request("/intent-a", "PATCH", action)).status, 409, "double click or lost-ack replay cannot schedule another attempt");
  await f.until(async () => (await f.list()).items[0]?.state === "submitted");
  assert.equal(f.state.posts.length, 2);
  assert.notEqual(f.state.posts[0]?.request_id, f.state.posts[1]?.request_id);
  assert.equal(f.state.posts[1]?.text, refused.text);
  const submitted = (await f.list()).items[0]!;
  assert.equal((await f.request("/intent-a", "PATCH", { ...action, operation: "discard_refused", base_revision: submitted.revision })).status, 409,
    "discard must never hide an input that may have been sent");
});
