import { isPromptIncarnation, type PromptReceipt } from "./promptReceipt.ts";

/** Server admission is distinct from the daemon's provider submission receipt. */
export type SharedOutboxState = "queued" | "sending" | "submitted" | "command_dispatched" | "refused" | "unknown" | "cancelled";
export interface SharedOutboxItem {
  readonly id: string;
  readonly text: string;
  readonly session_incarnation: string;
  readonly state: SharedOutboxState;
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly request_id: string | null;
  readonly receipt: PromptReceipt | null;
  readonly edit_hold: string | null;
  /** Edge admission/identity failures are not fabricated daemon receipts. */
  readonly error_code: string | null;
}
export interface SharedOutboxSnapshot {
  readonly revision: number;
  readonly items: readonly SharedOutboxItem[];
  readonly compose_holds: readonly string[];
}
export interface OutboxAdmission {
  readonly expected_session_incarnation: string;
  readonly text: string;
}
export const SHARED_OUTBOX_MAX_TEXT_BYTES = 16 * 1024;
export const SHARED_OUTBOX_MAX_ITEMS = 256;
export const SHARED_OUTBOX_MAX_HOLDS = 16;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function validOutboxText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && new TextEncoder().encode(value).length <= SHARED_OUTBOX_MAX_TEXT_BYTES
    && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
export function normalizeOutboxAdmission(value: unknown): OutboxAdmission | null {
  const raw = record(value);
  return raw && only(raw, ["text", "expected_session_incarnation"])
    && isPromptIncarnation(raw.expected_session_incarnation) && validOutboxText(raw.text)
    ? { text: raw.text, expected_session_incarnation: raw.expected_session_incarnation } : null;
}

/** Only definitely refused replies can be discarded or explicitly retried. */
export interface RefusedOutboxAction {
  readonly operation: "discard_refused" | "retry_refused";
  readonly expected_session_incarnation: string;
  readonly base_revision: number;
}
export function normalizeRefusedOutboxAction(value: unknown): RefusedOutboxAction | null {
  const raw = record(value);
  return raw && only(raw, ["operation", "expected_session_incarnation", "base_revision"])
    && (raw.operation === "discard_refused" || raw.operation === "retry_refused")
    && isPromptIncarnation(raw.expected_session_incarnation)
    && Number.isSafeInteger(raw.base_revision) && Number(raw.base_revision) > 0
    ? { operation: raw.operation, expected_session_incarnation: raw.expected_session_incarnation, base_revision: Number(raw.base_revision) } : null;
}
