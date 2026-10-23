export const SLOT_DRAG_TYPE = "application/x-agent-console-slot-index";
const SLOT_DRAG_TEXT_PREFIX = "agent-console-slot:";

export interface SlotDragDataTransfer {
  readonly types: readonly string[];
  effectAllowed?: string;
  dropEffect?: string;
  getData(type: string): string;
  setData(type: string, value: string): void;
}

interface SlotPointLookupTarget {
  closest(selector: string): SlotPointLookupSlot | null;
}

interface SlotPointLookupSlot {
  getAttribute(name: string): string | null;
}

export interface SlotPointLookup {
  elementFromPoint(x: number, y: number): SlotPointLookupTarget | null;
}

function parseSlotIndex(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const index = Number(trimmed);
  return Number.isSafeInteger(index) ? index : null;
}

function slotDragText(index: number): string {
  return `${SLOT_DRAG_TEXT_PREFIX}${index}`;
}

function parseSlotDragText(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(SLOT_DRAG_TEXT_PREFIX)) {
    return null;
  }
  return parseSlotIndex(trimmed.slice(SLOT_DRAG_TEXT_PREFIX.length));
}

function dragTypes(dataTransfer: Pick<SlotDragDataTransfer, "types">): readonly string[] {
  return Array.from(dataTransfer.types ?? []);
}

function safeSetData(dataTransfer: SlotDragDataTransfer, type: string, value: string): void {
  try {
    dataTransfer.setData(type, value);
  } catch {
    /* Some WebViews reject custom drag types; text/plain remains the fallback. */
  }
}

export function writeSlotDragData(dataTransfer: SlotDragDataTransfer, index: number): void {
  const value = String(index);
  safeSetData(dataTransfer, SLOT_DRAG_TYPE, value);
  safeSetData(dataTransfer, "text/plain", slotDragText(index));
  dataTransfer.effectAllowed = "move";
}

export function readSlotDragIndex(dataTransfer: SlotDragDataTransfer): number | null {
  if (dragTypes(dataTransfer).includes("Files")) {
    return null;
  }
  return parseSlotIndex(dataTransfer.getData(SLOT_DRAG_TYPE)) ?? parseSlotDragText(dataTransfer.getData("text/plain"));
}

export function slotDropSourceIndex(
  dataTransfer: SlotDragDataTransfer,
  activeDragIndex: number | null,
): number | null {
  return readSlotDragIndex(dataTransfer) ?? activeDragIndex;
}

export function hasSlotDragData(dataTransfer: SlotDragDataTransfer): boolean {
  const types = dragTypes(dataTransfer);
  if (types.includes("Files")) {
    return false;
  }
  if (types.includes(SLOT_DRAG_TYPE)) {
    return true;
  }
  if (!types.includes("text/plain")) {
    return false;
  }
  const fallback = dataTransfer.getData("text/plain");
  return parseSlotDragText(fallback) !== null;
}

export function slotIndexFromPoint(lookup: SlotPointLookup, x: number, y: number): number | null {
  const target = lookup.elementFromPoint(x, y);
  const slot = target?.closest("[data-slot-index]");
  return parseSlotIndex(slot?.getAttribute("data-slot-index") ?? "");
}
