import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import type { EdgeExtension, EdgeFirstReplyQuery, EdgeRoute } from "../src/extensions.ts";
import { OutboxStore } from "../src/outboxStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const createdAt = "2026-01-01T00:00:00Z";
const replyAt = "2026-01-01T00:02:00Z";
const target = {
  machine: "fixture", sessionId: "fixture-session",
  sessionCreatedAt: createdAt, sessionIncarnation: "fixture-incarnation",
};
const principalId = "owner";
const historyId = "h-" + "a".repeat(64);
const pathPrefix = "/api/ext/fixture";
const assistant = (order: number, text: string, timestamp = replyAt) =>
  ({ id: `${historyId}-${order}`, role: "assistant", text, timestamp });

interface Variant {
  readonly readCapability?: boolean;
  readonly admitCapability?: boolean;
  readonly bridge?: { readonly machines?: string[]; readonly permissions?: string[] } | null;
}

/** `onBehalf` stores the input as an owner-bound record admitted by the bridge principal. */
async function fixture(t: TestContext, provider: "codex" | "claude" = "codex", historyOwner = principalId,
  onBehalf?: Variant) {
  const directory = mkdtempSync(join(tmpdir(), "extension-conversation-"));
  const path = join(directory, "state.sqlite");
  const ownership = new AccessStore(path);
  ownership.claimSession({ principalId, machine: target.machine, sessionId: target.sessionId,
    incarnation: target.sessionIncarnation });
  ownership.claimHistory(historyOwner, target.machine, historyId, provider, "fixture-thread");

  const store = new OutboxStore(path);
  const { entry } = store.admitExtensionInput(
    { principalId: onBehalf ? "bridge" : principalId, extensionId: "fixture", channel: "companion", inputId: "fixture-input" },
    { target: { principalId, machine: target.machine, sessionId: target.sessionId, incarnation: target.sessionIncarnation },
      source: { channel: "companion", label: "Companion", prefix: "" },
      grant: onBehalf ? { routeKey: "fixture:relay", permission: "relay", callerPrincipalId: "bridge" }
        : { routeKey: "fixture:inputs", permission: "debug" } },
    "Example question", "fixture-generation", null,
  );
  const attempt = store.claim(store.candidate(entry.target)!)!;
  const receipt = { request_id: attempt.item.request_id!, session_id: target.sessionId,
    session_incarnation: target.sessionIncarnation };
  store.settle(attempt, { ...receipt, outcome: "submitted", code: null });
  store.close();

  const input = { id: `${historyId}-200`, role: "user", text: "Example question", timestamp: "2026-01-01T00:03:00Z",
    prompt_request: receipt };
  const query: EdgeFirstReplyQuery = { target, outboxIntentId: entry.item.id };
  let current = { id: target.sessionId, created_at: createdAt, session_incarnation: target.sessionIncarnation,
    status: "stopped", agent: provider, provider_resume: { provider, session_id: "fixture-thread" } };
  let messages: unknown[] = [];
  let historyReads = 0;
  let olderCursor: string | null = null;
  let onHistoryRead: (() => void) | undefined;
  const daemon = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid");
    const data = (() => {
      if (url.pathname === "/sessions") return { sessions: [current] };
      if (url.pathname === "/history/sessions") return { sessions: [{
        id: historyId, provider, provider_session_id: "fixture-thread", cwd: "/workspace",
        created_at: createdAt, updated_at: replyAt,
      }] };
      if (url.pathname === `/history/sessions/${historyId}/messages` && url.searchParams.get("direction") === "latest") {
        historyReads++;
        onHistoryRead?.();
        return { messages, older_cursor: olderCursor, next_cursor: null };
      }
      return undefined;
    })();
    res.writeHead(data ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify({ ok: !!data, data }));
  });
  const upstream = await listenOnLoopback(daemon);
  const startEdge = (variant: Variant = {}) => {
    const reply: EdgeRoute["handle"] = async ctx => {
      ctx.sendJson(200, await ctx.conversation.firstReplyAfter(await ctx.readJsonBody() as EdgeFirstReplyQuery));
    };
    const extension: EdgeExtension = { id: "fixture", permissions: ["relay", "reply_read"], routes: [
      { id: "inputs", pattern: `${pathPrefix}/inputs`, methods: ["PUT"], permission: "debug", handle() {} },
      { id: "reply", pattern: `${pathPrefix}/reply`, methods: ["POST"], permission: "debug", handle: reply },
      { id: "relay", pattern: `${pathPrefix}/relay`, methods: ["PUT"], permission: "relay",
        ...(variant.admitCapability !== false && { outboxOwnerDispatch: true }), handle() {} },
      { id: "reply-read", pattern: `${pathPrefix}/reply-read`, methods: ["POST"], permission: "relay",
        ...(variant.readCapability !== false && { outboxOwnerReplyRead: true }), handle: reply },
      { id: "reply-alt", pattern: `${pathPrefix}/reply-alt`, methods: ["POST"], permission: "reply_read",
        outboxOwnerReplyRead: true, handle: reply },
      { id: "reply-plain", pattern: `${pathPrefix}/reply-plain`, methods: ["POST"], permission: "relay", handle: reply },
    ] };
    const bridge = variant.bridge === undefined ? {} : variant.bridge;
    return createEdgeServer(makeEdgeConfig({ openAccess: false, multiUser: true, accessDbPath: path,
      principals: [
        { id: principalId, token: "owner-fixture", machines: [target.machine], permissions: ["debug"] },
        { id: "other", token: "other-fixture", machines: [target.machine], permissions: ["debug"] },
        { id: "limited", token: "limited-fixture", machines: [target.machine], permissions: [] },
        ...(bridge ? [{ id: "bridge", token: "bridge-fixture", machines: bridge.machines ?? [target.machine],
          permissions: bridge.permissions ?? ["relay"] }] : []),
      ],
      machines: [{ name: target.machine, url: upstream.base, token: "daemon-fixture" }],
    }), { extensions: [extension] });
  };
  let edge = startEdge(onBehalf);
  t.after(async () => {
    for (const server of [edge, daemon]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    ownership.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let { base } = await listenOnLoopback(edge);
  const call = (value: EdgeFirstReplyQuery = query, token = "owner-fixture", route = "reply") =>
    fetch(base + pathPrefix + "/" + route, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  return { call, path, input, query,
    /** Read as the bridge through a route that declares the reply-read capability. */
    callRead: (value: EdgeFirstReplyQuery = query, token = "bridge-fixture", route = "reply-read") => call(value, token, route),
    async restart(variant: Variant) {
      edge.closeAllConnections();
      await new Promise<void>(resolve => edge.close(() => resolve()));
      edge = startEdge(variant);
      ({ base } = await listenOnLoopback(edge));
    },
    transferSession() {
      const other = new DatabaseSync(path);
      try { other.prepare("UPDATE session_ownership SET principal_id=? WHERE machine=? AND session_id=?")
        .run("other", target.machine, target.sessionId); }
      finally { other.close(); }
    }, receipt, historyReads: () => historyReads,
    setMessages: (...rows: unknown[]) => { messages = rows; },
    markEarlierRows: () => { olderCursor = "100"; },
    replaceIncarnation: () => { current = { ...current, session_incarnation: "replacement" }; },
    onHistoryRead: (action: () => void) => { onHistoryRead = action; },
    capabilities: async () => (await (await fetch(base + "/api/sessions", {
      headers: { authorization: "Bearer owner-fixture" },
    })).json()).data.capabilities,
  };
}

test("first reply is receipt-bound and stays at the same position across reads and input selectors", async t => {
  const f = await fixture(t);
  const first = assistant(300, "First reply");
  const earlier = assistant(100, "Earlier reply", "2026-01-01T00:01:00Z");
  const later = assistant(400, "Later reply", "2026-01-01T00:04:00Z");
  f.setMessages(earlier, f.input, first, later);
  const response = await f.call();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "found");
  assert.match(result.reply.event_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.reply, { event_id: result.reply.event_id, order: Date.parse(replyAt), text: "First reply", created_at: replyAt });
  // Repacking can move unchanged rows to different offsets.
  f.setMessages({ ...f.input, id: `${historyId}-370` }, { ...first, id: `${historyId}-470` },
    { ...later, id: `${historyId}-570` }, assistant(600, "New reply", "2026-01-01T00:05:00Z"));
  assert.deepEqual(await (await f.call({ target, receiptRequestId: f.receipt.request_id })).json(), result);
  assert.equal((await f.capabilities()).extension_first_reply, true);
});

test("only an observed receipt anchor permits none_yet", async t => {
  const f = await fixture(t);
  f.setMessages(assistant(100, "Earlier reply", "2026-01-01T00:01:00Z"), f.input);
  assert.deepEqual(await (await f.call()).json(), { status: "none_yet" });
  f.setMessages({ ...f.input, prompt_request: undefined }, assistant(300, "Unbound reply"));
  assert.deepEqual(await (await f.call()).json(), { status: "unavailable", reason: "receipt_not_in_history" });
  f.setMessages(f.input, assistant(400, "Out of order"), assistant(300, "Earlier row"));
  assert.deepEqual(await (await f.call()).json(), { status: "unavailable", reason: "history_order_unavailable" });
});

test("a tied or reversed assistant timestamp cannot establish a durable order", async t => {
  const f = await fixture(t);
  for (const timestamp of [replyAt, "2026-01-01T00:01:00Z"]) {
    f.setMessages(f.input, assistant(300, "First reply"), assistant(400, "Second reply", timestamp));
    assert.deepEqual(await (await f.call()).json(), { status: "unavailable", reason: "history_order_unavailable" });
  }
});

test("earlier unread rows prevent a durable assistant order even with a visible receipt", async t => {
  const f = await fixture(t);
  f.setMessages(f.input, assistant(300, "First reply"));
  f.markEarlierRows();
  assert.deepEqual(await (await f.call()).json(), { status: "unavailable", reason: "history_order_unavailable" });
});

test("rejects an incorrect session creation time and a history anchor or live session from another incarnation", async t => {
  const f = await fixture(t);
  f.setMessages(f.input, assistant(300, "First reply"));
  const wrongTarget = { ...target, sessionCreatedAt: "2025-01-01T00:00:00Z" };
  assert.deepEqual(await (await f.call({ ...f.query, target: wrongTarget })).json(), { status: "wrong_incarnation" });
  f.setMessages({ ...f.input, prompt_request: { ...f.receipt, session_incarnation: "replacement" } }, assistant(300, "Other reply"));
  assert.deepEqual(await (await f.call()).json(), { status: "wrong_incarnation" });
  f.setMessages(f.input, assistant(300, "First reply"));
  f.onHistoryRead(f.replaceIncarnation);
  assert.deepEqual(await (await f.call()).json(), { status: "wrong_incarnation" });
});

test("first reply requires both the stored outbox namespace and history access", async t => {
  const f = await fixture(t, "codex", "other");
  assert.equal((await f.call(f.query, "unknown-fixture")).status, 401);
  assert.equal((await f.call(f.query, "limited-fixture")).status, 403);
  assert.deepEqual(await (await f.call(f.query, "other-fixture")).json(), { status: "unavailable", reason: "receipt_missing" });
  assert.deepEqual(await (await f.call()).json(), { status: "forbidden" });
  assert.equal(f.historyReads(), 0);
});

test("first reply caps text in UTF-8 without splitting a code point", async t => {
  const f = await fixture(t);
  f.setMessages(f.input, assistant(300, "a" + "🌱".repeat(5000)));
  const { status, reply } = await (await f.call()).json();
  assert.equal(status, "found");
  assert.equal(reply.text, "a" + "🌱".repeat(4095));
  assert.ok(Buffer.byteLength(reply.text) <= 16 * 1024);
});

test("Claude history without a receipt binding is unavailable", async t => {
  const f = await fixture(t, "claude");
  f.setMessages(f.input, assistant(300, "Unattributed reply"));
  assert.deepEqual(await (await f.call()).json(), { status: "unavailable", reason: "provider_order_unavailable" });
  assert.equal(f.historyReads(), 0);
});

const forbidden = { status: "forbidden" };

test("an on-behalf record yields the first reply after its own receipt through a route with the read capability", async t => {
  const f = await fixture(t, "codex", principalId, {});
  f.setMessages(assistant(100, "Earlier reply", "2026-01-01T00:01:00Z"), f.input, assistant(300, "First reply"),
    assistant(400, "Later reply", "2026-01-01T00:04:00Z"));
  const result = await (await f.callRead()).json();
  assert.equal(result.status, "found");
  assert.equal(result.reply.text, "First reply");
  assert.deepEqual(await (await f.callRead({ target, receiptRequestId: f.receipt.request_id })).json(), result);
});

test("an on-behalf read is refused without the read capability, for another namespace or receipt, and for another incarnation", async t => {
  const f = await fixture(t, "codex", principalId, {});
  f.setMessages(f.input, assistant(300, "First reply"));
  assert.deepEqual(await (await f.callRead(f.query, "bridge-fixture", "reply-plain")).json(), forbidden);
  assert.deepEqual(await (await f.callRead(f.query, "owner-fixture", "reply")).json(), { status: "unavailable", reason: "receipt_missing" });
  assert.deepEqual(await (await f.callRead({ target, receiptRequestId: "unrelated-receipt" })).json(),
    { status: "unavailable", reason: "receipt_missing" });
  assert.deepEqual(await (await f.callRead({ ...f.query, target: { ...target, sessionIncarnation: "replacement" } })).json(),
    { status: "wrong_incarnation" });
  assert.equal(f.historyReads(), 0);
  await f.restart({ readCapability: false });
  assert.deepEqual(await (await f.callRead()).json(), forbidden);
  assert.equal(f.historyReads(), 0);
});

test("an on-behalf read is refused after the owner changes", async t => {
  const f = await fixture(t, "codex", principalId, {});
  f.setMessages(f.input, assistant(300, "First reply"));
  f.transferSession();
  assert.deepEqual(await (await f.callRead()).json(), forbidden);
  assert.equal(f.historyReads(), 0);
});

test("an on-behalf read is refused when the admission route, the caller permission or the caller machine access is lost", async t => {
  const f = await fixture(t, "codex", principalId, {});
  f.setMessages(f.input, assistant(300, "First reply"));
  for (const variant of [{ admitCapability: false }, { bridge: { machines: [] } }, { bridge: null }] satisfies Variant[]) {
    await f.restart(variant);
    const response = await f.callRead();
    // A removed caller is unauthenticated; the others reach the facade and are refused.
    if (variant.bridge === null) assert.equal(response.status, 401);
    else assert.deepEqual(await response.json(), forbidden);
  }
  await f.restart({ bridge: { permissions: [] } });
  assert.equal((await f.callRead()).status, 403);
  assert.equal(f.historyReads(), 0);
});

test("an on-behalf read needs the owner's history access, not the caller's", async t => {
  const f = await fixture(t, "codex", "other", {});
  f.setMessages(f.input, assistant(300, "First reply"));
  assert.deepEqual(await (await f.callRead()).json(), forbidden);
});

test("an on-behalf read needs the caller to hold the admission route's permission, not only the reading route's", async t => {
  const f = await fixture(t, "codex", principalId, {});
  f.setMessages(f.input, assistant(300, "First reply"));
  await f.restart({ bridge: { permissions: ["relay", "reply_read"] } });
  assert.equal((await (await f.callRead(f.query, "bridge-fixture", "reply-alt")).json()).status, "found");
  await f.restart({ bridge: { permissions: ["reply_read"] } });
  assert.deepEqual(await (await f.callRead(f.query, "bridge-fixture", "reply-alt")).json(), forbidden);
});

test("an on-behalf read must name the stored machine, session and receipt", async t => {
  const f = await fixture(t, "codex", principalId, {});
  f.setMessages(f.input, assistant(300, "First reply"));
  const missing = { status: "unavailable", reason: "receipt_missing" };
  assert.deepEqual(await (await f.callRead({ ...f.query, target: { ...target, machine: "elsewhere" } })).json(), missing);
  assert.deepEqual(await (await f.callRead({ ...f.query, target: { ...target, sessionId: "another-session" } })).json(), missing);
  // An earlier attempt of the same intent resolves the entry but is not the stored receipt.
  const db = new DatabaseSync(f.path);
  try {
    const row = db.prepare("SELECT scope, intent_id FROM outbox_extension_inputs").get() as { scope: string; intent_id: string };
    db.prepare("INSERT INTO outbox_attempts(request_id,scope,intent_id,payload_hash) VALUES(?,?,?,?)")
      .run("earlier-attempt", row.scope, row.intent_id, "hash");
  } finally { db.close(); }
  assert.deepEqual(await (await f.callRead({ target, receiptRequestId: "earlier-attempt" })).json(), missing);
  assert.equal(f.historyReads(), 0);
});

test("an on-behalf read refuses a reply that follows another user's text, while a plain read is unchanged", async t => {
  const other = { id: `${historyId}-250`, role: "user", text: "Unrelated question", timestamp: "2026-01-01T00:03:30Z" };
  const rows = (f: { input: unknown }) => [f.input, other, assistant(300, "Reply to another input")];
  const onBehalf = await fixture(t, "codex", principalId, {});
  onBehalf.setMessages(...rows(onBehalf));
  assert.deepEqual(await (await onBehalf.callRead()).json(), { status: "unavailable", reason: "history_order_unavailable" });
  // A different receipt does not make intervening user text attributable to this input.
  onBehalf.setMessages(onBehalf.input, { ...other, prompt_request: { ...onBehalf.receipt, request_id: "other-request" } },
    assistant(300, "Reply to another input"));
  assert.deepEqual(await (await onBehalf.callRead()).json(), { status: "unavailable", reason: "history_order_unavailable" });
  // User text before the receipt cannot affect attribution of the later reply.
  onBehalf.setMessages({ ...other, id: `${historyId}-100` }, onBehalf.input, assistant(300, "First reply"));
  assert.equal((await (await onBehalf.callRead()).json()).status, "found");
  // Text after the reply cannot change which reply is first.
  onBehalf.setMessages(onBehalf.input, assistant(300, "First reply"), { ...other, id: `${historyId}-350` });
  assert.equal((await (await onBehalf.callRead()).json()).status, "found");
  const plain = await fixture(t);
  plain.setMessages(...rows(plain));
  assert.equal((await (await plain.call()).json()).status, "found");
});
