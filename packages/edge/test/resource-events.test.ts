import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createEdgeServer } from "../src/server.ts";
import { makeEdgeConfig, listenOnLoopback } from "./support.ts";

test("resource notifications authenticate and emit metadata-only session revisions", async () => {
  const server = createEdgeServer(makeEdgeConfig({ openAccess: false, clientToken: "test-token" }));
  const { base } = await listenOnLoopback(server);
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${base}/api/resources/events?resources=sessions`)).status, 401);
    const response = await fetch(`${base}/api/resources/events?resources=sessions`, {
      headers: { authorization: "Bearer test-token" }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes('"resource":"sessions"')) {
      const result = await reader.read();
      assert.equal(result.done, false);
      text += new TextDecoder().decode(result.value);
    }
    const frame = text.split("\n").find((line) => line.startsWith("data: "))!;
    const event = JSON.parse(frame.slice(6));
    assert.equal(event.type, "changed");
    assert.deepEqual(Object.keys(event).sort(), ["resource", "revision", "schema_version", "type"]);
    await reader.cancel();
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("resource subscriptions validate conversation ownership before contacting upstream", async () => {
  const server = createEdgeServer(makeEdgeConfig({ openAccess: false, clientToken: "test-token", machines: [] }));
  const { base } = await listenOnLoopback(server);
  try {
    const params = new URLSearchParams({ resources: "", conversations: JSON.stringify([{ machine: "outside", id: "private-history" }]) });
    const response = await fetch(`${base}/api/resources/events?${params}`, { headers: { authorization: "Bearer test-token" } });
    assert.equal(response.status, 404);
    assert.equal((await fetch(`${base}/api/resources/events?resources=unknown`, { headers: { authorization: "Bearer test-token" } })).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("watch capacity exhaustion returns a service error before SSE headers", async () => {
  const server = createEdgeServer(makeEdgeConfig({ machines: [{ name: "host", url: "http://127.0.0.1:1", token: "fixture" }] }));
  const { base } = await listenOnLoopback(server);
  const control = new AbortController();
  // Keep every open stream referenced: an unconsumed fetch body is cancelled
  // when its Response is garbage collected, which closes the SSE connection
  // and releases its watches before the capacity probe.
  const open: Response[] = [];
  try {
    for (let group = 0; group < 32; group += 1) {
      const conversations = Array.from({ length: 8 }, (_, index) => ({ machine: "host", id: `history-${group}-${index}` }));
      const params = new URLSearchParams({ resources: "", conversations: JSON.stringify(conversations) });
      const response = await fetch(`${base}/api/resources/events?${params}`, { signal: control.signal });
      open.push(response);
      assert.equal(response.status, 200);
    }
    const exhausted = await fetch(`${base}/api/resources/events?resources=sessions`, { signal: control.signal });
    assert.equal(exhausted.status, 503);
    assert.match(exhausted.headers.get("content-type") ?? "", /application\/json/);
  } finally {
    await Promise.all(open.map((response) => response.body?.cancel().catch(() => {})));
    control.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("conversation events push projected pages and keep oversized pages on the poll/refetch fallback", async () => {
  const { jsonReader } = await import("./support.ts");
  for (const oversized of [false, true]) {
    let reads = 0;
    const upstream = jsonReader((url) => {
      assert.equal(url.pathname, "/history/sessions/history/messages");
      assert.equal(url.searchParams.get("direction"), "latest");
      assert.equal(url.searchParams.get("limit"), "50"); reads++;
      return { status: 200, body: { ok: true, data: { source_path: "private", messages: [
        { id: "a1", role: "assistant", text: oversized ? "x".repeat(64 * 1024) : "new message", raw: "private" },
      ], older_cursor: "older" } } };
    });
    const daemon = await listenOnLoopback(upstream);
    const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "host", url: daemon.base, token: "fixture" }] }));
    const { base } = await listenOnLoopback(edge);
    const controller = new AbortController();
    try {
      const query = new URLSearchParams({ conversations: JSON.stringify([{ machine: "host", id: "history" }]), conversation_snapshots: "1" });
      const response = await fetch(`${base}/api/resources/events?${query}`, { signal: controller.signal });
      const reader = response.body!.getReader(); let frame = "";
      while (!frame.includes("data: ")) frame += new TextDecoder().decode((await reader.read()).value);
      const event = JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6));
      assert.equal(event.type, "changed"); assert.equal(reads, 1);
      assert.equal(frame.includes("private"), false);
      if (oversized) assert.equal(event.conversation, undefined, "payload omitted; client retains existing latest-page fetch");
      else assert.deepEqual(event.conversation, { messages: [{ id: "a1", role: "assistant", text: "new message" }], older_cursor: "older" });
      await reader.cancel();
    } finally {
      controller.abort(); edge.closeAllConnections(); upstream.closeAllConnections();
      await Promise.all([edge, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  }
});

test("eight near-limit snapshots fall back to metadata within the shared slow-client byte budget", async () => {
  const { ServerResponse } = await import("node:http");
  const { jsonReader } = await import("./support.ts");
  const upstream = jsonReader(() => ({ status: 200, body: { ok: true, data: { messages: [{ id: "a", role: "assistant", text: "x".repeat(58 * 1024) }] } } }));
  const daemon = await listenOnLoopback(upstream);
  const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "host", url: daemon.base, token: "fixture" }] }));
  const { base } = await listenOnLoopback(edge);
  const original = ServerResponse.prototype.write;
  let buffered = 0;
  // Simulate a transport whose writes have not drained. Still deliver the
  // bytes locally so the test can inspect every emitted frame deterministically.
  ServerResponse.prototype.write = function (chunk: any, ...args: any[]): any {
    if (this.getHeader("content-type") === "text/event-stream; charset=utf-8" && String(chunk).startsWith("event:")) {
      Object.defineProperty(this, "writableLength", { configurable: true, get: () => buffered });
      buffered += Buffer.byteLength(String(chunk));
    }
    return (original as any).call(this, chunk, ...args);
  };
  const controller = new AbortController();
  try {
    const query = new URLSearchParams({ conversation_snapshots: "1", conversations: JSON.stringify(Array.from({ length: 8 }, (_, index) => ({ machine: "host", id: `history-${index}` }))) });
    const response = await fetch(`${base}/api/resources/events?${query}`, { signal: controller.signal });
    const reader = response.body!.getReader(); let frames = "";
    while (frames.split("data: ").length - 1 < 8) {
      const chunk = await reader.read(); assert.equal(chunk.done, false, "congested stream stays connected");
      frames += new TextDecoder().decode(chunk.value);
    }
    const events = frames.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.length, 8); assert.equal(events.filter(event => event.conversation).length, 1);
    assert.ok(events.every(event => event.type === "changed"));
    assert.ok(buffered <= 64 * 1024, "payload and metadata share a prospective stream byte budget");
    await reader.cancel();
  } finally {
    ServerResponse.prototype.write = original; controller.abort(); edge.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([edge, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

for (const invalidation of ["logout", "expiry"] as const) {
  for (const revokedSubscriber of [0, 1]) {
    test(`conversation delivery rejects ${invalidation} of subscriber ${revokedSubscriber + 1} without revoking its same-principal sibling`, { timeout: 10_000 }, async () => {
      const { createHash } = await import("node:crypto");
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { createServer } = await import("node:http");
      const { DatabaseSync } = await import("node:sqlite");
      const { loginCookie } = await import("./support.ts");
      const directory = mkdtempSync(join(tmpdir(), "resource-auth-"));
      const database = join(directory, "access.sqlite");
      let release: (() => void) | undefined;
      const pendingPage = new Promise<void>(resolve => { release = resolve; });
      let reads = 0;
      let message = "written after revocation";
      const upstream = createServer((_req, res) => {
        reads += 1;
        void pendingPage.then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, data: { messages: [{ id: `m${reads}`, role: "assistant", text: message }] } }));
        });
      });
      const daemon = await listenOnLoopback(upstream);
      const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, clientToken: "fixture-token", accessDbPath: database,
        machines: [{ name: "host", url: daemon.base, token: "fixture" }] }));
      const { base } = await listenOnLoopback(edge);
      const controller = new AbortController();
      try {
        const cookies = [await loginCookie(base, "fixture-token"), await loginCookie(base, "fixture-token")];
        const query = new URLSearchParams({ conversation_snapshots: "1", conversations: JSON.stringify([{ machine: "host", id: "history" }]) });
        const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
        for (const cookie of cookies) {
          const response = await fetch(`${base}/api/resources/events?${query}`, { headers: { cookie }, signal: controller.signal });
          assert.equal(response.status, 200);
          readers.push(response.body!.getReader());
        }
        const revokedCookie = cookies[revokedSubscriber]!;
        if (invalidation === "logout") {
          const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: revokedCookie } });
          assert.equal(logout.status, 200);
        } else {
          // Expire only this session at the real SessionStore boundary. The
          // sibling cookie stays valid, without changing clocks or production TTL.
          const db = new DatabaseSync(database);
          try {
            const id = revokedCookie.slice("ac_session=".length);
            db.prepare("UPDATE auth_sessions SET expires_at = 0 WHERE id_hash = ?").run(createHash("sha256").update(id).digest("hex"));
          } finally { db.close(); }
        }
        assert.equal((await fetch(`${base}/api/history/host/sessions/history/messages`, { headers: { cookie: revokedCookie } })).status, 401);
        assert.equal((await fetch(`${base}/api/auth/status`, { headers: { cookie: cookies[1 - revokedSubscriber]! } }).then(response => response.json()) as { authenticated: boolean }).authenticated, true);
        assert.equal(reads, 1, "same-principal readers share the pending source read");
        release!();
        let revokedText = "";
        for (;;) {
          const chunk = await readers[revokedSubscriber]!.read();
          if (chunk.done) break;
          revokedText += new TextDecoder().decode(chunk.value);
          assert.equal(revokedText.includes("written after revocation"), false, "invalid credential must not receive a new transcript body");
        }
        const valid = readers[1 - revokedSubscriber]!;
        let validText = "";
        while (!validText.includes("written after revocation")) {
          const chunk = await valid.read();
          assert.equal(chunk.done, false, "valid sibling remains connected");
          validText += new TextDecoder().decode(chunk.value);
        }
        message = "next observed page";
        while (!validText.includes(message)) {
          const chunk = await valid.read();
          assert.equal(chunk.done, false, "revoked listener does not control the shared producer");
          validText += new TextDecoder().decode(chunk.value);
        }
        assert.equal(reads, 2, "valid sibling retains the shared poll after invalid listener teardown");
        await valid.cancel();
      } finally {
        release!(); controller.abort(); edge.closeAllConnections(); upstream.closeAllConnections();
        await Promise.all([edge, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
