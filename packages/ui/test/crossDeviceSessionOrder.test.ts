import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sortByDefaultSessionOrder } from "../src/format.ts";
import {
  completeLayoutOrder,
  mergeLayoutOrderWithReachability,
  seedSlotsFromOrder,
} from "../src/layoutOrder.ts";
import { sessionKey, type SlotKey } from "../src/layout.ts";
import { makeSession } from "./support/fixtures.ts";
import type { Session } from "../src/types.ts";

const MACHINES = ["summit"] as const;
const REACHABLE = new Set(MACHINES);

function session(id: string, createdAt: string): Session {
  return makeSession({ id, created_at: createdAt, updated_at: createdAt });
}

function visibleSessions(sessions: readonly Session[]): Session[] {
  return sortByDefaultSessionOrder(sessions, MACHINES);
}

// One device's ordering pipeline with no user reorder in it: the Dashboard's
// `visible` projection, the grid it seeds, and the ranking it publishes just by
// being opened. `storedSlots` stands in for a grid this device already held.
function device({
  ranking,
  sessions,
  slotCount,
  storedSlots,
}: {
  readonly ranking: readonly string[];
  readonly sessions: readonly Session[];
  readonly slotCount: number;
  readonly storedSlots?: readonly SlotKey[];
}): { readonly slots: SlotKey[]; readonly published: string[] } {
  const visible = visibleSessions(sessions);
  const complete = completeLayoutOrder(ranking, visible.map(sessionKey));
  const slots = storedSlots
    ? [...storedSlots]
    : seedSlotsFromOrder(complete, visible, slotCount);
  const published = mergeLayoutOrderWithReachability(
    ranking,
    complete,
    new Set(visible.map(sessionKey)),
    REACHABLE,
    undefined,
    new Set(MACHINES),
  );
  return { slots, published };
}

// The shared order every device must agree on: the stored ranking, then any live
// session the ranking does not cover, in the device-independent default order.
function expectedOrder(ranking: readonly string[], sessions: readonly Session[]): string[] {
  return completeLayoutOrder(ranking, visibleSessions(sessions).map(sessionKey));
}

test("a session the shared ranking does not cover lands in the same place on every device", () => {
  // The user arranged three sessions out of creation order, then a fourth was
  // created while the middle one was gone — the grid that arrangement leaves has
  // a hole, so the new session's rank must not come from grid geometry.
  const sessions = [
    session("a", "2026-09-02T19:24:39Z"),
    session("c", "2026-09-02T20:59:29Z"),
    session("d", "2026-09-02T21:54:41Z"),
    session("fresh", "2026-09-02T22:30:00Z"),
  ];
  const ranking = ["summit/a", "summit/c", "summit/d"];

  // The macOS grid still holds the slot the removed session used to occupy.
  const desktop = device({
    ranking,
    sessions,
    slotCount: 6,
    storedSlots: ["summit/a", null, "summit/c", "summit/d", null, null],
  });
  const phone = device({ ranking, sessions, slotCount: 4 });

  assert.deepEqual(desktop.published, expectedOrder(ranking, sessions));
  assert.deepEqual(phone.published, expectedOrder(ranking, sessions));
  assert.deepEqual(desktop.published, phone.published);
});

test("a device whose grid is smaller than the session list publishes the whole ranking", () => {
  const sessions = [
    session("a", "2026-09-02T19:00:00Z"),
    session("b", "2026-09-02T19:10:00Z"),
    session("c", "2026-09-02T19:20:00Z"),
    session("d", "2026-09-02T19:30:00Z"),
    session("e", "2026-09-02T19:40:00Z"),
    session("f", "2026-09-02T19:50:00Z"),
  ];
  const ranking = ["summit/f", "summit/a", "summit/c"];
  const phone = device({ ranking, sessions, slotCount: 4 });

  assert.deepEqual(phone.published, [
    "summit/f",
    "summit/a",
    "summit/c",
    "summit/b",
    "summit/d",
    "summit/e",
  ]);
  // The four-pane grid still shows the ranking's first four, not creation order.
  assert.deepEqual(phone.slots, ["summit/f", "summit/a", "summit/c", "summit/b"]);
});

test("completeLayoutOrder keeps ranked keys ahead of unranked ones and drops nothing", () => {
  assert.deepEqual(
    completeLayoutOrder(["summit/c", "summit/a"], ["summit/a", "summit/b", "summit/c"]),
    ["summit/c", "summit/a", "summit/b"],
  );
  // A ranked key that is not live on this device stays anchored; pruning it is
  // the reachability merge's job, not this projection's.
  assert.deepEqual(completeLayoutOrder(["mesa/x", "summit/a"], ["summit/a"]), ["mesa/x", "summit/a"]);
  assert.deepEqual(completeLayoutOrder([], ["summit/b", "summit/a"]), ["summit/b", "summit/a"]);
});
