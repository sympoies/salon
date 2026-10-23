import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Plugin } from "vite";
import type { SlotKey } from "../src/layout.ts";
import type { UseLayoutSyncResult } from "../src/useLayoutSync.ts";
import { makeSession } from "./support/fixtures.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const cleanupStack: Array<() => Promise<void>> = [];

declare global {
  // eslint-disable-next-line no-var
  var __agentConsoleLayoutResourceCallbacks: { change(): void; health(healthy: boolean): void } | undefined;
  var __agentConsoleLayoutSyncPut: ((order: readonly string[]) => Promise<{
    readonly reachable: boolean;
    readonly order: readonly string[];
    readonly revision: number;
  }>) | undefined;
  // eslint-disable-next-line no-var
  var __agentConsoleLayoutSyncFetch: (() => Promise<{
    readonly reachable: boolean;
    readonly conflict: boolean;
    readonly order: readonly string[];
    readonly revision: number;
  }>) | undefined;
}

afterEach(async () => {
  delete globalThis.__agentConsoleLayoutResourceCallbacks;
  delete globalThis.__agentConsoleLayoutSyncPut;
  delete globalThis.__agentConsoleLayoutSyncFetch;
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function layoutApiMockPlugin(): Plugin {
  const mockId = "\0use-layout-sync-api-mock";
  return {
    name: "use-layout-sync-api-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.endsWith("resourceEvents.ts")) return "\0layout-resource-mock";
      if (source.endsWith("api.ts") && importer?.includes("/src/useLayoutSync.ts")) {
        return mockId;
      }
      return null;
    },
    load(id) {
      if (id === "\0layout-resource-mock") return `
        export const RESOURCE_RECONCILE_MS = 30000;
        export const resourceEvents = { subscribe(_subscription, change, health) {
          globalThis.__agentConsoleLayoutResourceCallbacks = { change, health }; health(false);
          return () => {};
        }};
      `;
      if (id !== mockId) return null;
      return `
        export const fetchLayoutOrder = async () => globalThis.__agentConsoleLayoutSyncFetch?.() ?? ({
          reachable: true,
          conflict: false,
          order: ["summit/a", "summit/b", "summit/c", "summit/d"],
          revision: 1,
        });
        export const putLayoutOrder = (order) => globalThis.__agentConsoleLayoutSyncPut(order);
      `;
    },
  };
}

function installDom(): {
  readonly window: Window;
  readonly root: Root;
  cleanup(): Promise<void>;
} {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  return {
    window,
    root,
    async cleanup() {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous);
      await window.happyDOM.close();
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("a confirmed persisted snapshot immediately invalidates the derived complete order", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [
    makeSession({ id: "a" }),
    makeSession({ id: "b" }),
    makeSession({ id: "c" }),
    makeSession({ id: "d" }),
  ];
  let latest: UseLayoutSyncResult | null = null;
  globalThis.__agentConsoleLayoutSyncPut = async (order) => ({
    reachable: true,
    conflict: false,
    order: [...order.slice(0, 2), "summit/d", "summit/c"],
    revision: 2,
  });
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>(
    "/src/useLayoutSync.ts",
  );

  function Probe() {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latest = useLayoutSync({
      sessions,
      visible: sessions,
      slotCount: 2,
      reachableMachineNames: new Set(["summit"]),
      getKnownMachineNames: () => new Set(["summit"]),
      setSlots,
    });
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  assert.deepEqual(
    latest?.orderedSessionKeys,
    ["summit/a", "summit/b", "summit/c", "summit/d"],
  );

  await act(async () => {
    await latest?.persistLayoutLocalOrder(
      ["summit/b", "summit/a"],
      new Set(["summit/a", "summit/b", "summit/c", "summit/d"]),
      new Set(["summit"]),
      "test",
      { urgent: true, localOrderPlacement: true },
    );
    await flushPromises();
  });

  // The confirmed snapshot is the ranking, verbatim: the two-pane grid this
  // device happens to hold does not get to re-impose a/b over it.
  assert.deepEqual(
    latest?.orderedSessionKeys,
    ["summit/b", "summit/a", "summit/d", "summit/c"],
  );
});

test("a visible mounted client polls for newer remote revisions", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let poll: (() => void) | undefined;
  let pollingInterval = 0;
  Reflect.set(mounted.window, "setTimeout", (handler: () => void, interval?: number) => {
    if (interval === 5000) { poll = handler; pollingInterval = interval; }
    return 1;
  });
  Reflect.set(mounted.window, "clearTimeout", () => undefined);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
  let latest: UseLayoutSyncResult | null = null;
  let remote = {
    reachable: true,
    conflict: false,
    order: ["summit/a", "summit/b"],
    revision: 1,
  };
  globalThis.__agentConsoleLayoutSyncFetch = async () => remote;
  globalThis.__agentConsoleLayoutSyncPut = async (order) => ({
    reachable: true,
    order: [...order],
    revision: remote.revision + 1,
  });
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>(
    "/src/useLayoutSync.ts",
  );

  function Probe() {
    const [, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latest = useLayoutSync({
      sessions,
      visible: sessions,
      slotCount: 2,
      reachableMachineNames: new Set(["summit"]),
      getKnownMachineNames: () => new Set(["summit"]),
      setSlots,
    });
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  assert.equal(pollingInterval, 5_000);

  remote = {
    reachable: true,
    conflict: false,
    order: ["summit/b", "summit/a"],
    revision: 2,
  };
  await act(async () => {
    poll?.();
    await flushPromises();
  });

  assert.deepEqual(latest?.orderedSessionKeys, ["summit/b", "summit/a"]);
});

test("a brief omission from a reachable session list does not rewrite the shared order", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
  cleanupStack.push(ssr.close);
  const all = [
    makeSession({ machine: "summit", id: "a" }),
    makeSession({ machine: "summit", id: "b" }),
    makeSession({ machine: "cedar", id: "x" }),
    makeSession({ machine: "cedar", id: "y" }),
  ];
  const remote = ["summit/a", "summit/b", "cedar/x", "cedar/y"];
  const writes: string[][] = [];
  globalThis.__agentConsoleLayoutSyncFetch = async () => ({
    reachable: true, conflict: false, order: remote, revision: 1,
  });
  globalThis.__agentConsoleLayoutSyncPut = async (order) => {
    writes.push([...order]);
    return { reachable: true, order: [...order], revision: 2 };
  };
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>(
    "/src/useLayoutSync.ts",
  );

  function Probe({ sessions }: { readonly sessions: typeof all }) {
    const [, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    useLayoutSync({
      sessions,
      visible: sessions,
      slotCount: 2,
      reachableMachineNames: new Set(["summit", "cedar"]),
      getKnownMachineNames: () => new Set(["summit", "cedar"]),
      setSlots,
    });
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe, { sessions: all }));
    await flushPromises();
  });
  await act(async () => {
    mounted.root.render(createElement(Probe, { sessions: all.filter((s) => s.id !== "b") }));
    await flushPromises();
  });
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.deepEqual(writes, []);
});

test("two mounted clients converge after either client explicitly reorders", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [
    makeSession({ id: "a" }),
    makeSession({ id: "b" }),
    makeSession({ id: "c" }),
  ];
  let first: UseLayoutSyncResult | null = null;
  let second: UseLayoutSyncResult | null = null;
  let remote = {
    reachable: true,
    conflict: false,
    order: ["summit/a", "summit/b", "summit/c"],
    revision: 1,
  };
  globalThis.__agentConsoleLayoutSyncFetch = async () => remote;
  globalThis.__agentConsoleLayoutSyncPut = async (order) => {
    remote = {
      reachable: true,
      conflict: false,
      order: [...order],
      revision: remote.revision + 1,
    };
    return remote;
  };
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>(
    "/src/useLayoutSync.ts",
  );

  function Client({ capture }: { readonly capture: (value: UseLayoutSyncResult) => void }) {
    const [, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b", "summit/c"]);
    const value = useLayoutSync({
      sessions,
      visible: sessions,
      slotCount: 3,
      reachableMachineNames: new Set(["summit"]),
      getKnownMachineNames: () => new Set(["summit"]),
      setSlots,
    });
    capture(value);
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement("div", null,
      createElement(Client, { capture: (value) => { first = value; } }),
      createElement(Client, { capture: (value) => { second = value; } }),
    ));
    await flushPromises();
  });

  await act(async () => {
    await first?.applyLayoutLocalOrder(
      ["summit/c", "summit/a", "summit/b"],
      "overview-reorder",
    );
    await flushPromises();
  });
  assert.deepEqual(first?.orderedSessionKeys, ["summit/c", "summit/a", "summit/b"]);
  assert.deepEqual(second?.orderedSessionKeys, ["summit/a", "summit/b", "summit/c"]);

  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.Event("focus"));
    await flushPromises();
  });

  assert.deepEqual(second?.orderedSessionKeys, ["summit/c", "summit/a", "summit/b"]);
});

