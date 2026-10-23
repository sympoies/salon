export const HELD_COUNTS_MAX_UNAVAILABLE_MS = 60_000;

export interface HeaderCountObservation {
  readonly seenOnline: boolean;
  readonly unavailableSince: number | null;
}
export interface OfflineCountMachine {
  readonly name: string;
  readonly since: number;
  readonly held: boolean;
}
export interface HeaderCountAvailability {
  readonly observations: ReadonlyMap<string, HeaderCountObservation>;
  readonly includedMachines: ReadonlySet<string>;
  readonly offlineMachines: readonly OfflineCountMachine[];
  readonly available: boolean;
}

export function updateHeaderCountAvailability(
  previous: ReadonlyMap<string, HeaderCountObservation>,
  machines: readonly { name: string; ok: boolean; active?: boolean }[],
  responseOk: boolean,
  nowMs: number,
): HeaderCountAvailability {
  const observations = new Map<string, HeaderCountObservation>();
  const includedMachines = new Set<string>();
  const offlineMachines: OfflineCountMachine[] = [];
  const statuses = !responseOk && machines.length === 0
    ? [...previous.keys()].map(name => ({ name, ok: false, active: true }))
    : machines;
  for (const machine of statuses) {
    if (machine.active === false) continue;
    const prior = previous.get(machine.name);
    const online = responseOk && machine.ok;
    const unavailableSince = online ? null : prior?.unavailableSince ?? nowMs;
    const seenOnline = online || prior?.seenOnline === true;
    const held = !online && seenOnline && nowMs - unavailableSince! <= HELD_COUNTS_MAX_UNAVAILABLE_MS;
    observations.set(machine.name, { seenOnline, unavailableSince });
    if (online || held) includedMachines.add(machine.name);
    if (!online) offlineMachines.push({ name: machine.name, since: unavailableSince!, held });
  }
  return { observations, includedMachines, offlineMachines,
    available: includedMachines.size > 0 || (responseOk && observations.size === 0) };
}

export function sameHeaderCountAvailability(a: HeaderCountAvailability, b: HeaderCountAvailability): boolean {
  return a.available === b.available
    && a.includedMachines.size === b.includedMachines.size
    && [...a.includedMachines].every(name => b.includedMachines.has(name))
    && a.offlineMachines.length === b.offlineMachines.length
    && a.offlineMachines.every((machine, i) => {
      const other = b.offlineMachines[i]!;
      return machine.name === other.name && machine.since === other.since && machine.held === other.held;
    });
}
