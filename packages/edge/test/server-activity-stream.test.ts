import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { Server as NetServer } from "node:net";
import { ActivitySseDecoder } from "@agent-console/shared/activity";
import { createEdgeServer } from "../src/server.ts";
import { closeServers, listenOnLoopback, makeEdgeConfig } from "./support.ts";

let summitDaemon: HttpServer;
let mesaDaemon: HttpServer;
let edge: NetServer;
let base = "";
let summitRequests = 0;
let mesaRequests = 0;

function activityFrame(streamId: string): string {
  return `id: ${streamId}:1\nevent: snapshot\ndata: ${JSON.stringify({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "snapshot",
    stream_id: streamId,
    sequence: 1,
    machine: "daemon-local-name",
    observed_at: "2026-07-11T12:00:00Z",
    sessions: [],
  })}\n\n`;
}

function activityDaemon(onRequest: () => void, streamId: string): HttpServer {
  return createHttpServer((req, res) => {
    onRequest();
    if (req.url === "/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { sessions: [] } }));
      return;
    }
    assert.equal(req.url, "/activity/events");
    assert.match(req.headers.authorization ?? "", /^Bearer /);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(activityFrame(streamId));
  });
}

before(async () => {
  summitDaemon = activityDaemon(() => { summitRequests += 1; }, "summit-boot");
  mesaDaemon = activityDaemon(() => { mesaRequests += 1; }, "mesa-boot");
  const { base: summitBase } = await listenOnLoopback(summitDaemon);
  const { base: m4Base } = await listenOnLoopback(mesaDaemon);
  edge = createEdgeServer(makeEdgeConfig({
    clientToken: "client-secret",
    openAccess: false,
    machines: [
      { name: "summit", url: summitBase, token: "summit-secret" },
      { name: "mesa", url: m4Base, token: "mesa-secret" },
    ],
  }));
  ({ base } = await listenOnLoopback(edge));
});

after(() => closeServers(edge, summitDaemon, mesaDaemon));

test("activity stream route requires client authentication", async () => {
  const response = await fetch(`${base}/api/activity/events?machines=summit`);
  assert.equal(response.status, 401);
});

test("configured inactive hosts never open an activity source", { timeout: 5000 }, async () => {
  let requests = 0;
  const daemon = createHttpServer((_req, res) => { requests++; res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": fixture\n\n"); });
  const { base: daemonBase } = await listenOnLoopback(daemon);
  const server = createEdgeServer(makeEdgeConfig({ clientToken: "inactive-fixture-token", openAccess: false,
    machines: [{ name: "fixture-retired", url: daemonBase, token: "fixture-daemon-token", active: false }],
  }));
  const { base: edgeBase } = await listenOnLoopback(server);
  const control = new AbortController();
  try {
    const response = await fetch(`${edgeBase}/api/activity/events?machines=fixture-retired`, {
      headers: { authorization: "Bearer inactive-fixture-token" }, signal: control.signal,
    });
    assert.equal(response.status, 200);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(requests, 0, "inactive activity must not contact the daemon");
  } finally {
    control.abort(); server.closeAllConnections(); daemon.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => daemon.close(() => resolve()));
  }
});

test("activity stream route multiplexes only enabled machines and preserves configured identity", async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/activity/events?machines=summit`, {
    headers: { authorization: "Bearer client-secret", accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const text = new TextDecoder();
  const decoder = new ActivitySseDecoder();
  let event;
  while (!event) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    event = decoder.push(text.decode(chunk.value, { stream: true })).find((frame) => !frame.stream_id.startsWith("edge-initial-"));
  }
  controller.abort();
  await reader.cancel().catch(() => {});

  assert.equal(event.machine, "summit");
  assert.equal(event.stream_id, "summit-boot");
  assert.equal(summitRequests > 0, true);
  assert.equal(mesaRequests, 0);
});

test("activity streams are exempt from ordinary request deadlines", async () => {
  const holdingDaemon = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": holding\n\n");
  });
  const { base: daemonBase } = await listenOnLoopback(holdingDaemon);
  const shortDeadlineEdge = createEdgeServer(makeEdgeConfig({
    clientToken: "client-secret",
    openAccess: false,
    machines: [{ name: "holding", url: daemonBase, token: "holding-secret" }],
  }), { ordinaryRequestTimeoutMs: 20 });
  const { base: edgeBase } = await listenOnLoopback(shortDeadlineEdge);
  const controller = new AbortController();
  try {
    const response = await fetch(`${edgeBase}/api/activity/events?machines=holding`, {
      headers: { authorization: "Bearer client-secret", accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    const streamState = await Promise.race([
      reader.closed.then(() => "closed" as const),
      new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 10)),
    ]);
    assert.equal(streamState, "open");
    const health = await fetch(`${edgeBase}/healthz`);
    assert.equal(health.status, 200);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    controller.abort();
    closeServers(shortDeadlineEdge, holdingDaemon);
  }
});
