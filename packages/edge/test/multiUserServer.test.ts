import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import net, { type Server as NetServer } from "node:net";
import { ActivitySseDecoder } from "@agent-console/shared/activity";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import type { PrincipalPermission } from "../src/config.ts";
import { closeServers, listenOnLoopback, makeEdgeConfig } from "./support.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "agent-console-multi-user-"));
const statePath = join(tempRoot, "access.sqlite");
let daemon: HttpServer;
let edge: NetServer;
let base = "";
let edgePort = 0;
let daemonRequests = 0;
let daemonUpgrades = 0;
let lastShellOwner = "";
let lastUpgradePath = "";
let providerCreateMode: "valid" | "wrong-thread" | "failed" = "valid";
// Keeps the created session but answers an error, as serve does when a create
// outlives its own prompt budget.
let errorAfterCreate = false;
let resumeResponseMode: "valid" | "wrong-id" | "empty-incarnation" | "failed" = "valid";
let maintenanceResponseMode: "valid" | "malformed" | "legacy-null" = "valid";
let previewIncarnationOverride: string | null = null;
let resumeActionRequests = 0;
let failSnapshotAfterResume = false;
let failNextSessionList = false;
const daemonSessions: Array<Record<string, unknown>> = [
  {
    id: "owner-session", agent: "codex", status: "running", session_incarnation: "owner-inc",
    agent_env: { TOKEN: "private-test-sentinel" },
    launcher: { path: "/private/launcher" },
  },
  {
    id: "owner-worker",
    agent: "codex",
    status: "running",
    session_incarnation: "owner-worker-inc",
    orchestration: {
      schema_version: "agent-session.session-orchestration.v1",
      run_id: "run-owner",
      role: "worker",
      assignment_id: "assignment-owner-worker",
      primary_manager: {
        session_id: "owner-session",
        session_incarnation: "owner-inc",
        session_created_at: "2026-09-21T00:00:00Z",
      },
      relationship_revision: 1,
      run_state: "active",
      assignment_state: "working",
      objective_summary: "Test exact manager ownership inheritance",
    },
  },
  { id: "viewer-session", agent: "claude", status: "running", session_incarnation: "viewer-inc" },
  { id: "reused-session", agent: "codex", status: "running", session_incarnation: "inc-new" },
  { id: "unowned-session", agent: "codex", status: "running", session_incarnation: "other-inc" },
];

const rootPermissions: PrincipalPermission[] = [];
const principals = [
  { id: "root", token: "root-token", machines: [], permissions: rootPermissions },
  {
    id: "owner",
    token: "owner-token",
    machines: ["hub", "host-d"],
    permissions: ["debug", "usage", "codex_reset", "provider_import"] as const,
  },
  {
    id: "viewer", token: "viewer-token", machines: ["hub", "host-a"], permissions: [],
    defaultVisibleMachines: ["host-a"], defaultCreateMachine: "host-a",
  },
  { id: "second-operator", token: "second-operator-token", machines: ["hub"], permissions: ["provider_import"] as const },
];