test("an overview reorder is optimistic and preserves sessions outside the visible slots", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [
    makeSession({ id: "a" }),
    makeSession({ id: "b" }),
    makeSession({ id: "c" }),
    makeSession({ id: "d" }),
  ];
  let latest: UseLayoutSyncResult | null = null;
  let latestSlots: readonly SlotKey[] = [];
  let resolvePut:
    | ((snapshot: {
      readonly reachable: boolean;
      readonly order: readonly string[];
      readonly revision: number;
    }) => void)
    | undefined;
  globalThis.__agentConsoleLayoutSyncPut = (order) => new Promise((resolve) => {
    assert.deepEqual(order, ["summit/a", "summit/d", "summit/c", "summit/b"]);
    resolvePut = resolve;
  });
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>(
    "/src/useLayoutSync.ts",
  );

  function Probe() {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestSlots = slots;
    latest = useLayoutSync({
      sessions,
      visible: sessions,
      slotCount: 2,
      reachableMachineNames: new Set(["summit"]),
      getKnownMachineNames: () => new Set(["summit"]),
      setSlots,
    });
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });

  await act(async () => {
    void latest?.applyLayoutLocalOrder(
      ["summit/a", "summit/d", "summit/c", "summit/b"],
      "overview-reorder",
    );
    await flushPromises();
  });

  assert.deepEqual(latestSlots, ["summit/a", "summit/d"]);
  assert.deepEqual(
    latest?.orderedSessionKeys,
    ["summit/a", "summit/d", "summit/c", "summit/b"],
  );

  await act(async () => {
    resolvePut?.({
      reachable: true,
      order: ["summit/a", "summit/d", "summit/c", "summit/b"],
      revision: 2,
    });
    await flushPromises();
  });

  assert.deepEqual(
    latest?.orderedSessionKeys,
    ["summit/a", "summit/d", "summit/c", "summit/b"],
  );
});

