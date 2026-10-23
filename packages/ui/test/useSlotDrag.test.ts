import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SlotKey } from "../src/layout.ts";
import { useSlotDrag, type UseSlotDragResult } from "../src/useSlotDrag.ts";

const cleanupStack: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function installDom(): {
  readonly window: Window;
  readonly root: Root;
  readonly container: HTMLElement;
  cleanup(): Promise<void>;
} {
  const window = new Window({ url: "tauri://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
  Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  return {
    window,
    root,
    container,
    async cleanup() {
      await act(async () => root.unmount());
      Object.assign(globalThis, {
        window: previous.window,
        document: previous.document,
        Element: previous.Element,
        HTMLElement: previous.HTMLElement,
        IS_REACT_ACT_ENVIRONMENT: previous.IS_REACT_ACT_ENVIRONMENT,
      });
      if (previous.navigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", previous.navigatorDescriptor);
      } else {
        delete (globalThis as { navigator?: Navigator }).navigator;
      }
      await window.happyDOM.close();
    },
  };
}

function dataTransfer() {
  const types: string[] = [];
  const data = new Map<string, string>();
  return {
    types,
    effectAllowed: "all",
    dropEffect: "none",
    setData(type: string, value: string) {
      if (!types.includes(type)) types.push(type);
      data.set(type, value);
    },
    getData(type: string) {
      return data.get(type) ?? "";
    },
  };
}

for (const role of ["dialog", "tooltip", null]) {
  test(`macOS Activity text movement ${role ? `inside ${role} does not reorder` : "in an ordinary header still reorders"}`, async () => {
    const mounted = installDom();
    cleanupStack.push(mounted.cleanup);
    let latestDrag: UseSlotDragResult | null = null;
    const reorders: Array<readonly [number, number]> = [];
    function Probe() {
      const [slots, setSlots] = useState<SlotKey[]>(["fixture/a", "fixture/b"]);
      latestDrag = useSlotDrag({ active: true, mobile: false, setSlots,
        onReorder: (from, to) => { reorders.push([from, to]); } });
      void slots;
      return createElement("div");
    }
    await act(async () => mounted.root.render(createElement(Probe)));
    const panel = mounted.window.document.createElement("span");
    if (role) panel.setAttribute("role", role);
    const value = mounted.window.document.createElement("span");
    value.textContent = "selectable activity value";
    panel.append(value);
    mounted.container.append(panel);
    const targetSlot = mounted.window.document.createElement("div");
    targetSlot.dataset.slotIndex = "1";
    Object.defineProperty(mounted.window.document, "elementFromPoint", { configurable: true, value: () => targetSlot });
    latestDrag!.beginSlotPointerDrag({ button: 0, isPrimary: true, target: value, currentTarget: panel,
      clientX: 0, clientY: 0, pointerId: 17 } as unknown as React.PointerEvent<HTMLElement>, 0);
    const pointer = (type: string) => {
      const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { clientX: { value: 20 }, clientY: { value: 0 }, pointerId: { value: 17 } });
      return event;
    };
    await act(async () => {
      mounted.window.dispatchEvent(pointer("pointermove"));
      mounted.window.dispatchEvent(pointer("pointerup"));
    });
    assert.deepEqual(reorders, role ? [] : [[0, 1]], "popup text selection is independent of ordinary header dragging");
  });
}

test("an inactive dashboard cannot leave native drag state armed after activation", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let latestDrag: UseSlotDragResult | null = null;
  let latestSlots: readonly SlotKey[] = [];

  function Probe({ active }: { readonly active: boolean }) {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestDrag = useSlotDrag({ active, mobile: false, setSlots });
    latestSlots = slots;
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe, { active: true }));
  });
  const armedDrag = latestDrag;
  assert.ok(armedDrag);
  const armedTransfer = dataTransfer();
  armedDrag.handleSlotDragStart({
    dataTransfer: armedTransfer,
  } as unknown as ReactDragEvent<HTMLElement>, 0);
  assert.notDeepEqual(armedTransfer.types, []);

  await act(async () => {
    mounted.root.render(createElement(Probe, { active: false }));
  });
  await act(async () => {
    mounted.root.render(createElement(Probe, { active: true }));
  });
  const activeDrag = latestDrag;
  assert.ok(activeDrag);
  await act(async () => {
    activeDrag.handleSlotDrop({
      dataTransfer: armedTransfer,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as ReactDragEvent<HTMLElement>, 1);
  });

  assert.deepEqual(latestSlots, ["summit/a", "summit/b"]);
});

