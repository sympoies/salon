import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const RETENTION_MS = 7 * 86_400_000;
const MAX_MESSAGES = 1_000;
const MAX_ACK_KEYS = 64;
const MAX_REPLY_KEYS = 64;

const errors = {
  "invalid-request": [400, "Invalid request."],
  unauthorized: [401, "Unauthorized."],
  "device-required": [403, "Paired device credential required."],
  "cross-origin": [403, "Cross-origin request refused."],
  "confirmation-required": [403, "Physical confirmation required."],
  "source-forbidden": [403, "Source session is not permitted."],
  "message-not-found": [404, "Message is unavailable."],
  "receipt-not-found": [404, "Receipt is unavailable."],
  "method-not-allowed": [405, "Method not allowed."],
  "idempotency-key-conflict": [409, "Idempotency key conflicts with a previous request."],
  "reply-target-mismatch": [409, "Reply target differs from the message target."],
  "session-incarnation-conflict": [409, "Source session incarnation changed."],
  "cursor-expired": [410, "Cursor has no retained anchor."],
  "body-too-large": [413, "Request body is too large."],
  "inbox-full": [429, "Inbox has reached its retained message limit."],
  "ack-limit": [429, "Message has reached its acknowledgement key limit."],
  "reply-limit": [429, "Message has reached its reply key limit."],
  "inbox-error": [500, "Inbox operation failed."],
  "source-unavailable": [503, "Producer ingress or source snapshot is unavailable."],
} as const;
type ErrorCode = keyof typeof errors;

export class InboxError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode) {
    const [status, message] = errors[code];
    super(message);
    this.code = code;
    this.status = status;
  }
}

type AckState = "displayed" | "read";

export interface CompanionTarget {
  readonly machine: string;
  readonly session_id: string;
  readonly incarnation: string;
}

export interface CompanionReplyRequest {
  readonly idempotency_key: string;
  readonly message_id: string;
  readonly target: CompanionTarget;
  readonly text: string;
  readonly confirmation: "physical";
}

export type CompanionReplyStatus = "sent" | "busy" | "refused" | "uncertain";
export type CompanionReply = CompanionTarget & { receipt_id: string; status: CompanionReplyStatus };
export type ReplySelector = { field: "receipt_id" | "idempotency_key"; value: string };

interface MessageInput {
  readonly body: string;
  readonly color?: string;
  readonly urgent?: boolean;
  readonly target: CompanionTarget;
}
interface MessageRow {
  id: string;
  machine: string;
  session_id: string;
  incarnation: string;
  body: string;
  color: string | null;
  urgent: number | null;
  created_at: number;
}

