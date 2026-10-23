export type SessionNavigatorGroupLabel = "In grid" | "More sessions";

export interface SessionNavigatorGroup {
  readonly label: SessionNavigatorGroupLabel;
  readonly sessionKeys: readonly string[];
}

export type SessionNavigatorSelection =
  | { readonly kind: "focus-grid"; readonly sessionKey: string }
  | {
      readonly kind: "open-fullscreen";
      readonly sessionKey: string;
      readonly restorePromptTargetKey: string | null;
    };

export function adjacentPromptTargetKey({
  orderedSessionKeys,
  promptTargetKeys,
  currentSessionKey,
  direction,
}: {
  readonly orderedSessionKeys: readonly string[];
  readonly promptTargetKeys: readonly string[];
  readonly currentSessionKey: string | null;
  readonly direction: -1 | 1;
}): string | null {
  if (orderedSessionKeys.length === 0 || promptTargetKeys.length === 0) {
    return null;
  }
  const promptTargets = new Set(promptTargetKeys);
  const currentIndex = currentSessionKey === null
    ? -1
    : orderedSessionKeys.indexOf(currentSessionKey);
  const baseIndex = currentIndex < 0
    ? direction > 0 ? -1 : 0
    : currentIndex;

  for (let offset = 1; offset <= orderedSessionKeys.length; offset += 1) {
    const index = (
      baseIndex + direction * offset + orderedSessionKeys.length
    ) % orderedSessionKeys.length;
    const key = orderedSessionKeys[index];
    if (key && promptTargets.has(key)) {
      return key;
    }
  }
  return null;
}

export function filteredGridSessionKeys({
  filteredSessionKeys,
  slotSessionKeys,
}: {
  readonly filteredSessionKeys: readonly string[];
  readonly slotSessionKeys: readonly (string | null)[];
}): string[] {
  const filtered = new Set(filteredSessionKeys);
  return slotSessionKeys.filter(
    (key): key is string => key !== null && filtered.has(key),
  );
}

export function resolveOverviewPromptTargetFocus({
  currentPromptTargetKey,
  focusedSessionKey,
  focusedTerminalKey,
  gridSessionKeys,
}: {
  readonly currentPromptTargetKey: string | null;
  readonly focusedSessionKey: string | null;
  readonly focusedTerminalKey: string;
  readonly gridSessionKeys: readonly string[];
}): string | null {
  const currentGridTarget = currentPromptTargetKey && gridSessionKeys.includes(currentPromptTargetKey)
    ? currentPromptTargetKey
    : null;
  if (focusedSessionKey !== null) {
    return currentGridTarget;
  }
  return gridSessionKeys.includes(focusedTerminalKey)
    ? focusedTerminalKey
    : currentGridTarget;
}

export function groupNavigableSessionKeys({
  filteredSessionKeys,
  gridSessionKeys,
}: {
  readonly filteredSessionKeys: readonly string[];
  readonly gridSessionKeys: readonly string[];
}): SessionNavigatorGroup[] {
  const filtered = new Set(filteredSessionKeys);
  const grid = gridSessionKeys.filter((key) => filtered.has(key));
  const gridSet = new Set(grid);
  const overflow = filteredSessionKeys.filter((key) => !gridSet.has(key));
  const groups: SessionNavigatorGroup[] = [];

  if (grid.length > 0) {
    groups.push({ label: "In grid", sessionKeys: grid });
  }
  if (overflow.length > 0) {
    groups.push({ label: "More sessions", sessionKeys: overflow });
  }
  return groups;
}

export function resolveSessionNavigatorSelection({
  selectedSessionKey,
  gridSessionKeys,
  promptTargetKey,
  mobileOverview,
}: {
  readonly selectedSessionKey: string;
  readonly gridSessionKeys: readonly string[];
  readonly promptTargetKey: string | null;
  readonly mobileOverview: boolean;
}): SessionNavigatorSelection {
  if (!mobileOverview && gridSessionKeys.includes(selectedSessionKey)) {
    return { kind: "focus-grid", sessionKey: selectedSessionKey };
  }
  return {
    kind: "open-fullscreen",
    sessionKey: selectedSessionKey,
    restorePromptTargetKey: promptTargetKey,
  };
}
