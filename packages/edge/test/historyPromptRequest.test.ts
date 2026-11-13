import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OutboxStore } from "../src/outboxStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

test("#452 real history HTTP and resource events carry only the reader's durable intent association before receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "salon-history-binding-"));
  const path = join(directory, "state.sqlite"), store = new OutboxStore(path);
  const target = { principalId: "open-access", machine: "fixture", sessionId: "session-a", incarnation: "inc-a" };
  const claim = (principalId: string, id: string) => {
    const scoped = { ...target, principalId };
    store.admit(scoped, id, "Synthetic input", "credential-generation");
    return store.claim(store.candidate(scoped)!)!.item.request_id!;
  };
  const requestId = claim("open-access", "intent-a"), foreignId = claim("another-reader", "foreign-intent");
  const binding = { request_id: requestId, session_id: target.sessionId, session_incarnation: target.incarnation };
  const upstreamRows = [
    { id: "own", role: "user", text: "Provider projected text", prompt_request: { ...binding, private_proof: "not-public", outbox_intent_id: "untrusted-intent" } },
    { id: "foreign", role: "user", text: "Other reader", prompt_request: { ...binding, request_id: foreignId } },
    { id: "replaced", role: "user", text: "Other incarnation", prompt_request: { ...binding, session_incarnation: "inc-b" } },
    { id: "untracked", role: "user", text: "No durable attempt", prompt_request: { ...binding, request_id: "untracked-request", outbox_intent_id: "untrusted-intent" } },
    { id: "assistant", role: "assistant", text: "Provider reply", prompt_request: binding },
  ];
  const daemon = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: { messages: upstreamRows } }));
  });
  const upstream = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ accessDbPath: path,
    machines: [{ name: "fixture", url: upstream.base, token: "synthetic-token" }] }), { outboxPollIntervalMs: 60_000 });
  const { base } = await listenOnLoopback(edge), controller = new AbortController();
  type Row = { prompt_request?: typeof binding & { outbox_intent_id?: string; private_proof?: string } };
  const verify = (rows: Row[]) => {
    assert.equal(rows[0]?.prompt_request?.request_id, requestId);
    assert.equal(rows[0]?.prompt_request?.outbox_intent_id, "intent-a", "edge maps the attempt before its receipt settles");
    assert.equal(rows[0]?.prompt_request?.private_proof, undefined);
    assert.equal(rows[1]?.prompt_request?.outbox_intent_id, undefined, "another reader's intent is never exposed");
    assert.equal(rows[2]?.prompt_request?.outbox_intent_id, undefined, "mapping requires the exact incarnation");
    assert.equal(rows[3]?.prompt_request?.request_id, "untracked-request", "untracked request identity is still public");
    assert.equal(rows[3]?.prompt_request?.outbox_intent_id, undefined, "producer intent is stripped even without a durable attempt");
    assert.equal(rows[4]?.prompt_request, undefined, "assistant history never carries an accepted user association");
  };
  try {
    for (const direction of ["", "latest", "older"]) {
      const response = await fetch(`${base}/api/history/sessions/fixture/history-a/messages?direction=${direction}`);
      assert.equal(response.status, 200);
      verify((await response.json() as { data: { messages: Row[] } }).data.messages);
    }
    const query = new URLSearchParams({ conversations: JSON.stringify([{ machine: "fixture", id: "history-a" }]), conversation_snapshots: "1" });
    const response = await fetch(`${base}/api/resources/events?${query}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); let bytes = "";
    while (!bytes.includes('"conversation":')) {
      const part = await reader.read(); assert.equal(part.done, false);
      bytes += new TextDecoder().decode(part.value);
    }
    const data = bytes.split("\n").find(line => line.startsWith("data:") && line.includes('"conversation":'))!;
    verify((JSON.parse(data.slice(5)) as { conversation: { messages: Row[] } }).conversation.messages);
    await reader.cancel();
    assert.equal(store.get(target, "intent-a")?.state, "sending", "history projection never settles or replays an attempt");
  } finally {
    controller.abort(); edge.closeAllConnections(); daemon.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => edge.close(() => resolve())), new Promise<void>(resolve => daemon.close(() => resolve()))]);
    store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
