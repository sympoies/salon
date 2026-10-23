import {
  BOARD_EXTENSIONS,
  BOARD_RECORD_SCHEMA,
  BOARD_RETENTIONS,
  type BoardRecord,
  type BoardRetention,
  type BoardState,
} from "./record.ts";
import type { BoardMachineView, BoardStore, BoardTreeRow } from "./store.ts";
import type { SessionDispatchedBy } from "@agent-console/shared/api";

// The aggregator query (session-board-v1 "Aggregator query contract"): one
// `agent-session.board-view.v1` built from the deployment-wide store. The
// caller's scope arrives as the machine list and an optional record predicate
// (see routes.ts), so storage and retention stay deployment-wide while each
// reader sees only its own part. The daemon relay route and the console UI
// route both serve this object.

export const BOARD_VIEW_SCHEMA = "agent-session.board-view.v1";
const MAX_RECORDS = 1024;
const MAX_FILTER_LENGTH = 512;
const MINUTE_MS = 60_000;
const UNIT_MS: Record<string, number> = {
  m: MINUTE_MS,
  h: 60 * MINUTE_MS,
  d: 24 * 60 * MINUTE_MS,
  w: 7 * 24 * 60 * MINUTE_MS,
  mo: 31 * 24 * 60 * MINUTE_MS,
};
// Any positive count is valid; a window longer than the retention is clamped.
const SINCE = /^([1-9][0-9]*)(mo|m|h|d|w)$/;
const STATES = new Set(["live", "stopped", "closed", "all"]);
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface BoardQuery {
  readonly state: BoardState | "all";
  readonly sinceMs: number | null;
  readonly repo: string | null;
  readonly machine: string | null;
  readonly machines?: readonly string[];
  readonly root: string | null;
}

export interface BoardView {
  readonly ext?: Readonly<Record<string, unknown>>;
  readonly context_records?: BoardView["records"];
  readonly context_truncated?: boolean;
  readonly schema_version: typeof BOARD_VIEW_SCHEMA;
  readonly record_schema: typeof BOARD_RECORD_SCHEMA;
  readonly extensions: typeof BOARD_EXTENSIONS;
  readonly generated_at: string;
  readonly retention: BoardRetention;
  readonly effective_since: string;
  readonly since_capped: boolean;
  readonly machines: readonly BoardMachineView[];
  readonly records: ReadonlyArray<BoardRecord & {
    readonly console_owner?: string | null;
    readonly dispatched_by?: SessionDispatchedBy;
    readonly launched_by?: SessionDispatchedBy;
    readonly coordinator_tree?: { readonly depth: number };
    readonly orphaned?: boolean;
    readonly subtree?: { readonly live: number; readonly stopped: number };
  }>;
  readonly truncated: boolean;
}

export class BoardQueryError extends Error {
  readonly status = 400;
  readonly code = "board-query-invalid";
}

function filterText(value: string): string {
  if (value.length === 0 || value.length > MAX_FILTER_LENGTH || CONTROL.test(value)) {
    throw new BoardQueryError("invalid board filter value");
  }
  return value;
}

/**
 * Parses the five contract filters. Any key outside `filters ∪ extraKeys`, a
 * repeated key, or an invalid value fails with `board-query-invalid`.
 */
export function parseBoardQuery(params: URLSearchParams, extraKeys: readonly string[] = []): BoardQuery {
  const allowed = new Set(["state", "since", "repo", "machine", "machines", "root", ...extraKeys]);
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.has(key)) throw new BoardQueryError("unknown board query parameter");
    if (seen.has(key)) throw new BoardQueryError("repeated board query parameter");
    seen.add(key);
  }
  const state = params.get("state") ?? "all";
  if (!STATES.has(state)) throw new BoardQueryError("invalid board state filter");
  const sinceRaw = params.get("since");
  let sinceMs: number | null = null;
  if (sinceRaw !== null) {
    const match = SINCE.exec(sinceRaw);
    if (!match) throw new BoardQueryError("invalid board since filter");
    // A huge count overflows to Infinity, which the view clamps to retention.
    sinceMs = Number(match[1]) * UNIT_MS[match[2]!]!;
  }
  const repo = params.get("repo");
  const machine = params.get("machine");
  const root = params.get("root");
  const selectedRaw = params.get("machines");
  let selected: string[] | undefined;
  if (selectedRaw !== null) {
    if (machine !== null || selectedRaw.length > 32768) throw new BoardQueryError("invalid board machines filter");
    let value: unknown;
    try { value = JSON.parse(selectedRaw); } catch { throw new BoardQueryError("invalid board machines filter"); }
    if (!Array.isArray(value) || value.length > 256 || value.some(name => typeof name !== "string")) throw new BoardQueryError("invalid board machines filter");
    selected = [...new Set(value.map(name => filterText(name as string)))];
  }
  return {
    state: state as BoardQuery["state"],
    sinceMs,
    repo: repo === null ? null : filterText(repo),
    machine: machine === null ? null : filterText(machine),
    root: root === null ? null : filterText(root),
    ...(selected ? { machines: selected } : {}),
  };
}

