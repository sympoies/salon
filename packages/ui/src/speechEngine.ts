import { resolveLocalStorage, safeGetItem, safeRemoveItem, safeSetItem, type StorageLike } from "./storage.ts";

const key = (provider: string) => `ac.speechEngine.${provider}`;

/** The engine chosen on this device for one speech service, or null for its default. */
export function loadSpeechEngine(provider: string, storage?: StorageLike): string | null {
  return safeGetItem(resolveLocalStorage(storage), key(provider)) || null;
}

export function saveSpeechEngine(provider: string, engine: string | null, storage?: StorageLike): boolean {
  const target = resolveLocalStorage(storage);
  return engine ? safeSetItem(target, key(provider), engine) : safeRemoveItem(target, key(provider));
}
