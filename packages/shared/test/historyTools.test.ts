import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeConversationSnapshot } from "../src/resources.ts";

test("live resource snapshots retain bounded optional assistant tool parts", () => {
  const tool = { kind: "tool_call", id: "call", call_id: "tool-1", name: "exec_command", input_summary: "pnpm test", status: "ok" };
  const result = { kind: "tool_result", id: "result", call_id: "tool-1", summary: "Tests passed", status: "ok", truncated: false };
  const snapshot = normalizeConversationSnapshot({ messages: [
    { id: "a", role: "assistant", text: "", tool_parts: [tool, { kind: "future" }, { ...tool, name: "x".repeat(129) }] },
    { id: "b", role: "assistant", text: "", tool_parts: [result, { ...result, summary: "x".repeat(2049) }] },
    { id: "u", role: "user", text: "Hello", tool_parts: [tool] },
    { id: "old", role: "assistant", text: "Older runtime" },
  ] });
  assert.equal(snapshot?.messages[0]?.tool_parts?.length, 1);
  assert.equal(snapshot?.messages[0]?.tool_parts?.[0]?.kind, "tool_call");
  assert.equal(snapshot?.messages[1]?.tool_parts?.[0]?.kind, "tool_result");
  assert.equal(snapshot?.messages[2]?.tool_parts, undefined);
  assert.equal(snapshot?.messages[3]?.tool_parts, undefined);
});


test("owner tool siblings are independently bounded and counted in the row budget", () => {
  const call = { kind: "tool_call", id: "call", name: "exec_command", input_summary: "[path]", owner_input_summary: "🌿".repeat(2048) };
  const result = { kind: "tool_result", id: "result", summary: "[path]", owner_summary: "/work/example" };
  const snapshot = normalizeConversationSnapshot({ messages: [{ id: "a", role: "assistant", text: "", tool_parts: [
    call, result, { ...call, id: "oversized", owner_input_summary: "x".repeat(2049) },
    { ...result, id: "malformed", owner_summary: 42 },
  ] }] });
  const parts = snapshot?.messages[0]?.tool_parts as readonly Record<string, unknown>[];
  assert.equal(parts?.length, 4);
  assert.equal(parts?.[0]?.owner_input_summary, "🌿".repeat(2048));
  assert.equal(parts?.[1]?.owner_summary, "/work/example");
  assert.equal(parts?.[2]?.input_summary, "[path]");
  assert.equal(parts?.[2]?.owner_input_summary, undefined);
  assert.equal(parts?.[3]?.owner_summary, undefined);
  const many = normalizeConversationSnapshot({ messages: [{ id: "many", role: "assistant", text: "", tool_parts:
    Array.from({ length: 256 }, (_, i) => ({ ...call, id: String(i) })) }] });
  const bounded = many?.messages[0]?.tool_parts;
  assert.equal((bounded?.length ?? 0) > 0, true);
  assert.equal(Buffer.byteLength(JSON.stringify(bounded)) <= 64 * 1024, true);
});
