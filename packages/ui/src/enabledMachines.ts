import { resolveLocalStorage, safeGetItem, safeSetItem, safeRemoveItem, type StorageLike } from "./storage.ts";
const LEGACY_KEY = "ac.enabledMachines.optIn";
const NOTICE_KEY = "ac.sessionFilters.hostMigrationSeen";
const SEED_NOTICE_KEY = "ac.machinePreferences.migrationSeen";
/** Principal visibility is authoritative. The old device opt-in no longer hides hosts. */
export function resolveEnabledMachines(all: readonly string[], _legacyOptIn?: ReadonlySet<string>): string[] { return [...all]; }
export function hostVisibilityMigrationPending(storage?: StorageLike): boolean {
  const target = resolveLocalStorage(storage);
  return safeGetItem(target, LEGACY_KEY) !== null && safeGetItem(target, NOTICE_KEY) !== "1";
}
export function acknowledgeHostVisibilityMigration(storage?: StorageLike): boolean {
  return safeSetItem(resolveLocalStorage(storage), NOTICE_KEY, "1");
}

/** Offer a legacy device value; never apply it without the user's choice. */
export function legacyHostPreferenceSeed(available: readonly string[], storage?: StorageLike): ReadonlySet<string> | null {
  const target = resolveLocalStorage(storage);
  if (safeGetItem(target, SEED_NOTICE_KEY) === "1") return null;
  try {
    const raw = safeGetItem(target, LEGACY_KEY) ?? target?.getItem(LEGACY_KEY);
    if (raw === null || raw === undefined) return null;
    const names: unknown = JSON.parse(raw);
    if (!Array.isArray(names) || names.some(name => typeof name !== "string")) return null;
    return new Set(available.filter(name => names.includes(name)));
  } catch { return null; }
}

export function completeLegacyHostPreferenceMigration(storage?: StorageLike): boolean {
  const target = resolveLocalStorage(storage);
  if (!target) return false;
  try {
    if (safeGetItem(target, LEGACY_KEY) !== null && !safeRemoveItem(target, LEGACY_KEY)) return false;
    if (target.getItem(LEGACY_KEY) !== null) {
      if (!target.removeItem) return false;
      target.removeItem(LEGACY_KEY);
    }
    return safeSetItem(target, SEED_NOTICE_KEY, "1");
  } catch { return false; }
}
