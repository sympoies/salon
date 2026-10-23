import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { OutboxStore } from "../src/outboxStore.ts";

test("old schema held and unknown rows survive direct-mode migration without becoming dispatch candidates", () => {
  const directory = mkdtempSync(join(tmpdir(), "console-outbox-migration-"));
  const path = join(directory, "state.sqlite");
  const target = { principalId: "owner", machine: "fixture", sessionId: "session-a", incarnation: "inc-a" };
  const scope = JSON.stringify([target.principalId, target.machine, target.sessionId, target.incarnation]);
  const values = [
    { id: "held", state: "queued", request_id: null, edit_hold: "old-edit" },
    { id: "uncertain", state: "unknown", request_id: "old-request", edit_hold: null },
  ].map(value => ({ text: `Retained ${value.id} text`, session_incarnation: target.incarnation,
    revision: 7, created_at: 1, updated_at: 2, receipt: null, error_code: null, ...value }));
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE outbox_targets (scope TEXT PRIMARY KEY, target TEXT NOT NULL, revision INTEGER NOT NULL, holds TEXT NOT NULL) STRICT;
    CREATE TABLE outbox_items (sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL,
      admission_hash TEXT NOT NULL, credential_generation TEXT NOT NULL, next_attempt_at INTEGER NOT NULL,
      value TEXT NOT NULL, UNIQUE(scope,id)) STRICT;`);
  old.prepare("INSERT INTO outbox_targets VALUES(?,?,7,?)").run(scope, JSON.stringify(target), JSON.stringify(["old-compose"]));
  for (const value of values) old.prepare("INSERT INTO outbox_items(scope,id,admission_hash,credential_generation,next_attempt_at,value) VALUES(?,?,?,?,?,?)")
    .run(scope, value.id, "original-hash", "credentials", 0, JSON.stringify(value));
  old.close();
  let store = new OutboxStore(path);
  try {
    assert.deepEqual(store.snapshot(target), { revision: 7, items: values, compose_holds: ["old-compose"] });
    assert.equal(store.candidate(target), undefined, "migration must not release or submit historical intentions");
    store.admit(target, "new-intent", "A new deliberate follow-up", "credentials");
    const candidate = store.candidate(target)!;
    assert.equal(candidate.item.id, "new-intent", "old unknown and holds cannot pause new input");
    const attempt = store.claim(candidate)!;
    assert.ok(attempt.item.request_id);
    assert.equal(store.claim(candidate), undefined, "a stale competing candidate cannot repeat the claim");
    store.settle(attempt, { request_id: attempt.item.request_id, session_id: target.sessionId,
      session_incarnation: target.incarnation, outcome: "submitted", code: null });
    store.close(); store = new OutboxStore(path);
    assert.deepEqual(store.snapshot(target).items.slice(0, 2), values, "original content, state, holds and request identity survive restart");
    assert.deepEqual(store.snapshot(target).compose_holds, ["old-compose"]);
    assert.equal(store.candidate(target), undefined, "neither historical intentions nor submitted input may replay");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

// Archive and delete wait only for a reply that may still reach the provider.
test("archive and delete wait only for replies that may still be handed to the provider", () => {
  const directory = mkdtempSync(join(tmpdir(), "console-outbox-lifecycle-"));
  const path = join(directory, "state.sqlite");
  const target = { principalId: "owner", machine: "fixture", sessionId: "session-b", incarnation: "inc-b" };
  const scope = JSON.stringify([target.principalId, target.machine, target.sessionId, target.incarnation]);
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE outbox_targets (scope TEXT PRIMARY KEY, target TEXT NOT NULL, revision INTEGER NOT NULL, holds TEXT NOT NULL) STRICT;
    CREATE TABLE outbox_items (sequence INTEGER PRIMARY KEY, scope TEXT NOT NULL, id TEXT NOT NULL,
      admission_hash TEXT NOT NULL, credential_generation TEXT NOT NULL, next_attempt_at INTEGER NOT NULL,
      value TEXT NOT NULL, UNIQUE(scope,id)) STRICT;`);
  old.prepare("INSERT INTO outbox_targets VALUES(?,?,1,'[]')").run(scope, JSON.stringify(target));
  old.prepare("INSERT INTO outbox_items(scope,id,admission_hash,credential_generation,next_attempt_at,value) VALUES(?,?,?,?,?,?)")
    .run(scope, "held", "original-hash", "credentials", 0, JSON.stringify({ id: "held", text: "Old held text", state: "queued",
      session_incarnation: target.incarnation, revision: 1, created_at: 1, updated_at: 2, request_id: null, receipt: null,
      edit_hold: "old-edit", error_code: null }));
  old.close();
  const store = new OutboxStore(path);
  const lifecycle = () => { try { store.beginLifecycle(target.machine, target.sessionId); store.releaseLifecycle(target.machine, target.sessionId); return "open"; }
    catch (error) { return (error as { code?: string }).code; } };
  try {
    assert.equal(lifecycle(), "open", "a migrated held row is never dispatched, so it cannot hold archive or delete");
    store.admit(target, "refused", "Refused by the provider", "credentials");
    assert.equal(lifecycle(), "outbox-pending-replies", "a reply waiting for handoff still holds the session");
    const attempt = store.claim(store.candidate(target)!)!;
    store.settle(attempt, { request_id: attempt.item.request_id, session_id: target.sessionId,
      session_incarnation: target.incarnation, outcome: "refused", code: "session-blocked" });
    assert.equal(store.get(target, "refused")?.state, "refused");
    assert.equal(lifecycle(), "open", "a definitely refused reply never reaches the provider, so archive and delete proceed");
    store.admit(target, "uncertain", "Outcome unknown", "credentials");
    const sent = store.claim(store.candidate(target)!)!;
    store.settle(sent, { request_id: sent.item.request_id, session_id: target.sessionId,
      session_incarnation: target.incarnation, outcome: "unknown", code: "structured-prompt-outcome-unknown" });
    assert.equal(lifecycle(), "outbox-pending-replies", "an uncertain reply may still reach the provider");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
