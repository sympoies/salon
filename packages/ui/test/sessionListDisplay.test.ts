import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadSessionListDisplay, saveSessionListDisplay } from "../src/sessionListDisplay.ts";
import { setPrincipalStorageNamespace } from "../src/storage.ts";

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("session list display defaults and unknown stored values fall back to Terminal", () => {
  const store = storage();
  assert.equal(loadSessionListDisplay(store), "terminal");
  for (const value of ["invalid", "Conversation", "", "terminal"]) {
    store.values.set("ac.sessionListDisplay", value);
    assert.equal(loadSessionListDisplay(store), "terminal");
  }
});

test("session list display persists and reloads the client choice", () => {
  const store = storage();
  assert.equal(saveSessionListDisplay("conversation", store), true);
  assert.equal(loadSessionListDisplay(store), "conversation");
  assert.equal(saveSessionListDisplay("terminal", store), true);
  assert.equal(loadSessionListDisplay(store), "terminal");
});

test("session list display stays isolated in each principal namespace", () => {
  const store = storage();
  try {
    setPrincipalStorageNamespace("viewer-one");
    saveSessionListDisplay("conversation", store);
    setPrincipalStorageNamespace("viewer-two");
    assert.equal(loadSessionListDisplay(store), "terminal");
    saveSessionListDisplay("terminal", store);
    setPrincipalStorageNamespace("viewer-one");
    assert.equal(loadSessionListDisplay(store), "conversation");
  } finally { setPrincipalStorageNamespace(null); }
});

test("unavailable client storage retains the Terminal fallback and reports failed save", () => {
  const store = { getItem() { throw new Error("unavailable"); }, setItem() { throw new Error("unavailable"); } };
  assert.equal(loadSessionListDisplay(store), "terminal");
  assert.equal(saveSessionListDisplay("conversation", store), false);
});
