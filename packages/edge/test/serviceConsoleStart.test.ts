import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import type { BoardRecord } from "../src/board/record.ts";
import { BoardStore } from "../src/board/store.ts";
import { loadConfig, type ConsoleStartServiceConfig } from "../src/config.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const NOW = Date.parse("2030-01-10T00:00:00Z");
const OPERATION = "019a3560-0000-7000-8000-000000000001";
const ROOT_LINEAGE = {
  schema_version: "agent-session.session-lineage.v1", parent: null, root: null, depth: 0,
  starter: { kind: "console", via: "console" },
};
const SERVICE = { source_service_id: "integration", source_service_generation: "generation-1", owner: "tess", machine: "cedar" };
const SESSION = { agent: "claude", cwd: "/abs/path", title: "Service task", prompt: "run", lineage: ROOT_LINEAGE };
const ADMISSION = { relay_machine: "summit", service_id: "integration", service_generation: "generation-1", owners: ["tess"], machines: ["summit", "cedar", "maple"] };

function daemon(token: string) {
  const creates: Array<Record<string, unknown>> = [];
  const state: { refuse?: boolean; hold?: Promise<void> } = {};
  const sessions: Array<Record<string, unknown>> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      res.end(JSON.stringify({ ok: true, data: { sessions } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    creates.push(body);
    if (state.refuse) {
      res.writeHead(422);
      res.end(JSON.stringify({ ok: false, error: { code: "start-failed", message: "refused" } }));
      return;
    }
    await state.hold;
    const session = { id: body.id, agent: body.agent, cwd: body.cwd, title: body.title ?? null, status: "running", session_incarnation: `inc-${String(body.id)}` };
    sessions.push(session);
    res.writeHead(201);
    res.end(JSON.stringify({ ok: true, data: { session } }));
  });
  return { server, creates, state };
}

async function fixture(admissions: readonly ConsoleStartServiceConfig[] = [ADMISSION]) {
  const dir = mkdtempSync(join(tmpdir(), "service-console-start-test-"));
  const db = join(dir, "access.sqlite");
  const boardDb = join(dir, "board.sqlite");
  const summit = daemon("summit-operator");
  const cedar = daemon("cedar-operator");
  const summitAddress = await listenOnLoopback(summit.server);
  const cedarAddress = await listenOnLoopback(cedar.server);
  const edge = createEdgeServer(makeEdgeConfig({
    openAccess: false, multiUser: true, accessDbPath: db,
    principals: [
      { id: "tess", token: "browser-tess", machines: ["summit", "cedar"], permissions: [] },
      { id: "dana", token: "browser-dana", machines: ["summit", "cedar"], permissions: [] },
    ],
    machines: [
      { name: "summit", url: summitAddress.base, token: "summit-operator" },
      { name: "cedar", url: cedarAddress.base, token: "cedar-operator" },
      { name: "maple", url: "http://127.0.0.1:9", token: "maple-operator" },
    ],
    coordinationRelays: [
      { machine: "summit", token: "summit-relay", ingress_token: "summit-ingress" },
      { machine: "cedar", token: "cedar-relay", ingress_token: "cedar-ingress" },
    ],
    consoleStartServices: admissions,
    board: { dbPath: boardDb, retention: "3d" },
  }), { board: { autoStart: false, now: () => NOW } });
  const { base } = await listenOnLoopback(edge);
  return {
    base, db, boardDb, summit, cedar,
    cleanup: async () => {
      await Promise.all([edge, summit.server, cedar.server].map((server) => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function create(base: string, body: unknown, operation: string | null = OPERATION, token = "summit-relay") {
  const response = await fetch(`${base}/api/coordination/sessions/v1`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
      ...(operation === null ? {} : { "x-agent-session-operation-id": operation }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

async function scan(base: string, query: Record<string, string>, token = "summit-relay") {
  const response = await fetch(`${base}/api/coordination/board/v1?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() as any };
}

function boardRow(machine: string, id: string, lineage: unknown): BoardRecord {
  return {
    machine, session_id: id, session_incarnation: `${id}-inc`, messaging_supported: true, repo_name: "repo", cwd: "/abs/path",
    provider: "claude", agent_profile: null, title: id, title_state: null, turn_state: null, state: "live",
    runtime_status: "running", created_at: "2030-01-09T00:00:00Z", updated_at: "2030-01-09T23:00:00Z",
    closed_at: null, close_reason: null, summary: null, lineage,
  } as unknown as BoardRecord;
}

const rootLineage = (machine: string, id: string) => ({
  schema_version: "agent-session.session-lineage.v1", parent: null, effective_parent: null,
  root: { machine, session_id: id, session_created_at: "2030-01-09T00:00:00Z" }, depth: 0,
  starter: { kind: "console", via: "console" }, ended_ancestors: [],
});

test("an admitted service starts a root session owned by the named owner on the named machine", async () => {
  const f = await fixture();
  try {
    const result = await create(f.base, { ...SERVICE, session: SESSION });
    assert.equal(result.status, 201);
    assert.equal(result.body.ok, true);
    const session = result.body.data.session;
    assert.equal(f.summit.creates.length, 0);
    assert.equal(f.cedar.creates.length, 1);
    assert.equal(f.cedar.creates[0].id, session.id);
    assert.deepEqual(f.cedar.creates[0].lineage, ROOT_LINEAGE);
    assert.equal(f.cedar.creates[0].prompt, "run");
    const access = new AccessStore(f.db);
    const grant = access.sessionGrant("cedar", session.id);
    access.close();
    assert.equal(grant?.principalId, "tess");
    assert.equal(grant?.incarnation, session.session_incarnation);
    assert.equal(grant?.launcher, null);
    assert.equal(grant?.dispatcher, null);
  } finally { await f.cleanup(); }
});

test("every unadmitted selector is refused before anything is created", async () => {
  const f = await fixture();
  try {
    const unauthorized = [403, "console-start-service-unauthorized"] as const;
    const ownerDenied = [422, "console-start-service-owner-denied"] as const;
    const targetDenied = [422, "console-start-service-target-denied"] as const;
    const refused: Array<[Record<string, string>, readonly [number, string], string?]> = [
      [{ ...SERVICE, source_service_id: "stranger" }, unauthorized],
      [{ ...SERVICE, source_service_generation: "generation-0" }, unauthorized],
      [{ ...SERVICE }, unauthorized, "cedar-relay"],
      [{ ...SERVICE, owner: "dana" }, ownerDenied],
      [{ ...SERVICE, machine: "pine" }, targetDenied],
      // Admitted for the service, but outside the owner's own machine allowlist.
      [{ ...SERVICE, machine: "maple" }, targetDenied],
    ];
    for (const [selectors, [status, code], token] of refused) {
      const result = await create(f.base, { ...selectors, session: SESSION }, OPERATION, token);
      assert.equal(result.status, status, code);
      assert.equal(result.body.error.code, code);
      const read = await scan(f.base, selectors, token);
      assert.equal(read.status, status, code);
      assert.equal(read.body.error.code, code);
      assert.equal(read.body.records, undefined, code);
    }
    assert.equal(f.summit.creates.length + f.cedar.creates.length, 0);
    // A refusal burns no operation id.
    assert.equal((await create(f.base, { ...SERVICE, session: SESSION })).status, 201);
  } finally { await f.cleanup(); }
});

test("a deployment without admissions refuses service creates", async () => {
  const f = await fixture([]);
  try {
    const result = await create(f.base, { ...SERVICE, session: SESSION });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, "console-start-service-unauthorized");
    assert.equal(f.cedar.creates.length, 0);
  } finally { await f.cleanup(); }
});

test("a malformed service create is refused and never reaches a session-scoped path", async () => {
  const f = await fixture();
  try {
    const cases: Array<[unknown, string | null, string]> = [
      [{ ...SERVICE, session: SESSION }, null, "invalid-request"],
      [{ ...SERVICE, session: SESSION }, "not-a-uuid", "invalid-request"],
      // A canonical UUIDv4 is not a UUIDv7.
      [{ ...SERVICE, session: SESSION }, "019a3560-0000-4000-8000-000000000001", "invalid-request"],
      [{ ...SERVICE, source_session_id: "dispatcher", source_incarnation: "inc", session: SESSION }, OPERATION, "invalid-request"],
      [{ ...SERVICE, session: SESSION, extra: true }, OPERATION, "invalid-request"],
      [{ ...SERVICE, owner: undefined, session: SESSION }, OPERATION, "invalid-request"],
      [{ ...SERVICE, machine: undefined, session: SESSION }, OPERATION, "invalid-request"],
      [{ ...SERVICE, source_service_id: "bad id", session: SESSION }, OPERATION, "invalid-request"],
      [{ ...SERVICE, session: { ...SESSION, id: "chosen" } }, OPERATION, "invalid-request"],
      [{ ...SERVICE, session: { ...SESSION, provider_resume_id: "resume" } }, OPERATION, "invalid-request"],
      [{ ...SERVICE, session: { ...SESSION, resume: "resume" } }, OPERATION, "invalid-request"],
      [{ ...SERVICE, session: { ...SESSION, role: "coordinator" } }, OPERATION, "invalid-request"],
      [{ ...SERVICE, session: { ...SESSION, work: {} } }, OPERATION, "invalid-request"],
      [{ ...SERVICE, session: { ...SESSION, origin: { parent: { machine: "summit", session_id: "x" } } } }, OPERATION, "invalid-request"],
      [{ ...SERVICE, session: { ...SESSION, agent: "" } }, OPERATION, "invalid-request"],
      [{ ...SERVICE, session: { agent: "claude", cwd: "/abs/path" } }, OPERATION, "lineage-invalid"],
      [{ ...SERVICE, session: { ...SESSION, lineage: { ...ROOT_LINEAGE, parent: { machine: "summit", session_id: "x", session_incarnation: "y" } } } }, OPERATION, "lineage-invalid"],
      [{ ...SERVICE, session: { ...SESSION, lineage: { ...ROOT_LINEAGE, starter: { kind: "session", via: "console" } } } }, OPERATION, "lineage-invalid"],
    ];
    for (const [body, operation, code] of cases) {
      const result = await create(f.base, body, operation);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, code, JSON.stringify(body));
    }
    assert.equal(f.summit.creates.length + f.cedar.creates.length, 0);
    assert.equal((await create(f.base, { ...SERVICE, session: SESSION })).status, 201);
  } finally { await f.cleanup(); }
});

test("an identical retry replays the session and never creates a second one", async () => {
  const f = await fixture();
  try {
    const first = await create(f.base, { ...SERVICE, session: SESSION });
    const replay = await create(f.base, { ...SERVICE, session: SESSION });
    assert.equal(replay.status, 201);
    const { id, agent, session_incarnation } = first.body.data.session;
    assert.deepEqual(replay.body, { ok: true, data: { session: { id, agent, session_incarnation } } });
    assert.equal(f.cedar.creates.length, 1);
    assert.equal(new Set(f.cedar.creates.map(body => body.id)).size, 1);
  } finally { await f.cleanup(); }
});

test("a replay survives a generation rotation and is scoped to the service", async () => {
  const rotated = { ...ADMISSION, service_generation: "generation-2" };
  const other = { ...ADMISSION, service_id: "other" };
  const f = await fixture([ADMISSION, rotated, other]);
  try {
    const first = await create(f.base, { ...SERVICE, session: SESSION });
    const replay = await create(f.base, { ...SERVICE, source_service_generation: "generation-2", session: SESSION });
    assert.equal(replay.body.data.session.id, first.body.data.session.id);
    assert.equal(f.cedar.creates.length, 1);
    const independent = await create(f.base, { ...SERVICE, source_service_id: "other", session: SESSION });
    assert.notEqual(independent.body.data.session.id, first.body.data.session.id);
    assert.equal(f.cedar.creates.length, 2);
  } finally { await f.cleanup(); }
});

test("a different request under the same operation id conflicts", async () => {
  const f = await fixture([{ ...ADMISSION, owners: ["tess", "dana"] }]);
  try {
    await create(f.base, { ...SERVICE, session: SESSION });
    for (const change of [{ machine: "summit" }, { owner: "dana" }, { session: { ...SESSION, prompt: "other" } }]) {
      const result = await create(f.base, { ...SERVICE, session: SESSION, ...change });
      assert.equal(result.status, 409, JSON.stringify(change));
      assert.equal(result.body.error.code, "console-start-operation-conflict");
    }
    assert.equal(f.summit.creates.length + f.cedar.creates.length, 1);
  } finally { await f.cleanup(); }
});

test("a concurrent retry and a retry after a failed create never post again", async () => {
  const f = await fixture();
  try {
    let release = (): void => {};
    f.cedar.state.hold = new Promise(resolve => { release = resolve; });
    const pending = create(f.base, { ...SERVICE, session: SESSION });
    for (let tries = 0; f.cedar.creates.length === 0 && tries < 200; tries += 1) await new Promise(resolve => setTimeout(resolve, 5));
    const concurrent = await create(f.base, { ...SERVICE, session: SESSION });
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.body.error.code, "console-start-unavailable");
    release();
    assert.equal((await pending).status, 201);
    assert.equal(f.cedar.creates.length, 1);

    const failedOperation = "019a3560-0000-7000-8000-000000000002";
    f.cedar.state.refuse = true;
    assert.equal((await create(f.base, { ...SERVICE, session: SESSION }, failedOperation)).status, 422);
    f.cedar.state.refuse = false;
    const retry = await create(f.base, { ...SERVICE, session: SESSION }, failedOperation);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error.code, "console-start-unavailable");
    assert.equal(f.cedar.creates.length, 2);
  } finally { await f.cleanup(); }
});

test("the operation record outlives the store that wrote it", async () => {
  const f = await fixture();
  try {
    const created = await create(f.base, { ...SERVICE, session: SESSION });
    const reopened = new AccessStore(f.db);
    const row = reopened.beginServiceStart({ relayMachine: "summit", serviceId: "integration", operationId: OPERATION, sessionId: "unused", machine: "cedar", agent: "claude", fingerprint: "unused" });
    reopened.close();
    assert.equal(row.sessionId, created.body.data.session.id);
  } finally { await f.cleanup(); }
});

test("the scan returns only this service's root sessions for the owner on the machine", async () => {
  const f = await fixture([{ ...ADMISSION, owners: ["tess", "dana"] }, { ...ADMISSION, service_id: "other" }]);
  try {
    const mine = (await create(f.base, { ...SERVICE, session: SESSION })).body.data.session.id as string;
    const otherOwner = (await create(f.base, { ...SERVICE, owner: "dana", session: SESSION }, "019a3560-0000-7000-8000-000000000002")).body.data.session.id as string;
    const otherMachine = (await create(f.base, { ...SERVICE, machine: "summit", session: SESSION }, "019a3560-0000-7000-8000-000000000003")).body.data.session.id as string;
    const otherService = (await create(f.base, { ...SERVICE, source_service_id: "other", session: SESSION }, "019a3560-0000-7000-8000-000000000004")).body.data.session.id as string;
    const access = new AccessStore(f.db);
    access.claimSession({ principalId: "tess", machine: "cedar", sessionId: "owner-root", incarnation: "owner-root-inc" });
    access.close();
    const board = new BoardStore(f.boardDb);
    board.applySnapshot("cedar", [
      boardRow("cedar", mine, rootLineage("cedar", mine)),
      boardRow("cedar", otherOwner, rootLineage("cedar", otherOwner)),
      boardRow("cedar", otherService, rootLineage("cedar", otherService)),
      boardRow("cedar", "owner-root", rootLineage("cedar", "owner-root")),
    ], true, NOW - 1000);
    board.applySnapshot("summit", [boardRow("summit", otherMachine, rootLineage("summit", otherMachine))], true, NOW - 1000);
    board.close();

    const { machine, ...selectors } = SERVICE;
    const result = await scan(f.base, { ...selectors, machine });
    assert.equal(result.status, 200);
    assert.equal(result.body.schema_version, "agent-session.board-view.v1");
    assert.deepEqual(result.body.records.map((record: any) => [record.machine, record.session_id, record.console_owner, record.lineage.parent]), [["cedar", mine, "tess", null]]);
    assert.deepEqual(result.body.machines.map((entry: any) => entry.machine), ["cedar"]);
  } finally { await f.cleanup(); }
});

test("a session the service started that lost its root lineage is not a candidate", async () => {
  const f = await fixture();
  try {
    const id = (await create(f.base, { ...SERVICE, session: SESSION })).body.data.session.id as string;
    const board = new BoardStore(f.boardDb);
    board.applySnapshot("cedar", [boardRow("cedar", id, null)], true, NOW - 1000);
    board.close();
    assert.deepEqual((await scan(f.base, SERVICE)).body.records, []);
  } finally { await f.cleanup(); }
});

test("a malformed scan is refused without a session-scoped fallback", async () => {
  const f = await fixture();
  try {
    const { owner: _owner, ...withoutOwner } = SERVICE;
    const { machine: _machine, ...withoutMachine } = SERVICE;
    for (const query of [
      withoutOwner, withoutMachine,
      { ...SERVICE, source_session_id: "dispatcher", source_incarnation: "inc" },
      { ...SERVICE, state: "nonsense" },
      { ...SERVICE, unknown: "1" },
    ]) {
      const result = await scan(f.base, query);
      assert.equal(result.status, 400, JSON.stringify(query));
      assert.equal(result.body.error.code, "board-query-invalid", JSON.stringify(query));
    }
  } finally { await f.cleanup(); }
});

test("service admissions load only with configured relays, owners and machines", () => {
  const env = {
    AGENT_CONSOLE_PRINCIPALS: JSON.stringify([
      { id: "tess", token: "t".repeat(32), machines: ["summit"], permissions: [] },
      { id: "root", token: "r".repeat(32), machines: ["summit"], permissions: [] },
    ]),
    AGENT_CONSOLE_STATE_DB: "/data/access.sqlite",
    AGENT_CONSOLE_MACHINES: JSON.stringify([{ name: "summit", url: "http://127.0.0.1:1", token: "m".repeat(32) }]),
    AGENT_CONSOLE_COORDINATION_RELAYS: JSON.stringify([{ machine: "summit", token: "a".repeat(32), ingress_token: "b".repeat(32) }]),
  };
  const entry = { relay_machine: "summit", service_id: "integration", service_generation: "generation-1", owners: ["tess"], machines: ["summit"] };
  const load = (value: unknown) => loadConfig({ ...env, AGENT_CONSOLE_CONSOLE_START_SERVICES: JSON.stringify(value) }).consoleStartServices;
  assert.deepEqual(loadConfig(env).consoleStartServices, []);
  assert.deepEqual(load([entry]), [entry]);
  // Two generations of one service may overlap during a rotation.
  assert.equal(load([entry, { ...entry, service_generation: "generation-2" }])?.length, 2);
  for (const invalid of [
    {}, [{ ...entry, extra: 1 }], [entry, entry], [{ ...entry, relay_machine: "pine" }],
    [{ ...entry, service_id: "bad id" }], [{ ...entry, service_generation: "" }],
    [{ ...entry, owners: [] }], [{ ...entry, owners: ["stranger"] }], [{ ...entry, owners: ["root"] }],
    [{ ...entry, machines: [] }], [{ ...entry, machines: ["pine"] }],
  ]) assert.throws(() => load(invalid), /CONSOLE_START_SERVICES/, JSON.stringify(invalid));
});
