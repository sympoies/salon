import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionDispatchedBy } from "@agent-console/shared/api";

// The session that started another one through the coordination start route.
// Display-only metadata; never an authorization input.
export interface SessionDispatcher {
  readonly machine: string;
  readonly sessionId: string;
  readonly repoName?: string;
}

const MAX_TREE_DEPTH = 64;
// The tree depth recorded for a session started outside every coordinator's
// tree (a root start without the coordinator role, or a session the user
// starts), so the legacy repository rule never applies to it or its children.
export const OUTSIDE_COORDINATOR_TREE = -1;

/** The public `coordinator_tree` mark: depth 0 is the coordinator itself. */
export function publicCoordinatorTree(depth: number | null | undefined): { coordinator_tree?: { depth: number } } {
  return depth === null || depth === undefined ? {} : { coordinator_tree: { depth } };
}

export function publicDispatchedBy(dispatcher: SessionDispatcher | null | undefined): SessionDispatchedBy | null {
  if (!dispatcher) return null;
  return {
    machine: dispatcher.machine,
    session_id: dispatcher.sessionId,
    ...(dispatcher.repoName !== undefined ? { repo_name: dispatcher.repoName } : {}),
  };
}

// What the coordination start route records about how a session started.
export interface SessionStartMark {
  readonly dispatcher?: SessionDispatcher;
  readonly launcher?: SessionDispatcher;
  readonly consoleRole?: "coordinator";
  readonly treeDepth?: number;
}

export interface SessionOwnershipInput {
  readonly principalId: string;
  readonly machine: string;
  readonly sessionId: string;
  readonly incarnation: string;
  readonly provider?: string;
  readonly providerSessionId?: string;
  readonly runtimeStartedAt?: string;
  readonly dispatcher?: SessionDispatcher;
  readonly launcher?: SessionDispatcher;
  // Recorded once when the session starts; later claims never erase them.
  readonly consoleRole?: "coordinator";
  readonly treeDepth?: number;
}

export interface ProviderOwnershipInput {
  readonly machine: string;
  readonly provider: string;
  readonly providerSessionId: string;
}

export interface HistoryOwnershipInput extends ProviderOwnershipInput {
  readonly historyId: string;
}

export interface OwnershipImportInput {
  readonly principalId: string;
  readonly sessions: readonly SessionOwnershipInput[];
  readonly providers: readonly ProviderOwnershipInput[];
  readonly histories: readonly HistoryOwnershipInput[];
}

export interface LayoutDocument {
  readonly order: string[];
  readonly revision: number;
}

export interface LayoutWriteResult extends LayoutDocument {
  readonly ok: boolean;
}

interface OwnerRow {
  readonly principal_id: string;
}

interface SessionOwnerRow extends OwnerRow {
  readonly incarnation: string;
  readonly provider: string | null;
  readonly provider_session_id: string | null;
  readonly runtime_started_at: string | null;
  readonly dispatcher_machine: string | null;
  readonly dispatcher_session_id: string | null;
  readonly dispatcher_repo_name: string | null;
  readonly launcher_machine: string | null;
  readonly launcher_session_id: string | null;
  readonly launcher_repo_name: string | null;
  readonly console_role: string | null;
  readonly tree_depth: number | null;
}

export interface SessionGrant {
  readonly principalId: string;
  readonly incarnation: string;
  readonly provider: string | null;
  readonly providerSessionId: string | null;
  readonly runtimeStartedAt: string | null;
  readonly dispatcher: SessionDispatcher | null;
  readonly launcher: SessionDispatcher | null;
  readonly consoleRole: "coordinator" | null;
  readonly treeDepth: number | null;
}

interface LayoutRow {
  readonly order_json: string;
  readonly revision: number;
}

function ownerConflict(kind: string): Error {
  return new Error(`${kind} is already owned by another principal`);
}

