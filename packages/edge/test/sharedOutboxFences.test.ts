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
  const observation = { incarnation, status: "running", present: true, available: true };
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      if (!observation.available) { res.writeHead(503); return void res.end("{}"); }
      return void res.end(JSON.stringify({ ok: true, data: { sessions: observation.present ? [
        { id: "session-a", status: observation.status, agent: "codex", session_incarnation: observation.incarnation,
          provider_resume: { provider: "codex", session_id: "fixture-provider" } },
      ] : [] } }));
    }
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
  return { request, alice, observation };
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
    assert.equal((await f.request(0, "/maintenance/actions", "POST", {
      operation: "delete", action: "retry_delete", expected_session_incarnation: incarnation,
      expected_session_generation: 1, expected_preview_digest: `sha256:${"a".repeat(64)}`, confirmed: true,
    })).status, 409, "maintenance must preserve the fence refusal rather than report an unknown upstream outcome");
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

for (const outcome of ["malformed", "uncertain"] as const) test(`#339 ${outcome} archive acknowledgement retains the admission fence`, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(outcome === "malformed" ? 200 : 503);
    res.end(JSON.stringify(outcome === "malformed" ? { ok: true, data: {} } : { ok: false, error: { code: "uncertain-archive" } }));
    return true;
  });
  assert.equal((await f.request(0, "/archive", "POST", { expected_session_incarnation: incarnation })).status,
    outcome === "malformed" ? 502 : 503);
  const admissionResult = await f.request(1, "/outbox/after", "PUT", admission);
  assert.equal(admissionResult.status, 409);
  assert.equal((await admissionResult.json() as { error: { code: string } }).error.code, "outbox-lifecycle-pending");
});

// A stale response can arrive after another edge has recovered and acquired anew.
test("an old archive refusal cannot release a re-acquired current-incarnation fence", async t => {
  const responses: ServerResponse[] = [];
  let notify = () => {};
  const entered = () => new Promise<void>(resolve => { notify = resolve; });
  const f = await fixture(t, (req, res) => {
    if (!req.url?.endsWith("/archive")) return false;
    responses.push(res); notify(); return true;
  });
  const firstEntered = entered();
  const first = f.request(1, "/archive", "POST", { expected_session_incarnation: incarnation });
  await firstEntered;
  assert.equal((await f.request(0, "/outbox/current", "PUT", admission)).status, 409);
  f.observation.incarnation = "incarnation-b";
  const secondEntered = entered();
  const second = f.request(0, "/archive", "POST", { expected_session_incarnation: "incarnation-b" });
  try {
    await secondEntered;
    responses[0]!.writeHead(409);
    responses[0]!.end(JSON.stringify({ ok: false, error: { code: "session-incarnation-mismatch" } }));
    assert.equal((await first).status, 409);
    const reply = { ...admission, expected_session_incarnation: "incarnation-b" };
    assert.equal((await f.request(1, "/outbox/reacquired", "PUT", reply)).status, 409,
      "the first owner's late refusal must not release the second owner's fence");
  } finally {
    for (const res of responses) if (!res.writableEnded) {
      res.writeHead(503); res.end(JSON.stringify({ ok: false, error: { code: "uncertain-archive" } }));
    }
    await Promise.all([first, second]);
  }
});

for (const kind of ["archive", "delete", "maintenance"] as const) test(`an uncertain ${kind} stays fenced until sufficient replacement proof`, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(503); res.end(JSON.stringify({ ok: false, error: { code: "uncertain-lifecycle" } })); return true;
  });
  const path = kind === "archive" ? "/archive" : kind === "maintenance" ? "/maintenance/actions" : "";
  const body = kind === "archive" ? { expected_session_incarnation: incarnation } : kind === "maintenance" ? {
    operation: "delete", action: "retry_delete", expected_session_incarnation: incarnation,
    expected_session_generation: 1, expected_preview_digest: `sha256:${"a".repeat(64)}`, confirmed: true,
  } : undefined;
  assert.equal((await f.request(1, path, kind === "delete" ? "DELETE" : "POST", body)).status, 503);
  assert.equal((await f.request(0, "/outbox/same", "PUT", admission)).status, 409);
  f.observation.incarnation = "incarnation-b";
  const reply = { ...admission, expected_session_incarnation: "incarnation-b" };
  for (const status of ["stopped", "unknown"]) {
    f.observation.status = status;
    assert.equal((await f.request(0, `/outbox/${status}`, "PUT", reply)).status, 409, "only running proves a replacement");
  }
  f.observation.available = false;
  assert.equal((await f.request(0, "/outbox/unavailable", "PUT", reply)).status, 404);
  f.observation.available = true; f.observation.present = false;
  assert.equal((await f.request(0, "/outbox/absent", "PUT", reply)).status, 404);
  f.observation.present = true; f.observation.status = "running";
  assert.equal((await f.request(0, "/outbox/replacement", "PUT", reply)).status, kind === "delete" ? 409 : 201,
    "unguarded direct DELETE may still act on a replacement and cannot recover automatically");
});

for (const kind of ["direct", "maintenance"] as const) {
  for (const failure of [
    { status: 500, code: "session-termination-failed" },
    { status: 409, code: "session-has-live-children" },
    { status: 409, code: "coordination-lock-timeout" },
    { status: 409, code: "session-record-lock-timeout" },
  ]) test(`#340 a terminal ${kind} delete ${failure.code} releases its owned fence across edges`, async t => {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(failure.status);
      res.end(JSON.stringify({ ok: false, error: { code: failure.code } })); return true;
    });
    const path = kind === "direct" ? "" : "/maintenance/actions";
    const body = kind === "direct" ? undefined : {
      operation: "delete", action: "retry_delete", expected_session_incarnation: incarnation,
      expected_session_generation: 1, expected_preview_digest: `sha256:${"a".repeat(64)}`, confirmed: true,
    };
    assert.equal((await f.request(0, path, kind === "direct" ? "DELETE" : "POST", body)).status, failure.status);
    assert.equal((await f.request(1, "/outbox/recovered", "PUT", admission)).status, 201,
      "a completed refusal has no late deletion left to fence");
  });
}

for (const response of [
  { status: 503, body: { ok: false, error: { code: "session-termination-failed" } } },
  { status: 500, body: { error: { code: "session-termination-failed" } } },
]) test(`#340 an incomplete terminal refusal envelope at ${response.status} keeps direct delete fenced`, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(response.status); res.end(JSON.stringify(response.body)); return true;
  });
  assert.equal((await f.request(0, "", "DELETE")).status, response.status);
  f.observation.incarnation = "incarnation-b";
  assert.equal((await f.request(1, "/outbox/uncertain", "PUT", {
    ...admission, expected_session_incarnation: "incarnation-b",
  })).status, 409);
});
