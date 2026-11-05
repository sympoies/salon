import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { OutboxStore } from "../src/outboxStore.ts";
import { applyLegacyLifecycleRepair, planLegacyLifecycleRepair } from "../src/outboxLifecycleRepair.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "salon-lifecycle-upgrade-"));
  const path = join(directory, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE outbox_lifecycle(machine TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(machine,session_id)) STRICT");
  for (const id of ["selected", "untouched"]) db.prepare("INSERT INTO outbox_lifecycle VALUES('fixture',?)").run(id);
  db.close();
  const first = new OutboxStore(path), second = new OutboxStore(path);
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
  const fence = first.lifecycle("fixture", "selected")!;
  const proof = {
    schema_version: "outbox-archive-proof.v1", machine: "fixture", session_id: "selected", owner_token: fence.ownerToken,
    fenced_incarnation: "inc-old", verified_completed_archive: true,
    archive_result: { status: 200, body: { ok: true, data: {
      archived: { history_id: "archived-thread", provider: "codex", provider_session_id: "provider-thread",
        cwd: "/work/example", created_at: "2030-01-01T00:00:00Z", updated_at: "2030-01-01T00:00:01Z", archived_at: "2030-01-01T00:00:02Z" },
      deleted: { id: "selected", deleted: true, killed: true, cleanup_pending: false },
    } } },
  };
  return { first, second, fence, proof };
}

test("legacy migration retains distinct stable tokens and requires verified provenance before replacement recovery", t => {
  const { first, second, fence, proof } = fixture(t);
  const other = first.lifecycle("fixture", "untouched")!;
  assert.ok(fence.ownerToken); assert.notEqual(fence.ownerToken, other.ownerToken);
  assert.deepEqual(second.lifecycle("fixture", "selected"), fence, "reopening preserves the migrated identity");
  assert.equal(first.releaseObsoleteLifecycle(fence, "inc-new"), false, "replacement alone cannot identify a legacy operation");
  const text = JSON.stringify(proof);
  const plan = JSON.stringify(planLegacyLifecycleRepair(first, "fixture", "selected", text));
  assert.deepEqual(first.lifecycle("fixture", "selected"), fence, "dry-run must not repair or release");
  applyLegacyLifecycleRepair(second, "fixture", "selected", text, plan);
  const repaired = first.lifecycle("fixture", "selected")!;
  assert.equal(first.releaseLifecycle(fence), false, "pre-repair snapshots cannot clear changed provenance");
  assert.equal(first.releaseObsoleteLifecycle(repaired, "inc-old"), false);
  assert.equal(first.releaseObsoleteLifecycle(repaired, "inc-new"), true);
  assert.deepEqual(first.lifecycle("fixture", "untouched"), other, "repair touches only the named row");
});

test("repair refuses absent provenance, malformed acknowledgements and a stale dry-run plan", t => {
  const { first, second, fence, proof } = fixture(t);
  for (const invalid of [
    { ...proof, verified_completed_archive: false },
    { ...proof, owner_token: "unrelated-owner" },
    { ...proof, fenced_incarnation: "" },
    { ...proof, archive_result: { status: 503, body: proof.archive_result.body } },
    { ...proof, archive_result: { status: 200, body: { ok: true, data: {} } } },
  ]) {
    assert.throws(() => planLegacyLifecycleRepair(first, "fixture", "selected", JSON.stringify(invalid)), /provenance required/);
  }
  const text = JSON.stringify(proof), plan = JSON.stringify(planLegacyLifecycleRepair(first, "fixture", "selected", text));
  assert.throws(() => applyLegacyLifecycleRepair(first, "fixture", "selected", text + " ", plan), /plan changed/);
  assert.deepEqual(first.lifecycle("fixture", "selected"), fence);
  assert.equal(second.releaseLifecycle(fence), true);
  const current = second.beginLifecycle("fixture", "selected", "inc-current", true);
  assert.throws(() => applyLegacyLifecycleRepair(first, "fixture", "selected", text, plan), /legacy fence required/);
  assert.deepEqual(first.lifecycle("fixture", "selected"), current);
});

test("two stores cannot double-release or release a re-acquired fence with old proof", t => {
  const { first, second, fence, proof } = fixture(t);
  const text = JSON.stringify(proof), plan = JSON.stringify(planLegacyLifecycleRepair(first, "fixture", "selected", text));
  applyLegacyLifecycleRepair(first, "fixture", "selected", text, plan);
  const a = first.lifecycle("fixture", "selected")!, b = second.lifecycle("fixture", "selected")!;
  assert.equal(first.releaseObsoleteLifecycle(a, "inc-new"), true);
  assert.equal(second.releaseObsoleteLifecycle(b, "inc-new"), false);
  const next = second.beginLifecycle("fixture", "selected", "inc-new", true);
  assert.notEqual(next.ownerToken, fence.ownerToken);
  assert.equal(first.releaseLifecycle(a), false);
  assert.equal(first.releaseObsoleteLifecycle(b, "inc-new"), false);
  assert.deepEqual(second.lifecycle("fixture", "selected"), next);
});
