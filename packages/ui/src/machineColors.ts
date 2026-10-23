// Per-device machine badge colors.
//
// Hosts get the default color unless a distribution's UI extensions name one
// (#918). User overrides live in localStorage and are validated before
// reaching CSS custom properties.

import { resolveLocalStorage, safeGetItem, safeRemoveItem, safeSetItem, type StorageLike } from "./storage.ts";

export type MachineColorMap = Readonly<Record<string, string>>;

export const DEFAULT_MACHINE_COLOR = "#82aaff";
const NO_DEFAULTS: MachineColorMap = Object.freeze({});
export const MACHINE_COLOR_STORAGE_KEY = "ac.machineColors";

export type MachineColorStorage = StorageLike;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function hasOwn(map: MachineColorMap, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

export function createMachineColorMap(entries?: Iterable<readonly [string, string]>): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!entries) {
    return out;
  }
  for (const [machine, color] of entries) {
    out[machine] = color;
  }
  return out;
}

export function machineColorOverride(overrides: MachineColorMap, machine: string): string | undefined {
  return hasOwn(overrides, machine) ? overrides[machine] : undefined;
}

export function normalizeMachineColor(color: unknown): string | null {
  if (typeof color !== "string") {
    return null;
  }
  const normalized = color.trim().toLowerCase();
  return HEX_COLOR.test(normalized) ? normalized : null;
}

export function defaultMachineColor(machine: string, defaults: MachineColorMap = NO_DEFAULTS): string {
  return hasOwn(defaults, machine) ? defaults[machine]! : DEFAULT_MACHINE_COLOR;
}

export function resolveMachineColor(machine: string | undefined, overrides: MachineColorMap, defaults: MachineColorMap = NO_DEFAULTS): string {
  if (!machine) {
    return DEFAULT_MACHINE_COLOR;
  }
  const override = normalizeMachineColor(machineColorOverride(overrides, machine));
  return override ?? defaultMachineColor(machine, defaults);
}

export function machineColorRgb(color: string): string {
  const normalized = normalizeMachineColor(color) ?? DEFAULT_MACHINE_COLOR;
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

function normalizeOverrides(overrides: MachineColorMap, defaults: MachineColorMap): Record<string, string> {
  const out = createMachineColorMap();
  for (const [machine, color] of Object.entries(overrides)) {
    const normalized = normalizeMachineColor(color);
    if (!normalized || normalized === defaultMachineColor(machine, defaults)) {
      continue;
    }
    out[machine] = normalized;
  }
  return out;
}

export function loadMachineColors(storage?: MachineColorStorage, defaults: MachineColorMap = NO_DEFAULTS): Record<string, string> {
  const s = resolveLocalStorage(storage);
  try {
    const raw = safeGetItem(s, MACHINE_COLOR_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return normalizeOverrides(parsed as Record<string, string>, defaults);
  } catch {
    return {};
  }
}

export function saveMachineColors(overrides: MachineColorMap, storage?: MachineColorStorage, defaults: MachineColorMap = NO_DEFAULTS): void {
  const s = resolveLocalStorage(storage);
  if (!s) {
    return;
  }
  try {
    const normalized = normalizeOverrides(overrides, defaults);
    if (Object.keys(normalized).length === 0) {
      if (s.removeItem) {
        safeRemoveItem(s, MACHINE_COLOR_STORAGE_KEY);
      } else {
        safeSetItem(s, MACHINE_COLOR_STORAGE_KEY, JSON.stringify({}));
      }
      return;
    }
    safeSetItem(s, MACHINE_COLOR_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // best-effort; a full/blocked quota just means the choice is not remembered
  }
}

export function setMachineColor(overrides: MachineColorMap, machine: string, color: string, defaults: MachineColorMap = NO_DEFAULTS): Record<string, string> {
  const normalized = normalizeMachineColor(color);
  if (!machine || !normalized) {
    return normalizeOverrides(overrides, defaults);
  }
  if (normalized === defaultMachineColor(machine, defaults)) {
    return resetMachineColor(overrides, machine, defaults);
  }
  const next = normalizeOverrides(overrides, defaults);
  next[machine] = normalized;
  return next;
}

export function resetMachineColor(overrides: MachineColorMap, machine: string, defaults: MachineColorMap = NO_DEFAULTS): Record<string, string> {
  const next = normalizeOverrides(overrides, defaults);
  delete next[machine];
  return next;
}
