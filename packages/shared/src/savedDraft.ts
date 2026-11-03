/** Metadata only; draft text is fetched separately on demand. */
export interface SavedDraft {
  readonly event: "stale_draft_stashed";
  readonly draft_id: string;
  readonly saved_at: string;
  readonly session_id: string;
  readonly bytes: number;
  readonly cleared: boolean;
  readonly session_incarnation?: string | null;
}

export function normalizeSavedDraft(value: unknown, sessionId: string): SavedDraft | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.event !== "stale_draft_stashed" || typeof raw.draft_id !== "string"
    || !/^[a-zA-Z0-9_-]{1,256}$/.test(raw.draft_id) || raw.session_id !== sessionId
    || typeof raw.saved_at !== "string" || !Number.isFinite(Date.parse(raw.saved_at))
    || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0 || Number(raw.bytes) > 65536
    || typeof raw.cleared !== "boolean"
    || (raw.session_incarnation !== undefined && raw.session_incarnation !== null
      && (typeof raw.session_incarnation !== "string" || raw.session_incarnation.length > 512))) return undefined;
  return { event: raw.event, draft_id: raw.draft_id, saved_at: raw.saved_at,
    session_id: sessionId, bytes: Number(raw.bytes), cleared: raw.cleared,
    ...(raw.session_incarnation === undefined ? {} : { session_incarnation: raw.session_incarnation as string | null }) };
}

export function normalizeSavedDraftInventory(value: unknown, sessionId: string): SavedDraft[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const drafts = (value as Record<string, unknown>).drafts;
  if (!Array.isArray(drafts) || drafts.length > 128) return undefined;
  const normalized = drafts.map(draft => normalizeSavedDraft(draft, sessionId));
  return normalized.every((draft): draft is SavedDraft => draft !== undefined) ? normalized : undefined;
}
