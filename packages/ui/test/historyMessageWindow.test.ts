import { strict as assert } from "node:assert";
import { test } from "node:test";
import { boundHistoryMessages, mergeOlderHistoryMessages } from "../src/historyMessageWindow.ts";
import type { HistoryMessage } from "../src/types.ts";

const row = (id: string): HistoryMessage => ({ id, role: "assistant", text: id });
const event = (id: string, revision = 1): HistoryMessage => ({
  id, role: "notice", text: `<!-- agent-notice:v1 kind=mailbox.read source=agent-session id=${id} -->\n\nbody ${revision}`,
  mailbox: { schema_version: "agent-session.mailbox-read-event.v1", message_id: id, sender: { kind: "session", machine: "m", session_id: "s" }, category: "report", state: "read", read_at: null, acknowledged_at: null, revision, availability: "complete" },
});
const ids = (messages: readonly HistoryMessage[]) => messages.map(message => message.id);

test("a page keeps every mailbox event while bounding provider rows", () => {
  const page = [row("a"), event("e1"), row("b"), row("c"), event("e2"), row("d")];
  assert.deepEqual(ids(boundHistoryMessages(page, 3)), ["a", "e1", "b", "c", "e2"]);
  assert.deepEqual(ids(boundHistoryMessages(page, 10)), ids(page));
  assert.deepEqual(ids(boundHistoryMessages([event("e0"), ...page], 1)), ["e0", "a", "e1"]);
});

test("older rows join the window with events in their place, and the window bounds rows only", () => {
  const current = [row("c"), row("d")];
  const older = [row("a"), event("e1"), row("b")];
  assert.deepEqual(ids(mergeOlderHistoryMessages(current, older, 10)), ["a", "e1", "b", "c", "d"]);
  assert.deepEqual(ids(mergeOlderHistoryMessages(current, older, 3)), ["a", "e1", "b", "c"]);
});

test("a held event is replaced in place only by a higher revision", () => {
  const current = [row("c"), event("e1", 1), row("d")];
  const higher = mergeOlderHistoryMessages(current, [row("a"), event("e1", 2)], 10);
  assert.deepEqual(ids(higher), ["a", "c", "e1", "d"]);
  assert.equal(higher.find(message => message.id === "e1")?.mailbox?.revision, 2);
  const lower = mergeOlderHistoryMessages(current, [row("a"), event("e1", 1)], 10);
  assert.deepEqual(ids(lower), ["a", "c", "e1", "d"]);
  assert.equal(lower.find(message => message.id === "e1")?.mailbox?.revision, 1);
});
