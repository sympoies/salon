/**
 * A mailbox read event (mailbox-read-events-v1) reduced to its display-safe wire
 * fields: one shape on every hop (edge projection, HTTP, snapshots), so
 * normalizing it again returns it unchanged. Incarnations, paths and
 * capabilities never appear.
 */
export interface MailboxEvent {
  readonly schema_version: "agent-session.mailbox-read-event.v1";
  readonly message_id: string;
  readonly sender: { readonly kind: "session"; readonly machine: string; readonly session_id: string }
    | { readonly kind: "service"; readonly machine: string; readonly service_id: string };
  readonly category: "uncategorized" | "progress" | "handoff" | "blocker" | "decision" | "report";
  readonly state: "read" | "acknowledged";
  readonly read_at: string | null;
  readonly acknowledged_at: string | null;
  readonly revision: number;
  readonly availability: "complete";
}

const SCHEMA = "agent-session.mailbox-read-event.v1";
const CATEGORIES = new Set(["uncategorized", "progress", "handoff", "blocker", "decision", "report"]);

function bounded(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function instant(value: unknown): string | null | undefined {
  if (value === null) return null;
  return bounded(value, 64);
}

/** A valid v1 event, or undefined: an unknown or malformed object leaves the message a plain notice. */
export function normalizeMailboxEvent(value: unknown): MailboxEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schema_version !== SCHEMA || raw.availability !== "complete") return undefined;
  const messageId = bounded(raw.message_id, 96);
  const category = typeof raw.category === "string" && CATEGORIES.has(raw.category) ? raw.category as MailboxEvent["category"] : undefined;
  const state = raw.state === "read" || raw.state === "acknowledged" ? raw.state : undefined;
  const readAt = instant(raw.read_at);
  const acknowledgedAt = instant(raw.acknowledged_at);
  const revision = typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 1 && raw.revision <= 1000 ? raw.revision : undefined;
  const sender = raw.sender && typeof raw.sender === "object" && !Array.isArray(raw.sender) ? raw.sender as Record<string, unknown> : undefined;
  const kind = sender?.kind === "session" || sender?.kind === "service" ? sender.kind : undefined;
  const machine = bounded(sender?.machine, 128);
  const senderId = bounded(kind === "service" ? sender?.service_id : sender?.session_id, 128);
  if (!messageId || !category || !state || readAt === undefined || acknowledgedAt === undefined || revision === undefined || !kind || !machine || !senderId) return undefined;
  return {
    schema_version: SCHEMA,
    message_id: messageId,
    sender: kind === "service" ? { kind, machine, service_id: senderId } : { kind, machine, session_id: senderId },
    category, state, read_at: readAt, acknowledged_at: acknowledgedAt, revision,
    availability: "complete",
  };
}
