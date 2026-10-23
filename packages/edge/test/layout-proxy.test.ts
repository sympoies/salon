import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { createEdgeServer } from "../src/server.ts";
import { closeServers, makeEdgeConfig, listenOnLoopback } from "./support.ts";

// Outside multi-user mode (which persists layout per principal in access.sqlite)
// the edge can proxy GET/PUT /api/layout to an optional host read-write layout
// service (AGENT_CONSOLE_LAYOUT_URL) — the first read-write member of the
// Hermes/Usage reader pattern. These tests stand a fake host writer up on
// loopback and assert the proxy + graceful-degradation contract: with a writer,
// GET/PUT round-trip;
// with the writer unset/down/malformed, GET degrades to reachable:false + empty
// order and PUT is accepted as a no-op — never a 500.

async function readJson(
  r: Response,
): Promise<{
  ok: boolean;
  error?: { message?: string };
  data: { order?: string[]; revision?: number | null; reachable: boolean; conflict?: boolean; error?: string };
}> {
  return (await r.json()) as {
    ok: boolean;
    error?: { message?: string };
    data: { order?: string[]; revision?: number | null; reachable: boolean; conflict?: boolean; error?: string };
  };
}

// A stateful fake host writer: GET returns whatever the last PUT stored.
function fakeLayoutStore(initial: string[] = [], token?: string): { server: Server; seen: () => string[] } {
  let stored = [...initial];
  const server = createServer(async (req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/layout") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { order?: unknown };
        stored = Array.isArray(body.order) ? body.order.filter((v): v is string => typeof v === "string") : [];
      } catch {
        stored = [];
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ order: stored }));
  });
  return { server, seen: () => stored };
}

function fakeRevisionLayoutStore(initial: string[] = [], token?: string): {
  server: Server;
  seen: () => { order: string[]; revision: number; lastBody: unknown };
} {
  let stored = [...initial];
  let revision = 3;
  let lastBody: unknown = null;
  const server = createServer(async (req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/layout") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const body = lastBody as { order?: unknown; base_revision?: unknown };
      if (body.base_revision !== revision) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ order: stored, revision, error: "layout revision conflict" }));
        return;
      }
      stored = Array.isArray(body.order) ? body.order.filter((v): v is string => typeof v === "string") : [];
      revision += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, order: stored, revision }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ order: stored, revision }));
  });
  return { server, seen: () => ({ order: stored, revision, lastBody }) };
}

test("layout: reader not configured -> GET reachable:false, empty order (no host access)", async () => {
  const edge = createEdgeServer(makeEdgeConfig());
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`);
    assert.equal(r.status, 200);
    const body = await readJson(r);
    assert.equal(body.ok, true);
    assert.equal(body.data.reachable, false);
    assert.deepEqual(body.data.order, []);
  } finally {
    closeServers(edge);
  }
});

test("layout: a live reader's order is proxied through with reachable:true", async () => {
  const { server } = fakeLayoutStore(["summit/a", "summit/b"]);
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const body = await readJson(await fetch(`${base}/api/layout`));
    assert.equal(body.data.reachable, true);
    assert.deepEqual(body.data.order, ["summit/a", "summit/b"]);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: a live revision-capable reader exposes revision", async () => {
  const { server } = fakeRevisionLayoutStore(["summit/a", "summit/b"]);
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const body = await readJson(await fetch(`${base}/api/layout`));
    assert.equal(body.data.reachable, true);
    assert.deepEqual(body.data.order, ["summit/a", "summit/b"]);
    assert.equal(body.data.revision, 3);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: GET normalizes a malformed reader payload defensively", async () => {
  const reader = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/layout") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ order: ["summit/a", 42, null, "summit/a", "", "summit/b"] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const body = await readJson(await fetch(`${base}/api/layout`));
    assert.equal(body.data.reachable, true);
    assert.deepEqual(body.data.order, ["summit/a", "summit/b"]);
  } finally {
    closeServers(edge, reader);
  }
});

test("layout: an unreachable reader degrades GET to reachable:false (never 500s)", async () => {
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: "http://127.0.0.1:1", token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`);
    assert.equal(r.status, 200);
    const body = await readJson(r);
    assert.equal(body.data.reachable, false);
    assert.deepEqual(body.data.order, []);
  } finally {
    closeServers(edge);
  }
});