before(async () => {
  daemon = createHttpServer(async (req, res) => {
    daemonRequests += 1;
    if (req.url?.startsWith("/shells/")) {
      const owner = req.url.split("/")[2];
      lastShellOwner = owner ?? "";
      res.end(JSON.stringify({ ok: true, data: { shell: { schema_version:"agent-session.shell.v1", owner, status:"running", incarnation:"shell-inc", tmux_name:`ac-shell-${owner}` } } }));
      return;
    }
    if (req.url === "/activity/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`id: boot:1\nevent: snapshot\ndata: ${JSON.stringify({
        schema_version: "agent-session.activity-stream.event.v1",
        type: "snapshot",
        stream_id: "boot",
        sequence: 1,
        machine: "daemon-name",
        observed_at: "2026-09-21T00:00:00Z",
        sessions: [
          { id: "owner-session", turn_state: null },
          { id: "viewer-session", turn_state: null },
          { id: "reused-session", turn_state: null },
          { id: "unowned-session", turn_state: null },
        ],
      })}\n\n`);
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/history/sessions") {
      res.end(JSON.stringify({ ok: true, data: { sessions: [
        {
          id: "owner-history", provider: "codex", provider_session_id: "owner-provider",
          cwd: "/repo", created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-21T00:00:00Z",
        },
        {
          id: "viewer-history", provider: "claude", provider_session_id: "viewer-provider",
          cwd: "/repo", created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-21T00:00:00Z",
        },
      ] } }));
      return;
    }
    if (req.url === "/sessions") {
      if (failNextSessionList) {
        failNextSessionList = false;
        res.writeHead(503);
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (providerCreateMode === "failed") {
          res.writeHead(404);
          res.end(JSON.stringify({ ok: false, error: { message: "provider session not found" } }));
          return;
        }
        const providerId = body.provider_resume_id ?? body.resume_id;
        const session = {
          id: body.id,
          agent: body.agent,
          status: "running",
          session_incarnation: `inc-${body.id}`,
          ...(typeof providerId === "string"
            ? { provider_resume: { provider: body.agent, session_id: providerCreateMode === "wrong-thread" ? "other-thread" : providerId } }
            : {}),
        };
        daemonSessions.push(session);
        if (errorAfterCreate) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: { code: "structured-prompt-outcome-unknown", message: "unknown" } }));
          return;
        }
        res.end(JSON.stringify({ ok: true, data: { session } }));
        return;
      }
      res.end(JSON.stringify({ ok: true, data: { sessions: daemonSessions } }));
      return;
    }
    if (req.url === "/sessions/owner-session/glance" || req.url === "/sessions/auto-recovered/glance") {
      res.end(JSON.stringify({ ok: true, data: { text: "owner private output" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/owner-session/resume") {
      if (resumeResponseMode === "failed") {
        res.writeHead(409);
        res.end(JSON.stringify({ ok: false, error: { code: "resume-blocked", message: "retry later" } }));
        return;
      }
      const session = daemonSessions.find((entry) => entry.id === "owner-session")!;
      if (resumeResponseMode === "wrong-id") {
        res.end(JSON.stringify({ ok: true, data: { session: {
          id: "another-session", session_incarnation: "unconfirmed-inc",
        } } }));
        return;
      }
      if (resumeResponseMode === "empty-incarnation") {
        res.end(JSON.stringify({ ok: true, data: { session: {
          id: "owner-session", session_incarnation: "",
        } } }));
        return;
      }
      session.session_incarnation = "owner-resumed-inc";
      res.end(JSON.stringify({ ok: true, data: { session } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions/owner-session/maintenance?operation=resume") {
      const session = daemonSessions.find((entry) => entry.id === "owner-session")!;
      res.end(JSON.stringify({ ok: true, data: { maintenance: {
        schema_version: "agent-session.session-maintenance.v1",
        session_id: "owner-session", operation: "resume", state: "healthy",
        session_incarnation: maintenanceResponseMode === "legacy-null"
          ? null : previewIncarnationOverride ?? session.session_incarnation,
        session_generation: maintenanceResponseMode === "legacy-null" ? null : 1,
        issue: null,
        boundary: { kind: "tmux_session", safe_process_count: 0 },
        preservation: {
          session_metadata_retained_until_success: true,
          provider_conversation_retained: true,
          destructive_scope: "verified_recorded_runtime_only",
        },
        actions: [{
          id: "retry_resume", label: "Retry resume", destructive: false,
          requires_confirmation: false, preserves_session_metadata: true,
        }],
        preview_digest: `sha256:${"a".repeat(64)}`,
      } } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions/owner-session/maintenance/actions") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      resumeActionRequests += 1;
      if (resumeResponseMode === "failed") {
        res.writeHead(409);
        res.end(JSON.stringify({ ok: false, error: { code: "resume-blocked", message: "retry later" } }));
        return;
      }
      if (maintenanceResponseMode === "malformed") {
        res.end(JSON.stringify({ ok: true, data: { maintenance_result: {
          session_id: "owner-session", outcome: "resumed", session_incarnation: "unconfirmed-inc",
        } } }));
        return;
      }
      const session = daemonSessions.find((entry) => entry.id === "owner-session")!;
      session.session_incarnation = resumeResponseMode === "wrong-id" ? "unconfirmed-inc"
        : resumeResponseMode === "empty-incarnation" ? "" : "owner-recovered-inc";
      if (failSnapshotAfterResume) failNextSessionList = true;
      res.end(JSON.stringify({ ok: true, data: { maintenance_result: {
        schema_version: "agent-session.session-maintenance.v1",
        session_id: resumeResponseMode === "wrong-id" ? "another-session" : "owner-session",
        operation: "resume",
        action: "retry_resume",
        outcome: "resumed",
        session_incarnation: maintenanceResponseMode === "legacy-null" ? null : session.session_incarnation,
        session_generation: maintenanceResponseMode === "legacy-null" ? null : 3,
        status: "running",
        cleanup_pending: false,
      } } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false }));
  });
  daemon.on("upgrade", (_req, socket) => {
    lastUpgradePath = _req.url ?? "";
    daemonUpgrades += 1;
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: testaccept=\r\n\r\n",
    );
  });
  const daemonAddress = await listenOnLoopback(daemon);
  const access = new AccessStore(statePath);
  access.claimSession({ principalId: "owner", machine: "hub", sessionId: "owner-session", incarnation: "owner-inc" });
  access.claimSession({ principalId: "viewer", machine: "hub", sessionId: "viewer-session", incarnation: "viewer-inc" });
  access.claimSession({ principalId: "owner", machine: "hub", sessionId: "reused-session", incarnation: "inc-old" });
  access.claimProvider("owner", "hub", "codex", "owner-provider");
  access.claimProvider("viewer", "hub", "claude", "viewer-provider");
  access.close();
  edge = createEdgeServer(makeEdgeConfig({
    openAccess: false,
    multiUser: true,
    accessDbPath: statePath,
    principals,
    machines: [
      { name: "hub", url: daemonAddress.base, token: "daemon-token" },
      { name: "host-a", url: "http://127.0.0.1:1", token: "daemon-token" },
      { name: "host-d", url: "http://127.0.0.1:2", token: "daemon-token" },
    ],
  }));
  const edgeAddress = await listenOnLoopback(edge);
  base = edgeAddress.base;
  edgePort = edgeAddress.port;
});

after(() => {
  closeServers(edge, daemon);
  rmSync(tempRoot, { recursive: true, force: true });
});

async function api(path: string, token: string): Promise<Response> {
  return await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

test("clipboard copy cannot forward a selection to a machine outside the principal scope", async () => {
  const before = daemonRequests;
  const response = await fetch(`${base}/api/clipboard/unwrap`, {
    method: "POST",
    headers: { authorization: "Bearer viewer-token", "content-type": "application/json" },
    body: JSON.stringify({ machine: "host-d", selection: "https://example.test/private" }),
  });
  assert.equal(response.status, 404);
  assert.equal(daemonRequests, before);
});

function rawUpgrade(path: string, extraHeaders: string): Promise<string> {
  return new Promise((resolve) => {
    let response = "";
    let done = false;
    const socket = net.connect(edgePort, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${edgePort}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
        extraHeaders +
        "\r\n",
      );
    });
    const finish = (fallback: string) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(response.includes("\r\n") ? (response.split("\r\n")[0] ?? fallback) : fallback);
    };
    socket.setTimeout(1_500);
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n")) finish("");
    });
    socket.on("timeout", () => finish("(no status)"));
    socket.on("close", () => finish("(closed)"));
    socket.on("error", () => finish("(error)"));
  });
}

test("machine and session lists are scoped without granting legacy managed workers", async () => {
  const ownerMachines = await (await api("/api/machines", "owner-token")).json() as any;
  const viewerMachines = await (await api("/api/machines", "viewer-token")).json() as any;
  assert.deepEqual(ownerMachines.data.machines.map((entry: any) => entry.name), ["hub", "host-d"]);
  assert.deepEqual(viewerMachines.data.machines.map((entry: any) => entry.name), ["hub", "host-a"]);

  const owner = await (await api("/api/sessions?machines=hub", "owner-token")).json() as any;
  const viewer = await (await api("/api/sessions?machines=hub", "viewer-token")).json() as any;
  assert.deepEqual(owner.data.sessions.map((entry: any) => entry.id), ["owner-session"]);
  assert.deepEqual(viewer.data.sessions.map((entry: any) => entry.id), ["viewer-session"]);
});

test("persisted grants for former managed workers retain ordinary visibility", async () => {
  const access = new AccessStore(statePath);
  access.claimSession({ principalId: "owner", machine: "hub", sessionId: "owner-worker", incarnation: "owner-worker-inc" });
  access.close();
  const result = await (await api("/api/sessions?machines=hub", "owner-token")).json() as any;
  assert.deepEqual(result.data.sessions.map((entry: any) => entry.id), ["owner-session", "owner-worker"]);
  assert.equal("orchestration" in result.data.sessions[1], false);
});

test("a restarted runtime is automatically restored only with its exact owned provider binding", async () => {
  daemonSessions.push(
    {
      id: "auto-recovered", agent: "codex", status: "running",
      session_incarnation: "auto-new",
      runtime_started_at: "2026-09-22T00:00:00Z",
      provider_resume: { provider: "codex", session_id: "auto-provider" },
    },
    {
      id: "different-provider", agent: "codex", status: "running",
      session_incarnation: "different-new",
      runtime_started_at: "2026-09-22T00:00:00Z",
      provider_resume: { provider: "codex", session_id: "other-owner-provider" },
    },
  );
  const access = new AccessStore(statePath);
  access.claimSession({
    principalId: "owner", machine: "hub", sessionId: "auto-recovered",
    incarnation: "auto-old", provider: "codex", providerSessionId: "auto-provider",
    runtimeStartedAt: "2026-09-21T00:00:00Z",
  });
  access.claimProvider("owner", "hub", "codex", "auto-provider");
  access.claimSession({
    principalId: "owner", machine: "hub", sessionId: "different-provider",
    incarnation: "different-old", provider: "codex", providerSessionId: "original-provider",
    runtimeStartedAt: "2026-09-21T00:00:00Z",
  });
  access.claimProvider("owner", "hub", "codex", "original-provider");
  access.claimProvider("owner", "hub", "codex", "other-owner-provider");
  access.close();
  try {
    const response = await api("/api/sessions?machines=hub", "owner-token");
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.data.sessions.some((entry: any) => entry.id === "auto-recovered"), true);
    assert.equal(body.data.sessions.some((entry: any) => entry.id === "different-provider"), false);
    const after = new AccessStore(statePath);
    assert.equal(after.ownsSession("owner", "hub", "auto-recovered", "auto-new"), true);
    assert.equal(after.ownsSession("owner", "hub", "different-provider", "different-old"), true);
    after.close();
    const recovered = daemonSessions.find((entry) => entry.id === "auto-recovered")!;
    recovered.session_incarnation = "auto-old";
    recovered.runtime_started_at = "2026-09-21T00:00:00Z";
    const delayed = await (await api("/api/sessions?machines=hub", "owner-token")).json() as any;
    assert.equal(delayed.data.sessions.some((entry: any) => entry.id === "auto-recovered"), false);
    const afterDelayed = new AccessStore(statePath);
    assert.equal(afterDelayed.ownsSession("owner", "hub", "auto-recovered", "auto-new"), true);
    afterDelayed.close();
    recovered.session_incarnation = "auto-new";
    recovered.runtime_started_at = "2026-09-22T00:00:00Z";
    assert.equal((await api("/api/sessions/hub/auto-recovered/glance", "owner-token")).status, 200);
    assert.equal((await api("/api/sessions/hub/auto-recovered/glance", "viewer-token")).status, 404);
  } finally {
    daemonSessions.splice(daemonSessions.findIndex((entry) => entry.id === "auto-recovered"), 1);
    daemonSessions.splice(daemonSessions.findIndex((entry) => entry.id === "different-provider"), 1);
  }
});

test("an existing exact grant learns its provider before a later runtime replacement", async () => {
  const session = {
    id: "legacy-bound-later", agent: "codex", status: "running",
    session_incarnation: "legacy-current",
    runtime_started_at: "2026-09-21T00:00:00Z",
    provider_resume: { provider: "codex", session_id: "legacy-provider" },
  };
  daemonSessions.push(session);
  const access = new AccessStore(statePath);
  access.claimSession({
    principalId: "owner", machine: "hub", sessionId: session.id,
    incarnation: session.session_incarnation,
  });
  access.claimProvider("owner", "hub", "codex", "legacy-provider");
  access.close();
  try {
    const first = await (await api("/api/sessions?machines=hub", "owner-token")).json() as any;
    assert.equal(first.data.sessions.some((entry: any) => entry.id === session.id), true);
    session.session_incarnation = "legacy-next";
    session.runtime_started_at = "2026-09-22T00:00:00Z";
    const second = await (await api("/api/sessions?machines=hub", "owner-token")).json() as any;
    assert.equal(second.data.sessions.some((entry: any) => entry.id === session.id), true);
    const after = new AccessStore(statePath);
    assert.equal(after.ownsSession("owner", "hub", session.id, "legacy-next"), true);
    after.close();
  } finally {
    daemonSessions.splice(daemonSessions.indexOf(session), 1);
  }
});

test("resuming an owned session keeps its new incarnation visible and reachable", async () => {
  try {
    const resumed = await fetch(`${base}/api/sessions/hub/owner-session/resume`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token" },
    });
    assert.equal(resumed.status, 200);
    const resumedBody = await resumed.json() as any;
    assert.equal(resumedBody.data.session.id, "owner-session");
    assert.equal(resumedBody.data.session.session_incarnation, "owner-recovered-inc");
    assert.equal(JSON.stringify(resumedBody).includes("private-test-sentinel"), false);
    assert.equal(JSON.stringify(resumedBody).includes("/private/launcher"), false);
    const owner = await (await api("/api/sessions?machines=hub", "owner-token")).json() as any;
    assert.equal(owner.data.sessions.some((entry: any) => entry.id === "owner-session"), true);
    assert.equal((await api("/api/sessions/hub/owner-session/glance", "owner-token")).status, 200);
    assert.equal((await api("/api/sessions/hub/owner-session/glance", "viewer-token")).status, 404);

    const recovered = await fetch(`${base}/api/sessions/hub/owner-session/maintenance/actions`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({
        operation: "resume",
        action: "retry_resume",
        expected_session_incarnation: "owner-recovered-inc",
        expected_session_generation: 2,
        expected_preview_digest: `sha256:${"a".repeat(64)}`,
      }),
    });
    assert.equal(recovered.status, 200);
    const after = await (await api("/api/sessions?machines=hub", "owner-token")).json() as any;
    assert.equal(after.data.sessions.some((entry: any) => entry.id === "owner-session"), true);
    assert.equal((await api("/api/sessions/hub/owner-session/glance", "owner-token")).status, 200);
  } finally {
    const session = daemonSessions.find((entry) => entry.id === "owner-session")!;
    session.session_incarnation = "owner-inc";
    const access = new AccessStore(statePath);
    assert.equal(access.advanceSessionIncarnation(
      "owner", "hub", "owner-session", "owner-recovered-inc", "owner-inc",
    ), true);
    access.close();
  }
});

test("legacy runtime without a successor fence is rejected before resume", async () => {
  maintenanceResponseMode = "legacy-null";
  try {
    const beforeActions = resumeActionRequests;
    const resumed = await fetch(`${base}/api/sessions/hub/owner-session/resume`, {
      method: "POST", headers: { authorization: "Bearer owner-token" },
    });
    assert.equal(resumed.status, 409);
    assert.equal(resumeActionRequests, beforeActions);

    const recovered = await fetch(`${base}/api/sessions/hub/owner-session/maintenance/actions`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({
        operation: "resume", action: "retry_resume",
        expected_session_incarnation: "owner-inc",
        expected_session_generation: null,
        expected_preview_digest: `sha256:${"a".repeat(64)}`,
      }),
    });
    assert.equal(recovered.status, 409);
    assert.equal(resumeActionRequests, beforeActions);
  } finally {
    maintenanceResponseMode = "valid";
  }
});

test("a failed post-resume snapshot leaves a confirmed ownership update intact", async () => {
  failSnapshotAfterResume = true;
  try {
    const resumed = await fetch(`${base}/api/sessions/hub/owner-session/resume`, {
      method: "POST", headers: { authorization: "Bearer owner-token" },
    });
    assert.equal(resumed.status, 502);
    const access = new AccessStore(statePath);
    assert.equal(access.ownsSession("owner", "hub", "owner-session", "owner-recovered-inc"), true);
    access.close();
    assert.equal((await api("/api/sessions/hub/owner-session/glance", "owner-token")).status, 200);
  } finally {
    failSnapshotAfterResume = false;
    failNextSessionList = false;
    daemonSessions.find((entry) => entry.id === "owner-session")!.session_incarnation = "owner-inc";
    const access = new AccessStore(statePath);
    assert.equal(access.advanceSessionIncarnation(
      "owner", "hub", "owner-session", "owner-recovered-inc", "owner-inc",
    ), true);
    access.close();
  }
});

test("unconfirmed resume responses leave the exact ownership grant unchanged", async () => {
  try {
    for (const mode of ["wrong-id", "empty-incarnation", "failed"] as const) {
      resumeResponseMode = mode;
      const response = await fetch(`${base}/api/sessions/hub/owner-session/resume`, {
        method: "POST",
        headers: { authorization: "Bearer owner-token" },
      });
      assert.equal(response.status, mode === "failed" ? 409 : 502);
      const access = new AccessStore(statePath);
      assert.equal(access.ownsSession("owner", "hub", "owner-session", "owner-inc"), true);
      assert.equal(access.ownsSession("owner", "hub", "owner-session", "unconfirmed-inc"), false);
      access.close();
      daemonSessions.find((entry) => entry.id === "owner-session")!.session_incarnation = "owner-inc";
    }
    resumeResponseMode = "valid";
    maintenanceResponseMode = "malformed";
    const response = await fetch(`${base}/api/sessions/hub/owner-session/maintenance/actions`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({
        operation: "resume",
        action: "retry_resume",
        expected_session_incarnation: "owner-inc",
        expected_session_generation: 1,
        expected_preview_digest: `sha256:${"a".repeat(64)}`,
      }),
    });
    assert.equal(response.status, 502);
    const access = new AccessStore(statePath);
    assert.equal(access.ownsSession("owner", "hub", "owner-session", "owner-inc"), true);
    assert.equal(access.ownsSession("owner", "hub", "owner-session", "unconfirmed-inc"), false);
    access.close();
  } finally {
    resumeResponseMode = "valid";
    maintenanceResponseMode = "valid";
    daemonSessions.find((entry) => entry.id === "owner-session")!.session_incarnation = "owner-inc";
  }
});

test("resume refuses a session replaced after authorization", async () => {
  try {
    previewIncarnationOverride = "replacement-inc";
    const beforeActions = resumeActionRequests;
    const response = await fetch(`${base}/api/sessions/hub/owner-session/resume`, {
      method: "POST", headers: { authorization: "Bearer owner-token" },
    });
    assert.equal(response.status, 409);
    assert.equal(resumeActionRequests, beforeActions);
    const access = new AccessStore(statePath);
    assert.equal(access.ownsSession("owner", "hub", "owner-session", "owner-inc"), true);
    access.close();
  } finally {
    previewIncarnationOverride = null;
  }
});

test("manual resume maintenance requires the owned incarnation", async () => {
  const beforeActions = resumeActionRequests;
  const response = await fetch(`${base}/api/sessions/hub/owner-session/maintenance/actions`, {
    method: "POST",
    headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
    body: JSON.stringify({
      operation: "resume", action: "retry_resume",
      expected_session_incarnation: "replacement-inc",
      expected_session_generation: 1,
      expected_preview_digest: `sha256:${"a".repeat(64)}`,
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(resumeActionRequests, beforeActions);
});

test("bearer and browser-cookie authentication resolve the stable principal", async () => {
  const bearer = await (await api("/api/auth/status", "owner-token")).json() as any;
  assert.deepEqual(bearer.principal, {
    id: "owner",
    permissions: ["debug", "usage", "codex_reset"],
  });

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "viewer-token" }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const status = await fetch(`${base}/api/auth/status`, { headers: { cookie } });
  const body = await status.json() as any;
  assert.deepEqual(body.principal, {
    id: "viewer", permissions: [], defaultVisibleMachines: ["host-a"], defaultCreateMachine: "host-a",
  });

  const rejected = await fetch(`${base}/api/auth/status`, {
    headers: { cookie, authorization: "Bearer invalid-explicit-token" },
  });
  assert.equal(rejected.status, 200);
  assert.deepEqual(await rejected.json(), {
    ok: true,
    authenticated: false,
    openAccess: false,
    principal: null,
  });
});

test("cross-owner direct reads are denied before an upstream request", async () => {
  const before = daemonRequests;
  const denied = await api("/api/sessions/hub/owner-session/glance", "viewer-token");
  assert.equal(denied.status, 404);
  assert.equal(daemonRequests, before);
  const allowed = await api("/api/sessions/hub/owner-session/glance", "owner-token");
  assert.equal(allowed.status, 200);

  const beforeTicket = daemonRequests;
  const deniedTicket = await fetch(`${base}/api/sessions/hub/owner-session/attach-ticket`, {
    method: "POST",
    headers: { authorization: "Bearer viewer-token" },
  });
  assert.equal(deniedTicket.status, 404);
  assert.equal(daemonRequests, beforeTicket);
});

test("a reused session id is denied across direct HTTP and WebSocket attach paths", async () => {
  assert.equal((await api("/api/sessions/hub/reused-session/glance", "owner-token")).status, 404);
  const ticket = await fetch(`${base}/api/sessions/hub/reused-session/attach-ticket`, {
    method: "POST",
    headers: { authorization: "Bearer owner-token" },
  });
  assert.equal(ticket.status, 404);

  const beforeUpgrades = daemonUpgrades;
  const line = await rawUpgrade(
    "/api/sessions/hub/reused-session/attach",
    "Origin: http://tauri.localhost\r\nSec-WebSocket-Protocol: ac-token.owner-token\r\n",
  );
  assert.match(line, /404/);
  assert.equal(daemonUpgrades, beforeUpgrades);
});

test("an explicit WebSocket token overrides an ambient cookie and attach tickets bind the incarnation", async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "owner-token" }),
  });
  const ownerCookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const beforeMixed = daemonUpgrades;
  const mixed = await rawUpgrade(
    "/api/sessions/hub/owner-session/attach",
    `Origin: http://tauri.localhost\r\nCookie: ${ownerCookie}\r\nSec-WebSocket-Protocol: ac-token.viewer-token\r\n`,
  );
  assert.match(mixed, /404/);
  assert.equal(daemonUpgrades, beforeMixed);

  const issued = await fetch(`${base}/api/sessions/hub/owner-session/attach-ticket`, {
    method: "POST",
    headers: { authorization: "Bearer owner-token" },
  });
  assert.equal(issued.status, 200);
  const ticket = ((await issued.json()) as any).data.ticket as string;

  const access = new AccessStore(statePath);
  access.claimSession({
    principalId: "owner",
    machine: "hub",
    sessionId: "owner-session",
    incarnation: "owner-replacement-inc",
  });
  access.close();
  const session = daemonSessions.find((entry) => entry.id === "owner-session");
  assert.ok(session);
  session.session_incarnation = "owner-replacement-inc";
  try {
    const beforeTicket = daemonUpgrades;
    const replaced = await rawUpgrade(
      `/api/sessions/hub/owner-session/attach?ticket=${encodeURIComponent(ticket)}`,
      "Origin: http://tauri.localhost\r\n",
    );
    assert.match(replaced, /404/);
    assert.equal(daemonUpgrades, beforeTicket);
  } finally {
    session.session_incarnation = "owner-inc";
    const restore = new AccessStore(statePath);
    restore.claimSession({
      principalId: "owner",
      machine: "hub",
      sessionId: "owner-session",
      incarnation: "owner-inc",
    });
    restore.close();
  }

  const beforeValid = daemonUpgrades;
  const valid = await rawUpgrade(
    "/api/sessions/hub/owner-session/attach",
    "Origin: http://tauri.localhost\r\nSec-WebSocket-Protocol: ac-token.owner-token\r\n",
  );
  assert.match(valid, /101/);
  assert.equal(daemonUpgrades, beforeValid + 1);
});

