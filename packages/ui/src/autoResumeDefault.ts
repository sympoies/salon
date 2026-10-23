import { resolveLocalStorage, safeGetItem, safeSetItem, type StorageLike } from "./storage.ts";

export const DEFAULT_AUTO_RESUME_STORAGE_KEY = "ac.defaultAutoResume";

export function loadDefaultAutoResume(storage?: StorageLike): boolean {
  return safeGetItem(resolveLocalStorage(storage), DEFAULT_AUTO_RESUME_STORAGE_KEY) === "1";
}

export function saveDefaultAutoResume(enabled: boolean, storage?: StorageLike): boolean {
  return safeSetItem(resolveLocalStorage(storage), DEFAULT_AUTO_RESUME_STORAGE_KEY, enabled ? "1" : "0");
}
