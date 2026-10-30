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
