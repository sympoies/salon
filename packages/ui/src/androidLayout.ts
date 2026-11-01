import { LAYOUT_MODES, type LayoutMode } from "./layout.ts";
import { resolveLocalStorage, safeGetItem, safeSetItem, type StorageLike } from "./storage.ts";

/** The Android app's per-device Session layout: the phone list, or a fixed number of session tiles (#238). */
export type AndroidLayout = "list" | LayoutMode;

export const ANDROID_LAYOUT_STORAGE_KEY = "ac.androidLayout";

export function loadAndroidLayout(storage?: StorageLike): AndroidLayout {
  return parseAndroidLayout(safeGetItem(resolveLocalStorage(storage), ANDROID_LAYOUT_STORAGE_KEY) ?? "");
}

export function saveAndroidLayout(layout: AndroidLayout, storage?: StorageLike): boolean {
  return safeSetItem(resolveLocalStorage(storage), ANDROID_LAYOUT_STORAGE_KEY, String(layout));
}

export function parseAndroidLayout(value: string): AndroidLayout {
  const mode = LAYOUT_MODES.find(candidate => String(candidate) === value);
  return mode ?? "list";
}
