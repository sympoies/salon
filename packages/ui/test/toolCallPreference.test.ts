import { strict as assert } from "node:assert";
import { test } from "node:test";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { saveShowToolCalls, useShowToolCalls } from "../src/toolCallPreference.ts";
import { setPrincipalStorageNamespace, type StorageLike } from "../src/storage.ts";

function Probe() {
  return createElement("output", null, useShowToolCalls() ? "on" : "off");
}

async function withSubscribers(namespace: string, storage: StorageLike | undefined, run: (state: {
  read(): string | null;
  remount(): Promise<void>;
}) => Promise<void>) {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window, document: globalThis.document,
    Event: globalThis.Event, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.assign(globalThis, { window, document: window.document, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: undefined });
  setPrincipalStorageNamespace(namespace);
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let generation = 0;
  const remount = async () => {
    await act(async () => root.render(createElement(Fragment, { key: ++generation }, createElement(Probe), createElement(Probe))));
  };
  try {
    await remount();
    await run({ read: () => container.textContent, remount });
  } finally {
    await act(async () => root.unmount());
    setPrincipalStorageNamespace(null);
    Object.assign(globalThis, previous);
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    await window.happyDOM.close();
  }
}

for (const mode of ["unavailable", "write-denied"] as const) {
  test(`tool visibility updates every subscriber immediately with ${mode} storage`, async () => {
    const storage = mode === "unavailable" ? undefined : {
      getItem: () => null,
      setItem: () => { throw new Error("Storage write denied"); },
    };
    await withSubscribers(`fixture-${mode}`, storage, async ({ read, remount }) => {
      assert.equal(read(), "onon", "default on for both settings and conversation subscribers");
      await act(async () => saveShowToolCalls(false));
      assert.equal(read(), "offoff", "failed persistence must not prevent immediate hiding");
      await remount();
      assert.equal(read(), "offoff", "the current client retains its choice across view changes");
      await act(async () => saveShowToolCalls(true));
      assert.equal(read(), "onon", "restoring visibility also works without persistence");
    });
  });
}

test("unsaved tool visibility stays within its principal and later successful writes persist", async () => {
  const values = new Map<string, string>();
  let denied = true;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (denied) throw new Error("Storage write denied");
      values.set(key, value);
    },
  };
  await withSubscribers("fixture-scope-a", storage, async ({ read, remount }) => {
    await act(async () => saveShowToolCalls(false));
    assert.equal(read(), "offoff");
    setPrincipalStorageNamespace("fixture-scope-b");
    await remount();
    assert.equal(read(), "onon", "another principal does not inherit an unsaved preference");
    denied = false;
    await act(async () => saveShowToolCalls(false));
    assert.equal(read(), "offoff");
    assert.equal(values.get("agent-console.principal.fixture-scope-b.ac.showToolCalls"), "0");
    setPrincipalStorageNamespace("fixture-scope-a");
    await remount();
    assert.equal(read(), "offoff", "the original principal retains its in-memory preference");
    await act(async () => saveShowToolCalls(true));
    assert.equal(read(), "onon");
    assert.equal(values.get("agent-console.principal.fixture-scope-a.ac.showToolCalls"), "1");
    assert.equal(values.get("agent-console.principal.fixture-scope-b.ac.showToolCalls"), "0");
  });
});
