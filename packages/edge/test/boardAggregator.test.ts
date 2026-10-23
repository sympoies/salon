import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { BoardAggregator } from "../src/board/ingest.ts";
import { BOARD_STORE_VERSION, BoardStore } from "../src/board/store.ts";
import { projectBoardRecord, parseBoardRetention } from "../src/board/record.ts";
import { loadConfig } from "../src/config.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "agent-console-board-"));
after(() => rmSync(tempRoot, { recursive: true, force: true }));
let dbCounter = 0;
const freshDb = (): string => join(tempRoot, `board-${++dbCounter}.sqlite`);

const T0 = Date.parse("2030-01-10T00:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function record(machine: string, id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    machine,
    session_id: id,
    session_incarnation: `${id}-inc`,
    messaging_supported: true,
    repo_name: "nils-cli",
    cwd: "~/workspace/nils-cli",
    provider: "claude",
    agent_profile: null,
    title: `Title ${id}`,
    title_state: { activity: "Drafting" },
    turn_state: {
      phase: "working",
      phase_changed_at: "2030-01-01T00:00:00Z",
      current_turn: { last_progress_at: "2030-01-01T00:04:00Z", attention: null },
      last_turn: { outcome: "completed" },
      source: { confidence: "authoritative" },
    },
    state: "live",
    runtime_status: "running",
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-09T23:00:00Z",
    closed_at: null,
    close_reason: null,
    summary: null,
    ...overrides,
  };
}

function closedRecord(machine: string, id: string, reason: string, closedAt: string): Record<string, unknown> {
  return record(machine, id, {
    state: "closed", runtime_status: null, messaging_supported: false, closed_at: closedAt, close_reason: reason,
  });
}

interface FakeDaemon {
  server: Server;
  url: string;
  name: string;
  records: Record<string, unknown>[];
  ledger: Array<{ seq: number; record: Record<string, unknown> }>;
  ledgerId: string;
  skipped: number;
  envelopeMachine?: string;
  snapshotStatus?: { status: number; body: unknown };
  hits: string[];
  auth: Array<string | undefined>;
  expireNext: boolean;
}

async function fakeDaemon(name: string): Promise<FakeDaemon> {
  const daemon: FakeDaemon = {
    server: undefined as unknown as Server, url: "", name, records: [], ledger: [], ledgerId: "L1",
    skipped: 0, hits: [], auth: [], expireNext: false,
  };
  daemon.server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://daemon");
    daemon.hits.push(`${url.pathname}${url.search}`);
    daemon.auth.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    const machine = daemon.envelopeMachine ?? daemon.name;
    if (url.pathname === "/board/v1") {
      if (daemon.snapshotStatus) {
        res.writeHead(daemon.snapshotStatus.status);
        res.end(JSON.stringify(daemon.snapshotStatus.body));
        return;
      }
      res.end(JSON.stringify({
        schema_version: "cli.agent-session.serve.v1", ok: true,
        data: { machine, board: {
          schema_version: "agent-session.board.v1", record_schema: "agent-session.board-record.v1",
          machine, generated_at: "2030-01-10T00:00:00Z", ledger_cursor: `${daemon.ledgerId}:${daemon.ledger.at(-1)?.seq ?? 0}`,
          records: daemon.records, skipped_count: daemon.skipped,
        } },
      }));
      return;
    }
    if (url.pathname === "/board/closed/v1") {
      const since = url.searchParams.get("since");
      if (since !== null && (daemon.expireNext || !since.startsWith(`${daemon.ledgerId}:`))) {
        daemon.expireNext = false;
        res.writeHead(410);
        res.end(JSON.stringify({ schema_version: "cli.agent-session.serve.v1", ok: false, error: { code: "board-cursor-expired", message: "cursor expired" } }));
        return;
      }
      const after = since === null ? 0 : Number(since.split(":")[1]);
      const entries = daemon.ledger.filter((entry) => entry.seq > after)
        .map((entry) => ({ cursor: `${daemon.ledgerId}:${entry.seq}`, record: entry.record }));
      const head = daemon.ledger.at(-1)?.seq ?? 0;
      res.end(JSON.stringify({
        schema_version: "cli.agent-session.serve.v1", ok: true,
        data: { machine, board_closed: {
          schema_version: "agent-session.board-closed.v1", record_schema: "agent-session.board-record.v1",
          machine, generated_at: "2030-01-10T00:00:00Z", entries,
          next_cursor: entries.at(-1)?.cursor ?? `${daemon.ledgerId}:${head}`,
        } },
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: { code: "route-not-found", message: "unknown" } }));
  });
  daemon.url = (await listenOnLoopback(daemon.server)).base;
  return daemon;
}

