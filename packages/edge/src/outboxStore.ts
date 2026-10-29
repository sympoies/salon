import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SHARED_OUTBOX_MAX_ITEMS,
  type RefusedOutboxAction, type SharedOutboxItem, type SharedOutboxSnapshot } from "@agent-console/shared/shared-outbox";
import { normalizePromptReceipt, type PromptReceipt } from "@agent-console/shared/prompt-receipt";

export interface OutboxTarget {
  readonly principalId: string;
  readonly machine: string;
  readonly sessionId: string;
  readonly incarnation: string;
}
export interface OutboxAttempt {
  readonly target: OutboxTarget;
  readonly item: SharedOutboxItem;
  readonly credentialGeneration: string;
}
interface ItemRow {
  sequence: number;
  scope: string;
  id: string;
  admission_hash: string;
  credential_generation: string;
  next_attempt_at: number;
  native_handoff: number;
  value: string;
}
interface TargetRow { scope: string; target: string; revision: number; holds: string }
const key = (target: OutboxTarget) => JSON.stringify([target.principalId, target.machine, target.sessionId, target.incarnation]);
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
const STORE_MAX_ITEMS = 10_000;
const item = (row: ItemRow): SharedOutboxItem => JSON.parse(row.value) as SharedOutboxItem;
// A reply may still reach the provider while it waits for native handoff or its
// receipt is uncertain. Refused and migrated held rows are never dispatched.
const mayReachProvider = (row: ItemRow) => {
  const state = item(row).state;
  return state === "sending" || state === "unknown" || (state === "queued" && row.native_handoff === 1);
};
export class OutboxError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

