import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeMailboxEvent } from "../src/mailboxEvent.ts";

const wire = {
  schema_version: "agent-session.mailbox-read-event.v1",
  message_id: "11111111-1111-4111-8111-111111111111",
  sender: { kind: "session", machine: "machine-a", session_id: "sender-session-1" },
  category: "handoff",
  state: "read",
  read_at: "2026-11-02T01:02:03.456Z",
  acknowledged_at: null,
  revision: 1,
  availability: "complete",
  body_prefix: "none",
};

test("a v1 mailbox read event keeps only its display fields", () => {
  const normalized = normalizeMailboxEvent({ ...wire, path: "/private", sender: { ...wire.sender, incarnation: "i-1" } });
  assert.deepEqual(normalized, wire);
});

test("normalizing an already normalized event returns it unchanged, so every hop agrees on one shape", () => {
  const once = normalizeMailboxEvent({ ...wire, path: "/private" });
  assert.deepEqual(normalizeMailboxEvent(once), once);
  const service = normalizeMailboxEvent({ ...wire, sender: { kind: "service", machine: "machine-a", service_id: "dispatcher" } });
  assert.deepEqual(normalizeMailboxEvent(service), service);
});

test("service senders, acknowledged state and an ack before the first read are accepted", () => {
  const service = normalizeMailboxEvent({ ...wire, sender: { kind: "service", machine: "machine-a", service_id: "dispatcher" }, category: "uncategorized" });
  assert.deepEqual(service?.sender, { kind: "service", machine: "machine-a", service_id: "dispatcher" });
  const acked = normalizeMailboxEvent({ ...wire, state: "acknowledged", read_at: null, acknowledged_at: "2026-11-02T01:05:00.000Z", revision: 2 });
  assert.equal(acked?.state, "acknowledged");
  assert.equal(acked?.read_at, null);
  assert.equal(acked?.revision, 2);
});

test("the leading-marker body prefix is kept, and an absent or unknown one is not an event", () => {
  assert.equal(normalizeMailboxEvent({ ...wire, body_prefix: "lf" })?.body_prefix, "lf");
  const { body_prefix: _omitted, ...withoutPrefix } = wire;
  for (const bad of [withoutPrefix, { ...wire, body_prefix: "crlf" }, { ...wire, body_prefix: null }]) assert.equal(normalizeMailboxEvent(bad), undefined, JSON.stringify(bad));
});

test("an unknown or malformed mailbox object is not an event", () => {
  for (const bad of [
    null, "text", [], {},
    { ...wire, schema_version: "agent-session.mailbox-read-event.v2" },
    { ...wire, availability: "truncated" },
    { ...wire, state: "unread" },
    { ...wire, category: "gossip" },
    { ...wire, revision: 0 },
    { ...wire, revision: 1.5 },
    { ...wire, message_id: "" },
    { ...wire, sender: { kind: "robot", machine: "m", session_id: "s" } },
    { ...wire, sender: { kind: "session", machine: "m" } },
    { ...wire, read_at: 5 },
  ]) assert.equal(normalizeMailboxEvent(bad), undefined, JSON.stringify(bad));
});
