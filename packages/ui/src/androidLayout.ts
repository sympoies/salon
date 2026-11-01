import { resolveLocalStorage, safeGetItem, safeRemoveItem, safeSetItem, type StorageLike } from "./storage.ts";

/**
 * The Android app's per-device Layout choice (#252). Mobile is the phone list;
 * Desktop shows the desktop grid on the session list screen only. An opened
 * session is always the mobile session view, in both.
 */
export type AndroidLayout = "mobile" | "desktop";

export const ANDROID_LAYOUT_STORAGE_KEY = "ac.androidLayoutChoice";
// The #238 setting stored the phone list or 1 to 6 fixed tiles under this key.
const LEGACY_STORAGE_KEY = "ac.androidLayout";
// The desktop grid's own keys: the pane count is remembered there.
const DESKTOP_MODE_KEY = "agent-console.layout.mode";
const DESKTOP_AUTO_KEY = "agent-console.layout.auto";
const DESKTOP_ENTERED_KEY = "ac.androidDesktopEntered";

export function parseAndroidLayout(value: string): AndroidLayout {
  return value === "desktop" ? "desktop" : "mobile";
}

/** Move a stored 1 to 6 to Desktop with that count (auto off); any other value becomes Mobile; then drop the old key. */
function migrateLegacyLayout(target: StorageLike | null): void {
  const legacy = safeGetItem(target, LEGACY_STORAGE_KEY);
  if (legacy === null) return;
  if (safeGetItem(target, ANDROID_LAYOUT_STORAGE_KEY) === null) {
    const count = Number(legacy);
    const migrated = Number.isInteger(count) && count >= 1 && count <= 6
      ? safeSetItem(target, DESKTOP_MODE_KEY, String(count)) && safeSetItem(target, DESKTOP_AUTO_KEY, "0")
        && safeSetItem(target, DESKTOP_ENTERED_KEY, "1") && safeSetItem(target, ANDROID_LAYOUT_STORAGE_KEY, "desktop")
      : safeSetItem(target, ANDROID_LAYOUT_STORAGE_KEY, "mobile");
    if (!migrated) return;
  }
  safeRemoveItem(target, LEGACY_STORAGE_KEY);
}

export function loadAndroidLayout(storage?: StorageLike): AndroidLayout {
  const target = resolveLocalStorage(storage);
  migrateLegacyLayout(target);
  return parseAndroidLayout(safeGetItem(target, ANDROID_LAYOUT_STORAGE_KEY) ?? "");
}

export function saveAndroidLayout(layout: AndroidLayout, storage?: StorageLike): boolean {
  const target = resolveLocalStorage(storage);
  // The first time Desktop is chosen, the grid follows the session count (Auto).
  if (layout === "desktop" && safeGetItem(target, DESKTOP_ENTERED_KEY) === null) {
    safeSetItem(target, DESKTOP_AUTO_KEY, "1");
    safeSetItem(target, DESKTOP_ENTERED_KEY, "1");
  }
  return safeSetItem(target, ANDROID_LAYOUT_STORAGE_KEY, layout);
}