export interface BoardViewContext {
  readonly store: BoardStore;
  readonly retention: BoardRetention;
  // The only machines the view mentions: its availability list, and the only
  // machines whose rows it returns.
  readonly machines: readonly string[];
  // Records the reader may see; applied before the record limit and to the
  // rows the lineage.v1 annotations count.
  readonly include?: (record: Pick<BoardRecord, "machine" | "session_id">) => boolean;
  // Machines registered for cross-host messaging. A record reports
  // `messaging_supported` only when its daemon says so and the edge could relay
  // to it, which is the `agent-session.remote-peers.v1` meaning.
  readonly messagingMachines: ReadonlySet<string>;
  // Optional display-only owner label; never an authorization input.
  readonly ownerOf?: (machine: string, sessionId: string) => string | null;
  // Optional display-only dispatcher mark from the access store.
  readonly launcherOf?: (machine: string, sessionId: string) => SessionDispatchedBy | null;
  readonly dispatcherOf?: (machine: string, sessionId: string) => SessionDispatchedBy | null;
  // Optional display-only coordinator tree depth from the access store.
  readonly coordinatorTreeOf?: (machine: string, sessionId: string, repoName: string | null) => { coordinator_tree?: { depth: number } };
  readonly nowMs: number;
  readonly includeAncestorContext?: boolean;
}

const identity = (machine: string, sessionId: string, createdAt?: string): string =>
  JSON.stringify(createdAt === undefined ? [machine, sessionId] : [machine, sessionId, createdAt]);

/**
 * The lineage.v1 aggregator annotations (session-board-v1 "Aggregator
 * annotations"), judged against the rows the reader may see, not only the
 * rows the query's filters return:
 *
 * - `orphaned` on a non-closed record with lineage: its effective parent is a
 *   closed row within retention, or is absent while its machine is available.
 *   A parent on an unavailable or unknown machine, or one the reader does not
 *   own (another principal's, or a session without a grant), is never judged
 *   missing, so the annotation reveals nothing about sessions the reader
 *   cannot see.
 * - `subtree` on a record that is its own root, or a record without lineage
 *   that other rows name as their root: the other live rows of its tree, and
 *   its stopped rows updated within the view's window.
 */
function treeAnnotations(
  treeRows: readonly BoardTreeRow[],
  available: ReadonlySet<string>,
  stoppedSinceMs: number,
  owns: (session: Pick<BoardRecord, "machine" | "session_id">) => boolean,
): (record: BoardRecord) => { orphaned?: boolean; subtree?: { live: number; stopped: number } } {
  const states = new Map<string, BoardTreeRow["state"]>();
  const subtrees = new Map<string, { live: number; stopped: number }>();
  for (const row of treeRows) {
    states.set(identity(row.machine, row.session_id, row.created_at), row.state);
    if (row.state === "closed" || row.root_machine === null || row.root_session_id === null) continue;
    if (row.state === "stopped" && row.updated_ms < stoppedSinceMs) continue;
    if (row.root_machine === row.machine && row.root_session_id === row.session_id) continue;
    const key = identity(row.root_machine, row.root_session_id);
    const counts = subtrees.get(key) ?? { live: 0, stopped: 0 };
    counts[row.state] += 1;
    subtrees.set(key, counts);
  }
  return (record) => {
    const lineage = record.lineage;
    const self = identity(record.machine, record.session_id);
    const isOwnRoot = lineage !== null && lineage.root.machine === record.machine && lineage.root.session_id === record.session_id;
    const subtree = isOwnRoot || (lineage === null && subtrees.has(self))
      ? { subtree: subtrees.get(self) ?? { live: 0, stopped: 0 } }
      : {};
    if (lineage === null || record.state === "closed") return subtree;
    const parent = lineage.effective_parent;
    const parentState = parent && states.get(identity(parent.machine, parent.session_id, parent.session_created_at));
    const orphaned = parent !== null
      && (parentState === "closed"
        || (parentState === undefined && available.has(parent.machine)
          && owns({ machine: parent.machine, session_id: parent.session_id })));
    return { orphaned, ...subtree };
  };
}

