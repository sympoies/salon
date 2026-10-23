import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { sortByDefaultSessionOrder } from "../src/format.ts";
import { sessionKey, type SlotKey } from "../src/layout.ts";
import {
  deriveLayoutOrder,
  mergeLayoutOrderWithReachability,
  seedSlotsFromOrder,
} from "../src/layoutOrder.ts";
import {
  orderSessionListSessions,
  paginateSessionList,
  reorderProjectedSessionKeys,
} from "../src/sessionListNavigation.ts";
import type { Session } from "../src/types.ts";
import { useSlotDrag } from "../src/useSlotDrag.ts";
import { makeSession } from "./support/fixtures.ts";

const MACHINES = ["summit"] as const;
const REACHABLE: ReadonlySet<string> = new Set(MACHINES);
const SLOT_COUNT = 2;
const PAGE_SIZE = 2;

// More sessions than the grid shows, so the projected page is a strict prefix of
// the shared ranking — the shape the overview reorder path has to survive.
const SESSIONS: readonly Session[] = [
  makeSession({ id: "hs-a", title: "A", created_at: "2026-08-01T00:00:00Z" }),
  makeSession({ id: "hs-b", title: "B", created_at: "2026-08-01T00:01:00Z" }),
  makeSession({ id: "hs-c", title: "C", created_at: "2026-08-01T00:02:00Z" }),
];
const KEYS = SESSIONS.map(sessionKey);

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

test("a macOS pointer drop reorders the projected overview page", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let projected: readonly string[] = [];
  let latestDrag: ReturnType<typeof useSlotDrag> | null = null;
  const reorders: Array<readonly [number, number]> = [];

  // Mirrors the Dashboard overview composition: shared ranking -> projected page
  // -> reorderVisibleSlots -> optimistic ranking, all through the real helpers.
  function Overview() {
    const [slots, setSlots] = useState<SlotKey[]>([KEYS[0]!, KEYS[1]!]);
    const [optimisticOrder, setOptimisticOrder] = useState<readonly string[] | null>(null);
    const visible = sortByDefaultSessionOrder(SESSIONS, MACHINES);
    const layoutSessionKeys = mergeLayoutOrderWithReachability(
      optimisticOrder ?? KEYS,
      deriveLayoutOrder(slots),
      new Set(KEYS),
      REACHABLE,
      undefined,
      new Set(MACHINES),
    );
    const page = paginateSessionList({
      sessions: orderSessionListSessions({ sessions: visible, preferredSessionKeys: layoutSessionKeys }),
      requestedPage: 1,
      pageSize: PAGE_SIZE,
    });
    projected = page.sessionKeys;
    const drag = useSlotDrag({
      active: true,
      mobile: false,
      setSlots,
      onReorder: (fromIndex, toIndex) => {
        reorders.push([fromIndex, toIndex]);
        const nextOrder = reorderProjectedSessionKeys({
          orderedSessionKeys: layoutSessionKeys,
          pageSessionKeys: page.sessionKeys,
          fromIndex,
          toIndex,
        });
        if (nextOrder.length === layoutSessionKeys.length
          && nextOrder.every((key, index) => key === layoutSessionKeys[index])) {
          return;
        }
        setOptimisticOrder(nextOrder);
        setSlots(seedSlotsFromOrder(nextOrder, visible, SLOT_COUNT));
      },
    });
    latestDrag = drag;
    return createElement(
      "ol",
      null,
      page.sessionKeys.map((key, index) =>
        createElement(
          "li",
          { key, "data-slot-index": String(index) },
          createElement("div", {
            className: "slot-head",
            onPointerDown: (event: React.PointerEvent<HTMLElement>) => drag.beginSlotPointerDrag(event, index),
          }),
        )),
    );
  }

  await act(async () => {
    mounted.root.render(createElement(Overview));
  });
  assert.deepEqual(projected, [KEYS[0], KEYS[1]]);

  const heads = mounted.container.querySelectorAll(".slot-head");
  const sourceHead = heads[0] as unknown as HTMLElement;
  const targetSlot = mounted.container.querySelectorAll("[data-slot-index]")[1];
  assert.ok(sourceHead);
  assert.ok(targetSlot);
  Object.defineProperty(mounted.window.document, "elementFromPoint", {
    configurable: true,
    value: () => targetSlot,
  });

  const pointerEvent = (type: string, x: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: 20 },
      pointerId: { value: 11 },
      button: { value: 0 },
      isPrimary: { value: true },
    });
    return event;
  };

  await act(async () => {
    sourceHead.dispatchEvent(pointerEvent("pointerdown", 100));
  });
  await act(async () => {
    mounted.window.dispatchEvent(pointerEvent("pointermove", 400));
  });
  assert.equal(latestDrag?.slotPointerDragIndex, 0, "the press should engage a pointer drag");
  assert.equal(latestDrag?.slotPointerTargetIndex, 1, "the hovered slot should be the drop target");
  await act(async () => {
    mounted.window.dispatchEvent(pointerEvent("pointerup", 400));
  });

  assert.deepEqual(reorders, [[0, 1]], "the drop should request a reorder");
  assert.deepEqual(projected, [KEYS[1], KEYS[0]]);
});
