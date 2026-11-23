import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import type { EdgeExtension, EdgeFirstReplyQuery } from "../src/extensions.ts";
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

async function fixture(t: TestContext, provider: "codex" | "claude" = "codex", historyOwner = principalId) {
  const directory = mkdtempSync(join(tmpdir(), "extension-conversation-"));
  const path = join(directory, "state.sqlite");
  const ownership = new AccessStore(path);
  ownership.claimSession({ principalId, machine: target.machine, sessionId: target.sessionId,
    incarnation: target.sessionIncarnation });
  ownership.claimHistory(historyOwner, target.machine, historyId, provider, "fixture-thread");

  const store = new OutboxStore(path);
  const { entry } = store.admitExtensionInput(
    { principalId, extensionId: "fixture", channel: "companion", inputId: "fixture-input" },
    { target: { principalId, machine: target.machine, sessionId: target.sessionId, incarnation: target.sessionIncarnation },
      source: { channel: "companion", label: "Companion", prefix: "" },
      grant: { routeKey: "fixture:inputs", permission: "debug" } },
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
  const extension: EdgeExtension = { id: "fixture", routes: [
    { id: "inputs", pattern: `${pathPrefix}/inputs`, methods: ["PUT"], permission: "debug", handle() {} },
    { id: "reply", pattern: `${pathPrefix}/reply`, methods: ["POST"], permission: "debug",
      async handle(ctx) {
        ctx.sendJson(200, await ctx.conversation.firstReplyAfter(await ctx.readJsonBody() as EdgeFirstReplyQuery));
      },
    },
  ] };
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, multiUser: true, accessDbPath: path,
    principals: [
      { id: principalId, token: "owner-fixture", machines: [target.machine], permissions: ["debug"] },
      { id: "other", token: "other-fixture", machines: [target.machine], permissions: ["debug"] },
      { id: "limited", token: "limited-fixture", machines: [target.machine], permissions: [] },
    ],
    machines: [{ name: target.machine, url: upstream.base, token: "daemon-fixture" }],
  }), { extensions: [extension] });
  t.after(async () => {
    for (const server of [edge, daemon]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    ownership.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const { base } = await listenOnLoopback(edge);
  const call = (value: EdgeFirstReplyQuery = query, token = "owner-fixture") =>
    fetch(base + pathPrefix + "/reply", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  return { call, input, query, receipt, historyReads: () => historyReads,
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
