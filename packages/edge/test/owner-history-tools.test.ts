import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

const fixture = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/history-owner-tool-parts-v1.json", import.meta.url), "utf8"));
function ownerKeyCount(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce((count, [key, child]) => count + Number(key.startsWith("owner_")) + ownerKeyCount(child), 0);
}

test("owner history fields are confined to owners over HTTP and concurrent SSE snapshots", { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "owner-history-tools-"));
  const accessPath = join(dir, "access.sqlite");
  const access = new AccessStore(accessPath);
  access.claimSession({ principalId: "owner", machine: "fixture", sessionId: "live", incarnation: "inc", provider: "codex", providerSessionId: "provider" });
  access.claimHistory("owner", "fixture", "history", "codex", "provider");
  access.close();
  let requests = 0;
  const daemon = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    assert.equal(url.pathname, "/history/sessions/history/messages");
    assert.equal(url.searchParams.get("parts"), "v1");
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: fixture, owner_future: "private" }));
  });
  const { base: upstream } = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: false, multiUser: true, accessDbPath: accessPath,
    machines: [{ name: "fixture", url: upstream }],
    principals: ["owner", "viewer", "isolated", "root"].map(id => ({ id, token: `test-${id}`, machines: ["fixture"], permissions: [] })),
    crossOwnerSessionAccess: [
      { owner: "owner", viewer: "viewer", sessions: [{ machine: "fixture", session_id: "live" }] },
      { owner: "viewer", viewer: "owner", sessions: [{ machine: "fixture", session_id: "live" }] },
    ],
  }));
  const { base } = await listenOnLoopback(edge);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const verify = (payload: any, owner: boolean) => {
    const parts = payload.messages.flatMap((row: any) => row.tool_parts ?? []);
    assert.equal(parts[0]?.input_summary, "cat [path]");
    assert.equal(parts[1]?.summary, "Read [path]");
    assert.equal(parts[2]?.summary, "Already masked");
    assert.equal(parts[2]?.owner_summary, undefined);
    if (owner) {
      assert.equal(parts[0]?.owner_input_summary, "cat /work/example/notes.txt");
      assert.equal(parts[1]?.owner_summary, "Read /work/example/notes.txt");
    } else assert.equal(ownerKeyCount(payload), 0);
  };
  try {
    // Keep the owner stream open while the shared viewer and root subscribe.
    for (const id of ["owner", "viewer", "root", "isolated"]) {
      const cookie = await loginCookie(base, `test-${id}`);
      const owner = id === "owner" || id === "root";
      await t.test(`${id} HTTP`, async () => {
        for (const suffix of ["", "?direction=latest", "?direction=older&cursor=before"]) {
          const response = await fetch(`${base}/api/history/sessions/fixture/history/messages${suffix}`, { headers: { cookie } });
          assert.equal(response.status, id === "isolated" ? 404 : 200);
          const body = await response.json();
          if (id === "isolated") assert.equal(ownerKeyCount(body), 0);
          else verify(body.data, owner);
          if (!owner) assert.equal(ownerKeyCount(body), 0);
        }
      });
      await t.test(`${id} SSE`, async () => {
        const query = new URLSearchParams({ conversations: JSON.stringify([{ machine: "fixture", id: "history" }]), conversation_snapshots: "1" });
        const stream = await fetch(`${base}/api/resources/events?${query}`, { headers: { cookie } });
        assert.equal(stream.status, id === "isolated" ? 404 : 200);
        if (id === "isolated") { assert.equal(ownerKeyCount(await stream.json()), 0); return; }
        const reader = stream.body!.getReader(); readers.push(reader);
        let bytes = "";
        while (!bytes.includes('"conversation":')) {
          const chunk = await reader.read(); assert.equal(chunk.done, false);
          bytes += new TextDecoder().decode(chunk.value);
        }
        const line = bytes.split("\n").find(line => line.startsWith("data:") && line.includes('"conversation":'))!;
        const event = JSON.parse(line.slice(5));
        verify(event.conversation, owner);
        if (!owner) assert.equal(ownerKeyCount(event), 0);
      });
    }
    await t.test("live owner projection switches to masked text after ownership becomes shared access", async () => {
      const db = new DatabaseSync(accessPath);
      for (const table of ["session_ownership", "history_ownership", "provider_ownership"]) {
        db.prepare(`UPDATE ${table} SET principal_id = ? WHERE principal_id = ?`).run("viewer", "owner");
      }
      db.close();
      const cookie = await loginCookie(base, "test-owner");
      const query = new URLSearchParams({ conversations: JSON.stringify([{ machine: "fixture", id: "history" }]), conversation_snapshots: "1" });
      const stream = await fetch(`${base}/api/resources/events?${query}`, { headers: { cookie } });
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader(); readers.push(reader);
      let bytes = "";
      while (!bytes.includes('"conversation":')) {
        const chunk = await reader.read(); assert.equal(chunk.done, false);
        bytes += new TextDecoder().decode(chunk.value);
      }
      const line = bytes.split("\n").find(line => line.startsWith("data:") && line.includes('"conversation":'))!;
      const event = JSON.parse(line.slice(5));
      assert.equal(ownerKeyCount(event), 0);
      verify(event.conversation, false);
    });
    assert.equal(requests > 0, true);
  } finally {
    await Promise.all(readers.map(reader => reader.cancel()));
    edge.closeAllConnections(); daemon.closeAllConnections();
    await Promise.all([new Promise<void>(r => edge.close(() => r())), new Promise<void>(r => daemon.close(() => r()))]);
    rmSync(dir, { recursive: true, force: true });
  }
});