test("an explicit reorder retries after an in-flight write discovers the store is unreachable", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
  let latest: UseLayoutSyncResult | null = null;
  let putCount = 0;
  let remote = {
    reachable: true,
    conflict: false,
    order: ["summit/a", "summit/b"],
    revision: 1,
  };
  globalThis.__agentConsoleLayoutSyncFetch = async () => remote;
  globalThis.__agentConsoleLayoutSyncPut = async (order) => {
    putCount += 1;
    if (putCount === 1) {
      return { reachable: false, order: remote.order, revision: remote.revision };
    }
    remote = {
      reachable: true,
      conflict: false,
      order: [...order],
      revision: remote.revision + 1,
    };
    return remote;
  };
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>(
    "/src/useLayoutSync.ts",
  );

  function Probe() {
    const [, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latest = useLayoutSync({
      sessions,
      visible: sessions,
      slotCount: 2,
      reachableMachineNames: new Set(["summit"]),
      getKnownMachineNames: () => new Set(["summit"]),
      setSlots,
    });
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });

  await act(async () => {
    await latest?.applyLayoutLocalOrder(
      ["summit/b", "summit/a"],
      "overview-reorder",
    );
    await flushPromises();
  });
  assert.equal(putCount, 1);
  assert.deepEqual(latest?.orderedSessionKeys, ["summit/b", "summit/a"]);

  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.Event("focus"));
    await flushPromises();
  });

  assert.equal(putCount, 2);
  assert.deepEqual(remote.order, ["summit/b", "summit/a"]);
  assert.deepEqual(latest?.orderedSessionKeys, ["summit/b", "summit/a"]);
});

