import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer, type EdgeServerOptions } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

// A daemon that lists its sessions and creates new ones, recording each create
// body it receives.
function daemon(operatorToken: string, sessions: Array<Record<string, unknown>>) {
  const creates: Array<Record<string, unknown>> = [];
  // `createFailure` makes a create keep its session but answer with an error
  // (`status`) or drop the connection (`"drop"`), as a create that outlives a
  // serve-side or edge-side budget does. `createNothing` fails without creating.
  const state: {
    echoLineage?: boolean;
    failList: boolean;
    listDelayMs?: number;
    stallList?: boolean;
    createFailure?: { status: number; code: string } | "drop" | "drop-then-appear";
    createNothing?: { status: number; code: string };
  } = { failList: false };
  const history: Array<Record<string, unknown>> = [];
  let listCalls = 0;
  let pendingSession: Record<string, unknown> | undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    assert.equal(req.headers.authorization, `Bearer ${operatorToken}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/sessions" && state.failList) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: { code: "internal", message: "unavailable" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/sessions") {
      if (state.stallList) return;
      if (state.listDelayMs) await new Promise(resolve => setTimeout(resolve, state.listDelayMs));
      listCalls += 1;
      if (pendingSession && listCalls >= 2) {
        sessions.push(pendingSession);
        pendingSession = undefined;
      }
      res.end(JSON.stringify({ ok: true, data: { sessions } }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/history/sessions")) {
      res.end(JSON.stringify({ ok: true, data: { sessions: history, truncated: false } }));
      return;
    }
    if (req.method === "POST" && req.url === "/sessions") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      creates.push(body);
      if (state.createNothing) {
        res.writeHead(state.createNothing.status);
        res.end(JSON.stringify({ ok: false, error: { code: state.createNothing.code, message: "failed" } }));
        return;
      }
      // A lineage-aware daemon (agent-session 1.31.9+) records and echoes
      // the lineage, work, and role it was given.
      const session = {
        id: body.id, agent: body.agent, cwd: body.cwd, title: body.title ?? null,
        status: "running", session_incarnation: `inc-${String(body.id)}`,
        ...(state.echoLineage && body.lineage ? {
          lineage: { ...(body.lineage as object), root: (body.lineage as any).root ?? { machine: "summit", session_id: body.id, session_created_at: "2026-10-02T11:00:00Z" } },
        } : {}),
        ...(state.echoLineage && body.work ? { work: body.work } : {}),
        ...(state.echoLineage && body.role ? { role: body.role } : {}),
        ...(Object.hasOwn(body, "workspace") ? { workspace: body.workspace } : {}),
        ...(body.origin ? { origin: body.origin } : {}),
      };
      if (state.createFailure === "drop-then-appear") {
        // The session shows up only on a later list, as one serve is still starting.
        listCalls = 0;
        pendingSession = session;
        req.socket.destroy();
        return;
      }
      sessions.push(session);
      if (state.createFailure === "drop") {
        req.socket.destroy();
        return;
      }
      if (state.createFailure) {
        res.writeHead(state.createFailure.status);
        res.end(JSON.stringify({ ok: false, error: { code: state.createFailure.code, message: "unknown" } }));
        return;
      }
      res.writeHead(201);
      res.end(JSON.stringify({ ok: true, data: { session } }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: { code: "not-found", message: "not found" } }));
  });
  return { server, creates, sessions, state, history, listCalls: () => listCalls };
}

async function fixture(options: EdgeServerOptions = {}) {
  const ownerToken = "browser-tess";
  const otherMachine = "cedar";
  const dir = mkdtempSync(join(tmpdir(), "owned-create-test-"));
  const db = join(dir, "access.sqlite");
  const source = daemon("source-operator", [
    { id: "dispatcher", agent: "claude", status: "running", session_incarnation: "disp-inc", repo_name: "legacy-root" },
    { id: "unowned", agent: "claude", status: "running", session_incarnation: "unowned-inc" },
  ]);
  const other = daemon("cedar-operator", []);
  const viewerOnly = daemon("maple-operator", []);
  const sourceAddr = await listenOnLoopback(source.server);
  const otherAddr = await listenOnLoopback(other.server);
  const viewerAddr = await listenOnLoopback(viewerOnly.server);
  const access = new AccessStore(db);
  access.claimSession({ principalId: "tess", machine: "summit", sessionId: "dispatcher", incarnation: "disp-inc" });
  access.close();
  const edge = createEdgeServer(makeEdgeConfig({
    openAccess: false, multiUser: true, accessDbPath: db,
    principals: [
      { id: "tess", token: ownerToken, machines: ["summit", otherMachine], permissions: [] },
      { id: "dana", token: "browser-dana", machines: ["summit", "maple"], permissions: [] },
    ],
    machines: [
      { name: "summit", url: sourceAddr.base, token: "source-operator" },
      { name: otherMachine, url: otherAddr.base, token: "cedar-operator" },
      { name: "maple", url: viewerAddr.base, token: "maple-operator" },
    ],
    coordinationRelays: [{ machine: "summit", token: "source-relay", ingress_token: "source-ingress" }],
  }), { ...options, extensions: [{ id: "legacy-fixture", legacyCoordinatorRepositories: ["legacy-root"] }, ...(options.extensions ?? [])] });
  const { base } = await listenOnLoopback(edge);
  return {
    base, source, other, viewerOnly, db, ownerToken, otherMachine,
    cleanup: async () => {
      await Promise.all([edge, source.server, other.server, viewerOnly.server].map((server) => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const caller = { source_session_id: "dispatcher", source_incarnation: "disp-inc" };

async function create(base: string, body: unknown, token = "source-relay") {
  const response = await fetch(`${base}/api/coordination/sessions/v1`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

async function listSessions(base: string, token: string, machines: string): Promise<any[]> {
  const response = await fetch(`${base}/api/sessions?machines=${machines}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json() as any;
  return body.data.sessions;
}

async function listIds(base: string, token: string, machines: string): Promise<string[]> {
  return (await listSessions(base, token, machines)).map((session: any) => session.id);
}

test("an owned session starts a child session claimed for its own owner", async () => {
  const f = await fixture();
  try {
    const result = await create(f.base, {
      ...caller, session: { agent: "claude", cwd: "/work/repo", title: "Child task", prompt: "do the thing" },
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.ok, true);
    const child = result.body.data.session;
    assert.equal(f.source.creates.length, 1);
    assert.equal(f.source.creates[0].id, child.id);
    assert.equal(f.source.creates[0].prompt, "do the thing");
    assert.match(child.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await listIds(f.base, "browser-tess", "summit"), ["dispatcher", child.id]);
    assert.deepEqual(await listIds(f.base, "browser-dana", "summit"), []);
    const attach = await fetch(`${f.base}/api/sessions/summit/${child.id}/glance`, { headers: { authorization: "Bearer browser-dana" } });
    assert.equal(attach.status, 404);
  } finally { await f.cleanup(); }
});

test("the child session may start on another machine the owner is permitted", async () => {
  const f = await fixture();
  try {
    const result = await create(f.base, { ...caller, machine: "cedar", session: { agent: "codex", cwd: "/w" } });
    assert.equal(result.status, 201);
    assert.equal(f.source.creates.length, 0);
    assert.equal(f.other.creates.length, 1);
    assert.deepEqual(await listIds(f.base, "browser-tess", "cedar"), [result.body.data.session.id]);
  } finally { await f.cleanup(); }
});

test("the child session carries the console's account and agent argument selection", async () => {
  const f = await fixture();
  try {
    // The fake daemon does not confirm account bindings, so the edge answers
    // 502 after forwarding, as the browser route does; this checks what the
    // daemon was asked to create.
    await create(f.base, {
      ...caller, session: { agent: "claude", claude_account: "work", agent_args: ["--model", "opus"] },
    });
    await create(f.base, { ...caller, session: { agent: "codex", codex_account: "spare" } });
    assert.deepEqual(f.source.creates.map(({ id: _id, ...body }) => body), [
      { agent: "claude", claude_account: "work", agent_args: ["--model", "opus"] },
      { agent: "codex", codex_account: "spare" },
    ]);
    const mismatched = await create(f.base, { ...caller, session: { agent: "claude", codex_account: "spare" } });
    assert.equal(mismatched.status, 400);
    assert.equal(mismatched.body.error.code, "invalid-request");
    assert.equal(f.source.creates.length, 2);
  } finally { await f.cleanup(); }
});

test("a caller without an ownership grant is refused before any create", async () => {
  const f = await fixture();
  try {
    const result = await create(f.base, {
      source_session_id: "unowned", source_incarnation: "unowned-inc", session: { agent: "claude" },
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, "ownership-unknown");
    assert.equal(f.source.creates.length, 0);
  } finally { await f.cleanup(); }
});

test("the owner cannot be chosen and the request cannot widen the create", async () => {
  const f = await fixture();
  try {
    for (const body of [
      { ...caller, principal: "dana", session: { agent: "claude" } },
      { ...caller, session: { agent: "claude", id: "chosen-id" } },
      { ...caller, session: { agent: "claude", provider_resume_id: "p1" } },
      { ...caller, session: { agent: "claude", resume_id: "p1" } },
      { ...caller, session: { agent: 7 } },
      { ...caller, machine: 7, session: { agent: "claude" } },
      { ...caller, machine: "", session: { agent: "claude" } },
      { ...caller },
      { source_session_id: "dispatcher", session: { agent: "claude" } },
    ]) {
      const result = await create(f.base, body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, "invalid-request", JSON.stringify(body));
    }
    const stale = await create(f.base, { ...caller, source_incarnation: "old-inc", session: { agent: "claude" } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "session-incarnation-conflict");
    for (const machine of ["maple", "unknown"]) {
      const result = await create(f.base, { ...caller, machine, session: { agent: "claude" } });
      assert.equal(result.status, 403, machine);
      assert.equal(result.body.error.code, "machine-forbidden", machine);
    }
    assert.equal(f.source.creates.length + f.other.creates.length + f.viewerOnly.creates.length, 0);
  } finally { await f.cleanup(); }
});

test("a browser credential cannot start a child session through the relay", async () => {
  const f = await fixture();
  try {
    const result = await create(f.base, { ...caller, session: { agent: "claude" } }, "browser-tess");
    assert.equal(result.status, 401);
    assert.equal(f.source.creates.length, 0);
  } finally { await f.cleanup(); }
});

test("the owner's list names the dispatching session of a child it started", async () => {
  const f = await fixture();
  try {
    const result = await create(f.base, { ...caller, session: { agent: "claude", cwd: "/w" } });
    const remote = await create(f.base, { ...caller, machine: "cedar", session: { agent: "codex", cwd: "/w" } });
    const browser = await fetch(`${f.base}/api/sessions/summit`, {
      method: "POST",
      headers: { authorization: "Bearer browser-tess", "content-type": "application/json", origin: f.base },
      body: JSON.stringify({ agent: "claude", cwd: "/w" }),
    });
    assert.equal(browser.status, 201);
    const browserId = (await browser.json() as any).data.session.id;
    const byId = new Map((await listSessions(f.base, "browser-tess", "summit,cedar")).map((s: any) => [s.id, s]));
    const dispatcher = { machine: "summit", session_id: "dispatcher", repo_name: "legacy-root" };
    assert.deepEqual(byId.get(result.body.data.session.id)?.dispatched_by, dispatcher);
    assert.deepEqual(byId.get(remote.body.data.session.id)?.dispatched_by, dispatcher);
    assert.equal("dispatched_by" in byId.get("dispatcher"), false);
    assert.equal("dispatched_by" in byId.get(browserId), false);
  } finally { await f.cleanup(); }
});

// The lineage the caller's daemon computes for a relayed start
// (nils-cli session-lineage-work-v1): the caller is the parent.
const LINEAGE_SCHEMA = "agent-session.session-lineage.v1";
const callerRef = { machine: "summit", session_id: "dispatcher", session_created_at: "2026-10-02T10:00:00Z", session_incarnation: "disp-inc" };
const rootRef = { machine: "moss", session_id: "coordinator", session_created_at: "2026-10-02T09:00:00Z" };
const childLineage = { schema_version: LINEAGE_SCHEMA, parent: callerRef, root: rootRef, depth: 2, starter: { kind: "session", via: "console" } };
const rootLineage = { schema_version: LINEAGE_SCHEMA, parent: null, root: null, depth: 0, starter: { kind: "operator", via: "console" } };
const work = { program: { provider: "github", repository: "example-org/agent-console", number: 1 }, issues: [], inherited: true };

for (const [name, lineage, role] of [
  ["child", childLineage, "reviewer"],
  ["root role", rootLineage, "domain-coordinator"],
] as const) {
  test(`a relayed ${name} preserves public workspace and authenticated origin`, async () => {
    const f = await fixture();
    try {
      const origin = { parent: { machine: callerRef.machine, session_id: callerRef.session_id } };
      const result = await create(f.base, {
        ...caller, machine: f.otherMachine, session: { agent: "codex", lineage, role, workspace: "project.alpha", origin },
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(f.other.creates[0]!.workspace, "project.alpha");
      assert.deepEqual(f.other.creates[0]!.origin, origin);
      assert.equal(result.body.data.session.workspace, "project.alpha");
      assert.deepEqual(result.body.data.session.origin, origin);
      const sessions = await listSessions(f.base, f.ownerToken, f.otherMachine);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].workspace, "project.alpha", "the Workspace filter consumes this public field");
      assert.deepEqual(sessions[0].origin, origin);
    } finally { await f.cleanup(); }
  });
}

test("relayed workspace accepts public slug bounds and absent/null compatibility", async () => {
  const f = await fixture();
  try {
    for (const workspace of [undefined, null, "a", "0", "team-1", "a".repeat(64)]) {
      const result = await create(f.base, { ...caller, session: { agent: "codex", workspace } });
      assert.equal(result.status, 201);
      const forwarded = f.source.creates.at(-1)!;
      assert.equal(forwarded.workspace, workspace);
      assert.equal(Object.hasOwn(forwarded, "workspace"), workspace !== undefined);
      assert.equal(Object.hasOwn(forwarded, "origin"), false, "older daemons need not send origin");
    }
  } finally { await f.cleanup(); }
});

test("malformed workspace and forged origin never reach the target daemon", async () => {
  const f = await fixture();
  try {
    for (const workspace of ["", "A", "a_b", "a..b", "a.-b", "-a", "a.", "/private/path", "sk-example", "a".repeat(65), 1, {}, []]) {
      const result = await create(f.base, { ...caller, session: { agent: "codex", workspace } });
      assert.equal(result.status, 400, JSON.stringify(workspace));
    }
    for (const origin of [null, {}, { parent: null }, { parent: { machine: "other-host", session_id: callerRef.session_id } },
      { parent: { machine: callerRef.machine, session_id: "someone-else" } }]) {
      const result = await create(f.base, { ...caller, session: { agent: "codex", workspace: "project.alpha", origin } });
      assert.equal(result.status, 400, JSON.stringify(origin));
      assert.equal(result.body.error.code, "origin-invalid");
    }
    assert.equal(f.source.creates.length, 0);
    assert.equal(f.other.creates.length, 0);
  } finally { await f.cleanup(); }
});

test("a relayed start forwards the caller's lineage, work, and role to the target daemon", async () => {
  const f = await fixture();
  try {
    const result = await create(f.base, {
      ...caller, machine: "cedar", session: { agent: "claude", cwd: "/w", lineage: childLineage, work, role: null, title_mode: "pinned" },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const { id: _id, ...forwarded } = f.other.creates[0]!;
    assert.deepEqual(forwarded, { agent: "claude", cwd: "/w", lineage: childLineage, work, role: null, title_mode: "pinned" });
    const root = await create(f.base, { ...caller, session: { agent: "codex", lineage: rootLineage, role: "domain-coordinator" } });
    assert.equal(root.status, 201);
    assert.deepEqual(f.source.creates[0]!.lineage, rootLineage, "a root start is forwarded as a root");
    assert.equal(f.source.creates[0]!.role, "domain-coordinator", "a root start may declare the domain-coordinator role");
    const reviewer = await create(f.base, {
      ...caller, machine: "cedar", session: { agent: "claude", lineage: childLineage, role: "reviewer", title_mode: "auto" },
    });
    assert.equal(reviewer.status, 201, JSON.stringify(reviewer.body));
    assert.equal(f.other.creates[1]!.role, "reviewer", "a non-coordinator role is forwarded");
    assert.equal(f.other.creates[1]!.title_mode, "auto", "automatic title mode is forwarded");
    const childCoordinator = await create(f.base, {
      ...caller, session: { agent: "codex", lineage: childLineage, role: "domain-coordinator" },
    });
    assert.equal(childCoordinator.status, 400);
    assert.equal(childCoordinator.body.error.code, "role-requires-root");
    const invalidRole = await create(f.base, {
      ...caller, session: { agent: "codex", lineage: childLineage, role: "invalid role" },
    });
    assert.equal(invalidRole.status, 400);
    assert.equal(invalidRole.body.error.code, "role-invalid");
    const invalidTitleMode = await create(f.base, {
      ...caller, session: { agent: "codex", lineage: childLineage, title_mode: "sometimes" },
    });
    assert.equal(invalidTitleMode.status, 400);
    assert.equal(invalidTitleMode.body.error.code, "title-mode-invalid");
    const bare = await create(f.base, { ...caller, session: { agent: "codex" } });
    assert.equal(bare.status, 201);
    for (const key of ["lineage", "work", "role", "title_mode"]) {
      assert.equal(Object.hasOwn(f.source.creates[1]!, key), false, `an older daemon relay sends no ${key}`);
    }
  } finally { await f.cleanup(); }
});

test("the owner's list shows the lineage, work, and role a lineage-aware daemon recorded", async () => {
  const f = await fixture();
  try {
    f.source.state.echoLineage = true;
    const child = await create(f.base, { ...caller, session: { agent: "claude", lineage: childLineage, work } });
    const coordinator = await create(f.base, { ...caller, session: { agent: "claude", lineage: rootLineage, role: "coordinator" } });
    const byId = new Map((await listSessions(f.base, "browser-tess", "summit")).map((s: any) => [s.id, s]));
    const listedChild = byId.get(child.body.data.session.id);
    assert.deepEqual(listedChild.lineage, childLineage);
    assert.deepEqual(listedChild.work, work);
    assert.deepEqual(listedChild.dispatched_by, { machine: "summit", session_id: "dispatcher", repo_name: "legacy-root" },
      "the dispatcher mark stays as the fallback for older daemons");
    const listedCoordinator = byId.get(coordinator.body.data.session.id);
    assert.equal(listedCoordinator.role, "coordinator");
    assert.equal(listedCoordinator.lineage.depth, 0);
    assert.equal("dispatched_by" in listedCoordinator, false);
  } finally { await f.cleanup(); }
});

test("a relayed lineage must name the calling session as its parent", async () => {
  const f = await fixture();
  try {
    for (const parent of [
      { ...callerRef, session_id: "someone-else" },
      { ...callerRef, session_incarnation: "old-inc" },
      { ...callerRef, machine: "cedar" },
      { machine: "summit", session_id: "dispatcher", session_created_at: "2026-10-02T10:00:00Z" },
      null,
    ]) {
      const result = await create(f.base, { ...caller, session: { agent: "claude", lineage: { ...childLineage, parent } } });
      assert.equal(result.status, 400, JSON.stringify(parent));
      assert.equal(result.body.error.code, "lineage-parent-mismatch", JSON.stringify(parent));
    }
    const foreignOnRoot = await create(f.base, {
      ...caller, session: { agent: "claude", lineage: { ...rootLineage, parent: { ...callerRef, session_id: "someone-else" }, depth: 1 } },
    });
    assert.equal(foreignOnRoot.body.error.code, "lineage-parent-mismatch", "a parent is checked whatever the starter kind");
    const mainAgent = await create(f.base, {
      ...caller, session: { agent: "claude", lineage: { ...childLineage, parent: { ...callerRef, session_id: "x" }, starter: { kind: "main-agent", via: "console" } } },
    });
    assert.equal(mainAgent.body.error.code, "lineage-parent-mismatch");
    for (const lineage of ["root", 7, [], { ...childLineage, starter: "session" }]) {
      const result = await create(f.base, { ...caller, session: { agent: "claude", lineage } });
      assert.equal(result.status, 400, JSON.stringify(lineage));
      assert.equal(result.body.error.code, "lineage-invalid", JSON.stringify(lineage));
    }
    for (const role of ["invalid role", "", 1, {}]) {
      const result = await create(f.base, { ...caller, session: { agent: "claude", role } });
      assert.equal(result.status, 400, JSON.stringify(role));
      assert.equal(result.body.error.code, "role-invalid", JSON.stringify(role));
    }
    // Only a root start (`--no-parent`) may declare a coordinator, so a session
    // cannot make a coordinator inside its own tree.
    for (const session of [
      { agent: "claude", lineage: childLineage, role: "coordinator" },
      { agent: "claude", role: "coordinator" },
    ]) {
      const result = await create(f.base, { ...caller, session });
      assert.equal(result.status, 400, JSON.stringify(session));
      assert.equal(result.body.error.code, "role-requires-root", JSON.stringify(session));
    }
    const badWork = await create(f.base, { ...caller, session: { agent: "claude", work: "a/b#1" } });
    assert.equal(badWork.body.error.code, "work-ref-invalid");
    assert.equal(f.source.creates.length, 0, "nothing reaches the daemon");
  } finally { await f.cleanup(); }
});

test("a browser create starts a console root", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/api/sessions/summit`, {
      method: "POST",
      headers: { authorization: "Bearer browser-tess", "content-type": "application/json", origin: f.base },
      body: JSON.stringify({ agent: "claude", cwd: "/w", lineage: childLineage, role: "coordinator", workspace: "team-1",
        origin: { parent: { machine: callerRef.machine, session_id: callerRef.session_id } } }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(f.source.creates[0]!.lineage, {
      schema_version: LINEAGE_SCHEMA, parent: null, root: null, depth: 0, starter: { kind: "console", via: "console" },
    }, "the browser cannot name a parent");
    assert.equal(Object.hasOwn(f.source.creates[0]!, "role"), false, "the browser cannot claim a role");
    assert.equal(f.source.creates[0]!.workspace, "team-1");
    assert.equal(Object.hasOwn(f.source.creates[0]!, "origin"), false, "the browser cannot claim an origin");
    f.source.sessions.find((s) => s.id === f.source.creates[0]!.id)!.repo_name = "legacy-root";
    const created = (await listSessions(f.base, "browser-tess", "summit")).find((s: any) => s.id === f.source.creates[0]!.id);
    assert.equal("coordinator_tree" in created, false, "a session the user starts is outside every coordinator's tree, even in the legacy-root repo");
    assert.equal("dispatched_by" in created, false);
  } finally { await f.cleanup(); }
});

test("a root start (`--no-parent`, e.g. a legacy-root successor) records no dispatcher", async () => {
  const f = await fixture();
  try {
    const root = await create(f.base, { ...caller, session: { agent: "claude", cwd: "/w", lineage: rootLineage } });
    assert.equal(root.status, 201);
    const child = await create(f.base, { ...caller, session: { agent: "claude", cwd: "/w", lineage: childLineage } });
    const byId = new Map((await listSessions(f.base, "browser-tess", "summit")).map((s: any) => [s.id, s]));
    assert.equal("dispatched_by" in byId.get(root.body.data.session.id), false);
    assert.deepEqual(byId.get(child.body.data.session.id)?.dispatched_by, { machine: "summit", session_id: "dispatcher", repo_name: "legacy-root" });
  } finally { await f.cleanup(); }
});

for (const [name, failure] of [["success", undefined], ["daemon error", { status: 500, code: "structured-prompt-outcome-unknown" }], ["connection drop", "drop"]] as const) {
  test(`a root create records its launcher in its first claim (${name})`, async () => {
    const f = await fixture();
    try {
      f.other.state.createFailure = failure;
      const result = await create(f.base, { ...caller, machine: "cedar", session: { agent: "codex", cwd: "/w", prompt: "go", lineage: rootLineage } });
      assert.equal(result.status, failure ? 502 : 201);
      const id = String(f.other.creates[0]!.id);
      const launcher = { machine: "summit", session_id: "dispatcher", repo_name: "legacy-root" };
      const child = (await listSessions(f.base, "browser-tess", "cedar")).find((s: any) => s.id === id);
      assert.deepEqual(child?.launched_by, launcher);
      assert.equal("dispatched_by" in child, false, "root launches keep their root semantics");
      assert.equal("coordinator_tree" in child, false);
      const store = new AccessStore(f.db);
      assert.deepEqual(store.sessionGrant("cedar", id)?.launcher, { machine: "summit", sessionId: "dispatcher", repoName: "legacy-root" });
      store.claimSession({ principalId: "tess", machine: "cedar", sessionId: id, incarnation: `inc-${id}` });
      assert.deepEqual(store.sessionGrant("cedar", id)?.launcher, { machine: "summit", sessionId: "dispatcher", repoName: "legacy-root" });
      store.close();
      assert.deepEqual(await listIds(f.base, "browser-dana", "summit"), []);
    } finally { await f.cleanup(); }
  });
}

test("a dispatcher without a repository is recorded without a repo name", async () => {
  const f = await fixture();
  try {
    f.source.sessions.splice(0, 1, { id: "dispatcher", agent: "claude", status: "running", session_incarnation: "disp-inc" });
    const result = await create(f.base, { ...caller, session: { agent: "claude", cwd: "/w" } });
    const child = (await listSessions(f.base, "browser-tess", "summit")).find((s: any) => s.id === result.body.data.session.id);
    assert.deepEqual(child.dispatched_by, { machine: "summit", session_id: "dispatcher" });
  } finally { await f.cleanup(); }
});

test("a failed caller snapshot never blocks the create; the mark then has no repo name", async () => {
  const f = await fixture();
  try {
    f.source.state.failList = true;
    const result = await create(f.base, { ...caller, machine: "cedar", session: { agent: "codex", cwd: "/w" } });
    assert.equal(result.status, 201);
    f.source.state.failList = false;
    const child = (await listSessions(f.base, "browser-tess", "cedar")).find((s: any) => s.id === result.body.data.session.id);
    assert.deepEqual(child.dispatched_by, { machine: "summit", session_id: "dispatcher" });
  } finally { await f.cleanup(); }
});

// The coordinator tree (nils-cli#2032 A2): the edge records each
// session's depth in a coordinator's tree when it starts, so a marker never
// changes after an ancestor closes. `dispatcher` (repo legacy-root, no role) is a
// coordinator from before the explicit role.
test("a coordinator's tree depth is recorded at start and survives intermediate sessions closing", async () => {
  const f = await fixture();
  try {
    const start = async (from: string, session: Record<string, unknown> = {}) => {
      const incarnation = from === "dispatcher" ? "disp-inc" : `inc-${from}`;
      const parent = { machine: "summit", session_id: from, session_created_at: "2026-10-02T10:00:00Z", session_incarnation: incarnation };
      const result = await create(f.base, {
        source_session_id: from, source_incarnation: incarnation,
        session: { agent: "claude", lineage: { ...childLineage, parent }, ...session },
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.body.data.session.id as string;
    };
    const rootStart = (from: string, role: "coordinator" | "domain-coordinator" | null) => start(from, { lineage: rootLineage, role });
    const boss = await rootStart("dispatcher", "coordinator");
    const successor = await rootStart(boss, "coordinator");
    const domainBoss = await rootStart("dispatcher", "domain-coordinator");
    const domainKid = await start(domainBoss);
    const kid = await start(boss);
    const grand = await start(kid);
    f.source.sessions.splice(f.source.sessions.findIndex((s) => s.id === kid), 1);
    const great = await start(grand);
    const solo = await rootStart(boss, null);
    // A --no-parent root in the legacy-root repository that does not declare the
    // role is still outside every tree, and so are its children.
    f.source.sessions.find((s) => s.id === solo)!.repo_name = "legacy-root";
    const soloKid = await start(solo);
    const legacyKid = await start("dispatcher");
    const legacyGrand = await start(legacyKid);
    // A legacy-root-repository worker that a session outside every tree started is
    // not a coordinator, so its child is outside the tree too.
    const outsider = await rootStart("dispatcher", null);
    const outsiderWorker = await start(outsider);
    f.source.sessions.find((s) => s.id === outsiderWorker)!.repo_name = "legacy-root";
    const outsiderChild = await start(outsiderWorker);
    const byId = new Map((await listSessions(f.base, "browser-tess", "summit")).map((s: any) => [s.id, s]));
    const depth = (id: string) => byId.get(id)?.coordinator_tree?.depth;
    assert.equal(depth(boss), 0, "an explicit coordinator");
    assert.equal(depth(successor), 0, "a second coordinator during a handoff");
    assert.equal(depth(domainBoss), 0, "a domain coordinator starts its own tree");
    assert.equal(depth(domainKid), 1, "a child of a domain coordinator is one level deep");
    assert.equal(depth(grand), 2, "the grandchild keeps its depth after its parent closed");
    assert.equal(depth(great), 3);
    assert.equal(byId.has(kid), false);
    for (const id of [solo, soloKid]) {
      assert.equal("coordinator_tree" in byId.get(id), false, "a --no-parent root and its children are outside the tree");
    }
    assert.equal(depth(legacyKid), 1, "a child of a coordinator from before the role (repo legacy-root)");
    assert.equal(depth(legacyGrand), 2);
    assert.equal(depth("dispatcher"), 0, "a legacy-root-repo root from before the explicit role is the legacy coordinator");
    for (const id of [outsiderWorker, outsiderChild]) {
      assert.equal("coordinator_tree" in byId.get(id), false, "a dispatched legacy-root-repo worker is not a legacy coordinator");
    }
  } finally { await f.cleanup(); }
});

test("the owner's history marks the entry of a child the dispatcher started", async () => {
  const f = await fixture();
  try {
    const result = await create(f.base, { ...caller, session: { agent: "claude", cwd: "/w" } });
    const childId = result.body.data.session.id as string;
    // The child reports its provider session once the agent starts; the dispatcher has its own.
    for (const session of f.source.sessions) {
      if (session.id === childId) session.provider_resume = { provider: "claude", session_id: "prov-child" };
      if (session.id === "dispatcher") session.provider_resume = { provider: "claude", session_id: "prov-disp" };
    }
    await listSessions(f.base, "browser-tess", "summit");
    const entry = (id: string, providerSessionId: string, repo: string) => ({
      id, provider: "claude", provider_session_id: providerSessionId, cwd: "/w", repo_name: repo,
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:01:00Z", resumable: true,
    });
    f.source.history.push(entry("h-child", "prov-child", "agent-console"), entry("h-disp", "prov-disp", "legacy-root"));
    const response = await fetch(`${f.base}/api/history/sessions?machine=summit`, {
      headers: { authorization: "Bearer browser-tess" },
    });
    assert.equal(response.status, 200);
    const byId = new Map(((await response.json() as any).data.sessions as any[]).map((s) => [s.id, s]));
    assert.deepEqual(byId.get("h-child")?.dispatched_by, { machine: "summit", session_id: "dispatcher", repo_name: "legacy-root" });
    assert.deepEqual(byId.get("h-child")?.coordinator_tree, { depth: 1 }, "the history entry keeps the tree depth");
    assert.equal("dispatched_by" in byId.get("h-disp"), false, "legacy-root's own history entry has no dispatcher");

    const dana = await fetch(`${f.base}/api/history/sessions?machine=summit`, { headers: { authorization: "Bearer browser-dana" } });
    assert.deepEqual((await dana.json() as any).data.sessions, [], "another principal sees neither entry");
  } finally { await f.cleanup(); }
});

for (const [name, failure] of [
  ["answers that its prompt outcome is unknown", { status: 500, code: "structured-prompt-outcome-unknown" }],
  ["drops the create request", "drop"],
] as const) {
  test(`a create that keeps its session but ${name} is claimed for the owner`, async () => {
    const f = await fixture();
    try {
      f.source.state.createFailure = failure;
      const result = await create(f.base, { ...caller, session: { agent: "codex", cwd: "/w", prompt: "go" } });
      const id = String(f.source.creates[0]?.id);
      assert.equal(result.status, 502);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.error.code, "create-outcome-unknown");
      assert.match(result.body.error.message, new RegExp(`session ${id} `));
      assert.equal(f.source.creates.length, 1);
      const child = (await listSessions(f.base, "browser-tess", "summit")).find((s: any) => s.id === id);
      assert.deepEqual(child?.dispatched_by, { machine: "summit", session_id: "dispatcher", repo_name: "legacy-root" });
      assert.deepEqual(await listIds(f.base, "browser-dana", "summit"), []);
    } finally { await f.cleanup(); }
  });
}

test("a create that fails without a session keeps the daemon's failure", async () => {
  const f = await fixture();
  try {
    f.source.state.createNothing = { status: 409, code: "cwd-unavailable" };
    const result = await create(f.base, { ...caller, session: { agent: "codex", cwd: "/w" } });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, "cwd-unavailable");
    assert.deepEqual(await listIds(f.base, "browser-tess", "summit"), ["dispatcher"]);
  } finally { await f.cleanup(); }
});

test("a dropped create polls until serve lists the session, then claims it", async () => {
  const f = await fixture({ failedCreateLookupMs: 5_000, failedCreateLookupIntervalMs: 20 });
  try {
    f.source.state.createFailure = "drop-then-appear";
    const result = await create(f.base, { ...caller, session: { agent: "codex", cwd: "/w", prompt: "go" } });
    const id = String(f.source.creates[0]?.id);
    assert.equal(result.status, 502);
    assert.equal(result.body.error.code, "create-outcome-unknown");
    assert.ok(f.source.listCalls() >= 2);
    assert.ok((await listIds(f.base, "browser-tess", "summit")).includes(id));
  } finally { await f.cleanup(); }
});

test("a create to an unreachable machine fails without waiting out the lookup", async () => {
  const f = await fixture({ failedCreateLookupMs: 10_000, failedCreateLookupIntervalMs: 20 });
  try {
    await new Promise<void>((resolve) => {
      f.other.server.closeAllConnections();
      f.other.server.close(() => resolve());
    });
    // Keep the parent lookup in flight until after the unreachable target fails.
    f.source.state.listDelayMs = 50;
    const started = Date.now();
    const result = await create(f.base, { ...caller, machine: "cedar", session: { agent: "codex", cwd: "/w" } });
    assert.ok(Date.now() - started < 5_000);
    assert.notEqual(result.body.error?.code, "create-outcome-unknown");
    assert.equal(result.body.ok, false);
  } finally { await f.cleanup(); }
});

test("an unreachable create remains fast when parent metadata stalls", async () => {
  const f = await fixture({ failedCreateLookupMs: 10_000, failedCreateLookupIntervalMs: 20 });
  try {
    await new Promise<void>((resolve) => {
      f.other.server.closeAllConnections();
      f.other.server.close(() => resolve());
    });
    f.source.state.stallList = true;
    const started = Date.now();
    const result = await create(f.base, { ...caller, machine: "cedar", session: { agent: "codex", cwd: "/w" } });
    assert.ok(Date.now() - started < 5_000, "best-effort parent metadata cannot consume the failed-create lookup budget");
    assert.notEqual(result.body.error?.code, "create-outcome-unknown");
    assert.equal(result.body.ok, false);
  } finally { await f.cleanup(); }
});
