/**
 * Public keyed prompt delivery receipt from agent-session prompt/v2.
 * `command_dispatched` means an owner slash command opened its own UI; it is
 * terminal and is not model input.
 */
export interface PromptReceipt {
  readonly request_id: string;
  readonly session_id: string;
  readonly session_incarnation: string;
  readonly outcome: "submitted" | "command_dispatched" | "refused" | "unknown";
  readonly code: string | null;
}
export interface PromptReceiptIdentity {
  readonly request_id: string;
  readonly session_id: string;
  readonly session_incarnation: string;
}
export function isPromptRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}
export function isPromptIncarnation(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}
export function normalizePromptReceipt(value: unknown, expected: PromptReceiptIdentity): PromptReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isPromptRequestId(raw.request_id) || raw.request_id !== expected.request_id
    || raw.session_id !== expected.session_id || raw.session_incarnation !== expected.session_incarnation
    || !isPromptIncarnation(raw.session_incarnation)) return null;
  if (raw.outcome === "submitted" || raw.outcome === "command_dispatched" ? raw.code !== null
    : raw.outcome === "unknown" ? raw.code !== "structured-prompt-outcome-unknown"
    : raw.outcome === "refused" ? typeof raw.code !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(raw.code)
    : true) return null;
  return { request_id: raw.request_id, session_id: expected.session_id, session_incarnation: raw.session_incarnation,
    outcome: raw.outcome as PromptReceipt["outcome"], code: raw.code as string | null };
}