test("an exhausted explicit reorder waits for remote progress before automatic retry", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
  let latest: UseLayoutSyncResult | null = null;
  let putCount = 0;
  let remote = {
    reachable: true,
    conflict: false,
    order: ["summit/a", "summit/b"],
    revision: 1,
  };
  globalThis.__agentConsoleLayoutSyncFetch = async () => remote;
  globalThis.__agentConsoleLayoutSyncPut = async (order) => {
    putCount += 1;
    if (putCount <= 3) {
      remote = {
        reachable: true,
        conflict: true,
        order: ["summit/a", "summit/b"],
        revision: remote.revision + 1,
      };
      return remote;
    }
    remote = {
      reachable: true,
      conflict: false,
      order: [...order],
      revision: remote.revision + 1,
    };
    return remote;
  };
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>(
    "/src/useLayoutSync.ts",
  );

  function Probe() {
    const [, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latest = useLayoutSync({
      sessions,
      visible: sessions,
      slotCount: 2,
      reachableMachineNames: new Set(["summit"]),
      getKnownMachineNames: () => new Set(["summit"]),
      setSlots,
    });
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });

  await act(async () => {
    await latest?.applyLayoutLocalOrder(
      ["summit/b", "summit/a"],
      "overview-reorder",
    );
    await flushPromises();
  });
  assert.equal(putCount, 3);
  assert.deepEqual(latest?.orderedSessionKeys, ["summit/b", "summit/a"]);

  for (let refresh = 0; refresh < 3; refresh += 1) {
    await act(async () => {
      mounted.window.dispatchEvent(new mounted.window.Event("focus"));
      await flushPromises();
    });
  }
  assert.equal(putCount, 3, "unchanged refresh cannot restart an exhausted conflict round");
  assert.deepEqual(latest?.orderedSessionKeys, ["summit/b", "summit/a"],
    "the user's pending order remains optimistic");

  remote = { ...remote, revision: remote.revision + 1 };
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.Event("focus"));
    await flushPromises();
  });

  assert.equal(putCount, 4);
  assert.deepEqual(remote.order, ["summit/b", "summit/a"]);
  assert.deepEqual(latest?.orderedSessionKeys, ["summit/b", "summit/a"]);
});

test("an overview reorder made while the store is unreachable persists after reconnect", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [
    makeSession({ id: "a" }),
    makeSession({ id: "b" }),
    makeSession({ id: "c" }),
    makeSession({ id: "d" }),
  ];
  let latest: UseLayoutSyncResult | null = null;
  let latestSlots: readonly SlotKey[] = [];
  let fetchCount = 0;
  let remote = {
    reachable: false,
    conflict: false,
    order: [] as string[],
    revision: 0,
  };
  const persistedOrders: string[][] = [];
  globalThis.__agentConsoleLayoutSyncFetch = async () => {
    fetchCount += 1;
    return remote;
  };
  globalThis.__agentConsoleLayoutSyncPut = async (order) => {
    persistedOrders.push([...order]);
    return {
      reachable: true,
      order: [...order],
      revision: 2,
    };
  };
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>(
    "/src/useLayoutSync.ts",
  );

  function Probe() {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestSlots = slots;
    latest = useLayoutSync({
      sessions,
      visible: sessions,
      slotCount: 2,
      reachableMachineNames: new Set(["summit"]),
      getKnownMachineNames: () => new Set(["summit"]),
      setSlots,
    });
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  assert.equal(fetchCount, 1);
  await act(async () => {
    void latest?.applyLayoutLocalOrder(
      ["summit/a", "summit/d", "summit/c", "summit/b"],
      "overview-reorder",
    );
    await flushPromises();
  });

  assert.deepEqual(latestSlots, ["summit/a", "summit/d"]);
  assert.deepEqual(persistedOrders, []);

  remote = {
    reachable: true,
    conflict: false,
    order: ["summit/a", "summit/b", "summit/c", "summit/d"],
    revision: 1,
  };
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.Event("focus"));
    await flushPromises();
  });

  assert.equal(fetchCount, 2);
  assert.deepEqual(persistedOrders, [
    ["summit/a", "summit/d", "summit/c", "summit/b"],
  ]);
  assert.deepEqual(latestSlots, ["summit/a", "summit/d"]);
});

