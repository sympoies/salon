import { sessionKey } from "./layout.ts";
import type { Session } from "./types.ts";

/** What a consumer learns from one refresh: the facts that changed, or why it failed. */
export type SessionRefreshOutcome =
  | { readonly ok: true; readonly changed: readonly string[] }
  | { readonly ok: false; readonly message: string };

// The facts a refresh re-reads. Lifecycle, location and activity stay with the list poll.
const REFRESHED_FIELDS = ["model", "reasoning_effort"] as const;
const TITLE_FIELDS = ["title", "title_revision", "title_state"] as const;

/** The merged list, and whether the record was applied to a listed session. */
export interface SessionRefreshMerge<T extends Session> {
  readonly sessions: readonly T[];
  readonly applied: boolean;
}

function observedAt(usage: unknown): number {
  const value = usage && typeof usage === "object" ? (usage as { observed_at?: unknown }).observed_at : undefined;
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/**
 * Apply a refreshed session record to the matching listed session. The reply
 * belongs to the runtime the request was made for (`requestedIncarnation`), so
 * a listed session that is gone or has since been replaced, and a reply naming
 * another incarnation, change nothing; the next poll reconciles those. Title
 * and context facts that are already newer in the list are kept.
 */
export function mergeRefreshedSession<T extends Session>(
  sessions: readonly T[],
  machine: string,
  record: Readonly<Record<string, unknown>>,
  requestedIncarnation: string | undefined,
): SessionRefreshMerge<T> {
  const key = sessionKey({ machine, id: String(record.id) });
  const index = sessions.findIndex(session => sessionKey(session) === key);
  const current = sessions[index];
  if (!current || current.session_incarnation !== requestedIncarnation) return { sessions, applied: false };
  if (typeof record.session_incarnation === "string" && typeof current.session_incarnation === "string"
    && record.session_incarnation !== current.session_incarnation) return { sessions, applied: false };
  const patch: Record<string, unknown> = {};
  for (const field of REFRESHED_FIELDS) if (Object.hasOwn(record, field)) patch[field] = record[field];
  const listedRevision = current.title_revision;
  const staleTitle = typeof listedRevision === "number"
    && !(typeof record.title_revision === "number" && record.title_revision >= listedRevision);
  if (!staleTitle) for (const field of TITLE_FIELDS) if (Object.hasOwn(record, field)) patch[field] = record[field];
  if (Object.hasOwn(record, "context_usage") && !(observedAt(record.context_usage) < observedAt(current.context_usage))) {
    patch.context_usage = record.context_usage;
  }
  const next = sessions.slice();
  next[index] = { ...current, ...patch };
  return { sessions: next, applied: true };
}
