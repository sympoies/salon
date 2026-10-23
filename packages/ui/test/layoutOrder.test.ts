import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  deriveLayoutOrder,
  layoutOrderChanged,
  mergeLayoutOrderPreservingRemote,
  mergeLayoutOrderWithLocalPrefix,
  mergeLayoutOrderWithReachability,
  orderForCreatedSession,
  removeLayoutOrderKey,
  seedSlotsFromOrder,
} from "../src/layoutOrder.ts";
import type { KeyedSession } from "../src/layout.ts";

// The cross-device arrangement is one relative ORDER of `machine/id` keys, not
// slot indices — desktop grids are 2/3/4/6 and mobile 1-4, so an index can't map
// across devices. deriveLayoutOrder turns the local slot layout into that
// ranking (to PUT); seedSlotsFromOrder maps a fetched ranking back into this
// device's own grid (to seed). layoutOrderChanged gates the debounced PUT so
// reconcile churn that leaves the ranking unchanged does not re-send.

const sessions = (...keys: string[]): KeyedSession[] =>
  keys.map((k) => {
    const [machine, id] = k.split("/");
    return { machine: machine ?? "", id: id ?? "" };
  });

test("deriveLayoutOrder ranks non-null slot keys in slot order", () => {
  assert.deepEqual(deriveLayoutOrder([null, "m/b", null, "m/a"]), ["m/b", "m/a"]);
});

test("deriveLayoutOrder dedupes and skips nulls", () => {
  assert.deepEqual(deriveLayoutOrder(["m/a", null, "m/a", "m/b"]), ["m/a", "m/b"]);
  assert.deepEqual(deriveLayoutOrder([null, null]), []);
});

test("seedSlotsFromOrder places ranked keys first, then appends the rest in default order", () => {
  // order asks for b,a first; c is a live session with no rank -> appended.
  assert.deepEqual(
    seedSlotsFromOrder(["m/b", "m/a"], sessions("m/a", "m/b", "m/c"), 4),
    ["m/b", "m/a", "m/c", null],
  );
});

test("seedSlotsFromOrder drops keys for sessions that no longer exist", () => {
  // m/x was killed; it is dropped and the live m/b is appended in default order.
  assert.deepEqual(seedSlotsFromOrder(["m/x", "m/a"], sessions("m/a", "m/b"), 2), ["m/b", "m/a"]);
});

test("seedSlotsFromOrder maps one ranking into whatever grid size this device has", () => {
  const order = ["m/a", "m/b", "m/c"];
  assert.deepEqual(seedSlotsFromOrder(order, sessions("m/a", "m/b", "m/c"), 2), ["m/a", "m/b"]);
  assert.deepEqual(seedSlotsFromOrder(order, sessions("m/a", "m/b", "m/c"), 6), [
    "m/a",
    "m/b",
    "m/c",
    null,
    null,
    null,
  ]);
});

test("layoutOrderChanged detects a real reordering but ignores an identical list", () => {
  assert.equal(layoutOrderChanged(["a", "b"], ["a", "b"]), false);
  assert.equal(layoutOrderChanged([], []), false);
  assert.equal(layoutOrderChanged(["a", "b"], ["b", "a"]), true);
  assert.equal(layoutOrderChanged(["a"], ["a", "b"]), true);
  assert.equal(layoutOrderChanged(["a", "b"], ["a"]), true);
});

const live = (...keys: string[]): ReadonlySet<string> => new Set(keys);

function knownMachines(...keys: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const key of keys) {
    const index = key.indexOf("/");
    if (index > 0) {
      out.add(key.slice(0, index));
    }
  }
  return out;
}

function mergeReachable(
  previous: readonly string[],
  localOrder: readonly string[],
  liveKeys: ReadonlySet<string>,
): string[] {
  const machines = knownMachines(...previous, ...localOrder, ...liveKeys);
  return mergeLayoutOrderWithReachability(previous, localOrder, liveKeys, machines, undefined, machines);
}