test("a mounted client adopts a newer remote revision on focus", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [
    makeSession({ id: "a" }),
    makeSession({ id: "b" }),
    makeSession({ id: "c" }),
    makeSession({ id: "d" }),
  ];
  let latest: UseLayoutSyncResult | null = null;
  let latestSlots: readonly SlotKey[] = [];
  let fetchCount = 0;
  let remote = {
    reachable: true,
    conflict: false,
    order: ["summit/a", "summit/b", "summit/c", "summit/d"],
    revision: 1,
  };
  globalThis.__agentConsoleLayoutSyncFetch = async () => {
    fetchCount += 1;
    return remote;
  };
  globalThis.__agentConsoleLayoutSyncPut = async (order) => ({
    reachable: true,
    order: [...order],
    revision: remote.revision + 1,
  });
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>(
    "/src/useLayoutSync.ts",
  );

  function Probe() {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestSlots = slots;
    latest = useLayoutSync({
      sessions,
      visible: sessions,
      slotCount: 2,
      reachableMachineNames: new Set(["summit"]),
      getKnownMachineNames: () => new Set(["summit"]),
      setSlots,
    });
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  assert.equal(fetchCount, 1);

  remote = {
    reachable: true,
    conflict: false,
    order: ["summit/b", "summit/a", "summit/d", "summit/c"],
    revision: 2,
  };
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.Event("focus"));
    await flushPromises();
  });

  assert.equal(fetchCount, 2);
  assert.deepEqual(latestSlots, ["summit/b", "summit/a"]);
  assert.deepEqual(
    latest?.orderedSessionKeys,
    ["summit/b", "summit/a", "summit/d", "summit/c"],
  );

  remote = {
    reachable: true,
    conflict: false,
    order: ["summit/d", "summit/c", "summit/b", "summit/a"],
    revision: 3,
  };
  await act(async () => {
    mounted.window.document.dispatchEvent(new mounted.window.Event("visibilitychange"));
    await flushPromises();
  });

  assert.equal(fetchCount, 3);
  assert.deepEqual(latestSlots, ["summit/d", "summit/c"]);

  remote = {
    reachable: true,
    conflict: false,
    order: ["summit/a", "summit/b", "summit/c", "summit/d"],
    revision: 2,
  };
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.Event("focus"));
    await flushPromises();
  });

  assert.equal(fetchCount, 4);
  assert.deepEqual(latestSlots, ["summit/d", "summit/c"]);
  assert.deepEqual(
    latest?.orderedSessionKeys,
    ["summit/d", "summit/c", "summit/b", "summit/a"],
  );
});

test("refresh triggers coalesce while a layout request is in flight", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let poll: (() => void) | undefined;
  Reflect.set(mounted.window, "setTimeout", (handler: () => void, delay?: number) => {
    if (delay === 5000) poll = handler;
    return 1;
  });
  Reflect.set(mounted.window, "clearTimeout", () => undefined);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
  cleanupStack.push(ssr.close);
  const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];
  let latest: UseLayoutSyncResult | null = null;
  let latestSlots: readonly SlotKey[] = [];
  const resolveFetches: Array<(snapshot: {
    readonly reachable: boolean;
    readonly conflict: boolean;
    readonly order: readonly string[];
    readonly revision: number;
  }) => void> = [];
  globalThis.__agentConsoleLayoutSyncFetch = () => new Promise((resolve) => {
    resolveFetches.push(resolve);
  });
  globalThis.__agentConsoleLayoutSyncPut = async (order) => ({
    reachable: true,
    order: [...order],
    revision: 3,
  });
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>(
    "/src/useLayoutSync.ts",
  );

  function Probe() {
    const [slots, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latestSlots = slots;
    latest = useLayoutSync({
      sessions,
      visible: sessions,
      slotCount: 2,
      reachableMachineNames: new Set(["summit"]),
      getKnownMachineNames: () => new Set(["summit"]),
      setSlots,
    });
    return createElement("div");
  }

  await act(async () => {
    mounted.root.render(createElement(Probe));
    await flushPromises();
  });
  assert.equal(resolveFetches.length, 1);

  await act(async () => {
    poll?.();
    mounted.window.dispatchEvent(new mounted.window.Event("focus"));
    mounted.window.document.dispatchEvent(new mounted.window.Event("visibilitychange"));
    await flushPromises();
  });
  assert.equal(resolveFetches.length, 1);

  await act(async () => {
    resolveFetches[0]?.({
      reachable: true,
      conflict: false,
      order: ["summit/a", "summit/b"],
      revision: 1,
    });
    await flushPromises();
  });
  assert.equal(resolveFetches.length, 2);

  await act(async () => {
    resolveFetches[1]?.({
      reachable: true,
      conflict: false,
      order: ["summit/b", "summit/a"],
      revision: 2,
    });
    await flushPromises();
  });
  assert.equal(resolveFetches.length, 2);
  assert.deepEqual(latestSlots, ["summit/b", "summit/a"]);
  assert.deepEqual(latest?.orderedSessionKeys, ["summit/b", "summit/a"]);
});


