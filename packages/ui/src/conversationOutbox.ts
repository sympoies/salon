import { normalizePromptReceipt, type PromptReceipt } from "@agent-console/shared/prompt-receipt";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { lookupSessionPromptReceipt, submitSessionPrompt } from "./api.ts";
import { apiBase, nativeConnectionConfigGeneration, nativePrincipalIsActive } from "./runtime.ts";
import { getPrincipalStorageNamespace } from "./storage.ts";
import { parseTurnStateV1 } from "./sessionActivity.ts";
import { sessionKey } from "./layout.ts";
import { unwrapPastedContent } from "./pastedContent.ts";
import { isActivityTurnWaitingPhase } from "@agent-console/shared/activity";
import type { HistoryMessage, Session } from "./types.ts";
import type { ConversationReplyDrafts } from "./ConversationComposer.tsx";

export interface QueuedReply {
  readonly id: string;
  readonly text: string;
  readonly incarnation: string;
  readonly requestId: string;
  /** "delivered" keeps a submitted reply on screen until the transcript shows it (#969). */
  readonly state: "queued" | "dispatching" | "refused" | "unknown" | "delivered";
  readonly error?: string;
  readonly newAttempt?: boolean;
  /** Earliest retry after a definite pre-delivery idle-guarded busy refusal (#976). */
  readonly busyRetryAt?: number;
  /** The refusal's phase_changed_at; another receipt may release consumedIdle. */
  readonly busyRetryPhaseAt?: string;
  /** Sent to a busy Claude session without the idle guard (#943). */
  readonly handoff?: boolean;
  /** When the reply was queued; a busy hand-off waits out the grace window (#953). */
  readonly queuedAt?: number;
  /** Sent while the session was idle: keyed, without the idle guard while it stays idle (#969). */
  readonly direct?: boolean;
  /** Uncertain and still missing from a later turn's transcript; it never blocks (#973). */
  readonly unconfirmed?: boolean;
  /** When the latest attempt was claimed; only a later transcript turn proves it (#969). */
  readonly attemptedAt?: number;
  /** The idle phase (phase_changed_at) the attempt was made in; its paste may sit in the input while it lasts (#994). */
  readonly idlePhaseAt?: string;
}
interface Queue {
  readonly key: string;
  readonly namespace: string;
  readonly machine: string;
  readonly session: string;
  items: QueuedReply[];
  consumedIdle?: string;
  /** Monotonic per-incarnation observations shared by every window (#980 F1). */
  observedActivity?: { incarnation: string; revision: number };
  /** Transcript turns that already proved a reply; kept across reloads (#969). */
  provenTurns?: string[];
}
const EMPTY: readonly QueuedReply[] = [];
/**
 * A reply observed while working stays cancellable this long before daemon
 * admission (#953, #976). Reported-idle attempts are not delayed.
 */
export const QUEUED_REPLY_HANDOFF_GRACE_MS = 5000;
const QUEUED_REPLY_BUSY_RETRY_MS = 5000;
/**
 * An uncertain reply to an idle session that stays in that idle phase this
 * long did not start a turn, so it is shown as not confirmed (#994).
 */
export const UNCERTAIN_IDLE_REPLY_MS = 30_000;
/** How many proving transcript turns a queue remembers (#969). */
const PROVEN_TURNS_KEPT = 200;
const transcriptText = (text: string) => text.replace(/\s+/g, " ").trim();

/** When a reply was attempted. Rows stored before #971 fall back to their queue time (#973). */
const attemptTime = (item: QueuedReply) => item.attemptedAt ?? item.queuedAt ?? 0;
const NOT_CONFIRMED = "Not confirmed in the conversation. Retry sends it again.";
// A reply is never merged into an owner draft; the daemon refuses it before
// dispatch (#995, nils-cli#2622). Console sends no keys to clear the draft:
// the daemon's key route has no idle or incarnation fence (#1000 review F1).
const TERMINAL_DRAFT_ERRORS: Readonly<Record<string, string>> = {
  "composer-not-empty": "Terminal has a draft, so this reply was not sent. Clear it in the terminal, then Retry.",
  "composer-unobservable": "Console cannot read the terminal input, so this reply was not sent. Check the terminal, then Retry.",
};
const provable = (item: QueuedReply) => item.state === "unknown" || item.state === "dispatching" || item.state === "delivered"
  || (item.state === "refused" && item.unconfirmed === true);

