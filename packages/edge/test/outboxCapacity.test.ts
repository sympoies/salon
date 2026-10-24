import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SHARED_OUTBOX_MAX_ITEMS } from "@agent-console/shared/shared-outbox";
import { OutboxStore } from "../src/outboxStore.ts";

const target = { principalId: "owner", machine: "fixture", sessionId: "long-session", incarnation: "inc-a" };

function settle(store: OutboxStore, outcome: "submitted" | "refused" | "unknown") {
  const attempt = store.claim(store.candidate(target)!)!;
  store.settle(attempt, { request_id: attempt.item.request_id, session_id: target.sessionId, session_incarnation: target.incarnation,
    outcome, code: outcome === "submitted" ? null : outcome === "unknown" ? "structured-prompt-outcome-unknown" : "session-blocked" });
}

test("a long session keeps accepting replies once old submitted replies fill the store", () => {
  const directory = mkdtempSync(join(tmpdir(), "console-outbox-capacity-"));
  const store = new OutboxStore(join(directory, "state.sqlite"));
  try {
    store.admit(target, "refused", "Never sent", "credentials"); settle(store, "refused");
    store.admit(target, "uncertain", "Outcome unknown", "credentials"); settle(store, "unknown");
    for (let index = 0; store.snapshot(target).items.length < SHARED_OUTBOX_MAX_ITEMS; index++) {
      store.admit(target, `sent-${index}`, `Message ${index}`, "credentials"); settle(store, "submitted");
    }
    const newest = store.snapshot(target).items.at(-1)!;
    assert.equal(store.admit(target, "next", "One more message", "credentials").created, true,
      "submitted replies must not stop a long session from sending");
    const ids = store.snapshot(target).items.map(item => item.id);
    assert.ok(ids.includes("refused") && ids.includes("uncertain"), "only submitted replies make room");
    assert.equal(store.admit(target, newest.id, newest.text, "credentials").created, false,
      "a retry of a recent intent is still recognised and never admitted twice");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a late retry of a pruned submitted intent is recognised and never dispatched again", () => {
  const directory = mkdtempSync(join(tmpdir(), "console-outbox-capacity-"));
  const store = new OutboxStore(join(directory, "state.sqlite"));
  try {
    store.admit(target, "late", "Sent once", "credentials"); settle(store, "submitted");
    for (let index = 0; store.get(target, "late"); index++) {
      store.admit(target, `sent-${index}`, `Message ${index}`, "credentials"); settle(store, "submitted");
    }
    const retry = store.admit(target, "late", "Sent once", "credentials");
    assert.equal(retry.created, false, "the pruned intent was already submitted");
    assert.equal(retry.item.state, "submitted");
    assert.equal(store.candidate(target), undefined, "nothing may be dispatched again");
    assert.throws(() => store.admit(target, "late", "Different text", "credentials"), /outbox-intent-conflict/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const refusal of ["before-dispatch", "receipt"] as const) {
  test(`discarded ${refusal} refusals make room without losing durable cancellation`, () => {
    const directory = mkdtempSync(join(tmpdir(), "console-outbox-capacity-"));
    const path = join(directory, "state.sqlite");
    let store = new OutboxStore(path);
    try {
      let cancelled;
      for (let index = 0; index < SHARED_OUTBOX_MAX_ITEMS; index++) {
        const id = `discard-${index}`;
        store.admit(target, id, `Never send ${index}`, "credentials");
        if (refusal === "receipt") settle(store, "refused");
        else store.refuse(store.candidate(target)!, "session-blocked");
        const refused = store.get(target, id)!;
        const result = store.actOnRefused(target, id, { operation: "discard_refused",
          expected_session_incarnation: target.incarnation, base_revision: refused.revision });
        if (index === 0) cancelled = result;
      }
      assert.equal(store.candidate(target), undefined, "discard sends nothing");
      assert.equal(store.admit(target, "next", "A new reply", "credentials").created, true,
        "discarded replies must not permanently fill the queue");
      assert.ok(!store.snapshot(target).items.some(item => item.id === "discard-0"), "old cancelled rows leave the bounded snapshot");
      store.close();
      store = new OutboxStore(path);
      assert.deepEqual(store.get(target, "discard-0"), cancelled, "the cancellation audit survives pruning and restart");
      const replay = store.admit(target, "discard-0", "Never send 0", "credentials");
      assert.equal(replay.created, false, "an old PUT cannot resurrect a discarded intent");
      assert.deepEqual(replay.item, cancelled, "even a prior refused receipt cannot replace the cancellation");
      assert.throws(() => store.admit(target, "discard-0", "Changed text", "credentials"), /outbox-intent-conflict/);
      assert.equal(store.candidate(target)?.item.id, "next", "only the new intent can reach the provider");
      settle(store, "submitted");
      assert.equal(store.candidate(target), undefined);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