async function closeAll(...servers: Server[]): Promise<void> {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
}

function aggregator(store: BoardStore, daemons: FakeDaemon[], clock: { now: number }): BoardAggregator {
  return new BoardAggregator(
    store,
    daemons.map((daemon) => ({ name: daemon.name, url: daemon.url, token: `${daemon.name}-operator` })),
    { retention: "3d", now: () => clock.now },
  );
}

test("board store migrates from empty, reopens idempotently, and resets safely when deleted", () => {
  const path = freshDb();
  const first = new BoardStore(path);
  first.close();
  const raw = new DatabaseSync(path);
  assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, BOARD_STORE_VERSION);
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
  assert.deepEqual(tables, ["board_machine", "board_record"]);
  raw.close();

  const second = new BoardStore(path);
  second.applySnapshot("host-a", [], true, T0);
  second.close();
  const third = new BoardStore(path);
  assert.equal(third.machineStatus("host-a").lastSeenMs, T0);
  third.close();

  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const reset = new BoardStore(path);
  assert.equal(reset.machineStatus("host-a").lastSeenMs, null);
  assert.deepEqual(reset.rows(), []);
  reset.close();
});

test("board store refuses a file written by a newer schema version", () => {
  const path = freshDb();
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA user_version = ${BOARD_STORE_VERSION + 1}`);
  raw.close();
  assert.throws(() => new BoardStore(path), /newer/);
});

test("ingests every configured machine with its operator bearer and projects the record allowlist", async () => {
  const a = await fakeDaemon("host-a");
  const b = await fakeDaemon("host-b");
  a.records = [record("host-a", "s1", { last_prompt: "private-prompt-sentinel", attach_command: "tmux attach", summary: "ignored" })];
  b.records = [record("host-b", "s2", { state: "stopped", runtime_status: "missing", messaging_supported: false })];
  b.ledger = [{ seq: 1, record: closedRecord("host-b", "gone", "deleted", "2030-01-09T12:00:00Z") }];
  const store = new BoardStore(freshDb());
  const clock = { now: T0 };
  try {
    await aggregator(store, [a, b], clock).ingestAll();
    assert.deepEqual(a.auth, ["Bearer host-a-operator", "Bearer host-a-operator"]);
    assert.deepEqual(b.hits, ["/board/closed/v1", "/board/v1"]);
    const rows = store.rows();
    assert.deepEqual(rows.map((row) => `${row.machine}/${row.session_id}/${row.state}`).sort(), [
      "host-a/s1/live", "host-b/gone/closed", "host-b/s2/stopped",
    ]);
    const s1 = rows.find((row) => row.session_id === "s1")!;
    assert.deepEqual(Object.keys(s1).sort(), [
      "agent_profile", "close_reason", "closed_at", "created_at", "cwd", "lineage", "machine", "messaging_supported", "model",
      "provider", "reasoning_effort", "repo_name", "role", "runtime_status", "session_id", "session_incarnation", "state", "summary",
      "title", "title_state", "turn_state", "updated_at", "work",
    ]);
    assert.equal(s1.summary, null);
    assert.deepEqual([s1.role, s1.lineage, s1.work], [null, null, null], "a daemon before lineage.v1 gives null members");
    assert.equal(JSON.stringify(rows).includes("private-prompt-sentinel"), false);
    const gone = rows.find((row) => row.session_id === "gone")!;
    assert.equal(gone.close_reason, "deleted");
    assert.equal(gone.closed_at, "2030-01-09T12:00:00Z");
    assert.deepEqual(store.machineStatuses(["host-a", "host-b"], clock.now).map((m) => m.available), [true, true]);
  } finally {
    store.close();
    await closeAll(a.server, b.server);
  }
});

// session-board-v1 lineage.v1 and work.v1 (nils-cli#2071).
const ref = (id: string, machine = "host-a") => ({ machine, session_id: id, session_created_at: "2030-01-01T00:00:00Z" });
const childLineage = {
  parent: ref("boss"), effective_parent: ref("boss"), root: ref("boss"), depth: 1,
  starter: { kind: "session", via: "console" }, budget: null,
};
const childWork = {
  program: { provider: "github", repository: "owner/program", number: 44 },
  issues: [{ provider: "github", repository: "owner/repo", number: 2032 }],
  inherited: true,
};

test("role, lineage, and work are projected strictly onto stored records", async () => {
  const a = await fakeDaemon("host-a");
  a.records = [
    record("host-a", "boss", {
      role: "coordinator",
      lineage: { ...childLineage, parent: null, effective_parent: null, root: ref("boss"), depth: 0, starter: { kind: "operator", via: "console" } },
      work: null,
    }),
    record("host-a", "child", {
      role: null,
      lineage: { ...childLineage, parent: { ...ref("boss"), session_incarnation: "boss-inc" }, extra: "dropped" },
      work: { ...childWork, revision: 3 },
    }),
    record("host-a", "bad-role", { role: "invalid role" }),
    record("host-a", "bad-lineage", { lineage: { ...childLineage, depth: "1" } }),
    record("host-a", "bad-work", { work: { ...childWork, issues: "owner/repo#1" } }),
  ];
  a.ledger = [{ seq: 1, record: closedRecord("host-a", "closed-child", "deleted", "2030-01-09T12:00:00Z") }];
  const store = new BoardStore(freshDb());
  const clock = { now: T0 };
  try {
    await aggregator(store, [a], clock).ingestAll();
    const byId = new Map(store.rows().map((row) => [row.session_id, row]));
    assert.equal(byId.get("boss")?.role, "coordinator");
    assert.equal(byId.get("boss")?.lineage?.depth, 0);
    assert.deepEqual(byId.get("child")?.lineage, childLineage, "refs carry no incarnation and unknown members are dropped");
    assert.deepEqual(byId.get("child")?.work, childWork, "the work revision is not exposed");
    assert.equal(byId.get("bad-role")?.role, null, "malformed display role preserves the session without guessing");
    for (const id of ["bad-lineage", "bad-work"]) {
      assert.equal(byId.has(id), false, `${id} is outside the contract and skipped`);
    }
    assert.deepEqual([byId.get("closed-child")?.role, byId.get("closed-child")?.lineage, byId.get("closed-child")?.work], [null, null, null]);
  } finally {
    store.close();
    await closeAll(a.server);
  }
});

test("a board store from before lineage migrates and serves its rows with null members", () => {
  const path = freshDb();
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE board_machine (machine TEXT PRIMARY KEY, closed_cursor TEXT, last_seen_ms INTEGER, last_attempt_ok INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE board_record (machine TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('live', 'stopped', 'closed')), repo_name TEXT, updated_ms INTEGER NOT NULL,
      closed_ms INTEGER, missing_since_ms INTEGER, record_json TEXT NOT NULL, PRIMARY KEY (machine, session_id, created_at)) STRICT;
    CREATE INDEX board_record_closed ON board_record (state, closed_ms);
    PRAGMA user_version = 1;
  `);
  const old = { ...record("host-a", "old"), summary: null };
  raw.prepare("INSERT INTO board_record (machine, session_id, created_at, state, repo_name, updated_ms, record_json) VALUES (?, ?, ?, 'live', ?, ?, ?)")
    .run("host-a", "old", "2030-01-01T00:00:00Z", "nils-cli", T0, JSON.stringify(old));
  raw.close();
  const store = new BoardStore(path);
  try {
    const [row] = store.rows();
    assert.deepEqual([row?.role, row?.lineage, row?.work], [null, null, null]);
    const query = { states: ["live"], sinceMs: 0, repo: null, machine: null, availableMachines: ["host-a"], configuredMachines: ["host-a"], limit: 10 };
    assert.deepEqual(store.queryRows({ ...query, root: "boss" }), [], "a migrated row has no root until it is ingested again");
    store.applySnapshot("host-a", [{ ...row!, lineage: childLineage }], true, T0);
    assert.deepEqual(store.queryRows({ ...query, root: "boss" }).map((record) => record.session_id), ["old"]);
  } finally {
    store.close();
  }
  const check = new DatabaseSync(path);
  assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, BOARD_STORE_VERSION);
  check.close();
});

