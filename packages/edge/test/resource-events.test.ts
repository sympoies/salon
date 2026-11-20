import { readFileSync } from "node:fs";
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
  const file = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/history-file-part-v1.json", import.meta.url), "utf8"));
  const message = { id: "message", role: "user", text: "'/fixture/sessions/sample/attachments/stored.txt'" };
  for (const oversized of [false, true]) {
    let reads = 0;
    const upstream = jsonReader((url) => {
      assert.equal(url.pathname, "/history/sessions/history/messages");
      assert.equal(url.searchParams.get("direction"), "latest");
      assert.equal(url.searchParams.get("limit"), "100");
      assert.equal(url.searchParams.get("parts"), "v1"); reads++;
      return { status: 200, body: { ok: true, data: { source_path: "private", messages: [
        { id: "a1", role: "assistant", text: oversized ? "x".repeat(64 * 1024) : "new message", raw: "private" },
        { ...message, parts: [file] },
      ] } } };
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
      else assert.deepEqual(event.conversation, { messages: [{ id: "a1", role: "assistant", text: "new message" }, { ...message, files: [file] }] });
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

test("conversation snapshots fill sparse visible pages from older history", async () => {
  const { jsonReader } = await import("./support.ts");
  const calls: string[] = [];
  const upstream = jsonReader((url) => {
    calls.push(url.search);
    const older = url.searchParams.get("direction") === "older";
    return { status: 200, body: { ok: true, data: {
      messages: [{ id: older ? "old" : "new", role: "assistant", text: older ? "older text" : "latest text" },
        ...Array.from({ length: 99 }, (_, i) => ({ id: `${older ? "old" : "new"}-tool-${i}`, role: "assistant", text: "", parts: [{ type: "tool_call" }] }))],
      ...(older ? {} : { older_cursor: "previous" }),
    } } };
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
    assert.deepEqual(event.conversation.messages.map((message: { id: string }) => message.id), ["old", "new"]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => new URLSearchParams(call).get("limit") === "100"));
    await reader.cancel();
  } finally {
    controller.abort(); edge.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([edge, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

test("a live conversation update sends the changed suffix after the initial page", { timeout: 10_000 }, async () => {
  const { jsonReader } = await import("./support.ts");
  const { ResourceSseDecoder } = await import("@agent-console/shared/resources");
  const first = { id: "first", role: "user", text: "Review the sample changes." };
  const next = { id: "next", role: "assistant", text: "The sample is ready." };
  let messages = [first];
  const daemon = jsonReader(() => ({ status: 200, body: { ok: true, data: { messages } } }));
  const upstream = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "fixture", url: upstream.base, token: "fixture" }] }));
  const { base } = await listenOnLoopback(edge);
  const controller = new AbortController();
  try {
    const query = new URLSearchParams({ conversation_snapshots: "1", conversations: JSON.stringify([{ machine: "fixture", id: "history" }]) });
    const response = await fetch(`${base}/api/resources/events?${query}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new ResourceSseDecoder();
    const text = new TextDecoder();
    const changedPage = async () => {
      for (;;) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        const changed = decoder.push(text.decode(chunk.value, { stream: true })).find(event => event.type === "changed");
        if (changed) return changed;
      }
    };
    const initial = await changedPage();
    assert.deepEqual(initial.conversation?.messages, [first]);
    messages = [first, next];
    const changed = await changedPage();
    assert.deepEqual(changed.conversation?.messages, [next]);
    assert.deepEqual(changed.conversation_delta, { base_revision: initial.revision, retained: 1 });
  } finally {
    controller.abort();
    await Promise.all([edge, daemon].map(server => {
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    }));
  }
});

test("session reconciliation joins a pending watcher observation", { timeout: 10_000 }, async () => {
  const { createServer } = await import("node:http");
  const { SESSION_LIST_REVISION_HEADER } = await import("@agent-console/shared");
  let reads = 0;
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const firstRead = new Promise<void>(resolve => { started = resolve; });
  const daemon = createServer((_request, response) => {
    reads++;
    started();
    void pending.then(() => response.end(JSON.stringify({ ok: true, data: { observed_at: "2026-07-11T12:00:00Z", sessions: [{ id: "item" }] } })));
  });
  const upstream = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "fixture", url: upstream.base, token: "fixture" }] }));
  const { base } = await listenOnLoopback(edge);
  const controller = new AbortController();
  try {
    const watch = await fetch(`${base}/api/resources/events?resources=sessions`, { signal: controller.signal });
    await firstRead;
    const poll = fetch(`${base}/api/sessions`, { headers: { [SESSION_LIST_REVISION_HEADER]: "" } });
    await new Promise(resolve => setTimeout(resolve, 100));
    const concurrentReads = reads;
    await watch.body!.cancel();
    const fresh = fetch(`${base}/api/sessions`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const freshReads = reads;
    release();
    const result = await poll;
    assert.equal(result.status, 200, "canceling the watcher leaves reconciliation alive");
    const data = (await result.json() as any).data;
    assert.equal(data.machines[0].observed_at, "2026-07-11T12:00:00Z");
    assert.equal(data.sessions[0].activity_observed_at, "2026-07-11T12:00:00Z");
    assert.equal((await fresh).status, 200);
    assert.equal(concurrentReads, 1, "the reconciliation shares the pending spoke read");
    assert.equal(freshReads, 2, "an explicit fresh read bypasses the pending observation");
  } finally {
    release(); controller.abort(); edge.closeAllConnections(); daemon.closeAllConnections();
    await Promise.all([edge, daemon].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

test("concurrent session reads isolate principals and machine selections", { timeout: 10_000 }, async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { AccessStore } = await import("../src/accessStore.ts");
  const { SESSION_LIST_REVISION_HEADER } = await import("@agent-console/shared");
  const directory = mkdtempSync(join(tmpdir(), "session-observation-"));
  const database = join(directory, "access.sqlite");
  const access = new AccessStore(database);
  access.claimSession({ principalId: "alpha", machine: "one", sessionId: "a", incarnation: "a-inc" });
  access.claimSession({ principalId: "beta", machine: "one", sessionId: "b", incarnation: "b-inc" });
  access.close();
  let reads = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const daemon = createServer((_request, response) => {
    reads++;
    void pending.then(() => response.end(JSON.stringify({ ok: true, data: { sessions: [
      { id: "a", session_incarnation: "a-inc" }, { id: "b", session_incarnation: "b-inc" },
    ] } })));
  });
  const upstream = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, multiUser: true, accessDbPath: database,
    machines: [{ name: "one", url: upstream.base, token: "fixture" }, { name: "two", url: upstream.base, token: "fixture" }],
    principals: ["alpha", "beta"].map(id => ({ id, token: id, machines: ["one", "two"], permissions: [] })) }));
  const { base } = await listenOnLoopback(edge);
  const controller = new AbortController();
  try {
    const headers = (id: string) => ({ authorization: `Bearer ${id}`, [SESSION_LIST_REVISION_HEADER]: "" });
    const alpha = fetch(`${base}/api/sessions?machines=one`, { headers: headers("alpha") });
    const beta = fetch(`${base}/api/sessions?machines=one`, { headers: headers("beta") });
    const filtered = fetch(`${base}/api/sessions?machines=two`, { headers: headers("alpha") });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(reads, 3, "different principals and selections use distinct observations");
    release();
    const [a, b, c] = await Promise.all([alpha, beta, filtered].map(async result => (await (await result).json()) as any));
    assert.deepEqual(a.data.sessions.map((session: any) => session.id), ["a"]);
    assert.deepEqual(b.data.sessions.map((session: any) => session.id), ["b"]);
    assert.deepEqual(c.data.machines.map((machine: any) => machine.name), ["two"]);
  } finally {
    release(); controller.abort(); edge.closeAllConnections(); daemon.closeAllConnections();
    await Promise.all([edge, daemon].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed shared observation is retried after recovery", { timeout: 10_000 }, async () => {
  const { createServer } = await import("node:http");
  const { SESSION_LIST_REVISION_HEADER } = await import("@agent-console/shared");
  let reads = 0;
  let available = false;
  const daemon = createServer((_request, response) => {
    reads++;
    setTimeout(() => {
      response.statusCode = available ? 200 : 503;
      response.end(JSON.stringify({ ok: available, data: { sessions: [] } }));
    }, 100);
  });
  const upstream = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ machines: [{ name: "fixture", url: upstream.base, token: "fixture" }] }));
  const { base } = await listenOnLoopback(edge);
  try {
    const poll = async () => (await (await fetch(`${base}/api/sessions`, { headers: { [SESSION_LIST_REVISION_HEADER]: "" } })).json()) as any;
    const failed = await Promise.all([poll(), poll()]);
    assert.ok(failed.every(result => result.data.machines[0].ok === false));
    assert.equal(reads, 1, "concurrent readers share the unavailable spoke result");
    available = true;
    assert.equal((await poll()).data.machines[0].ok, true);
    assert.equal(reads, 2);
  } finally {
    edge.closeAllConnections(); daemon.closeAllConnections();
    await Promise.all([edge, daemon].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});