test("mergeLayoutOrderWithReachability preserves ranked keys this device did not place (no truncation)", () => {
  // Grid smaller than the ranking: the device placed only the top 2, but c/d/e
  // must survive in the persisted order rather than being dropped.
  const previous = ["m/a", "m/b", "m/c", "m/d", "m/e"];
  const localOrder = ["m/a", "m/b"]; // only 2 slots visible
  assert.deepEqual(mergeReachable(previous, localOrder, live("m/a", "m/b", "m/c", "m/d", "m/e")), previous);
});

test("mergeLayoutOrderWithReachability REGRESSION: seed->derive round-trips a longer-than-grid order unchanged", () => {
  // The exact seed->derive composition Dashboard effect 3 runs must NOT shrink a
  // 5-key stored order down to the 2-slot grid (the truncation-clobber bug).
  const stored = ["m/a", "m/b", "m/c", "m/d", "m/e"];
  const sessions = live("m/a", "m/b", "m/c", "m/d", "m/e");
  const seededSlots = seedSlotsFromOrder(stored, [...sessions].map((k) => {
    const [machine, id] = k.split("/");
    return { machine: machine ?? "", id: id ?? "" };
  }), 2);
  const derived = deriveLayoutOrder(seededSlots);
  assert.equal(derived.length, 2); // grid only shows 2
  const toPersist = mergeReachable(stored, derived, sessions);
  assert.deepEqual(toPersist, stored); // full order preserved -> layoutOrderChanged is false -> no clobber PUT
  assert.equal(layoutOrderChanged(toPersist, stored), false);
});

test("mergeLayoutOrderWithReachability repositions the placed keys and keeps unplaced ones anchored", () => {
  // User swaps a<->b on a 2-slot device; c stays where it was ranked.
  assert.deepEqual(
    mergeReachable(["m/a", "m/b", "m/c"], ["m/b", "m/a"], live("m/a", "m/b", "m/c")),
    ["m/b", "m/a", "m/c"],
  );
});

test("mergeLayoutOrderWithReachability keeps a non-visible key anchored in place (machine filter)", () => {
  // Filtered to machine A: only A keys are placed; B/1 must keep its slot, not be
  // demoted or dropped, and an unchanged A arrangement must not reorder anything.
  assert.deepEqual(
    mergeReachable(["A/1", "B/1", "A/2"], ["A/1", "A/2"], live("A/1", "A/2", "B/1")),
    ["A/1", "B/1", "A/2"],
  );
});

test("mergeLayoutOrderWithReachability drops keys for sessions that no longer exist", () => {
  assert.deepEqual(
    mergeReachable(["m/a", "m/b", "m/c"], ["m/a", "m/c"], live("m/a", "m/c")),
    ["m/a", "m/c"],
  );
});

test("mergeLayoutOrderWithReachability appends newly placed keys not present in the previous ranking", () => {
  assert.deepEqual(
    mergeReachable(["m/a", "m/b"], ["m/a", "m/b", "m/z"], live("m/a", "m/b", "m/z")),
    ["m/a", "m/b", "m/z"],
  );
});

test("mergeLayoutOrderWithReachability seeds an empty store from the local order", () => {
  assert.deepEqual(mergeReachable([], ["m/a", "m/b"], live("m/a", "m/b")), ["m/a", "m/b"]);
});

test("mergeLayoutOrderPreservingRemote appends local discoveries without reordering remote keys", () => {
  assert.deepEqual(
    mergeLayoutOrderPreservingRemote(
      ["m/a", "m/c"],
      ["m/b", "m/a", "m/c", "m/d"],
      live("m/a", "m/b", "m/c", "m/d"),
      live("m"),
      undefined,
      live("m"),
    ),
    ["m/a", "m/c", "m/b", "m/d"],
  );
});

test("mergeLayoutOrderPreservingRemote prunes only missing keys on reachable machines", () => {
  assert.deepEqual(
    mergeLayoutOrderPreservingRemote(
      ["A/1", "B/1", "A/dead", "A/2"],
      ["A/2", "A/1"],
      live("A/1", "A/2"),
      live("A"),
      undefined,
      live("A", "B"),
    ),
    ["A/1", "B/1", "A/2"],
  );
});

