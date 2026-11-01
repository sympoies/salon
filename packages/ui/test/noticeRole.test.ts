import { strict as assert } from "node:assert";
import { test } from "node:test";
import { transcriptProof, type QueuedReply } from "../src/conversationOutbox.ts";
import { stuckTurn } from "../src/stuckTurn.ts";
import type { HistoryMessage, TurnState } from "../src/types.ts";

const text = "<!-- agent-notice:v1 kind=mailbox source=fixture id=sample-1 -->\n\nSynthetic update";
const failed = { last_turn: { outcome: "failed", completed_at: "2026-01-01T00:00:10Z" } } as unknown as TurnState;
const notice = (timestamp: string): HistoryMessage => ({ id: "n1", role: "notice", text, timestamp });

test("a notice after a failed turn does not change stuck-turn detection", () => {
  const user: HistoryMessage = { id: "u1", role: "user", text: "Do the work", timestamp: "2026-01-01T00:00:00Z" };
  const assistant: HistoryMessage = { id: "a1", role: "assistant", text: "Started", timestamp: "2026-01-01T00:00:05Z" };
  assert.deepEqual(stuckTurn(failed, null, [user, assistant, notice("2026-01-01T00:00:20Z")]), stuckTurn(failed, null, [user, assistant]));
  assert.equal(stuckTurn(failed, null, [user, assistant, notice("2026-01-01T00:00:20Z")])?.action?.label, "Continue");
  // A later notice is not the next try that a user message after the failure would be.
  assert.equal(stuckTurn(failed, null, [user, notice("2026-01-01T00:00:20Z")])?.action?.text, "Do the work");
});

test("a notice never proves a queued reply delivered", () => {
  const reply = { id: "r1", text, incarnation: "inc-1", requestId: "req-1", state: "delivered", attemptedAt: Date.parse("2026-01-01T00:00:00Z") } as QueuedReply;
  assert.equal(transcriptProof([reply], [notice("2026-01-01T00:00:01Z")]).size, 0);
  assert.equal(transcriptProof([reply], [{ ...notice("2026-01-01T00:00:01Z"), role: "user" }]).size, 1);
});

test("a mailbox read event is not an agent turn: stuck-turn detection and reply proof ignore it", () => {
  const event: HistoryMessage = {
    ...notice("2026-01-01T00:00:20Z"),
    mailbox: { schema_version: "agent-session.mailbox-read-event.v1", message_id: "m-1", sender: { kind: "session", machine: "m", session_id: "s" }, category: "report", state: "read", read_at: null, acknowledged_at: null, revision: 1, availability: "complete" },
  };
  const user: HistoryMessage = { id: "u1", role: "user", text: "Do the work", timestamp: "2026-01-01T00:00:00Z" };
  const assistant: HistoryMessage = { id: "a1", role: "assistant", text: "Started", timestamp: "2026-01-01T00:00:05Z" };
  assert.deepEqual(stuckTurn(failed, null, [user, assistant, event]), stuckTurn(failed, null, [user, assistant]));
  const reply = { id: "r1", text: "x", incarnation: "inc-1", requestId: "req-1", state: "delivered", attemptedAt: Date.parse("2026-01-01T00:00:00Z") } as QueuedReply;
  assert.equal(transcriptProof([reply], [event]).size, 0);
});
