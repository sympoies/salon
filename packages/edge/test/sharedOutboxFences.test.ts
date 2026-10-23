import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEdgeServer } from "../src/server.ts";
import { AccessStore } from "../src/accessStore.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

const incarnation = "incarnation-a";
const admission = { text: "Retained original account intention", expected_session_incarnation: incarnation };
async function fixture(t: TestContext, handle?: (req: IncomingMessage, res: ServerResponse) => boolean) {
  const directory = mkdtempSync(join(tmpdir(), "console-outbox-fences-"));
  const statePath = join(directory, "state.sqlite");
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") return void res.end(JSON.stringify({ ok: true, data: { sessions: [
      { id: "session-a", status: "running", agent: "codex", session_incarnation: incarnation,
        provider_resume: { provider: "codex", session_id: "fixture-provider" } },
    ] } }));
    if (handle?.(req, res)) return;
    res.writeHead(404); res.end("{}");
  });
  const upstream = await listenOnLoopback(daemon);
  const ownership = new AccessStore(statePath);
  ownership.claimSession({ principalId: "alice", machine: "fixture", sessionId: "session-a", incarnation }); ownership.close();
  const config = makeEdgeConfig({ openAccess: false, clientToken: "", multiUser: true, accessDbPath: statePath,
    principals: [
      { id: "alice", token: "alice-secret", machines: ["fixture"], permissions: [] },
      { id: "root", token: "root-secret", machines: [], permissions: [] },
    ], machines: [{ name: "fixture", url: upstream.base, token: "synthetic-upstream" }] });
  const edges = [createEdgeServer(config), createEdgeServer(config)];
  const bases = await Promise.all(edges.map(edge => listenOnLoopback(edge).then(value => value.base)));
  const alice = await loginCookie(bases[0]!, "alice-secret");
  const root = await Promise.all(bases.map(base => loginCookie(base, "root-secret")));
  t.after(async () => {
    for (const server of [...edges, daemon]) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (edge: number, suffix: string, method = "GET", body?: unknown, expected: string | null = "root", cookie = root[edge]!) =>
    fetch(`${bases[edge]}/api/sessions/fixture/session-a${suffix}`, { method,
      headers: { cookie, origin: bases[edge]!, "content-type": "application/json",
        ...(expected === null ? {} : { "x-console-expected-principal": expected }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { request, alice };
}

test("a competing lifecycle refusal cannot release another edge's in-flight or uncertain fence", async t => {
  let finish = () => {}, entered = () => {};
  const deletion = new Promise<void>(resolve => { entered = resolve; });
  let archiveCalls = 0;
  const f = await fixture(t, (req, res) => {
    if (req.method === "DELETE") {
      finish = () => { if (res.writableEnded) return; res.writeHead(503); res.end(JSON.stringify({ ok: false, error: { code: "uncertain-delete" } })); };
      entered(); return true;
    }
    if (req.url?.endsWith("/archive")) {
      archiveCalls++; res.writeHead(409);
      res.end(JSON.stringify({ ok: false, error: { code: "session-incarnation-mismatch" } })); return true;
    }
    return false;
  });
  const pending = f.request(1, "", "DELETE");
  try {
    await deletion;
    assert.equal((await f.request(0, "/outbox/before", "PUT", admission)).status, 409);
    assert.equal((await f.request(0, "/archive", "POST", { expected_session_incarnation: "stale-incarnation" })).status, 409);
    assert.equal((await f.request(0, "/outbox/during", "PUT", admission)).status, 409,
      "a competing refusal must not reopen admission while deletion is in flight");
    assert.equal(archiveCalls, 0, "exclusive acquisition rejects the second lifecycle operation before upstream I/O");
    finish(); assert.equal((await pending).status, 503);
    assert.equal((await f.request(0, "/outbox/after", "PUT", admission)).status, 409,
      "an uncertain delete retains the durable fence");
  } finally { finish(); await pending; }
});

test("the acquiring lifecycle operation can release its own fence after a definite refusal", async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(409); res.end(JSON.stringify({ ok: false, error: { code: "session-incarnation-mismatch" } })); return true;
  });
  assert.equal((await f.request(1, "/archive", "POST", { expected_session_incarnation: "stale-incarnation" })).status, 409);
  assert.equal((await f.request(0, "/outbox/after", "PUT", admission)).status, 201);
});

test("expected principal binds every outbox read and mutation across a shared-cookie replacement", async t => {
  const f = await fixture(t);
  const list = `/outbox?expected_session_incarnation=${incarnation}`;
  // These requests have root's valid cookie but originate from Alice's old tab.
  for (const [suffix, method, body] of [
    [list, "GET", undefined],
    ["/outbox/old-alice", "PUT", admission],
    ["/outbox", "PATCH", { operation: "begin_compose", hold_id: "old-hold", base_revision: 0, expected_session_incarnation: incarnation }],
  ] as const) {
    const response = await f.request(0, suffix, method, body, "alice");
    assert.equal(response.status, 409, `stale principal must fail before ${method} collection access`);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "outbox-principal-changed");
  }
  assert.equal((await f.request(0, list, "GET", undefined, null)).status, 409, "missing assertion fails closed");
  const empty = await f.request(0, list);
  assert.equal((await empty.json() as { data: { items: unknown[] } }).data.items.length, 0);
  assert.equal((await f.request(0, "/outbox/alice", "PUT", admission, "alice", f.alice)).status, 201);
  assert.equal((await f.request(0, "/outbox/root", "PUT", admission, "root")).status, 201);
  for (const [principal, cookie, id] of [["alice", f.alice, "alice"], ["root", undefined, "root"]] as const) {
    const response = await f.request(0, list, "GET", undefined, principal, cookie);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { data: { items: { id: string }[] } }).data.items.map(item => item.id), [id]);
  }
});
