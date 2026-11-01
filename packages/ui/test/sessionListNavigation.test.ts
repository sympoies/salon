type SessionOrchestration = Record<string, any>;
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sortByDefaultSessionOrder } from "../src/format.ts";
import type { Session } from "../src/types.ts";
import { makeSession } from "./support/fixtures.ts";

interface SessionListGroupOption {
  readonly runId: string;
  readonly ordinal: number;
  readonly mainSessionKey: string;
  readonly agent: string;
  readonly title: string;
  readonly workerSummary: string | null;
}

interface SessionListPage {
  readonly page: number | null;
  readonly pageCount: number;
  readonly sessionKeys: readonly string[];
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

interface SessionListNavigationModule {
  deriveSessionListGroupOptions(sessions: readonly Session[]): SessionListGroupOption[];
  filterSessionListSessions(input: {
    readonly sessions: readonly Session[];
    readonly selectedRunId: string | null;
    readonly showSubagents: boolean;
    readonly machine?: string | null;
    readonly harness?: string | null;
  }): Session[];
  deriveSessionListChoiceCounts(input: {
    readonly sessions: readonly Session[];
    readonly selectedRunId: string | null;
    readonly showSubagents: boolean;
    readonly machine?: string | null;
    readonly harness?: string | null;
    readonly control?: boolean;
  }): {
    readonly machines: { readonly all: number; readonly by: Readonly<Record<string, number>> };
    readonly harnesses: { readonly all: number; readonly by: Readonly<Record<string, number>> };
    readonly dispatcher: { readonly all: number; readonly by: Readonly<Record<string, number>> };
    readonly groups: { readonly all: number; readonly by: Readonly<Record<string, number>> };
  };
  orderSessionListSessions(input: {
    readonly sessions: readonly Session[];
    readonly preferredSessionKeys: readonly string[];
  }): Session[];
  reorderProjectedSessionKeys(input: {
    readonly orderedSessionKeys: readonly string[];
    readonly pageSessionKeys: readonly string[];
    readonly fromIndex: number;
    readonly toIndex: number;
  }): string[];
  paginateSessionList(input: {
    readonly sessions: readonly Session[];
    readonly requestedPage: number;
    readonly pageSize: number;
  }): SessionListPage;
  stepSessionListPage(input: {
    readonly page: number;
    readonly pageCount: number;
    readonly direction: -1 | 1;
  }): number;
  resolveSelectedSessionListRunId(input: {
    readonly selectedRunId: string | null;
    readonly groups: readonly SessionListGroupOption[];
  }): string | null;
  resolveOverviewPromptTargetForPage(input: {
    readonly promptTargetKey: string | null;
    readonly pageSessionKeys: readonly string[];
  }): string | null;
  resolveSessionListPageSize(input: {
    readonly mobile: boolean;
    readonly slotCount: number;
    readonly resultCount: number;
  }): number;
  resolveOverviewSessionListPageSize(input: {
    readonly mobile: boolean;
    readonly autoLayout: boolean;
    readonly fixedSlotCount: number;
    readonly resultCount: number;
  }): number;
  resolveOverviewDesktopMode(input: {
    readonly autoLayout: boolean;
    readonly fixedSlotCount: 1 | 2 | 3 | 4 | 6;
    readonly pageSessionCount: number;
  }): 1 | 2 | 3 | 4 | 6;
}

function orchestration(
  runId: string,
  role: "main" | "worker",
  overrides: Partial<SessionOrchestration> = {},
): SessionOrchestration {
  return {
    schema_version: "agent-session.session-orchestration.v1",
    run_id: runId,
    role,
    relationship_revision: 1,
    run_state: "active",
    objective_summary: `Deliver ${runId}`,
    ...(role === "worker"
      ? {
          assignment_id: `assignment-${runId}`,
          assignment_state: "working" as const,
          primary_manager: {
            session_id: `main-${runId}`,
            session_incarnation: `inc-main-${runId}`,
            session_created_at: "2026-07-23T00:00:00Z",
          },
        }
      : {}),
    ...overrides,
  };
}

function main(
  runId: string,
  title: string,
  overrides: Partial<SessionOrchestration> = {},
): Session {
  return makeSession({
    id: `main-${runId}`,
    title,
    session_incarnation: `inc-main-${runId}`,
    created_at: "2026-07-23T00:00:00Z",
    orchestration: orchestration(runId, "main", overrides),
  });
}

function worker(runId: string, id: string, state: "working" | "submitted" = "working"): Session {
  return makeSession({
    id,
    title: `Worker ${id}`,
    orchestration: orchestration(runId, "worker", {
      assignment_id: `assignment-${id}`,
      assignment_state: state,
    }),
  });
}

const mainAlpha = main("run-alpha", "Alpha delivery", {
  worker_counts: {
    assigned: 0,
    starting: 0,
    working: 1,
    blocked: 0,
    submitted: 1,
    accepted: 0,
    cleanup_pending: 0,
    orphaned: 0,
  },
});
const workerAlphaWorking = worker("run-alpha", "worker-alpha-working");
const workerAlphaSubmitted = worker("run-alpha", "worker-alpha-submitted", "submitted");
const mainBeta = main("run-beta", "Beta delivery");
const workerBeta = worker("run-beta", "worker-beta");
const standalone = makeSession({ id: "standalone", title: "Standalone session" });
const orphanedWorker = worker("run-orphaned", "worker-orphaned");

const orderedFixture = [
  mainAlpha,
  workerAlphaWorking,
  workerAlphaSubmitted,
  mainBeta,
  workerBeta,
  standalone,
  orphanedWorker,
];

function keys(sessions: readonly Session[]): string[] {
  return sessions.map((session) => `${session.machine}/${session.id}`);
}

async function loadNavigation(): Promise<SessionListNavigationModule> {
  const moduleUrl = new URL("../src/sessionListNavigation.ts", import.meta.url).href;
  const navigation = await import(moduleUrl).catch(() => null) as SessionListNavigationModule | null;
  assert.ok(
    navigation,
    "sessionListNavigation.ts should define the overview group/filter/page contract",
  );
  return navigation;
}

test("host and harness filters intersect before pagination and exclude other sessions", async () => {
  const { filterSessionListSessions, paginateSessionList } = await loadNavigation();
  const sessions = [
    makeSession({ id: "local-codex", machine: "host-a", agent: "codex" }),
    makeSession({ id: "remote-codex", machine: "host-b", agent: "codex" }),
    makeSession({ id: "local-claude", machine: "host-a", agent: "claude" }),
  ];
  const filtered = filterSessionListSessions({
    sessions, selectedRunId: null, showSubagents: false,
    machine: "host-a", harness: "codex",
  });
  assert.deepEqual(keys(filtered), ["host-a/local-codex"]);
  assert.equal(paginateSessionList({ sessions: filtered, requestedPage: 2, pageSize: 1 }).pageCount, 1);
});

test("old-daemon dsh sessions use raw unknown-agent navigation and filters", async () => {
  const { deriveSessionListHarnessOptions, filterSessionListSessions, paginateSessionList } = await import("../src/sessionListNavigation.ts");
  const { CLEAR_SESSION_FILTERS, filterRecords } = await import("../src/sessionFilters.ts");
  const session = makeSession({ id: "retired", agent: "dsh", machine: "host-a" });
  const sessions = [makeSession({ id: "current", agent: "codex", machine: "host-a" }), session];
  assert.deepEqual(deriveSessionListHarnessOptions(sessions), [{ id: "codex", label: "Codex" }, { id: "dsh", label: "dsh" }]);
  const filtered = filterSessionListSessions({ sessions, harness: "dsh" });
  assert.deepEqual(filtered, [session]);
  assert.deepEqual(paginateSessionList({ sessions: filtered, requestedPage: 1, pageSize: 1 }).sessionKeys, ["host-a/retired"]);
  const row = { ...session, session_id: session.id, provider: session.agent };
  assert.deepEqual(filterRecords([row], { ...CLEAR_SESSION_FILTERS, harnesses: ["dsh"] }), [row]);
  assert.deepEqual(filterRecords([row], { ...CLEAR_SESSION_FILTERS, harnesses: ["codex"] }), []);
});

test("preferred full layout order survives page-sized projections and appends new sessions", async () => {
  const { orderSessionListSessions } = await loadNavigation();
  const sessions = [
    makeSession({ id: "a" }),
    makeSession({ id: "b" }),
    makeSession({ id: "c" }),
    makeSession({ id: "d" }),
    makeSession({ id: "new" }),
  ];

  assert.deepEqual(
    keys(orderSessionListSessions({
      sessions,
      preferredSessionKeys: [
        "summit/c",
        "summit/a",
        "summit/d",
        "summit/b",
      ],
    })),
    [
      "summit/c",
      "summit/a",
      "summit/d",
      "summit/b",
      "summit/new",
    ],
  );
});

test("projected page reorder swaps only visible keys in the complete layout order", async () => {
  const { reorderProjectedSessionKeys } = await loadNavigation();
  const orderedSessionKeys = [
    "summit/hidden-a",
    "summit/visible-a",
    "summit/hidden-b",
    "summit/visible-b",
    "summit/visible-c",
    "summit/hidden-c",
  ];

  assert.deepEqual(reorderProjectedSessionKeys({
    orderedSessionKeys,
    pageSessionKeys: [
      "summit/visible-a",
      "summit/visible-b",
      "summit/visible-c",
    ],
    fromIndex: 0,
    toIndex: 2,
  }), [
    "summit/hidden-a",
    "summit/visible-c",
    "summit/hidden-b",
    "summit/visible-b",
    "summit/visible-a",
    "summit/hidden-c",
  ]);

  assert.deepEqual(reorderProjectedSessionKeys({
    orderedSessionKeys,
    pageSessionKeys: ["summit/missing", "summit/visible-b"],
    fromIndex: 0,
    toIndex: 1,
  }), orderedSessionKeys);
});

test("pagination counts after filtering and returns the requested page slice", async () => {
  const {
    filterSessionListSessions,
    paginateSessionList,
  } = await loadNavigation();
  const sessions = Array.from({ length: 9 }, (_, index) => main(
    `run-${index + 1}`,
    `Main ${index + 1}`,
  ));
  const filtered = filterSessionListSessions({
    sessions,
    selectedRunId: null,
    showSubagents: false,
  });

  assert.deepEqual(paginateSessionList({
    sessions: filtered,
    requestedPage: 2,
    pageSize: 4,
  }), {
    page: 2,
    pageCount: 3,
    sessionKeys: [
      "summit/main-run-5",
      "summit/main-run-6",
      "summit/main-run-7",
      "summit/main-run-8",
    ],
    hasPrevious: true,
    hasNext: true,
  });
});

test("pagination clamps an invalid page after reconciliation shrinks the result", async () => {
  const { paginateSessionList } = await loadNavigation();
  const sessions = Array.from({ length: 5 }, (_, index) => makeSession({ id: `s-${index + 1}` }));

  assert.deepEqual(paginateSessionList({
    sessions,
    requestedPage: 99,
    pageSize: 4,
  }), {
    page: 2,
    pageCount: 2,
    sessionKeys: ["summit/s-5"],
    hasPrevious: true,
    hasNext: false,
  });
});

test("empty pagination has no current page and never creates Page 0 of 0", async () => {
  const { paginateSessionList } = await loadNavigation();

  assert.deepEqual(paginateSessionList({
    sessions: [],
    requestedPage: 1,
    pageSize: 4,
  }), {
    page: null,
    pageCount: 0,
    sessionKeys: [],
    hasPrevious: false,
    hasNext: false,
  });
});

test("page stepping cycles past both boundaries", async () => {
  const { stepSessionListPage } = await loadNavigation();

  assert.equal(stepSessionListPage({ page: 1, pageCount: 4, direction: -1 }), 4);
  assert.equal(stepSessionListPage({ page: 1, pageCount: 4, direction: 1 }), 2);
  assert.equal(stepSessionListPage({ page: 4, pageCount: 4, direction: 1 }), 1);
  assert.equal(stepSessionListPage({ page: 4, pageCount: 4, direction: -1 }), 3);
  // A single page has nowhere to cycle to, and out-of-range state stays sane.
  assert.equal(stepSessionListPage({ page: 1, pageCount: 1, direction: 1 }), 1);
  assert.equal(stepSessionListPage({ page: 1, pageCount: 1, direction: -1 }), 1);
  assert.equal(stepSessionListPage({ page: 0, pageCount: 3, direction: -1 }), 3);
  assert.equal(stepSessionListPage({ page: 9, pageCount: 3, direction: 1 }), 1);
  assert.equal(stepSessionListPage({ page: 2, pageCount: 0, direction: 1 }), 1);
});

test("an overview prompt target is cleared when it is not on the new page", async () => {
  const { resolveOverviewPromptTargetForPage } = await loadNavigation();

  assert.equal(resolveOverviewPromptTargetForPage({
    promptTargetKey: "summit/s-1",
    pageSessionKeys: ["summit/s-5", "summit/s-6"],
  }), null);
  assert.equal(resolveOverviewPromptTargetForPage({
    promptTargetKey: "summit/s-5",
    pageSessionKeys: ["summit/s-5", "summit/s-6"],
  }), "summit/s-5");
  assert.equal(resolveOverviewPromptTargetForPage({
    promptTargetKey: null,
    pageSessionKeys: ["summit/s-5", "summit/s-6"],
  }), null);
});

test("desktop page size follows grid capacity while mobile keeps every card in one list", async () => {
  const { resolveSessionListPageSize } = await loadNavigation();

  assert.equal(resolveSessionListPageSize({ mobile: false, slotCount: 6, resultCount: 12 }), 6);
  assert.equal(resolveSessionListPageSize({ mobile: false, slotCount: 2, resultCount: 12 }), 2);
  assert.equal(resolveSessionListPageSize({ mobile: true, slotCount: 1, resultCount: 12 }), 12);
  assert.equal(resolveSessionListPageSize({ mobile: true, slotCount: 4, resultCount: 3 }), 3);
  assert.equal(resolveSessionListPageSize({ mobile: true, slotCount: 4, resultCount: 0 }), 1);
});

test("Auto desktop capacity follows page mode while mobile keeps the full filtered result", async () => {
  const {
    resolveOverviewDesktopMode,
    resolveOverviewSessionListPageSize,
  } = await loadNavigation();

  assert.equal(resolveOverviewSessionListPageSize({
    mobile: false,
    autoLayout: true,
    fixedSlotCount: 6,
    resultCount: 2,
  }), 2);
  assert.equal(resolveOverviewSessionListPageSize({
    mobile: false,
    autoLayout: true,
    fixedSlotCount: 2,
    resultCount: 9,
  }), 6);
  assert.equal(resolveOverviewSessionListPageSize({
    mobile: false,
    autoLayout: false,
    fixedSlotCount: 3,
    resultCount: 9,
  }), 3);
  assert.equal(resolveOverviewSessionListPageSize({
    mobile: true,
    autoLayout: true,
    fixedSlotCount: 6,
    resultCount: 9,
  }), 9);

  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((pageSessionCount) => resolveOverviewDesktopMode({
      autoLayout: true,
      fixedSlotCount: 6,
      pageSessionCount,
    })),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(resolveOverviewDesktopMode({
    autoLayout: false,
    fixedSlotCount: 3,
    pageSessionCount: 1,
  }), 3);
});

test("the helper never leaks sessions absent from the already machine-filtered input", async () => {
  const {
    filterSessionListSessions,
  } = await loadNavigation();
  const machineFiltered = [
    makeSession({ ...mainAlpha, machine: "mesa" }),
    makeSession({ ...workerAlphaWorking, machine: "mesa" }),
  ];

  assert.deepEqual(
    filterSessionListSessions({
      sessions: machineFiltered,
      selectedRunId: "run-alpha",
      showSubagents: false,
    }).map((session) => session.machine),
    ["mesa", "mesa"],
  );
});

const countFixture = [
  makeSession({ id: "a1", machine: "host-a", agent: "codex", repo_name: "control", coordinator_tree: { depth: 0 } }),
  makeSession({ id: "a2", machine: "host-a", agent: "claude", dispatched_by: { repo_name: "control" } as Session["dispatched_by"], coordinator_tree: { depth: 1 } }),
  makeSession({ id: "a3", machine: "host-a", agent: "codex" }),
  makeSession({ id: "b1", machine: "host-b", agent: "codex", dispatched_by: { repo_name: "control" } as Session["dispatched_by"], coordinator_tree: { depth: 1 } }),
  makeSession({ id: "b2", machine: "host-b", agent: "claude" }),
  { ...mainAlpha, machine: "host-a", agent: "claude" },
  { ...workerAlphaWorking, machine: "host-b", agent: "codex" },
];

test("choice counts with no filter match what each choice would list", async () => {
  const { deriveSessionListChoiceCounts, filterSessionListSessions } = await loadNavigation();
  const base = { sessions: countFixture, selectedRunId: null, showSubagents: false };
  const counts = deriveSessionListChoiceCounts(base);
  // Legacy orchestration extras do not hide any sessions.
  assert.equal(counts.machines.all, 7);
  assert.deepEqual(counts.machines.by, { "host-a": 4, "host-b": 3 });
  assert.deepEqual(counts.harnesses.by, { codex: 4, claude: 3 });
  assert.deepEqual(counts.dispatcher.by, { coordinatorTrees: 3 });
  for (const machine of ["host-a", "host-b"]) {
    assert.equal(counts.machines.by[machine], filterSessionListSessions({ ...base, machine }).length);
  }
});

test("each dimension's counts honor the other active filters but not its own", async () => {
  const { deriveSessionListChoiceCounts } = await loadNavigation();
  const counts = deriveSessionListChoiceCounts({
    sessions: countFixture, selectedRunId: null, showSubagents: false,
    machine: "host-a", harness: "codex", coordinatorTrees: false,
  });
  // Hosts: harness=codex only, so the host filter itself is ignored.
  assert.deepEqual(counts.machines.by, { "host-a": 2, "host-b": 2 });
  assert.equal(counts.machines.all, 4);
  // Harnesses: host-a only.
  assert.deepEqual(counts.harnesses.by, { codex: 2, claude: 2 });
  assert.equal(counts.harnesses.all, 4);
  // Dispatcher: host-a + codex.
  assert.equal(counts.dispatcher.all, 2);
  assert.deepEqual(counts.dispatcher.by, { coordinatorTrees: 1 });
});

test("a control filter narrows the other dimensions and leaves zero-match choices at 0", async () => {
  const { deriveSessionListChoiceCounts } = await loadNavigation();
  const counts = deriveSessionListChoiceCounts({
    sessions: countFixture, selectedRunId: null, showSubagents: false,
    machine: "host-b", coordinatorTrees: true,
  });
  assert.deepEqual(counts.harnesses.by, { codex: 1, claude: 0 });
  assert.deepEqual(counts.machines.by, { "host-a": 2, "host-b": 1 });
});

test("choice counts follow a live session list update", async () => {
  const { deriveSessionListChoiceCounts } = await loadNavigation();
  const base = { selectedRunId: null, showSubagents: false };
  const before = deriveSessionListChoiceCounts({ ...base, sessions: countFixture });
  const after = deriveSessionListChoiceCounts({
    ...base,
    sessions: [...countFixture, makeSession({ id: "c1", machine: "host-c", agent: "codex" })],
  });
  assert.equal(after.machines.all, before.machines.all + 1);
  assert.equal(after.machines.by["host-c"], 1);
});

test("retired orchestration fields cannot hide ordinary sessions or select a stale run", async () => {
  const { filterSessionListSessions } = await loadNavigation();
  assert.deepEqual(keys(filterSessionListSessions({ sessions: orderedFixture, selectedRunId: "retired-run", showSubagents: false })), keys(orderedFixture));
});