/** A proven part of a transcript turn: the turn and the reply text it held. */
const provenKey = (turnId: string, text: string) => `${turnId}\u0000${text}`;

/** The daemon's mailbox nudge, which Claude Code may join with queued replies. */
const MAILBOX_NUDGE = /^Mailbox: \S+; agent-session message inbox/;

/**
 * Which attempted replies a transcript proves delivered, as reply id -> proven
 * key. A user turn at or after a reply's attempt proves it when the whole turn
 * is made of known pieces: this browser's attempted replies, parts already
 * spent on other replies, and the daemon's mailbox nudge. Claude Code joins
 * inputs queued during a turn into one user turn without a separator, so one
 * turn can prove several replies; a turn with any other text proves none, so a
 * short reply is never proven by an unrelated message that starts with it. A
 * bare turn id in `proven` (as stored by 0.3.50) spends the whole turn (#969,
 * #973).
 */
export function transcriptProof(items: readonly QueuedReply[], messages: readonly HistoryMessage[],
  proven: readonly string[] = []): Map<string, string> {
  const spent = new Map<string, string[]>();
  for (const key of proven) {
    const split = key.indexOf("\u0000");
    const id = split < 0 ? key : key.slice(0, split);
    spent.set(id, [...(spent.get(id) ?? []), split < 0 ? "" : key.slice(split + 1)]);
  }
  const pending = items.filter(provable);
  const matched = new Map<string, string>();
  for (const message of messages) {
    const at = Date.parse(message.timestamp ?? "");
    const parts = spent.get(message.id) ?? [];
    if (message.role !== "user" || !Number.isFinite(at) || parts.includes("")) continue;
    const candidates = pending.filter(item => !matched.has(item.id) && attemptTime(item) <= at);
    const used = candidates.length > 0 ? coverTurn(transcriptText(unwrapPastedContent(message.text)), candidates, parts) : undefined;
    // Spend the transcript text a reply used, which may show its images as
    // "[Image #N]", so the turn can still cover it as it grows (#1005 F2).
    for (const {item, part} of used ?? []) matched.set(item.id, provenKey(message.id, part));
  }
  return matched;
}

// Claude Code shows an image path it attached as "[Image #N]" in the user
// turn, and a non-queued turn adds "[Image: source: <path>]" (#1004). Uploads
// insert single-quoted paths; a bare path also counts.
const IMAGE_PATH = /'(?:[^']|'\\'')*\.(?:png|jpe?g|gif|webp)'|(?<![\w'])\/\S*\.(?:png|jpe?g|gif|webp)(?!\S)/gi;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A shell-quoted upload path as the file path Claude Code names. */
const unquotePath = (path: string) => path.startsWith("'") ? path.slice(1, -1).replaceAll("'\\''", "'") : path;

/**
 * The start of the turn that is this reply, literally or with its images shown
 * as "[Image #N]". A named source must be that image, in order. A reply with
 * no text of its own is tied to a turn only by its images' sources (#1005 F1).
 */
function replyPart(rest: string, text: string): string | undefined {
  const reply = transcriptText(text);
  if (!reply) return undefined;
  if (rest.startsWith(reply)) return reply;
  const parts = reply.split(IMAGE_PATH);
  if (parts.length === 1) return undefined;
  const paths = reply.match(IMAGE_PATH)!.map(unquotePath);
  const sourceNeeded = parts.every(part => !part.trim());
  const pattern = parts.map(part => escapeRegExp(part.trim())).reduce((joined, part, index) => {
    const source = `\\s*\\[Image: source: ${escapeRegExp(paths[index - 1]!)}\\]`;
    return `${joined}\\s*\\[Image #\\d+\\](?:${source})${sourceNeeded ? "" : "?"}\\s*${part}`;
  });
  return new RegExp(`^${pattern}`).exec(rest)?.[0].trim();
}

/** The upload paths a reply carries, in order. */
const imagePaths = (text: string) => (transcriptText(text).match(IMAGE_PATH) ?? []).map(unquotePath);

/** The replies, with the transcript text each used, that with spent parts and nudges make up the whole turn. */
function coverTurn(text: string, candidates: readonly QueuedReply[], spentParts: readonly string[]): { item: QueuedReply; part: string }[] | undefined {
  const search = (rest: string, available: readonly QueuedReply[], parts: readonly string[]): { item: QueuedReply; part: string }[] | undefined => {
    if (!rest) return [];
    // Parts already spent on other replies come first: they are in this turn.
    for (const part of new Set(parts)) {
      if (!rest.startsWith(part)) continue;
      const left = [...parts]; left.splice(left.indexOf(part), 1);
      const tail = search(rest.slice(part.length).trim(), available, left);
      if (tail) return tail;
    }
    for (const item of available) {
      const part = replyPart(rest, item.text);
      if (part === undefined) continue;
      // A placeholder without a named source cannot tell different images
      // apart: when another pending reply with other images matches the same
      // part, it proves neither (#1005 review F1).
      const paths = imagePaths(item.text);
      if (paths.length > (part.match(/\[Image: source: /g)?.length ?? 0)
        && available.some(other => other !== item && imagePaths(other.text).join("\u0000") !== paths.join("\u0000")
          && replyPart(rest, other.text) === part)) continue;
      const tail = search(rest.slice(part.length).trim(), available.filter(other => other !== item), parts);
      if (tail) return [{ item, part }, ...tail];
    }
    const nudge = MAILBOX_NUDGE.exec(rest);
    return nudge ? search(rest.slice(nudge[0].length).trim(), available, parts) : undefined;
  };
  const used = search(text, candidates, spentParts);
  return used && used.length > 0 ? used : undefined;
}
const stores = new Map<string, ConversationOutbox>();
const databases = new WeakMap<IDBFactory, Promise<IDBDatabase>>();

function database(): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error("Durable queued replies are unavailable in this browser."));
  const saved = databases.get(factory);
  if (saved) return saved;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("agent-console-conversation-outbox", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("queues", {keyPath:"key"}).createIndex("namespace","namespace");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Could not open queued reply storage."));
    request.onblocked = () => reject(new Error("Queued reply storage is blocked. Close older Console windows and try again."));
  });
  databases.set(factory, opening);
  return opening;
}

