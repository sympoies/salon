import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { createEdgeServer } from "../src/server.ts";
import { PRINCIPAL_PERMISSIONS } from "../src/config.ts";
import { closeServers, makeEdgeConfig, jsonReader, listenOnLoopback, type JsonResult } from "./support.ts";

// The edge cannot read the host's ~/.codex / ~/.claude (hardened container, and
// those files hold live API keys / OAuth tokens). It proxies /api/usage to a
// host-local usage reader (AGENT_CONSOLE_USAGE_URL), exactly like the Hermes
// panel. These tests stand a fake reader up on loopback and assert the proxy +
// graceful-degradation contract so the panel can tell "reader down / not
// configured" apart from a genuine "no providers".

function fakeReader(handler: () => JsonResult): Server {
  return jsonReader((u) => {
    if (u.pathname === "/usage") {
      return handler();
    }
    return null;
  });
}

test("usage: reader not configured -> reachable:false, empty providers (no host access)", async () => {
  const edge = createEdgeServer(makeEdgeConfig());
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/usage`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { ok: boolean; data: { providers: unknown[]; reachable: boolean } };
    assert.equal(body.ok, true);
    assert.equal(body.data.reachable, false);
    assert.deepEqual(body.data.providers, []);
  } finally {
    closeServers(edge);
  }
});

test("usage: a live reader is proxied through with reachable:true", async () => {
  const reader = fakeReader(() => ({
    status: 200,
    body: {
      providers: [
        {
          provider: "codex",
          label: "Codex",
          ok: true,
          windows: [{ key: "5h", label: "5h", used_percent: 86, window_minutes: 300, resets_at: 1783288112 }],
        },
      ],
    },
  }));
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), usage: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/usage`);
    const body = (await r.json()) as {
      data: { providers: Array<{ provider: string; windows: unknown[] }>; reachable: boolean };
    };
    assert.equal(body.data.reachable, true);
    assert.equal(body.data.providers.length, 1);
    assert.equal(body.data.providers[0]?.provider, "codex");
    assert.equal(body.data.providers[0]?.windows.length, 1);
  } finally {
    closeServers(edge, reader);
  }
});

test("usage: refresh=1 is forwarded to the host reader", async () => {
  const paths: string[] = [];
  const reader = createServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"providers":[]}');
  });
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), usage: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const response = await fetch(`${base}/api/usage?refresh=1`);
    assert.equal(response.status, 200);
    assert.deepEqual(paths, ["/usage?refresh=1"]);
  } finally {
    closeServers(edge, reader);
  }
});

test("usage: an unreachable reader degrades to reachable:false (never 500s the panel)", async () => {
  const edge = createEdgeServer({ ...makeEdgeConfig(), usage: { url: "http://127.0.0.1:1", token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/usage`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { data: { reachable: boolean; providers: unknown[] } };
    assert.equal(body.data.reachable, false);
    assert.deepEqual(body.data.providers, []);
  } finally {
    closeServers(edge);
  }
});

test("usage: a reader 5xx degrades to reachable:false with the status surfaced", async () => {
  const reader = fakeReader(() => ({ status: 502, body: { error: "boom" } }));
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), usage: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/usage`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { data: { reachable: boolean; error?: string } };
    assert.equal(body.data.reachable, false);
    assert.match(body.data.error ?? "", /502/);
  } finally {
    closeServers(edge, reader);
  }
});

test("usage: only GET is allowed", async () => {
  const edge = createEdgeServer(makeEdgeConfig());
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/usage`, { method: "POST" });
    assert.equal(r.status, 405);
  } finally {
    closeServers(edge);
  }
});

test("usage: a 200 with a non-JSON body degrades to reachable:false (res.json throws -> caught)", async () => {
  const reader = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/usage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not json"); // JSON.parse in fetchUsage rejects
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), usage: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/usage`);
    assert.equal(r.status, 200); // never a 500
    const body = (await r.json()) as { data: { reachable: boolean; providers: unknown[] } };
    assert.equal(body.data.reachable, false);
    assert.deepEqual(body.data.providers, []);
  } finally {
    closeServers(edge, reader);
  }
});

test("usage: a reader that sends headers then stalls the body is still bounded by the reader timeout", async () => {
  const reader = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/usage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"providers":[');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), usage: { url: readerBase, token: null, timeoutMs: 25 } });
  const { base } = await listenOnLoopback(edge);
  const started = Date.now();
  try {
    const r = await fetch(`${base}/api/usage`, { signal: AbortSignal.timeout(1000) });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { data: { reachable: boolean; providers: unknown[] } };
    assert.equal(body.data.reachable, false);
    assert.deepEqual(body.data.providers, []);
    assert.ok(Date.now() - started < 1000);
  } finally {
    closeServers(edge, reader);
  }
});

test("usage: an oversized reader body degrades to reachable:false (size cap, no OOM/500)", async () => {
  const huge = `{"providers":[{"provider":"codex","junk":"${"x".repeat(700 * 1024)}"}]}`;
  const reader = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/usage") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(huge); // > MAX_RESPONSE_BYTES (512 KiB) -> capped read throws
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), usage: { url: readerBase, token: null } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/usage`);
    assert.equal(r.status, 200); // never a 500
    const body = (await r.json()) as { data: { reachable: boolean; providers: unknown[] } };
    assert.equal(body.data.reachable, false);
    assert.deepEqual(body.data.providers, []);
  } finally {
    closeServers(edge, reader);
  }
});

test("usage: the configured reader token is forwarded as an Authorization: Bearer header", async () => {
  let seenAuth: string | undefined;
  const reader = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/usage") {
      seenAuth = req.headers.authorization;
      if (seenAuth !== "Bearer usage-secret") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ providers: [{ provider: "codex", label: "Codex", ok: true, windows: [] }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer({ ...makeEdgeConfig(), usage: { url: readerBase, token: "usage-secret" } });
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/usage`);
    const body = (await r.json()) as { data: { reachable: boolean; providers: Array<{ provider: string }> } };
    assert.equal(seenAuth, "Bearer usage-secret");
    assert.equal(body.data.reachable, true);
    assert.equal(body.data.providers[0]?.provider, "codex");
  } finally {
    closeServers(edge, reader);
  }
});

