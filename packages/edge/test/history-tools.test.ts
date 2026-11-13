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

// Claude 2.1 parts=v1 keeps a plain tool_result in its non-human user envelope.
const claudeFixture = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/history-claude-tool-parts-v1.json", import.meta.url), "utf8"));

test("Claude user-envelope tool results survive real history HTTP and live resource snapshots", { timeout: 10_000 }, async t => {
  const daemon = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: claudeFixture }));
  });
  const { base: upstream } = await listenOnLoopback(daemon);
  const edge = createEdgeServer(makeEdgeConfig({ openAccess: true, machines: [{ name: "fixture", url: upstream }] }));
  const { base } = await listenOnLoopback(edge), controller = new AbortController();
  const verify = (snapshot: import("@agent-console/shared/resources").ConversationSnapshot | undefined) => {
    assert.ok(snapshot);
    assert.equal(snapshot.messages.length, 2, "both the call and its textless user-envelope result survive");
    const [call, result] = snapshot.messages;
    assert.equal(call?.role, "assistant");
    assert.equal(result?.role, "assistant", "non-human tool output cannot become a user reply");
    const callPart = call?.tool_parts?.[0], resultPart = result?.tool_parts?.[0];
    assert.ok(callPart?.kind === "tool_call");
    assert.ok(resultPart?.kind === "tool_result");
    assert.equal(callPart.name, "Bash");
    assert.equal(resultPart.call_id, callPart.call_id, "the shared view joins the result to its call by this identity");
    assert.equal(resultPart.summary, "tool output");
    assert.equal(resultPart.status, "ok");
    assert.equal(result?.files, undefined);
    assert.equal(result?.prompt_request, undefined);
  };
  try {
    await t.test("history HTTP", async () => {
      const response = await fetch(`${base}/api/history/sessions/fixture/claude-history/messages`);
      assert.equal(response.status, 200);
      verify((await response.json() as { data: import("@agent-console/shared/resources").ConversationSnapshot }).data);
    });
    await t.test("live resource snapshot", async () => {
      const query = new URLSearchParams({ conversations: JSON.stringify([{ machine: "fixture", id: "claude-history" }]), conversation_snapshots: "1" });
      const stream = await fetch(`${base}/api/resources/events?${query}`, { signal: controller.signal });
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader(); let bytes = "";
      while (!bytes.includes('"conversation":')) {
        const part = await reader.read(); assert.equal(part.done, false);
        bytes += new TextDecoder().decode(part.value);
      }
      const data = bytes.split("\n").find(line => line.startsWith("data:") && line.includes('"conversation":'))!;
      const { normalizeResourceEvent } = await import("@agent-console/shared/resources");
      verify(normalizeResourceEvent(JSON.parse(data.slice(5)))?.conversation);
      await reader.cancel();
    });
  } finally {
    controller.abort(); edge.closeAllConnections(); daemon.closeAllConnections();
    await Promise.all([new Promise<void>(r => edge.close(() => r())), new Promise<void>(r => daemon.close(() => r()))]);
  }
});

test("user-envelope inference preserves human text, files, images and associations and rejects oversized results", () => {
  const result = claudeFixture.messages[1].parts[0];
  const file = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/history-file-part-v1.json", import.meta.url), "utf8"));
  const binding = { request_id: "request-a", session_id: "session-a", session_incarnation: "inc-a" };
  const projected = projectHistoryMessagesDaemonData({ messages: [
    { id: "human", role: "user", text: "Human request", parts: [file, result], prompt_request: binding },
    { id: "image", role: "user", text: "", images: [{ id: `${"a".repeat(16)}.0.0.${"b".repeat(32)}`, origin: "user_attachment" }], parts: [result] },
    { id: "oversized", role: "user", text: "", parts: [{ ...result, summary: "x".repeat(2049) }] },
  ] }) as { messages: Array<Record<string, any>> };
  assert.equal(projected.messages.length, 2);
  assert.equal(projected.messages[0]?.role, "user");
  assert.equal(projected.messages[0]?.text, "Human request");
  assert.equal(projected.messages[0]?.files?.[0]?.original_name, "notes.txt");
  assert.equal(projected.messages[0]?.prompt_request?.request_id, "request-a");
  assert.equal(projected.messages[0]?.tool_parts, undefined);
  assert.equal(projected.messages[1]?.role, "user");
  assert.equal(projected.messages[1]?.images?.length, 1);
  assert.equal(projected.messages[1]?.tool_parts, undefined);
});
