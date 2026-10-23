import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createLayoutPersistQueue,
  persistLayoutIntent,
  type LayoutOrderWriter,
  type LayoutStoreSnapshot,
} from "../src/layoutPersistence.ts";

function live(...keys: string[]): Set<string> {
  return new Set(keys);
}

test("passive polling cannot erase a ranked session missing from one successful list", async () => {
  const writes: string[][] = [];
  const result = await persistLayoutIntent({
    previous: { order: ["summit/a", "summit/b", "cedar/x", "cedar/y"], revision: 7 },
    intent: {
      localOrder: ["summit/a", "cedar/x", "cedar/y", "cedar/z"],
      liveKeys: live("summit/a", "cedar/x", "cedar/y", "cedar/z"),
      reachableMachines: live("summit", "cedar"),
      reason: "reorder",
    },
    knownMachines: live("summit", "cedar"),
    putLayoutOrder: async (order) => {
      writes.push([...order]);
      return { reachable: true, order: [...order], revision: 8 };
    },
  });
  assert.deepEqual(writes, [["summit/a", "summit/b", "cedar/x", "cedar/y", "cedar/z"]]);
  assert.deepEqual(result.snapshot?.order, writes[0]);
});

test("closing a session removes exactly its key even when another is temporarily missing", async () => {
  const writes: string[][] = [];
  await persistLayoutIntent({
    previous: { order: ["summit/a", "summit/b", "cedar/x"], revision: 7 },
    intent: {
      localOrder: ["cedar/x"],
      liveKeys: live("cedar/x"),
      reachableMachines: live("summit", "cedar"),
      removedKeys: live("summit/a"),
      reason: "close",
    },
    knownMachines: live("summit", "cedar"),
    putLayoutOrder: async (order) => {
      writes.push([...order]);
      return { reachable: true, order: [...order], revision: 8 };
    },
  });
  assert.deepEqual(writes, [["summit/b", "cedar/x"]]);
});

test("a user reorder keeps an absent ranked session anchored", async () => {
  const writes: string[][] = [];
  await persistLayoutIntent({
    previous: { order: ["summit/a", "summit/b", "cedar/x", "cedar/y"], revision: 7 },
    intent: {
      localOrder: ["cedar/x", "summit/a", "cedar/y"],
      liveKeys: live("summit/a", "cedar/x", "cedar/y"),
      reachableMachines: live("summit", "cedar"),
      reason: "overview-reorder",
      localOrderPlacement: true,
    },
    knownMachines: live("summit", "cedar"),
    putLayoutOrder: async (order) => {
      writes.push([...order]);
      return { reachable: true, order: [...order], revision: 8 };
    },
  });
  assert.deepEqual(writes, [["cedar/x", "summit/b", "summit/a", "cedar/y"]]);
});

test("placing a newly created session keeps an absent ranked session anchored", async () => {
  const writes: string[][] = [];
  await persistLayoutIntent({
    previous: { order: ["summit/a", "summit/b", "cedar/x"], revision: 7 },
    intent: {
      // Replacing slot 0 removes its old occupant from the local slot order.
      localOrder: ["summit/new", "cedar/x"],
      liveKeys: live("summit/new", "summit/a", "cedar/x"),
      reachableMachines: live("summit", "cedar"),
      reason: "create",
      localOrderPlacement: true,
    },
    knownMachines: live("summit", "cedar"),
    putLayoutOrder: async (order) => {
      writes.push([...order]);
      return { reachable: true, order: [...order], revision: 8 };
    },
  });
  assert.deepEqual(writes, [["summit/new", "summit/b", "cedar/x", "summit/a"]]);
});

