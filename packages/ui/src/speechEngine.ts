import { resolveLocalStorage, safeGetItem, safeRemoveItem, safeSetItem, type StorageLike } from "./storage.ts";

export const SPEECH_ENGINE_STORAGE_KEY = "ac.speechEngine";

/** The engine chosen on this device, or null to follow the server default. */
export function loadSpeechEngine(storage?: StorageLike): string | null {
  return safeGetItem(resolveLocalStorage(storage), SPEECH_ENGINE_STORAGE_KEY) || null;
}

export function saveSpeechEngine(engine: string | null, storage?: StorageLike): boolean {
  const target = resolveLocalStorage(storage);
  return engine ? safeSetItem(target, SPEECH_ENGINE_STORAGE_KEY, engine) : safeRemoveItem(target, SPEECH_ENGINE_STORAGE_KEY);
}