test("layout notifications trigger reads and healthy reconciliation restores fallback after disconnect", async () => {
  const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  let tick: (() => void) | undefined; let delay = 0;
  Reflect.set(mounted.window, "setTimeout", (callback: () => void, ms: number) => { tick = callback; delay = ms; return 1; });
  Reflect.set(mounted.window, "clearTimeout", () => undefined);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]); cleanupStack.push(ssr.close);
  let reads = 0; let revision = 1;
  globalThis.__agentConsoleLayoutSyncFetch = async () => { reads += 1; return { reachable: true, conflict: false, order: ["summit/a"], revision }; };
  const { useLayoutSync } = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>("/src/useLayoutSync.ts");
  const sessions = [makeSession({ id: "a" })];
  function Probe() {
    const [, setSlots] = useState<SlotKey[]>(["summit/a"]);
    useLayoutSync({ sessions, visible: sessions, slotCount: 1, reachableMachineNames: new Set(["summit"]), getKnownMachineNames: () => new Set(["summit"]), setSlots });
    return createElement("div");
  }
  await act(async () => { mounted.root.render(createElement(Probe)); await flushPromises(); });
  assert.equal(delay, 5000);
  await act(async () => { globalThis.__agentConsoleLayoutResourceCallbacks!.health(true); tick?.(); await flushPromises(); });
  assert.equal(delay, 30000);
  const before = reads; revision += 1;
  await act(async () => { globalThis.__agentConsoleLayoutResourceCallbacks!.change(); await flushPromises(); });
  assert.equal(reads, before + 1);
  await act(async () => { globalThis.__agentConsoleLayoutResourceCallbacks!.health(false); await flushPromises(); });
  assert.equal(delay, 5000);
});


