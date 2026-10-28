import { sessionKey } from "./layout.ts";
import type { Session } from "./types.ts";

/** What a consumer learns from one refresh: the facts that changed, or why it failed. */
export type SessionRefreshOutcome =
  | { readonly ok: true; readonly changed: readonly string[] }
  | { readonly ok: false; readonly message: string };

// The facts a refresh re-reads. Lifecycle, location and activity stay with the list poll.
const REFRESHED_FIELDS = [
  "model", "reasoning_effort", "context_usage", "title", "title_revision", "title_state",
] as const;

/**
 * Apply a refreshed session record to the matching listed session. A record
 * for a replaced runtime (different incarnation) or an unlisted session changes
 * nothing; the next poll reconciles those.
 */
export function mergeRefreshedSession<T extends Session>(
  sessions: readonly T[],
  machine: string,
  record: Readonly<Record<string, unknown>>,
): readonly T[] {
  const key = sessionKey({ machine, id: String(record.id) });
  const index = sessions.findIndex(session => sessionKey(session) === key);
  const current = sessions[index];
  if (!current) return sessions;
  if (typeof record.session_incarnation === "string" && typeof current.session_incarnation === "string"
    && record.session_incarnation !== current.session_incarnation) return sessions;
  const patch: Record<string, unknown> = {};
  for (const field of REFRESHED_FIELDS) if (Object.hasOwn(record, field)) patch[field] = record[field];
  const next = sessions.slice();
  next[index] = { ...current, ...patch };
  return next;
}
