import { useSyncExternalStore } from "react";
import type { Session } from "./types.ts";

export interface PromptDeliveryFailure {
  readonly at: string;
  readonly unknown: boolean;
}
const failures = new Map<string, PromptDeliveryFailure>();
const listeners = new Set<() => void>();
const key = (machine: string, id: string, incarnation?: string) => JSON.stringify([machine, id, incarnation ?? ""]);

/** Local delivery evidence contains no prompt text and never survives a new incarnation. */
export function notePromptDelivery(machine: string, id: string, incarnation: string | undefined, result: {ok: boolean; outcomeUnknown?: boolean}): void {
  const identity = key(machine, id, incarnation);
  if (result.ok) failures.delete(identity);
  else {
    failures.delete(identity);
    failures.set(identity, {at: new Date().toISOString(), unknown: Boolean(result.outcomeUnknown)});
    if (failures.size > 256) failures.delete(failures.keys().next().value!);
  }
  for (const listener of listeners) listener();
}
export function promptDeliveryFailure(session: Session): PromptDeliveryFailure | undefined {
  return failures.get(key(session.machine, session.id, session.session_incarnation));
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function usePromptDeliveryFailure(session: Session): PromptDeliveryFailure | undefined {
  return useSyncExternalStore(subscribe, () => promptDeliveryFailure(session), () => undefined);
}
