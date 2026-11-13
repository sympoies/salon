import { type PointerEvent, type RefObject, type ReactNode, useEffect, useRef, useState } from "react";
import { moveMachine } from "./machineOrder.ts";
import "./ReorderList.css";

const DRAG_THRESHOLD_PX = 4;

interface Drag {
  readonly key: string;
  readonly pointerId: number;
  readonly startY: number;
  /** Row boxes in base order, read before the preview reorders the DOM. */
  readonly slots: readonly { readonly top: number; readonly bottom: number }[];
  moved: boolean;
  order: readonly string[] | null;
}

/**
 * Pointer-driven reordering of a vertical list of `[data-reorder-key]` rows.
 * The drag is tracked on the document from pointer-down until release, so it
 * keeps reordering wherever the pointer goes. The live preview moves the
 * dragged row's DOM node, which drops the handle's pointer capture; nothing
 * here depends on that capture. Slots are read once in base order and a gap
 * between rows belongs to the nearer row.
 */
export function useReorderDrag({ keys, list, onReorder }: {
  readonly keys: readonly string[];
  readonly list: RefObject<HTMLElement | null>;
  readonly onReorder: (order: readonly string[]) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const [preview, setPreview] = useState<{ readonly key: string; readonly order: readonly string[] } | null>(null);

  const rowSlots = () => [...list.current?.querySelectorAll<HTMLElement>("[data-reorder-key]") ?? []].map(row => {
    const { top, bottom } = row.getBoundingClientRect();
    return { top, bottom };
  });
  // The slot is the row whose box, widened to the middle of the gaps around it, holds the pointer.
  const targetIndex = (slots: Drag["slots"], clientY: number): number => {
    const next = slots.findIndex((slot, index) => index > 0 && clientY < (slots[index - 1]!.bottom + slot.top) / 2);
    return next < 0 ? slots.length - 1 : next - 1;
  };
  const finish = (commit: boolean) => {
    const current = drag.current;
    drag.current = null;
    detach.current?.();
    const order = current?.order;
    setPreview(null);
    if (commit && current?.moved && order && order.some((key, index) => key !== keys[index])) onReorder(order);
  };
  const track = (pointerId: number, clientY: number) => {
    const current = drag.current;
    if (!current || pointerId !== current.pointerId) return;
    if (!current.moved && Math.abs(clientY - current.startY) < DRAG_THRESHOLD_PX) return;
    current.moved = true;
    const order = moveMachine(keys, current.key, targetIndex(current.slots, clientY));
    current.order = order;
    setPreview(previous => previous && previous.order.every((key, index) => key === order[index]) ? previous : { key: current.key, order });
  };
  const latest = useRef({ track, finish });
  latest.current = { track, finish };
  useEffect(() => () => { detach.current?.(); drag.current = null; }, []);

  const begin = (event: PointerEvent<HTMLElement>, key: string) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    detach.current?.();
    drag.current = { key, pointerId: event.pointerId, startY: event.clientY, slots: rowSlots(), moved: false, order: null };
    const document = event.currentTarget.ownerDocument;
    const onMove = (moveEvent: globalThis.PointerEvent) => latest.current.track(moveEvent.pointerId, moveEvent.clientY);
    const onUp = (upEvent: globalThis.PointerEvent) => { if (drag.current?.pointerId === upEvent.pointerId) latest.current.finish(true); };
    const onCancel = (cancelEvent: globalThis.PointerEvent) => { if (drag.current?.pointerId === cancelEvent.pointerId) latest.current.finish(false); };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    detach.current = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      detach.current = null;
    };
  };

  return { shownKeys: preview?.order ?? keys, draggingKey: preview?.key ?? null, begin };
}

/**
 * A list whose rows reorder by dragging the handle (pointer events, so mouse,
 * pen and touch share one path with no native drag image) or by the up/down
 * buttons. The dragged row previews the new order live and the drop saves it.
 * `itemKey` identifies a row; `itemName` optionally names it in control labels.
 */
export function ReorderList<T>({ items, itemKey, itemName, renderLabel, renderActions, onReorder, restore }: {
  readonly items: readonly T[];
  readonly itemKey: (item: T) => string;
  /** Human-readable name for row controls; defaults to the item key. */
  readonly itemName?: (item: T) => string;
  readonly renderLabel: (item: T) => ReactNode;
  readonly renderActions: (item: T) => ReactNode;
  readonly onReorder: (items: readonly T[]) => void;
  /** Optional control rendered after the list, such as a restore-defaults button. */
  readonly restore?: ReactNode;
}) {
  const list = useRef<HTMLUListElement>(null);
  const byKey = new Map(items.map(item => [itemKey(item), item]));
  const { shownKeys, draggingKey, begin } = useReorderDrag({
    keys: items.map(itemKey),
    list,
    onReorder: order => onReorder(order.map(key => byKey.get(key)!)),
  });
  const move = (key: string, offset: -1 | 1) => {
    const keys = items.map(itemKey);
    const to = keys.indexOf(key) + offset;
    if (to < 0 || to >= keys.length) return;
    onReorder(moveMachine(keys, key, to).map(name => byKey.get(name)!));
  };

  return (
    <>
      <ul className="reorder-list" ref={list}>
        {shownKeys.map((key, index) => {
          const item = byKey.get(key)!;
          const name = itemName ? itemName(item) : key;
          return (
            <li key={key} className="reorder-row" data-reorder-key={key} data-dragging={draggingKey === key ? "" : undefined}>
              <button
                type="button"
                className="reorder-handle"
                data-reorder-handle=""
                aria-label={`Drag ${name} to reorder`}
                onPointerDown={(event) => begin(event, key)}
              >
                ⠿
              </button>
              <span className="reorder-row-label">{renderLabel(item)}</span>
              <span className="reorder-row-actions">{renderActions(item)}</span>
              <span className="reorder-moves">
                <button type="button" className="reorder-move" aria-label={`Move ${name} up`} aria-disabled={index === 0} onClick={() => move(key, -1)}>↑</button>
                <button type="button" className="reorder-move" aria-label={`Move ${name} down`} aria-disabled={index === shownKeys.length - 1} onClick={() => move(key, 1)}>↓</button>
              </span>
            </li>
          );
        })}
      </ul>
      {restore}
    </>
  );
}
