import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Server as NetServer } from "node:net";
import { createEdgeServer } from "../src/server.ts";
import { closeServers, listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

// The star is stored by the daemon, so the edge's whole job on this feature is
// to forward the intent faithfully and project the acknowledgement narrowly.
// These tests stand a recording fake daemon up and pin both halves: the archive
// request must carry `starred` through (it is otherwise a silent no-op the user
// cannot see), and the star route must stay same-origin fenced and body-typed.

interface DaemonRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const daemonRequests: DaemonRequest[] = [];
let daemon: HttpServer;
let edge: NetServer;
let base = "";
let cookie = "";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

before(async () => {
  daemon = createHttpServer(async (req, res) => {
    const url = req.url ?? "";
    daemonRequests.push({ method: req.method ?? "", url, body: await readJson(req) });
    res.setHeader("content-type", "application/json");
    if (url.endsWith("/star")) {
      res.end(JSON.stringify({ ok: true, data: {
        machine: "maple",
        history_id: "h-abc",
        starred_at: "2026-09-01T00:00:00Z",
        stars_path: "/private/stars",
      } }));
      return;
    }
    if (url.endsWith("/h-conflict/resume")) {
      res.writeHead(409);
      res.end(JSON.stringify({
        ok: false,
        error: {
          code: "provider-session-already-running",
          message: "private runtime owner: /private/session",
        },
      }));
      return;
    }
    if (url.endsWith("/h-unavailable/resume")) {
      res.writeHead(503);
      res.end(JSON.stringify({
        ok: false,
        error: {
          code: "dsh-history-unavailable",
          message: "private DSH root: /private/dsh/sessions",
        },
      }));
      return;
    }
    if (url.endsWith("/h-profile-unavailable/resume")) {
      res.writeHead(503);
      res.end(JSON.stringify({
        ok: false,
        error: {
          code: "history-resume-profile-unavailable",
          message: "private profile diagnostics",
        },
      }));
      return;
    }
    if (url.endsWith("/resume")) {
      res.end(JSON.stringify({ ok: true, data: {
        machine: "maple",
        session: {
          id: "live-9",
          agent: "dsh",
          agent_profile: "dsh-runtime-kit",
          cwd: "/work/example",
          status: "running",
          private_runtime_path: "/private/runtime",
        },
      } }));
      return;
    }
    if (url.endsWith("/child-with-descendant/archive")) {
      res.writeHead(409);
      res.end(JSON.stringify({ ok: false, error: {
        code: "session-has-live-children",
        message: "private daemon output: pass --orphan-children",
        details: { scope: "local", children: [{ session_id: "private-child", machine: "private-host" }] },
      } }));
      return;
    }
    if (url.endsWith("/archive")) {
      res.end(JSON.stringify({ ok: true, data: {
        archived: {
          history_id: "h-abc",
          provider: "codex",
          provider_session_id: "provider-1",
          cwd: "/work/example",
          created_at: "2026-08-31T00:00:00Z",
          updated_at: "2026-08-31T00:00:01Z",
          archived_at: "2026-08-31T00:00:02Z",
          starred_at: "2026-08-31T00:00:02Z",
        },
        deleted: { id: "s1", deleted: true, killed: true, cleanup_pending: false },
      } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: { code: "not-found" } }));
  });
  const { port: daemonPort } = await listenOnLoopback(daemon);
  edge = createEdgeServer(makeEdgeConfig({
    clientToken: "client-secret",
    openAccess: false,
    machines: [{ name: "maple", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
  }));
  ({ base } = await listenOnLoopback(edge));
  cookie = await loginCookie(base);
});

after(() => closeServers(daemon, edge));

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, origin: base, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("the archive route forwards a requested star and omits it otherwise", async () => {
  daemonRequests.length = 0;

  const starred = await post("/api/sessions/maple/s1/archive", {
    expected_session_incarnation: "launch-s1",
    starred: true,
  });
  assert.equal(starred.status, 200);
  const body = await starred.json() as { data?: { archived?: { starred_at?: string } } };
  assert.equal(body.data?.archived?.starred_at, "2026-08-31T00:00:02Z");
  assert.deepEqual(daemonRequests.at(-1)?.body, {
    expected_session_incarnation: "launch-s1",
    starred: true,
  });

  const plain = await post("/api/sessions/maple/s1/archive", {
    expected_session_incarnation: "launch-s1",
  });
  assert.equal(plain.status, 200);
  assert.deepEqual(daemonRequests.at(-1)?.body, { expected_session_incarnation: "launch-s1" });
});

test("a non-boolean archive star is refused instead of dropped", async () => {
  daemonRequests.length = 0;

  const res = await post("/api/sessions/maple/s1/archive", {
    expected_session_incarnation: "launch-s1",
    starred: "yes",
  });

  assert.equal(res.status, 422);
  assert.deepEqual(daemonRequests, []);
});

test("archive explains the child guard without forwarding an orphan override or private details", async () => {
  for (const starred of [false, true]) {
    daemonRequests.length = 0;
    const request = {
      expected_session_incarnation: "launch-child",
      ...(starred ? { starred: true } : {}),
    };
    const response = await post("/api/sessions/maple/child-with-descendant/archive", request);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: {
        code: "session-has-live-children",
        message: "this session still has child sessions; close them before archiving or deleting it",
      },
    });
    assert.deepEqual(daemonRequests, [{
      method: "POST",
      url: "/sessions/child-with-descendant/archive",
      body: request,
    }], "a refused archive is sent once with only the caller's incarnation and Star intent");
  }
});

test("the star route forwards the toggle and projects only the acknowledgement", async () => {
  daemonRequests.length = 0;

  const res = await post("/api/history/sessions/maple/h-abc/star", { starred: true });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    data: { history_id: "h-abc", starred_at: "2026-09-01T00:00:00Z" },
  });
  assert.deepEqual(daemonRequests.at(-1), {
    method: "POST",
    url: "/history/sessions/h-abc/star",
    body: { starred: true },
  });
});