test("an inactive macOS pointer-down cannot complete after the dashboard activates", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let latestDrag: UseSlotDragResult | null = null;
  let latestSlots: readonly SlotKey[] = [];

  function Probe({ active }: { readonly active: boolean }) {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestDrag = useSlotDrag({ active, mobile: false, setSlots });
    latestSlots = slots;
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe, { active: true }));
  });
  const armedDrag = latestDrag;
  assert.ok(armedDrag);
  const handle = mounted.window.document.createElement("div");
  armedDrag.beginSlotPointerDrag({
    button: 0,
    isPrimary: true,
    target: handle,
    currentTarget: handle,
    clientX: 0,
    clientY: 0,
    pointerId: 7,
  } as unknown as React.PointerEvent<HTMLElement>, 0);

  const targetSlot = mounted.window.document.createElement("div");
  targetSlot.dataset.slotIndex = "1";
  Object.defineProperty(mounted.window.document, "elementFromPoint", {
    configurable: true,
    value: () => targetSlot,
  });
  await act(async () => {
    mounted.root.render(createElement(Probe, { active: false }));
  });
  await act(async () => {
    mounted.root.render(createElement(Probe, { active: true }));
  });

  const pointerEvent = (type: string, x: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: 0 },
      pointerId: { value: 7 },
    });
    return event;
  };
  await act(async () => {
    mounted.window.dispatchEvent(pointerEvent("pointermove", 12));
    mounted.window.dispatchEvent(pointerEvent("pointerup", 12));
  });

  assert.deepEqual(latestSlots, ["summit/a", "summit/b"]);
  assert.equal(latestDrag?.slotPointerDragIndex, null);
});

test("an in-flight macOS pointer drag survives session churn that rebuilds the reorder callback", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let latestDrag: UseSlotDragResult | null = null;
  const reorders: Array<readonly [number, number]> = [];

  // The dashboard rebuilds onReorder whenever polled sessions or the activity
  // stream replace the session list identity, which happens continuously while
  // agents are running. A pointer drag has to outlive those re-renders.
  function Probe({ churn }: { readonly churn: number }) {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestDrag = useSlotDrag({
      active: true,
      mobile: false,
      setSlots,
      onReorder: (fromIndex, toIndex) => {
        void churn;
        reorders.push([fromIndex, toIndex]);
      },
    });
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe, { churn: 0 }));
  });
  const drag = latestDrag;
  assert.ok(drag);
  const handle = mounted.window.document.createElement("div");
  drag.beginSlotPointerDrag({
    button: 0,
    isPrimary: true,
    target: handle,
    currentTarget: handle,
    clientX: 0,
    clientY: 0,
    pointerId: 9,
  } as unknown as React.PointerEvent<HTMLElement>, 0);

  const targetSlot = mounted.window.document.createElement("div");
  targetSlot.dataset.slotIndex = "1";
  Object.defineProperty(mounted.window.document, "elementFromPoint", {
    configurable: true,
    value: () => targetSlot,
  });
  const pointerEvent = (type: string, x: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: 0 },
      pointerId: { value: 9 },
    });
    return event;
  };

  // A refresh lands between the pointer-down and the first move past the threshold.
  await act(async () => {
    mounted.root.render(createElement(Probe, { churn: 1 }));
  });
  await act(async () => {
    mounted.window.dispatchEvent(pointerEvent("pointermove", 12));
  });
  assert.equal(latestDrag?.slotPointerDragIndex, 0);
  assert.equal(latestDrag?.slotPointerTargetIndex, 1);

  // A second refresh lands mid-drag, before the drop.
  await act(async () => {
    mounted.root.render(createElement(Probe, { churn: 2 }));
  });
  await act(async () => {
    mounted.window.dispatchEvent(pointerEvent("pointermove", 24));
    mounted.window.dispatchEvent(pointerEvent("pointerup", 24));
  });

  assert.deepEqual(reorders, [[0, 1]]);
  assert.equal(latestDrag?.slotPointerDragIndex, null);
  assert.equal(latestDrag?.slotPointerTargetIndex, null);
});

test("a macOS pointer drop lands on the highlighted target when the release point resolves to nothing", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let latestDrag: UseSlotDragResult | null = null;
  const reorders: Array<readonly [number, number]> = [];

  function Probe() {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestDrag = useSlotDrag({
      active: true,
      mobile: false,
      setSlots,
      onReorder: (fromIndex, toIndex) => reorders.push([fromIndex, toIndex]),
    });
    void slots;
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  const drag = latestDrag;
  assert.ok(drag);
  const handle = mounted.window.document.createElement("div");
  drag.beginSlotPointerDrag({
    button: 0,
    isPrimary: true,
    target: handle,
    currentTarget: handle,
    clientX: 0,
    clientY: 0,
    pointerId: 12,
  } as unknown as React.PointerEvent<HTMLElement>, 0);

  const targetSlot = mounted.window.document.createElement("div");
  targetSlot.dataset.slotIndex = "1";
  let hit: unknown = targetSlot;
  Object.defineProperty(mounted.window.document, "elementFromPoint", {
    configurable: true,
    value: () => hit,
  });
  const pointerEvent = (type: string, x: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: 0 },
      pointerId: { value: 12 },
    });
    return event;
  };

  await act(async () => {
    mounted.window.dispatchEvent(pointerEvent("pointermove", 12));
  });
  assert.equal(latestDrag?.slotPointerTargetIndex, 1);

  // The release point no longer resolves to a slot, as happens when the drag
  // re-rendered the grid underneath the pointer.
  hit = null;
  await act(async () => {
    mounted.window.dispatchEvent(pointerEvent("pointerup", 12));
  });

  assert.deepEqual(reorders, [[0, 1]]);
  assert.equal(latestDrag?.slotPointerDragIndex, null);
});

