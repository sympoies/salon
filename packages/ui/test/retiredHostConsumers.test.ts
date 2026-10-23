import { strict as assert } from "node:assert";
import { test } from "node:test";
import { unavailableSessionList } from "../src/dashboardSessions.ts";
import { updateHeaderCountAvailability } from "../src/headerCountAvailability.ts";
import { accountMachineKeys } from "../src/useAccountInventories.ts";
import type { MachineStatus } from "@agent-console/shared/api";

test("whole-request failure retains the last explicit inactive status and no offline marker", () => {
  const previous = new Map<string, MachineStatus>([["fixture-retired", { name: "fixture-retired", ok: false, active: false }]]);
  const failure = Reflect.apply(unavailableSessionList, null, [["fixture-retired"], "Fixture rejection", previous]);
  assert.equal(failure.machines[0].active, false);
  const counts = updateHeaderCountAvailability(new Map(), failure.machines, false, 60_001);
  assert.deepEqual(counts.offlineMachines, []);
  assert.deepEqual([...counts.includedMachines], []);
});

test("successful reactivation or a new scope does not inherit the inactive flag", () => {
  for (const previous of [new Map(), new Map([["fixture-retired", { name: "fixture-retired", ok: true }]])]) {
    const failure = Reflect.apply(unavailableSessionList, null, [["fixture-retired"], undefined, previous]);
    assert.equal(failure.machines[0].active, undefined, "missing active retains the legacy default");
  }
});

test("inactive hosts never enter account polling keys while unknown active hosts retain legacy defaults", () => {
  assert.deepEqual(accountMachineKeys([
    { name: "fixture-retired", ok: false, active: false },
    { name: "fixture-default", ok: false },
  ]), { codex: "fixture-default", claude: "" });
});
