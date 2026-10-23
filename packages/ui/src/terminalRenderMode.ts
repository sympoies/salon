import { resolveLocalStorage, safeGetItem, safeSetItem, type StorageLike } from "./storage.ts";

export type TerminalRenderMode =
  | "realtime"
  | "focus-aware-smooth"
  | "focus-aware-balanced"
  | "focus-aware-efficient";

export const TERMINAL_RENDER_MODE_STORAGE_KEY = "ac.terminalRenderMode";
export const TERMINAL_SELECTED_PANE_REALTIME_STORAGE_KEY = "ac.terminalSelectedPaneRealtime";

const BATCH_DELAY_BY_MODE: Record<Exclude<TerminalRenderMode, "realtime">, number> = {
  "focus-aware-smooth": 100,
  "focus-aware-balanced": 250,
  "focus-aware-efficient": 500,
};

function isTerminalRenderMode(value: string | null): value is TerminalRenderMode {
  return (
    value === "realtime" ||
    value === "focus-aware-smooth" ||
    value === "focus-aware-balanced" ||
    value === "focus-aware-efficient"
  );
}

export function loadTerminalRenderMode(storage?: StorageLike): TerminalRenderMode {
  const value = safeGetItem(resolveLocalStorage(storage), TERMINAL_RENDER_MODE_STORAGE_KEY);
  if (value === "focus-aware") {
    return "focus-aware-balanced";
  }
  return isTerminalRenderMode(value) ? value : "realtime";
}

export function saveTerminalRenderMode(mode: TerminalRenderMode, storage?: StorageLike): boolean {
  return safeSetItem(resolveLocalStorage(storage), TERMINAL_RENDER_MODE_STORAGE_KEY, mode);
}

export function terminalRenderBatchDelayMs(mode: TerminalRenderMode): number | null {
  return mode === "realtime" ? null : BATCH_DELAY_BY_MODE[mode];
}

export function loadTerminalSelectedPaneRealtime(storage?: StorageLike): boolean {
  return safeGetItem(resolveLocalStorage(storage), TERMINAL_SELECTED_PANE_REALTIME_STORAGE_KEY) !== "false";
}

export function saveTerminalSelectedPaneRealtime(enabled: boolean, storage?: StorageLike): boolean {
  return safeSetItem(
    resolveLocalStorage(storage),
    TERMINAL_SELECTED_PANE_REALTIME_STORAGE_KEY,
    String(enabled),
  );
}
