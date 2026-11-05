import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SharedOutboxSnapshot } from "@agent-console/shared/shared-outbox";
import { createEdgeServer } from "../../src/server.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "../support.ts";

/** Real edge/SQLite lifecycle; only the native provider is synthetic. */
export async function archiveResumeOutbox() {
  const directory = mkdtempSync(join(tmpdir(), "salon-archive-outbox-"));
  const network = globalThis.fetch;
  let incarnation = "inc-1", present = true, posts = 0;
  let archiveResult: unknown;
  const session = () => ({ id: "shared-reply", agent: "codex", status: "running", session_incarnation: incarnation,
    provider_resume: { provider: "codex", session_id: "fixture-thread" } });
  const daemon = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") return void res.end(JSON.stringify({ ok: true, data: { sessions: present ? [session()] : [] } }));
    if (req.url === "/sessions/shared-reply/archive") {
      if (!present) {
        res.writeHead(404);
        return void res.end(JSON.stringify({ ok: false, error: { code: "session-not-found" } }));
      }
      present = false;
      const body = { ok: true, data: {
        archived: { history_id: "fixture-history", provider: "codex", provider_session_id: "fixture-thread",
          cwd: "/work/example", created_at: "2030-01-01T00:00:00Z", updated_at: "2030-01-01T00:00:01Z", archived_at: "2030-01-01T00:00:02Z" },
        deleted: { id: "shared-reply", deleted: true, killed: true, cleanup_pending: false },
      } };
      archiveResult = { status: 200, body };
      return void res.end(JSON.stringify(body));
    }
    if (req.url === "/history/sessions/fixture-history/resume") {
      incarnation = "inc-2"; present = true;
      return void res.end(JSON.stringify({ ok: true, data: { session: session() } }));
    }
    if (req.url === "/sessions/shared-reply/prompt/v2") {
      let text = ""; for await (const chunk of req) text += String(chunk);
      const body = JSON.parse(text); posts++;
      res.writeHead(409);
      return void res.end(JSON.stringify({ ok: false, error: { code: "composer-not-empty", details: { receipt: {
        request_id: body.request_id, session_id: "shared-reply", session_incarnation: body.expected_session_incarnation,
        outcome: "refused", code: "composer-not-empty",
      } } } }));
    }
    res.writeHead(404); res.end(JSON.stringify({ ok: false, error: { code: "not-found" } }));
  });
  const upstream = await listenOnLoopback(daemon);
  const config = makeEdgeConfig({ openAccess: false, clientToken: "client-secret", accessDbPath: join(directory, "state.sqlite"),
    machines: [{ name: "fixture", url: upstream.base, token: "synthetic-upstream" }] });
  let edge = createEdgeServer(config, { outboxPollIntervalMs: 10 });
  let { base } = await listenOnLoopback(edge), cookie = await loginCookie(base);
  const stop = async (server: Server) => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  };
  const request = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie); headers.set("origin", base); headers.set("content-type", "application/json");
    headers.set("x-console-expected-principal", "legacy");
    return network(`${base}${path}`, { ...init, headers });
  };
  const list = async (expected = incarnation) => {
    const res = await request(`/api/sessions/fixture/shared-reply/outbox?expected_session_incarnation=${expected}`);
    assert.equal(res.status, 200); return (await res.json() as { data: SharedOutboxSnapshot }).data;
  };
  const until = async (check: () => Promise<boolean>) => {
    for (let n = 0; n < 150; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail("expected shared reply transition");
  };
  return { request, list, until, posts: () => posts,
    async archiveAndResume({ duplicateArchive = false, legacyFence = false } = {}) {
      const archived = await request("/api/sessions/fixture/shared-reply/archive", { method: "POST",
        body: JSON.stringify({ expected_session_incarnation: incarnation }) });
      assert.equal(archived.status, 200);
      if (duplicateArchive) {
        const duplicate = await request("/api/sessions/fixture/shared-reply/archive", { method: "POST",
          body: JSON.stringify({ expected_session_incarnation: incarnation }) });
        assert.equal(duplicate.status, 404);
        assert.equal((await duplicate.json() as { error: { code: string } }).error.code, "session-not-found");
      }
      if (legacyFence) {
        // Recreate the pre-fix durable row after its archive has completed.
        const db = new DatabaseSync(config.accessDbPath!);
        db.prepare("INSERT INTO outbox_lifecycle(machine,session_id) VALUES(?,?)").run("fixture", "shared-reply");
        db.close();
      }
      const resumed = await request("/api/history/sessions/fixture/fixture-history/resume", { method: "POST" });
      assert.equal(resumed.status, 200);
    },
    repairLegacyFence() {
      chmodSync(config.accessDbPath!, 0o600);
      const cli = fileURLToPath(new URL("../../scripts/outbox-lifecycle.ts", import.meta.url));
      const args = ["--conditions=source", cli, "--db", config.accessDbPath!, "--machine", "fixture", "--session", "shared-reply"];
      const run = (extra: string[]) => execFileSync(process.execPath, [...args, ...extra], { encoding: "utf8" });
      const { fence } = JSON.parse(run([]));
      const proofPath = join(directory, "proof.json"), planPath = join(directory, "plan.json");
      writeFileSync(proofPath, JSON.stringify({ schema_version: "outbox-archive-proof.v1", machine: "fixture", session_id: "shared-reply",
        owner_token: fence.ownerToken, fenced_incarnation: "inc-1", verified_completed_archive: true, archive_result: archiveResult }), { mode: 0o600 });
      writeFileSync(planPath, run(["--proof-file", proofPath]), { mode: 0o600 });
      assert.equal(JSON.parse(run([])).fence.incarnation, null, "dry-run retains the fence without assigning provenance");
      assert.deepEqual(JSON.parse(run(["--proof-file", proofPath, "--apply-plan", planPath])), { repaired: true });
    },
    async restart() {
      await stop(edge); edge = createEdgeServer(config, { outboxPollIntervalMs: 10 });
      ({ base } = await listenOnLoopback(edge)); cookie = await loginCookie(base);
    },
    async close() { await stop(edge); await stop(daemon); rmSync(directory, { recursive: true, force: true }); },
  };
}
