import { useEffect, useSyncExternalStore } from "react";
import { validOutboxText, type RefusedOutboxAction, type SharedOutboxItem, type SharedOutboxSnapshot } from "@agent-console/shared/shared-outbox";
import { actOnRefusedSharedOutbox, admitSharedOutbox, readSharedOutbox, SharedOutboxRequestError, type SharedOutboxTarget } from "./api.ts";
import { apiBase, nativeConnectionConfigGeneration, nativePrincipalIsActive } from "./runtime.ts";
import { getPrincipalStorageNamespace } from "./storage.ts";
import { transcriptProof } from "./conversationOutbox.ts";
import type { HistoryMessage, Session } from "./types.ts";

export interface LocalSharedAdmission {
  readonly id: string;
  readonly text: string;
  readonly created_at: number;
  readonly attempted: boolean;
}
export interface SharedClientTarget {
  readonly key: string;
  readonly namespace: string;
  readonly target: SharedOutboxTarget;
  readonly snapshot: SharedOutboxSnapshot;
  readonly admissions: readonly LocalSharedAdmission[];
  /** Recorded with the local intention, before any upload. Snapshots confer no ownership. */
  readonly localIntentIds?: readonly string[];
  /** Pre-ownership cached rows: preserve unresolved text without adopting new remote rows. */
  readonly unattributedIntentIds?: readonly string[];
  /** User-turn parts already observed for submitted rows; scoped by this target incarnation. */
  readonly submittedProofs?: Readonly<Record<string, string>>;
}
const emptySnapshot: SharedOutboxSnapshot = { revision: 0, items: [], compose_holds: [] };
function ownership(row: SharedClientTarget) {
  const localIntentIds = [...new Set([...(row.localIntentIds ?? []), ...row.admissions.map(item => item.id)])];
  const unattributedIntentIds = row.unattributedIntentIds ?? (row.localIntentIds === undefined
    ? row.snapshot.items.filter(item => !localIntentIds.includes(item.id)).map(item => item.id) : []);
  return { localIntentIds, unattributedIntentIds };
}
const databases = new WeakMap<IDBFactory, Promise<IDBDatabase>>();
function database(factory: IDBFactory | undefined): Promise<IDBDatabase> {
  if (!factory) return Promise.reject(new Error("Durable storage is unavailable. Your draft has been kept."));
  const existing = databases.get(factory);
  if (existing) return existing;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("agent-console-shared-admissions", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("targets", { keyPath: "key" }).createIndex("namespace", "namespace");
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(new Error("Could not open shared reply storage. Your draft has been kept."));
  });
  databases.set(factory, opening);
  return opening;
}
export function sharedOutboxNamespace(): string {
  return JSON.stringify([apiBase() || (typeof window === "undefined" ? "" : window.location.origin), getPrincipalStorageNamespace()]);
}
export function sharedOutboxTarget(session: Session): SharedOutboxTarget {
  if (!session.session_incarnation) throw new Error("This session cannot confirm a safe reply target.");
  return { machine: session.machine, id: session.id, incarnation: session.session_incarnation };
}
export function usesSharedOutbox(session: Session): boolean {
  const provider = session.provider_resume?.provider ?? session.agent;
  return (provider === "codex" || provider === "claude") && Boolean(session.session_incarnation);
}
function errorText(error: unknown): string {
  if (error instanceof SharedOutboxRequestError) {
    if (error.code === "outbox-principal-changed") return "Account changed. Sign in to the original account to reconcile this reply.";
    if (error.status === 401 || error.status === 403) return "Access changed. Sign in again to reconcile this reply.";
    if (error.code === "outbox-durability-unavailable") return "Shared replies are unavailable on this server. Your local text is kept.";
    if (error.code === "outbox-session-changed") return "This session restarted. The original reply has not been confirmed.";
    if (error.status === 507) return "The server reply queue is full. Your local text is kept.";
    if (error.status === 409) return "The reply changed on the server. Refresh before taking another action.";
  }
  return "Sync unconfirmed. Your text is kept; reconnect to check the same reply.";
}

