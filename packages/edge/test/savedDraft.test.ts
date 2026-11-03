import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { test } from "node:test";
import { createEdgeServer } from "../src/server.ts";
import { closeServers, listenOnLoopback, makeEdgeConfig } from "./support.ts";

const text = "  café 雪\ntrailing  ";
const draft = { event: "stale_draft_stashed", draft_id: "draft-1", saved_at: "2026-11-01T12:00:00Z", session_id: "session-1", bytes: Buffer.byteLength(text), cleared: true };

test("saved draft routes require client auth and forward daemon auth and exact bytes", async () => {
  const calls: string[] = [];
  const daemon = createServer((req, res) => {
    calls.push(`${req.url} ${req.headers.authorization}`);
    if (req.url === "/sessions/session-1/drafts") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, data: { drafts: [draft] } }));
    } else if (req.url === "/sessions/session-1/drafts/draft-1") {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(Buffer.from(text));
    } else { res.writeHead(404); res.end(); }
  });
  const daemonBase = (await listenOnLoopback(daemon)).base;
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, clientToken: "client-fixture", machines: [{ name: "fixture", url: daemonBase, token: "daemon-fixture" }] }));
  const base = (await listenOnLoopback(edge)).base;
  try {
    const route = `${base}/api/sessions/fixture/session-1/drafts`;
    assert.equal((await fetch(route)).status, 401);
    assert.equal(calls.length, 0);
    const headers = { authorization: "Bearer client-fixture" };
    const list = await fetch(route, { headers });
    assert.deepEqual((await list.json() as any).data.drafts, [draft]);
    const read = await fetch(`${route}/draft-1`, { headers });
    assert.equal(read.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), Buffer.from(text));
    assert.deepEqual(calls, ["/sessions/session-1/drafts Bearer daemon-fixture", "/sessions/session-1/drafts/draft-1 Bearer daemon-fixture"]);
  } finally { closeServers(edge, daemon); }
});

test("the session list attaches only matching board draft metadata", async () => {
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") res.end(JSON.stringify({ ok: true, data: { sessions: [
      { id: "session-1", agent: "codex", status: "running", created_at: "2026-01-01T00:00:00Z" },
      { id: "session-2", agent: "codex", status: "running", created_at: "2026-01-01T00:00:00Z" },
    ] } }));
    else if (req.url === "/board/v1") res.end(JSON.stringify({ ok: true, data: { machine: "fixture", board: { machine: "fixture", records: [
      { session_id: "session-1", created_at: "2026-01-01T00:00:00Z", stale_draft: { ...draft, text: "private" } },
      { session_id: "session-2", created_at: "2025-01-01T00:00:00Z", stale_draft: { ...draft, session_id: "session-2" } },
    ] } } }));
    else { res.writeHead(404); res.end(); }
  });
  const daemonBase = (await listenOnLoopback(daemon)).base;
  const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "fixture", url: daemonBase, token: "daemon-fixture" }] }));
  const base = (await listenOnLoopback(edge)).base;
  try {
    let sessions: any[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await fetch(`${base}/api/sessions`);
      sessions = (await response.json() as any).data.sessions;
      if (sessions[0].stale_draft) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(sessions[0].stale_draft, draft);
    assert.equal(sessions[1].stale_draft, undefined);
  } finally { closeServers(edge, daemon); }
});

test("a slow board never delays session lists and refreshes are shared and cached", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T12:00:00Z") });
  let boardHits = 0;
  const pending: import("node:http").ServerResponse[] = [];
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") res.end(JSON.stringify({ ok: true, data: { sessions: [
      { id: "session-1", agent: "codex", status: "running", created_at: "2026-01-01T00:00:00Z" },
    ] } }));
    else if (req.url === "/board/v1") { boardHits++; pending.push(res); }
    else { res.writeHead(404); res.end(); }
  });
  const daemonBase = (await listenOnLoopback(daemon)).base;
  const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "fixture", url: daemonBase, token: "daemon-fixture" }] }));
  const base = (await listenOnLoopback(edge)).base;
  const list = async () => (await (await fetch(`${base}/api/sessions`)).json() as any).data.sessions[0];
  try {
    const first = await Promise.race([list(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("session list waited for board")), 400))]);
    assert.equal(first.stale_draft, undefined);
    const second = await list();
    assert.equal(second.stale_draft, undefined);
    assert.equal(boardHits, 1, "concurrent polls share the pending refresh");
    pending.shift()!.end(JSON.stringify({ ok: true, data: { machine: "fixture", board: { machine: "fixture", records: [
      { session_id: "session-1", created_at: "2026-01-01T00:00:00Z", stale_draft: draft },
    ] } } }));
    let cached: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      cached = await list();
      if (cached.stale_draft) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(cached.stale_draft, draft);
    assert.equal(boardHits, 1, "cached metadata is reused within the window");
    t.mock.timers.tick(30_001);
    assert.equal((await list()).stale_draft, undefined, "expired metadata is not served while refreshing");
    await list();
    assert.equal(boardHits, 2, "one refresh starts after the cache window");
  } finally { for (const response of pending) response.end(); closeServers(edge, daemon); }
});
