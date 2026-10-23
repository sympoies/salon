import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_MACHINE_COLOR,
  MACHINE_COLOR_STORAGE_KEY,
  loadMachineColors,
  machineColorRgb,
  resolveMachineColor,
  resetMachineColor,
  saveMachineColors,
  setMachineColor,
} from "../src/machineColors.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function plainColors(colors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(colors));
}

// Host colour defaults come from the distribution's UI extensions (#918).
const DEFAULTS = { cedar: "#fff68f", mesa: "#ef5350" };

test("machine colors resolve extension defaults and CSS rgb values (#918)", () => {
  assert.equal(resolveMachineColor("cedar", {}, DEFAULTS), "#fff68f");
  assert.equal(resolveMachineColor("mesa", {}, DEFAULTS), "#ef5350");
  assert.equal(resolveMachineColor("unknown", {}, DEFAULTS), DEFAULT_MACHINE_COLOR);
  assert.equal(resolveMachineColor("cedar", {}), DEFAULT_MACHINE_COLOR, "core itself names no host colour");
  assert.equal(machineColorRgb("#ef5350"), "239, 83, 80");
});

test("machine color overrides keep only valid CSS hex values", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    MACHINE_COLOR_STORAGE_KEY,
    JSON.stringify({
      mesa: "#addb67",
      summit: "#ABCDEF",
      bad: "red",
      other: 7,
    }),
  );

  assert.deepEqual(plainColors(loadMachineColors(storage)), {
    mesa: "#addb67",
    summit: "#abcdef",
  });
  // A stored colour equal to a default is not an override.
  storage.setItem(MACHINE_COLOR_STORAGE_KEY, JSON.stringify({ mesa: "#ef5350", summit: "#abcdef" }));
  assert.deepEqual(plainColors(loadMachineColors(storage, DEFAULTS)), { summit: "#abcdef" });

  storage.setItem(MACHINE_COLOR_STORAGE_KEY, JSON.stringify(["not", "object"]));
  assert.deepEqual(plainColors(loadMachineColors(storage)), {});

  storage.setItem(MACHINE_COLOR_STORAGE_KEY, "{bad");
  assert.deepEqual(plainColors(loadMachineColors(storage)), {});
});

test("machine color updates persist overrides and reset back to the extension defaults (#918)", () => {
  const storage = new MemoryStorage();
  const customized = setMachineColor({}, "mesa", "#addb67", DEFAULTS);
  assert.deepEqual(plainColors(customized), { mesa: "#addb67" });

  saveMachineColors(customized, storage, DEFAULTS);
  assert.equal(storage.getItem(MACHINE_COLOR_STORAGE_KEY), JSON.stringify({ mesa: "#addb67" }));

  const defaulted = setMachineColor(customized, "mesa", "#ef5350", DEFAULTS);
  assert.deepEqual(plainColors(defaulted), {});
  saveMachineColors(defaulted, storage, DEFAULTS);
  assert.equal(storage.getItem(MACHINE_COLOR_STORAGE_KEY), null);
  // Without that default the same colour is a real override.
  assert.deepEqual(plainColors(setMachineColor({}, "mesa", "#ef5350")), { mesa: "#ef5350" });

  assert.deepEqual(plainColors(resetMachineColor({ mesa: "#addb67", summit: "#b7dbff" }, "mesa", DEFAULTS)), { summit: "#b7dbff" });
});

test("machine color maps preserve prototype-like machine names", () => {
  const storage = new MemoryStorage();
  const customized = setMachineColor({}, "__proto__", "#123456");

  assert.equal(Object.prototype.hasOwnProperty.call(customized, "__proto__"), true);
  assert.equal(resolveMachineColor("__proto__", customized), "#123456");

  saveMachineColors(customized, storage);
  assert.equal(storage.getItem(MACHINE_COLOR_STORAGE_KEY), '{"__proto__":"#123456"}');
  assert.equal(resolveMachineColor("__proto__", loadMachineColors(storage)), "#123456");

  storage.setItem(MACHINE_COLOR_STORAGE_KEY, '{"__proto__":"#654321"}');
  assert.equal(resolveMachineColor("__proto__", loadMachineColors(storage)), "#654321");
});