export class CompanionInboxStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(path: string, now = Date.now) {
    this.#now = now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS companion_inbox_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        machine TEXT NOT NULL,
        session_id TEXT NOT NULL,
        incarnation TEXT NOT NULL,
        body TEXT NOT NULL,
        color TEXT,
        urgent INTEGER,
        created_at INTEGER NOT NULL,
        ack_state TEXT CHECK (ack_state IN ('displayed', 'read'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS companion_inbox_order ON companion_inbox_messages(owner, sequence);
      CREATE TABLE IF NOT EXISTS companion_inbox_acks (
        owner TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES companion_inbox_messages(id) ON DELETE CASCADE,
        requested_state TEXT NOT NULL CHECK (requested_state IN ('displayed', 'read')),
        receipt_state TEXT NOT NULL CHECK (receipt_state IN ('displayed', 'read')),
        PRIMARY KEY (owner, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS companion_inbox_message_acks ON companion_inbox_acks(message_id);
      CREATE TABLE IF NOT EXISTS companion_inbox_replies (
        owner TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES companion_inbox_messages(id) ON DELETE CASCADE,
        receipt_id TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'busy', 'refused', 'uncertain')),
        PRIMARY KEY (owner, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS companion_inbox_message_replies ON companion_inbox_replies(message_id);
    `);
  }

  close(): void {
    this.#db.close();
  }

  list(owner: string, cursor: string | null, limit: number) {
    const cutoff = this.#now() - RETENTION_MS;
    const anchor = cursor === null ? { sequence: 0 } : this.#db.prepare(`
      SELECT sequence FROM companion_inbox_messages WHERE owner=? AND id=? AND created_at>?
    `).get(owner, cursor, cutoff) as { sequence: number } | undefined;
    if (!anchor) throw new InboxError("cursor-expired");
    const rows = this.#db.prepare(`
      SELECT id, machine, session_id, incarnation, body, color, urgent, created_at
      FROM companion_inbox_messages WHERE owner=? AND sequence>? AND created_at>?
      ORDER BY sequence LIMIT ?
    `).all(owner, anchor.sequence, cutoff, limit) as unknown as MessageRow[];
    const messages = rows.map(row => ({
      id: row.id, sender: row.session_id, body: row.body, created_at: new Date(row.created_at).toISOString(),
      ...(row.color === null ? {} : { color: row.color }),
      ...(row.urgent === null ? {} : { urgent: Boolean(row.urgent) }),
      target: { machine: row.machine, session_id: row.session_id, incarnation: row.incarnation },
    }));
    return { messages, next_cursor: messages.at(-1)?.id ?? cursor };
  }

  enqueue(owner: string, message: MessageInput, assertSource: () => void): { id: string } {
    return this.#write(() => {
      // Read the current grant with the state database's writer lock held.
      assertSource();
      const now = this.#now();
      this.#expire(owner, now);
      const count = this.#db.prepare("SELECT count(*) AS total FROM companion_inbox_messages WHERE owner=?")
        .get(owner) as { total: number };
      if (count.total >= MAX_MESSAGES) throw new InboxError("inbox-full");
      const insert = this.#db.prepare(`
        INSERT INTO companion_inbox_messages (id, owner, machine, session_id, incarnation, body, color, urgent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
      `);
      for (let attempt = 0; attempt < 3; attempt++) {
        const id = randomBytes(8).readBigUInt64BE().toString();
        const { machine, session_id, incarnation } = message.target;
        const result = insert.run(id, owner, machine, session_id, incarnation, message.body, message.color ?? null,
          message.urgent === undefined ? null : Number(message.urgent), now);
        if (result.changes === 1) return { id };
      }
      throw new InboxError("inbox-error");
    });
  }

  ack(owner: string, id: string, key: string, requested: AckState, isAuthorized: () => boolean) {
    return this.#write(() => {
      // Recheck the captured device after body parsing and before state changes.
      if (!isAuthorized()) throw new InboxError("unauthorized");
      this.#expire(owner, this.#now());
      const message = this.#db.prepare("SELECT ack_state FROM companion_inbox_messages WHERE owner=? AND id=?")
        .get(owner, id) as { ack_state: AckState | null } | undefined;
      if (!message) throw new InboxError("message-not-found");
      const prior = this.#db.prepare(`
        SELECT message_id, requested_state, receipt_state FROM companion_inbox_acks WHERE owner=? AND idempotency_key=?
      `).get(owner, key) as { message_id: string; requested_state: AckState; receipt_state: AckState } | undefined;
      if (prior) {
        if (prior.message_id !== id || prior.requested_state !== requested) throw new InboxError("idempotency-key-conflict");
        return { id, state: prior.receipt_state };
      }
      const count = this.#db.prepare("SELECT count(*) AS total FROM companion_inbox_acks WHERE owner=? AND message_id=?")
        .get(owner, id) as { total: number };
      if (count.total >= MAX_ACK_KEYS) throw new InboxError("ack-limit");
      const state = message.ack_state === "read" ? "read" : requested;
      if (message.ack_state !== state) {
        this.#db.prepare("UPDATE companion_inbox_messages SET ack_state=? WHERE owner=? AND id=?").run(state, owner, id);
      }
      this.#db.prepare(`
        INSERT INTO companion_inbox_acks (owner, idempotency_key, message_id, requested_state, receipt_state)
        VALUES (?, ?, ?, ?, ?)
      `).run(owner, key, id, requested, state);
      return { id, state };
    });
  }

  claimReply(owner: string, request: CompanionReplyRequest, isAuthorized: () => boolean) {
    const { idempotency_key: key, message_id: messageId, target, text, confirmation } = request;
    const fingerprint = createHash("sha256").update(JSON.stringify([
      messageId, target.machine, target.session_id, target.incarnation, text, confirmation,
    ])).digest("hex");
    return this.#write(() => {
      if (!isAuthorized()) throw new InboxError("unauthorized");
      this.#expire(owner, this.#now());
      const message = this.#db.prepare(`
        SELECT machine, session_id, incarnation FROM companion_inbox_messages WHERE owner=? AND id=?
      `).get(owner, messageId) as CompanionTarget | undefined;
      if (!message) throw new InboxError("message-not-found");
      const prior = this.#db.prepare(`
        SELECT receipt_id, status, fingerprint FROM companion_inbox_replies WHERE owner=? AND idempotency_key=?
      `).get(owner, key) as (Pick<CompanionReply, "receipt_id" | "status"> & { fingerprint: string }) | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new InboxError("idempotency-key-conflict");
        return { claimed: false, reply: { ...message, receipt_id: prior.receipt_id, status: prior.status } };
      }
      if (target.machine !== message.machine || target.session_id !== message.session_id
        || target.incarnation !== message.incarnation) throw new InboxError("reply-target-mismatch");
      const count = this.#db.prepare("SELECT count(*) AS total FROM companion_inbox_replies WHERE message_id=?")
        .get(messageId) as { total: number };
      if (count.total >= MAX_REPLY_KEYS) throw new InboxError("reply-limit");
      const reply: CompanionReply = { ...message, receipt_id: randomUUID(), status: "uncertain" };
      this.#db.prepare(`
        INSERT INTO companion_inbox_replies (owner, idempotency_key, message_id, receipt_id, fingerprint, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(owner, key, messageId, reply.receipt_id, fingerprint, reply.status);
      return { claimed: true, reply };
    });
  }

  lookupReply(owner: string, selector: ReplySelector): CompanionReply {
    const column = selector.field === "receipt_id" ? "receipt_id" : "idempotency_key";
    const reply = this.#db.prepare(`
      SELECT r.receipt_id, r.status, m.machine, m.session_id, m.incarnation
      FROM companion_inbox_replies r JOIN companion_inbox_messages m ON r.message_id = m.id
      WHERE r.owner=? AND r.${column}=? AND m.created_at>?
    `).get(owner, selector.value, this.#now() - RETENTION_MS) as CompanionReply | undefined;
    if (!reply) throw new InboxError("receipt-not-found");
    return reply;
  }

  settleReply(owner: string, id: string, status: CompanionReplyStatus): CompanionReplyStatus {
    if (status !== "uncertain") {
      this.#db.prepare(`
        UPDATE companion_inbox_replies SET status=? WHERE owner=? AND receipt_id=? AND status='uncertain'
      `).run(status, owner, id);
    }
    const settled = this.#db.prepare("SELECT status FROM companion_inbox_replies WHERE owner=? AND receipt_id=?")
      .get(owner, id) as { status: CompanionReplyStatus } | undefined;
    return settled?.status ?? status;
  }

  #expire(owner: string, now: number): void {
    this.#db.prepare("DELETE FROM companion_inbox_messages WHERE owner=? AND created_at<=?").run(owner, now - RETENTION_MS);
  }

  #write<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
