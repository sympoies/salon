import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeSavedDraft, normalizeSavedDraftInventory } from "../src/savedDraft.ts";

const draft = { event: "stale_draft_stashed", draft_id: "draft-1", saved_at: "2026-11-01T12:00:00Z", session_id: "session-1", bytes: 8, cleared: true };

test("saved draft metadata projects only the frozen fields", () => {
  assert.deepEqual(normalizeSavedDraft({ ...draft, text: "private" }, "session-1"), draft);
  assert.equal(normalizeSavedDraft({ ...draft, session_id: "other" }, "session-1"), undefined);
  assert.equal(normalizeSavedDraft({ ...draft, bytes: -1 }, "session-1"), undefined);
  assert.equal(normalizeSavedDraft(undefined, "session-1"), undefined);
});

test("inventory distinguishes an absent route or malformed data from an empty inventory", () => {
  assert.deepEqual(normalizeSavedDraftInventory({ drafts: [draft] }, "session-1"), [draft]);
  assert.deepEqual(normalizeSavedDraftInventory({ drafts: [] }, "session-1"), []);
  assert.equal(normalizeSavedDraftInventory({}, "session-1"), undefined);
  assert.equal(normalizeSavedDraftInventory({ drafts: [{ ...draft, bytes: -1 }] }, "session-1"), undefined);
});