test("global routes require explicit principal permissions", async () => {
  const cases = [
    { method: "GET", path: "/api/debug/events" },
    { method: "GET", path: "/api/usage" },
    {
      method: "POST",
      path: "/api/codex/rate-limit-reset",
      body: { account: "sym", idempotency_key: "00000000-0000-4000-8000-000000000001" },
    },
    {
      method: "POST",
      path: "/api/claude/limit-reset",
      body: { account: "work", program: "juniper_tide", idempotency_key: "00000000-0000-4000-8000-000000000002" },
    },
  ] as const;
  for (const entry of cases) {
    const request = (token: string) => fetch(`${base}${entry.path}`, {
      method: entry.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(entry.body ? { "content-type": "application/json" } : {}),
      },
      ...(entry.body ? { body: JSON.stringify(entry.body) } : {}),
    });
    assert.equal((await request("viewer-token")).status, 403, entry.path);
    assert.notEqual((await request("owner-token")).status, 403, entry.path);
  }
});

test("history and activity streams expose only owned identities", async () => {
  const ownerHistory = await (await api("/api/history/sessions?machine=hub", "owner-token")).json() as any;
  const viewerHistory = await (await api("/api/history/sessions?machine=hub", "viewer-token")).json() as any;
  assert.deepEqual(ownerHistory.data.sessions.map((entry: any) => entry.id), ["owner-history"]);
  assert.deepEqual(viewerHistory.data.sessions.map((entry: any) => entry.id), ["viewer-history"]);

  const readActivity = async (token: string) => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/activity/events?machines=hub`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new ActivitySseDecoder();
    let event: any;
    while (!event) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      event = decoder.push(new TextDecoder().decode(chunk.value, { stream: true }))[0];
    }
    controller.abort();
    await reader.cancel().catch(() => {});
    return event;
  };

  const viewerActivity = await readActivity("viewer-token");
  assert.deepEqual(viewerActivity.sessions.map((entry: any) => entry.id), ["viewer-session"]);

  // Owner owns the stale database row for reused-session at inc-old, while the
  // current daemon and this SSE snapshot use the replacement ID at inc-new.
  // The exact snapshot join must omit it rather than authorizing by ID alone.
  const ownerActivity = await readActivity("owner-token");
  assert.deepEqual(ownerActivity.sessions.map((entry: any) => entry.id), ["owner-session", "owner-worker"]);
});

test("session creation assigns an edge id and binds only the creator", async () => {
  const createdResponse = await fetch(`${base}/api/sessions/hub`, {
    method: "POST",
    headers: {
      authorization: "Bearer viewer-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ agent: "codex" }),
  });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json() as any;
  const id = created.data.session.id as string;
  assert.match(id, /^[0-9a-f-]{36}$/);

  const viewer = await (await api("/api/sessions?machines=hub", "viewer-token")).json() as any;
  const owner = await (await api("/api/sessions?machines=hub", "owner-token")).json() as any;
  assert.equal(viewer.data.sessions.some((entry: any) => entry.id === id), true);
  assert.equal(owner.data.sessions.some((entry: any) => entry.id === id), false);
});

test("manual provider resume cannot cross principal ownership", async () => {
  const before = daemonRequests;
  const response = await fetch(`${base}/api/sessions/hub`, {
    method: "POST",
    headers: {
      authorization: "Bearer viewer-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ agent: "codex", provider_resume_id: "owner-provider" }),
  });
  assert.equal(response.status, 404);
  assert.equal(daemonRequests, before);
});

test("a principal without import permission can resume its owned Claude thread", async () => {
  const response = await fetch(`${base}/api/sessions/hub`, {
    method: "POST",
    headers: { authorization: "Bearer viewer-token", "content-type": "application/json" },
    body: JSON.stringify({ agent: "claude", provider_resume_id: "viewer-provider" }),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as any;
  assert.deepEqual(result.data.session.provider_resume, { provider: "claude", session_id: "viewer-provider" });
  const store = new AccessStore(statePath);
  assert.equal(store.ownsSession("viewer", "hub", result.data.session.id, result.data.session.session_incarnation), true);
  store.close();
});

test("only an import operator can first bind external Codex and Claude threads", async () => {
  for (const agent of ["codex", "claude"]) {
    const providerId = `external-${agent}-shell-thread`;
    const before = daemonRequests;
    const unprivileged = await fetch(`${base}/api/sessions/hub`, {
      method: "POST",
      headers: { authorization: "Bearer viewer-token", "content-type": "application/json" },
      body: JSON.stringify({ agent, provider_resume_id: providerId }),
    });
    assert.equal(unprivileged.status, 404);
    assert.equal(daemonRequests, before);
    const response = await fetch(`${base}/api/sessions/hub`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
      body: JSON.stringify({ agent, provider_resume_id: providerId }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.deepEqual(result.data.session.provider_resume, { provider: agent, session_id: providerId });
    const store = new AccessStore(statePath);
    assert.equal(store.ownsProvider("owner", "hub", agent, providerId), true);
    store.close();
    const after = daemonRequests;
    const denied = await fetch(`${base}/api/sessions/hub`, {
      method: "POST",
      headers: { authorization: "Bearer viewer-token", "content-type": "application/json" },
      body: JSON.stringify({ agent, provider_resume_id: providerId }),
    });
    assert.equal(denied.status, 404);
    assert.equal(daemonRequests, after);
  }
});


test("external resume accepts the legacy resume ID alias", async () => {
  const response = await fetch(base + "/api/sessions/hub", {
    method: "POST", headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
    body: JSON.stringify({ agent: "codex", resume_id: "external-alias-thread" }),
  });
  assert.equal(response.status, 200);
  const store = new AccessStore(statePath);
  assert.equal(store.ownsProvider("owner", "hub", "codex", "external-alias-thread"), true);
  store.close();
});

test("failed and unconfirmed external resumes never receive an ownership grant", async () => {
  try {
    for (const mode of ["failed", "wrong-thread"] as const) {
      providerCreateMode = mode;
      const id = "external-" + mode;
      const response = await fetch(base + "/api/sessions/hub", {
        method: "POST", headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", provider_resume_id: id }),
      });
      assert.equal(response.status, mode === "failed" ? 404 : 502);
      const store = new AccessStore(statePath);
      assert.equal(store.hasProviderOwner("hub", "codex", id), false);
      store.close();
    }
  } finally { providerCreateMode = "valid"; }
});

test("a failed external resume that kept its session is claimed only for the requested thread", async () => {
  try {
    errorAfterCreate = true;
    for (const mode of ["valid", "wrong-thread"] as const) {
      providerCreateMode = mode;
      const id = "kept-" + mode;
      const response = await fetch(base + "/api/sessions/hub", {
        method: "POST", headers: { authorization: "Bearer owner-token", "content-type": "application/json" },
        body: JSON.stringify({ agent: "codex", provider_resume_id: id }),
      });
      const body = await response.json() as { error?: { code?: string } };
      const store = new AccessStore(statePath);
      if (mode === "valid") {
        assert.equal(response.status, 502);
        assert.equal(body.error?.code, "create-outcome-unknown");
        assert.equal(store.ownsProvider("owner", "hub", "codex", id), true);
      } else {
        assert.equal(response.status, 500);
        assert.notEqual(body.error?.code, "create-outcome-unknown");
        assert.equal(store.hasProviderOwner("hub", "codex", id), false);
        assert.equal(store.hasProviderOwner("hub", "codex", "other-thread"), false);
      }
      store.close();
    }
  } finally { providerCreateMode = "valid"; errorAfterCreate = false; }
});

test("concurrent eligible first resumes assign the external thread to only one principal", async () => {
  const before = daemonRequests;
  const candidates = ["owner", "second-operator"];
  const responses = await Promise.all(candidates.map(principal => fetch(base + "/api/sessions/hub", {
    method: "POST", headers: { authorization: "Bearer " + principal + "-token", "content-type": "application/json" },
    body: JSON.stringify({ agent: "codex", provider_resume_id: "external-concurrent-thread" }),
  })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 404]);
  assert.equal(daemonRequests - before, 1);
  const store = new AccessStore(statePath);
  for (const [index, principal] of candidates.entries()) {
    assert.equal(store.ownsProvider(principal, "hub", "codex", "external-concurrent-thread"),
      responses[index].status === 200);
  }
  store.close();
});


test("root without terminal permission cannot read, create, delete or ticket emergency shells", async () => {
  const before = daemonRequests;
  for (const machine of ["hub", "host-a"]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await fetch(`${base}/api/shells/${machine}`, {
        method,
        headers: { authorization: "Bearer root-token", "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(method === "POST" ? {} : { incarnation: "shell-inc" }) }),
      });
      assert.equal(response.status, 403, `${method} shell on ${machine}`);
    }
    const response = await fetch(`${base}/api/shells/${machine}/shell-inc/attach-ticket`, {
      method: "POST", headers: { authorization: "Bearer root-token" }, body: "{}",
    });
    assert.equal(response.status, 403, `shell ticket on ${machine}`);
  }
  assert.equal(daemonRequests, before, "forbidden shell requests never reach a daemon");
});

test("root without terminal permission cannot attach an emergency shell with bearer or native token", async () => {
  const before = daemonUpgrades;
  for (const machine of ["hub", "host-a"]) {
    for (const headers of ["Authorization: Bearer root-token\r\n", "Origin: http://tauri.localhost\r\nSec-WebSocket-Protocol: ac-token.root-token\r\n"]) {
      assert.match(await rawUpgrade(`/api/shells/${machine}/shell-inc/attach`, headers), /403 Forbidden/);
    }
  }
  assert.equal(daemonUpgrades, before);
});

test("root without terminal permission cannot attach another owner's session", async () => {
  const before = daemonUpgrades;
  for (const headers of ["Authorization: Bearer root-token\r\n", "Origin: http://tauri.localhost\r\nSec-WebSocket-Protocol: ac-token.root-token\r\n"]) {
    assert.match(await rawUpgrade("/api/sessions/hub/viewer-session/attach", headers), /403 Forbidden/);
  }
  assert.equal(daemonUpgrades, before);
  const response = await fetch(`${base}/api/sessions/hub/viewer-session/attach-ticket`, {
    method: "POST", headers: { authorization: "Bearer root-token" },
  });
  assert.equal(response.status, 403);
});

test("emergency Shell cannot operate a machine outside the principal scope", async () => {
  const before = daemonRequests;
  const denied = await api("/api/shells/host-a", "owner-token");
  assert.equal(denied.status, 404);
  assert.equal(daemonRequests, before);
});

test("root emergency shell requires an explicit terminal permission for lifecycle and one-time attach", async () => {
  rootPermissions.push("terminal");
  try {
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await fetch(`${base}/api/shells/hub`, {
        method, headers: { authorization: "Bearer root-token", "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(method === "POST" ? {} : { incarnation: "shell-inc" }) }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).data.shell.owner, "root");
    }
    const issue = async () => {
      const response = await fetch(`${base}/api/shells/hub/shell-inc/attach-ticket`, {
        method: "POST", headers: { authorization: "Bearer root-token" }, body: "{}",
      });
      assert.equal(response.status, 200);
      return (await response.json() as any).data.ticket;
    };
    const ticket = await issue();
    assert.match(await rawUpgrade(`/api/shells/hub/shell-inc/attach?ticket=${ticket}`,
      "Origin: http://tauri.localhost\r\n"), /101/);
    assert.equal(lastUpgradePath, "/shells/root/attach?incarnation=shell-inc");
    assert.match(await rawUpgrade(`/api/shells/hub/shell-inc/attach?ticket=${ticket}`,
      "Origin: http://tauri.localhost\r\n"), /403/);
    // A ticket cannot carry terminal authority after its principal loses it.
    const before = daemonUpgrades;
    const revoked = await issue();
    rootPermissions.length = 0;
    assert.match(await rawUpgrade(`/api/shells/hub/shell-inc/attach?ticket=${revoked}`,
      "Origin: http://tauri.localhost\r\n"), /403/);
    assert.equal(daemonUpgrades, before);
  } finally { rootPermissions.length = 0; }
});

test("emergency Shell reads forward only the authenticated principal", async () => {
  const response = await api("/api/shells/hub?owner=viewer", "owner-token");
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.data.shell.owner, "owner");
});


test("Shell lifecycle rejects owner selection and scopes writes and native tickets", async () => {
  const write = (path: string, body: unknown, method = "POST", token = "owner-token") => fetch(base + path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const before = daemonRequests;
  assert.equal((await write("/api/shells/host-a", {})).status, 404);
  assert.equal((await write("/api/shells/hub", { owner: "viewer" })).status, 422);
  assert.equal((await write("/api/shells/hub", {}, "DELETE")).status, 422);
  assert.equal(daemonRequests, before);
  assert.equal((await write("/api/shells/hub", {})).status, 200);
  assert.equal(lastShellOwner, "owner");
  assert.equal((await write("/api/shells/hub", { incarnation: "shell-inc" }, "DELETE", "viewer-token")).status, 200);
  assert.equal(lastShellOwner, "viewer");
  assert.equal((await write("/api/shells/hub/stale/attach-ticket", {})).status, 409);
  const ticketBody = await (await write("/api/shells/hub/shell-inc/attach-ticket", {})).json() as any;
  let ticket = ticketBody.data.ticket;
  assert.match(await rawUpgrade(`/api/shells/host-a/shell-inc/attach?ticket=${ticket}`, "Origin: https://foreign.test\r\n"), /403/);
  ticket = (await (await write("/api/shells/hub/shell-inc/attach-ticket", {})).json() as any).data.ticket;
  assert.match(await rawUpgrade(`/api/shells/hub/other/attach?ticket=${ticket}`, "Origin: https://foreign.test\r\n"), /403/);
  ticket = (await (await write("/api/shells/hub/shell-inc/attach-ticket", {})).json() as any).data.ticket;
  assert.match(await rawUpgrade(`/api/shells/hub/shell-inc/attach?ticket=${ticket}`, "Origin: http://tauri.localhost\r\n"), /101/);
  assert.equal(lastUpgradePath, "/shells/owner/attach?incarnation=shell-inc");
  assert.match(await rawUpgrade(`/api/shells/hub/shell-inc/attach?ticket=${ticket}`, "Origin: http://tauri.localhost\r\n"), /403/);
});

test("Shell cookie writes and attach preserve the same-origin gate", async () => {
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type":"application/json" }, body: JSON.stringify({ token:"owner-token" }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const before = daemonRequests;
  for (const method of ["POST", "DELETE"]) {
    const result = await fetch(base + "/api/shells/hub", { method, headers: { cookie, origin:"https://foreign.test", "content-type":"application/json" }, body: JSON.stringify(method === "POST" ? {} : { incarnation:"shell-inc" }) });
    assert.equal(result.status, 403);
  }
  assert.equal(daemonRequests, before);
  assert.match(await rawUpgrade("/api/shells/hub/shell-inc/attach", `Cookie: ${cookie}\r\nOrigin: https://foreign.test\r\n`), /403/);
});


