import { resolveLocalStorage, safeGetItem, safeSetItem, type StorageLike } from "./storage.ts";
import type { SessionListDisplay } from "./sessionListDisplay.ts";

export const PHONE_SESSION_OPEN_STORAGE_KEY = "ac.phoneSessionOpen";
export function loadPhoneSessionOpen(storage?: StorageLike): SessionListDisplay {
  return safeGetItem(resolveLocalStorage(storage), PHONE_SESSION_OPEN_STORAGE_KEY) === "terminal"
    ? "terminal" : "conversation";
}
export function savePhoneSessionOpen(display: SessionListDisplay, storage?: StorageLike): boolean {
  return safeSetItem(resolveLocalStorage(storage), PHONE_SESSION_OPEN_STORAGE_KEY, display);
}
