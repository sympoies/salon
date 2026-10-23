import {
  type Dispatch,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { swapSlots, type SlotKey } from "./layout.ts";
import { isMacTauri } from "./runtime.ts";
import { slotIndexFromPoint, writeSlotDragData } from "./slotDrag.ts";

const SLOT_POINTER_DRAG_THRESHOLD_PX = 4;
const SLOT_POINTER_CLICK_SUPPRESS_MS = 250;

interface SlotPointerDrag {
  readonly from: number;
  readonly startX: number;
  readonly startY: number;
  readonly pointerId: number;
  dragging: boolean;
  /** The slot the pointer last hovered, i.e. the drop target the user saw highlighted. */
  target: number | null;
}

interface UseSlotDragOptions {
  readonly active: boolean;
  readonly mobile: boolean;
  readonly setSlots: Dispatch<SetStateAction<SlotKey[]>>;
  readonly onReorder?: (fromIndex: number, toIndex: number) => void;
}

export interface UseSlotDragResult {
  readonly slotNativeDragEnabled: boolean;
  readonly slotPointerDragIndex: number | null;
  readonly slotPointerTargetIndex: number | null;
  readonly handleSlotDragOver: (event: DragEvent<HTMLElement>, index: number) => void;
  readonly handleSlotDrop: (event: DragEvent<HTMLElement>, index: number) => void;
  readonly handleSlotDragStart: (event: DragEvent<HTMLElement>, index: number) => void;
  readonly handleSlotDragEnd: () => void;
  readonly beginSlotPointerDrag: (event: ReactPointerEvent<HTMLElement>, index: number) => void;
  readonly suppressSlotPointerClick: (event: ReactMouseEvent<HTMLElement>) => void;
}

export function useSlotDrag({
  active,
  mobile,
  setSlots,
  onReorder,
}: UseSlotDragOptions): UseSlotDragResult {
  const [slotPointerDragIndex, setSlotPointerDragIndex] = useState<number | null>(null);
  const [slotPointerTargetIndex, setSlotPointerTargetIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const pointerDragRef = useRef<SlotPointerDrag | null>(null);
  const suppressSlotPointerClickUntilRef = useRef(0);
  const slotNativeDragEnabled = active && !mobile && !isMacTauri();

  const swapSlot = useCallback((index: number, from: number | null = dragIndexRef.current) => {
    dragIndexRef.current = null;
    if (!active || from === null) {
      return;
    }
    if (onReorder) {
      onReorder(from, index);
      return;
    }
    setSlots((prev) => swapSlots(prev, from, index));
  }, [active, onReorder, setSlots]);

  // The dashboard rebuilds onReorder whenever the polled session list or the
  // activity stream replaces the session array, so swapSlot changes identity
  // continuously while agents run. The pointer-drag listeners read it through a
  // ref: resubscribing on every rebuild would discard the in-flight drag.
  const swapSlotRef = useRef(swapSlot);
  useEffect(() => {
    swapSlotRef.current = swapSlot;
  }, [swapSlot]);

  const handleSlotDragOver = useCallback((event: DragEvent<HTMLElement>, index: number) => {
    if (!active || mobile) {
      return;
    }
    const from = dragIndexRef.current;
    if (from === null) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, [active, mobile]);

  const handleSlotDrop = useCallback((event: DragEvent<HTMLElement>, index: number) => {
    if (!active || mobile) {
      return;
    }
    const from = dragIndexRef.current;
    if (from === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    swapSlot(index, from);
  }, [active, mobile, swapSlot]);

  const handleSlotDragStart = useCallback((event: DragEvent<HTMLElement>, index: number) => {
    if (!active) {
      dragIndexRef.current = null;
      return;
    }
    dragIndexRef.current = index;
    writeSlotDragData(event.dataTransfer, index);
  }, [active]);

  const handleSlotDragEnd = useCallback(() => {
    dragIndexRef.current = null;
  }, []);

  const beginSlotPointerDrag = useCallback((event: ReactPointerEvent<HTMLElement>, index: number) => {
    if (!active || mobile || !isMacTauri() || event.button !== 0 || !event.isPrimary) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button,input,textarea,select,a,[role=dialog],[role=tooltip]")) {
      return;
    }
    pointerDragRef.current = {
      from: index,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      dragging: false,
      target: null,
    };
  }, [active, mobile]);

  const suppressSlotPointerClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (Date.now() > suppressSlotPointerClickUntilRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    dragIndexRef.current = null;
    pointerDragRef.current = null;
    if (!active || mobile || !isMacTauri()) {
      setSlotPointerDragIndex(null);
      setSlotPointerTargetIndex(null);
      return;
    }
    const updateSlotPointerDrag = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag) {
        return;
      }
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (!drag.dragging) {
        if (distance < SLOT_POINTER_DRAG_THRESHOLD_PX) {
          return;
        }
        drag.dragging = true;
        setSlotPointerDragIndex(drag.from);
        setSlotPointerTargetIndex(null);
      }
      event.preventDefault();
      const target = slotIndexFromPoint(document, event.clientX, event.clientY);
      drag.target = target === drag.from ? null : target;
      setSlotPointerTargetIndex(drag.target);
    };
    // The drop lands on the slot the user saw highlighted, not on a fresh
    // elementFromPoint lookup taken at release: WebKit resolves that release
    // point against a DOM the dashboard has re-rendered many times during the
    // drag, and a miss there silently dropped the whole gesture.
    const endSlotPointerDrag = (event: PointerEvent, dropped: boolean) => {
      const drag = pointerDragRef.current;
      pointerDragRef.current = null;
      if (!drag?.dragging) {
        return;
      }
      setSlotPointerDragIndex(null);
      setSlotPointerTargetIndex(null);
      event.preventDefault();
      event.stopPropagation();
      suppressSlotPointerClickUntilRef.current = Date.now() + SLOT_POINTER_CLICK_SUPPRESS_MS;
      const to = drag.target ?? (dropped ? slotIndexFromPoint(document, event.clientX, event.clientY) : null);
      if (to === null || to === drag.from) {
        return;
      }
      swapSlotRef.current(to, drag.from);
    };
    const finishSlotPointerDrag = (event: PointerEvent) => endSlotPointerDrag(event, true);
    // WebKit ends a captured mouse/trackpad drag with pointercancel when the
    // pressed element is re-rendered away mid-gesture, which the dashboard does
    // constantly. Treat it as a drop on the tracked target rather than losing
    // the reorder the user already aimed.
    const cancelSlotPointerDrag = (event: PointerEvent) => endSlotPointerDrag(event, false);

    window.addEventListener("pointermove", updateSlotPointerDrag, { capture: true });
    window.addEventListener("pointerup", finishSlotPointerDrag, { capture: true });
    window.addEventListener("pointercancel", cancelSlotPointerDrag, { capture: true });
    return () => {
      window.removeEventListener("pointermove", updateSlotPointerDrag, { capture: true });
      window.removeEventListener("pointerup", finishSlotPointerDrag, { capture: true });
      window.removeEventListener("pointercancel", cancelSlotPointerDrag, { capture: true });
    };
  }, [active, mobile]);

  return {
    slotNativeDragEnabled,
    slotPointerDragIndex,
    slotPointerTargetIndex,
    handleSlotDragOver,
    handleSlotDrop,
    handleSlotDragStart,
    handleSlotDragEnd,
    beginSlotPointerDrag,
    suppressSlotPointerClick,
  };
}
