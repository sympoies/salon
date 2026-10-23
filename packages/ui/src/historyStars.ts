// Star ordering for the History panel.
//
// The daemon owns the star and already returns its pages in this order, so the
// UI only needs to reproduce it for a toggle: starred sessions lead, newest star
// first, and the unstarred remainder keeps the recency order the list always had.
//
// Only the loaded page is reordered. A row starred from page two rises to the
// top of that page, not to page one, and the next load reconciles it — the
// daemon stays the source of truth for placement across pages.
import type { HistorySession } from "./types.ts";

function compareHistorySessions(left: HistorySession, right: HistorySession): number {
  const leftStar = left.starred_at;
  const rightStar = right.starred_at;
  if (Boolean(leftStar) !== Boolean(rightStar)) return leftStar ? -1 : 1;
  if (leftStar && rightStar && leftStar !== rightStar) return leftStar < rightStar ? 1 : -1;
  if (left.updated_at !== right.updated_at) return left.updated_at < right.updated_at ? 1 : -1;
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? 1 : -1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function sortHistorySessions(
  sessions: readonly HistorySession[],
): readonly HistorySession[] {
  return [...sessions].sort(compareHistorySessions);
}

/**
 * Apply one star toggle to a loaded page. `starredAt` is the timestamp the
 * daemon stored, or `undefined` when the star was cleared. A history id that is
 * not on this page leaves the list untouched — the row may live on another page,
 * and the daemon remains the source of truth either way.
 */
export function applyHistoryStar(
  sessions: readonly HistorySession[],
  historyId: string,
  starredAt: string | undefined,
): readonly HistorySession[] {
  if (!sessions.some((session) => session.id === historyId)) return sessions;
  return sortHistorySessions(sessions.map((session) => {
    if (session.id !== historyId) return session;
    const { starred_at: _cleared, ...rest } = session;
    return starredAt ? { ...rest, starred_at: starredAt } : rest;
  }));
}