test("rejects a response whose machine differs from the configured name", async () => {
  const a = await fakeDaemon("host-a");
  a.records = [record("host-a", "s1")];
  const store = new BoardStore(freshDb());
  const clock = { now: T0 };
  try {
    const agg = aggregator(store, [a], clock);
    a.envelopeMachine = "impostor";
    await agg.ingestAll();
    assert.deepEqual(store.rows(), []);
    assert.deepEqual(store.machineStatuses(["host-a"], clock.now), [{ machine: "host-a", available: false, last_seen_at: null }]);

    a.envelopeMachine = undefined;
    a.records = [record("host-a", "s1"), record("impostor", "s9")];
    await agg.ingestAll();
    assert.deepEqual(store.rows(), []);
    assert.equal(store.machineStatuses(["host-a"], clock.now)[0]!.available, false);
  } finally {
    store.close();
    await closeAll(a.server);
  }
});

test("a record outside the contract is skipped as incomplete instead of failing the machine", async () => {
  const a = await fakeDaemon("host-a");
  a.records = [record("host-a", "s1"), record("host-a", "s2")];
  const store = new BoardStore(freshDb());
  const clock = { now: T0 };
  try {
    const agg = aggregator(store, [a], clock);
    await agg.ingestAll();
    // A tab in a title is spec-conformant display text; a numeric provider is not.
    a.records = [record("host-a", "s1", { title: "a\tb" }), record("host-a", "s2", { provider: 7 })];
    for (const offset of [30_000, 100_000, 170_000]) {
      clock.now = T0 + offset;
      await agg.ingestAll();
    }
    assert.equal(store.machineStatuses(["host-a"], clock.now)[0]!.available, true);
    const rows = store.rows();
    assert.equal(rows.find((row) => row.session_id === "s1")?.title, "a\tb");
    // The skipped record keeps its last ingested value and never vanishes.
    assert.equal(rows.find((row) => row.session_id === "s2")?.state, "live");
    assert.equal(rows.find((row) => row.session_id === "s2")?.provider, "claude");
  } finally {
    store.close();
    await closeAll(a.server);
  }
});

