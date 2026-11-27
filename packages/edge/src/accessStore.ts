import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionDispatchedBy } from "@agent-console/shared/api";
import type { ResumeMoveReply } from "./resumeMove.ts";

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

export interface PendingSessionClaim {
  readonly machine: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly parentMachine: string;
  readonly parentId: string;
  readonly parentIncarnation: string;
  readonly operationId: string;
  readonly startMark: SessionStartMark;
  readonly expiresAt: number;
}

export interface ServiceStartOperation {
  readonly sessionId: string;
  readonly machine: string;
  readonly agent: string;
  readonly fingerprint: string;
}

export interface ServiceStartInput extends ServiceStartOperation {
  readonly relayMachine: string;
  readonly serviceId: string;
  readonly operationId: string;
}

interface ServiceStartRow {
  readonly session_id: string;
  readonly machine: string;
  readonly agent: string;
  readonly fingerprint: string;
}

export interface ResumeMoveReceiptKey {
  readonly machine: string;
  readonly signer: string;
  readonly moveId: string;
  readonly owner: string;
  readonly digest: string;
  readonly operationId: string;
  readonly originMachine: string;
  readonly callerId: string;
  readonly callerIncarnation: string;
}

type ResumeMoveClaim =
  | { readonly kind: "repeat"; readonly outcome: ResumeMoveReply | null }
  | { readonly kind: "claimed" | "unavailable" | "conflict" | "missing" | "expired" };

