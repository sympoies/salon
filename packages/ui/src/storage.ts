export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

let principalNamespace: string | null = null;

export function getPrincipalStorageNamespace(): string | null {
  return principalNamespace;
}

export function setPrincipalStorageNamespace(principalId: string | null): void {
  principalNamespace = principalId && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(principalId)
    ? principalId
    : null;
}

function scopedKey(key: string): string {
  return principalNamespace === null
    ? key
    : `agent-console.principal.${principalNamespace}.${key}`;
}

export function resolveLocalStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) {
    return storage;
  }
  try {
    if (typeof window !== "undefined") {
      const windowStorage = window.localStorage ?? null;
      if (windowStorage) {
        return windowStorage;
      }
    }
  } catch {
    // Fall through to globalThis: tests and some shells expose storage there.
  }
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function safeGetItem(storage: StorageLike | null | undefined, key: string): string | null {
  try {
    return storage?.getItem(scopedKey(key)) ?? null;
  } catch {
    return null;
  }
}

export function safeSetItem(storage: StorageLike | null | undefined, key: string, value: string): boolean {
  try {
    storage?.setItem(scopedKey(key), value);
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function safeRemoveItem(storage: StorageLike | null | undefined, key: string): boolean {
  try {
    if (!storage) {
      return false;
    }
    if (storage.removeItem) {
      storage.removeItem(scopedKey(key));
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function localStorageGetItem(key: string): string | null {
  return safeGetItem(resolveLocalStorage(), key);
}

export function localStorageSetItem(key: string, value: string): boolean {
  return safeSetItem(resolveLocalStorage(), key, value);
}

export function unscopedLocalStorageGetItem(key: string): string | null {
  try {
    return resolveLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function unscopedLocalStorageSetItem(key: string, value: string): boolean {
  try {
    const storage = resolveLocalStorage();
    storage?.setItem(key, value);
    return Boolean(storage);
  } catch {
    return false;
  }
}
