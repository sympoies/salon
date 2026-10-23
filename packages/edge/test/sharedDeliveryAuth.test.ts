import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { ActivityFeedSseDecoder } from "@agent-console/shared/activity";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shared-delivery-"));
  const path = join(root, "access.sqlite");
  const store = new AccessStore(path);
  for (const id of ["a", "b"]) {
    store.claimSession({ principalId: id, machine: "host", sessionId: id, incarnation: `inc-${id}` });
    store.claimHistory(id, "host", `history-${id}`, "codex", `provider-${id}`);
  }
  store.close();
  const sources = new Set<ServerResponse>();
  const connected = Promise.withResolvers<void>();
  let connections = 0; let historyReads = 0; let sequence = 0;
  const daemon = createServer((req, res) => {
    if (req.url === "/activity/events") {
      connections += 1; sources.add(res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n"); connected.resolve(); res.on("close", () => sources.delete(res)); return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      res.end(JSON.stringify({ ok: true, data: { sessions: ["a", "b"].map(id => ({ id, agent: "codex", status: "running", session_incarnation: `inc-${id}` })) } }));
    } else if (req.url?.startsWith("/history/sessions/")) {
      historyReads += 1;
      res.end(JSON.stringify({ ok: true, data: { messages: [{ id: "m", role: "assistant", text: "private transcript fixture" }] } }));
    } else { res.writeHead(404); res.end("{}"); }
  });
  const upstream = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, multiUser: true, accessDbPath: path,
    principals: ["a", "b"].map(id => ({ id, token: `token-${id}`, machines: ["host"], permissions: [] })),
    machines: [{ name: "host", url: upstream.base, token: "daemon-fixture" }] }));
  const { base } = await listenOnLoopback(edge);
  const emit = () => {
    sequence += 1;
    for (const res of sources) res.write(`event: snapshot\ndata: ${JSON.stringify({ schema_version: "agent-session.activity-stream.event.v1", type: "snapshot", stream_id: "shared-boot", sequence, machine: "host", observed_at: new Date().toISOString(), sessions: ["a", "b"].map(id => ({ id, turn_state: null })) })}\n\n`);
  };
  return { base, emit, connected: connected.promise, counts: () => ({ connections, historyReads, active: sources.size }), async close() {
    edge.closeAllConnections(); daemon.closeAllConnections();
    await Promise.all([edge, daemon].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    rmSync(root, { recursive: true, force: true });
  } };
}

test("resource history authorization rejects another principal before upstream access", async () => {
  const f = await fixture(); const control = new AbortController();
  try {
    const params = new URLSearchParams({ resources: "", conversations: JSON.stringify([{ machine: "host", id: "history-a" }]) });
    const url = `${f.base}/api/resources/events?${params}`;
    assert.equal((await fetch(url, { headers: { authorization: "Bearer token-b" } })).status, 404);
    assert.equal(f.counts().historyReads, 0);
    const response = await fetch(url, { headers: { authorization: "Bearer token-a" }, signal: control.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); let frames = "";
    while (!frames.includes('"type":"changed"')) {
      const chunk = await reader.read(); assert.equal(chunk.done, false); frames += new TextDecoder().decode(chunk.value);
    }
    assert.equal(f.counts().historyReads, 1);
    assert.equal(frames.includes("private transcript"), false);
    await reader.cancel();
  } finally { control.abort(); await f.close(); }
});

test("concurrent principals share a daemon activity connection and retain independent projections", { timeout: 10_000 }, async (t) => {
  const f = await fixture(); const a = new AbortController(); const b = new AbortController();
  t.signal.addEventListener("abort", () => { a.abort(); b.abort(); }, { once: true });
  async function connect(id: string, signal: AbortSignal) {
    const response = await fetch(`${f.base}/api/activity/events?machines=host`, { headers: { authorization: `Bearer token-${id}` }, signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); const decoder = new ActivityFeedSseDecoder();
    // Headers arrive before the initial projection finishes. The delivery
    // bootstrap is written immediately before the shared stream is joined.
    for (;;) {
      const chunk = await reader.read(); assert.equal(chunk.done, false);
      if (decoder.push(new TextDecoder().decode(chunk.value)).some(event => event.type === "delivery")) break;
    }
    async function readShared() {
      for (;;) {
        const chunk = await reader.read(); assert.equal(chunk.done, false);
        const event = decoder.push(new TextDecoder().decode(chunk.value)).find(event => event.type !== "delivery" && event.stream_id === "shared-boot");
        if (event && event.type !== "delivery") return event;
      }
    }
    return { reader, readShared };
  }
  try {
    const first = await connect("a", a.signal); const second = await connect("b", b.signal);
    const aborted = new Promise<never>((_resolve, reject) => {
      t.signal.addEventListener("abort", () => reject(t.signal.reason), { once: true });
    });
    await Promise.race([f.connected, aborted]);
    const readA = first.readShared(); const readB = second.readShared(); f.emit();
    assert.deepEqual((await readA).sessions?.map(session => session.id), ["a"]);
    assert.deepEqual((await readB).sessions?.map(session => session.id), ["b"]);
    assert.equal(f.counts().connections, 1);
    a.abort(); await first.reader.cancel().catch(() => {});
    const next = second.readShared(); f.emit();
    assert.deepEqual((await next).sessions?.map(session => session.id), ["b"]);
    assert.equal(f.counts().connections, 1);
    await second.reader.cancel();
  } finally { a.abort(); b.abort(); await f.close(); }
});
