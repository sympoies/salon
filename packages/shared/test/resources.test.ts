import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeResourceEvent, ResourceSseDecoder, resourceKey } from "../src/resources.ts";
test("resource notifications allowlist metadata and reject malformed keys or revisions", () => {
  const event = { schema_version: "agent-console.resource-event.v1", type: "changed", resource: "sessions", revision: 1 };
  assert.deepEqual(normalizeResourceEvent({ ...event, prompt: "secret" }), event);
  assert.equal(normalizeResourceEvent({ ...event, resource: "credential" }), null);
  assert.equal(normalizeResourceEvent({ ...event, revision: -1 }), null);
  assert.equal(normalizeResourceEvent({ ...event, revision: 1.5 }), null);
  assert.equal(resourceKey({ resource: "conversation", machine: "a/b", id: "history/id" }), "conversation/a%2Fb/history%2Fid");
  const decoder = new ResourceSseDecoder();
  assert.deepEqual(decoder.push(`event: changed\ndata: ${JSON.stringify({ ...event, prompt: "secret" })}\n`), []);
  assert.deepEqual(decoder.push("\n"), [event]);
});

test("conversation snapshots admit the notice role only for a valid envelope without images", () => {
  const metadata = { schema_version: "agent-console.resource-event.v1", type: "changed", resource: "conversation/host/history", revision: 1 };
  const text = "<!-- agent-notice:v1 kind=mailbox source=fixture id=sample-1 -->\n\nSynthetic update";
  const conversation = { messages: [
    { id: "n1", role: "notice", text },
    { id: "n2", role: "notice", text: "plain text, not an envelope" },
    { id: "n3", role: "notice", text, images: [{ id: `${"a".repeat(16)}.0.0.${"b".repeat(32)}` }] },
    { id: "u1", role: "user", text: "hello" },
  ] };
  assert.deepEqual(normalizeResourceEvent({ ...metadata, conversation }), {
    ...metadata, conversation: { messages: [{ id: "n1", role: "notice", text }, { id: "u1", role: "user", text: "hello" }] },
  });
});

test("conversation snapshots carry only bounded normalized messages and cursors", () => {
  const metadata = { schema_version: "agent-console.resource-event.v1", type: "changed", resource: "conversation/host/history", revision: 1 };
  const snapshot = { messages: [{ id: "a1", role: "assistant", text: "new reply", source_path: "private" }], older_cursor: "older", token: "private" };
  assert.deepEqual(normalizeResourceEvent({ ...metadata, conversation: snapshot }), {
    ...metadata, conversation: { messages: [{ id: "a1", role: "assistant", text: "new reply" }], older_cursor: "older" },
  });
  for (const conversation of [ { messages: [{ id: "bad", role: "system", text: "bad" }] },
    { messages: Array.from({ length: 51 }, () => ({ id: "a", role: "user", text: "x" })) },
    { messages: [{ id: "big", role: "assistant", text: "x".repeat(64 * 1024) }] },
    { messages: [{ id: "dup", role: "user", text: "one" }, { id: "dup", role: "user", text: "two" }] } ]) {
    assert.deepEqual(normalizeResourceEvent({ ...metadata, conversation }), metadata, "invalid/oversized snapshot falls back to HTTP");
  }
  assert.deepEqual(normalizeResourceEvent({ ...metadata, resource: "sessions", conversation: snapshot }), { ...metadata, resource: "sessions" });
});


test("conversation snapshots preserve bounded image-only descriptors without paths or bytes", () => {
  const id = `${"a".repeat(16)}.0.0.${"b".repeat(32)}`;
  const event = {schema_version:"agent-console.resource-event.v1",type:"changed",resource:"conversation/fixture/history",revision:1};
  const image = {id,path:"/private/image.png",data:"private"};
  const conversation = {messages:[{id:"image-only",role:"user",text:"",images:[image]}]};
  assert.deepEqual(normalizeResourceEvent({...event,conversation}),{...event,conversation:{messages:[{id:"image-only",role:"user",text:"",images:[{id}]}]}});
  const bounded = normalizeResourceEvent({...event,conversation:{messages:[{id:"many",role:"assistant",text:"images",images:Array(30).fill(image)}]}});
  assert.equal(bounded?.conversation?.messages[0]?.images?.length,16);
});

