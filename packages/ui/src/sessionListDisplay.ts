import { resolveLocalStorage, safeGetItem, safeSetItem, type StorageLike } from "./storage.ts";

export type SessionListDisplay = "terminal" | "conversation";
export const SESSION_LIST_DISPLAY_STORAGE_KEY = "ac.sessionListDisplay";

export function loadSessionListDisplay(storage?: StorageLike): SessionListDisplay {
  return safeGetItem(resolveLocalStorage(storage), SESSION_LIST_DISPLAY_STORAGE_KEY) === "conversation"
    ? "conversation" : "terminal";
}

export function saveSessionListDisplay(display: SessionListDisplay, storage?: StorageLike): boolean {
  return safeSetItem(resolveLocalStorage(storage), SESSION_LIST_DISPLAY_STORAGE_KEY, display);
}
