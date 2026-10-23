import type { HistorySession, HistorySessionsResponse } from "./types.ts";

// A profile the daemon resumes from its own session history (DSH) cannot import
// a provider id directly; Resume by ID finds the matching history entry first
// and then uses the daemon-owned history resume route.
export interface HistoryResumeTarget {
  readonly agentProfile: string;
  readonly providerSessionId: string;
  /** Profile label used in user-facing errors. */
  readonly label: string;
}

export type HistoryResumeResolution =
  | { readonly ok: true; readonly historyId: string }
  | { readonly ok: false; readonly error: string };

export interface HistoryEntryTarget {
  /** When set, only an entry under this agent profile matches. */
  readonly agentProfile?: string;
  readonly providerSessionId: string;
  /** Profile label used in user-facing errors. */
  readonly label: string;
}

export type HistoryEntryResolution =
  | { readonly ok: true; readonly session: HistorySession; readonly latestMessagePaging: boolean }
  | { readonly ok: false; readonly error: string };

export type HistorySessionLister = (
  machine: string,
  options: { readonly q?: string; readonly limit?: number; readonly cursor?: string },
) => Promise<Pick<
  HistorySessionsResponse,
  "ok" | "error" | "sessions" | "nextCursor" | "truncated" | "latestMessagePaging"
>>;

const HISTORY_LOOKUP_LIMIT = 50;
const HISTORY_LOOKUP_MAX_PAGES = 10;

export async function findHistoryEntry(
  machine: string,
  target: HistoryEntryTarget,
  listHistorySessions: HistorySessionLister,
): Promise<HistoryEntryResolution> {
  // The history search is a substring match, so keep only the exact id (under
  // the chosen profile, when one is given), following the cursor while other
  // entries crowd a page.
  let match: HistorySession | undefined;
  let cursor: string | undefined;
  let scanLimited = false;
  let latestMessagePaging = false;
  for (let pageIndex = 0; pageIndex < HISTORY_LOOKUP_MAX_PAGES; pageIndex += 1) {
    const page = await listHistorySessions(machine, {
      q: target.providerSessionId,
      limit: HISTORY_LOOKUP_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!page.ok) {
      return { ok: false, error: page.error ?? "Session history could not be searched." };
    }
    latestMessagePaging = page.latestMessagePaging === true;
    match = page.sessions.find((session) =>
      session.provider_session_id === target.providerSessionId
      && (target.agentProfile === undefined || session.agent_profile === target.agentProfile)
    );
    cursor = page.nextCursor;
    // `truncated` means the daemon hit its scan limit, so a miss is not proof
    // that the session is absent.
    scanLimited ||= page.truncated === true;
    if (match || !cursor) break;
  }
  if (!match && cursor) {
    return {
      ok: false,
      error: `Too many history entries match ${target.providerSessionId}; paste the full ${target.label} session ID.`,
    };
  }
  if (!match && scanLimited) {
    return {
      ok: false,
      error: `The ${machine} history scan limit was reached before ${target.label} session ${target.providerSessionId} was found.`,
    };
  }
  if (!match) {
    return {
      ok: false,
      error: `No ${target.label} session with ID ${target.providerSessionId} is in ${machine} history.`,
    };
  }
  return { ok: true, session: match, latestMessagePaging };
}

export async function resolveHistoryResumeTarget(
  machine: string,
  target: HistoryResumeTarget,
  listHistorySessions: HistorySessionLister,
): Promise<HistoryResumeResolution> {
  const found = await findHistoryEntry(machine, target, listHistorySessions);
  if (!found.ok) return found;
  if (!found.session.resumable) {
    return {
      ok: false,
      error: `${target.label} session ${target.providerSessionId} is in history but cannot be resumed.`,
    };
  }
  return { ok: true, historyId: found.session.id };
}
