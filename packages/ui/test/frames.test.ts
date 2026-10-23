import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  AGENT_KINDS,
  keyFrame,
  parseProviderPromptServerFrame,
  providerPromptSubscriptionFrame,
  resizeFrame,
  textFrame,
} from "../src/frames.ts";

test("textFrame encodes text", () => {
  assert.deepEqual(JSON.parse(textFrame("hi")), { text: "hi" });
  assert.deepEqual(JSON.parse(textFrame("")), { text: "" });
});

test("keyFrame encodes a single key", () => {
  assert.deepEqual(JSON.parse(keyFrame("c-c")), { key: "c-c" });
  assert.deepEqual(JSON.parse(keyFrame("enter")), { key: "enter" });
});

test("resizeFrame floors and clamps to >=1", () => {
  assert.deepEqual(JSON.parse(resizeFrame(80.9, 24.9)), { resize: { cols: 80, rows: 24 } });
  assert.deepEqual(JSON.parse(resizeFrame(0, -5)), { resize: { cols: 1, rows: 1 } });
});

test("agent kinds match the daemon contract", () => {
  assert.deepEqual([...AGENT_KINDS], ["codex", "claude"]);
});

test("provider prompt subscription frame is versioned and exact", () => {
  assert.deepEqual(JSON.parse(providerPromptSubscriptionFrame()), {
    subscribe: ["provider-prompt.v1"],
  });
});

test("provider prompt server frame parser accepts only the exact capability and event contracts", () => {
  assert.deepEqual(
    parseProviderPromptServerFrame(JSON.stringify({
      schema_version: "agent-session.attach.v1",
      type: "capability",
      capability: "provider-prompt.v1",
      supported: true,
      provider: "codex",
      prompt_max_bytes: 16_384,
    })),
    {
      kind: "capability",
      supported: true,
      provider: "codex",
      promptMaxBytes: 16_384,
    },
  );
  assert.deepEqual(
    parseProviderPromptServerFrame(JSON.stringify({
      schema_version: "agent-session.attach.event.v1",
      type: "prompt_submitted",
      event_id: "pp-1",
      provider: "claude",
      submitted_at: "2026-07-10T00:00:00Z",
      text: "final prompt",
      truncated: false,
    })),
    {
      kind: "prompt_submitted",
      eventId: "pp-1",
      provider: "claude",
      submittedAt: "2026-07-10T00:00:00Z",
      text: "final prompt",
      truncated: false,
    },
  );

  assert.deepEqual(
    parseProviderPromptServerFrame(JSON.stringify({
      schema_version: "agent-session.attach.event.v2",
      type: "prompt_submitted",
      event_id: "pp-2",
      provider: "codex",
      submitted_at: "2026-07-10T00:00:00Z",
      text: "future event",
      truncated: false,
    })),
    { kind: "unknown_control" },
  );
  assert.deepEqual(
    parseProviderPromptServerFrame(JSON.stringify({
      schema_version: "agent-session.attach.event.v1",
      type: "input_rejected",
      code: "codex-account-next-pending",
      retryable: true,
    })),
    {
      kind: "input_rejected",
      code: "codex-account-next-pending",
      retryable: true,
    },
  );
  assert.deepEqual(
    parseProviderPromptServerFrame(JSON.stringify({
      schema_version: "agent-session.attach.event.v1",
      type: "input_rejected",
      code: "invalid code",
      retryable: true,
    })),
    { kind: "unknown_control" },
  );
  assert.deepEqual(
    parseProviderPromptServerFrame(JSON.stringify({
      schema_version: "agent-session.attach.event.v1",
      type: "prompt_submitted",
      event_id: "",
      provider: "codex",
      submitted_at: "2026-07-10T00:00:00Z",
      text: "",
      truncated: false,
    })),
    { kind: "unknown_control" },
  );
  assert.equal(parseProviderPromptServerFrame("terminal text"), null);
  assert.equal(parseProviderPromptServerFrame(JSON.stringify({ ordinary: "json terminal text" })), null);
  assert.equal(parseProviderPromptServerFrame(JSON.stringify({ type: "capability", message: "terminal text" })), null);
  assert.deepEqual(
    parseProviderPromptServerFrame(JSON.stringify({
      schema_version: "agent-session.attach.event.v1",
      type: "prompt_submitted",
      event_id: "pp-oversized",
      provider: "codex",
      submitted_at: "2026-07-10T00:00:00Z",
      text: "🙂".repeat(5_000),
      truncated: false,
    })),
    { kind: "unknown_control" },
  );
});
