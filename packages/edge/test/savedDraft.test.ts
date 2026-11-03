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
    const response = await fetch(`${base}/api/sessions`);
    const sessions = (await response.json() as any).data.sessions;
    assert.deepEqual(sessions[0].stale_draft, draft);
    assert.equal(sessions[1].stale_draft, undefined);
  } finally { closeServers(edge, daemon); }
});