test("layout: a reader 5xx degrades GET to reachable:false with the status surfaced", async () => {
  const reader = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/layout") {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const body = await readJson(await fetch(`${base}/api/layout`));
    assert.equal(body.data.reachable, false);
    assert.match(body.data.error ?? "", /502/);
  } finally {
    closeServers(edge, reader);
  }
});

test("layout: a 200 with a non-JSON body degrades GET to reachable:false", async () => {
  const reader = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/layout") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`);
    assert.equal(r.status, 200); // never a 500
    const body = await readJson(r);
    assert.equal(body.data.reachable, false);
    assert.deepEqual(body.data.order, []);
  } finally {
    closeServers(edge, reader);
  }
});

test("layout: an oversized reader body degrades GET to reachable:false (size cap, no OOM/500)", async () => {
  const huge = `{"order":["summit/a","${"x".repeat(400 * 1024)}"]}`;
  const reader = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/layout") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(huge);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`);
    assert.equal(r.status, 200);
    const body = await readJson(r);
    assert.equal(body.data.reachable, false);
    assert.deepEqual(body.data.order, []);
  } finally {
    closeServers(edge, reader);
  }
});

test("layout: PUT then GET round-trips a new order through a live writer", async () => {
  const { server, seen } = fakeLayoutStore(["summit/a"]);
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const put = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["summit/b", "summit/c", "summit/a"] }),
    });
    assert.equal(put.status, 200);
    const putBody = await readJson(put);
    assert.equal(putBody.data.reachable, true);
    assert.deepEqual(putBody.data.order, ["summit/b", "summit/c", "summit/a"]);
    assert.equal(putBody.data.revision, null);
    assert.deepEqual(seen(), ["summit/b", "summit/c", "summit/a"]);

    const getBody = await readJson(await fetch(`${base}/api/layout`));
    assert.deepEqual(getBody.data.order, ["summit/b", "summit/c", "summit/a"]);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: PUT accepts an empty success response from the writer", async () => {
  let seen: string[] = [];
  const server = createServer(async (req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/layout") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method !== "PUT") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ order: seen }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { order?: unknown };
    seen = Array.isArray(body.order) ? body.order.filter((v): v is string => typeof v === "string") : [];
    res.writeHead(204);
    res.end();
  });
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const put = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["summit/b", "summit/a"] }),
    });
    assert.equal(put.status, 200);
    const putBody = await readJson(put);
    assert.equal(putBody.ok, true);
    assert.equal(putBody.data.reachable, true);
    assert.deepEqual(putBody.data.order, ["summit/b", "summit/a"]);
    assert.equal(putBody.data.revision, null);
    assert.deepEqual(seen, ["summit/b", "summit/a"]);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: PUT normalizes before forwarding to the writer", async () => {
  const { server, seen } = fakeLayoutStore();
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["summit/a", 7, "summit/a", "", "summit/b"] }),
    });
    assert.deepEqual(seen(), ["summit/a", "summit/b"]);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: PUT forwards base revision and returns the next revision", async () => {
  const { server, seen } = fakeRevisionLayoutStore(["summit/a"]);
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const put = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["summit/b", "summit/a"], base_revision: 3, reason: "reorder" }),
    });
    assert.equal(put.status, 200);
    const body = await readJson(put);
    assert.equal(body.data.reachable, true);
    assert.equal(body.data.revision, 4);
    assert.deepEqual(seen().order, ["summit/b", "summit/a"]);
    assert.deepEqual(seen().lastBody, { order: ["summit/b", "summit/a"], base_revision: 3, reason: "reorder" });
  } finally {
    closeServers(edge, server);
  }
});

