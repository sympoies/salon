import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { boardTimestampMs, withBoardExtensionDefaults, type BoardRecord } from "./record.ts";

// board.sqlite: rebuildable observation data for the session board, kept apart
// from access.sqlite (authority). Deleting the file is a safe reset: the next
// start recreates it from empty and ingestion refills it from the daemons.

// Ordered, append-only migrations. `PRAGMA user_version` records how many have
// been applied, so reopening an up-to-date file is a no-op.
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE board_machine (
    machine TEXT PRIMARY KEY,
    closed_cursor TEXT,
    last_seen_ms INTEGER,
    last_attempt_ok INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE TABLE board_record (
    machine TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('live', 'stopped', 'closed')),
    repo_name TEXT,
    updated_ms INTEGER NOT NULL,
    closed_ms INTEGER,
    missing_since_ms INTEGER,
    record_json TEXT NOT NULL,
    PRIMARY KEY (machine, session_id, created_at)
  ) STRICT;
  CREATE INDEX board_record_closed ON board_record (state, closed_ms);
  `,
  // lineage.v1: each record's tree root, for the root filter and the subtree
  // annotation. Rows from before stay NULL until their next ingestion.
  `
  ALTER TABLE board_record ADD COLUMN root_machine TEXT;
  ALTER TABLE board_record ADD COLUMN root_session_id TEXT;
  CREATE INDEX board_record_root ON board_record (root_session_id);
  `,
];
export const BOARD_STORE_VERSION = MIGRATIONS.length;

// Two consecutive complete snapshots at least this far apart confirm absence.
const VANISH_CONFIRM_MS = 60_000;

export interface BoardMachineStatus {
  readonly cursor: string | null;
  readonly lastSeenMs: number | null;
  readonly lastAttemptOk: boolean;
}

export interface BoardMachineView {
  readonly machine: string;
  readonly available: boolean;
  readonly last_seen_at: string | null;
}

interface MachineRow {
  readonly closed_cursor: string | null;
  readonly last_seen_ms: number | null;
  readonly last_attempt_ok: number;
}

/** One stored row's tree position, for the lineage.v1 annotations. */
export interface BoardTreeRow {
  readonly machine: string;
  readonly session_id: string;
  readonly created_at: string;
  readonly state: "live" | "stopped" | "closed";
  readonly updated_ms: number;
  readonly root_machine: string | null;
  readonly root_session_id: string | null;
}

interface OpenRow {
  readonly session_id: string;
  readonly created_at: string;
  readonly missing_since_ms: number | null;
  readonly record_json: string;
}

const identity = (sessionId: string, createdAt: string): string => JSON.stringify([sessionId, createdAt]);

export class BoardStore {
  readonly #db: DatabaseSync;
  #identityLookup?: StatementSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      this.#migrate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #migrate(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const version = (this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > BOARD_STORE_VERSION) {
        throw new Error(`board store schema ${version} is newer than supported ${BOARD_STORE_VERSION}`);
      }
      for (let next = version; next < BOARD_STORE_VERSION; next += 1) {
        this.#db.exec(MIGRATIONS[next]!);
        this.#db.exec(`PRAGMA user_version = ${next + 1}`);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  #transaction(action: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #ensureMachine(machine: string): void {
    this.#db.prepare("INSERT INTO board_machine (machine) VALUES (?) ON CONFLICT (machine) DO NOTHING").run(machine);
  }

  #upsert(record: BoardRecord): void {
    const closedMs = record.closed_at === null ? null : boardTimestampMs(record.closed_at);
    this.#db.prepare(`
      INSERT INTO board_record
        (machine, session_id, created_at, state, repo_name, updated_ms, closed_ms, missing_since_ms, record_json,
         root_machine, root_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT (machine, session_id, created_at) DO UPDATE SET
        state = excluded.state,
        repo_name = excluded.repo_name,
        updated_ms = excluded.updated_ms,
        closed_ms = excluded.closed_ms,
        missing_since_ms = NULL,
        record_json = excluded.record_json,
        root_machine = excluded.root_machine,
        root_session_id = excluded.root_session_id
    `).run(
      record.machine, record.session_id, record.created_at, record.state, record.repo_name,
      boardTimestampMs(record.updated_at) ?? 0, closedMs, JSON.stringify(record),
      record.lineage?.root.machine ?? null, record.lineage?.root.session_id ?? null,
    );
  }

  machineStatus(machine: string): BoardMachineStatus {
    const row = this.#db.prepare(
      "SELECT closed_cursor, last_seen_ms, last_attempt_ok FROM board_machine WHERE machine = ?",
    ).get(machine) as MachineRow | undefined;
    return {
      cursor: row?.closed_cursor ?? null,
      lastSeenMs: row?.last_seen_ms ?? null,
      lastAttemptOk: row?.last_attempt_ok === 1,
    };
  }

  /**
   * Availability of each configured machine, in the order given. A machine is
   * available only when its last ingestion attempt succeeded and that success
   * is within the freshness window.
   */
  machineStatuses(machines: readonly string[], nowMs: number, freshnessMs = 90_000): BoardMachineView[] {
    return machines.map((machine) => {
      const status = this.machineStatus(machine);
      return {
        machine,
        available: status.lastAttemptOk && status.lastSeenMs !== null && nowMs - status.lastSeenMs <= freshnessMs,
        last_seen_at: status.lastSeenMs === null ? null : new Date(status.lastSeenMs).toISOString(),
      };
    });
  }

  clearCursor(machine: string): void {
    this.#ensureMachine(machine);
    this.#db.prepare("UPDATE board_machine SET closed_cursor = NULL WHERE machine = ?").run(machine);
  }

  /** Applies closed-ledger records and advances the machine cursor atomically. */
  applyClosed(machine: string, records: readonly BoardRecord[], nextCursor: string): void {
    this.#transaction(() => {
      this.#ensureMachine(machine);
      for (const record of records) this.#upsert(record);
      this.#db.prepare("UPDATE board_machine SET closed_cursor = ? WHERE machine = ?").run(nextCursor, machine);
    });
  }

  /**
   * A failed ingestion attempt: the machine becomes unavailable, and pending
   * absence observations are discarded because the next snapshot is no longer
   * consecutive with them.
   */
  recordFailure(machine: string): void {
    this.#transaction(() => {
      this.#ensureMachine(machine);
      this.#db.prepare("UPDATE board_machine SET last_attempt_ok = 0 WHERE machine = ?").run(machine);
      this.#db.prepare("UPDATE board_record SET missing_since_ms = NULL WHERE machine = ?").run(machine);
    });
  }

  /**
   * Replaces the machine's live and stopped view with a successful snapshot.
   * Rows absent from two consecutive complete snapshots at least 60 seconds
   * apart become `closed`/`vanished`, dated at the first absence. An incomplete
   * snapshot (`complete` false) never advances or confirms an absence.
   */
  applySnapshot(machine: string, records: readonly BoardRecord[], complete: boolean, nowMs: number): void {
    this.#transaction(() => {
      this.#ensureMachine(machine);
      const present = new Set(records.map((record) => identity(record.session_id, record.created_at)));
      const open = this.#db.prepare(`
        SELECT session_id, created_at, missing_since_ms, record_json FROM board_record
        WHERE machine = ? AND state IN ('live', 'stopped')
      `).all(machine) as unknown as OpenRow[];
      for (const row of open) {
        if (present.has(identity(row.session_id, row.created_at))) continue;
        const key = [machine, row.session_id, row.created_at] as const;
        if (!complete) {
          this.#db.prepare(`
            UPDATE board_record SET missing_since_ms = NULL
            WHERE machine = ? AND session_id = ? AND created_at = ?
          `).run(...key);
        } else if (row.missing_since_ms === null) {
          this.#db.prepare(`
            UPDATE board_record SET missing_since_ms = ?
            WHERE machine = ? AND session_id = ? AND created_at = ?
          `).run(nowMs, ...key);
        } else if (nowMs - row.missing_since_ms >= VANISH_CONFIRM_MS) {
          const last = withBoardExtensionDefaults(JSON.parse(row.record_json) as BoardRecord);
          this.#upsert({
            ...last,
            state: "closed",
            runtime_status: null,
            messaging_supported: false,
            closed_at: new Date(row.missing_since_ms).toISOString(),
            close_reason: "vanished",
          });
        }
      }
      for (const record of records) this.#upsert(record);
      this.#db.prepare("UPDATE board_machine SET last_seen_ms = ?, last_attempt_ok = 1 WHERE machine = ?")
        .run(nowMs, machine);
    });
  }

  /**
   * Retention: drops closed rows closed before the window, rows whose machine
   * has not been seen within it, and every row or cursor of a machine that is
   * no longer configured.
   */
  prune(nowMs: number, retentionMs: number, configuredMachines: readonly string[]): void {
    const cutoff = nowMs - retentionMs;
    const configured = JSON.stringify(configuredMachines);
    this.#transaction(() => {
      this.#db.prepare("DELETE FROM board_record WHERE state = 'closed' AND closed_ms < ?").run(cutoff);
      this.#db.prepare(`
        DELETE FROM board_record WHERE state != 'closed' AND machine IN (
          SELECT machine FROM board_machine WHERE last_seen_ms IS NULL OR last_seen_ms < ?
        )
      `).run(cutoff);
      this.#db.prepare("DELETE FROM board_record WHERE machine NOT IN (SELECT value FROM json_each(?))").run(configured);
      this.#db.prepare("DELETE FROM board_machine WHERE machine NOT IN (SELECT value FROM json_each(?))").run(configured);
    });
  }

  /**
   * Rows for the aggregator query, in contract order: live, stopped, closed;
   * newest `updated_at` (live/stopped) or `closed_at` (closed) first; then
   * machine and session id. Live and stopped rows come only from available
   * machines; closed rows from any configured machine. `sinceMs` bounds stopped
   * rows by `updated_at` and closed rows by `closed_at`; live rows are kept.
   */
  queryRows(query: {
    readonly states: readonly string[];
    readonly sinceMs: number;
    readonly repo: string | null;
    readonly machine: string | null;
    // lineage.v1: the root itself and every record whose lineage names it.
    readonly root?: string | null;
    readonly availableMachines: readonly string[];
    readonly configuredMachines: readonly string[];
    readonly limit: number;
    // Applied before the limit, so rows the reader may not see never count
    // toward it.
    readonly include?: (record: BoardRecord) => boolean;
  }): BoardRecord[] {
    const statement = this.#db.prepare(`
      SELECT record_json FROM board_record
      WHERE state IN (SELECT value FROM json_each(?))
        AND (? IS NULL OR repo_name = ?)
        AND (? IS NULL OR machine = ?)
        AND (? IS NULL OR session_id = ? OR root_session_id = ?)
        AND (
          (state = 'live' AND machine IN (SELECT value FROM json_each(?)))
          OR (state = 'stopped' AND updated_ms >= ? AND machine IN (SELECT value FROM json_each(?)))
          OR (state = 'closed' AND closed_ms >= ? AND machine IN (SELECT value FROM json_each(?)))
        )
      ORDER BY
        CASE state WHEN 'live' THEN 0 WHEN 'stopped' THEN 1 ELSE 2 END,
        CASE state WHEN 'closed' THEN closed_ms ELSE updated_ms END DESC,
        machine, session_id
      LIMIT ?
    `);
    const params = [
      JSON.stringify(query.states),
      query.repo, query.repo,
      query.machine, query.machine,
      query.root ?? null, query.root ?? null, query.root ?? null,
      JSON.stringify(query.availableMachines),
      query.sinceMs, JSON.stringify(query.availableMachines),
      query.sinceMs, JSON.stringify(query.configuredMachines),
    ];
    if (!query.include) {
      const rows = statement.all(...params, query.limit) as Array<{ record_json: string }>;
      return rows.map((row) => withBoardExtensionDefaults(JSON.parse(row.record_json) as BoardRecord));
    }
    const records: BoardRecord[] = [];
    // LIMIT -1 is unbounded in SQLite; iteration stops at the limit instead.
    for (const row of statement.iterate(...params, -1) as Iterable<{ record_json: string }>) {
      const record = withBoardExtensionDefaults(JSON.parse(row.record_json) as BoardRecord);
      if (!query.include(record)) continue;
      records.push(record);
      if (records.length >= query.limit) break;
    }
    return records;
  }

  /** Exact identity lookup; the caller must check scope and retention first. */
  recordForIdentity(machine: string, sessionId: string, createdAt: string): BoardRecord | undefined {
    const lookup = this.#identityLookup ??= this.#db.prepare("SELECT record_json FROM board_record WHERE machine = ? AND session_id = ? AND created_at = ?");
    const row = lookup
      .get(machine, sessionId, createdAt) as { record_json: string } | undefined;
    return row ? withBoardExtensionDefaults(JSON.parse(row.record_json) as BoardRecord) : undefined;
  }

  /** Every stored row, optionally for one machine. */
  rows(machine?: string): BoardRecord[] {
    const rows = (machine === undefined
      ? this.#db.prepare("SELECT record_json FROM board_record ORDER BY machine, session_id, created_at").all()
      : this.#db.prepare("SELECT record_json FROM board_record WHERE machine = ? ORDER BY session_id, created_at").all(machine)
    ) as Array<{ record_json: string }>;
    return rows.map((row) => withBoardExtensionDefaults(JSON.parse(row.record_json) as BoardRecord));
  }

  /**
   * Tree positions for the lineage.v1 annotations, without the query's
   * filters: every live and stopped row of an available machine, and closed
   * rows within `closedSinceMs` (the retention window, so a parent's close is
   * judged the same whatever `since` a request asks for). The caller narrows
   * stopped rows to its window where it counts them.
   */
  treeRows(query: {
    readonly closedSinceMs: number;
    readonly availableMachines: readonly string[];
    readonly configuredMachines: readonly string[];
  }): BoardTreeRow[] {
    return this.#db.prepare(`
      SELECT machine, session_id, created_at, state, updated_ms, root_machine, root_session_id FROM board_record
      WHERE (state IN ('live', 'stopped') AND machine IN (SELECT value FROM json_each(?)))
        OR (state = 'closed' AND closed_ms >= ? AND machine IN (SELECT value FROM json_each(?)))
    `).all(
      JSON.stringify(query.availableMachines), query.closedSinceMs, JSON.stringify(query.configuredMachines),
    ) as unknown as BoardTreeRow[];
  }
}
