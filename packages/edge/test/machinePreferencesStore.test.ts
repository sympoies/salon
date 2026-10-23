import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { MachinePreferencesStore } from "../src/machinePreferences.ts";

function fixture(run: (path: string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "machine-preference-store-"));
  try { run(join(dir, "state.sqlite"), dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("manual changes persist across connections with isolated ordered audit history", () => fixture(path => {
  const first = new MachinePreferencesStore(path);
  first.write("fixture-owner", "fixture-a", false, " Planned maintenance ", "principal:fixture-owner");
  first.write("fixture-other", "fixture-a", true, "Other account", "principal:fixture-other");
  first.close();
  const next = new MachinePreferencesStore(path);
  try {
    assert.deepEqual([...next.disabled("fixture-owner")], ["fixture-a"]);
    assert.deepEqual([...next.disabled("fixture-other")], []);
    next.write("fixture-owner", "fixture-a", true, "Maintenance complete", "owner-local:fixture");
    const audit = next.audit("fixture-owner");
    assert.deepEqual(audit.map(row => [row.enabled, row.revision, row.reason]), [
      [0, 1, "Planned maintenance"], [1, 2, "Maintenance complete"],
    ]);
    assert.ok(audit[1].change_id > audit[0].change_id);
    assert.equal(next.snapshot("fixture-owner", [{ name: "fixture-a", url: "unused", token: "unused" }])[0].last_change?.revision, 2);
  } finally { next.close(); }
}));

test("failed audit append rolls back the effective preference and revision", () => fixture(path => {
  const store = new MachinePreferencesStore(path);
  const probe = new DatabaseSync(path);
  try {
    store.write("fixture-owner", "fixture-a", true, "Initial", "principal:fixture-owner");
    probe.exec("CREATE TRIGGER reject_preference_audit BEFORE INSERT ON machine_preference_audit BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
    assert.throws(() => store.write("fixture-owner", "fixture-a", false, "Rejected", "principal:fixture-owner"), /fixture audit failure/);
    assert.deepEqual([...store.disabled("fixture-owner")], []);
    assert.equal(store.audit("fixture-owner").length, 1);
    probe.exec("DROP TRIGGER reject_preference_audit");
    assert.equal(store.write("fixture-owner", "fixture-a", false, "Accepted", "principal:fixture-owner").revision, 2);
  } finally { probe.close(); store.close(); }
}));

test("initial device preference cannot overwrite a value already written by another client", () => fixture(path => {
  const store = new MachinePreferencesStore(path);
  try {
    store.write("fixture-owner", "fixture-a", false, "Owner maintenance", "owner-local:fixture");
    assert.throws(() => Reflect.apply(store.write, store, ["fixture-owner", "fixture-a", true,
      "Device migration", "principal:fixture-owner", true]), /already initialized/);
    assert.deepEqual([...store.disabled("fixture-owner")], ["fixture-a"]);
    assert.equal(store.audit("fixture-owner").length, 1);
    const seeded = Reflect.apply(store.write, store, ["fixture-owner", "fixture-b", false,
      "Device migration", "principal:fixture-owner", true]);
    assert.equal(seeded.revision, 1);
  } finally { store.close(); }
}));

test("owner-local CLI updates only preference tables, preserving retained auth and legacy tables", () => fixture(path => {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE auth_sessions (value TEXT); INSERT INTO auth_sessions VALUES ('retained-fixture'); CREATE TABLE principal_claude_display (value TEXT); INSERT INTO principal_claude_display VALUES ('legacy-fixture')");
  db.close();
  chmodSync(path, 0o600);
  const result = spawnSync(process.execPath, [new URL("../src/machinePreferencesCli.ts", import.meta.url).pathname,
    "--db", path, "--principal", "fixture-owner", "--machine", "fixture-a", "--disable", "--reason", "Owner maintenance", "--actor", "coordinator"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.principal, "fixture-owner");
  assert.equal(receipt.enabled, false);
  assert.equal(receipt.change.actor, `owner-local:${process.getuid!()}:coordinator`);
  const retained = new DatabaseSync(path);
  try {
    assert.deepEqual(retained.prepare("SELECT value FROM auth_sessions").all().map(row => row.value), ["retained-fixture"]);
    assert.deepEqual(retained.prepare("SELECT value FROM principal_claude_display").all().map(row => row.value), ["legacy-fixture"]);
    assert.equal(retained.prepare("SELECT count(*) AS n FROM machine_preference_audit").get()!.n, 1);
  } finally { retained.close(); }
}));

test("owner-local CLI rejects public files, symlinks and incomplete intent before writing", () => fixture((path, dir) => {
  new DatabaseSync(path).close();
  const args = [new URL("../src/machinePreferencesCli.ts", import.meta.url).pathname, "--db", path,
    "--principal", "fixture-owner", "--machine", "fixture-a", "--disable", "--reason", "Maintenance", "--actor", "coordinator"];
  const cli = (values: string[]) => spawnSync(process.execPath, values, { encoding: "utf8" });
  chmodSync(path, 0o644);
  assert.match(cli(args).stderr, /private regular file/);
  chmodSync(path, 0o600);
  const link = join(dir, "linked.sqlite"); symlinkSync(path, link);
  const linked = [...args]; linked[2] = link;
  assert.match(cli(linked).stderr, /private regular file/);
  assert.match(cli(args.filter((_, index) => index !== 8 && index !== 9)).stderr, /usage:/);
  assert.match(cli([...args, "--enable"]).stderr, /usage:/);
  const db = new DatabaseSync(path);
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='machine_preferences'").get()!.n, 0); }
  finally { db.close(); }
}));
