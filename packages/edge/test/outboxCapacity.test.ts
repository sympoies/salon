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