/** Owns only outbox tables in the configured state DB. Transactions never span network I/O. */
export class OutboxStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    if (path === ":memory:") throw new OutboxError("outbox-durability-unavailable", 503);
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS outbox_targets (
        scope TEXT PRIMARY KEY, target TEXT NOT NULL, revision INTEGER NOT NULL, holds TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS outbox_items (
        sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL,
        admission_hash TEXT NOT NULL, credential_generation TEXT NOT NULL,
        next_attempt_at INTEGER NOT NULL, value TEXT NOT NULL, UNIQUE(scope,id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS outbox_items_scope ON outbox_items(scope,sequence);
      CREATE TABLE IF NOT EXISTS outbox_attempts (
        request_id TEXT PRIMARY KEY, scope TEXT NOT NULL, intent_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, receipt TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS outbox_cancellations (
        scope TEXT NOT NULL, id TEXT NOT NULL, admission_hash TEXT NOT NULL,
        value TEXT NOT NULL, PRIMARY KEY(scope,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS outbox_lifecycle (
        machine TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(machine,session_id)
      ) STRICT;
    `);
    // Old pending/held intentions retain their original policy and contents.
    // Only newly admitted intentions opt into immediate native handoff.
    this.#transaction(() => {
      const columns = this.#db.prepare("PRAGMA table_info(outbox_items)").all() as { name: string }[];
      if (!columns.some(column => column.name === "native_handoff")) {
        this.#db.exec("ALTER TABLE outbox_items ADD COLUMN native_handoff INTEGER NOT NULL DEFAULT 0");
      }
    });
  }
  close(): void { this.#db.close(); }
  #transaction<T>(action: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.#db.exec("COMMIT"); return result; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #target(target: OutboxTarget): TargetRow | undefined {
    return this.#db.prepare("SELECT * FROM outbox_targets WHERE scope=?").get(key(target)) as unknown as TargetRow | undefined;
  }
  #rows(target: OutboxTarget): ItemRow[] {
    return this.#db.prepare("SELECT * FROM outbox_items WHERE scope=? ORDER BY sequence").all(key(target)) as unknown as ItemRow[];
  }
  #count(): number {
    return (this.#db.prepare("SELECT count(*) AS count FROM outbox_items").get() as { count: number }).count;
  }
  /**
   * At capacity the oldest submitted/command_dispatched/cancelled rows make room, keeping the
   * newest `keep` rows untouched (#1051). Cancellation records also cover
   * pre-dispatch refusals, which have no attempt to fence a late PUT replay.
   */
  #prune(scope: string | null, keep: number): void {
    const where = scope === null ? "" : "scope=? AND";
    const args = scope === null ? [keep] : [scope, scope, keep];
    const older = `sequence < (SELECT min(sequence) FROM (SELECT sequence FROM outbox_items ${scope === null ? "" : "WHERE scope=?"} ORDER BY sequence DESC LIMIT ?))`;
    this.#db.prepare(`INSERT INTO outbox_cancellations(scope,id,admission_hash,value)
      SELECT scope,id,admission_hash,value FROM outbox_items
      WHERE ${where} json_extract(value,'$.state') = 'cancelled' AND ${older}`)
      .run(...args);
    this.#db.prepare(`DELETE FROM outbox_items WHERE ${where} json_extract(value,'$.state') IN ('submitted','command_dispatched','cancelled') AND ${older}`)
      .run(...args);
  }
  #row(target: OutboxTarget, id: string): ItemRow | undefined {
    return this.#db.prepare("SELECT * FROM outbox_items WHERE scope=? AND id=?").get(key(target), id) as unknown as ItemRow | undefined;
  }
  #ensure(target: OutboxTarget): void {
    this.#db.prepare("INSERT OR IGNORE INTO outbox_targets(scope,target,revision,holds) VALUES(?,?,0,'[]')")
      .run(key(target), JSON.stringify(target));
  }
  #bump(target: OutboxTarget): void {
    this.#db.prepare("UPDATE outbox_targets SET revision=revision+1 WHERE scope=?").run(key(target));
  }
  #write(target: OutboxTarget, value: SharedOutboxItem, nextAttemptAt = 0): SharedOutboxItem {
    const updated = { ...value, revision: value.revision + 1, updated_at: Date.now() };
    this.#db.prepare("UPDATE outbox_items SET value=?,next_attempt_at=? WHERE scope=? AND id=?")
      .run(JSON.stringify(updated), nextAttemptAt, key(target), value.id);
    this.#bump(target); return updated;
  }
  #lifecycleBlocked(target: OutboxTarget): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM outbox_lifecycle WHERE machine=? AND session_id=?")
      .get(target.machine, target.sessionId));
  }
  snapshot(target: OutboxTarget): SharedOutboxSnapshot {
    return this.#transaction(() => {
      const row = this.#target(target);
      return { revision: row?.revision ?? 0, items: this.#rows(target).map(item), compose_holds: row ? JSON.parse(row.holds) as string[] : [] };
    });
  }
  get(target: OutboxTarget, id: string): SharedOutboxItem | undefined {
    const row = this.#row(target, id);
    if (row) return item(row);
    const cancelled = this.#db.prepare("SELECT value FROM outbox_cancellations WHERE scope=? AND id=?")
      .get(key(target), id) as { value: string } | undefined;
    return cancelled ? JSON.parse(cancelled.value) as SharedOutboxItem : undefined;
  }
  admit(target: OutboxTarget, id: string, text: string, credentialGeneration: string): { created: boolean; item: SharedOutboxItem } {
    return this.#transaction(() => {
      const existing = this.#row(target, id);
      if (existing) {
        if (existing.admission_hash !== fingerprint(text)) throw new OutboxError("outbox-intent-conflict", 409);
        return { created: false, item: item(existing) };
      }
      const cancelled = this.#db.prepare("SELECT admission_hash,value FROM outbox_cancellations WHERE scope=? AND id=?")
        .get(key(target), id) as { admission_hash: string; value: string } | undefined;
      if (cancelled) {
        if (cancelled.admission_hash !== fingerprint(text)) throw new OutboxError("outbox-intent-conflict", 409);
        return { created: false, item: JSON.parse(cancelled.value) as SharedOutboxItem };
      }
      const pruned = this.#db.prepare("SELECT request_id, payload_hash, receipt FROM outbox_attempts WHERE scope=? AND intent_id=? ORDER BY rowid DESC LIMIT 1")
        .get(key(target), id) as { request_id: string; payload_hash: string; receipt: string | null } | undefined;
      if (pruned) {
        if (pruned.payload_hash !== fingerprint(JSON.stringify([text, false]))) throw new OutboxError("outbox-intent-conflict", 409);
        const receipt = pruned.receipt ? JSON.parse(pruned.receipt) as PromptReceipt : null;
        const now = Date.now();
        return { created: false, item: { id, text, session_incarnation: target.incarnation, state: receipt?.outcome ?? "unknown",
          revision: 1, created_at: now, updated_at: now, request_id: pruned.request_id, receipt, edit_hold: null, error_code: receipt?.code ?? null } };
      }
      if (this.#lifecycleBlocked(target)) throw new OutboxError("outbox-lifecycle-pending", 409);
      if (this.#rows(target).length >= SHARED_OUTBOX_MAX_ITEMS) this.#prune(key(target), SHARED_OUTBOX_MAX_ITEMS / 2);
      if (this.#count() >= STORE_MAX_ITEMS) this.#prune(null, STORE_MAX_ITEMS / 2);
      if (this.#rows(target).length >= SHARED_OUTBOX_MAX_ITEMS || this.#count() >= STORE_MAX_ITEMS) throw new OutboxError("outbox-capacity", 507);
      this.#ensure(target);
      const now = Date.now();
      const value: SharedOutboxItem = { id, text, session_incarnation: target.incarnation, state: "queued", revision: 1,
        created_at: now, updated_at: now, request_id: null, receipt: null, edit_hold: null, error_code: null };
      this.#db.prepare("INSERT INTO outbox_items(scope,id,admission_hash,credential_generation,next_attempt_at,value,native_handoff) VALUES(?,?,?,?,?,?,1)")
        .run(key(target), id, fingerprint(text), credentialGeneration, 0, JSON.stringify(value));
      this.#bump(target); return { created: true, item: value };
    });
  }
  actOnRefused(target: OutboxTarget, id: string, action: RefusedOutboxAction, credentialGeneration?: string): SharedOutboxItem {
    return this.#transaction(() => {
      const current = this.get(target, id);
      if (!current) throw new OutboxError("outbox-intent-not-found", 404);
      if (current.revision !== action.base_revision) throw new OutboxError("outbox-revision-conflict", 409);
      if (current.state !== "refused") throw new OutboxError("outbox-not-refused", 409);
      if (action.operation === "discard_refused") {
        // Keep the item and its refusal receipt as the durable discard record.
        return this.#write(target, { ...current, state: "cancelled" });
      }
      if (!credentialGeneration) throw new OutboxError("outbox-authorization-changed", 403);
      if (this.#lifecycleBlocked(target)) throw new OutboxError("outbox-lifecycle-pending", 409);
      this.#db.prepare("UPDATE outbox_items SET credential_generation=?,native_handoff=1 WHERE scope=? AND id=?")
        .run(credentialGeneration, key(target), id);
      // Prior attempt receipts remain in outbox_attempts. Claim allocates a new
      // request ID; replaying this action with its old revision cannot resend.
      return this.#write(target, { ...current, state: "queued", request_id: null, receipt: null, error_code: null, edit_hold: null });
    });
  }
  /** Caller authorizes this exact candidate after asynchronous daemon reads. Claim rechecks the transaction winner. */
  candidate(target: OutboxTarget, _now = Date.now()): OutboxAttempt | undefined {
    const rows = this.#rows(target);
    // A distinct new intent never resolves or replays an earlier unknown.
    // Native admission owns processing order; old holds cannot pause new input.
    const row = rows.find(row => row.native_handoff === 1 && item(row).state === "queued");
    if (!row) return undefined;
    const value = item(row);
    if (this.#lifecycleBlocked(target)) return undefined;
    return { target, item: value, credentialGeneration: row.credential_generation };
  }
  claim(candidate: OutboxAttempt, now = Date.now()): OutboxAttempt | undefined {
    return this.#transaction(() => {
      const current = this.candidate(candidate.target, now);
      if (!current || current.item.id !== candidate.item.id || current.item.revision !== candidate.item.revision) return undefined;
      const requestId = randomUUID();
      this.#db.prepare("INSERT INTO outbox_attempts(request_id,scope,intent_id,payload_hash) VALUES(?,?,?,?)")
        .run(requestId, key(current.target), current.item.id, fingerprint(JSON.stringify([current.item.text, false])));
      return { ...current, item: this.#write(current.target, { ...current.item, state: "sending", request_id: requestId, receipt: null, error_code: null }) };
    });
  }
  settle(attempt: OutboxAttempt, value: unknown): void {
    this.#transaction(() => {
      const current = this.get(attempt.target, attempt.item.id);
      if (!current || !["sending", "unknown"].includes(current.state) || current.request_id !== attempt.item.request_id) return;
      const identity = { request_id: current.request_id!, session_id: attempt.target.sessionId, session_incarnation: attempt.target.incarnation };
      const receipt: PromptReceipt = normalizePromptReceipt(value, identity)
        ?? { ...identity, outcome: "unknown", code: "structured-prompt-outcome-unknown" };
      if (current.state === "unknown" && JSON.stringify(current.receipt) === JSON.stringify(receipt)) return;
      this.#db.prepare("UPDATE outbox_attempts SET receipt=? WHERE request_id=?").run(JSON.stringify(receipt), identity.request_id);
      // Lookup can upgrade an unknown claim, never downgrade a terminal receipt.
      this.#write(attempt.target, { ...current, state: receipt.outcome,
        request_id: current.request_id, receipt, error_code: receipt.code });
    });
  }
  refuse(attempt: OutboxAttempt, code: string): void {
    this.#transaction(() => {
      const current = this.get(attempt.target, attempt.item.id);
      if (!current || current.revision !== attempt.item.revision) return;
      this.#write(attempt.target, { ...current, state: "refused", error_code: code, receipt: null, edit_hold: null });
    });
  }
  uncertain(target: OutboxTarget): OutboxAttempt[] {
    return this.#rows(target).filter(row => ["sending", "unknown"].includes(item(row).state))
      .map(row => ({ target, item: item(row), credentialGeneration: row.credential_generation }));
  }
  targets(): OutboxTarget[] {
    return (this.#db.prepare("SELECT target FROM outbox_targets ORDER BY scope").all() as { target: string }[])
      .map(row => JSON.parse(row.target) as OutboxTarget);
  }
  /** Permanent until a definite lifecycle refusal; an uncertain destructive call never reopens admission. */
  beginLifecycle(machine: string, sessionId: string): void {
    this.#transaction(() => {
      for (const target of this.targets().filter(target => target.machine === machine && target.sessionId === sessionId)) {
        if (this.#rows(target).some(mayReachProvider)) throw new OutboxError("outbox-pending-replies", 409);
      }
      // Only the operation that acquires this fence may reach upstream and
      // subsequently release it. A competing refusal cannot clear its owner.
      const acquired = this.#db.prepare("INSERT OR IGNORE INTO outbox_lifecycle(machine,session_id) VALUES(?,?)").run(machine, sessionId);
      if (acquired.changes !== 1) throw new OutboxError("outbox-lifecycle-pending", 409);
    });
  }
  releaseLifecycle(machine: string, sessionId: string): void {
    this.#db.prepare("DELETE FROM outbox_lifecycle WHERE machine=? AND session_id=?").run(machine, sessionId);
  }
}