test("usage: multi-user principals only see Claude hosts they may access", async () => {
  const reader = fakeReader(() => ({
    status: 200,
    body: {
      providers: [
        { provider: "claude", account: "max@example.com", hosts: ["summit"] },
        { provider: "claude", account: "team@example.com", hosts: ["cedar", "mesa"] },
        { provider: "claude", label: "Claude" },
        { provider: "codex", account: "galaxy" },
      ],
    },
  }));
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer(makeEdgeConfig({
    openAccess: false,
    multiUser: true,
    usage: { url: readerBase, token: null },
    principals: [
      { id: "tess", token: "tess-token", machines: ["summit", "cedar", "mesa"], permissions: [...PRINCIPAL_PERMISSIONS] },
      { id: "dana", token: "dana-token", machines: ["summit", "mesa"], permissions: [...PRINCIPAL_PERMISSIONS] },
      { id: "guest", token: "guest-token", machines: ["maple"], permissions: [...PRINCIPAL_PERMISSIONS] },
    ],
  }));
  const { base } = await listenOnLoopback(edge);
  const read = async (token: string) => {
    const r = await fetch(`${base}/api/usage`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await r.json()) as { data: { providers: Array<{ provider: string; account: string | null; hosts?: string[] }> } };
    return body.data.providers.map((p) => `${p.provider}:${p.account}:${p.hosts?.join(",") ?? "-"}`);
  };
  try {
    assert.deepEqual(await read("tess-token"), [
      "claude:max@example.com:summit", "claude:team@example.com:cedar,mesa", "claude:null:-", "codex:galaxy:-",
    ]);
    assert.deepEqual(await read("dana-token"), [
      "claude:max@example.com:summit", "claude:team@example.com:mesa", "claude:null:-", "codex:galaxy:-",
    ]);
    assert.deepEqual(await read("guest-token"), ["claude:null:-", "codex:galaxy:-"]);
  } finally {
    closeServers(edge, reader);
  }
});

test("usage: a per-host entry naming no valid host never reaches another principal", async () => {
  const reader = fakeReader(() => ({
    status: 200,
    body: { providers: [
      { provider: "claude", account: "hidden@example.com", hosts: [] },
      { provider: "claude", account: "long@example.com", hosts: ["x".repeat(65)] },
    ] },
  }));
  const { base: readerBase } = await listenOnLoopback(reader);
  const edge = createEdgeServer(makeEdgeConfig({
    openAccess: false,
    multiUser: true,
    usage: { url: readerBase, token: null },
    principals: [{ id: "guest", token: "guest-token", machines: ["maple"], permissions: [...PRINCIPAL_PERMISSIONS] }],
  }));
  const { base } = await listenOnLoopback(edge);
  try {
    const r = await fetch(`${base}/api/usage`, { headers: { authorization: "Bearer guest-token" } });
    const body = (await r.json()) as { data: { providers: unknown[] } };
    assert.deepEqual(body.data.providers, []);
  } finally {
    closeServers(edge, reader);
  }
});

test("usage: an agent-session serve reader is read at its configured path and its envelope unwrapped", async () => {
  const paths: string[] = [];
  const serve = createServer((req, res) => {
    paths.push(req.url ?? "");
    if (new URL(req.url ?? "/", "http://x").pathname !== "/usage/v1") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      schema_version: "cli.agent-session.serve.v1",
      ok: true,
      data: {
        machine: "summit",
        usage: {
          schema_version: "agent-session.provider-usage.v1",
          providers: [
            { provider: "codex", account: "sym", label: "Codex", ok: true, windows: [], reset_credits: { available_count: 1 } },
            { provider: "claude", account: null, label: "Claude", ok: true, windows: [] },
          ],
        },
      },
    }));
  });
  const { base: serveBase } = await listenOnLoopback(serve);
  const edge = createEdgeServer({ ...makeEdgeConfig(), usage: { url: serveBase, token: null, path: "/usage/v1" } });
  const { base } = await listenOnLoopback(edge);
  try {
    const plain = (await (await fetch(`${base}/api/usage`)).json()) as {
      data: { reachable: boolean; providers: Array<{ provider: string; account: string | null }> };
    };
    await fetch(`${base}/api/usage?refresh=1`);
    assert.deepEqual(paths, ["/usage/v1", "/usage/v1?refresh=1"]);
    assert.equal(plain.data.reachable, true);
    assert.deepEqual(plain.data.providers.map((p) => `${p.provider}:${p.account}`), ["codex:sym", "claude:null"]);
  } finally {
    closeServers(edge, serve);
  }
});