for (const update of ["unchanged", "same-key parent refresh", "store recovery", "parent refresh while write is in flight", "registry change while write is in flight"]) {
  test(update === "registry change while write is in flight"
    ? "a passive conflict permits reconciliation after a registry change while write is in flight"
    : `an identical passive conflict snapshot does not rearm the layout debounce: ${update}`, async () => {
    const mounted = installDom();
    cleanupStack.push(mounted.cleanup);
    const timers = new Map<object, () => void>();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
      if (delay !== 800) return originalSetTimeout(callback, delay, ...args);
      const timer = {};
      timers.set(timer, callback);
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      if (!timers.delete(timer as object)) originalClearTimeout(timer as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout;
    cleanupStack.push(async () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    });
    const ssr = createUiSsrHarness([layoutApiMockPlugin()]);
    cleanupStack.push(ssr.close);
    let sessions = [makeSession({id: "a"}), makeSession({id: "b"})];
    const registryChanges = update === "registry change while write is in flight";
    let known = new Set(["summit", ...(registryChanges ? ["retired"] : [])]);
    let putCount = 0;
    let conflict = true;
    let releaseWrite: (() => void) | undefined;
    let remote = {reachable: true, conflict: false, order: registryChanges ? ["summit/a", "retired/x"] : ["summit/a"], revision: 1};
    globalThis.__agentConsoleLayoutSyncFetch = async () => remote;
    globalThis.__agentConsoleLayoutSyncPut = async (order) => {
      putCount += 1;
      if ((update === "parent refresh while write is in flight" || registryChanges) && putCount === 1) {
        await new Promise<void>(resolve => {releaseWrite = resolve;});
      }
      if (conflict) return {...remote, conflict: true};
      remote = {...remote, order: [...order], revision: remote.revision + 1};
      return remote;
    };
    const {useLayoutSync} = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>("/src/useLayoutSync.ts");
    function Probe() {
      const [, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
      useLayoutSync({sessions, visible: sessions, slotCount: 2,
        reachableMachineNames: new Set(["summit"]),
        getKnownMachineNames: () => known, setSlots});
      return createElement("div");
    }
    await act(async () => { mounted.root.render(createElement(Probe)); await flushPromises(); });
    assert.equal(timers.size, 1, "the missing session schedules one passive reconciliation");
    const [timer, run] = [...timers.entries()][0]!;
    timers.delete(timer);
    await act(async () => { run(); await flushPromises(); });
    if (update === "parent refresh while write is in flight" || registryChanges) {
      assert.equal(putCount, 1);
      if (registryChanges) known = new Set(["summit"]);
      sessions = sessions.map(session => ({...session}));
      await act(async () => { mounted.root.render(createElement(Probe)); await flushPromises(); });
      assert.equal(timers.size, 1, "parent update queued a timer before the pending write settled");
      await act(async () => {releaseWrite?.(); await flushPromises();});
    }
    assert.equal(putCount, 3, "one reconciliation preserves the existing bounded conflict attempts");
    if (update === "same-key parent refresh") {
      sessions = sessions.map(session => ({...session}));
      await act(async () => { mounted.root.render(createElement(Probe)); await flushPromises(); });
    }
    if (registryChanges) {
      assert.equal(timers.size, 1, "a changed registry permits reconciliation after the old round settles");
      conflict = false;
      const [changedTimer, reconcile] = [...timers.entries()][0]!;
      timers.delete(changedTimer);
      await act(async () => { reconcile(); await flushPromises(); });
      assert.equal(putCount, 4, "the new registry needs only one successful write");
      assert.deepEqual(remote.order, ["summit/a", "summit/b"]);
      assert.equal(timers.size, 0);
      return;
    }
    assert.equal(timers.size, 0, "the identical snapshot and session keys cannot start another passive round");
    if (update === "store recovery") {
      remote = {...remote, reachable: false};
      await act(async () => {
        mounted.window.dispatchEvent(new mounted.window.Event("focus"));
        await flushPromises();
      });
      assert.equal(timers.size, 0, "no write while the layout store is unreachable");
    }
    conflict = false;
    remote = {...remote, reachable: true,
      revision: remote.revision + (update === "store recovery" ? 0 : 1)};
    await act(async () => {
      mounted.window.dispatchEvent(new mounted.window.Event("focus"));
      await flushPromises();
    });
    assert.equal(timers.size, 1, "remote progress or genuine store recovery can reconcile again");
    const [nextTimer, retry] = [...timers.entries()][0]!;
    timers.delete(nextTimer);
    await act(async () => { retry(); await flushPromises(); });
    assert.equal(putCount, 4);
    assert.deepEqual(remote.order, ["summit/a", "summit/b"]);
    assert.equal(timers.size, 0);
  });
}

test("a fresh user reorder can retry an unchanged conflict snapshot", async () => {
  const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]); cleanupStack.push(ssr.close);
  const sessions = [makeSession({id: "a"}), makeSession({id: "b"})];
  let latest: UseLayoutSyncResult | null = null;
  let putCount = 0; let conflict = true;
  let remote = {reachable: true, conflict: false, order: ["summit/a", "summit/b"], revision: 1};
  globalThis.__agentConsoleLayoutSyncFetch = async () => remote;
  globalThis.__agentConsoleLayoutSyncPut = async order => {
    putCount += 1;
    if (conflict) return {...remote, conflict: true};
    remote = {...remote, order: [...order], revision: remote.revision + 1};
    return remote;
  };
  const {useLayoutSync} = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>("/src/useLayoutSync.ts");
  function Probe() {
    const [, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latest = useLayoutSync({sessions, visible: sessions, slotCount: 2,
      reachableMachineNames: new Set(["summit"]), getKnownMachineNames: () => new Set(["summit"]), setSlots});
    return createElement("div");
  }
  await act(async () => { mounted.root.render(createElement(Probe)); await flushPromises(); });
  await act(async () => {
    await latest?.applyLayoutLocalOrder(["summit/b", "summit/a"], "overview-reorder");
    await flushPromises();
  });
  assert.equal(putCount, 3);
  assert.deepEqual(latest?.orderedSessionKeys, ["summit/b", "summit/a"]);
  conflict = false;
  await act(async () => {
    await latest?.applyLayoutLocalOrder(["summit/b", "summit/a"], "overview-reorder");
    await flushPromises();
  });
  assert.equal(putCount, 4, "a new user action gets its own reconciliation");
  assert.deepEqual(remote.order, ["summit/b", "summit/a"]);
});