function normalizedRuntimeStartedAt(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export class AccessStore {
  readonly #db: DatabaseSync;

  readonly #legacyCoordinatorRepositories: ReadonlySet<string>;

  constructor(path: string, options: { readonly legacyCoordinatorRepositories?: readonly string[] } = {}) {
    this.#legacyCoordinatorRepositories = new Set(options.legacyCoordinatorRepositories ?? []);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS session_ownership (
        machine TEXT NOT NULL,
        session_id TEXT NOT NULL,
        incarnation TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        provider TEXT,
        provider_session_id TEXT,
        runtime_started_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (machine, session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS provider_ownership (
        machine TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (machine, provider, provider_session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS history_ownership (
        machine TEXT NOT NULL,
        history_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (machine, history_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS principal_layout (
        principal_id TEXT PRIMARY KEY,
        order_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      -- Retired per-principal header account choice.
      DROP TABLE IF EXISTS principal_claude_display;
    `);
    const columns = this.#db.prepare("PRAGMA table_info(session_ownership)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "provider")) {
      this.#db.exec("ALTER TABLE session_ownership ADD COLUMN provider TEXT");
    }
    if (!columns.some((column) => column.name === "provider_session_id")) {
      this.#db.exec("ALTER TABLE session_ownership ADD COLUMN provider_session_id TEXT");
    }
    if (!columns.some((column) => column.name === "runtime_started_at")) {
      this.#db.exec("ALTER TABLE session_ownership ADD COLUMN runtime_started_at TEXT");
    }
    for (const column of ["dispatcher_machine", "dispatcher_session_id", "dispatcher_repo_name", "console_role", "launcher_machine", "launcher_session_id", "launcher_repo_name"]) {
      if (!columns.some((existing) => existing.name === column)) {
        this.#db.exec(`ALTER TABLE session_ownership ADD COLUMN ${column} TEXT`);
      }
    }
    if (!columns.some((column) => column.name === "tree_depth")) {
      this.#db.exec("ALTER TABLE session_ownership ADD COLUMN tree_depth INTEGER");
    }
  }

  close(): void {
    this.#db.close();
  }

  claimSession(input: SessionOwnershipInput): void {
    const existing = this.#db.prepare(
      "SELECT principal_id FROM session_ownership WHERE machine = ? AND session_id = ?",
    ).get(input.machine, input.sessionId) as unknown as OwnerRow | undefined;
    if (existing && existing.principal_id !== input.principalId) throw ownerConflict("session");
    this.#db.prepare(`
      INSERT INTO session_ownership
        (machine, session_id, incarnation, principal_id, provider, provider_session_id, runtime_started_at,
         dispatcher_machine, dispatcher_session_id, dispatcher_repo_name, console_role, tree_depth,
         launcher_machine, launcher_session_id, launcher_repo_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (machine, session_id) DO UPDATE SET
        incarnation = excluded.incarnation,
        provider = COALESCE(excluded.provider, session_ownership.provider),
        provider_session_id = COALESCE(excluded.provider_session_id, session_ownership.provider_session_id),
        runtime_started_at = excluded.runtime_started_at,
        dispatcher_machine = COALESCE(excluded.dispatcher_machine, session_ownership.dispatcher_machine),
        dispatcher_session_id = COALESCE(excluded.dispatcher_session_id, session_ownership.dispatcher_session_id),
        dispatcher_repo_name = CASE WHEN excluded.dispatcher_machine IS NULL
          THEN session_ownership.dispatcher_repo_name ELSE excluded.dispatcher_repo_name END,
        launcher_machine = COALESCE(session_ownership.launcher_machine, excluded.launcher_machine),
        launcher_session_id = COALESCE(session_ownership.launcher_session_id, excluded.launcher_session_id),
        launcher_repo_name = CASE WHEN session_ownership.launcher_machine IS NULL
          THEN excluded.launcher_repo_name ELSE session_ownership.launcher_repo_name END,
        console_role = COALESCE(excluded.console_role, session_ownership.console_role),
        tree_depth = COALESCE(excluded.tree_depth, session_ownership.tree_depth),
        updated_at = CURRENT_TIMESTAMP
    `).run(
      input.machine, input.sessionId, input.incarnation, input.principalId,
      input.provider ?? null, input.providerSessionId ?? null,
      normalizedRuntimeStartedAt(input.runtimeStartedAt),
      input.dispatcher?.machine ?? null, input.dispatcher?.sessionId ?? null, input.dispatcher?.repoName ?? null,
      input.consoleRole ?? null, input.treeDepth ?? null,
      input.launcher?.machine ?? null, input.launcher?.sessionId ?? null, input.launcher?.repoName ?? null,
    );
  }

  ownsSession(
    principalId: string,
    machine: string,
    sessionId: string,
    incarnation?: string,
  ): boolean {
    const row = this.#db.prepare(`
      SELECT principal_id FROM session_ownership
      WHERE machine = ? AND session_id = ?
        AND (? IS NULL OR incarnation = ?)
    `).get(machine, sessionId, incarnation ?? null, incarnation ?? null) as unknown as OwnerRow | undefined;
    return row?.principal_id === principalId;
  }

  sessionIncarnation(principalId: string, machine: string, sessionId: string): string | undefined {
    const row = this.#db.prepare(`
      SELECT principal_id, incarnation FROM session_ownership
      WHERE machine = ? AND session_id = ?
    `).get(machine, sessionId) as unknown as SessionOwnerRow | undefined;
    return row?.principal_id === principalId ? row.incarnation : undefined;
  }

  sessionGrant(machine: string, sessionId: string): SessionGrant | undefined {
    const row = this.#db.prepare(`
      SELECT principal_id, incarnation, provider, provider_session_id, runtime_started_at,
        dispatcher_machine, dispatcher_session_id, dispatcher_repo_name, console_role, tree_depth,
        launcher_machine, launcher_session_id, launcher_repo_name
      FROM session_ownership WHERE machine = ? AND session_id = ?
    `).get(machine, sessionId) as unknown as SessionOwnerRow | undefined;
    return row ? {
      principalId: row.principal_id,
      incarnation: row.incarnation,
      provider: row.provider,
      providerSessionId: row.provider_session_id,
      runtimeStartedAt: row.runtime_started_at,
      dispatcher: row.dispatcher_machine !== null && row.dispatcher_session_id !== null ? {
        machine: row.dispatcher_machine,
        sessionId: row.dispatcher_session_id,
        ...(row.dispatcher_repo_name !== null ? { repoName: row.dispatcher_repo_name } : {}),
      } : null,
      launcher: row.launcher_machine !== null && row.launcher_session_id !== null ? {
        machine: row.launcher_machine,
        sessionId: row.launcher_session_id,
        ...(row.launcher_repo_name !== null ? { repoName: row.launcher_repo_name } : {}),
      } : null,
      consoleRole: row.console_role === "coordinator" ? row.console_role : null,
      treeDepth: Number.isSafeInteger(row.tree_depth) ? row.tree_depth : null,
    } : undefined;
  }

  /**
   * The session's depth in a coordinator's tree: 0 for a coordinator, or the
   * depth recorded when it started. A session recorded as outside every tree
   * stays outside, and so do its children. A session with nothing recorded
   * was started before depths were recorded: one that nobody dispatched in
   * a configured legacy coordinator repository (`repoName`) is a coordinator, and any
   * other takes its dispatcher's depth plus one. Null outside any tree.
   * Display-only; never an authorization input.
   */
  coordinatorTreeDepth(machine: string, sessionId: string, repoName?: string | null, hops = 0,
    grantOf: (machine: string, sessionId: string) => SessionGrant | undefined = (machine, sessionId) => this.sessionGrant(machine, sessionId),
  ): number | null {
    const grant = grantOf(machine, sessionId);
    // A dispatcher the console never owned is judged by its repository alone.
    if (!grant) return hops > 0 && typeof repoName === "string" && this.#legacyCoordinatorRepositories.has(repoName) ? 0 : null;
    if (grant.consoleRole === "coordinator") return 0;
    if (grant.treeDepth !== null) return grant.treeDepth >= 0 ? grant.treeDepth : null;
    const dispatcher = grant.dispatcher;
    if (!dispatcher) return typeof repoName === "string" && this.#legacyCoordinatorRepositories.has(repoName) ? 0 : null;
    if (hops >= MAX_TREE_DEPTH) return null;
    const above = this.coordinatorTreeDepth(dispatcher.machine, dispatcher.sessionId, dispatcher.repoName, hops + 1, grantOf);
    return above === null ? null : above + 1;
  }

  advanceSessionIncarnation(
    principalId: string,
    machine: string,
    sessionId: string,
    previousIncarnation: string,
    nextIncarnation: string,
  ): boolean {
    if (!nextIncarnation) return false;
    const result = this.#db.prepare(`
      UPDATE session_ownership SET incarnation = ?, updated_at = CURRENT_TIMESTAMP
      WHERE machine = ? AND session_id = ? AND principal_id = ? AND incarnation = ?
    `).run(nextIncarnation, machine, sessionId, principalId, previousIncarnation);
    return result.changes === 1;
  }

  bindSessionProvider(
    principalId: string,
    machine: string,
    sessionId: string,
    incarnation: string,
    provider: string,
    providerSessionId: string,
    runtimeStartedAt?: string,
  ): boolean {
    if (!provider || !providerSessionId) return false;
    const startedAt = normalizedRuntimeStartedAt(runtimeStartedAt);
    const result = this.#db.prepare(`
      UPDATE session_ownership
      SET provider = ?, provider_session_id = ?,
          runtime_started_at = COALESCE(?, runtime_started_at), updated_at = CURRENT_TIMESTAMP
      WHERE machine = ? AND session_id = ? AND principal_id = ? AND incarnation = ?
        AND (
          (provider IS NULL AND provider_session_id IS NULL)
          OR (provider = ? AND provider_session_id = ? AND ? IS NOT NULL
              AND (runtime_started_at IS NULL OR runtime_started_at < ?))
        )
        AND EXISTS (
          SELECT 1 FROM provider_ownership
          WHERE machine = ? AND provider = ? AND provider_session_id = ? AND principal_id = ?
        )
    `).run(
      provider, providerSessionId, startedAt,
      machine, sessionId, principalId, incarnation,
      provider, providerSessionId, startedAt, startedAt,
      machine, provider, providerSessionId, principalId,
    );
    return result.changes === 1;
  }

  repairSessionIncarnation(
    principalId: string,
    machine: string,
    sessionId: string,
    previousIncarnation: string,
    nextIncarnation: string,
    provider: string,
    providerSessionId: string,
    allowUnbound = false,
    checkOnly = false,
    nextRuntimeStartedAt?: string,
  ): boolean {
    if (!nextIncarnation || previousIncarnation === nextIncarnation) return false;
    const startedAt = normalizedRuntimeStartedAt(nextRuntimeStartedAt);
    if (!allowUnbound && !startedAt) return false;
    if (checkOnly) this.#db.exec("SAVEPOINT ownership_repair_check");
    try {
      const result = this.#db.prepare(`
      UPDATE session_ownership SET
        incarnation = ?, provider = ?, provider_session_id = ?,
        runtime_started_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE machine = ? AND session_id = ? AND principal_id = ? AND incarnation = ?
        AND (? = 1 OR (runtime_started_at IS NOT NULL AND runtime_started_at < ?))
        AND (
          (provider = ? AND provider_session_id = ?)
          OR (? = 1 AND provider IS NULL AND provider_session_id IS NULL)
        )
        AND EXISTS (
          SELECT 1 FROM provider_ownership
          WHERE machine = ? AND provider = ? AND provider_session_id = ? AND principal_id = ?
        )
      `).run(
        nextIncarnation, provider, providerSessionId, startedAt,
        machine, sessionId, principalId, previousIncarnation,
        allowUnbound ? 1 : 0, startedAt,
        provider, providerSessionId, allowUnbound ? 1 : 0,
        machine, provider, providerSessionId, principalId,
      );
      return result.changes === 1;
    } finally {
      if (checkOnly) {
        this.#db.exec("ROLLBACK TO ownership_repair_check");
        this.#db.exec("RELEASE ownership_repair_check");
      }
    }
  }

  claimProvider(
    principalId: string,
    machine: string,
    provider: string,
    providerSessionId: string,
  ): void {
    const existing = this.#db.prepare(`
      SELECT principal_id FROM provider_ownership
      WHERE machine = ? AND provider = ? AND provider_session_id = ?
    `).get(machine, provider, providerSessionId) as unknown as OwnerRow | undefined;
    if (existing && existing.principal_id !== principalId) throw ownerConflict("provider session");
    this.#db.prepare(`
      INSERT INTO provider_ownership (machine, provider, provider_session_id, principal_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (machine, provider, provider_session_id) DO UPDATE SET
        updated_at = CURRENT_TIMESTAMP
    `).run(machine, provider, providerSessionId, principalId);
  }

  ownsProvider(
    principalId: string,
    machine: string,
    provider: string,
    providerSessionId: string,
  ): boolean {
    const row = this.#db.prepare(`
      SELECT principal_id FROM provider_ownership
      WHERE machine = ? AND provider = ? AND provider_session_id = ?
    `).get(machine, provider, providerSessionId) as unknown as OwnerRow | undefined;
    return row?.principal_id === principalId;
  }

  hasProviderOwner(machine: string, provider: string, providerSessionId: string): boolean {
    return this.#db.prepare(`
      SELECT 1 FROM provider_ownership
      WHERE machine = ? AND provider = ? AND provider_session_id = ?
    `).get(machine, provider, providerSessionId) !== undefined;
  }

  /**
   * The live session of this principal's grant for a provider session, so a
   * history entry carries the same coordinator tree mark as its live session.
   * A grant that records how the session started inside a tree (a role, a
   * depth, or a dispatcher) wins over a later one that does not, such as the
   * grant a resume from History records outside every tree.
   */
  providerSession(principalId: string, machine: string, provider: string, providerSessionId: string): string | null {
    const row = this.#db.prepare(`
      SELECT session_id FROM session_ownership
      WHERE machine = ? AND provider = ? AND provider_session_id = ? AND principal_id = ?
      ORDER BY (console_role IS NOT NULL OR tree_depth >= 0 OR dispatcher_machine IS NOT NULL) DESC,
        updated_at DESC
      LIMIT 1
    `).get(machine, provider, providerSessionId, principalId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  /**
   * The dispatcher recorded on this principal's session grant for a provider
   * session, so a history entry of a dispatched child carries the same mark as
   * its live session.
   */
  providerDispatcher(
    principalId: string,
    machine: string,
    provider: string,
    providerSessionId: string,
  ): SessionDispatcher | null {
    const row = this.#db.prepare(`
      SELECT dispatcher_machine, dispatcher_session_id, dispatcher_repo_name FROM session_ownership
      WHERE machine = ? AND provider = ? AND provider_session_id = ? AND principal_id = ?
        AND dispatcher_machine IS NOT NULL AND dispatcher_session_id IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(machine, provider, providerSessionId, principalId) as unknown as Pick<
      SessionOwnerRow, "dispatcher_machine" | "dispatcher_session_id" | "dispatcher_repo_name"
    > | undefined;
    if (!row || row.dispatcher_machine === null || row.dispatcher_session_id === null) return null;
    return {
      machine: row.dispatcher_machine,
      sessionId: row.dispatcher_session_id,
      ...(row.dispatcher_repo_name !== null ? { repoName: row.dispatcher_repo_name } : {}),
    };
  }

  claimHistory(
    principalId: string,
    machine: string,
    historyId: string,
    provider: string,
    providerSessionId: string,
  ): void {
    this.claimProvider(principalId, machine, provider, providerSessionId);
    const existing = this.#db.prepare(`
      SELECT principal_id FROM history_ownership WHERE machine = ? AND history_id = ?
    `).get(machine, historyId) as unknown as OwnerRow | undefined;
    if (existing && existing.principal_id !== principalId) throw ownerConflict("history session");
    this.#db.prepare(`
      INSERT INTO history_ownership
        (machine, history_id, provider, provider_session_id, principal_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (machine, history_id) DO UPDATE SET
        provider = excluded.provider,
        provider_session_id = excluded.provider_session_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(machine, historyId, provider, providerSessionId, principalId);
  }

  ownsHistory(principalId: string, machine: string, historyId: string): boolean {
    const row = this.#db.prepare(`
      SELECT principal_id FROM history_ownership WHERE machine = ? AND history_id = ?
    `).get(machine, historyId) as unknown as OwnerRow | undefined;
    return row?.principal_id === principalId;
  }

  claimImport(input: OwnershipImportInput, checkOnly = false): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const session of input.sessions) this.claimSession(session);
      for (const provider of input.providers) {
        this.claimProvider(
          input.principalId,
          provider.machine,
          provider.provider,
          provider.providerSessionId,
        );
      }
      for (const history of input.histories) {
        this.claimHistory(
          input.principalId,
          history.machine,
          history.historyId,
          history.provider,
          history.providerSessionId,
        );
      }
      this.#db.exec(checkOnly ? "ROLLBACK" : "COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  readLayout(principalId: string): LayoutDocument {
    const row = this.#db.prepare(`
      SELECT order_json, revision FROM principal_layout WHERE principal_id = ?
    `).get(principalId) as unknown as LayoutRow | undefined;
    if (!row) return { order: [], revision: 0 };
    const order = JSON.parse(row.order_json) as unknown;
    if (!Array.isArray(order) || !order.every((entry) => typeof entry === "string")) {
      throw new Error("stored principal layout is invalid");
    }
    return { order, revision: Number(row.revision) };
  }

  writeLayout(principalId: string, order: readonly string[], baseRevision: number): LayoutWriteResult {
    const current = this.readLayout(principalId);
    if (current.revision !== baseRevision) return { ok: false, ...current };
    const next = { order: [...order], revision: current.revision + 1 };
    this.#db.prepare(`
      INSERT INTO principal_layout (principal_id, order_json, revision)
      VALUES (?, ?, ?)
      ON CONFLICT (principal_id) DO UPDATE SET
        order_json = excluded.order_json,
        revision = excluded.revision,
        updated_at = CURRENT_TIMESTAMP
      WHERE principal_layout.revision = ?
    `).run(principalId, JSON.stringify(next.order), next.revision, baseRevision);
    return { ok: true, ...next };
  }
}
