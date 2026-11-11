// Per-device machine order.
//
// The Machines section and the Session filter list hosts in one order: the
// device's saved order, else the distribution's default (UI extensions), else
// the order the server reports. Hosts the order does not name follow in server
// order, and names the principal cannot see are ignored.

import { resolveLocalStorage, safeGetItem, safeRemoveItem, safeSetItem, type StorageLike } from "./storage.ts";

export const MACHINE_ORDER_STORAGE_KEY = "ac.machineOrder";

export function orderMachines(
  serverOrder: readonly string[],
  saved: readonly string[],
  defaults: readonly string[],
): string[] {
  const visible = new Set(serverOrder);
  const preferred = saved.length > 0 ? saved : defaults;
  const ordered = new Set<string>();
  for (const name of preferred) {
    if (visible.has(name)) ordered.add(name);
  }
  for (const name of serverOrder) ordered.add(name);
  return [...ordered];
}

/** The full order after moving `machine` to `toIndex`, clamped to the list. */
export function moveMachine(order: readonly string[], machine: string, toIndex: number): string[] {
  const from = order.indexOf(machine);
  if (from < 0) return [...order];
  const next = order.filter(name => name !== machine);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, machine);
  return next;
}

export function loadMachineOrder(storage?: StorageLike): string[] {
  try {
    const raw = safeGetItem(resolveLocalStorage(storage), MACHINE_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((name): name is string => typeof name === "string" && name !== ""))];
  } catch {
    return [];
  }
}

/** An empty order removes the saved value, which restores the defaults. */
export function saveMachineOrder(order: readonly string[], storage?: StorageLike): void {
  const target = resolveLocalStorage(storage);
  if (!target) return;
  if (order.length === 0) {
    safeRemoveItem(target, MACHINE_ORDER_STORAGE_KEY);
    return;
  }
  safeSetItem(target, MACHINE_ORDER_STORAGE_KEY, JSON.stringify(order));
}
