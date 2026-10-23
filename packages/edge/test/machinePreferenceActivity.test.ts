import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ActivityFeedSseDecoder, type ActivityStreamEvent } from "@agent-console/shared/activity";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

const auth = { authorization: "Bearer fixture-reader-token" };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (check()) return;
    await pause(10);
  }
  assert.fail(message);
}

async function fixture(run: (f: {
  base: string; db: string; requests: string[]; sources: Map<ServerResponse, { streamId: string; sequence: number }>;
  emit(): void; subscribe(headers?: Record<string, string>): Promise<{ events: ActivityStreamEvent[] }>;
  put(enabled: boolean, headers?: Record<string, string>): Promise<void>;
}) => Promise<void>, active?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "machine-preference-activity-"));
  const db = join(dir, "state.sqlite");
  const requests: string[] = [];
  const sources = new Map<ServerResponse, { streamId: string; sequence: number }>();
  let connection = 0;
  const send = (response: ServerResponse) => {
    const source = sources.get(response)!;
    response.write(`event: snapshot\ndata: ${JSON.stringify({
      schema_version: "agent-session.activity-stream.event.v1", type: "snapshot",
      stream_id: source.streamId, sequence: ++source.sequence, machine: "daemon-fixture-name",
      observed_at: new Date().toISOString(), sessions: [],
    })}\n\n`);
  };
  const daemon = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === "/sessions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { sessions: [] } })); return;
    }
    assert.equal(req.url, "/activity/events");
    res.writeHead(200, { "content-type": "text/event-stream" });
    sources.set(res, { streamId: `fixture-stream-${++connection}`, sequence: 0 });
    res.on("close", () => sources.delete(res)); send(res);
  });
  const { base: daemonBase } = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ multiUser: true, openAccess: false, accessDbPath: db,
    principals: [
      { id: "fixture-reader", token: "fixture-reader-token", machines: ["fixture-host"], permissions: [] },
      { id: "fixture-other", token: "fixture-other-token", machines: ["fixture-host"], permissions: [] },
    ], machines: [{ name: "fixture-host", url: daemonBase, token: "fixture-daemon-token", ...(active === undefined ? {} : { active }) }],
  }));
  chmodSync(db, 0o600); // This fixture owns the private owner-local administration file.
  const { base } = await listenOnLoopback(edge);
  const controls: AbortController[] = [];
  const pumps: Promise<void>[] = [];
  const subscribe = async (headers = auth) => {
    const control = new AbortController(); controls.push(control);
    const response = await fetch(`${base}/api/activity/events?machines=fixture-host`, { headers, signal: control.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new ActivityFeedSseDecoder(); const text = new TextDecoder();
    const events: ActivityStreamEvent[] = [];
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) return;
          for (const event of decoder.push(text.decode(chunk.value, { stream: true }))) {
            if (event.type !== "delivery") events.push(event);
          }
        }
      } catch (error) { if (!control.signal.aborted) throw error; }
    })();
    pumps.push(pump); return { events };
  };
  const put = async (enabled: boolean, headers: Record<string, string> = auth) => {
    const response = await fetch(`${base}/api/machine-preferences/fixture-host`, { method: "PUT",
      headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ enabled, reason: "Fixture manual maintenance" }) });
    assert.equal(response.status, 200);
  };
  try { await run({ base, db, requests, sources, emit: () => { for (const res of sources.keys()) send(res); }, subscribe, put }); }
  finally {
    for (const control of controls) control.abort();
    await Promise.allSettled(pumps);
    edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve()));
    daemon.closeAllConnections(); await new Promise<void>(resolve => daemon.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("activity reconnect after another client's disable makes no daemon request", { timeout: 10_000 }, async () => {
  await fixture(async f => {
    const cookie = await loginCookie(f.base, "fixture-reader-token");
    await f.put(false, { cookie });
    await f.subscribe(); await pause(80);
    assert.deepEqual(f.requests, [], "disabled activity must not load sessions or subscribe upstream");
  });
});

test("manual enable cannot activate a fleet-configured inactive activity source", { timeout: 10_000 }, async () => {
  await fixture(async f => {
    await f.put(false); await f.put(true);
    const preferences = await fetch(`${f.base}/api/machine-preferences`, { headers: auth });
    const row = (await preferences.json()).data.machines[0];
    assert.equal(row.enabled, true); assert.equal(row.active, false);
    await f.subscribe(); await pause(80);
    assert.deepEqual(f.requests, [], "static fleet and dynamic account activation remain conjunctive");
  }, false);
});

test("already-open activity excludes a cross-client disable and resumes after enable", { timeout: 10_000 }, async () => {
  await fixture(async f => {
    const stream = await f.subscribe();
    await until(() => stream.events.some(event => event.stream_id === "fixture-stream-1"), "initial daemon event missing");
    const cookie = await loginCookie(f.base, "fixture-reader-token");
    await f.put(false, { cookie });
    const before = f.requests.length;
    f.emit(); await pause(80);
    assert.equal(f.requests.length, before, "disabled per-event projection must not poll upstream ownership");
    assert.equal(stream.events.some(event => event.stream_id === "fixture-stream-1" && event.sequence === 2), false);
    await until(() => f.sources.size === 0, "disabled reader must unsubscribe its upstream source");
    await f.put(true, { cookie });
    await until(() => stream.events.some(event => event.stream_id === "fixture-stream-2"), "same client stream must resume after manual enable");
  });
});

test("one principal's activity disable preserves another reader's shared upstream", { timeout: 10_000 }, async () => {
  await fixture(async f => {
    const owner = await f.subscribe();
    const other = await f.subscribe({ authorization: "Bearer fixture-other-token" });
    await until(() => owner.events.some(event => event.stream_id === "fixture-stream-1")
      && other.events.some(event => event.stream_id.startsWith("edge-initial-")), "both readers must receive their authoritative initial projection");
    assert.equal(f.requests.filter(path => path === "/activity/events").length, 1);
    await f.put(false); f.emit();
    await until(() => other.events.some(event => event.stream_id === "fixture-stream-1" && event.sequence === 2), "other principal lost activity");
    assert.equal(owner.events.some(event => event.stream_id === "fixture-stream-1" && event.sequence === 2), false);
    assert.equal(f.sources.size, 1, "another principal keeps its producer subscription");
  });
});

test("owner-local CLI disable cancels an already-open activity subscription", { timeout: 10_000 }, async () => {
  await fixture(async f => {
    const stream = await f.subscribe();
    await until(() => stream.events.some(event => event.stream_id === "fixture-stream-1"), "initial activity missing");
    const result = spawnSync(process.execPath, [new URL("../src/machinePreferencesCli.ts", import.meta.url).pathname,
      "--db", f.db, "--principal", "fixture-reader", "--machine", "fixture-host", "--disable",
      "--reason", "CLI fixture maintenance", "--actor", "fixture-coordinator"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    await until(() => f.sources.size === 0, "CLI preference must be observed without an HTTP write notification");
  });
});
