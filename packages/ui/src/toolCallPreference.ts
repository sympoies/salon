import { useSyncExternalStore } from "react";
import { resolveLocalStorage, safeGetItem, safeSetItem } from "./storage.ts";

const KEY = "ac.showToolCalls";
const CHANGE = "salon-tool-call-preference";

function loadShowToolCalls(): boolean {
  return safeGetItem(resolveLocalStorage(), KEY) !== "0";
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE, listener);
  return () => window.removeEventListener(CHANGE, listener);
}

export function saveShowToolCalls(shown: boolean): void {
  safeSetItem(resolveLocalStorage(), KEY, shown ? "1" : "0");
  window.dispatchEvent(new Event(CHANGE));
}

/** Shared by settings and mounted live/saved views so toggling never reloads history. */
export function useShowToolCalls(): boolean {
  return useSyncExternalStore(subscribe, loadShowToolCalls, () => true);
}