test("persistLayoutIntent preserves remote order when passive reconciliation conflicts", async () => {
  const calls: Array<{ order: readonly string[]; baseRevision?: number | null; reason?: string }> = [];
  const putLayoutOrder: LayoutOrderWriter = async (order, options) => {
    calls.push({ order: [...order], baseRevision: options?.baseRevision, reason: options?.reason });
    if (calls.length === 1) {
      return { reachable: true, conflict: true, order: ["m/a", "m/c"], revision: 8 };
    }
    return { reachable: true, order: [...order], revision: 9 };
  };

  const result = await persistLayoutIntent({
    previous: { order: ["m/a", "m/b"], revision: 7 },
    intent: {
      localOrder: ["m/b", "m/a", "m/d"],
      liveKeys: live("m/a", "m/b", "m/c", "m/d"),
      reachableMachines: live("m"),
      reason: "reorder",
    },
    knownMachines: live("m"),
    putLayoutOrder,
  });

  assert.deepEqual(calls, [
    { order: ["m/a", "m/b", "m/d"], baseRevision: 7, reason: "reorder" },
    { order: ["m/a", "m/c", "m/b", "m/d"], baseRevision: 8, reason: "reorder:retry" },
  ]);
  assert.deepEqual(result, { reachable: true, snapshot: { order: ["m/a", "m/c", "m/b", "m/d"], revision: 9 } });
});

test("persistLayoutIntent rebases an explicit reorder over the latest remote revision", async () => {
  const calls: Array<{ order: readonly string[]; baseRevision?: number | null; reason?: string }> = [];
  const putLayoutOrder: LayoutOrderWriter = async (order, options) => {
    calls.push({ order: [...order], baseRevision: options?.baseRevision, reason: options?.reason });
    if (calls.length === 1) {
      return { reachable: true, conflict: true, order: ["m/a", "m/c"], revision: 8 };
    }
    return { reachable: true, order: [...order], revision: 9 };
  };

  const result = await persistLayoutIntent({
    previous: { order: ["m/a", "m/b"], revision: 7 },
    intent: {
      localOrder: ["m/b", "m/a"],
      liveKeys: live("m/a", "m/b", "m/c"),
      reachableMachines: live("m"),
      reason: "reorder",
      localOrderPlacement: true,
    },
    knownMachines: live("m"),
    putLayoutOrder,
  });

  assert.deepEqual(calls, [
    { order: ["m/b", "m/a"], baseRevision: 7, reason: "reorder" },
    { order: ["m/b", "m/a", "m/c"], baseRevision: 8, reason: "reorder:retry" },
  ]);
  assert.deepEqual(result, { reachable: true, snapshot: { order: ["m/b", "m/a", "m/c"], revision: 9 } });
});

test("persistLayoutIntent keeps an explicit slot-created session at the selected rank", async () => {
  const calls: Array<{ order: readonly string[]; baseRevision?: number | null; reason?: string }> = [];
  const putLayoutOrder: LayoutOrderWriter = async (order, options) => {
    calls.push({ order: [...order], baseRevision: options?.baseRevision, reason: options?.reason });
    return { reachable: true, order: [...order], revision: 8 };
  };

  const result = await persistLayoutIntent({
    previous: { order: ["m/a", "m/b"], revision: 7 },
    intent: {
      localOrder: ["m/new", "m/b"],
      liveKeys: live("m/a", "m/b", "m/new"),
      reachableMachines: live("m"),
      reason: "create",
      localOrderPlacement: true,
    },
    knownMachines: live("m"),
    putLayoutOrder,
  });

  assert.deepEqual(calls, [{ order: ["m/new", "m/b", "m/a"], baseRevision: 7, reason: "create" }]);
  assert.deepEqual(result, { reachable: true, snapshot: { order: ["m/new", "m/b", "m/a"], revision: 8 } });
});

