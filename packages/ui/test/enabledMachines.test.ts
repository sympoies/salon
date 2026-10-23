import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveEnabledMachines, hostVisibilityMigrationPending, acknowledgeHostVisibilityMigration, legacyHostPreferenceSeed, completeLegacyHostPreferenceMigration } from "../src/enabledMachines.ts";
import { setPrincipalStorageNamespace } from "../src/storage.ts";

test("redesign defaults to every principal-visible host despite an old empty opt-in", () => {
  assert.deepEqual(resolveEnabledMachines(["host-a", "host-b", "host-c"], new Set()), ["host-a", "host-b", "host-c"]);
  assert.deepEqual(resolveEnabledMachines([], new Set(["forbidden"])), []);
});
test("migration is one-time and preserves the old preference exactly", () => {
  const values = new Map([["ac.enabledMachines.optIn", "[\"host-b\"]"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  assert.equal(hostVisibilityMigrationPending(storage), true);
  acknowledgeHostVisibilityMigration(storage);
  assert.equal(hostVisibilityMigrationPending(storage), false);
  assert.equal(values.get("ac.enabledMachines.optIn"), "[\"host-b\"]");
});
test("migration notices are principal-local and fresh devices need no migration", () => {
  const values = new Map<string,string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  try {
    setPrincipalStorageNamespace("alice");
    assert.equal(hostVisibilityMigrationPending(storage), false);
    values.set("agent-console.principal.alice.ac.enabledMachines.optIn", "[]");
    assert.equal(hostVisibilityMigrationPending(storage), true);
    acknowledgeHostVisibilityMigration(storage);
    setPrincipalStorageNamespace("bob");
    values.set("agent-console.principal.bob.ac.enabledMachines.optIn", "[]");
    assert.equal(hostVisibilityMigrationPending(storage), true);
  } finally { setPrincipalStorageNamespace(null); }
});

test("manual seed offer ignores unknown hosts, preserves empty intent and removes the old key only on acknowledgment", () => {
  const values = new Map([["ac.enabledMachines.optIn", '["fixture-b","foreign"]'], ["ac.sessionFilters.hostMigrationSeen", "1"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) };
  assert.deepEqual([...legacyHostPreferenceSeed(["fixture-a", "fixture-b"], storage)!], ["fixture-b"]);
  assert.ok(values.has("ac.enabledMachines.optIn"), "reading does not apply or discard the old intent");
  values.set("ac.enabledMachines.optIn", "[]");
  assert.deepEqual([...legacyHostPreferenceSeed(["fixture-a"], storage)!], []);
  assert.equal(completeLegacyHostPreferenceMigration(storage), true);
  assert.equal(values.has("ac.enabledMachines.optIn"), false);
  assert.equal(legacyHostPreferenceSeed(["fixture-a"], storage), null);
});

test("manual seed completion preserves another principal's local preference", () => {
  const values = new Map([["agent-console.principal.fixture-a.ac.enabledMachines.optIn", "[]"], ["agent-console.principal.fixture-b.ac.enabledMachines.optIn", '["fixture-b"]']]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) };
  try {
    setPrincipalStorageNamespace("fixture-a");
    assert.equal(completeLegacyHostPreferenceMigration(storage), true);
    setPrincipalStorageNamespace("fixture-b");
    assert.deepEqual([...legacyHostPreferenceSeed(["fixture-b"], storage)!], ["fixture-b"]);
  } finally { setPrincipalStorageNamespace(null); }
});

test("invalid or unavailable legacy storage never infers a preference", () => {
  for (const raw of ["bad json", "{}", '["fixture-a",1]']) {
    const storage = { getItem: () => raw, setItem() {} };
    assert.equal(legacyHostPreferenceSeed(["fixture-a"], storage), null);
  }
  const denied = { getItem(): string | null { throw new Error("storage denied"); }, setItem() {} };
  assert.equal(legacyHostPreferenceSeed(["fixture-a"], denied), null);
  assert.equal(completeLegacyHostPreferenceMigration(denied), false);
});