// Documented behavior + known caveat (tracked as #106 Sprint 2): mergeLayoutOrder
// prunes any previous key not in liveKeys. That correctly drops a killed session,
// but liveKeys is built from the device's current session list, so a key whose
// machine is *transiently unreachable* (aggregateSessions returns no sessions for
// it) is also pruned, and a kill-then-resume re-appends at the tail (rank lost).
// Pinned here so a future reachability-aware change is a conscious contract shift.
test("mergeLayoutOrder prunes a key absent from liveKeys (killed OR machine offline)", () => {
  // B/1 is absent from liveKeys (machine B killed the session, or B is offline).
  assert.deepEqual(mergeReachable(["A/1", "B/1", "A/2"], ["A/1", "A/2"], live("A/1", "A/2")), ["A/1", "A/2"]);
});

test("mergeLayoutOrder re-appends a resumed key at the tail (prior rank not restored)", () => {
  // m/b was pruned earlier; on resume it is live again and appended after the rest.
  assert.deepEqual(
    mergeReachable(["m/a", "m/c"], ["m/a", "m/c", "m/b"], live("m/a", "m/b", "m/c")),
    ["m/a", "m/c", "m/b"],
  );
});

test("mergeLayoutOrderWithReachability keeps keys from unreachable machines anchored", () => {
  // B/1 did not show up in this poll, but machine B is not reachable. Keep its
  // rank so a transient outage does not erase the cross-device order.
  assert.deepEqual(
    mergeLayoutOrderWithReachability(["A/1", "B/1", "A/2"], ["A/2", "A/1"], live("A/1", "A/2"), live("A")),
    ["A/2", "B/1", "A/1"],
  );
});

test("mergeLayoutOrderWithReachability drops missing keys from reachable machines", () => {
  assert.deepEqual(
    mergeLayoutOrderWithReachability(["A/1", "A/2", "A/3"], ["A/1", "A/3"], live("A/1", "A/3"), live("A")),
    ["A/1", "A/3"],
  );
});

test("mergeLayoutOrderWithReachability drops malformed or unknown-machine keys", () => {
  assert.deepEqual(
    mergeLayoutOrderWithReachability(
      ["A/1", "malformed", "Z/1", "B/1", "A/2"],
      ["A/2", "A/1"],
      live("A/1", "A/2"),
      live("A"),
      undefined,
      live("A", "B"),
    ),
    ["A/2", "B/1", "A/1"],
  );
});

test("mergeLayoutOrderWithReachability treats an empty known-machine set as unknown", () => {
  assert.deepEqual(
    mergeLayoutOrderWithReachability(["A/1", "B/1"], ["A/1"], live("A/1"), live("A"), undefined, live()),
    ["A/1", "B/1"],
  );
});

test("orderForCreatedSession keeps slot-created sessions at their assigned rank", () => {
  assert.deepEqual(orderForCreatedSession(["m/new", "m/b", "m/c"], "m/new", true), ["m/new", "m/b", "m/c"]);
});

test("mergeLayoutOrderWithLocalPrefix lets explicit placement displace old ranked keys", () => {
  assert.deepEqual(
    mergeLayoutOrderWithLocalPrefix(["m/a", "m/b"], ["m/new", "m/b"], live("m/a", "m/b", "m/new"), live("m"), undefined, live("m")),
    ["m/new", "m/b", "m/a"],
  );
});

test("orderForCreatedSession appends non-slot creates after the current rendered order", () => {
  assert.deepEqual(orderForCreatedSession(["m/a", "m/b"], "m/new", false), ["m/a", "m/b", "m/new"]);
});

test("removeLayoutOrderKey prunes a killed session immediately before app shutdown", () => {
  assert.deepEqual(removeLayoutOrderKey(["m/1", "m/2", "m/3"], "m/1"), ["m/2", "m/3"]);
});
