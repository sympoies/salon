import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import { moveMachine } from "./machineOrder.ts";

const DRAG_THRESHOLD_PX = 4;

interface Drag {
  readonly machine: string;
  readonly pointerId: number;
  readonly startY: number;
  /** Row boxes in base order, read before the preview reorders the DOM. */
  readonly slots: readonly { readonly top: number; readonly bottom: number }[];
  moved: boolean;
  order: readonly string[] | null;
}

/**
 * The Machines list. Rows reorder by dragging the handle (pointer events, so
 * mouse, pen and touch share one path with no native drag image) or by the
 * up/down buttons. The dragged row previews the new order live and the drop
 * saves it.
 */
export function MachineOrderList({ machines, onReorder, renderActions }: {
  readonly machines: readonly string[];
  readonly onReorder: (order: readonly string[]) => void;
  readonly renderActions: (machine: string) => ReactNode;
}) {
  const list = useRef<HTMLUListElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ readonly machine: string; readonly order: readonly string[] } | null>(null);
  const shown = preview?.order ?? machines;

  const rowSlots = () => [...list.current?.querySelectorAll<HTMLElement>("[data-machine]") ?? []].map(row => {
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
    const order = current?.order;
    setPreview(null);
    if (commit && current?.moved && order && order.some((name, index) => name !== machines[index])) onReorder(order);
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>, machine: string) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { machine, pointerId: event.pointerId, startY: event.clientY, slots: rowSlots(), moved: false, order: null };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.moved && Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD_PX) return;
    current.moved = true;
    const order = moveMachine(machines, current.machine, targetIndex(current.slots, event.clientY));
    current.order = order;
    setPreview(previous => previous && previous.order.every((name, index) => name === order[index]) ? previous : { machine: current.machine, order });
  };
  const move = (machine: string, offset: -1 | 1) => {
    const index = machines.indexOf(machine);
    const to = index + offset;
    if (to < 0 || to >= machines.length) return;
    onReorder(moveMachine(machines, machine, to));
  };

  return (
    <ul className="settings-machines" ref={list}>
      {shown.map((machine, index) => (
        <li key={machine} className="settings-row" data-machine={machine} data-dragging={preview?.machine === machine ? "" : undefined}>
          <button
            type="button"
            className="machine-order-handle"
            data-machine-handle=""
            aria-label={`Drag ${machine} to reorder`}
            onPointerDown={(event) => onPointerDown(event, machine)}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) finish(true); }}
            onPointerCancel={() => finish(false)}
          >
            ⠿
          </button>
          <span className="settings-row-label">{machine}</span>
          <span className="settings-row-actions">{renderActions(machine)}</span>
          <span className="machine-order-moves">
            <button type="button" className="machine-order-move" aria-label={`Move ${machine} up`} aria-disabled={index === 0} onClick={() => move(machine, -1)}>↑</button>
            <button type="button" className="machine-order-move" aria-label={`Move ${machine} down`} aria-disabled={index === shown.length - 1} onClick={() => move(machine, 1)}>↓</button>
          </span>
        </li>
      ))}
    </ul>
  );
}