export function queuedReplyTargetAllowed(session: Session, reachable: boolean): boolean {
  const provider = session.provider_resume?.provider ?? session.agent;
  const state = parseTurnStateV1(session.turn_state);
  return reachable && session.status === "running" && Boolean(session.session_incarnation)
    && (provider === "codex" || provider === "claude") && Boolean(state)
    && !state?.current_turn?.attention && state?.phase !== "needs_input";
}

/**
 * Whether a queued reply may ask the daemon for admission. Codex always keeps
 * require_idle: its native idle check can replace stale hook progress (#976).
 * Claude also takes a busy-time reply into its own queue:
 * boundary-time prompts such as mailbox reminders can start the next turn
 * before a remote client sees the idle moment, so idle alone may never come
 * (#943).
 */
export function queuedReplyDeliverablePhase(session: Session): boolean {
  const phase = parseTurnStateV1(session.turn_state)?.phase;
  const provider = session.provider_resume?.provider ?? session.agent;
  return isActivityTurnWaitingPhase(phase)
    || ((provider === "claude" || provider === "codex") && (phase === "working" || phase === "starting"));
}

export class ConversationOutbox {
  private readonly queues = new Map<string, Queue>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private readonly sending = new Set<string>();
  private readonly delivering = new Set<string>();
  private readonly checking = new Set<string>();
  private readonly checked = new Set<string>();
  private readonly acknowledged = new Map<string, string>();
  /**
   * Open editors per reply in this window; it and those behind it wait (#969 C).
   * A count, since the tile and the full panel can both edit one reply.
   */
  private readonly deliveryObservations = new Map<string, {
    session: Session; reachable: boolean; draftEmpty: () => boolean; generation: number;
  }>();
  private readonly channel: BroadcastChannel | undefined;
  private graceWake: { readonly at: number; readonly timer: ReturnType<typeof setTimeout> } | undefined;
  readonly ready: Promise<void>;
  readonly namespace: string;
  constructor(namespace: string) {
    this.namespace = namespace;
    try {
      if (typeof window !== "undefined" && typeof window.BroadcastChannel === "function") {
        this.channel = new window.BroadcastChannel(`conversation-outbox:${namespace}`);
        this.channel.onmessage = () => { void this.refresh().catch(() => {}); };
      }
    } catch { /* IndexedDB still provides cross-window atomic claims. */ }
    this.ready = this.refresh();
    // Renderers can show a draft even when storage is unavailable. Destructive
    // actions verify storage separately and must not treat a failed load as empty.
    void this.ready.catch(() => {});
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly snapshot = () => this.version;
  isSending(id: string) { return this.sending.has(id); }
  lastAcknowledgement(session: Session) { return this.acknowledged.get(this.key(session)); }
  /** Spent transcript parts, one entry per proven reply, duplicates kept (#973). */
  provenTurnIds(session: Session): readonly string[] { return this.queues.get(this.key(session))?.provenTurns ?? []; }
  wake() { this.version++; for (const listener of this.listeners) listener(); }
  /** Replies Archive or Delete would lose: all but those proven delivered (#969, #973). */
  hasQueuedReplies(machine: string, id: string) {
    return Boolean(this.queues.get(JSON.stringify([this.namespace,machine,id]))?.items
      .some(item => item.state !== "delivered"));
  }
  async verifyQueuedReplies(machine: string, id: string): Promise<boolean> {
    await this.refresh();
    return this.hasQueuedReplies(machine,id);
  }
  private key(session: Session): string { return JSON.stringify([this.namespace, session.machine, session.id]); }
  items(session: Session): readonly QueuedReply[] { return this.queues.get(this.key(session))?.items ?? EMPTY; }
  private async refresh() {
    const db = await database();
    const rows = await new Promise<Queue[]>((resolve, reject) => {
      const request = db.transaction("queues").objectStore("queues").index("namespace").getAll(this.namespace);
      request.onsuccess = () => resolve(request.result as Queue[]);
      request.onerror = () => reject(new Error("Could not read queued replies."));
    });
    const before = JSON.stringify([...this.queues]);
    this.queues.clear();
    for (const row of rows) if (row.namespace === this.namespace) this.queues.set(row.key, row);
    if (JSON.stringify([...this.queues]) !== before) this.wake();
  }
  // The read, claim and write share one IDB transaction across all windows.
  // No lease expires: a persisted dispatch claim is never automatically replayed.
  private async change<T>(session: Session, edit: (queue: Queue) => T): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("queues", "readwrite"), store = tx.objectStore("queues");
      let queue: Queue, result: T, changed = false;
      const request = store.get(this.key(session));
      request.onsuccess = () => {
        queue = request.result as Queue | undefined ?? { key: this.key(session), namespace: this.namespace,
          machine: session.machine, session: session.id, items: [] };
        const before = JSON.stringify(queue);
        result = edit(queue);
        changed = JSON.stringify(queue) !== before;
        if (changed) store.put(queue);
      };
      tx.oncomplete = () => {
        const stale = JSON.stringify(this.queues.get(queue.key)) !== JSON.stringify(queue);
        this.queues.set(queue.key, queue);
        if (changed || stale) this.wake();
        if (changed) this.channel?.postMessage("changed");
        resolve(result);
      };
      tx.onabort = tx.onerror = () => reject(new Error("Could not save the queued reply. Your draft has been kept."));
    });
  }
  private locks(): LockManager {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) throw new Error("Queued delivery requires browser locking support. Your draft has been kept.");
    return locks;
  }
  private async exclusively<T>(session: Session, action: () => Promise<T>): Promise<T | undefined> {
    return this.locks().request(`conversation-outbox:${this.key(session)}`, {mode:"exclusive",ifAvailable:true}, async lock => {
      if (!lock) return;
      await this.refresh();
      return action();
    });
  }
  async enqueue(session: Session, text: string, { direct = false }: { readonly direct?: boolean } = {}) {
    this.locks();
    const id = crypto.randomUUID();
    await this.change(session, queue => { queue.items.push({ id, requestId: id, text, incarnation: session.session_incarnation!,
      state: "queued", queuedAt: Date.now(), ...(direct ? { direct: true } : {}) }); });
  }
  async retry(session: Session, id: string) {
    await this.change(session, queue => {
      // While its idle phase lasts, the uncertain paste may still sit in the
      // input, so the Retry keeps the idle guard (#994).
      queue.items = queue.items.map(item => item.id === id && item.state === "refused"
        ? { ...item, requestId: crypto.randomUUID(), state: "queued", error: undefined, unconfirmed: undefined,
          ...(mayHoldIdlePaste(item, session) ? { direct: undefined } : {}) } : item);
      queue.consumedIdle = undefined;
    });
  }
  async deliver(session: Session, reachable: boolean, draftEmpty: () => boolean) {
    const target = this.key(session);
    this.deliveryObservations.set(target, { session, reachable, draftEmpty, generation: nativeConnectionConfigGeneration() });
    const attempted = await this.exclusively(session, async () => {
      // Lock acquisition and IDB refresh can span a whole working/idle cycle.
      // Claim the latest observed epoch, and verify it again after IDB waits.
      const observed = this.deliveryObservations.get(target)!;
      const epoch = parseTurnStateV1(observed.session.turn_state)?.phase_changed_at;
      const current = () => {
        const latest = this.deliveryObservations.get(target)!;
        const state = parseTurnStateV1(latest.session.turn_state);
        return latest.session.session_incarnation === observed.session.session_incarnation
          && state?.phase_changed_at === epoch && queuedReplyDeliverablePhase(latest.session)
          && queuedReplyTargetAllowed(latest.session, latest.reachable)
          && observed.generation === nativeConnectionConfigGeneration()
          && nativePrincipalIsActive() && latest.draftEmpty();
      };
      const sent = await this.deliverClaim(observed.session, observed.reachable, current);
      const latest = this.deliveryObservations.get(target)!;
      return sent || latest.session.session_incarnation !== observed.session.session_incarnation
        || parseTurnStateV1(latest.session.turn_state)?.phase_changed_at !== epoch;
    });
    if (attempted) this.wake();
  }
  // One timer serves every queue's cancellation grace and definite-busy retry.
  private wakeAfter(ms: number) {
    const at = Date.now() + ms;
    if (this.graceWake && this.graceWake.at <= at) return;
    if (this.graceWake) clearTimeout(this.graceWake.timer);
    this.graceWake = { at, timer: setTimeout(() => { this.graceWake = undefined; this.wake(); }, ms) };
  }
  private async deliverClaim(session: Session, reachable: boolean, draftEmpty: () => boolean) {
    const state = parseTurnStateV1(session.turn_state);
    if (!state || !nativePrincipalIsActive()) return;
    const waiting = isActivityTurnWaitingPhase(state?.phase);
    const codex = (session.provider_resume?.provider ?? session.agent) === "codex";
    const idleGuard = codex || waiting;
    if (outboxNamespace() !== this.namespace) return;
    const target = this.key(session);
    if (this.delivering.has(target)) return;
    this.delivering.add(target);
    try {
      const idle = `${session.session_incarnation}:${state.phase_changed_at}`;
      let graceLeft = 0;
      const item = await this.change(session, queue => {
        // An uncertain reply is never sent again and never holds back the
        // replies behind it (#957, #973): a later idle-guarded attempt still
        // finds any leftover input and is refused as busy. A delivered reply
        // only waits to be seen in the transcript, and an unconfirmed one for
        // the owner's Retry or Cancel, or a late transcript turn (#969).
        const index = queue.items.findIndex(candidate => candidate.state !== "delivered" && candidate.state !== "unknown"
          && !(candidate.state === "refused" && candidate.unconfirmed));
        const head = queue.items[index];
        // A reply being edited holds the ones behind it, which keeps their order (#969 C).
        if (!head || head.incarnation !== session.session_incarnation) return null;
        // Turn-state revisions increase within an incarnation. Record even a
        // blocked phase (such as attention), so an older window cannot send
        // or move the shared retry fence backward after observing it.
        const observed = queue.observedActivity;
        if (observed?.incarnation === head.incarnation && state.revision < observed.revision) return null;
        queue.observedActivity = { incarnation: head.incarnation, revision: state.revision };
        // One successful guarded attempt per reported idle transition. A definite
        // busy refusal may retry; Codex's native idle guard owns admission even
        // when the hook snapshot stays Working (#976). Hand-offs go to
        // Claude's own queue, which keeps their order, so later replies follow
        // in the same turn instead of racing its turn boundary (#957).
        if (!queuedReplyTargetAllowed(session, reachable) || !queuedReplyDeliverablePhase(session) || !draftEmpty() || head.state !== "queued"
          // A direct reply goes at once, like the old direct send (#969, #993).
          || (waiting && queue.consumedIdle === idle && !head.newAttempt && !head.direct)) return null;
        if (idleGuard && head.newAttempt && head.busyRetryAt !== undefined
          && (!waiting || head.busyRetryPhaseAt === state.phase_changed_at)) {
          graceLeft = head.busyRetryAt - Date.now();
          if (graceLeft > 0) return null;
        }
        if (!waiting && head.queuedAt !== undefined) {
          graceLeft = head.queuedAt + QUEUED_REPLY_HANDOFF_GRACE_MS - Date.now();
          if (graceLeft > 0) return null;
        }
        const claimed: QueuedReply = { ...head, state: "dispatching", handoff: idleGuard ? undefined : true, attemptedAt: Date.now(),
          idlePhaseAt: waiting ? state.phase_changed_at : undefined, busyRetryAt: undefined, busyRetryPhaseAt: undefined,
          ...(head.newAttempt ? {requestId:crypto.randomUUID(),newAttempt:false} : {}) };
        queue.items[index] = claimed; queue.consumedIdle = idle;
        return claimed;
      });
      if (!item) {
        if (graceLeft > 0) this.wakeAfter(graceLeft);
        return;
      }
      if (!draftEmpty() || outboxNamespace() !== this.namespace) {
        await this.change(session, queue => {
          queue.items = queue.items.map(current => current.id === item.id ? { ...current, state: "queued" } : current);
          queue.consumedIdle = undefined;
        });
        return true;
      }
      this.sending.add(item.id); this.wake();
      try {
        const result = await submitSessionPrompt(session.machine, session.id, {
          text: item.text, expected_session_incarnation: item.incarnation,
          // A direct reply skips the idle guard only while the session is idle;
          // a Retry once Codex works keeps its native guard (#969, #976).
          request_id: item.requestId, ...(idleGuard && !(item.direct && waiting) ? { require_idle: true } : {}),
        });
        await this.settle(session, item, result.receipt, result.error, result.refusalCode);
      } catch {
        await this.settle(session, item, undefined, "Delivery may have happened. Check its receipt; this item will not be sent again.");
      } finally { this.sending.delete(item.id); this.wake(); }
      return true;
    } finally { this.delivering.delete(target); }
  }
  private async settle(session: Session, item: QueuedReply, value: PromptReceipt | undefined, error?: string, refusalCode?: string) {
    const receipt = normalizePromptReceipt(value, {session_id:session.id,session_incarnation:item.incarnation,request_id:item.requestId});
    const completed = await this.change(session, queue => {
      const current = queue.items.find(candidate => candidate.id === item.id && candidate.requestId === item.requestId);
      if (!current) return false;
      if (receipt?.outcome === "submitted") {
        queue.items = queue.items.map(candidate => candidate.id !== item.id ? candidate
          : { ...candidate, state: "delivered", error: undefined, newAttempt: undefined });
        return true;
      }
      const refused = receipt?.outcome === "refused" || refusalCode === "request-id-conflict" || refusalCode === "keyed-prompt-unsupported";
      const busy = receipt?.outcome === "refused" && receipt.code === "busy";
      const terminalDraft = receipt?.outcome === "refused" && receipt.code && Object.hasOwn(TERMINAL_DRAFT_ERRORS, receipt.code)
        ? TERMINAL_DRAFT_ERRORS[receipt.code] : undefined;
      if (refused && !busy) queue.consumedIdle = undefined;
      // An uncertain idle attempt does not use up the idle period: the next
      // idle-guarded attempt may go, and the daemon refuses it as busy if a
      // paste was left in the input (#973 G2).
      if (!refused && !item.handoff) queue.consumedIdle = undefined;
      queue.items = queue.items.map(candidate => candidate.id !== item.id ? candidate : {
        ...candidate, state: busy ? "queued" : refused ? "refused" : "unknown",
        newAttempt: busy, handoff: busy ? undefined : candidate.handoff,
        busyRetryAt: busy && !candidate.handoff ? Date.now() + QUEUED_REPLY_BUSY_RETRY_MS : undefined,
        busyRetryPhaseAt: busy && !candidate.handoff ? parseTurnStateV1(session.turn_state)?.phase_changed_at : undefined,
        error: busy ? "The session is busy or terminal input is in use. This reply remains queued."
          : terminalDraft ?? error ?? (receipt?.outcome === "refused" ? "The queued reply was refused."
          : "Delivery may have happened. Check its receipt; this item will not be sent again."),
      });
      return false;
    });
    if (completed) { this.acknowledged.set(this.key(session), item.id); this.wake(); }
  }
  /**
   * Settle replies the transcript proves delivered (see transcriptProof),
   * including one already shown as not confirmed. An uncertain reply the
   * transcript still lacks once a later turn has completed is shown as not
   * confirmed, with Retry and Cancel; it is never sent again on its own and
   * never removed silently (#969, #973).
   */
  async confirmFromTranscript(session: Session, messages: readonly HistoryMessage[]) {
    const attempted = (item: QueuedReply) => provable(item) && !this.sending.has(item.id);
    if (!this.items(session).some(attempted)) return;
    // A turn that began after an uncertain reply has completed, and this
    // transcript covers it: a reply still missing from it did not arrive.
    const last = parseTurnStateV1(session.turn_state)?.last_turn;
    const started = Date.parse(last?.started_at ?? ""), completed = Date.parse(last?.completed_at ?? "");
    const covered = Number.isFinite(started) && Number.isFinite(completed)
      && messages.some(message => Date.parse(message.timestamp ?? "") >= started);
    // Match inside the transaction, against the turns this queue already spent,
    // so a reload or another window never lets one turn prove two replies.
    const settled = await this.change(session, queue => {
      // A list, not a set: a turn that proved two identical replies keeps both parts (#973).
      const proven = queue.provenTurns ?? [];
      // A row stored without any time is stamped when first seen, so an older
      // identical turn can never prove it (#973 review N3).
      const now = Date.now();
      queue.items = queue.items.map(item => attempted(item) && item.attemptedAt === undefined && item.queuedAt === undefined
        ? { ...item, attemptedAt: now } : item);
      const delivered = transcriptProof(queue.items.filter(attempted), messages, proven);
      queue.items = queue.items.filter(item => !delivered.has(item.id)).map(item => covered && item.state === "unknown"
        && !this.sending.has(item.id) && attemptTime(item) <= started
        ? { ...item, state: "refused" as const, unconfirmed: true, error: NOT_CONFIRMED } : item);
      if (delivered.size === 0) return [];
      queue.provenTurns = [...proven, ...delivered.values()].slice(-PROVEN_TURNS_KEPT);
      return [...delivered.keys()];
    });
    if (settled.length === 0) return;
    this.acknowledged.set(this.key(session), settled.at(-1)!); this.wake();
  }
  /**
   * A delivered reply the transcript never matched leaves the conversation
   * once a turn that began after it has completed (#969). An uncertain one
   * stays until the transcript proves or disproves it (#973), or, attempted
   * while the session was idle, until that idle phase has lasted
   * UNCERTAIN_IDLE_REPLY_MS: no turn started, so it is shown as not confirmed,
   * with Retry and Cancel, and never sent again on its own (#994).
   */
  async expire(session: Session) {
    const stillIdle = (item: QueuedReply) => item.state === "unknown" && !this.sending.has(item.id)
      && item.incarnation === session.session_incarnation && mayHoldIdlePaste(item, session);
    const left = this.items(session).filter(stillIdle).map(item => attemptTime(item) + UNCERTAIN_IDLE_REPLY_MS - Date.now());
    if (left.some(ms => ms > 0)) this.wakeAfter(Math.min(...left.filter(ms => ms > 0)));
    if (left.some(ms => ms <= 0) && outboxNamespace() === this.namespace) {
      await this.change(session, queue => {
        queue.items = queue.items.map(item => stillIdle(item) && attemptTime(item) + UNCERTAIN_IDLE_REPLY_MS <= Date.now()
          ? { ...item, state: "refused" as const, unconfirmed: true, error: NOT_CONFIRMED } : item);
      });
    }
    const last = parseTurnStateV1(session.turn_state)?.last_turn;
    const started = Date.parse(last?.started_at ?? ""), completed = Date.parse(last?.completed_at ?? "");
    if (!Number.isFinite(started) || !Number.isFinite(completed)) return;
    const stale = (item: QueuedReply) => item.state === "delivered" && started >= attemptTime(item);
    if (!this.items(session).some(stale) || outboxNamespace() !== this.namespace) return;
    await this.change(session, queue => { queue.items = queue.items.filter(item => !stale(item)); });
  }
  async reconcile(session: Session, reachable: boolean) {
    if (!reachable) {
      for (const item of this.items(session)) {
        for (const observation of this.checked) if (observation.startsWith(`${item.requestId}:`)) this.checked.delete(observation);
      }
      return;
    }
    if (!nativePrincipalIsActive() || outboxNamespace() !== this.namespace || this.delivering.has(this.key(session))) return;
    // A receipt already checked in this phase needs no lock; holding it would
    // keep delivery of the replies behind it from running (#957).
    if (!this.pendingReceipt(session)) return;
    const generation = nativeConnectionConfigGeneration();
    // Delivery woken during the lookup found the lock taken; wake it again.
    if (await this.exclusively(session, () => this.reconcileClaim(session,generation))) this.wake();
  }
  // The receipt to look up next: one not yet checked in this phase, a
  // dispatching claim first. An uncertain hand-off can sit in front of a later
  // one, which must still be looked up (#957).
  private pendingReceipt(session: Session): QueuedReply | undefined {
    const pending = this.items(session).filter(item => (item.state === "unknown" || item.state === "dispatching")
      && !this.sending.has(item.id) && !this.checking.has(item.id)
      && !this.checked.has(receiptObservation(session, item)));
    return pending.find(item => item.state === "dispatching") ?? pending[0];
  }
  private async reconcileClaim(session: Session, generation: number) {
    if (generation !== nativeConnectionConfigGeneration() || !nativePrincipalIsActive() || outboxNamespace() !== this.namespace) return;
    const item = this.pendingReceipt(session);
    if (!item) return;
    this.checked.add(receiptObservation(session, item)); this.checking.add(item.id); this.wake();
    try {
      const result = await lookupSessionPromptReceipt(session.machine, session.id, item.requestId, item.incarnation);
      await this.settle(session, item, result.ok ? result.receipt : undefined, result.error);
    } finally { this.checking.delete(item.id); this.wake(); }
    return true;
  }

}