test("resumes the closed ledger from the stored cursor and fully resyncs on cursor-expired", async () => {
  const a = await fakeDaemon("host-a");
  a.records = [record("host-a", "s1"), record("host-a", "s2")];
  const path = freshDb();
  let store = new BoardStore(path);
  const clock = { now: T0 };
  try {
    await aggregator(store, [a], clock).ingestAll();
    assert.equal(store.machineStatus("host-a").cursor, "L1:0");

    // s2 is deleted; the stored cursor survives a restart.
    a.records = [record("host-a", "s1")];
    a.ledger.push({ seq: 1, record: closedRecord("host-a", "s2", "archived", "2030-01-10T00:00:10Z") });
    store.close();
    store = new BoardStore(path);
    a.hits = [];
    clock.now = T0 + 30_000;
    await aggregator(store, [a], clock).ingestAll();
    assert.deepEqual(a.hits, ["/board/closed/v1?since=L1%3A0", "/board/v1"]);
    assert.equal(store.machineStatus("host-a").cursor, "L1:1");
    assert.equal(store.rows().find((row) => row.session_id === "s2")?.close_reason, "archived");

    // The ledger was replaced: the cursor expires and the consumer resyncs.
    a.ledgerId = "L2";
    a.ledger = [{ seq: 1, record: closedRecord("host-a", "s3", "deleted", "2030-01-10T00:00:40Z") }];
    a.hits = [];
    clock.now = T0 + 60_000;
    await aggregator(store, [a], clock).ingestAll();
    assert.deepEqual(a.hits, ["/board/closed/v1?since=L1%3A1", "/board/closed/v1", "/board/v1"]);
    assert.equal(store.machineStatus("host-a").cursor, "L2:1");
    assert.equal(store.rows().find((row) => row.session_id === "s3")?.close_reason, "deleted");
    assert.equal(store.machineStatuses(["host-a"], clock.now)[0]!.available, true);
  } finally {
    store.close();
    await closeAll(a.server);
  }
});

