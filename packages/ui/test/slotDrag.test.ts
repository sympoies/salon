import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SLOT_DRAG_TYPE,
  hasSlotDragData,
  readSlotDragIndex,
  slotIndexFromPoint,
  slotDropSourceIndex,
  writeSlotDragData,
} from "../src/slotDrag.ts";
import { swapSlots } from "../src/layout.ts";

function dataTransfer(types: string[] = [], throwingTypes = new Set<string>()) {
  const data = new Map<string, string>();
  return {
    types,
    effectAllowed: "all",
    dropEffect: "none",
    setData(type: string, value: string) {
      if (throwingTypes.has(type)) {
        throw new Error(`unsupported drag type: ${type}`);
      }
      if (!types.includes(type)) {
        types.push(type);
      }
      data.set(type, value);
    },
    getData(type: string) {
      return data.get(type) ?? "";
    },
  };
}

test("slot drag writes WebKit-safe data and move effect", () => {
  const transfer = dataTransfer();

  writeSlotDragData(transfer, 2);

  assert.equal(transfer.getData(SLOT_DRAG_TYPE), "2");
  assert.equal(transfer.getData("text/plain"), "agent-console-slot:2");
  assert.equal(transfer.effectAllowed, "move");
});

test("slot drag reads custom data before text/plain fallback", () => {
  const transfer = dataTransfer();
  transfer.setData("text/plain", "agent-console-slot:1");
  transfer.setData(SLOT_DRAG_TYPE, "3");

  assert.equal(readSlotDragIndex(transfer), 3);
});

test("slot drag accepts scoped text/plain fallback and rejects file drops", () => {
  const transfer = dataTransfer();
  transfer.setData("text/plain", "agent-console-slot:4");

  assert.equal(hasSlotDragData(transfer), true);
  assert.equal(readSlotDragIndex(transfer), 4);
  assert.equal(hasSlotDragData(dataTransfer(["Files", "text/plain"])), false);
  assert.equal(readSlotDragIndex(dataTransfer(["Files", "text/plain"])), null);
});

test("slot drag rejects unscoped text/plain payloads", () => {
  const transfer = dataTransfer();
  transfer.setData("text/plain", "4");

  assert.equal(hasSlotDragData(transfer), false);
  assert.equal(readSlotDragIndex(transfer), null);
});

test("slot drag falls back when custom drag type is unsupported", () => {
  const transfer = dataTransfer([], new Set([SLOT_DRAG_TYPE]));

  assert.doesNotThrow(() => writeSlotDragData(transfer, 1));
  assert.equal(transfer.getData(SLOT_DRAG_TYPE), "");
  assert.equal(transfer.getData("text/plain"), "agent-console-slot:1");
  assert.equal(readSlotDragIndex(transfer), 1);
  assert.equal(transfer.effectAllowed, "move");
});

test("slot drop source swaps panes from scoped drag data", () => {
  const transfer = dataTransfer();
  writeSlotDragData(transfer, 0);

  const from = slotDropSourceIndex(transfer, null);
  assert.equal(from, 0);
  assert.deepEqual(swapSlots(["summit/a", "summit/b"], from!, 1), ["summit/b", "summit/a"]);
});

test("slot drop source can use the active dashboard drag when payload data is hidden", () => {
  const transfer = dataTransfer(["text/plain"]);

  assert.equal(slotDropSourceIndex(transfer, 2), 2);
  assert.equal(slotDropSourceIndex(transfer, null), null);
});

test("slot pointer fallback resolves a drop target from release coordinates", () => {
  const slot = {
    getAttribute(name: string) {
      assert.equal(name, "data-slot-index");
      return "1";
    },
  };
  const target = {
    closest(selector: string) {
      assert.equal(selector, "[data-slot-index]");
      return slot;
    },
  };
  const lookup = {
    elementFromPoint(x: number, y: number) {
      assert.equal(x, 24);
      assert.equal(y, 48);
      return target;
    },
  };

  const to = slotIndexFromPoint(lookup, 24, 48);

  assert.equal(to, 1);
  assert.deepEqual(swapSlots(["summit/a", "summit/b"], 0, to!), ["summit/b", "summit/a"]);
});

test("slot pointer fallback ignores non-slot release targets", () => {
  const lookup = {
    elementFromPoint() {
      return {
        closest: () => null,
      };
    },
  };

  assert.equal(slotIndexFromPoint(lookup, 24, 48), null);
});