/** Whether the session is still in the idle phase the reply was attempted in (#994). */
export function mayHoldIdlePaste(item: QueuedReply, session: Session): boolean {
  const state = parseTurnStateV1(session.turn_state);
  return item.idlePhaseAt !== undefined && isActivityTurnWaitingPhase(state?.phase) && state?.phase_changed_at === item.idlePhaseAt;
}
function receiptObservation(session: Session, item: QueuedReply): string {
  return `${item.requestId}:${parseTurnStateV1(session.turn_state)?.phase_changed_at ?? "unavailable"}`;
}
function outboxNamespace(): string {
  return JSON.stringify([apiBase() || (typeof window === "undefined" ? "" : window.location.origin), getPrincipalStorageNamespace()]);
}
export function conversationOutbox(): ConversationOutbox {
  const namespace = outboxNamespace();
  let store = stores.get(namespace);
  if (!store) { store = new ConversationOutbox(namespace); stores.set(namespace, store); }
  return store;
}
export function useConversationOutbox(): ConversationOutbox {
  const store = conversationOutbox();
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return store;
}
export function useConversationOutboxDelivery(sessions: readonly Session[], reachable: ReadonlySet<string>, drafts: ConversationReplyDrafts) {
  const store = useConversationOutbox();
  const version = store.snapshot();
  const latest = useRef({sessions, reachable, drafts});
  latest.current = {sessions, reachable, drafts};
  useEffect(() => {
    for (const session of sessions) {
      void store.reconcile(session, reachable.has(session.machine)).catch(() => {});
      void store.expire(session).catch(() => {});
      if (!store.items(session).some(item => item.state === "queued")) continue;
      void store.deliver(session, reachable.has(session.machine), () => {
        const current = latest.current;
        const target = current.sessions.find(candidate => sessionKey(candidate) === sessionKey(session));
        if (!target || target.session_incarnation !== session.session_incarnation
          || !queuedReplyTargetAllowed(target, current.reachable.has(target.machine))
          || !queuedReplyDeliverablePhase(target)) return false;
        const draft = current.drafts.get(sessionKey(session));
        return !draft?.text && !draft?.sending && !draft?.outcomeUnknown;
      }).catch(() => {});
    }
  }, [store, version, sessions, reachable, drafts]);
}
