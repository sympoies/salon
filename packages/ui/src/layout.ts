export type LayoutMode = 1 | 2 | 3 | 4 | 5 | 6;
export type MobileSlotCount = 1 | 2 | 3 | 4;
export type SlotKey = string | null;

export const LAYOUT_MODES: readonly LayoutMode[] = [1, 2, 3, 4, 5, 6];
export const DEFAULT_LAYOUT_MODE: LayoutMode = 4;

export interface KeyedSession {
  readonly id: string;
  readonly machine: string;
}

export function sessionKey(s: KeyedSession): string {
  return `${s.machine}/${s.id}`;
}

export function isLayoutMode(value: number): value is LayoutMode {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6;
}

// Auto layout: the smallest desktop grid mode that shows every visible session,
// capped at 6 (extra sessions overflow, as in the fixed modes). Drives the grid
// when the user picks "Auto" so it grows/shrinks with add/delete.
export function autoLayoutMode(visibleSessions: number): LayoutMode {
  if (visibleSessions <= 1) return 1;
  if (visibleSessions === 2) return 2;
  if (visibleSessions === 3) return 3;
  if (visibleSessions === 4) return 4;
  if (visibleSessions === 5) return 5;
  return 6;
}

export function parseLayoutMode(value: string | null): LayoutMode {
  const n = Number(value);
  return isLayoutMode(n) ? n : DEFAULT_LAYOUT_MODE;
}

export function stepLayoutMode(current: LayoutMode, direction: -1 | 1): LayoutMode {
  const index = LAYOUT_MODES.indexOf(current);
  if (index < 0) {
    return DEFAULT_LAYOUT_MODE;
  }
  // Circular: stepping past either end wraps to the other (1 <-> 6).
  const count = LAYOUT_MODES.length;
  const nextIndex = (index + direction + count) % count;
  return LAYOUT_MODES[nextIndex] ?? DEFAULT_LAYOUT_MODE;
}

export function mobileSlotCount(width: number, height: number, visibleSessions?: number): MobileSlotCount {
  if (typeof visibleSessions === "number") {
    if (visibleSessions <= 1) return 1;
    if (visibleSessions >= 4) return 4;
    return visibleSessions === 2 ? 2 : 3;
  }
  return width >= 800 || height >= 860 ? 3 : 2;
}

export function reconcileSlots(
  current: readonly SlotKey[],
  sessions: readonly KeyedSession[],
  size: number,
): SlotKey[] {
  const available = sessions.map(sessionKey);
  const valid = new Set(available);
  const used = new Set<string>();
  const next: SlotKey[] = Array.from({ length: size }, (_, i) => {
    const key = current[i] ?? null;
    if (!key || !valid.has(key) || used.has(key)) {
      return null;
    }
    used.add(key);
    return key;
  });

  for (const key of available) {
    if (used.has(key)) {
      continue;
    }
    const empty = next.findIndex((slot) => slot === null);
    if (empty < 0) {
      break;
    }
    next[empty] = key;
    used.add(key);
  }
  return next;
}

export function compactSlotsAfterRemoval(
  current: readonly SlotKey[],
  removedKeys: ReadonlySet<string>,
  sessions: readonly KeyedSession[],
  orderedKeys: readonly string[],
): SlotKey[] {
  if (!current.some((key) => key !== null && removedKeys.has(key))) {
    return [...current];
  }

  const valid = new Set(sessions.map(sessionKey));
  const used = new Set<string>();
  const compacted: string[] = [];
  const append = (key: SlotKey) => {
    if (
      key !== null
      && valid.has(key)
      && !removedKeys.has(key)
      && !used.has(key)
      && compacted.length < current.length
    ) {
      compacted.push(key);
      used.add(key);
    }
  };

  for (const key of orderedKeys) append(key);
  for (const session of sessions) append(sessionKey(session));

  return Array.from({ length: current.length }, (_, index) => compacted[index] ?? null);
}

export function assignSlot(slots: readonly SlotKey[], index: number, key: SlotKey): SlotKey[] {
  if (index < 0 || index >= slots.length) {
    return [...slots];
  }
  return slots.map((slot, i) => {
    if (i === index) {
      return key;
    }
    return key && slot === key ? null : slot;
  });
}

export function swapSlots(slots: readonly SlotKey[], a: number, b: number): SlotKey[] {
  const next = [...slots];
  if (a < 0 || b < 0 || a >= next.length || b >= next.length || a === b) {
    return next;
  }
  const tmp = next[a] ?? null;
  next[a] = next[b] ?? null;
  next[b] = tmp;
  return next;
}

export function slotsEqual(a: readonly SlotKey[], b: readonly SlotKey[]): boolean {
  return a.length === b.length && a.every((slot, i) => slot === b[i]);
}