export function buildBoardView(context: BoardViewContext, query: BoardQuery): BoardView {
  const retentionMs = BOARD_RETENTIONS[context.retention];
  const requested = query.sinceMs ?? retentionMs;
  const windowMs = Math.min(requested, retentionMs);
  const effectiveSinceMs = context.nowMs - windowMs;
  const names = [...context.machines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const machines = context.store.machineStatuses(names, context.nowMs);
  const availableMachines = machines.filter((machine) => machine.available).map((machine) => machine.machine);
  const rows = context.store.queryRows({
    states: query.state === "all" ? ["live", "stopped", "closed"] : [query.state],
    sinceMs: effectiveSinceMs,
    repo: query.repo,
    machine: query.machine,
    root: query.root,
    availableMachines,
    configuredMachines: names,
    limit: MAX_RECORDS + 1,
    ...((context.include || query.machines) ? { include: (row: Pick<BoardRecord, "machine" | "session_id">) =>
      (context.include?.(row) ?? true) && (query.machines?.includes(row.machine) ?? true) } : {}),
  });
  const include = context.include ?? (() => true);
  const treeRows = context.store.treeRows({
    closedSinceMs: context.nowMs - retentionMs, availableMachines, configuredMachines: names,
  });
  const scopedTree = treeRows.filter((row) => include(row));
  const annotate = treeAnnotations(
    scopedTree,
    new Set(availableMachines),
    effectiveSinceMs,
    include,
  );
  const project = (record: BoardRecord): BoardView["records"][number] => {
    const dispatchedBy = context.dispatcherOf?.(record.machine, record.session_id);
    const launchedBy = context.launcherOf?.(record.machine, record.session_id);
    return {
      ...record,
      messaging_supported: record.messaging_supported && context.messagingMachines.has(record.machine),
      ...(context.ownerOf ? { console_owner: context.ownerOf(record.machine, record.session_id) } : {}),
      ...annotate(record),
      ...(dispatchedBy ? { dispatched_by: dispatchedBy } : {}),
      ...(launchedBy ? { launched_by: launchedBy } : {}),
      ...context.coordinatorTreeOf?.(record.machine, record.session_id, record.repo_name),
    };
  };
  const records = rows.slice(0, MAX_RECORDS).map(project);
  const contextRecords: BoardView["records"][number][] = [];
  let contextTruncated = false;
  if (context.includeAncestorContext) {
    const retainedTree = scopedTree.filter((row) => row.state !== "stopped" || row.updated_ms >= context.nowMs - retentionMs);
    const permitted = new Map(retainedTree.map((row) => [identity(row.machine, row.session_id, row.created_at), row]));
    const byId = new Map<string, BoardTreeRow[]>();
    for (const row of retainedTree) {
      const key = identity(row.machine, row.session_id);
      byId.set(key, [...(byId.get(key) ?? []), row]);
    }
    const seen = new Set(records.map((row) => identity(row.machine, row.session_id, row.created_at)));
    for (const match of records) {
      let row: BoardView["records"][number] | undefined = match;
      while (row) {
        const legacy = !row.lineage && row.dispatched_by
          ? byId.get(identity(row.dispatched_by.machine, row.dispatched_by.session_id)) : undefined;
        const parent = row.lineage?.effective_parent ?? (legacy?.length === 1
          ? { ...legacy[0]!, session_created_at: legacy[0]!.created_at } : null);
        if (!parent) break;
        const key = identity(parent.machine, parent.session_id, parent.session_created_at);
        if (seen.has(key) || !permitted.has(key)) break;
        if (contextRecords.length >= MAX_RECORDS) { contextTruncated = true; break; }
        seen.add(key);
        const stored = context.store.recordForIdentity(parent.machine, parent.session_id, parent.session_created_at);
        row = stored ? project(stored) : undefined;
        if (row) contextRecords.push(row);
      }
    }
  }
  return {
    schema_version: BOARD_VIEW_SCHEMA,
    record_schema: BOARD_RECORD_SCHEMA,
    extensions: BOARD_EXTENSIONS,
    generated_at: new Date(context.nowMs).toISOString(),
    retention: context.retention,
    effective_since: new Date(effectiveSinceMs).toISOString(),
    since_capped: requested > retentionMs,
    machines,
    records,
    ...(contextRecords.length > 0 || contextTruncated ? { context_records: contextRecords, context_truncated: contextTruncated } : {}),
    truncated: rows.length > MAX_RECORDS,
  };
}