test("the star route stays same-origin fenced and body typed", async () => {
  daemonRequests.length = 0;

  const crossOrigin = await post(
    "/api/history/sessions/maple/h-abc/star",
    { starred: true },
    { origin: "https://evil.example" },
  );
  assert.equal(crossOrigin.status, 403);

  const malformed = await post("/api/history/sessions/maple/h-abc/star", { starred: "yes" });
  assert.equal(malformed.status, 422);

  assert.deepEqual(daemonRequests, [], "neither refusal reaches the daemon");
});

test("the history resume route forwards only the stable id and projects the live session", async () => {
  daemonRequests.length = 0;

  const res = await post("/api/history/sessions/maple/h-abc/resume");

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    data: {
      session: {
        id: "live-9",
        agent: "dsh",
        agent_profile: "dsh-runtime-kit",
        cwd: "/work/example",
        status: "running",
      },
    },
  });
  assert.deepEqual(daemonRequests.at(-1), {
    method: "POST",
    url: "/history/sessions/h-abc/resume",
    body: undefined,
  });
});

test("the history resume route stays same-origin fenced", async () => {
  daemonRequests.length = 0;

  const res = await post(
    "/api/history/sessions/maple/h-abc/resume",
    {},
    { origin: "https://evil.example" },
  );

  assert.equal(res.status, 403);
  assert.deepEqual(daemonRequests, []);
});

test("the history resume route rejects browser-selected launch inputs", async () => {
  daemonRequests.length = 0;

  const res = await post("/api/history/sessions/maple/h-abc/resume", {
    provider: "dsh",
    cwd: "/untrusted/browser/path",
    agent_args: ["--resume", "another-session"],
  });

  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: { message: "history resume body must be empty" },
  });
  assert.deepEqual(daemonRequests, []);
});

test("the history resume route preserves a typed rejection with a safe message", async () => {
  daemonRequests.length = 0;

  const res = await post("/api/history/sessions/maple/h-conflict/resume");

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: {
      code: "provider-session-already-running",
      message: "this provider session is already running",
    },
  });
  assert.deepEqual(daemonRequests.at(-1), {
    method: "POST",
    url: "/history/sessions/h-conflict/resume",
    body: undefined,
  });
});

test("the history resume route safely maps a vanished DSH history root", async () => {
  daemonRequests.length = 0;

  const res = await post("/api/history/sessions/maple/h-unavailable/resume");

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: {
      code: "dsh-history-unavailable",
      message: "DSH history is unavailable; refresh History and try again",
    },
  });
  assert.deepEqual(daemonRequests.at(-1), {
    method: "POST",
    url: "/history/sessions/h-unavailable/resume",
    body: undefined,
  });
});

test("the history resume route safely maps an unavailable owning profile", async () => {
  const res = await post("/api/history/sessions/maple/h-profile-unavailable/resume");

  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: {
      code: "history-resume-profile-unavailable",
      message: "history resume profile is unavailable; refresh History and try again",
    },
  });
});
