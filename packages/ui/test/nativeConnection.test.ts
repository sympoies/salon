import assert from "node:assert/strict";
import test from "node:test";
import { nativeConnection } from "@agent-console/ui/native-connection";
import { saveServerUrl, saveToken } from "../src/runtime.ts";

test("native connection snapshots require both saved values and leave storage untouched", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: t.mock.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: t.mock.fn((key: string) => { values.delete(key); }),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  const unavailable = { unavailable: true };
  assert.deepEqual(nativeConnection(), unavailable);
  saveServerUrl("https://console.example.test/settings");
  assert.deepEqual(nativeConnection(), unavailable);

  saveToken(" fixture-credential ");
  assert.deepEqual(nativeConnection(), {
    serverUrl: "https://console.example.test",
    token: "fixture-credential",
  });

  saveServerUrl("");
  assert.deepEqual(nativeConnection(), unavailable);
  assert.equal(storage.setItem.mock.callCount(), 3);
  assert.equal(storage.removeItem.mock.callCount(), 0);
});
