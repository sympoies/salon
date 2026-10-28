import { useCallback, useSyncExternalStore } from "react";
import { unscopedLocalStorageGetItem, unscopedLocalStorageSetItem, type StorageLike } from "./storage.ts";

/** What the user chose. `system` follows the OS colour-scheme preference. */
export type ThemeMode = "system" | "dark" | "paper";
/** What is on screen. Exposed as `data-theme` on the root element. */
export type ResolvedTheme = "dark" | "paper";

export const THEME_MODES: readonly { readonly id: ThemeMode; readonly label: string }[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "paper", label: "Paper" },
];
export const DEFAULT_THEME_MODE: ThemeMode = "system";
export const THEME_MODE_STORAGE_KEY = "ac.themeMode";
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
/** The resolved canvas colour, for `<meta name="theme-color">` so a hosting shell can follow. */
export const THEME_META_COLORS: Record<ResolvedTheme, string> = { dark: "#011627", paper: "#f4f3ed" };

export interface ThemeState {
  readonly mode: ThemeMode;
  readonly resolved: ResolvedTheme;
}

export interface ThemeEnvironment {
  readonly document: Document;
  readonly matchMedia?: (query: string) => MediaQueryList;
  /** Omit for the device's local storage. */
  readonly storage?: StorageLike | null;
}

export interface ThemeController {
  getState(): ThemeState;
  subscribe(listener: () => void): () => void;
  setMode(mode: ThemeMode): void;
  dispose(): void;
}

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "system" || value === "dark" || value === "paper";
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === "system") return systemPrefersDark ? "dark" : "paper";
  return mode;
}

// The choice belongs to the device, not to a signed-in principal, so it also
// applies before sign-in: these helpers bypass the principal storage namespace.
export function loadThemeMode(storage?: StorageLike | null): ThemeMode {
  try {
    const value = storage === undefined ? unscopedLocalStorageGetItem(THEME_MODE_STORAGE_KEY) : storage?.getItem(THEME_MODE_STORAGE_KEY) ?? null;
    return isThemeMode(value) ? value : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

export function saveThemeMode(mode: ThemeMode, storage?: StorageLike | null): boolean {
  try {
    if (storage === undefined) return unscopedLocalStorageSetItem(THEME_MODE_STORAGE_KEY, mode);
    storage?.setItem(THEME_MODE_STORAGE_KEY, mode);
    return Boolean(storage);
  } catch {
    return false;
  }
}

function applyTheme(document: Document, state: ThemeState): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", state.resolved);
  root.setAttribute("data-theme-mode", state.mode);
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.append(meta);
  }
  meta.setAttribute("content", THEME_META_COLORS[state.resolved]);
}

export function createThemeController(env: ThemeEnvironment): ThemeController {
  const listeners = new Set<() => void>();
  let mode = loadThemeMode(env.storage);
  let media: MediaQueryList | null = null;
  try {
    media = env.matchMedia?.(SYSTEM_DARK_QUERY) ?? null;
  } catch {
    media = null;
  }
  // Without a preference signal keep the original dark appearance.
  let prefersDark = media ? media.matches : true;
  let state: ThemeState = { mode, resolved: resolveTheme(mode, prefersDark) };
  applyTheme(env.document, state);

  const update = () => {
    const next: ThemeState = { mode, resolved: resolveTheme(mode, prefersDark) };
    if (next.mode === state.mode && next.resolved === state.resolved) return;
    state = next;
    applyTheme(env.document, state);
    for (const listener of [...listeners]) listener();
  };
  const onSystemChange = (event: { readonly matches: boolean }) => {
    prefersDark = event.matches;
    update();
  };
  media?.addEventListener("change", onSystemChange);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setMode(next) {
      mode = next;
      saveThemeMode(next, env.storage);
      update();
    },
    dispose() {
      media?.removeEventListener("change", onSystemChange);
      listeners.clear();
    },
  };
}

let sharedController: ThemeController | null = null;
const inertState: ThemeState = { mode: DEFAULT_THEME_MODE, resolved: "dark" };
const inertController: ThemeController = {
  getState: () => inertState,
  subscribe: () => () => undefined,
  setMode() {},
  dispose() {},
};

/** The app-wide controller, created on first use from the browser globals. */
export function installTheme(): ThemeController {
  if (sharedController) return sharedController;
  // Server rendering has no document: report the default look and change nothing.
  if (typeof globalThis.document === "undefined") return inertController;
  const browser = typeof window === "undefined" ? undefined : window;
  sharedController = createThemeController({
    document: globalThis.document,
    matchMedia: typeof browser?.matchMedia === "function" ? query => browser.matchMedia(query) : undefined,
  });
  return sharedController;
}

/**
 * Public hook for embedding consumers: the chosen mode, the resolved theme
 * (`"dark"` or `"paper"`, also on `<html data-theme>`), and a setter.
 */
export function useTheme(): ThemeState & { readonly setMode: (mode: ThemeMode) => void } {
  const controller = installTheme();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const setMode = useCallback((mode: ThemeMode) => controller.setMode(mode), [controller]);
  return { ...state, setMode };
}