test("persistLayoutIntent reports a bounded conflict when every retry conflicts", async () => {
  const calls: Array<{ order: readonly string[]; baseRevision?: number | null; reason?: string }> = [];
  const putLayoutOrder: LayoutOrderWriter = async (order, options) => {
    calls.push({ order: [...order], baseRevision: options?.baseRevision, reason: options?.reason });
    return { reachable: true, conflict: true, order: [`remote/${calls.length}`], revision: 10 + calls.length };
  };

  const result = await persistLayoutIntent({
    previous: { order: ["m/a"], revision: 7 },
    intent: {
      localOrder: ["m/b"],
      liveKeys: live("m/a", "m/b", "remote/1", "remote/2", "remote/3"),
      reachableMachines: live("m", "remote"),
      reason: "reorder",
    },
    knownMachines: live("m", "remote"),
    putLayoutOrder,
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(result, { reachable: true, conflict: true, snapshot: { order: ["remote/3"], revision: 13 } });
});

test("createLayoutPersistQueue collapses obsolete queued work so the newest intent wins", async () => {
  const calls: Array<{ order: readonly string[]; baseRevision?: number | null; reason?: string }> = [];
  let snapshot: LayoutStoreSnapshot | null = { order: ["m/a"], revision: 1 };
  const putLayoutOrder: LayoutOrderWriter = async (order, options) => {
    calls.push({ order: [...order], baseRevision: options?.baseRevision, reason: options?.reason });
    if (calls.length === 1) {
      return { reachable: true, conflict: true, order: ["m/a", "m/remote"], revision: 2 };
    }
    return { reachable: true, order: [...order], revision: 3 };
  };
  const queue = createLayoutPersistQueue({
    isReachable: () => true,
    setUnreachable: () => {
      throw new Error("unexpected unreachable");
    },
    getSnapshot: () => snapshot,
    setSnapshot: (next) => {
      snapshot = next;
    },
    getKnownMachines: () => live("m"),
    putLayoutOrder,
  });

  const first = queue.persist({
    localOrder: ["m/old"],
    liveKeys: live("m/a", "m/old", "m/new", "m/remote"),
    reachableMachines: live("m"),
    reason: "reorder",
  });
  const second = queue.persist({
    localOrder: ["m/new", "m/a"],
    liveKeys: live("m/a", "m/new", "m/remote"),
    reachableMachines: live("m"),
    reason: "close",
  });
  await Promise.all([first, second]);

  assert.deepEqual(calls, [
    { order: ["m/a", "m/new"], baseRevision: 1, reason: "close" },
    { order: ["m/a", "m/remote", "m/new"], baseRevision: 2, reason: "close:retry" },
  ]);
  assert.deepEqual(snapshot, { order: ["m/a", "m/remote", "m/new"], revision: 3 });
});

test("createLayoutPersistQueue runs urgent keepalive intents without waiting for queued work", async () => {
  const calls: Array<{ order: readonly string[]; keepalive?: boolean; reason?: string }> = [];
  let snapshot: LayoutStoreSnapshot = { order: [], revision: 0 };
  let releaseFirst: (() => void) | undefined;
  let startedFirst: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    startedFirst = resolve;
  });
  const putLayoutOrder: LayoutOrderWriter = async (order, options) => {
    calls.push({ order: [...order], keepalive: options?.keepalive, reason: options?.reason });
    if (calls.length === 1) {
      startedFirst();
      await new Promise<void>((release) => {
        releaseFirst = release;
      });
    }
    return { reachable: true, order: [...order], revision: calls.length };
  };
  const queue = createLayoutPersistQueue({
    isReachable: () => true,
    setUnreachable: () => {
      throw new Error("unexpected unreachable");
    },
    getSnapshot: () => snapshot,
    setSnapshot: (next) => {
      snapshot = next;
    },
    getKnownMachines: () => live("m"),
    putLayoutOrder,
  });
  const first = queue.persist({
    localOrder: ["m/slow"],
    liveKeys: live("m/slow", "m/final"),
    reachableMachines: live("m"),
    reason: "reorder",
  });
  await firstStarted;
  const urgent = queue.persist({
    localOrder: ["m/final"],
    liveKeys: live("m/slow", "m/final"),
    reachableMachines: live("m"),
    reason: "flush",
    keepalive: true,
    urgent: true,
  });
  await urgent;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { order: ["m/final"], keepalive: true, reason: "flush" });
  releaseFirst?.();
  await first;
  assert.deepEqual(snapshot, { order: ["m/final"], revision: 2 });
});

