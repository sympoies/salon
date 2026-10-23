import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  acknowledgeUnknownCreateRecovery,
  reconcileUnknownCreateRecoveries,
  unknownCreateBlocksNewSession,
  type UnknownCreateRecoveryState,
} from "../src/createLifecycle.ts";

interface Entry extends UnknownCreateRecoveryState {
  readonly key: number;
}

const unknown = (overrides: Partial<Entry> = {}): Entry => ({
  key: 1,
  machine: "summit",
  creationOutcomeUnknown: true,
  listRequestFloor: 4,
  ...overrides,
});

test("an unknown create blocks a new session until it is acknowledged", () => {
  assert.equal(unknownCreateBlocksNewSession([]), false);
  assert.equal(unknownCreateBlocksNewSession([unknown()]), true);
  assert.equal(unknownCreateBlocksNewSession([unknown({ reconciled: true })]), true);
  assert.equal(unknownCreateBlocksNewSession([unknown({ reconciled: true, acknowledged: true })]), false);
  // A known-created session whose prompt was not submitted never blocked creation.
  assert.equal(unknownCreateBlocksNewSession([{ machine: "summit" }]), false);
});

test("only a successful list issued after the incident reconciles it", () => {
  const entries = [unknown()];
  const machines = [{ name: "summit", ok: true }];

  // A request issued before or at the retention floor may have been in flight
  // before the create failed, so it proves nothing about the outcome.
  assert.equal(reconcileUnknownCreateRecoveries(entries, 4, machines), entries);
  // The target machine must actually have answered.
  assert.equal(reconcileUnknownCreateRecoveries(entries, 5, [{ name: "summit", ok: false }]), entries);
  assert.equal(reconcileUnknownCreateRecoveries(entries, 5, [{ name: "mesa", ok: true }]), entries);

  const reconciled = reconcileUnknownCreateRecoveries(entries, 5, machines);
  assert.notEqual(reconciled, entries);
  assert.equal(reconciled[0]?.reconciled, true);
  assert.equal(reconciled[0]?.key, 1);
  // Already reconciled entries are returned unchanged.
  assert.equal(reconcileUnknownCreateRecoveries(reconciled, 6, machines), reconciled);
});

test("acknowledgement requires a reconciled incident and keeps the entry", () => {
  const pending = [unknown()];
  assert.equal(acknowledgeUnknownCreateRecovery(pending, 1), pending);

  const reconciled = [unknown({ reconciled: true }), unknown({ key: 2 })];
  const acknowledged = acknowledgeUnknownCreateRecovery(reconciled, 1);
  assert.equal(acknowledged.length, 2);
  assert.equal(acknowledged[0]?.acknowledged, true);
  assert.equal(acknowledged[1]?.acknowledged, undefined);
  assert.equal(unknownCreateBlocksNewSession(acknowledged), true);
  assert.equal(unknownCreateBlocksNewSession(acknowledged.slice(0, 1)), false);
});