test("root with terminal permission binds attach tickets to the live foreign incarnation", async () => {
  rootPermissions.push("terminal");
  try {
    const issue = async () => {
      const response = await fetch(`${base}/api/sessions/hub/viewer-session/attach-ticket`, {
        method: "POST", headers: { authorization: "Bearer root-token" },
      });
      assert.equal(response.status, 200);
      return (await response.json() as any).data.ticket;
    };
    const beforeTicket = daemonRequests;
    const ticket = await issue();
    assert.equal(daemonRequests - beforeTicket, 1, "one authoritative snapshot issues a root ticket");
    const beforeAttach = daemonRequests;
    assert.match(await rawUpgrade(`/api/sessions/hub/viewer-session/attach?ticket=${ticket}`,
      "Origin: http://tauri.localhost\r\n"), /101/);
    assert.match(await rawUpgrade(`/api/sessions/hub/viewer-session/attach?ticket=${ticket}`,
      "Origin: http://tauri.localhost\r\n"), /403/);
    assert.equal(daemonRequests - beforeAttach, 1, "one fresh snapshot validates a root upgrade");
    const stale = await issue();
    const session = daemonSessions.find(entry => entry.id === "viewer-session")!;
    session.session_incarnation = "replacement-inc";
    try {
      const before = daemonUpgrades;
      assert.match(await rawUpgrade(`/api/sessions/hub/viewer-session/attach?ticket=${stale}`,
        "Origin: http://tauri.localhost\r\n"), /404/);
      assert.equal(daemonUpgrades, before);
      assert.match(await rawUpgrade("/api/sessions/hub/viewer-session/attach",
        "Authorization: Bearer root-token\r\n"), /101/);
    } finally { session.session_incarnation = "viewer-inc"; }
    const revoked = await issue();
    rootPermissions.length = 0;
    const beforeRevoked = daemonRequests;
    const upgradesBeforeRevoked = daemonUpgrades;
    assert.match(await rawUpgrade(`/api/sessions/hub/viewer-session/attach?ticket=${revoked}`,
      "Origin: http://tauri.localhost\r\n"), /403/);
    assert.equal(daemonRequests, beforeRevoked, "permission is checked before even reading a daemon snapshot");
    assert.equal(daemonUpgrades, upgradesBeforeRevoked);
  } finally { rootPermissions.length = 0; }
});