/** This browser only uploads intentions. Provider dispatch belongs to the edge. */
export class SharedOutboxClient {
  readonly namespace: string;
  readonly ready: Promise<void>;
  private readonly generation = nativeConnectionConfigGeneration();
  private readonly db: Promise<IDBDatabase>;
  private rows = new Map<string, SharedClientTarget>();
  private errors = new Map<string, string>();
  private listeners = new Set<() => void>();
  private version = 0;
  private working = new Map<string, Promise<void>>();
  private watched = new Map<string, { target: SharedOutboxTarget; count: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private users = 0;
  private stopped = false;
  private currentSessions: readonly Session[] | undefined;
  constructor(namespace = sharedOutboxNamespace(), factory = globalThis.indexedDB) {
    this.namespace = namespace;
    this.db = database(factory);
    this.ready = this.reload().catch(() => { this.changed(); });
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  readonly snapshot = () => this.version;
  private changed() { this.version++; for (const listener of this.listeners) listener(); }
  private active(): boolean {
    return !this.stopped && this.namespace === sharedOutboxNamespace() && this.generation === nativeConnectionConfigGeneration() && nativePrincipalIsActive();
  }
  private requireActive() { if (!this.active()) throw new Error("Connection or account changed. Return to the original account to reconcile this reply."); }
  private key(target: SharedOutboxTarget) { return JSON.stringify([this.namespace, target.machine, target.id, target.incarnation]); }
  private initial(target: SharedOutboxTarget): SharedClientTarget {
    return { key: this.key(target), namespace: this.namespace, target, snapshot: emptySnapshot, admissions: [], localIntentIds: [], unattributedIntentIds: [] };
  }
  state(target: SharedOutboxTarget): SharedClientTarget { return this.rows.get(this.key(target)) ?? this.initial(target); }
  error(target: SharedOutboxTarget): string | undefined { return this.errors.get(this.key(target)); }
  targets(session: Session): readonly SharedClientTarget[] {
    return [...this.rows.values()].filter(row => row.target.machine === session.machine && row.target.id === session.id);
  }
  outgoingItems(row: SharedClientTarget): readonly SharedOutboxItem[] {
    const { localIntentIds, unattributedIntentIds } = ownership(row);
    return row.snapshot.items.filter(item => localIntentIds.includes(item.id)
      || (unattributedIntentIds.includes(item.id) && item.state !== "submitted"));
  }
  submittedProof(row: SharedClientTarget, messages: readonly HistoryMessage[]): Readonly<Record<string, string>> {
    const settled = row.submittedProofs ?? {};
    const matches = transcriptProof(this.outgoingItems(row).filter(item => item.state === "submitted" && !Object.hasOwn(settled, item.id)).map(item => ({
      id: item.id, text: item.text, incarnation: item.session_incarnation, requestId: item.request_id!,
      state: "delivered" as const, attemptedAt: item.created_at,
    })), messages, Object.values(settled));
    return matches.size ? { ...settled, ...Object.fromEntries(matches) } : settled;
  }
  async confirmSubmitted(target: SharedOutboxTarget, messages: readonly HistoryMessage[]): Promise<void> {
    const row = this.state(target), proof = this.submittedProof(row, messages);
    if (Object.keys(proof).length === Object.keys(row.submittedProofs ?? {}).length) return;
    // Merge under the journal transaction, so another pane/tab cannot undo a
    // handover or spend the same transcript part on two identical replies.
    await this.update(target, current => ({ ...current, submittedProofs: this.submittedProof(current, messages) }));
  }
  /** Read-only recovery of text left by the retired editor. Never replay it. */
  retainedEdits(session: Session): readonly { id: string; text: string }[] {
    return this.targets(session).flatMap(row => {
      const legacy = row as SharedClientTarget & { mutation?: { id?: unknown; body?: { operation?: unknown; text?: unknown } } };
      const pending = legacy.mutation;
      if (typeof pending?.id !== "string" || pending.body?.operation !== "save_edit" || !validOutboxText(pending.body.text)
        || row.snapshot.items.some(item => item.id === pending.id && item.text === pending.body?.text)) return [];
      return [{ id: `${row.key}:${pending.id}`, text: pending.body.text }];
    });
  }
  private async reload(): Promise<void> {
    const db = await this.db;
    const rows = await new Promise<SharedClientTarget[]>((resolve, reject) => {
      const request = db.transaction("targets").objectStore("targets").index("namespace").getAll(this.namespace);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (!this.active()) return;
    this.rows = new Map(rows.map(row => [row.key, row])); this.changed();
  }
  private async update(target: SharedOutboxTarget, change: (row: SharedClientTarget) => SharedClientTarget): Promise<SharedClientTarget> {
    this.requireActive();
    const db = await this.db;
    this.requireActive();
    const value = await new Promise<SharedClientTarget>((resolve, reject) => {
      const tx = db.transaction("targets", "readwrite"), store = tx.objectStore("targets");
      const request = store.get(this.key(target)); let next: SharedClientTarget;
      request.onsuccess = () => {
        try {
          this.requireActive();
          const current = request.result ?? this.initial(target);
          next = change({ ...current, ...ownership(current) }); store.put(next);
        }
        catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = tx.onabort = () => reject(new Error("Could not save shared reply state. Your draft has been kept."));
    });
    this.requireActive(); this.rows.set(value.key, value); this.changed(); return value;
  }
  private async acceptSnapshot(target: SharedOutboxTarget, snapshot: SharedOutboxSnapshot) {
    // PUT can acknowledge an item before the local snapshot revision advances.
    // An equal-revision delayed read cannot revoke that known ownership.
    return this.update(target, row => snapshot.revision < row.snapshot.revision ? row : { ...row, snapshot,
      localIntentIds: snapshot.revision > row.snapshot.revision
        ? row.localIntentIds!.filter(id => row.admissions.some(item => item.id === id) || snapshot.items.some(item => item.id === id)) : row.localIntentIds,
      unattributedIntentIds: snapshot.revision > row.snapshot.revision
        ? row.unattributedIntentIds!.filter(id => snapshot.items.some(item => item.id === id)) : row.unattributedIntentIds,
      admissions: row.admissions.filter(admission => !snapshot.items.some(item => item.id === admission.id)),
      submittedProofs: Object.fromEntries(Object.entries(row.submittedProofs ?? {}).filter(([id]) => snapshot.items.some(item => item.id === id))) });
  }
  async enqueue(session: Session, text: string): Promise<string> {
    this.requireActive();
    if (!usesSharedOutbox(session) || !validOutboxText(text)) throw new Error("This reply cannot be queued. Keep the draft and check the target and text.");
    const target = sharedOutboxTarget(session), id = crypto.randomUUID();
    await this.update(target, row => {
      if (row.admissions.length >= 256) throw new Error("This device's reply queue is full. Your draft has been kept.");
      return { ...row, localIntentIds: [...row.localIntentIds!, id],
        admissions: [...row.admissions, { id, text, created_at: Date.now(), attempted: false }] };
    });
    void this.sync(target).then(() => this.sync(target)); return id;
  }
  async actOnRefused(session: Session, target: SharedOutboxTarget, item: SharedOutboxItem,
    operation: RefusedOutboxAction["operation"]): Promise<void> {
    const key = this.key(target);
    try {
      this.requireActive();
      if (item.state !== "refused" || target.machine !== session.machine || target.id !== session.id
        || (operation === "retry_refused" && target.incarnation !== session.session_incarnation)) {
        throw new SharedOutboxRequestError(409, "outbox-session-changed");
      }
      // Server revision CAS arbitrates concurrent viewers and repeated clicks.
      // Never persist/replay a mutation whose acknowledgement may be lost.
      await actOnRefusedSharedOutbox(target, item, operation); this.requireActive();
      await this.sync(target);
    } catch (error) {
      if (this.active()) { this.errors.set(key, errorText(error)); this.changed(); }
    }
  }
  async sync(target: SharedOutboxTarget): Promise<void> {
    const key = this.key(target);
    const running = this.working.get(key);
    if (running) return running;
    if (!this.active() || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    const operation = this.synchronize(target).catch(error => {
      if (this.active()) { this.errors.set(key, errorText(error)); this.changed(); }
    }).finally(() => this.working.delete(key));
    this.working.set(key, operation); return operation;
  }
  private async synchronize(target: SharedOutboxTarget): Promise<void> {
    // A write-capable queue must be able to retain the authoritative response
    // before contacting the server; ready also resolves after a storage failure.
    await this.ready; await this.db; this.requireActive();
    let row = await this.acceptSnapshot(target, await readSharedOutbox(target)); this.requireActive();
    // The active host snapshot can disprove this target. Never upload an old
    // local intention to a replacement; historical server reads remain useful.
    const live = this.currentSessions?.find(session => session.machine === target.machine && session.id === target.id);
    const changedTarget = this.currentSessions !== undefined && (!live || live.session_incarnation !== target.incarnation);
    if (changedTarget && row.admissions.length) throw new SharedOutboxRequestError(409, "outbox-session-changed");
    for (const admission of row.admissions) {
      this.requireActive();
      // Persist uncertainty before the network call. Every replay uses this
      // original immutable intent ID and text, including crash-before-PUT.
      row = await this.update(target, current => ({ ...current, admissions: current.admissions.map(item => item.id === admission.id ? { ...item, attempted: true } : item) }));
      if (!row.admissions.some(item => item.id === admission.id)) continue;
      const item = await admitSharedOutbox(target, admission.id, admission.text); this.requireActive();
      await this.update(target, current => ({ ...current,
        admissions: current.admissions.filter(value => value.id !== admission.id),
        snapshot: { ...current.snapshot, items: [...current.snapshot.items.filter(value => value.id !== item.id), item] } }));
    }
    await this.acceptSnapshot(target, await readSharedOutbox(target)); this.requireActive();
    this.errors.delete(this.key(target)); this.changed();
  }
  private async tick() {
    if (!this.active()) return;
    await this.ready;
    await this.reload().catch(() => {});
    const targets = new Map([...this.watched].map(([key, value]) => [key, value.target]));
    for (const row of this.rows.values()) if (row.admissions.length) targets.set(row.key, row.target);
    // Serial target polling bounds outstanding native requests on reconnect.
    for (const target of targets.values()) { if (!this.active()) return; await this.sync(target); }
  }
  start(): () => void {
    this.users++;
    if (!this.timer) {
      this.timer = setInterval(() => { void this.tick(); }, 3_000);
      window.addEventListener("online", this.wake); window.addEventListener("focus", this.wake);
      void this.tick();
    }
    return () => {
      this.users--;
      if (this.users <= 0 && this.timer) {
        clearInterval(this.timer); this.timer = undefined;
        window.removeEventListener("online", this.wake); window.removeEventListener("focus", this.wake);
      }
    };
  }
  private readonly wake = () => { void this.tick(); };
  watch(target: SharedOutboxTarget): () => void {
    const key = this.key(target), existing = this.watched.get(key);
    this.watched.set(key, { target, count: (existing?.count ?? 0) + 1 });
    const stop = this.start(); void this.sync(target);
    return () => { const current = this.watched.get(key); if (current && current.count > 1) current.count--; else this.watched.delete(key); stop(); };
  }
  observe(sessions: readonly Session[]) { this.currentSessions = sessions; }
  close() { this.stopped = true; if (this.timer) clearInterval(this.timer); window.removeEventListener("online", this.wake); window.removeEventListener("focus", this.wake); }
}
const clients = new Map<string, SharedOutboxClient>();
export function sharedOutboxClient(): SharedOutboxClient {
  const namespace = sharedOutboxNamespace(), key = JSON.stringify([namespace, nativeConnectionConfigGeneration()]);
  let client = clients.get(key);
  if (!client) { client = new SharedOutboxClient(namespace); clients.set(key, client); }
  return client;
}
export function useSharedOutbox(session?: Session): SharedOutboxClient {
  const client = sharedOutboxClient();
  useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot);
  const machine = session?.machine, id = session?.id, incarnation = session?.session_incarnation;
  const enabled = session && usesSharedOutbox(session);
  useEffect(() => enabled && machine && id && incarnation ? client.watch({ machine, id, incarnation }) : undefined, [client, enabled, machine, id, incarnation]);
  return client;
}
export function useSharedOutboxSync(sessions: readonly Session[]) {
  const client = sharedOutboxClient(); client.observe(sessions);
  useEffect(() => client.start(), [client]);
}