test("marks a failing or stale machine unavailable, keeps its rows, and never logs", async () => {
  const a = await fakeDaemon("host-a");
  a.snapshotStatus = { status: 404, body: { ok: false, error: { code: "board-disabled", message: "board is disabled" } } };
  const store = new BoardStore(freshDb());
  const clock = { now: T0 };
  const logged: unknown[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  console.log = console.error = console.warn = console.info = (...args: unknown[]) => { logged.push(args); };
  try {
    const agg = aggregator(store, [a], clock);
    await agg.ingestAll();
    assert.deepEqual(store.machineStatuses(["host-a"], clock.now), [{ machine: "host-a", available: false, last_seen_at: null }]);

    a.snapshotStatus = undefined;
    a.records = [record("host-a", "s1")];
    await agg.ingestAll();
    assert.equal(store.machineStatuses(["host-a"], clock.now)[0]!.available, true);

    a.snapshotStatus = { status: 500, body: "not json" };
    clock.now = T0 + 30_000;
    await agg.ingestAll();
    assert.deepEqual(store.machineStatuses(["host-a"], clock.now), [{ machine: "host-a", available: false, last_seen_at: iso(T0) }]);
    assert.equal(store.rows().length, 1, "rows of an unavailable machine are retained");

    // A machine whose last success is older than the freshness window is stale.
    a.snapshotStatus = undefined;
    await agg.ingestAll();
    clock.now += 10 * 60_000;
    assert.equal(store.machineStatuses(["host-a"], clock.now)[0]!.available, false);

    await closeAll(a.server);
    await agg.ingestAll();
    assert.equal(store.machineStatuses(["host-a"], clock.now)[0]!.available, false);
  } finally {
    Object.assign(console, original);
    store.close();
  }
  assert.deepEqual(logged, []);
});

test("a row vanishes only after two complete snapshots at least 60 seconds apart", async () => {
  const a = await fakeDaemon("host-a");
  a.records = [record("host-a", "s1"), record("host-a", "s2")];
  const store = new BoardStore(freshDb());
  const clock = { now: T0 };
  const state = (id: string) => store.rows().find((row) => row.session_id === id);
  try {
    const agg = aggregator(store, [a], clock);
    await agg.ingestAll();
    a.records = [record("host-a", "s1")];

    clock.now = T0 + 30_000;
    await agg.ingestAll();
    assert.equal(state("s2")?.state, "live");
    // An incomplete snapshot breaks the consecutive-absence rule.
    a.skipped = 1;
    clock.now = T0 + 70_000;
    await agg.ingestAll();
    assert.equal(state("s2")?.state, "live");
    a.skipped = 0;
    clock.now = T0 + 100_000;
    await agg.ingestAll();
    assert.equal(state("s2")?.state, "live");
    // A failed attempt also breaks it.
    a.snapshotStatus = { status: 503, body: { ok: false, error: { code: "board-ledger-unavailable" } } };
    clock.now = T0 + 130_000;
    await agg.ingestAll();
    a.snapshotStatus = undefined;
    clock.now = T0 + 160_000;
    await agg.ingestAll();
    clock.now = T0 + 190_000;
    await agg.ingestAll();
    assert.equal(state("s2")?.state, "live");
    clock.now = T0 + 220_000;
    await agg.ingestAll();
    const vanished = state("s2")!;
    assert.equal(vanished.state, "closed");
    assert.equal(vanished.close_reason, "vanished");
    assert.equal(vanished.closed_at, iso(T0 + 160_000));
    assert.equal(vanished.runtime_status, null);
    assert.equal(vanished.messaging_supported, false);
    assert.equal(vanished.title, "Title s2");

    // The same identity reappearing is restored.
    a.records = [record("host-a", "s1"), record("host-a", "s2")];
    clock.now = T0 + 250_000;
    await agg.ingestAll();
    assert.equal(state("s2")?.state, "live");

    // A ledger entry replaces vanished with the ledger reason.
    a.records = [record("host-a", "s1")];
    for (const offset of [280_000, 340_000]) {
      clock.now = T0 + offset;
      await agg.ingestAll();
    }
    assert.equal(state("s2")?.close_reason, "vanished");
    a.ledger.push({ seq: 1, record: closedRecord("host-a", "s2", "deleted", "2030-01-10T00:04:00Z") });
    clock.now = T0 + 370_000;
    await agg.ingestAll();
    assert.equal(state("s2")?.close_reason, "deleted");
    assert.equal(state("s2")?.closed_at, "2030-01-10T00:04:00Z");

    // A ledger entry that lands between the two snapshots prevents vanished.
    a.records = [];
    clock.now = T0 + 400_000;
    await agg.ingestAll();
    a.ledger.push({ seq: 2, record: closedRecord("host-a", "s1", "archived", "2030-01-10T00:06:50Z") });
    clock.now = T0 + 460_000;
    await agg.ingestAll();
    assert.equal(state("s1")?.close_reason, "archived");
  } finally {
    store.close();
    await closeAll(a.server);
  }
});

test("retention prunes old closed rows and unconfigured machines at startup and on demand", async () => {
  const a = await fakeDaemon("host-a");
  const path = freshDb();
  const store = new BoardStore(path);
  store.applyClosed("host-a", [
    closedRecord("host-a", "old", "deleted", iso(T0 - 4 * 24 * 3600_000)),
    closedRecord("host-a", "recent", "deleted", iso(T0 - 2 * 24 * 3600_000)),
  ] as never, "L1:2");
  store.applySnapshot("retired-host", [record("retired-host", "x")] as never, true, T0);
  const clock = { now: T0 };
  const agg = aggregator(store, [a], clock);
  try {
    agg.start();
    await agg.stop();
    assert.deepEqual(store.rows().map((row) => row.session_id), ["recent"]);
    clock.now = T0 + 2 * 24 * 3600_000;
    agg.prune();
    assert.deepEqual(store.rows(), []);
  } finally {
    await agg.stop();
    store.close();
    await closeAll(a.server);
  }
});

test("retention drops open rows only of configured machines unseen for the whole window", () => {
  const store = new BoardStore(freshDb());
  const day = 24 * 3600_000;
  try {
    store.applySnapshot("host-a", [record("host-a", "stale")] as never, true, T0 - 4 * day);
    store.applyClosed("host-a", [closedRecord("host-a", "recent", "deleted", iso(T0 - day))] as never, "L1:1");
    store.applySnapshot("host-b", [record("host-b", "fresh", { state: "stopped", runtime_status: "stopped" })] as never, true, T0 - 2 * day);
    store.prune(T0, 3 * day, ["host-a", "host-b"]);
    assert.deepEqual(store.rows().map((row) => `${row.machine}/${row.session_id}`), ["host-a/recent", "host-b/fresh"]);
  } finally {
    store.close();
  }
});

test("board transport refuses redirects and oversized responses", async () => {
  const target = await fakeDaemon("host-a");
  target.records = [record("host-a", "s1")];
  const redirect = createServer((_req, res) => {
    res.writeHead(302, { location: `${target.url}/board/v1` });
    res.end();
  });
  const huge = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: { padding: "x".repeat(9 * 1024 * 1024) } }));
  });
  const redirectUrl = (await listenOnLoopback(redirect)).base;
  const hugeUrl = (await listenOnLoopback(huge)).base;
  const store = new BoardStore(freshDb());
  const clock = { now: T0 };
  try {
    const agg = new BoardAggregator(store, [
      { name: "host-a", url: redirectUrl, token: "t" },
      { name: "host-b", url: hugeUrl, token: "t" },
    ], { retention: "3d", now: () => clock.now });
    await agg.ingestAll();
    assert.deepEqual(target.hits, []);
    assert.deepEqual(store.machineStatuses(["host-a", "host-b"], clock.now).map((m) => m.available), [false, false]);
    assert.deepEqual(store.rows(), []);
  } finally {
    store.close();
    await closeAll(target.server, redirect, huge);
  }
});

