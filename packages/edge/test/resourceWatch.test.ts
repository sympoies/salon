import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ResourceWatchRegistry, type ResourceObservation } from "../src/resourceWatch.ts";

const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
function harness() {
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const registry = new ResourceWatchRegistry(((callback: () => void) => {
    timers.push(callback); return { unref() {} };
  }) as typeof setTimeout, ((timer: unknown) => { cleared.push(timer); }) as typeof clearTimeout);
  return { registry, timers, cleared };
}

test("equivalent resource subscribers share reads and unchanged revisions", async () => {
  const { registry, timers } = harness();
  let reads = 0;
  let value = { title: "first" };
  const load = async () => { reads += 1; return value; };
  const a: ResourceObservation[] = [];
  const b: ResourceObservation[] = [];
  const stopA = registry.subscribe("principal/session-scope", load, 4, (event) => a.push(event));
  const stopB = registry.subscribe("principal/session-scope", load, 4, (event) => b.push(event));
  await flush();
  assert.equal(reads, 1);
  assert.equal(a[0]?.changed, true);
  assert.deepEqual(a, b);
  timers.shift()!(); await flush();
  assert.equal(reads, 2);
  assert.deepEqual(a[1], { changed: false, revision: 1, available: true });
  value = { title: "second" };
  timers.shift()!(); await flush();
  assert.deepEqual(a[2], { changed: true, revision: 2, available: true });
  stopA();
  timers.shift()!(); await flush();
  assert.equal(a.length, 3);
  assert.equal(b.length, 4);
  stopB();
});

test("failed observations recover without exposing content and isolate principal scopes", async () => {
  const { registry, timers } = harness();
  let fail = false;
  const events: ResourceObservation[] = [];
  let otherReads = 0;
  const stop = registry.subscribe("owner-a/layout", async () => {
    if (fail) throw new Error("private content must stay here");
    return { order: [] };
  }, 4, (event) => events.push(event));
  const stopOther = registry.subscribe("owner-b/layout", async () => { otherReads += 1; return {}; }, 4, () => {});
  await flush();
  assert.equal(otherReads, 1);
  fail = true; timers.shift()!(); await flush();
  assert.deepEqual(events[1], { available: false, changed: false, revision: 1 });
  fail = false; timers.pop()!(); await flush();
  assert.deepEqual(events[2], { available: true, changed: true, revision: 2 });
  stop(); stopOther();
});

test("last subscriber aborts its read and prevents late results or scheduled work", async () => {
  const { registry, timers } = harness();
  let finish!: (value: unknown) => void;
  let signal!: AbortSignal;
  const events: ResourceObservation[] = [];
  const stop = registry.subscribe("key", (current) => {
    signal = current;
    return new Promise((resolve) => { finish = resolve; });
  }, 4, (event) => events.push(event));
  await flush();
  stop();
  assert.equal(signal.aborted, true);
  finish({ transcript: "not retained" }); await flush();
  assert.deepEqual(events, []);
  assert.deepEqual(timers, []);
});

test("conversation push reuses the observed snapshot and reconnect replaces a missed page", async () => {
  const { registry, timers } = harness();
  let value = { messages: [{ id: "a1", role: "assistant", text: "first" }] };
  let reads = 0;
  const events: Array<ResourceObservation & { value?: unknown }> = [];
  const stop = registry.subscribe("conversation", async () => { reads++; return value; }, 3000, event => events.push(event), true);
  await flush();
  assert.deepEqual(events[0]?.value, value);
  timers.shift()!(); await flush();
  assert.equal(events[1]?.value, undefined, "heartbeats do not repeat transcript bodies");
  const replay: Array<ResourceObservation & { value?: unknown }> = [];
  const stopReplay = registry.subscribe("conversation", async () => { throw new Error("must share"); }, 3000, event => replay.push(event), true);
  assert.equal(replay[0]?.value, undefined, "late subscribers refetch instead of replaying a page older than their initial HTTP read");
  assert.equal(replay[0]?.changed, true);
  stopReplay(); stop();
  value = { messages: [{ id: "a1", role: "assistant", text: "first" }, { id: "a2", role: "assistant", text: "while disconnected" }] };
  const reconnect = registry.subscribe("conversation", async () => { reads++; return value; }, 3000, event => replay.push(event), true);
  await flush();
  assert.deepEqual(replay.at(-1)?.value, value);
  assert.equal(reads, 3);
  reconnect();
});

test("metadata-only readers and unchanged heartbeats do not normalize snapshots", async () => {
  const { registry, timers } = harness();
  let traversals = 0;
  let text = "same";
  const value = { get messages() { traversals++; return [{ id: "a1", role: "assistant", text }]; } };
  const stopMetadata = registry.subscribe("conversation", async () => value, 3000, () => {});
  await flush(); const fingerprintTraversals = traversals;
  const pushed: ResourceObservation[] = [];
  const stopPush = registry.subscribe("conversation", async () => value, 3000, event => pushed.push(event), true);
  timers.shift()!(); await flush();
  assert.equal(traversals, fingerprintTraversals * 2, "unchanged opt-in heartbeat only fingerprints");
  text = "changed";
  timers.shift()!(); await flush();
  assert.ok(pushed.at(-1)?.value, "opt-in demand joining an existing metadata watch gets fresh changed snapshots");
  const afterChange = traversals;
  timers.shift()!(); await flush();
  assert.equal(traversals - afterChange, fingerprintTraversals, "unchanged opt-in heartbeat only fingerprints");
  stopPush(); stopMetadata();
});
