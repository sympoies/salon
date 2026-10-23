import type { SlotKey } from "./layout.ts";

/** Auto uses the current filtered list; fixed layouts retain their local slots. */
export function projectFocusedGridSlots({ automatic, orderedSessionKeys, localSlots, slotCount }: {
  readonly automatic: boolean;
  readonly orderedSessionKeys: readonly string[];
  readonly localSlots: readonly SlotKey[];
  readonly slotCount: number;
}): SlotKey[] {
  if (!automatic) return [...localSlots];
  return Array.from({ length: slotCount }, (_, index) => orderedSessionKeys[index] ?? null);
}