test("board configuration is opt-in with a bounded retention", () => {
  const base = { AGENT_CONSOLE_NO_AUTH: "1" };
  assert.equal(loadConfig(base).board, null);
  assert.deepEqual(loadConfig({ ...base, AGENT_CONSOLE_BOARD_DB: "/var/lib/agent-console/board.sqlite" }).board, {
    dbPath: "/var/lib/agent-console/board.sqlite", retention: "3d",
  });
  assert.equal(loadConfig({ ...base, AGENT_CONSOLE_BOARD_DB: "/x/board.sqlite", AGENT_CONSOLE_BOARD_RETENTION: "1mo" }).board?.retention, "1mo");
  assert.throws(() => loadConfig({ ...base, AGENT_CONSOLE_BOARD_DB: "board.sqlite" }), /absolute/);
  for (const bad of ["32d", "5w", "2mo", "1d", "forever"]) {
    assert.throws(() => parseBoardRetention(bad), /AGENT_CONSOLE_BOARD_RETENTION/);
  }
  assert.equal(parseBoardRetention("7d"), "7d");
  assert.equal(existsSync("/x/board.sqlite"), false, "loading config never creates the store");
});

test("the edge stays healthy when daemons do not expose the board or the store cannot open", async () => {
  const daemon = createServer((req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "board-disabled", message: "board is disabled" } }));
  });
  const daemonUrl = (await listenOnLoopback(daemon)).base;
  const blocker = join(tempRoot, "not-a-directory");
  writeFileSync(blocker, "");
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    for (const dbPath of [freshDb(), join(blocker, "board.sqlite")]) {
      const edge = createEdgeServer(makeEdgeConfig({
        machines: [{ name: "host-a", url: daemonUrl, token: "operator" }],
        board: { dbPath, retention: "3d" },
      }));
      const { base } = await listenOnLoopback(edge);
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      await new Promise<void>((resolve) => { edge.closeAllConnections(); edge.close(() => resolve()); });
    }
  } finally {
    console.error = originalError;
    await closeAll(daemon);
  }
  assert.equal(logged.length, 1, "only the unopenable store is reported, once and without its path");
  assert.equal(JSON.stringify(logged).includes(tempRoot), false);
});


