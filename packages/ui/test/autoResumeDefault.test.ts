import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_AUTO_RESUME_STORAGE_KEY,
  loadDefaultAutoResume,
  saveDefaultAutoResume,
} from "../src/autoResumeDefault.ts";
import type { StorageLike } from "../src/storage.ts";

function memoryStorage(): StorageLike & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("default auto-resume is off until the device preference is enabled", () => {
  const storage = memoryStorage();

  assert.equal(loadDefaultAutoResume(storage), false);
  assert.equal(saveDefaultAutoResume(true, storage), true);
  assert.equal(storage.values.get(DEFAULT_AUTO_RESUME_STORAGE_KEY), "1");
  assert.equal(loadDefaultAutoResume(storage), true);
  assert.equal(saveDefaultAutoResume(false, storage), true);
  assert.equal(storage.values.get(DEFAULT_AUTO_RESUME_STORAGE_KEY), "0");
  assert.equal(loadDefaultAutoResume(storage), false);
});

test("default auto-resume fails closed for unknown stored values", () => {
  const storage = memoryStorage();
  storage.values.set(DEFAULT_AUTO_RESUME_STORAGE_KEY, "yes");
  assert.equal(loadDefaultAutoResume(storage), false);
});

test("default auto-resume reports blocked preference writes", () => {
  const storage: StorageLike = {
    getItem: () => null,
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(saveDefaultAutoResume(true, storage), false);
  assert.equal(loadDefaultAutoResume(storage), false);
});
