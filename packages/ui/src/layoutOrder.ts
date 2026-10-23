import { reconcileSlots, type KeyedSession, type SlotKey } from "./layout.ts";

// Cross-device session order is one relative ranking of `machine/id` keys, never
// slot indices: desktop grids are 2/3/4/6 and mobile 1-4, so a slot index is
// meaningless across devices, but a ranked key list fills any grid via
// reconcileSlots. These pure helpers bridge the local slot layout and that
// shared ranking; the Dashboard wires them to /api/layout (see api.ts).

// The order to persist: the sequence of non-null slot keys in slot order
// (deduped). Empty slots don't persist — each device fills its own gaps.
export function deriveLayoutOrder(slots: readonly SlotKey[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const slot of slots) {
    if (slot && !seen.has(slot)) {
      seen.add(slot);
      out.push(slot);
    }
  }
  return out;
}

// Seed this device's grid from a shared ranking: place ranked-and-live keys
// first (dropping any that no longer exist), then append the remaining live
// sessions in their default order, all sized to this device's grid. This is
// exactly reconcileSlots with the ranking as the starting layout (a
// `readonly string[]` is a `readonly SlotKey[]` by covariance — no cast needed).
export function seedSlotsFromOrder(
  order: readonly string[],
  sessions: readonly KeyedSession[],
  size: number,
): SlotKey[] {
  return reconcileSlots(order, sessions, size);
}

// Build the full ranking to persist after a local reorder — the inverse of the
// seed. `localOrder` is this device's placed keys in their new order; it may be
// a strict subset of the shared ranking because a smaller grid or a machine
// filter hides some keys. So we splice the reordered keys back into the
// remembered `previous` ranking: keys the user placed are repositioned in
// order, alive keys this device did NOT place stay anchored where they were,
// keys that no longer exist anywhere are dropped, and newly placed keys not in
// `previous` are appended. This guarantees a small grid never truncates the
// shared order (the bug a naive `deriveLayoutOrder(slots)` PUT would cause).
function defaultKeyMachine(key: string): string {
  const index = key.indexOf("/");
  return index < 0 ? "" : key.slice(0, index);
}

function layoutOrderKeyShouldRemain(
  key: string,
  liveKeys: ReadonlySet<string>,
  reachableMachines: ReadonlySet<string>,
  keyMachine: (key: string) => string,
  knownMachines?: ReadonlySet<string>,
): boolean {
  if (liveKeys.has(key)) {
    return true;
  }
  const machine = keyMachine(key);
  if (!machine || (knownMachines !== undefined && knownMachines.size > 0 && !knownMachines.has(machine))) {
    return false;
  }
  return !reachableMachines.has(machine);
}

function mergeLayoutOrderInternal(
  previous: readonly string[],
  localOrder: readonly string[],
  shouldKeep: (key: string) => boolean,
): string[] {
  const arranged = new Set(localOrder); // keys this device placed -> repositionable
  const queue = [...localOrder]; // their new order, consumed in place
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (key: string | undefined) => {
    if (key !== undefined && !seen.has(key) && shouldKeep(key)) {
      seen.add(key);
      result.push(key);
    }
  };
  for (const key of previous) {
    if (!shouldKeep(key)) {
      continue; // drop a session that no longer exists anywhere
    }
    if (arranged.has(key)) {
      push(queue.shift()); // fill this placed-key slot from the new local order
    } else {
      push(key); // anchor an alive key this device didn't place (other grid/filter)
    }
  }
  for (const key of queue) {
    push(key); // newly placed keys that weren't in the remembered ranking
  }
  return result;
}

// Variant used by the Dashboard sync path: a key absent from the current
// session list is pruned only when its machine is reachable. If a machine is
// transiently down, keep its ranked keys anchored so one bad poll cannot erase
// another machine's layout.
export function mergeLayoutOrderWithReachability(
  previous: readonly string[],
  localOrder: readonly string[],
  liveKeys: ReadonlySet<string>,
  reachableMachines: ReadonlySet<string>,
  keyMachine: (key: string) => string = defaultKeyMachine,
  knownMachines?: ReadonlySet<string>,
): string[] {
  return mergeLayoutOrderInternal(
    previous,
    localOrder,
    (key) => layoutOrderKeyShouldRemain(
      key,
      liveKeys,
      reachableMachines,
      keyMachine,
      knownMachines,
    ),
  );
}

// Passive reconciliation must never let a stale client's full ranking reorder
// a newer remote snapshot. Keep the remote order as the prefix, pruning only
// keys proven gone, then append live keys the remote snapshot does not know yet
// in the client's device-independent order. Explicit user placement uses the
// separate local-prefix helper below.
export function mergeLayoutOrderPreservingRemote(
  remote: readonly string[],
  localOrder: readonly string[],
  liveKeys: ReadonlySet<string>,
  reachableMachines: ReadonlySet<string>,
  keyMachine: (key: string) => string = defaultKeyMachine,
  knownMachines?: ReadonlySet<string>,
): string[] {
  const shouldKeep = (key: string) => layoutOrderKeyShouldRemain(
    key,
    liveKeys,
    reachableMachines,
    keyMachine,
    knownMachines,
  );
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (!seen.has(key) && shouldKeep(key)) {
      seen.add(key);
      result.push(key);
    }
  };
  for (const key of remote) {
    push(key);
  }
  for (const key of localOrder) {
    push(key);
  }
  return result;
}

export function mergeLayoutOrderWithLocalPrefix(
  previous: readonly string[],
  localOrder: readonly string[],
  liveKeys: ReadonlySet<string>,
  reachableMachines: ReadonlySet<string>,
  keyMachine: (key: string) => string = defaultKeyMachine,
  knownMachines?: ReadonlySet<string>,
): string[] {
  const shouldKeep = (key: string) => layoutOrderKeyShouldRemain(
    key,
    liveKeys,
    reachableMachines,
    keyMachine,
    knownMachines,
  );
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (!seen.has(key) && shouldKeep(key)) {
      seen.add(key);
      result.push(key);
    }
  };
  for (const key of localOrder) {
    push(key);
  }
  for (const key of previous) {
    push(key);
  }
  return result;
}

export function orderForCreatedSession(
  nextSlots: readonly (string | null)[],
  createdKey: string,
  placedInSlot: boolean,
): string[] {
  const order = deriveLayoutOrder(nextSlots);
  if (placedInSlot || order.includes(createdKey)) {
    return order;
  }
  return [...order, createdKey];
}

export function removeLayoutOrderKey(order: readonly string[], keyToRemove: string): string[] {
  return order.filter((key) => key !== keyToRemove);
}

// Whether a freshly-derived order differs from the last one we sent, so the
// debounced PUT only fires on a genuine reorder — not on reconcile churn that
// leaves the ranking unchanged.
export function layoutOrderChanged(a: readonly string[], b: readonly string[]): boolean {
  return a.length !== b.length || a.some((key, i) => key !== b[i]);
}

// The complete cross-device ranking: every key the shared order already ranks,
// then every remaining live session in the device-independent default order.
// This is what a device publishes when the user has not reordered anything, so a
// session the shared order does not yet cover gets the same rank everywhere. It
// deliberately ignores the local grid: slot geometry differs per device (a
// desktop grid can hold a hole a phone's never has), so letting an empty slot
// decide a rank is what made two devices disagree.
export function completeLayoutOrder(
  ranking: readonly string[],
  defaultOrderedKeys: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of [...ranking, ...defaultOrderedKeys]) {
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
