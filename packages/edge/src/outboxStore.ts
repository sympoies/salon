import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SHARED_OUTBOX_MAX_ITEMS,
  type RefusedOutboxAction, type SharedOutboxItem, type SharedOutboxSnapshot } from "@agent-console/shared/shared-outbox";
import type { EdgeOutboxInputKey, EdgeOutboxSource } from "./extensions.ts";
import { normalizePromptReceipt, type PromptReceipt } from "@agent-console/shared/prompt-receipt";

export interface OutboxTarget {
  readonly principalId: string;
  readonly machine: string;
  readonly sessionId: string;
  readonly incarnation: string;
}
export interface OutboxLifecycle {
  readonly machine: string;
  readonly sessionId: string;
  readonly incarnation: string | null;
  readonly ownerToken: string;
  readonly operation: "archive" | "maintenance-delete" | "delete" | "stop" | null;
}
export type StopState = "pending" | "stopped" | "refused" | "unknown";
export interface StopReceipt { readonly state: StopState }
/** The delegated successor and the absolute retry deadline an operation is bound to. */
export interface StopBinding {
  readonly delegationId: string;
  readonly callerMachine: string;
  readonly callerSessionId: string;
  readonly callerIncarnation: string;
  readonly retryUntilEpoch: number;
}
export interface StopOutcome { readonly stopResult?: "exited" | "already_stopped"; readonly code?: string }
export interface StopOperation extends StopBinding {
  readonly state: StopState;
  readonly stopResult: "exited" | "already_stopped" | null;
  readonly code: string | null;
}
export interface UnresolvedStop { readonly target: OutboxTarget; readonly operationId: string; readonly binding: StopBinding }
interface StopRow {
  principal_id: string; machine: string; session_id: string; incarnation: string; state: StopState;
  delegation_id: string; caller_machine: string; caller_session_id: string; caller_incarnation: string;
  retry_until_epoch: number; stop_result: "exited" | "already_stopped" | null; code: string | null;
}
export interface ExtensionOutboxGrant {
  readonly routeKey: string;
  readonly permission: string;
}
export interface ExtensionOutboxKey extends EdgeOutboxInputKey {
  readonly principalId: string;
  readonly extensionId: string;
}
export interface ExtensionOutboxInput {
  readonly target: OutboxTarget;
  readonly source: EdgeOutboxSource;
  readonly grant: ExtensionOutboxGrant;
}
interface ExtensionOutboxEntry extends ExtensionOutboxInput {
  readonly admissionHash: string;
  readonly item: Omit<SharedOutboxItem, "text" | "edit_hold">;
}
export interface OutboxAttempt {
  readonly target: OutboxTarget;
  readonly item: SharedOutboxItem;
  readonly credentialGeneration: string;
  readonly deviceId: string | null;
  readonly extensionGrant?: ExtensionOutboxGrant;
}
interface ItemRow {
  sequence: number;
  scope: string;
  id: string;
  admission_hash: string;
  credential_generation: string;
  device_id: string | null;
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
    let db: DatabaseSync | undefined;
    try {
      this.#db = db = new DatabaseSync(path);
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS outbox_targets (
          scope TEXT PRIMARY KEY, target TEXT NOT NULL, revision INTEGER NOT NULL, holds TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS outbox_items (
          sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL,
          admission_hash TEXT NOT NULL, credential_generation TEXT NOT NULL,
          next_attempt_at INTEGER NOT NULL, value TEXT NOT NULL, device_id TEXT, UNIQUE(scope,id)
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
        CREATE TABLE IF NOT EXISTS outbox_extension_inputs (
          principal_id TEXT NOT NULL, extension_id TEXT NOT NULL, channel TEXT NOT NULL, input_id TEXT NOT NULL,
          scope TEXT NOT NULL, intent_id TEXT NOT NULL, admission_hash TEXT NOT NULL, admission TEXT NOT NULL,
          retired_item TEXT, PRIMARY KEY(principal_id,extension_id,channel,input_id), UNIQUE(scope,intent_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS outbox_extension_inputs_intent
          ON outbox_extension_inputs(principal_id,extension_id,intent_id);
        CREATE TABLE IF NOT EXISTS outbox_stop_operations (
          operation_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, machine TEXT NOT NULL,
          session_id TEXT NOT NULL, incarnation TEXT NOT NULL, state TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS outbox_stop_blocks (
          machine TEXT NOT NULL, session_id TEXT NOT NULL, incarnation TEXT NOT NULL,
          operation_id TEXT NOT NULL, PRIMARY KEY(machine,session_id,incarnation)
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
        if (!columns.some(column => column.name === "device_id")) {
          this.#db.exec("ALTER TABLE outbox_items ADD COLUMN device_id TEXT");
        }
        const stops = this.#db.prepare("PRAGMA table_info(outbox_stop_operations)").all() as { name: string }[];
        for (const column of ["delegation_id", "caller_machine", "caller_session_id", "caller_incarnation"]) {
          if (!stops.some(existing => existing.name === column)) this.#db.exec(`ALTER TABLE outbox_stop_operations ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
        }
        if (!stops.some(column => column.name === "retry_until_epoch")) this.#db.exec("ALTER TABLE outbox_stop_operations ADD COLUMN retry_until_epoch INTEGER NOT NULL DEFAULT 0");
        for (const column of ["stop_result", "code"]) {
          if (!stops.some(existing => existing.name === column)) this.#db.exec(`ALTER TABLE outbox_stop_operations ADD COLUMN ${column} TEXT`);
        }
        const lifecycle = this.#db.prepare("PRAGMA table_info(outbox_lifecycle)").all() as { name: string }[];
        if (!lifecycle.some(column => column.name === "incarnation")) {
          this.#db.exec("ALTER TABLE outbox_lifecycle ADD COLUMN incarnation TEXT");
          this.#db.exec("ALTER TABLE outbox_lifecycle ADD COLUMN owner_token TEXT");
          this.#db.exec("ALTER TABLE outbox_lifecycle ADD COLUMN operation TEXT");
        }
        // Legacy rows gain identity, never guessed operation provenance.
        for (const row of this.#db.prepare("SELECT machine,session_id FROM outbox_lifecycle WHERE owner_token IS NULL").all() as { machine: string; session_id: string }[]) {
          this.#db.prepare("UPDATE outbox_lifecycle SET owner_token=? WHERE machine=? AND session_id=?")
            .run(randomUUID(), row.machine, row.session_id);
        }
      });
    } catch {
      try { db?.close(); } catch { /* Preserve the fixed refusal. */ }
      throw new OutboxError("outbox-durability-unavailable", 503);
    }
  }
  close(): void { this.#db.close(); }
  /** Read the attempt recorded before dispatch, even while its receipt is pending. */
  intentForRequest(target: OutboxTarget, requestId: string): string | undefined {
    const row = this.#db.prepare("SELECT intent_id FROM outbox_attempts WHERE request_id=? AND scope=?")
      .get(requestId, key(target)) as { intent_id: string } | undefined;
    return row?.intent_id;
  }

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
    const terminal = `${where} json_extract(value,'$.state') IN ('submitted','command_dispatched','cancelled') AND ${older}`;
    this.#db.prepare(`UPDATE outbox_extension_inputs SET retired_item=json_remove(retired.value,'$.text','$.edit_hold')
      FROM (SELECT scope,id,value FROM outbox_items WHERE ${terminal}) AS retired
      WHERE outbox_extension_inputs.scope=retired.scope AND intent_id=retired.id`).run(...args);
    this.#db.prepare(`DELETE FROM outbox_items WHERE ${terminal}`)
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
      .get(target.machine, target.sessionId)) || Boolean(this.#db.prepare(
        "SELECT 1 FROM outbox_stop_blocks WHERE machine=? AND session_id=? AND incarnation=?")
        .get(target.machine, target.sessionId, target.incarnation));
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
  extensionInput(input: ExtensionOutboxKey): ExtensionOutboxEntry | undefined {
    return this.#extensionInput("principal_id=? AND extension_id=? AND channel=? AND input_id=?",
      input.principalId, input.extensionId, input.channel, input.inputId);
  }

  /** Resolve only the admission owned by this principal and extension. */
  extensionInputForDelivery(principalId: string, extensionId: string,
    selector: { outboxIntentId: string } | { receiptRequestId: string }): ExtensionOutboxEntry | undefined {
    return "outboxIntentId" in selector
      ? this.#extensionInput("principal_id=? AND extension_id=? AND extension.intent_id=?",
        principalId, extensionId, selector.outboxIntentId)
      : this.#extensionInput(`principal_id=? AND extension_id=? AND (extension.scope,extension.intent_id)=
        (SELECT scope,intent_id FROM outbox_attempts WHERE request_id=?)`,
        principalId, extensionId, selector.receiptRequestId);
  }

  #extensionInput(where: string, ...parameters: string[]): ExtensionOutboxEntry | undefined {
    const row = this.#db.prepare(`SELECT admission, extension.admission_hash, COALESCE(json_remove(items.value,'$.text','$.edit_hold'),retired_item) AS item
      FROM outbox_extension_inputs AS extension LEFT JOIN outbox_items AS items
        ON items.scope=extension.scope AND items.id=extension.intent_id
      WHERE ${where}`).get(...parameters) as { admission: string; admission_hash: string; item: string } | undefined;
    if (!row) return undefined;
    return { ...JSON.parse(row.admission) as ExtensionOutboxInput,
      admissionHash: row.admission_hash, item: JSON.parse(row.item) as ExtensionOutboxEntry["item"] };
  }
  admitExtensionInput(input: ExtensionOutboxKey, admission: ExtensionOutboxInput, originalText: string,
    credentialGeneration: string, deviceId: string | null): { created: boolean; entry: ExtensionOutboxEntry } {
    const { target, source } = admission;
    const admissionHash = fingerprint(JSON.stringify([key(target), originalText, source.label, source.prefix]));
    return this.#transaction(() => {
      const existing = this.extensionInput(input);
      if (existing) {
        if (existing.admissionHash !== admissionHash) throw new OutboxError("outbox-intent-conflict", 409);
        return { created: false, entry: existing };
      }
      const intentId = randomUUID();
      const { item } = this.#admit(target, intentId, source.prefix + originalText, credentialGeneration, deviceId);
      this.#db.prepare(`INSERT INTO outbox_extension_inputs
        (principal_id,extension_id,channel,input_id,scope,intent_id,admission_hash,admission) VALUES(?,?,?,?,?,?,?,?)`)
        .run(input.principalId, input.extensionId, input.channel, input.inputId, key(target), intentId, admissionHash, JSON.stringify(admission));
      return { created: true, entry: { ...admission, admissionHash, item } };
    });
  }
  admit(target: OutboxTarget, id: string, text: string, credentialGeneration: string, deviceId: string | null = null): { created: boolean; item: SharedOutboxItem } {
    return this.#transaction(() => this.#admit(target, id, text, credentialGeneration, deviceId));
  }
  #admit(target: OutboxTarget, id: string, text: string, credentialGeneration: string, deviceId: string | null): { created: boolean; item: SharedOutboxItem } {
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
    this.#db.prepare("INSERT INTO outbox_items(scope,id,admission_hash,credential_generation,next_attempt_at,value,native_handoff,device_id) VALUES(?,?,?,?,?,?,1,?)")
      .run(key(target), id, fingerprint(text), credentialGeneration, 0, JSON.stringify(value), deviceId);
    this.#bump(target); return { created: true, item: value };
  }
  actOnRefused(target: OutboxTarget, id: string, action: RefusedOutboxAction, credentialGeneration?: string, deviceId: string | null = null): SharedOutboxItem {
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
      this.#db.prepare("UPDATE outbox_items SET credential_generation=?,device_id=?,native_handoff=1 WHERE scope=? AND id=?")
        .run(credentialGeneration, deviceId, key(target), id);
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
    const extension = this.#db.prepare("SELECT admission FROM outbox_extension_inputs WHERE scope=? AND intent_id=?")
      .get(row.scope, row.id) as { admission: string } | undefined;
    return { target, item: value, credentialGeneration: row.credential_generation, deviceId: row.device_id,
      ...(extension && { extensionGrant: (JSON.parse(extension.admission) as ExtensionOutboxInput).grant }) };
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
  /** Revoke only work that has not crossed the durable dispatch boundary. */
  refuseDevice(id: string): void {
    this.#transaction(() => {
      const rows = this.#db.prepare("SELECT * FROM outbox_items WHERE device_id=? AND json_extract(value,'$.state')='queued'")
        .all(id) as unknown as ItemRow[];
      for (const row of rows) {
        const targetRow = this.#db.prepare("SELECT target FROM outbox_targets WHERE scope=?").get(row.scope) as { target: string };
        const target = JSON.parse(targetRow.target) as OutboxTarget;
        this.#write(target, { ...item(row), state: "refused", error_code: "outbox-authorization-changed", receipt: null, edit_hold: null });
      }
    });
  }
  /** Retire obsolete intentions without retracting a confirmed provider outcome. */
  cancelUnconfirmed(target: OutboxTarget): void {
    this.#transaction(() => {
      for (const row of this.#rows(target)) {
        const current = item(row);
        if (["submitted", "command_dispatched", "cancelled"].includes(current.state)) continue;
        this.#write(target, { ...current, state: "cancelled", error_code: "outbox-session-changed", edit_hold: null });
      }
    });
  }
  uncertain(target: OutboxTarget): OutboxAttempt[] {
    return this.#rows(target).filter(row => ["sending", "unknown"].includes(item(row).state))
      .map(row => ({ target, item: item(row), credentialGeneration: row.credential_generation, deviceId: row.device_id }));
  }
  targets(): OutboxTarget[] {
    return (this.#db.prepare("SELECT target FROM outbox_targets ORDER BY scope").all() as { target: string }[])
      .map(row => JSON.parse(row.target) as OutboxTarget);
  }
  lifecycle(machine: string, sessionId: string): OutboxLifecycle | undefined {
    const row = this.#db.prepare("SELECT incarnation,owner_token,operation FROM outbox_lifecycle WHERE machine=? AND session_id=?")
      .get(machine, sessionId) as { incarnation: string | null; owner_token: string; operation: OutboxLifecycle["operation"] } | undefined;
    return row ? { machine, sessionId, incarnation: row.incarnation, ownerToken: row.owner_token, operation: row.operation } : undefined;
  }
  /** Uncertain unguarded deletion cannot be retired by an incarnation change. */
  beginLifecycle(machine: string, sessionId: string, incarnation: string | null, operation: Exclude<OutboxLifecycle["operation"], null | "stop">): OutboxLifecycle {
    return this.#transaction(() => {
      for (const target of this.targets().filter(target => target.machine === machine && target.sessionId === sessionId)) {
        if (this.#rows(target).some(mayReachProvider)) throw new OutboxError("outbox-pending-replies", 409);
      }
      // Only the operation that acquires this fence may reach upstream and
      // subsequently release it. A competing refusal cannot clear its owner.
      const fence = { machine, sessionId, incarnation, operation, ownerToken: randomUUID() };
      const acquired = this.#db.prepare("INSERT OR IGNORE INTO outbox_lifecycle(machine,session_id,incarnation,owner_token,operation) VALUES(?,?,?,?,?)")
        .run(machine, sessionId, incarnation, fence.ownerToken, operation);
      if (acquired.changes !== 1) throw new OutboxError("outbox-lifecycle-pending", 409);
      return fence;
    });
  }
  /** Bind an operation to its issuer, exact target, delegated successor and deadline while acquiring the shared lifecycle slot. */
  beginStop(target: OutboxTarget, operationId: string, binding: StopBinding): StopReceipt {
    return this.#transaction(() => {
      const existing = this.#stopRow(operationId);
      if (existing) {
        if (!this.#sameStop(existing, target, binding)) throw new OutboxError("operation-id-conflict", 409);
        return { state: existing.state };
      }
      if (this.#db.prepare("SELECT 1 FROM outbox_stop_blocks WHERE machine=? AND session_id=? AND incarnation=?")
        .get(target.machine, target.sessionId, target.incarnation))
        throw new OutboxError("outbox-lifecycle-pending", 409);
      for (const candidate of this.targets().filter(value => value.machine === target.machine &&
        value.sessionId === target.sessionId && value.incarnation === target.incarnation)) {
        if (this.#rows(candidate).some(mayReachProvider)) throw new OutboxError("outbox-pending-replies", 409);
      }
      const acquired = this.#db.prepare("INSERT OR IGNORE INTO outbox_lifecycle(machine,session_id,incarnation,owner_token,operation) VALUES(?,?,?,?,'stop')")
        .run(target.machine, target.sessionId, target.incarnation, operationId);
      if (acquired.changes !== 1) {
        const owner = this.lifecycle(target.machine, target.sessionId);
        throw new OutboxError(owner?.operation === "stop" ? "session-stop-busy" : "outbox-lifecycle-pending", 409);
      }
      this.#db.prepare(`INSERT INTO outbox_stop_operations(operation_id,principal_id,machine,session_id,incarnation,state,
        delegation_id,caller_machine,caller_session_id,caller_incarnation,retry_until_epoch) VALUES(?,?,?,?,?,'pending',?,?,?,?,?)`)
        .run(operationId, target.principalId, target.machine, target.sessionId, target.incarnation,
          binding.delegationId, binding.callerMachine, binding.callerSessionId, binding.callerIncarnation, binding.retryUntilEpoch);
      return { state: "pending" };
    });
  }
  #stopRow(operationId: string): StopRow | undefined {
    return this.#db.prepare("SELECT * FROM outbox_stop_operations WHERE operation_id=?").get(operationId) as unknown as StopRow | undefined;
  }
  #sameStop(row: StopRow, target: OutboxTarget, binding: StopBinding): boolean {
    return row.principal_id === target.principalId && row.machine === target.machine && row.session_id === target.sessionId
      && row.incarnation === target.incarnation && row.delegation_id === binding.delegationId && row.caller_machine === binding.callerMachine
      && row.caller_session_id === binding.callerSessionId && row.caller_incarnation === binding.callerIncarnation && row.retry_until_epoch === binding.retryUntilEpoch;
  }
  stopReceipt(target: OutboxTarget, operationId: string): StopReceipt {
    return { state: this.stopOperation(target, operationId).state };
  }
  stopOperation(target: OutboxTarget, operationId: string): StopOperation {
    const row = this.#db.prepare("SELECT * FROM outbox_stop_operations WHERE operation_id=? AND principal_id=? AND machine=? AND session_id=? AND incarnation=?")
      .get(operationId, target.principalId, target.machine, target.sessionId, target.incarnation) as unknown as StopRow | undefined;
    if (!row) throw new OutboxError("stop-operation-not-found", 404);
    return { state: row.state, stopResult: row.stop_result, code: row.code, delegationId: row.delegation_id, callerMachine: row.caller_machine,
      callerSessionId: row.caller_session_id, callerIncarnation: row.caller_incarnation, retryUntilEpoch: row.retry_until_epoch };
  }
  /** Operations whose outcome is not settled, for read-only reconciliation. */
  unresolvedStops(): UnresolvedStop[] {
    const rows = this.#db.prepare("SELECT * FROM outbox_stop_operations WHERE state IN ('pending','unknown')").all() as unknown as (StopRow & { operation_id: string })[];
    return rows.map(row => ({ operationId: row.operation_id, target: { principalId: row.principal_id, machine: row.machine, sessionId: row.session_id, incarnation: row.incarnation },
      binding: { delegationId: row.delegation_id, callerMachine: row.caller_machine, callerSessionId: row.caller_session_id, callerIncarnation: row.caller_incarnation, retryUntilEpoch: row.retry_until_epoch } }));
  }
  /** Invoke only after verified stop or a proven refusal before any effect. */
  resolveStop(target: OutboxTarget, operationId: string, result: "stopped" | "refused" | "unknown", outcome: StopOutcome = {}): StopReceipt {
    return this.#transaction(() => {
      const receipt = this.stopOperation(target, operationId);
      if (receipt.state !== "pending" && receipt.state !== "unknown") {
        if (receipt.state !== result || (outcome.stopResult ?? null) !== receipt.stopResult || (outcome.code ?? null) !== receipt.code) throw new OutboxError("operation-id-conflict", 409);
        return { state: receipt.state };
      }
      if (result === "unknown") {
        this.#db.prepare("UPDATE outbox_stop_operations SET state='unknown' WHERE operation_id=?").run(operationId);
        return { state: "unknown" };
      }
      if (result === "stopped" ? !outcome.stopResult || outcome.code !== undefined : !outcome.code || outcome.stopResult !== undefined) throw new Error("stop outcome does not match its state");
      const fence = this.#db.prepare("DELETE FROM outbox_lifecycle WHERE machine=? AND session_id=? AND incarnation=? AND owner_token=? AND operation='stop'")
        .run(target.machine, target.sessionId, target.incarnation, operationId);
      if (fence.changes !== 1) throw new OutboxError("outbox-lifecycle-pending", 409);
      if (result === "stopped") this.#db.prepare("INSERT OR IGNORE INTO outbox_stop_blocks VALUES(?,?,?,?)")
        .run(target.machine, target.sessionId, target.incarnation, operationId);
      this.#db.prepare("UPDATE outbox_stop_operations SET state=?,stop_result=?,code=? WHERE operation_id=?").run(result, outcome.stopResult ?? null, outcome.code ?? null, operationId);
      return { state: result };
    });
  }
  /** The snapshot must be captured before the asynchronous proof or operation. */
  releaseLifecycle(fence: OutboxLifecycle): boolean {
    if (fence.operation === "stop") return false;
    return this.#db.prepare("DELETE FROM outbox_lifecycle WHERE machine=? AND session_id=? AND owner_token=? AND incarnation IS ? AND operation IS ?")
      .run(fence.machine, fence.sessionId, fence.ownerToken, fence.incarnation, fence.operation).changes === 1;
  }
  releaseObsoleteLifecycle(fence: OutboxLifecycle, runningIncarnation: string): boolean {
    if (!["archive", "maintenance-delete"].includes(fence.operation ?? "") || fence.incarnation === null || fence.incarnation === runningIncarnation) return false;
    return this.releaseLifecycle(fence);
  }
  /** Owner-local repair supplies verified archive provenance; admission still needs replacement proof. */
  repairLegacyLifecycle(fence: OutboxLifecycle, incarnation: string): boolean {
    if (fence.incarnation !== null || fence.operation !== null) return false;
    return this.#db.prepare("UPDATE outbox_lifecycle SET incarnation=?,operation='archive' WHERE machine=? AND session_id=? AND owner_token=? AND incarnation IS NULL AND operation IS NULL")
      .run(incarnation, fence.machine, fence.sessionId, fence.ownerToken).changes === 1;
  }
}