test("root recovery retains the original owner instead of claiming its session", async () => {
  const session = daemonSessions.find(entry => entry.id === "owner-session")!;
  const prior = session.session_incarnation;
  const access = new AccessStore(statePath);
  const before = access.sessionGrant("hub", "owner-session")!;
  access.close();
  try {
    const response = await fetch(`${base}/api/sessions/hub/owner-session/resume`, {
      method: "POST", headers: { authorization: "Bearer root-token" },
    });
    assert.equal(response.status, 200);
    const after = new AccessStore(statePath);
    try {
      const grant = after.sessionGrant("hub", "owner-session")!;
      assert.equal(grant.principalId, "owner");
      assert.equal(grant.incarnation, session.session_incarnation);
    } finally { after.close(); }
    assert.equal((await api("/api/sessions/hub/owner-session/glance", "owner-token")).status, 200);
    assert.equal((await api("/api/sessions/hub/owner-session/glance", "viewer-token")).status, 404);
  } finally {
    session.session_incarnation = prior;
    const restore = new AccessStore(statePath);
    restore.advanceSessionIncarnation(before.principalId, "hub", "owner-session", "owner-recovered-inc", before.incarnation);
    restore.close();
  }
});


test("root recovery leaves a reused runtime's stale owner grant untouched", async () => {
  const session = daemonSessions.find(entry => entry.id === "owner-session")!;
  const prior = session.session_incarnation;
  const access = new AccessStore(statePath);
  const before = access.sessionGrant("hub", "owner-session")!;
  access.advanceSessionIncarnation(before.principalId, "hub", "owner-session", before.incarnation, "stale-inc");
  access.close();
  try {
    const response = await fetch(`${base}/api/sessions/hub/owner-session/resume`, {
      method: "POST", headers: { authorization: "Bearer root-token" },
    });
    assert.equal(response.status, 200);
    const after = new AccessStore(statePath);
    try {
      assert.equal(after.sessionGrant("hub", "owner-session")?.incarnation, "stale-inc");
      assert.equal(after.ownsSession(before.principalId, "hub", "owner-session", String(session.session_incarnation)), false);
    } finally { after.close(); }
  } finally {
    session.session_incarnation = prior;
    const restore = new AccessStore(statePath);
    const grant = restore.sessionGrant("hub", "owner-session")!;
    restore.advanceSessionIncarnation(before.principalId, "hub", "owner-session", grant.incarnation, before.incarnation);
    restore.close();
  }
});


test("history image reads require the caller's history ownership before contacting a daemon", async () => {
  await api("/api/history/sessions?machine=hub", "owner-token");
  const image = `${"a".repeat(16)}.0.0.${"b".repeat(32)}`;
  const before = daemonRequests;
  assert.equal((await api(`/api/history/sessions/hub/viewer-history/images/${image}`, "owner-token")).status,404);
  assert.equal(daemonRequests,before,"cross-owner image reads never reach upstream");
  assert.equal((await api(`/api/history/sessions/hub/owner-history/images/${image}`, "owner-token")).status,422);
  assert.equal(daemonRequests,before + 1,"owned history uses the history gate rather than live-session admission");
  assert.equal((await api(`/api/history/sessions/hub/viewer-history/images/${image}`, "root-token")).status,422,
    "root can read history images through the same history read policy");
});
