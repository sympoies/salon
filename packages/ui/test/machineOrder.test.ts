import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MACHINE_ORDER_STORAGE_KEY,
  loadMachineOrder,
  moveMachine,
  orderMachines,
  saveMachineOrder,
} from "../src/machineOrder.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const SERVER = ["cedar", "mesa", "summit", "delta"];

test("machine order keeps server order without a saved order or extension default", () => {
  assert.deepEqual(orderMachines(SERVER, [], []), SERVER);
});

test("machine order applies the extension default; unlisted machines follow in server order", () => {
  assert.deepEqual(orderMachines(SERVER, [], ["summit", "cedar"]), ["summit", "cedar", "mesa", "delta"]);
});

test("a saved order wins over the extension default", () => {
  assert.deepEqual(orderMachines(SERVER, ["delta", "mesa"], ["summit", "cedar"]), ["delta", "mesa", "cedar", "summit"]);
});

test("machine order ignores names the principal cannot see and never duplicates", () => {
  assert.deepEqual(orderMachines(SERVER, ["ghost", "mesa", "mesa"], ["cedar"]), ["mesa", "cedar", "summit", "delta"]);
});

test("moving a machine stores the full visible order", () => {
  assert.deepEqual(moveMachine(SERVER, "delta", 0), ["delta", "cedar", "mesa", "summit"]);
  assert.deepEqual(moveMachine(SERVER, "cedar", 3), ["mesa", "summit", "delta", "cedar"]);
  assert.deepEqual(moveMachine(SERVER, "cedar", 99), ["mesa", "summit", "delta", "cedar"]);
  assert.deepEqual(moveMachine(SERVER, "ghost", 1), SERVER);
});

test("the saved order round-trips, drops malformed values and clears when emptied", () => {
  const storage = new MemoryStorage();
  assert.deepEqual(loadMachineOrder(storage), []);
  saveMachineOrder(["mesa", "cedar"], storage);
  assert.equal(storage.values.get(MACHINE_ORDER_STORAGE_KEY), JSON.stringify(["mesa", "cedar"]));
  assert.deepEqual(loadMachineOrder(storage), ["mesa", "cedar"]);
  storage.setItem(MACHINE_ORDER_STORAGE_KEY, JSON.stringify(["mesa", 7, "mesa", "", "cedar"]));
  assert.deepEqual(loadMachineOrder(storage), ["mesa", "cedar"]);
  storage.setItem(MACHINE_ORDER_STORAGE_KEY, "{not json");
  assert.deepEqual(loadMachineOrder(storage), []);
  storage.setItem(MACHINE_ORDER_STORAGE_KEY, JSON.stringify({ mesa: 1 }));
  assert.deepEqual(loadMachineOrder(storage), []);
  saveMachineOrder([], storage);
  assert.equal(storage.values.has(MACHINE_ORDER_STORAGE_KEY), false);
});