test("a macOS pointer drag cancelled by the engine still drops on the highlighted target", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let latestDrag: UseSlotDragResult | null = null;
  const reorders: Array<readonly [number, number]> = [];

  function Probe() {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestDrag = useSlotDrag({
      active: true,
      mobile: false,
      setSlots,
      onReorder: (fromIndex, toIndex) => reorders.push([fromIndex, toIndex]),
    });
    void slots;
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  const drag = latestDrag;
  assert.ok(drag);
  const handle = mounted.window.document.createElement("div");
  drag.beginSlotPointerDrag({
    button: 0,
    isPrimary: true,
    target: handle,
    currentTarget: handle,
    clientX: 0,
    clientY: 0,
    pointerId: 13,
  } as unknown as React.PointerEvent<HTMLElement>, 0);

  const targetSlot = mounted.window.document.createElement("div");
  targetSlot.dataset.slotIndex = "1";
  Object.defineProperty(mounted.window.document, "elementFromPoint", {
    configurable: true,
    value: () => targetSlot,
  });
  const pointerEvent = (type: string, x: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: 0 },
      pointerId: { value: 13 },
    });
    return event;
  };

  await act(async () => {
    mounted.window.dispatchEvent(pointerEvent("pointermove", 12));
    mounted.window.dispatchEvent(pointerEvent("pointercancel", 12));
  });

  assert.deepEqual(reorders, [[0, 1]]);
  assert.equal(latestDrag?.slotPointerDragIndex, null);
  assert.equal(latestDrag?.slotPointerTargetIndex, null);
});

test("a macOS pointer drag cancelled without a target leaves the order alone", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let latestDrag: UseSlotDragResult | null = null;
  const reorders: Array<readonly [number, number]> = [];

  function Probe() {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestDrag = useSlotDrag({
      active: true,
      mobile: false,
      setSlots,
      onReorder: (fromIndex, toIndex) => reorders.push([fromIndex, toIndex]),
    });
    void slots;
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  const drag = latestDrag;
  assert.ok(drag);
  const handle = mounted.window.document.createElement("div");
  drag.beginSlotPointerDrag({
    button: 0,
    isPrimary: true,
    target: handle,
    currentTarget: handle,
    clientX: 0,
    clientY: 0,
    pointerId: 14,
  } as unknown as React.PointerEvent<HTMLElement>, 0);

  Object.defineProperty(mounted.window.document, "elementFromPoint", {
    configurable: true,
    value: () => null,
  });
  const pointerEvent = (type: string, x: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: 0 },
      pointerId: { value: 14 },
    });
    return event;
  };

  await act(async () => {
    mounted.window.dispatchEvent(pointerEvent("pointermove", 12));
    mounted.window.dispatchEvent(pointerEvent("pointercancel", 12));
  });

  assert.deepEqual(reorders, []);
  assert.equal(latestDrag?.slotPointerDragIndex, null);
});

test("an active macOS pointer drag delegates overview reordering without rewriting focused slots", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let latestDrag: UseSlotDragResult | null = null;
  let latestSlots: readonly SlotKey[] = [];
  const reorders: Array<readonly [number, number]> = [];

  function Probe() {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestDrag = useSlotDrag({
      active: true,
      mobile: false,
      setSlots,
      onReorder: (fromIndex, toIndex) => reorders.push([fromIndex, toIndex]),
    });
    latestSlots = slots;
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
  });
  const drag = latestDrag;
  assert.ok(drag);
  const handle = mounted.window.document.createElement("div");
  drag.beginSlotPointerDrag({
    button: 0,
    isPrimary: true,
    target: handle,
    currentTarget: handle,
    clientX: 0,
    clientY: 0,
    pointerId: 8,
  } as unknown as React.PointerEvent<HTMLElement>, 0);

  const targetSlot = mounted.window.document.createElement("div");
  targetSlot.dataset.slotIndex = "1";
  Object.defineProperty(mounted.window.document, "elementFromPoint", {
    configurable: true,
    value: () => targetSlot,
  });
  const pointerEvent = (type: string, x: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: 0 },
      pointerId: { value: 8 },
    });
    return event;
  };

  await act(async () => {
    mounted.window.dispatchEvent(pointerEvent("pointermove", 12));
    mounted.window.dispatchEvent(pointerEvent("pointerup", 12));
  });

  assert.deepEqual(reorders, [[0, 1]]);
  assert.deepEqual(latestSlots, ["summit/a", "summit/b"]);
});
