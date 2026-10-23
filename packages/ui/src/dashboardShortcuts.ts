export type DashboardShortcutAction =
  | "shell"
  | "create"
  | "reconnect"
  | "repair-sessions"
  | "rename"
  | "layout-decrease"
  | "layout-increase"
  | "usage"
  | "close"
  | "back"
  | "toggle-focus"
  | "retitle"
  | "voice"
  | "conversation"
  | "shortcut-help"
  | "session-prev"
  | "session-next"
  | `open-${1 | 2 | 3 | 4 | 6}`;

export interface DashboardShortcutInput {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isMacTauri: boolean;
  readonly editableTarget: boolean;
}

export interface ToggleFocusTargetInput {
  readonly selectedKey: string | null;
  readonly activeTerminalKey: string | null;
  readonly rememberedKey: string | null;
  readonly shortcutSessionKeys: readonly string[];
}

export interface SessionShortcutTargetInput {
  readonly focusedKey: string | null;
  readonly activeTerminalKey: string | null;
  readonly promptTargetKey: string | null;
  readonly availableKeys: Iterable<string>;
}

const DASHBOARD_SHORTCUT_ACTIONS: Readonly<Record<string, DashboardShortcutAction>> = {
  t: "create",
  r: "reconnect",
  e: "rename",
  n: "layout-decrease",
  m: "layout-increase",
  // H/L walk the session list (vim-style prev/next), everywhere.
  h: "session-prev",
  l: "session-next",
  w: "close",
  f: "toggle-focus",
  p: "retitle",
  i: "voice",
  // Safari's Show History key; opens the selected session's conversation.
  y: "conversation",
  // Usage moved off L to free it for session navigation.
  ";": "usage",
};

export function resolveDashboardShortcutAction(
  input: DashboardShortcutInput,
): DashboardShortcutAction | null {
  if (input.key.toLowerCase() === "s" && input.shiftKey && !input.altKey
    && !input.editableTarget && input.metaKey !== input.ctrlKey) return "shell";
  if (
    !input.isMacTauri ||
    !input.metaKey ||
    input.ctrlKey ||
    input.altKey ||
    input.editableTarget
  ) {
    return null;
  }

  if (input.key === "`" || input.key === "~") {
    return "back";
  }

  if (input.shiftKey) {
    return null;
  }

  if (input.key === "5") {
    return "repair-sessions";
  }

  if (input.key === "/" || input.code === "Slash") {
    return "shortcut-help";
  }

  if (/^[1-4]$/.test(input.key) || input.key === "6") {
    return `open-${input.key}` as DashboardShortcutAction;
  }

  return DASHBOARD_SHORTCUT_ACTIONS[input.key.toLowerCase()] ?? null;
}

export function orderedShortcutSessionKeys(
  slots: readonly (string | null)[],
  visibleKeys: readonly string[],
): string[] {
  const visibleSet = new Set(visibleKeys);
  const used = new Set<string>();
  const ordered: string[] = [];

  const push = (key: string | null) => {
    if (!key || !visibleSet.has(key) || used.has(key)) {
      return;
    }
    used.add(key);
    ordered.push(key);
  };

  slots.forEach(push);
  visibleKeys.forEach(push);
  return ordered;
}

export function resolveSessionShortcutTarget(input: SessionShortcutTargetInput): string | null {
  const available = new Set(input.availableKeys);
  if (input.focusedKey !== null) {
    return available.has(input.focusedKey) ? input.focusedKey : null;
  }
  for (const key of [input.promptTargetKey, input.activeTerminalKey]) {
    if (key && available.has(key)) return key;
  }
  return null;
}

export function resolveToggleFocusTarget(input: ToggleFocusTargetInput): string | null {
  const available = new Set(input.shortcutSessionKeys);
  for (const key of [input.selectedKey, input.activeTerminalKey, input.rememberedKey]) {
    if (key && available.has(key)) {
      return key;
    }
  }
  return input.shortcutSessionKeys[0] ?? null;
}