test("conversation snapshots retain classified rows including empty compactions", () => {
  const conversation = { messages: [
    { id: "compact", role: "notice", text: "", row_class: "compaction", compaction: { summary_truncated: true } },
    { id: "notice", role: "user", text: "Synthetic notice", row_class: "notice" },
    { id: "unknown", role: "user", text: "ordinary", row_class: "future" },
  ] };
  assert.deepEqual(normalizeResourceEvent({ schema_version: "agent-console.resource-event.v1", type: "changed", resource: "conversation/a/b", revision: 1, conversation })?.conversation,
    { messages: [conversation.messages[0], conversation.messages[1], { id: "unknown", role: "user", text: "ordinary" }] });
});

test("conversation snapshots preserve sanitized file names and unnamed descriptor positions", () => {
  const file = JSON.parse(readFileSync(new URL("./fixtures/history-file-part-v1.json", import.meta.url), "utf8"));
  const metadata = { schema_version: "agent-console.resource-event.v1", type: "changed", resource: "conversation/fixture/history", revision: 1 };
  const unnamed = { kind: "file", id: "unnamed.file-0-0", bytes: 0 };
  const row = { id: "message", role: "user", text: "Synthetic uploads" };
  assert.deepEqual(normalizeResourceEvent({ ...metadata, conversation: { messages: [{ ...row, files: [
    { ...unnamed, original_name: ".." }, { ...file, original_name: "../folder\\notes\u0000.txt", future_field: true },
    { ...file, kind: "future" }, { ...file, bytes: -1 },
  ] }] } })?.conversation, { messages: [{ ...row, files: [unnamed, file] }] });
});


test("#452 conversation resource decoding keeps the accepted user request association", () => {
  const binding = { request_id: "request-a", session_id: "session-a", session_incarnation: "inc-a", outbox_intent_id: "intent-a" };
  const event = normalizeResourceEvent({ schema_version: "agent-console.resource-event.v1", type: "changed",
    resource: "conversation/fixture/history-a", revision: 1,
    conversation: { messages: [{ id: "user-a", role: "user", text: "Provider projection", prompt_request: { ...binding, private_proof: "not-public" } }] } });
  const row = event?.conversation?.messages[0] as { prompt_request?: typeof binding & { private_proof?: string } } | undefined;
  assert.equal(row?.prompt_request?.request_id, binding.request_id);
  assert.equal(row?.prompt_request?.outbox_intent_id, binding.outbox_intent_id);
  assert.equal(row?.prompt_request?.private_proof, undefined);
});

for (const [label, changes] of [
  ["assistant", { role: "assistant" }],
  ["classified user", { row_class: "runtime_command" }],
  ["invalid request", { prompt_request: { request_id: "bad id", session_id: "session-a", session_incarnation: "inc-a" } }],
  ["invalid session", { prompt_request: { request_id: "request-a", session_id: "bad id", session_incarnation: "inc-a" } }],
  ["invalid incarnation", { prompt_request: { request_id: "request-a", session_id: "session-a", session_incarnation: "inc\u0000a" } }],
] as const) test(`#457 resource decoder strips the association from ${label} rows`, () => {
  const event = normalizeResourceEvent({ schema_version: "agent-console.resource-event.v1", type: "changed",
    resource: "conversation/fixture/history-a", revision: 1, conversation: { messages: [{
      id: "guarded-row", role: "user", text: "Synthetic history",
      prompt_request: { request_id: "request-a", session_id: "session-a", session_incarnation: "inc-a" }, ...changes,
    }] } });
  assert.equal(event?.conversation?.messages.length, 1, "a rejected association preserves its history row");
  assert.equal(event?.conversation?.messages[0]?.id, "guarded-row");
  assert.equal(event?.conversation?.messages[0]?.prompt_request, undefined);
});
