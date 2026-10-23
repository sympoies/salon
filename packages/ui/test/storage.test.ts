import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  localStorageGetItem,
  localStorageSetItem,
  setPrincipalStorageNamespace,
  unscopedLocalStorageGetItem,
  unscopedLocalStorageSetItem,
  resolveLocalStorage,
  safeGetItem,
  safeRemoveItem,
  safeSetItem,
  type StorageLike,
} from "../src/storage.ts";

function memoryStorage(): StorageLike & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function withGlobalProperty<T>(name: "window" | "localStorage", descriptor: PropertyDescriptor, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { ...descriptor, configurable: true });
  try {
    return run();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, name, original);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
}

test("safe storage helpers tolerate missing and throwing storage", () => {
  const throwing = {
    getItem: () => {
      throw new Error("blocked get");
    },
    setItem: () => {
      throw new Error("blocked set");
    },
    removeItem: () => {
      throw new Error("blocked remove");
    },
  };

  assert.equal(safeGetItem(null, "k"), null);
  assert.equal(safeGetItem(throwing, "k"), null);
  assert.equal(safeSetItem(undefined, "k", "v"), false);
  assert.equal(safeSetItem(throwing, "k", "v"), false);
  assert.equal(safeRemoveItem(null, "k"), false);
  assert.equal(safeRemoveItem(throwing, "k"), false);
});

test("principal storage namespaces isolate application state but not native connection keys", () => {
  const storage = memoryStorage();
  withGlobalProperty("localStorage", { value: storage }, () => {
    setPrincipalStorageNamespace("tess");
    assert.equal(localStorageSetItem("agent-console.layout.slots", "tess-slots"), true);
    setPrincipalStorageNamespace("dana");
    assert.equal(localStorageGetItem("agent-console.layout.slots"), null);
    assert.equal(localStorageSetItem("agent-console.layout.slots", "dana-slots"), true);
    setPrincipalStorageNamespace("tess");
    assert.equal(localStorageGetItem("agent-console.layout.slots"), "tess-slots");

    unscopedLocalStorageSetItem("ac:server-url", "https://console.example");
    setPrincipalStorageNamespace("dana");
    assert.equal(unscopedLocalStorageGetItem("ac:server-url"), "https://console.example");
    setPrincipalStorageNamespace(null);
  });
});

test("safe storage helpers report successful set and real remove operations", () => {
  const storage = memoryStorage();

  assert.equal(safeSetItem(storage, "k", "v"), true);
  assert.equal(safeGetItem(storage, "k"), "v");
  assert.equal(safeRemoveItem(storage, "k"), true);
  assert.equal(safeGetItem(storage, "k"), null);
});

test("safeRemoveItem returns false when real removal is unavailable", () => {
  const writes: string[] = [];
  const storage = {
    getItem: () => "v",
    setItem: (_key: string, value: string) => {
      writes.push(value);
    },
  };

  assert.equal(safeRemoveItem(storage, "k"), false);
  assert.deepEqual(writes, []);
});

test("resolveLocalStorage prefers explicit storage and falls back to global storage", () => {
  const explicit = memoryStorage();
  assert.equal(resolveLocalStorage(explicit), explicit);

  const fallback = memoryStorage();
  withGlobalProperty("localStorage", { value: fallback }, () => {
    assert.equal(resolveLocalStorage(), fallback);
    assert.equal(localStorageSetItem("k", "v"), true);
    assert.equal(localStorageGetItem("k"), "v");
  });
});

test("resolveLocalStorage tolerates blocked window storage before global fallback", () => {
  const fallback = memoryStorage();
  withGlobalProperty("localStorage", { value: fallback }, () => {
    withGlobalProperty("window", {
      value: {
        get localStorage() {
          throw new Error("blocked window storage");
        },
      },
    }, () => {
      assert.equal(resolveLocalStorage(), fallback);
    });
  });
});