test("store progress observed during an exhausted write is not lost to its stale conflict response", async () => {
  const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]); cleanupStack.push(ssr.close);
  const sessions = [makeSession({id: "a"}), makeSession({id: "b"})];
  let latest: UseLayoutSyncResult | null = null;
  let puts = 0; let releaseConflict: (() => void) | undefined;
  let persistence: Promise<void> | undefined;
  let remote = {reachable: true, conflict: false, order: ["summit/a", "summit/b"], revision: 1};
  globalThis.__agentConsoleLayoutSyncFetch = async () => remote;
  globalThis.__agentConsoleLayoutSyncPut = async order => {
    puts += 1;
    if (puts <= 2) {
      remote = {...remote, revision: remote.revision + 1};
      return {...remote, conflict: true};
    }
    if (puts === 3) {
      const stale = {...remote, revision: 4, conflict: true};
      return await new Promise(resolve => {releaseConflict = () => resolve(stale);});
    }
    remote = {...remote, order: [...order], revision: remote.revision + 1};
    return remote;
  };
  const {useLayoutSync} = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>("/src/useLayoutSync.ts");
  function Probe() {
    const [, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latest = useLayoutSync({sessions, visible: sessions, slotCount: 2,
      reachableMachineNames: new Set(["summit"]), getKnownMachineNames: () => new Set(["summit"]), setSlots});
    return createElement("div");
  }
  await act(async () => {mounted.root.render(createElement(Probe)); await flushPromises();});
  await act(async () => {
    persistence = latest?.applyLayoutLocalOrder(["summit/b", "summit/a"], "overview-reorder");
    await flushPromises();
  });
  assert.equal(puts, 3); assert.ok(releaseConflict);
  remote = {...remote, revision: 5};
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.Event("focus")); await flushPromises();
  });
  await act(async () => {releaseConflict!(); await persistence; await flushPromises();});
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.Event("focus")); await flushPromises();
  });
  assert.equal(puts, 4, "the newer observed snapshot was not consumed by the exhausted stale round");
  assert.deepEqual(remote.order, ["summit/b", "summit/a"]);
});


test("a delayed confirmed write does not overwrite newer other-client order", async () => {
  const mounted = installDom(); cleanupStack.push(mounted.cleanup);
  const ssr = createUiSsrHarness([layoutApiMockPlugin()]); cleanupStack.push(ssr.close);
  const sessions = [makeSession({id: "a"}), makeSession({id: "b"})];
  let latest: UseLayoutSyncResult | null = null;
  let puts = 0; let releaseSuccess: (() => void) | undefined;
  let persistence: Promise<void> | undefined;
  let remote = {reachable: true, conflict: false, order: ["summit/a", "summit/b"], revision: 1};
  globalThis.__agentConsoleLayoutSyncFetch = async () => remote;
  globalThis.__agentConsoleLayoutSyncPut = async order => {
    puts += 1;
    if (puts === 1) {
      const confirmed = {...remote, order: [...order], revision: 2};
      return await new Promise(resolve => {releaseSuccess = () => resolve(confirmed);});
    }
    remote = {...remote, order: [...order], revision: remote.revision + 1};
    return remote;
  };
  const {useLayoutSync} = await ssr.loadModule<typeof import("../src/useLayoutSync.ts")>("/src/useLayoutSync.ts");
  function Probe() {
    const [, setSlots] = useState<SlotKey[]>(["summit/a", "summit/b"]);
    latest = useLayoutSync({sessions, visible: sessions, slotCount: 2,
      reachableMachineNames: new Set(["summit"]), getKnownMachineNames: () => new Set(["summit"]), setSlots});
    return createElement("div");
  }
  await act(async () => {mounted.root.render(createElement(Probe)); await flushPromises();});
  await act(async () => {
    persistence = latest?.applyLayoutLocalOrder(["summit/b", "summit/a"], "overview-reorder");
    await flushPromises();
  });
  assert.equal(puts, 1); assert.ok(releaseSuccess);
  remote = {...remote, revision: 3};
  await act(async () => {
    mounted.window.dispatchEvent(new mounted.window.Event("focus")); await flushPromises();
  });
  await act(async () => {releaseSuccess!(); await persistence; await flushPromises();});
  assert.equal(puts, 1, "a successful older operation ends its intent rather than reasserting over later writes");
  assert.deepEqual(latest?.orderedSessionKeys, remote.order, "the newer store order remains authoritative");
});
