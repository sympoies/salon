import { autoLayoutMode, sessionKey, type LayoutMode } from "./layout.ts";
import type { Session } from "./types.ts";
import { isDshAgent } from "./dshAgent.ts";
import { isCoordinatorTreeMember } from "./coordinatorTree.ts";

export interface SessionListHarnessOption {
  readonly id: string;
  readonly label: string;
}

export function sessionListHarness(session: Pick<Session, "agent">): string {
  return isDshAgent(session.agent) ? "dsh" : session.agent;
}

export function sessionListHarnessLabel(harness: string): string {
  switch (harness) {
    case "codex": return "Codex";
    case "claude": return "Claude";
    case "dsh": return "DSH";
    default: return harness;
  }
}

export function deriveSessionListHarnessOptions(sessions: readonly Session[]): SessionListHarnessOption[] {
  return [...new Set(sessions.map(sessionListHarness))]
    .map((id) => ({ id, label: sessionListHarnessLabel(id) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export interface SessionListPage {
  readonly page: number | null;
  readonly pageCount: number;
  readonly sessionKeys: readonly string[];
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export function filterSessionListSessions({
  sessions,
  machine = null,
  harness = null,
  coordinatorTrees = false,
}: {
  readonly sessions: readonly Session[];
  readonly machine?: string | null;
  readonly harness?: string | null;
  /** Only sessions in a coordinator tree. */
  readonly coordinatorTrees?: boolean;
}): Session[] {
  return sessions.filter((session) =>
    (machine === null || session.machine === machine)
    && (harness === null || sessionListHarness(session) === harness)
    && (!coordinatorTrees || isCoordinatorTreeMember(session)),
  );
}

/** How many sessions a filter choice would list: `all` is its unfiltered option. */
export interface SessionListChoiceCount {
  readonly all: number;
  readonly by: Readonly<Record<string, number>>;
}

export interface SessionListChoiceCounts {
  readonly machines: SessionListChoiceCount;
  readonly harnesses: SessionListChoiceCount;
  readonly dispatcher: SessionListChoiceCount;
}

/**
 * Per-choice match counts for the filter popover. Each choice is counted as if
 * it were picked, with every other active filter still applied, so the numbers
 * are what the list would show after the click.
 */
export function deriveSessionListChoiceCounts({
  sessions,
  machine = null,
  harness = null,
  coordinatorTrees = false,
}: {
  readonly sessions: readonly Session[];
  readonly machine?: string | null;
  readonly harness?: string | null;
  readonly coordinatorTrees?: boolean;
}): SessionListChoiceCounts {
  const active = { sessions, machine, harness, coordinatorTrees };
  const count = (override: Partial<typeof active>) =>
    filterSessionListSessions({ ...active, ...override }).length;
  const tally = (
    ids: Iterable<string>,
    override: (id: string | null) => Partial<typeof active>,
  ): SessionListChoiceCount => ({
    all: count(override(null)),
    by: Object.fromEntries([...new Set(ids)].map((id) => [id, count(override(id))])),
  });
  return {
    machines: tally(sessions.map((session) => session.machine), (id) => ({ machine: id })),
    harnesses: tally(sessions.map(sessionListHarness), (id) => ({ harness: id })),
    dispatcher: {
      all: count({ coordinatorTrees: false }),
      by: { coordinatorTrees: count({ coordinatorTrees: true }) },
    },
  };
}

export function orderSessionListSessions<T extends Session>({
  sessions,
  preferredSessionKeys,
}: {
  readonly sessions: readonly T[];
  readonly preferredSessionKeys: readonly string[];
}): T[] {
  const byKey = new Map(sessions.map((session) => [sessionKey(session), session] as const));
  const ordered: T[] = [];

  for (const key of preferredSessionKeys) {
    const session = byKey.get(key);
    if (!session) continue;
    ordered.push(session);
    byKey.delete(key);
  }

  for (const session of sessions) {
    const key = sessionKey(session);
    if (!byKey.has(key)) continue;
    ordered.push(session);
    byKey.delete(key);
  }

  return ordered;
}

export function reorderProjectedSessionKeys({
  orderedSessionKeys,
  pageSessionKeys,
  fromIndex,
  toIndex,
}: {
  readonly orderedSessionKeys: readonly string[];
  /** The dragged surface's keys by index; a null entry is an empty pane. */
  readonly pageSessionKeys: readonly (string | null)[];
  readonly fromIndex: number;
  readonly toIndex: number;
}): string[] {
  const next = [...orderedSessionKeys];
  const fromKey = pageSessionKeys[fromIndex];
  const toKey = pageSessionKeys[toIndex];
  if (!fromKey || !toKey || fromKey === toKey) {
    return next;
  }

  const fromOrderIndex = next.indexOf(fromKey);
  const toOrderIndex = next.indexOf(toKey);
  if (fromOrderIndex < 0 || toOrderIndex < 0) {
    return next;
  }

  next[fromOrderIndex] = toKey;
  next[toOrderIndex] = fromKey;
  return next;
}

export function paginateSessionList({
  sessions,
  requestedPage,
  pageSize,
}: {
  readonly sessions: readonly Session[];
  readonly requestedPage: number;
  readonly pageSize: number;
}): SessionListPage {
  if (sessions.length === 0) {
    return {
      page: null,
      pageCount: 0,
      sessionKeys: [],
      hasPrevious: false,
      hasNext: false,
    };
  }

  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.ceil(sessions.length / normalizedPageSize);
  const page = Math.min(Math.max(1, Math.floor(requestedPage)), pageCount);
  const start = (page - 1) * normalizedPageSize;

  return {
    page,
    pageCount,
    sessionKeys: sessions
      .slice(start, start + normalizedPageSize)
      .map(sessionKey),
    hasPrevious: page > 1,
    hasNext: page < pageCount,
  };
}

// Circular, like the ⌘H/⌘L session pager: stepping past either end lands on the
// other, so the arrows keep cycling instead of dead-ending at the last page.
export function stepSessionListPage({
  page,
  pageCount,
  direction,
}: {
  readonly page: number;
  readonly pageCount: number;
  readonly direction: -1 | 1;
}): number {
  if (pageCount <= 0) return 1;
  const current = Math.min(Math.max(1, Math.floor(page)), pageCount);
  return ((current - 1 + direction + pageCount) % pageCount) + 1;
}

export function resolveOverviewPromptTargetForPage({
  promptTargetKey,
  pageSessionKeys,
}: {
  readonly promptTargetKey: string | null;
  readonly pageSessionKeys: readonly string[];
}): string | null {
  return promptTargetKey !== null && pageSessionKeys.includes(promptTargetKey)
    ? promptTargetKey
    : null;
}

export function resolveSessionListPageSize({
  mobile,
  slotCount,
  resultCount,
}: {
  readonly mobile: boolean;
  readonly slotCount: number;
  readonly resultCount: number;
}): number {
  if (!mobile) {
    return Math.max(1, Math.floor(slotCount));
  }
  return Math.max(1, Math.floor(resultCount));
}

export function resolveOverviewSessionListPageSize({
  mobile,
  autoLayout,
  fixedSlotCount,
  resultCount,
}: {
  readonly mobile: boolean;
  readonly autoLayout: boolean;
  readonly fixedSlotCount: LayoutMode;
  readonly resultCount: number;
}): number {
  return resolveSessionListPageSize({
    mobile,
    slotCount: autoLayout ? autoLayoutMode(resultCount) : fixedSlotCount,
    resultCount,
  });
}

export function resolveOverviewDesktopMode({
  autoLayout,
  fixedSlotCount,
  pageSessionCount,
}: {
  readonly autoLayout: boolean;
  readonly fixedSlotCount: LayoutMode;
  readonly pageSessionCount: number;
}): LayoutMode {
  return autoLayout ? autoLayoutMode(pageSessionCount) : fixedSlotCount;
}
