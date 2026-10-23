import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import type { BoardRecord } from "../src/board/record.ts";
import { BoardStore } from "../src/board/store.ts";
import type { EdgeConfig } from "../src/config.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "agent-console-board-query-"));
after(() => rmSync(tempRoot, { recursive: true, force: true }));
let counter = 0;

const NOW = Date.parse("2030-01-10T00:00:00Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

function row(machine: string, id: string, overrides: Partial<Record<keyof BoardRecord, unknown>> = {}): BoardRecord {
  return {
    machine,
    session_id: id,
    session_incarnation: `${id}-inc`,
    messaging_supported: true,
    repo_name: "nils-cli",
    cwd: "~/workspace/nils-cli",
    provider: "claude",
    agent_profile: null,
    title: `private-title-${id}`,
    title_state: null,
    turn_state: null,
    state: "live",
    runtime_status: "running",
    created_at: "2030-01-01T00:00:00Z",
    updated_at: iso(NOW - HOUR),
    closed_at: null,
    close_reason: null,
    summary: null,
    ...overrides,
  } as BoardRecord;
}

function closed(machine: string, id: string, closedAtMs: number, reason = "deleted"): BoardRecord {
  return row(machine, id, {
    state: "closed", runtime_status: null, messaging_supported: false, closed_at: iso(closedAtMs), close_reason: reason,
  });
}

interface Fixture {
  base: string;
  edge: Server;
  cleanup: () => Promise<void>;
}

// tess owns every seeded session except dana's b-live, so tess's scoped view
// exercises the filters; principal scoping itself is boardPrincipalScope.test.ts.
const OWNER_SESSIONS: ReadonlyArray<[string, string]> = [
  ["host-a", "a-live"], ["host-a", "a-newer"], ["host-a", "a-stopped"], ["host-a", "a-old-stopped"],
  ["host-a", "a-closed"], ["host-a", "a-old-closed"], ["host-b", "b-stopped"], ["host-b", "b-closed"],
];

async function fixture(options: {
  board?: boolean;
  seed?: (store: BoardStore) => void;
  retention?: "3d" | "1mo";
  ownerSessions?: ReadonlyArray<[string, string]>;
} = {}): Promise<Fixture> {
  const dir = join(tempRoot, `case-${++counter}`);
  const accessDb = join(dir, "access.sqlite");
  const boardDb = join(dir, "board.sqlite");
  const access = new AccessStore(accessDb);
  access.claimSession({ principalId: "dana", machine: "host-b", sessionId: "b-live", incarnation: "b-live-inc" });
  access.close();
  // One transaction keeps the bulk cases fast.
  const db = new DatabaseSync(accessDb);
  const insert = db.prepare("INSERT INTO session_ownership (machine, session_id, incarnation, principal_id) VALUES (?, ?, ?, 'tess')");
  db.exec("BEGIN");
  for (const [machine, sessionId] of [...OWNER_SESSIONS, ...(options.ownerSessions ?? [])]) insert.run(machine, sessionId, `${sessionId}-inc`);
  db.exec("COMMIT");
  db.close();
  if (options.board !== false) {
    const store = new BoardStore(boardDb);
    // host-a is fresh; host-b was last seen long ago and is unavailable.
    store.applySnapshot("host-b", [
      row("host-b", "b-live"),
      row("host-b", "b-stopped", { state: "stopped", runtime_status: "stopped" }),
    ], true, NOW - 2 * DAY);
    store.applyClosed("host-b", [closed("host-b", "b-closed", NOW - 3 * HOUR, "archived")], "L1:1");
    store.applySnapshot("host-a", [
      row("host-a", "a-live", { updated_at: iso(NOW - 2 * HOUR) }),
      row("host-a", "a-newer", { updated_at: iso(NOW - HOUR), repo_name: "agent-console" }),
      row("host-a", "a-stopped", { state: "stopped", runtime_status: "missing", updated_at: iso(NOW - 2 * DAY) }),
      row("host-a", "a-old-stopped", { state: "stopped", runtime_status: "stopped", updated_at: iso(NOW - 10 * DAY) }),
    ], true, NOW - 10_000);
    store.applyClosed("host-a", [
      closed("host-a", "a-closed", NOW - 30 * 60_000),
      closed("host-a", "a-old-closed", NOW - 5 * DAY),
    ], "L1:2");
    options.seed?.(store);
    store.close();
  }
  const config: EdgeConfig = makeEdgeConfig({
    openAccess: false,
    multiUser: true,
    accessDbPath: accessDb,
    principals: [
      { id: "tess", token: "browser-tess", machines: ["host-a", "host-b"], permissions: ["debug"] },
      { id: "dana", token: "browser-dana", machines: ["host-b"], permissions: [] },
    ],
    machines: [
      { name: "host-b", url: "http://127.0.0.1:9", token: "b-operator" },
      { name: "host-a", url: "http://127.0.0.1:9", token: "a-operator" },
    ],
    coordinationRelays: [{ machine: "host-a", token: "host-a-relay-token", ingress_token: "host-a-ingress-token" }],
    ...(options.board === false ? {} : { board: { dbPath: boardDb, retention: options.retention ?? "3d" } }),
  });
  const edge = createEdgeServer(config, { board: { autoStart: false, now: () => NOW } });
  const { base } = await listenOnLoopback(edge);
  return {
    base,
    edge,
    cleanup: async () => {
      await new Promise<void>((resolve) => { edge.closeAllConnections(); edge.close(() => resolve()); });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface View {
  schema_version: string;
  record_schema: string;
  generated_at: string;
  retention: string;
  effective_since: string;
  since_capped: boolean;
  machines: Array<{ machine: string; available: boolean; last_seen_at: string | null }>;
  records: Array<BoardRecord & { console_owner?: string | null }>;
  truncated: boolean;
}

async function uiBoard(base: string, query = "", token = "browser-tess"): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/board${query}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() };
}

async function relayBoard(base: string, query = "", token = "host-a-relay-token"): Promise<{ status: number; body: any }> {
  const sep = query ? "&" : "";
  const response = await fetch(
    `${base}/api/coordination/board/v1?source_session_id=a-live&source_incarnation=a-live-inc${sep}${query}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return { status: response.status, body: await response.json() };
}

const keys = (view: View): string[] => view.records.map((record) => `${record.machine}/${record.session_id}`);

test("the console route serves the reader's scoped view in the board-view shape", async () => {
  const f = await fixture();
  try {
    const result = await uiBoard(f.base);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    const view = result.body.data.board as View;
    assert.equal(view.schema_version, "agent-session.board-view.v1");
    assert.equal(view.record_schema, "agent-session.board-record.v1");
    assert.equal(view.generated_at, iso(NOW));
    assert.equal(view.retention, "3d");
    assert.equal(view.effective_since, iso(NOW - 3 * DAY));
    assert.equal(view.since_capped, false);
    assert.deepEqual(view.machines, [
      { machine: "host-a", available: true, last_seen_at: iso(NOW - 10_000) },
      { machine: "host-b", available: false, last_seen_at: iso(NOW - 2 * DAY) },
    ]);
    // host-b is unavailable, so only its closed row remains. Rows beyond the
    // retention window are omitted.
    assert.deepEqual(keys(view), [
      "host-a/a-newer", "host-a/a-live", "host-a/a-stopped", "host-a/a-closed", "host-b/b-closed",
    ]);
    assert.equal(view.truncated, false);
    const owners = Object.fromEntries(view.records.map((record) => [record.session_id, record.console_owner]));
    assert.deepEqual(owners, { "a-newer": "tess", "a-live": "tess", "a-stopped": "tess", "a-closed": "tess", "b-closed": "tess" });
    // messaging_supported keeps the peers meaning: only relay-registered machines.
    assert.equal(view.records.find((record) => record.session_id === "a-live")?.messaging_supported, true);
    assert.equal(view.records.find((record) => record.session_id === "b-closed")?.messaging_supported, false);

    // dana may use host-b only, and her one session there is on an unavailable machine.
    const dana = (await uiBoard(f.base, "", "browser-dana")).body.data.board as View;
    assert.deepEqual(dana.machines.map((machine) => machine.machine), ["host-b"]);
    assert.deepEqual(keys(dana), []);
  } finally {
    await f.cleanup();
  }
});

test("state, since, repo, and machine filter the view and since is clamped to retention", async () => {
  const f = await fixture();
  try {
    const cases: Array<[string, string[]]> = [
      ["?state=live", ["host-a/a-newer", "host-a/a-live"]],
      ["?state=stopped", ["host-a/a-stopped"]],
      ["?state=closed", ["host-a/a-closed", "host-b/b-closed"]],
      ["?state=all&since=1h", ["host-a/a-newer", "host-a/a-live", "host-a/a-closed"]],
      ["?since=90m", ["host-a/a-newer", "host-a/a-live", "host-a/a-closed"]],
      ["?repo=agent-console", ["host-a/a-newer"]],
      ["?repo=Agent-Console", []],
      ["?machine=host-b", ["host-b/b-closed"]],
      ["?machine=host-a&state=closed", ["host-a/a-closed"]],
    ];
    for (const [query, expected] of cases) {
      const result = await uiBoard(f.base, query);
      assert.equal(result.status, 200, query);
      assert.deepEqual(keys(result.body.data.board), expected, query);
    }
    const filtered = (await uiBoard(f.base, "?machine=host-a")).body.data.board as View;
    assert.equal(filtered.machines.length, 2, "machines lists every machine of the reader regardless of the filter");

    const capped = (await uiBoard(f.base, "?since=1mo")).body.data.board as View;
    assert.equal(capped.since_capped, true);
    assert.equal(capped.effective_since, iso(NOW - 3 * DAY));
    const exact = (await uiBoard(f.base, "?since=3d")).body.data.board as View;
    assert.equal(exact.since_capped, false);
    const week = (await uiBoard(f.base, "?since=1w")).body.data.board as View;
    assert.equal(week.since_capped, true);
    // An over-long since is clamped, never rejected.
    for (const since of ["1000000m", "99999999999999999999999d"]) {
      const huge = await uiBoard(f.base, `?since=${since}`);
      assert.equal(huge.status, 200, since);
      assert.equal(huge.body.data.board.since_capped, true, since);
      assert.equal(huge.body.data.board.effective_since, iso(NOW - 3 * DAY), since);
    }
  } finally {
    await f.cleanup();
  }
});

// lineage.v1 (nils-cli#2071): a coordinator tree on available host-a.
const CREATED = "2030-01-01T00:00:00Z";
const ref = (id: string, machine = "host-a") => ({ machine, session_id: id, session_created_at: CREATED });
function treeLineage(id: string, parent: string | null, root: string, depth: number, parentMachine = "host-a") {
  return {
    parent: parent === null ? null : ref(parent, parentMachine),
    effective_parent: parent === null ? null : ref(parent, parentMachine),
    root: ref(root),
    depth,
    starter: parent === null ? { kind: "operator", via: "console" } : { kind: "session", via: "console" },
    budget: null,
  };
}
// "ghost" is tess's session that is gone from the store; dana owns
// "dana-kid" and "dana-steward" on host-a.
const TREE_SESSIONS: ReadonlyArray<[string, string]> = [
  ...[
    "boss", "boss2", "kid", "grand", "grand2", "old-grand", "solo", "solo-kid", "remote-kid", "gone-kid", "legacy",
    "adopted-kid", "b-orphan", "ghost",
  ].map((id): [string, string] => ["host-a", id]),
  ["host-b", "b-parent"],
];
function seedTree(store: BoardStore): void {
  store.applySnapshot("host-a", [
    row("host-a", "a-live"),
    row("host-a", "boss", { role: "coordinator", lineage: treeLineage("boss", null, "boss", 0) }),
    row("host-a", "boss2", { role: "coordinator", lineage: treeLineage("boss2", null, "boss2", 0) }),
    row("host-a", "grand", { lineage: treeLineage("grand", "kid", "boss", 2) }),
    row("host-a", "grand2", { state: "stopped", runtime_status: "stopped", lineage: treeLineage("grand2", "kid", "boss", 2) }),
    row("host-a", "solo", { lineage: treeLineage("solo", null, "solo", 0) }),
    row("host-a", "solo-kid", { lineage: treeLineage("solo-kid", "solo", "solo", 1) }),
    row("host-a", "remote-kid", { lineage: treeLineage("remote-kid", "b-x", "boss", 2, "host-b") }),
    row("host-a", "gone-kid", { lineage: treeLineage("gone-kid", "ghost", "boss", 2) }),
    row("host-a", "legacy"),
    row("host-a", "old-grand", {
      state: "stopped", runtime_status: "stopped", updated_at: iso(NOW - 2 * DAY), lineage: treeLineage("old-grand", "kid", "boss", 2),
    }),
    row("host-a", "dana-kid", { lineage: treeLineage("dana-kid", "boss", "boss", 1) }),
    row("host-a", "dana-steward"),
    row("host-a", "adopted-kid", { lineage: { ...treeLineage("adopted-kid", "boss", "boss", 1), effective_parent: ref("dana-steward") } }),
    row("host-a", "b-orphan", { lineage: treeLineage("b-orphan", "b-parent", "boss", 2, "host-b") }),
  ], true, NOW - 5_000);
  store.applyClosed("host-a", [
    { ...closed("host-a", "kid", NOW - HOUR), lineage: treeLineage("kid", "boss", "boss", 1) },
  ], "L1:3");
  // host-b is unavailable; its closed row is still known within retention.
  store.applyClosed("host-b", [closed("host-b", "b-parent", NOW - 2 * HOUR)], "L1:4");
}

test("lineage.v1: the view carries role, lineage, and work, the root filter, and tree annotations", async () => {
  const f = await fixture({ seed: seedTree, ownerSessions: TREE_SESSIONS });
  try {
    const view = (await uiBoard(f.base)).body.data.board as View & { extensions: string[] };
    assert.deepEqual(view.extensions, ["lineage.v1", "work.v1"]);
    const byId = new Map(view.records.map((record) => [record.session_id, record as any]));
    for (const record of view.records) {
      for (const key of ["role", "lineage", "work"]) assert.ok(key in record, `${record.session_id} has ${key}`);
    }
    // Coordinators, and a --no-parent root that is not one.
    assert.equal(byId.get("boss").role, "coordinator");
    assert.equal(byId.get("boss2").role, "coordinator", "two coordinators at once");
    assert.equal(byId.get("solo").role, null);
    assert.equal(byId.get("solo").lineage.depth, 0);
    // orphaned: a closed or missing effective parent on an available machine.
    assert.equal(byId.get("grand").orphaned, true, "its parent kid is closed");
    assert.equal(byId.get("grand2").orphaned, true);
    assert.equal(byId.get("gone-kid").orphaned, true, "its parent is absent from its available machine");
    assert.equal(byId.get("b-orphan").orphaned, true, "its parent closed, even on a machine that is now unavailable");
    assert.equal(byId.get("adopted-kid").orphaned, false, "a live steward the reader does not own is never judged missing");
    assert.equal(byId.has("dana-kid"), false);
    assert.equal(byId.get("solo-kid").orphaned, false);
    assert.equal(byId.get("remote-kid").orphaned, false, "a parent on an unavailable machine is not judged missing");
    assert.equal(byId.get("boss").orphaned, false, "a root has no effective parent");
    assert.equal("orphaned" in byId.get("legacy"), false, "a record without lineage is not annotated");
    assert.equal("orphaned" in byId.get("kid"), false, "a closed record is not annotated");
    // subtree: other non-closed records of each root's tree.
    // grand, remote-kid, gone-kid, adopted-kid, b-orphan; grand2, old-grand.
    // dana's child in the same tree is not counted for tess.
    assert.deepEqual(byId.get("boss").subtree, { live: 5, stopped: 2 });
    assert.deepEqual(byId.get("boss2").subtree, { live: 0, stopped: 0 });
    assert.deepEqual(byId.get("solo").subtree, { live: 1, stopped: 0 });
    for (const id of ["grand", "solo-kid", "legacy", "kid"]) assert.equal("subtree" in byId.get(id), false, id);

    const tree = (await uiBoard(f.base, "?root=boss")).body.data.board as View;
    assert.deepEqual(keys(tree).sort(), [
      "host-a/adopted-kid", "host-a/b-orphan", "host-a/boss", "host-a/gone-kid", "host-a/grand", "host-a/grand2",
      "host-a/kid", "host-a/old-grand", "host-a/remote-kid",
    ], "the root filter keeps the root and every record naming it, closed ones too");
    // A shorter window narrows the stopped subtree count but not the orphan judgement.
    const recent = new Map(((await uiBoard(f.base, "?since=1d")).body.data.board as View).records.map((record) => [record.session_id, record as any]));
    assert.deepEqual(recent.get("boss").subtree, { live: 5, stopped: 1 });
    const narrow = new Map(((await uiBoard(f.base, "?since=1h")).body.data.board as View).records.map((record) => [record.session_id, record as any]));
    assert.equal(narrow.get("b-orphan").orphaned, true, "a parent closed before the window is still judged within retention");
    const relay = await relayBoard(f.base, "root=solo");
    assert.equal(relay.status, 200);
    assert.deepEqual(keys(relay.body).sort(), ["host-a/solo", "host-a/solo-kid"]);
    const invalid = await uiBoard(f.base, "?root=");
    assert.equal(invalid.status, 400);
  } finally {
    await f.cleanup();
  }
});

test("messaging_supported is true only on machines the edge can relay to", async () => {
  // host-b is configured without a coordination relay; make it available.
  const f = await fixture({ seed: (store) => store.applySnapshot("host-b", [row("host-b", "b-live")], true, NOW - 10_000) });
  try {
    const view = (await uiBoard(f.base, "?state=live")).body.data.board as View;
    const supported = Object.fromEntries(view.records.map((record) => [`${record.machine}/${record.session_id}`, record.messaging_supported]));
    assert.deepEqual(supported, { "host-a/a-newer": true, "host-a/a-live": true });
    const dana = (await uiBoard(f.base, "?state=live", "browser-dana")).body.data.board as View;
    assert.deepEqual(dana.records.map((record) => [record.session_id, record.messaging_supported, record.console_owner]), [
      ["b-live", false, "dana"],
    ]);
  } finally {
    await f.cleanup();
  }
});

test("a longer configured retention widens the default window", async () => {
  const f = await fixture({ retention: "1mo" });
  try {
    const view = (await uiBoard(f.base)).body.data.board as View;
    assert.equal(view.retention, "1mo");
    assert.equal(view.effective_since, iso(NOW - 31 * DAY));
    assert.ok(keys(view).includes("host-a/a-old-stopped"));
    assert.ok(keys(view).includes("host-a/a-old-closed"));
    assert.equal(((await uiBoard(f.base, "?since=1mo")).body.data.board as View).since_capped, false);
  } finally {
    await f.cleanup();
  }
});

test("invalid board queries fail with board-query-invalid on both routes", async () => {
  const f = await fixture();
  try {
    for (const query of [
      "?state=open", "?state=live&state=closed", "?since=0d", "?since=3x", "?since=3D", "?since=-1d", "?since=",
      "?repo=", "?machine=", "?principal=tess", "?since=1d&since=2d",
    ]) {
      const result = await uiBoard(f.base, query);
      assert.equal(result.status, 400, query);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.error.code, "board-query-invalid", query);
      assert.equal(typeof result.body.error.message, "string");
      const relay = await relayBoard(f.base, query.slice(1));
      assert.equal(relay.status, 400, `relay ${query}`);
      assert.equal(relay.body.error.code, "board-query-invalid", `relay ${query}`);
    }
  } finally {
    await f.cleanup();
  }
});

test("the relay route authenticates relay credentials and returns the raw view", async () => {
  const f = await fixture();
  try {
    const result = await relayBoard(f.base, "state=live");
    assert.equal(result.status, 200);
    assert.equal(result.body.schema_version, "agent-session.board-view.v1");
    assert.deepEqual(keys(result.body as View), ["host-a/a-newer", "host-a/a-live"]);

    for (const token of ["", "browser-tess", "a-operator", "host-a-ingress-token"]) {
      const denied = await relayBoard(f.base, "", token);
      assert.equal(denied.status, 401, `token ${token || "(none)"}`);
    }
    const missingSource = await fetch(`${f.base}/api/coordination/board/v1`, {
      headers: { authorization: "Bearer host-a-relay-token" },
    });
    assert.equal(missingSource.status, 400);
    assert.equal(((await missingSource.json()) as any).error.code, "board-query-invalid");
  } finally {
    await f.cleanup();
  }
});

test("the view is bounded to 1024 records and reports truncation", async () => {
  const bulk = Array.from({ length: 1030 }, (_, index) => `bulk-${String(index).padStart(4, "0")}`);
  const f = await fixture({
    ownerSessions: bulk.map((id) => ["host-a", id] as [string, string]),
    seed: (store) => store.applySnapshot(
      "host-a",
      bulk.map((id) => row("host-a", id)),
      true,
      NOW - 10_000,
    ),
  });
  try {
    const view = (await uiBoard(f.base, "?state=live")).body.data.board as View;
    assert.equal(view.records.length, 1024);
    assert.equal(view.truncated, true);
    // Equal updated_at: machine then session_id ascending.
    assert.deepEqual(view.records.slice(0, 3).map((record) => record.session_id), ["a-newer", "bulk-0000", "bulk-0001"]);
  } finally {
    await f.cleanup();
  }
});

test("the capability and routes follow board enablement", async () => {
  const on = await fixture();
  const off = await fixture({ board: false });
  try {
    const sessions = async (base: string) => {
      const response = await fetch(`${base}/api/sessions`, { headers: { authorization: "Bearer browser-tess" } });
      return (await response.json() as { data: { capabilities: Record<string, unknown> } }).data.capabilities;
    };
    assert.equal((await sessions(on.base)).session_board, true);
    assert.equal((await sessions(off.base)).session_board, undefined);
    const ui = await uiBoard(off.base);
    assert.equal(ui.status, 404);
    assert.equal(ui.body.error.code, "board-disabled");
    const relay = await relayBoard(off.base);
    assert.equal(relay.status, 404);
    assert.equal(relay.body.error.code, "board-disabled");
  } finally {
    await on.cleanup();
    await off.cleanup();
  }
});

test("board rows never enter the browser debug ring", async () => {
  const f = await fixture();
  try {
    await uiBoard(f.base, "", "browser-tess");
    await uiBoard(f.base, "?repo=private-repo-filter", "browser-tess");
    await relayBoard(f.base);
    const debug = await (await fetch(`${f.base}/api/debug/events`, { headers: { authorization: "Bearer browser-tess" } })).text();
    for (const value of ["private-title-", "~/Project", "private-repo-filter", "host-a-relay-token", "/api/coordination/"]) {
      assert.equal(debug.includes(value), false, value);
    }
  } finally {
    await f.cleanup();
  }
});

test("redesign host selection scopes Board matches before its cap and never broadens grants", async () => {
  const f = await fixture({ seed: store => store.applyClosed("host-a", Array.from({ length: 1100 }, (_, i) => closed("host-a", `bulk-${i}`, NOW - i * 1000)), "bulk"),
    ownerSessions: Array.from({ length: 1100 }, (_, i) => ["host-a", `bulk-${i}`] as [string, string]) });
  try {
    const query = (machines: string[]) => `?machines=${encodeURIComponent(JSON.stringify(machines))}`;
    const empty = await uiBoard(f.base, query([]));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data.board.records, []);
    const selected = await uiBoard(f.base, query(["host-b"]));
    assert.equal(selected.status, 200);
    assert.deepEqual(keys(selected.body.data.board), ["host-b/b-closed"]);
    assert.equal(selected.body.data.board.truncated, false);
    const otherPrincipal = await uiBoard(f.base, query(["host-a"]), "browser-dana");
    assert.equal(otherPrincipal.status, 200);
    assert.deepEqual(otherPrincipal.body.data.board.records, []);
  } finally { await f.cleanup(); }
});