interface ResumeMoveRow {
  readonly machine: string;
  readonly signer: string;
  readonly owner: string;
  readonly digest: string;
  readonly outcome: string | null;
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

export interface SuccessionStopIdentity {
  readonly machine: string;
  readonly session_id: string;
  readonly session_incarnation: string;
}
export interface SuccessionStopRequest {
  readonly delegation_id: string;
  readonly operation_id: string;
  readonly caller: SuccessionStopIdentity;
  readonly predecessor: SuccessionStopIdentity;
}
export interface SuccessionStopGrant extends SuccessionStopRequest {
  readonly scope: "succession_stop";
  readonly owner: string;
  readonly state: "active" | "revoked";
  readonly issued_at_epoch: number;
  readonly retry_until_epoch: number;
  readonly revoked_at_epoch: number | null;
}
export type SuccessionStopIssue =
  | { readonly kind: "issued" | "repeat"; readonly grant: SuccessionStopGrant }
  | { readonly kind: "conflict" | "mismatch" | "owner-mismatch"; readonly grant?: undefined };

interface SuccessionStopRow {
  readonly delegation_id: string; readonly operation_id: string; readonly owner: string;
  readonly caller_machine: string; readonly caller_session_id: string; readonly caller_incarnation: string;
  readonly pred_machine: string; readonly pred_session_id: string; readonly pred_incarnation: string;
  readonly state: "active" | "revoked"; readonly issued_at_epoch: number; readonly retry_until_epoch: number; readonly revoked_at_epoch: number | null;
}

const SUCCESSION_STOP_RETRY_SECONDS = 24 * 3600;

function successionStopGrant(row: SuccessionStopRow): SuccessionStopGrant {
  return {
    delegation_id: row.delegation_id, operation_id: row.operation_id,
    caller: { machine: row.caller_machine, session_id: row.caller_session_id, session_incarnation: row.caller_incarnation },
    predecessor: { machine: row.pred_machine, session_id: row.pred_session_id, session_incarnation: row.pred_incarnation },
    scope: "succession_stop", owner: row.owner, state: row.state,
    issued_at_epoch: row.issued_at_epoch, retry_until_epoch: row.retry_until_epoch, revoked_at_epoch: row.revoked_at_epoch,
  };
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
      CREATE TABLE IF NOT EXISTS pending_session_claim (
        machine TEXT NOT NULL, session_id TEXT NOT NULL, principal_id TEXT NOT NULL,
        parent_machine TEXT NOT NULL, parent_id TEXT NOT NULL, parent_incarnation TEXT NOT NULL,
        operation_id TEXT NOT NULL, start_mark TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY (machine, session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS service_start_operation (
        relay_machine TEXT NOT NULL,
        service_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        machine TEXT NOT NULL,
        agent TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (relay_machine, service_id, operation_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS attested_create_fence (
        machine TEXT NOT NULL, session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE, origin_machine TEXT NOT NULL, caller_id TEXT NOT NULL,
        caller_incarnation TEXT NOT NULL, owner TEXT NOT NULL, digest TEXT NOT NULL, outcome TEXT, created_epoch INTEGER NOT NULL,
        PRIMARY KEY (machine, session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS succession_stop_grant (
        delegation_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
        caller_machine TEXT NOT NULL, caller_session_id TEXT NOT NULL, caller_incarnation TEXT NOT NULL,
        pred_machine TEXT NOT NULL, pred_session_id TEXT NOT NULL, pred_incarnation TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        issued_at_epoch INTEGER NOT NULL, retry_until_epoch INTEGER NOT NULL, revoked_at_epoch INTEGER
      ) STRICT;
      -- One active grant per predecessor tuple; revoked records stay for audit and replay.
      CREATE UNIQUE INDEX IF NOT EXISTS succession_stop_grant_active
        ON succession_stop_grant (pred_machine, pred_session_id, pred_incarnation) WHERE state = 'active';
      CREATE TABLE IF NOT EXISTS attested_store_marker (initialized_epoch INTEGER NOT NULL) STRICT;
      INSERT INTO attested_store_marker (initialized_epoch) SELECT CAST(strftime('%s', 'now') AS INTEGER) WHERE NOT EXISTS (SELECT 1 FROM attested_store_marker);
      CREATE TABLE IF NOT EXISTS resume_move_receipt (
        machine TEXT NOT NULL,
        move_id TEXT NOT NULL UNIQUE,
        signer TEXT NOT NULL,
        owner TEXT NOT NULL,
        digest TEXT NOT NULL,
        proof_expires_at INTEGER,
        outcome TEXT,
        PRIMARY KEY (machine, move_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS resume_move_operation (
        origin_machine TEXT NOT NULL,
        caller_id TEXT NOT NULL,
        caller_incarnation TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        move_id TEXT NOT NULL REFERENCES resume_move_receipt(move_id),
        PRIMARY KEY (origin_machine, caller_id, caller_incarnation, operation_id)
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

  /**
   * Reserves a service operation for `sessionId`, or returns the record that
   * already holds it. The row is written before any daemon call, so whatever
   * becomes of that call the operation can never start a second session.
   */
  beginServiceStart(input: ServiceStartInput): ServiceStartOperation {
    this.#db.prepare(`
      INSERT INTO service_start_operation (relay_machine, service_id, operation_id, session_id, machine, agent, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).run(input.relayMachine, input.serviceId, input.operationId, input.sessionId, input.machine, input.agent, input.fingerprint);
    const row = this.#db.prepare(`
      SELECT session_id, machine, agent, fingerprint FROM service_start_operation
      WHERE relay_machine = ? AND service_id = ? AND operation_id = ?
    `).get(input.relayMachine, input.serviceId, input.operationId) as unknown as ServiceStartRow;
    return { sessionId: row.session_id, machine: row.machine, agent: row.agent, fingerprint: row.fingerprint };
  }

  claimAttestedCreate(key: { machine: string; sessionId: string; operationId: string; originMachine: string; callerId: string; incarnation: string; owner: string; digest: string; fresh: boolean; operationEpoch: number }): { kind: "new" | "repeat" | "conflict" | "fenced" | "expired" | "unproven"; outcome?: string; reconcilable?: boolean } {
    return this.#resumeMoveWrite(() => {
      const byOperation = this.#db.prepare("SELECT * FROM attested_create_fence WHERE operation_id = ?").get(key.operationId);
      const byId = this.#db.prepare("SELECT * FROM attested_create_fence WHERE machine = ? AND session_id = ?").get(key.machine, key.sessionId);
      if (byOperation) {
        if (byOperation.machine !== key.machine || byOperation.session_id !== key.sessionId || byOperation.origin_machine !== key.originMachine
          || byOperation.caller_id !== key.callerId || byOperation.caller_incarnation !== key.incarnation || byOperation.owner !== key.owner || byOperation.digest !== key.digest) return { kind: "conflict" };
        if (typeof byOperation.created_epoch !== "number" || byOperation.created_epoch <= Math.floor(Date.now() / 1000) - 86400) {
          this.#db.prepare("UPDATE attested_create_fence SET outcome = NULL WHERE operation_id = ?").run(key.operationId);
          return { kind: "expired" };
        }
        // A store created after the operation began cannot prove it holds this operation's fence history.
        const marker = this.#db.prepare("SELECT initialized_epoch FROM attested_store_marker").get() as { initialized_epoch: number } | undefined;
        const reconcilable = typeof marker?.initialized_epoch === "number" && marker.initialized_epoch <= key.operationEpoch + 60;
        return { kind: "repeat", reconcilable, ...(typeof byOperation.outcome === "string" ? { outcome: byOperation.outcome } : {}) };
      }
      if (byId) return { kind: "fenced" };
      if (!key.fresh) return { kind: "expired" };
      // A store created after the operation began cannot prove that no earlier dispatch happened.
      const marker = this.#db.prepare("SELECT initialized_epoch FROM attested_store_marker").get() as { initialized_epoch: number } | undefined;
      if (typeof marker?.initialized_epoch !== "number" || marker.initialized_epoch > key.operationEpoch + 60) return { kind: "unproven" };
      this.#db.prepare("INSERT INTO attested_create_fence (machine, session_id, operation_id, origin_machine, caller_id, caller_incarnation, owner, digest, created_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(key.machine, key.sessionId, key.operationId, key.originMachine, key.callerId, key.incarnation, key.owner, key.digest, Math.floor(Date.now() / 1000));
      return { kind: "new" };
    });
  }

  completeAttestedCreate(key: { machine: string; sessionId: string; operationId: string; originMachine: string; callerId: string; incarnation: string; owner: string; digest: string }, session: Record<string, unknown>): boolean {
    return this.#resumeMoveWrite(() => {
      const row = this.#db.prepare("SELECT * FROM attested_create_fence WHERE operation_id = ?").get(key.operationId);
      if (!row || row.machine !== key.machine || row.session_id !== key.sessionId || row.origin_machine !== key.originMachine
        || row.caller_id !== key.callerId || row.caller_incarnation !== key.incarnation || row.owner !== key.owner || row.digest !== key.digest
        || row.outcome !== null || !this.ownsSession(key.owner, key.originMachine, key.callerId, key.incarnation) || typeof session.session_incarnation !== "string") return false;
      const existing = this.sessionGrant(key.machine, key.sessionId);
      if (existing && (existing.principalId !== key.owner || existing.incarnation !== session.session_incarnation)) return false;
      this.claimSession({ principalId: key.owner, machine: key.machine, sessionId: key.sessionId, incarnation: session.session_incarnation,
        launcher: { machine: key.originMachine, sessionId: key.callerId }, treeDepth: OUTSIDE_COORDINATOR_TREE });
      this.#db.prepare("UPDATE attested_create_fence SET outcome = ? WHERE operation_id = ?").run(JSON.stringify({ status: 201, body: { ok: true, data: { session } } }), key.operationId);
      return true;
    });
  }

  refuseAttestedCreate(key: { machine: string; sessionId: string; operationId: string; originMachine: string; callerId: string; incarnation: string; owner: string; digest: string }, status: number, code: string): boolean {
    return this.#resumeMoveWrite(() => {
      const row = this.#db.prepare("SELECT * FROM attested_create_fence WHERE operation_id = ?").get(key.operationId);
      if (!row || row.machine !== key.machine || row.session_id !== key.sessionId || row.origin_machine !== key.originMachine
        || row.caller_id !== key.callerId || row.caller_incarnation !== key.incarnation || row.owner !== key.owner || row.digest !== key.digest
        || row.outcome !== null || !this.ownsSession(key.owner, key.originMachine, key.callerId, key.incarnation)) return false;
      this.#db.prepare("UPDATE attested_create_fence SET outcome = ? WHERE operation_id = ?")
        .run(JSON.stringify({ status, body: { ok: false, error: { code, message: "destination rejected attested create" } } }), key.operationId);
      return true;
    });
  }

  /**
   * Registers a grant once. `resolveOwner` runs inside the write transaction so the
   * ownership check and the one-active-grant check cannot be interleaved with another issue.
   */
  issueSuccessionStopGrant(request: SuccessionStopRequest, nowEpoch: number,
    resolveOwner: () => string | "mismatch" | "owner-mismatch"): SuccessionStopIssue {
    return this.#resumeMoveWrite(() => {
      const byId = this.#db.prepare("SELECT * FROM succession_stop_grant WHERE delegation_id = ?").get(request.delegation_id) as unknown as SuccessionStopRow | undefined;
      if (byId) {
        const stored = successionStopGrant(byId);
        const same = stored.operation_id === request.operation_id
          && (["machine", "session_id", "session_incarnation"] as const).every(key => stored.caller[key] === request.caller[key] && stored.predecessor[key] === request.predecessor[key]);
        return same ? { kind: "repeat", grant: stored } : { kind: "conflict" };
      }
      if (this.#db.prepare("SELECT 1 FROM succession_stop_grant WHERE operation_id = ?").get(request.operation_id)) return { kind: "conflict" };
      const owner = resolveOwner();
      if (owner === "mismatch" || owner === "owner-mismatch") return { kind: owner };
      const active = this.#db.prepare(`SELECT 1 FROM succession_stop_grant WHERE state = 'active'
        AND pred_machine = ? AND pred_session_id = ? AND pred_incarnation = ?`)
        .get(request.predecessor.machine, request.predecessor.session_id, request.predecessor.session_incarnation);
      if (active) return { kind: "mismatch" };
      this.#db.prepare(`INSERT INTO succession_stop_grant (delegation_id, operation_id, owner, caller_machine, caller_session_id, caller_incarnation,
        pred_machine, pred_session_id, pred_incarnation, state, issued_at_epoch, retry_until_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
        .run(request.delegation_id, request.operation_id, owner, request.caller.machine, request.caller.session_id, request.caller.session_incarnation,
          request.predecessor.machine, request.predecessor.session_id, request.predecessor.session_incarnation, nowEpoch, nowEpoch + SUCCESSION_STOP_RETRY_SECONDS);
      return { kind: "issued", grant: this.successionStopGrant(request.delegation_id)! };
    });
  }

  /** Revokes the exact grant once and keeps the record. */
  revokeSuccessionStopGrant(delegationId: string, nowEpoch: number): SuccessionStopGrant | undefined {
    return this.#resumeMoveWrite(() => {
      this.#db.prepare("UPDATE succession_stop_grant SET state = 'revoked', revoked_at_epoch = ? WHERE delegation_id = ? AND state = 'active'").run(nowEpoch, delegationId);
      return this.successionStopGrant(delegationId);
    });
  }

  successionStopGrant(delegationId: string): SuccessionStopGrant | undefined {
    const row = this.#db.prepare("SELECT * FROM succession_stop_grant WHERE delegation_id = ?").get(delegationId) as unknown as SuccessionStopRow | undefined;
    return row ? successionStopGrant(row) : undefined;
  }

  /** Every grant, active or revoked, that binds exactly these two tuples under the owner. */
  successionStopMatches(owner: string, caller: SuccessionStopIdentity, predecessor: SuccessionStopIdentity): readonly SuccessionStopGrant[] {
    const rows = this.#db.prepare(`SELECT * FROM succession_stop_grant WHERE owner = ?
      AND caller_machine = ? AND caller_session_id = ? AND caller_incarnation = ?
      AND pred_machine = ? AND pred_session_id = ? AND pred_incarnation = ?`)
      .all(owner, caller.machine, caller.session_id, caller.session_incarnation,
        predecessor.machine, predecessor.session_id, predecessor.session_incarnation) as unknown as SuccessionStopRow[];
    return rows.map(successionStopGrant);
  }

  #resumeMoveWrite<T>(write: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #resumeMoveRow(moveId: string): ResumeMoveRow | undefined {
    return this.#db.prepare("SELECT machine, signer, owner, digest, outcome FROM resume_move_receipt WHERE move_id = ?")
      .get(moveId) as unknown as ResumeMoveRow | undefined;
  }

  #resumeMoveAuthorized(key: ResumeMoveReceiptKey): boolean {
    return this.ownsSession(key.owner, key.originMachine, key.callerId, key.callerIncarnation);
  }

  /**
   * Bind an operation to an exact retained move, or reserve the one dispatch
   * after verified proof freshness. Without expiry evidence no row is created.
   * The global move constraint prevents retargeting even with a new operation.
   */
  claimResumeMove(key: ResumeMoveReceiptKey, proofExpiresAt?: number): ResumeMoveClaim {
    return this.#resumeMoveWrite(() => {
      if (!this.#resumeMoveAuthorized(key)) return { kind: "unavailable" };
      const row = this.#resumeMoveRow(key.moveId);
      if (row && row.owner !== key.owner) return { kind: "unavailable" };
      const scope = [key.originMachine, key.callerId, key.callerIncarnation, key.operationId] as const;
      const operation = this.#db.prepare(`
        SELECT move_id FROM resume_move_operation
        WHERE origin_machine = ? AND caller_id = ? AND caller_incarnation = ? AND operation_id = ?
      `).get(...scope);
      if (operation && operation.move_id !== key.moveId) return { kind: "conflict" };
      if (row && (row.machine !== key.machine || row.digest !== key.digest)) return { kind: "conflict" };
      if (row && row.signer !== key.signer) return { kind: "unavailable" };
      if (!row) {
        if (proofExpiresAt === undefined) return { kind: "missing" };
        if (!Number.isSafeInteger(proofExpiresAt)) return { kind: "unavailable" };
        if (proofExpiresAt <= Math.floor(Date.now() / 1000)) return { kind: "expired" };
        this.#db.prepare(`
          INSERT INTO resume_move_receipt (machine, move_id, signer, owner, digest, proof_expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(key.machine, key.moveId, key.signer, key.owner, key.digest, proofExpiresAt);
      }
      if (!operation) this.#db.prepare(`
        INSERT INTO resume_move_operation (origin_machine, caller_id, caller_incarnation, operation_id, move_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(...scope, key.moveId);
      return row ? { kind: "repeat", outcome: row.outcome === null ? null : JSON.parse(row.outcome) as ResumeMoveReply }
        : { kind: "claimed" };
    });
  }

  /** Commit the terminal reply and any Console grant together. */
  completeResumeMove(key: ResumeMoveReceiptKey, reply: ResumeMoveReply): ResumeMoveReply | null {
    return this.#resumeMoveWrite(() => {
      if (!this.#resumeMoveAuthorized(key)) return null;
      const row = this.#resumeMoveRow(key.moveId);
      if (!row || row.owner !== key.owner || row.machine !== key.machine
        || row.digest !== key.digest || row.signer !== key.signer) return null;
      if (row.outcome !== null) return JSON.parse(row.outcome) as ResumeMoveReply;
      const { body } = reply;
      if (body.ok) {
        const result = body.data;
        if (result.move_id !== key.moveId || result.machine !== key.machine || result.session_id !== `move-${key.moveId}`) return null;
        const grant = this.sessionGrant(key.machine, result.session_id);
        if (grant && (grant.principalId !== key.owner || grant.incarnation !== result.session_incarnation)) return null;
        if (!grant?.launcher) this.claimSession({
          principalId: key.owner, machine: key.machine, sessionId: result.session_id, incarnation: result.session_incarnation,
          launcher: { machine: key.originMachine, sessionId: key.callerId },
          ...(grant?.runtimeStartedAt ? { runtimeStartedAt: grant.runtimeStartedAt } : {}),
        });
      } else if (body.error.details.session_created !== false || body.error.details.move_id !== key.moveId) {
        return reply;
      }
      this.#db.prepare("UPDATE resume_move_receipt SET outcome = ? WHERE move_id = ?")
        .run(JSON.stringify(reply), key.moveId);
      return reply;
    });
  }

  // The verified expiry is dispensable once elapsed. Do not remove the
  // dispatch fence, its operation bindings or the outcome (including unknown).
  compactResumeMoveReceipts(now: number): void {
    this.#db.prepare("UPDATE resume_move_receipt SET proof_expires_at = NULL WHERE proof_expires_at <= ?").run(now);
  }

  // Sessions a service started on `machine`, across its generations.
  serviceStartSessions(relayMachine: string, serviceId: string, machine: string): ReadonlySet<string> {
    const rows = this.#db.prepare(`
      SELECT session_id FROM service_start_operation WHERE relay_machine = ? AND service_id = ? AND machine = ?
    `).all(relayMachine, serviceId, machine) as unknown as Array<{ session_id: string }>;
    return new Set(rows.map(row => row.session_id));
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

  advanceSessionContinuity(principalId: string, machine: string, sessionId: string,
    previousIncarnation: string, previousConversation: string, nextIncarnation: string, nextConversation: string): boolean {
    if (!nextIncarnation || !nextConversation) return false;
    const result = this.#db.prepare(`
      UPDATE session_ownership SET incarnation = ?, provider_session_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE machine = ? AND session_id = ? AND principal_id = ? AND incarnation = ? AND provider_session_id = ?
    `).run(nextIncarnation, nextConversation, machine, sessionId, principalId, previousIncarnation, previousConversation);
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

  /** The sessions recorded for a provider session, whoever owns them. */
  providerSessions(machine: string, provider: string, providerSessionId: string): Array<{ sessionId: string; principalId: string }> {
    const rows = this.#db.prepare(`
      SELECT session_id, principal_id FROM session_ownership
      WHERE machine = ? AND provider = ? AND provider_session_id = ?
    `).all(machine, provider, providerSessionId) as unknown as Array<{ session_id: string; principal_id: string }>;
    return rows.map(row => ({ sessionId: row.session_id, principalId: row.principal_id }));
  }

  historyGrant(machine: string, historyId: string): { principalId: string; provider: string; providerSessionId: string } | undefined {
    const row = this.#db.prepare(`
      SELECT principal_id, provider, provider_session_id FROM history_ownership WHERE machine = ? AND history_id = ?
    `).get(machine, historyId) as unknown as { principal_id: string; provider: string; provider_session_id: string } | undefined;
    return row ? { principalId: row.principal_id, provider: row.provider, providerSessionId: row.provider_session_id } : undefined;
  }

  ownsHistory(principalId: string, machine: string, historyId: string): boolean {
    const row = this.#db.prepare(`
      SELECT principal_id FROM history_ownership WHERE machine = ? AND history_id = ?
    `).get(machine, historyId) as unknown as OwnerRow | undefined;
    return row?.principal_id === principalId;
  }

  savePendingSessionClaim(claim: PendingSessionClaim): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM pending_session_claim WHERE expires_at <= ?").run(Date.now());
      const row = this.#db.prepare("SELECT count(*) AS count FROM pending_session_claim WHERE principal_id = ?").get(claim.principalId);
      if (Number(row?.count) >= 128) { this.#db.exec("ROLLBACK"); return false; }
      this.#db.prepare(`INSERT INTO pending_session_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(claim.machine, claim.sessionId, claim.principalId, claim.parentMachine, claim.parentId,
          claim.parentIncarnation, claim.operationId, JSON.stringify(claim.startMark), claim.expiresAt);
      this.#db.exec("COMMIT"); return true;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  pendingSessionClaims(): PendingSessionClaim[] {
    this.#db.prepare("DELETE FROM pending_session_claim WHERE expires_at <= ?").run(Date.now());
    const claims: PendingSessionClaim[] = [];
    let invalid = 0;
    for (const row of this.#db.prepare("SELECT * FROM pending_session_claim").all() as Array<Record<string, unknown>>) {
      try {
        claims.push({ machine: String(row.machine), sessionId: String(row.session_id), principalId: String(row.principal_id),
          parentMachine: String(row.parent_machine), parentId: String(row.parent_id), parentIncarnation: String(row.parent_incarnation),
          operationId: String(row.operation_id), startMark: JSON.parse(String(row.start_mark)) as SessionStartMark, expiresAt: Number(row.expires_at) });
      } catch { invalid++; }
    }
    if (invalid) console.warn(JSON.stringify({ code: "pending-session-recovery-failed", count: invalid }));
    return claims;
  }

  removePendingSessionClaim(claim: PendingSessionClaim): void {
    this.#db.prepare("DELETE FROM pending_session_claim WHERE machine = ? AND session_id = ? AND operation_id = ?")
      .run(claim.machine, claim.sessionId, claim.operationId);
  }

  removeMatchingPendingSessionClaim(claim: PendingSessionClaim, incarnation: string): void {
    this.#db.prepare(`DELETE FROM pending_session_claim WHERE machine = ? AND session_id = ? AND operation_id = ?
      AND EXISTS (SELECT 1 FROM session_ownership WHERE machine = ? AND session_id = ? AND principal_id = ? AND incarnation = ?)`)
      .run(claim.machine, claim.sessionId, claim.operationId, claim.machine, claim.sessionId, claim.principalId, incarnation);
  }

  settlePendingSessionClaim(claim: PendingSessionClaim, input: OwnershipImportInput): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.#db.prepare("SELECT operation_id FROM pending_session_claim WHERE machine = ? AND session_id = ? AND expires_at > ?")
        .get(claim.machine, claim.sessionId, Date.now());
      if (!pending || pending.operation_id !== claim.operationId
        || !this.ownsSession(claim.principalId, claim.parentMachine, claim.parentId, claim.parentIncarnation)
        || this.#db.prepare("SELECT 1 FROM machine_preferences WHERE principal_id = ? AND machine = ? AND enabled = 0").get(claim.principalId, claim.machine)
        || this.sessionGrant(claim.machine, claim.sessionId)) {
        this.#db.exec("ROLLBACK"); return false;
      }
      for (const session of input.sessions) this.claimSession(session);
      for (const provider of input.providers) this.claimProvider(input.principalId, provider.machine, provider.provider, provider.providerSessionId);
      this.#db.prepare("DELETE FROM pending_session_claim WHERE machine = ? AND session_id = ? AND operation_id = ?")
        .run(claim.machine, claim.sessionId, claim.operationId);
      this.#db.exec("COMMIT"); return true;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
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

  removeLayoutKeys(keys: readonly string[]): void {
    if (keys.length === 0) return;
    const removed = new Set(keys);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db.prepare("SELECT principal_id, order_json, revision FROM principal_layout").all() as Array<{ principal_id: string; order_json: string; revision: number }>;
      for (const row of rows) {
        const order = JSON.parse(row.order_json) as string[];
        const kept = order.filter(key => !removed.has(key));
        if (kept.length !== order.length) this.writeLayout(row.principal_id, kept, Number(row.revision));
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
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
