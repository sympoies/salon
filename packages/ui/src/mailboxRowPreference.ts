import { resolveLocalStorage, safeGetItem, safeRemoveItem, safeSetItem, type StorageLike } from "./storage.ts";

const KEY = "ac.mailboxRowsExpanded";

/** Whether mailbox read rows start expanded on this device; collapsed by default. */
export function loadMailboxRowsExpanded(storage?: StorageLike): boolean {
  return safeGetItem(resolveLocalStorage(storage), KEY) === "1";
}

export function saveMailboxRowsExpanded(expanded: boolean, storage?: StorageLike): boolean {
  const target = resolveLocalStorage(storage);
  return expanded ? safeSetItem(target, KEY, "1") : safeRemoveItem(target, KEY);
}
