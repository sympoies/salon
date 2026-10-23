import { resolveLocalStorage, safeGetItem, safeSetItem, type StorageLike } from "./storage.ts";

export const PHONE_FOCUS_COUNTS_STORAGE_KEY = "ac.phoneFocusCounts";

/**
 * The phone single-session view's status count row (#938) is shown by
 * default. This device hides it only after an explicit "0".
 */
export function loadPhoneFocusCounts(storage?: StorageLike): boolean {
  return safeGetItem(resolveLocalStorage(storage), PHONE_FOCUS_COUNTS_STORAGE_KEY) !== "0";
}
export function savePhoneFocusCounts(shown: boolean, storage?: StorageLike): boolean {
  return safeSetItem(resolveLocalStorage(storage), PHONE_FOCUS_COUNTS_STORAGE_KEY, shown ? "1" : "0");
}