test("board projection preserves bounded model settings and old records remain unknown", () => {
  const projected = projectBoardRecord(record("host-a", "model-settings", { model: "local-model", reasoning_effort: "medium" }), "host-a", "snapshot");
  assert.equal(projected?.model, "local-model");
  assert.equal(projected?.reasoning_effort, "medium");
  const legacy = projectBoardRecord(record("host-a", "legacy-settings"), "host-a", "snapshot");
  assert.equal(legacy?.model, null);
  assert.equal(legacy?.reasoning_effort, null);
});

// #873: the board carries what a reader needs to explain a pending request or
// an unknown state. Every field is optional, so older daemons still project.
test("board turn_state keeps bounded attention and diagnostic detail when present", () => {
  const turn = (extra: Record<string, unknown>, attention: Record<string, unknown> | null) => ({
    phase: attention ? "needs_input" : "unknown", phase_changed_at: "2030-01-01T00:00:00Z",
    current_turn: { last_progress_at: "2030-01-01T00:04:00Z", attention },
    last_turn: null, source: { confidence: "inferred" }, ...extra,
  });
  const pending = projectBoardRecord(record("host-a", "pending", { turn_state: turn({}, {
    kind: "clarification", requested_at: "2030-01-01T00:05:00Z", pending_count: 2, certainty: "conservative",
  }) }), "host-a", "snapshot");
  assert.deepEqual(pending?.turn_state?.current_turn?.attention,
    { kind: "clarification", requested_at: "2030-01-01T00:05:00Z", pending_count: 2, certainty: "conservative" });
  const unknown = projectBoardRecord(record("host-a", "unknown", { turn_state: turn({
    diagnostic: { reason: "completion_evidence_pending", quiet_since: "2030-01-01T00:04:00Z", extra: "dropped" },
  }, null) }), "host-a", "snapshot");
  assert.deepEqual(unknown?.turn_state?.diagnostic, { reason: "completion_evidence_pending", quiet_since: "2030-01-01T00:04:00Z" });
  const legacy = projectBoardRecord(record("host-a", "legacy"), "host-a", "snapshot");
  assert.ok(legacy, "a record without the optional fields still projects");
  assert.equal(legacy?.turn_state?.diagnostic, undefined);
  const malformed = projectBoardRecord(record("host-a", "malformed", { turn_state: turn({ diagnostic: { reason: 7 } }, {
    kind: "approval", requested_at: "2030-01-01T00:05:00Z", pending_count: -1, certainty: "maybe",
  }) }), "host-a", "snapshot");
  assert.ok(malformed, "malformed optional detail is dropped, not fatal");
  assert.equal(malformed?.turn_state?.diagnostic, undefined);
  assert.deepEqual(malformed?.turn_state?.current_turn?.attention, { kind: "approval", requested_at: "2030-01-01T00:05:00Z" });
});