test("layout: stale PUT returns conflict details without marking the store unreachable", async () => {
  const { server } = fakeRevisionLayoutStore(["summit/a", "summit/b"]);
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const put = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["summit/b", "summit/a"], base_revision: 2, reason: "reorder" }),
    });
    assert.equal(put.status, 409);
    const body = await readJson(put);
    assert.equal(body.ok, false);
    assert.equal(body.error?.message, "layout revision conflict");
    assert.equal(body.data.reachable, true);
    assert.equal(body.data.conflict, true);
    assert.equal(body.data.revision, 3);
    assert.deepEqual(body.data.order, ["summit/a", "summit/b"]);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: PUT with the writer unset is accepted as a no-op (reachable:false, never 500)", async () => {
  const edge = createEdgeServer(makeEdgeConfig());
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["summit/a"] }),
    });
    assert.equal(r.status, 200);
    const body = await readJson(r);
    assert.equal(body.ok, true);
    assert.equal(body.data.reachable, false);
  } finally {
    closeServers(edge);
  }
});

test("layout: PUT with an unreachable writer degrades to reachable:false (no-op, never 500)", async () => {
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: "http://127.0.0.1:1", token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["summit/a"] }),
    });
    assert.equal(r.status, 200);
    const body = await readJson(r);
    assert.equal(body.data.reachable, false);
  } finally {
    closeServers(edge);
  }
});

test("layout: the configured token is forwarded as Authorization: Bearer on GET and PUT", async () => {
  const { server, seen } = fakeLayoutStore(["summit/a"], "layout-secret");
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: "layout-secret" } });
  const { base } = await listenOnLoopback(edge);
  try {
    const getBody = await readJson(await fetch(`${base}/api/layout`));
    assert.equal(getBody.data.reachable, true);
    assert.deepEqual(getBody.data.order, ["summit/a"]);

    const put = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: ["summit/z"] }),
    });
    assert.equal((await readJson(put)).data.reachable, true);
    assert.deepEqual(seen(), ["summit/z"]);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: a malformed (non-JSON) PUT body is rejected (422) and does NOT clear the store", async () => {
  const { server, seen } = fakeLayoutStore(["summit/a", "summit/b"]);
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    });
    assert.equal(r.status, 422);
    // The store must be untouched — a garbage body must not wipe the ranking.
    assert.deepEqual(seen(), ["summit/a", "summit/b"]);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: a PUT whose body lacks an order array is rejected (422)", async () => {
  const { server, seen } = fakeLayoutStore(["summit/a"]);
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: "nope" }),
    });
    assert.equal(r.status, 422);
    assert.deepEqual(seen(), ["summit/a"]);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: a non-empty order of all-invalid entries is rejected (422), not a silent clear", async () => {
  const { server, seen } = fakeLayoutStore(["summit/a"]);
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: [1, 2, 3] }),
    });
    assert.equal(r.status, 422);
    assert.deepEqual(seen(), ["summit/a"]); // store untouched
  } finally {
    closeServers(edge, server);
  }
});

test("layout: an intentional empty { order: [] } is accepted and clears the store", async () => {
  const { server, seen } = fakeLayoutStore(["summit/a", "summit/b"]);
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: [] }),
    });
    assert.equal(r.status, 200);
    assert.equal((await readJson(r)).data.reachable, true);
    assert.deepEqual(seen(), []);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: only GET and PUT are allowed", async () => {
  const edge = createEdgeServer(makeEdgeConfig());
  const { base } = await listenOnLoopback(edge);
  try {
    assert.equal((await fetch(`${base}/api/layout`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/api/layout`, { method: "DELETE" })).status, 405);
  } finally {
    closeServers(edge);
  }
});

test("layout: a cross-origin PUT with no token is refused (shared CSRF gate)", async () => {
  const { server } = fakeLayoutStore();
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({ ...makeEdgeConfig(), layout: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ order: ["summit/a"] }),
    });
    assert.equal(r.status, 403);
  } finally {
    closeServers(edge, server);
  }
});

test("layout: a token-authed PUT is exempt from the same-origin gate", async () => {
  const { server, seen } = fakeLayoutStore();
  const { base: readerBase } = await listenOnLoopback(server);
  const edge = createEdgeServer({
    ...makeEdgeConfig(),
    openAccess: false,
    clientToken: "client-secret",
    layout: { url: readerBase, token: null },
  });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/layout`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example",
        authorization: "Bearer client-secret",
      },
      body: JSON.stringify({ order: ["summit/a"] }),
    });
    assert.equal(r.status, 200);
    assert.equal((await readJson(r)).data.reachable, true);
    assert.deepEqual(seen(), ["summit/a"]);
  } finally {
    closeServers(edge, server);
  }
});
