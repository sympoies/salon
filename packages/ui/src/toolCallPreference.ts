import { useSyncExternalStore } from "react";
import { getPrincipalStorageNamespace, resolveLocalStorage, safeGetItem, safeSetItem } from "./storage.ts";

const KEY = "ac.showToolCalls";
const CHANGE = "salon-tool-call-preference";
// Keep an immediate client choice even when the browser refuses persistence.
const unsavedValues = new Map<string | null, boolean>();

function loadShowToolCalls(): boolean {
  return unsavedValues.get(getPrincipalStorageNamespace()) ?? (safeGetItem(resolveLocalStorage(), KEY) !== "0");
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE, listener);
  return () => window.removeEventListener(CHANGE, listener);
}

export function saveShowToolCalls(shown: boolean): void {
  const principal = getPrincipalStorageNamespace();
  if (safeSetItem(resolveLocalStorage(), KEY, shown ? "1" : "0")) unsavedValues.delete(principal);
  else unsavedValues.set(principal, shown);
  window.dispatchEvent(new Event(CHANGE));
}

/** Shared by settings and mounted live/saved views so toggling never reloads history. */
export function useShowToolCalls(): boolean {
  return useSyncExternalStore(subscribe, loadShowToolCalls, () => true);
}
