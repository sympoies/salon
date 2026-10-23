import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createResourceEvents } from "../src/resourceEvents.ts";
import type { ResourceEvent } from "@agent-console/shared/resources";
import type { SseStreamOptions } from "../src/sseStream.ts";

function event(resource: string, type: ResourceEvent["type"] = "changed"): ResourceEvent {
  return { schema_version: "agent-console.resource-event.v1", resource, type, revision: 1 };
}
test("one client multiplex shares selections and fences replaced generations", () => {
  const streams: SseStreamOptions<ResourceEvent>[] = [];
  const service = createResourceEvents(async (options) => { streams.push(options); });
  const reads: string[] = [];
  const health: boolean[] = [];
  const stopSessions = service.subscribe({ resource: "sessions", machines: ["allowed"] }, () => reads.push("sessions"), (value) => health.push(value));
  const first = streams[0]!;
  first.onEvent(event("sessions"));
  assert.deepEqual(reads, ["sessions"]);
  assert.deepEqual(health, [false, true]);
  const stopLayout = service.subscribe({ resource: "layout" }, () => reads.push("layout"), () => {});
  assert.equal(first.signal.aborted, true);
  first.onEvent(event("sessions"));
  assert.equal(reads.length, 1);
  const current = streams[1]!;
  const query = new URL(current.path, "http://test").searchParams;
  assert.equal(query.get("resources"), "layout,sessions");
  assert.equal(query.get("machines"), "allowed");
  current.onEvent(event("layout", "heartbeat"));
  assert.equal(reads.length, 1, "unchanged resources do not cause HTTP reads");
  current.onEvent(event("layout", "unavailable"));
  assert.deepEqual(reads, ["sessions", "layout"]);
  stopLayout(); stopSessions();
  assert.equal(streams.at(-1)?.signal.aborted, true);
});

test("source failure and stream reconnect restore fallback only for their scope", () => {
  let stream!: SseStreamOptions<ResourceEvent>;
  const service = createResourceEvents(async (options) => { stream = options; });
  let sessionHealth = false;
  let layoutHealth = false;
  const stopA = service.subscribe({ resource: "sessions", machines: [] }, () => {}, (value) => { sessionHealth = value; });
  const stopB = service.subscribe({ resource: "layout" }, () => {}, (value) => { layoutHealth = value; });
  stream.onEvent(event("sessions")); stream.onEvent(event("layout"));
  stream.onEvent(event("layout", "unavailable"));
  assert.equal(layoutHealth, false); assert.equal(sessionHealth, true);
  stream.onState("reconnecting");
  assert.equal(sessionHealth, false);
  stopA(); stopB();
});

test("conversation multiplex opts in to snapshots and forwards the decoded event", () => {
  const streams: SseStreamOptions<ResourceEvent>[] = [];
  const service = createResourceEvents(async options => { streams.push(options); });
  const received: Array<ResourceEvent | undefined> = [];
  const stop = service.subscribe({ resource: "conversation", machine: "host", id: "history" }, value => received.push(value), () => {});
  const stream = streams.at(-1)!;
  const query = new URL(stream.path, "http://fixture").searchParams;
  assert.equal(query.get("conversation_snapshots"), "1");
  assert.deepEqual(JSON.parse(query.get("conversations")!), [{ machine: "host", id: "history" }]);
  const snapshot = { ...event("conversation/host/history"), conversation: { messages: [{ id: "a1", role: "assistant" as const, text: "push" }] } };
  stream.onEvent(snapshot);
  assert.deepEqual(received, [snapshot]);
  stop(); stream.onEvent(snapshot); assert.equal(received.length, 1, "stale stream cannot redeliver");
});
