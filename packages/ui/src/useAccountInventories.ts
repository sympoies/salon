import { useEffect, useMemo, useState } from "react";
import {
  ACCOUNT_PROVIDERS,
  machineServesAccountSwitch,
  type AccountProvider,
  type MachineStatus,
} from "@agent-console/shared/api";
import { listAccounts } from "./api.ts";
import {
  reconcileAccountInventories,
  type AccountInventories,
  type AccountInventoriesByProvider,
} from "./sessionAccounts.ts";

const ACCOUNT_INVENTORY_POLL_MS = 30_000;

/**
 * Newline-joined, sorted names of the machines serving each provider's account
 * switch. A machine whose status is unknown takes the provider's no-flag
 * default: the Codex switch predates the capability flag, so a Codex machine
 * stays polled and keeps its last-good inventory through an outage, while a
 * Claude machine drops out until it advertises the switch again. Strings keep
 * an unchanged set from restarting the inventory poll.
 */
export function accountMachineKeys(
  machines: readonly MachineStatus[],
): Readonly<Record<AccountProvider, string>> {
  const keys = {} as Record<AccountProvider, string>;
  for (const provider of ACCOUNT_PROVIDERS) {
    keys[provider] = machines
      .filter((machine) => machine.active !== false && machineServesAccountSwitch(provider, machine.ok ? machine.capabilities : undefined))
      .map((machine) => machine.name)
      .sort()
      .join("\n");
  }
  return keys;
}

function useAccountInventory(provider: AccountProvider, machineKey: string): AccountInventories {
  const [inventories, setInventories] = useState<AccountInventories>({});
  useEffect(() => {
    const machines = machineKey ? machineKey.split("\n") : [];
    if (machines.length === 0) {
      setInventories({});
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const refresh = () => {
      void Promise.all(machines.map(async (machine) => [
        machine,
        await listAccounts(provider, machine, controller.signal).catch(() => null),
      ] as const)).then((entries) => {
        if (!cancelled) setInventories((current) => reconcileAccountInventories(current, entries));
      });
    };
    refresh();
    const timer = window.setInterval(refresh, ACCOUNT_INVENTORY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      controller.abort();
    };
  }, [provider, machineKey]);
  return inventories;
}

/** Every serving machine's account inventory, per provider, polled and kept through outages. */
export function useAccountInventories(
  machineKeys: Readonly<Record<AccountProvider, string>>,
): AccountInventoriesByProvider {
  const codex = useAccountInventory("codex", machineKeys.codex);
  const claude = useAccountInventory("claude", machineKeys.claude);
  return useMemo(() => ({ codex, claude }), [codex, claude]);
}
