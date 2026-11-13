import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { createEdgeServer } from "../src/server.ts";
import { projectHistoryMessagesDaemonData } from "../src/daemonEnvelope.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

// Current runtime parts=v1: calls and results can be separate, textless assistant rows.
const fixture = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/history-tool-parts-v1.json", import.meta.url), "utf8"));

test("history HTTP requests typed parts and retains textless tool calls and correlated results", async () => {
  let query = "";
  const daemon = createServer((req, res) => {
    query = req.url ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: fixture }));
  });
  const { base: upstream } = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: true, machines: [{ name: "fixture", url: upstream }] }));
  const { base } = await listenOnLoopback(edge);
  try {
    const response = await fetch(`${base}/api/history/sessions/fixture/history/messages`);
    assert.equal(response.status, 200);
    assert.equal(new URL(query, upstream).searchParams.get("parts"), "v1", "real edge-to-daemon request opts in");
    const data = (await response.json() as { data: { messages: Array<Record<string, any>> } }).data;
    assert.equal(data.messages.length, 3, "tool-only assistant rows survive projection");
    assert.equal(data.messages[0]?.tool_parts?.[0]?.name, "exec_command");
    assert.equal(data.messages[0]?.tool_parts?.[0]?.input_summary, "pnpm test");
    assert.equal(data.messages[0]?.tool_parts?.[0]?.status, "ok");
    assert.equal(data.messages[1]?.tool_parts?.[0]?.call_id, "tool-1");
    assert.equal(data.messages[1]?.tool_parts?.[0]?.summary, "12 tests passed");
    assert.equal(data.messages[2]?.tool_parts?.[1]?.summary.includes("+new example"), true);
    assert.equal(data.messages[0]?.parts, undefined, "raw producer fields stay private");
  } finally {
    edge.closeAllConnections(); daemon.closeAllConnections();
    await Promise.all([new Promise<void>(r => edge.close(() => r())), new Promise<void>(r => daemon.close(() => r()))]);
  }
});

test("tool projection drops unknown and oversized parts, bounds rows, and ignores non-assistant tools", () => {
  const call = fixture.messages[0].parts[0];
  const projected = projectHistoryMessagesDaemonData({ messages: [
    { id: "a", role: "assistant", text: "Safe", parts: [
      { ...call, extra: "producer-only" }, { ...call, name: "n".repeat(129) },
      { ...call, input_summary: "x".repeat(2049) }, { kind: "future", summary: "hidden" },
      { kind: "tool_result", id: "bad", summary: "x".repeat(2049) },
      { ...call, id: "unicode", input_summary: "🌿".repeat(2048), status: "unknown" },
      { kind: "tool_result", id: "error", call_id: "other", summary: "Failed", is_error: true },
    ] },
    { id: "u", role: "user", text: "Hello", parts: [call] },
    { id: "empty", role: "assistant", text: "", parts: [{ kind: "future" }] },
  ] }) as { messages: Array<Record<string, any>> };
  assert.equal(projected.messages.length, 2);
  const parts = projected.messages[0]?.tool_parts;
  assert.equal(parts?.length, 3);
  assert.equal(parts?.[0]?.extra, undefined);
  assert.equal(parts?.[1]?.input_summary, "🌿".repeat(2048));
  assert.equal(parts?.[1]?.status, undefined);
  assert.equal(parts?.[2]?.status, "error");
  assert.equal(projected.messages[1]?.tool_parts, undefined);
  const many = projectHistoryMessagesDaemonData({ messages: [{ id: "many", role: "assistant", text: "", parts:
    Array.from({ length: 300 }, (_, i) => ({ ...call, id: `call-${i}`, input_summary: "x".repeat(2048) })) }] }) as { messages: Array<Record<string, any>> };
  assert.ok(many.messages[0]?.tool_parts?.length > 0);
  assert.ok(many.messages[0]?.tool_parts?.length <= 256);
  assert.ok(Buffer.byteLength(JSON.stringify(many.messages[0]?.tool_parts)) <= 64 * 1024);
});