test("createLayoutPersistQueue serializes urgent intents for no-revision stores", async () => {
  const calls: Array<{ order: readonly string[]; keepalive?: boolean; reason?: string }> = [];
  let snapshot: LayoutStoreSnapshot = { order: [], revision: null };
  let releaseFirst: (() => void) | undefined;
  let startedFirst: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    startedFirst = resolve;
  });
  const putLayoutOrder: LayoutOrderWriter = async (order, options) => {
    calls.push({ order: [...order], keepalive: options?.keepalive, reason: options?.reason });
    if (calls.length === 1) {
      startedFirst();
      await new Promise<void>((release) => {
        releaseFirst = release;
      });
    }
    return { reachable: true, order: [...order], revision: null };
  };
  const queue = createLayoutPersistQueue({
    isReachable: () => true,
    setUnreachable: () => {
      throw new Error("unexpected unreachable");
    },
    getSnapshot: () => snapshot,
    setSnapshot: (next) => {
      snapshot = next;
    },
    getKnownMachines: () => live("m"),
    putLayoutOrder,
  });
  const first = queue.persist({
    localOrder: ["m/slow"],
    liveKeys: live("m/slow", "m/final"),
    reachableMachines: live("m"),
    reason: "reorder",
  });
  await firstStarted;
  const urgent = queue.persist({
    localOrder: ["m/final"],
    liveKeys: live("m/slow", "m/final"),
    reachableMachines: live("m"),
    reason: "flush",
    keepalive: true,
    urgent: true,
  });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  releaseFirst?.();
  await Promise.all([first, urgent]);
  assert.deepEqual(calls, [
    { order: ["m/slow"], keepalive: undefined, reason: "reorder" },
    { order: ["m/final"], keepalive: true, reason: "flush" },
  ]);
  assert.deepEqual(snapshot, { order: ["m/final"], revision: null });
});


test("createLayoutPersistQueue captures the registry at run start rather than enqueue", async () => {
  let known = live("m", "retired");
  const calls: string[][] = [];
  const queue = createLayoutPersistQueue({
    isReachable: () => true,
    setUnreachable: () => { throw new Error("unexpected unreachable"); },
    getSnapshot: () => ({ order: ["m/a", "retired/x"], revision: 1 }),
    setSnapshot: () => undefined,
    getKnownMachines: () => known,
    putLayoutOrder: async order => {
      calls.push([...order]);
      return { reachable: true, order: [...order], revision: 2 };
    },
  });
  const pending = queue.persist({ localOrder: ["m/a", "m/b"], liveKeys: live("m/a", "m/b"),
    reachableMachines: live("m"), reason: "reconcile" });
  known = live("m");
  await pending;
  assert.deepEqual(calls, [["m/a", "m/b"]]);
});

test("createLayoutPersistQueue preserves its copied registry throughout an in-flight conflict round", async () => {
  const known = live("m", "retired");
  const calls: string[][] = [];
  let releaseFirst: (() => void) | undefined;
  let startedFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { startedFirst = resolve; });
  const queue = createLayoutPersistQueue({
    isReachable: () => true,
    setUnreachable: () => { throw new Error("unexpected unreachable"); },
    getSnapshot: () => ({ order: ["m/a", "retired/x"], revision: 1 }),
    setSnapshot: () => undefined,
    getKnownMachines: () => known,
    putLayoutOrder: async order => {
      calls.push([...order]);
      if (calls.length === 1) {
        startedFirst();
        await new Promise<void>(resolve => { releaseFirst = resolve; });
      }
      return { reachable: true, conflict: true, order: ["m/a", "retired/x"], revision: 1 };
    },
  });
  const pending = queue.persist({ localOrder: ["m/a", "m/b"], liveKeys: live("m/a", "m/b"),
    reachableMachines: live("m"), reason: "reconcile" });
  await firstStarted;
  known.delete("retired");
  releaseFirst?.();
  await pending;
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ["m/a", "retired/x", "m/b"]));
});
