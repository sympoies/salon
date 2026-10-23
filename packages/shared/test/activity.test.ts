import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  ActivityFeedSseDecoder,
  ActivitySseDecoder,
  normalizeActivityDeliveryEvent,
  normalizeActivityStreamEvent,
  normalizeActivityTurnState,
  serializeActivityDeliverySseEvent,
  serializeActivitySseEvent,
} from "../src/activity.ts";

const waitingState = {
  schema_version: "agent-session.turn-state.v1",
  phase: "waiting",
  phase_changed_at: "2026-07-11T12:00:00Z",
  revision: 9,
  source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
  current_turn: null,
  last_turn: {
    provider_turn_id: "turn-9",
    started_at: "2026-07-11T11:59:00Z",
    completed_at: "2026-07-11T12:00:00Z",
    outcome: "completed",
  },
};

const NILS_1120_CANONICAL_FIXTURE_SHA256 = "fbf731e97c679b19a039842bbfe5d275ce34aea81acaf3031428f69a86dc4365";

test("activity stream normalization preserves the additive v1 metadata contract", () => {
  const canonicalWaitingState = Object.fromEntries(
    Object.entries(waitingState).filter(([key]) => key !== "current_turn"),
  );
  const event = normalizeActivityStreamEvent({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "snapshot",
    stream_id: "boot-a",
    sequence: 11,
    machine: "daemon-local-name",
    observed_at: "2026-07-11T12:00:01Z",
    sessions: [{ id: "session-1", turn_state: waitingState }],
  }, "summit");

  assert.deepEqual(event, {
    schema_version: "agent-session.activity-stream.event.v1",
    type: "snapshot",
    stream_id: "boot-a",
    sequence: 11,
    machine: "summit",
    observed_at: "2026-07-11T12:00:01Z",
    sessions: [{ id: "session-1", turn_state: canonicalWaitingState }],
  });
});

test("turn-state normalization preserves bounded provider evidence metadata only", () => {
  const state = normalizeActivityTurnState({
    ...waitingState,
    phase: "needs_input",
    semantic_event: {
      kind: "progress",
      observed_at: "2026-07-11T12:00:01Z",
      provider_payload: "must-not-cross",
    },
    diagnostic: {
      reason: "completion_evidence_pending",
      detail: "must-not-cross",
    },
    shadow_observation: {
      observer_version: "terminal-shadow.v1",
      rule_id: "claude_prompt_visible",
      observed_at: "2026-07-11T12:00:02Z",
      projection: "waiting",
      disagrees: true,
      terminal: "must-not-cross",
    },
    current_turn: {
      started_at: "2026-07-11T11:59:00Z",
      attention: {
        kind: "approval",
        requested_at: "2026-07-11T11:59:30Z",
        pending_count: 1,
        certainty: "conservative",
        response: "must-not-cross",
      },
    },
    last_turn: null,
  });

  assert.ok(state);
  assert.deepEqual(state.semantic_event, {
    kind: "progress",
    observed_at: "2026-07-11T12:00:01Z",
  });
  assert.deepEqual(state.diagnostic, { reason: "completion_evidence_pending" });
  assert.deepEqual(state.shadow_observation, {
    observer_version: "terminal-shadow.v1",
    rule_id: "claude_prompt_visible",
    observed_at: "2026-07-11T12:00:02Z",
    projection: "waiting",
    disagrees: true,
  });
  assert.equal(state.current_turn?.attention?.certainty, "conservative");
  assert.doesNotMatch(JSON.stringify(state), /must-not-cross|provider_payload|"terminal":|"response":/);
});

test("turn-state normalization preserves the idle phase for Waiting classification", () => {
  const state = normalizeActivityTurnState({ ...waitingState, phase: "idle" });
  assert.equal(state?.phase, "idle");
});

test("turn-state evidence metadata drops free-form optional enums and defaults old attention conservatively", () => {
  const oldState = normalizeActivityTurnState({
    ...waitingState,
    phase: "needs_input",
    current_turn: {
      started_at: "2026-07-11T11:59:00Z",
      attention: {
        kind: "approval",
        requested_at: "2026-07-11T11:59:30Z",
        pending_count: 1,
      },
    },
    last_turn: null,
  });
  assert.equal(oldState?.current_turn?.attention?.certainty, "conservative");

  for (const extra of [
    { semantic_event: { kind: "provider said secret", observed_at: "2026-07-11T12:00:01Z" } },
    { diagnostic: { reason: "free-form internal error" } },
    {
      shadow_observation: {
        observer_version: "terminal-shadow.v1",
        rule_id: "claude_prompt_visible",
        observed_at: "2026-07-11T12:00:02Z",
        projection: "provider said secret",
        disagrees: true,
      },
    },
  ]) {
    const normalized = normalizeActivityTurnState({ ...waitingState, ...extra });
    assert.ok(normalized);
    assert.equal(normalized.semantic_event, undefined);
    assert.equal(normalized.diagnostic, undefined);
    assert.equal(normalized.shadow_observation, undefined);
  }
});

test("activity stream snapshots ignore retired orchestration metadata", () => {
  const event = normalizeActivityStreamEvent({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "snapshot",
    stream_id: "boot-orchestration",
    sequence: 1,
    machine: "ignored",
    observed_at: "2026-07-22T12:00:01Z",
    sessions: [{
      id: "main-1",
      turn_state: null,
      orchestration: {
        schema_version: "agent-session.session-orchestration.v1",
        run_id: "run-1",
        role: "main",
        relationship_revision: 4,
        run_state: "active",
        objective_summary: "Ship the bounded projection",
        worker_counts: {
          assigned: 0,
          starting: 1,
          working: 2,
          blocked: 1,
          submitted: 0,
          accepted: 3,
          cleanup_pending: 1,
          orphaned: 0,
          private_count: 99,
        },
        private_packet: { prompt: "secret" },
      },
    }],
  }, "summit");

  assert.ok(event?.type === "snapshot");
  assert.equal("orchestration" in event.sessions[0]!, false);
});

test("nils #1120 forward-compatible attention kinds preserve needs-input events", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/nils-1120-permission-attention-event.json", import.meta.url),
    "utf8",
  ));

  const event = normalizeActivityStreamEvent(fixture, "summit");

  assert.ok(event && event.type === "snapshot");
  assert.equal(event.sessions[0]?.turn_state?.phase, "needs_input");
  assert.equal(event.sessions[0]?.turn_state?.current_turn?.attention?.kind, "other");
  assert.equal(event.sessions[0]?.turn_state?.revision, 31);
});

test("nils #1120 nullable stream options preserve every session and canonicalize to omitted fields", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./fixtures/nils-1120-nullable-multi-session-event.json", import.meta.url),
    "utf8",
  ));

  const event = normalizeActivityStreamEvent(fixture, "summit");

  assert.ok(event && event.type === "snapshot");
  assert.deepEqual(event.sessions.map((session) => session.id), [
    "hs-starting",
    "hs-unknown",
    "hs-working",
    "hs-waiting",
    "hs-needs-input",
  ]);
  const stateById = (id: string) => {
    const state = event.sessions.find((session) => session.id === id)?.turn_state;
    assert.ok(state, id);
    return state;
  };
  const starting = stateById("hs-starting");
  const working = stateById("hs-working");
  const waiting = stateById("hs-waiting");
  const needsInput = stateById("hs-needs-input");
  assert.ok(working.current_turn);
  assert.ok(waiting.last_turn);
  assert.ok(needsInput.current_turn?.attention);
  assert.equal("provider" in starting.source, false);
  assert.equal("current_turn" in starting, false);
  assert.equal("last_turn" in starting, false);
  assert.equal("provider_turn_id" in working.current_turn, false);
  assert.equal("last_progress_at" in working.current_turn, false);
  assert.equal("attention" in working.current_turn, false);
  assert.equal("provider_turn_id" in waiting.last_turn, false);
  assert.equal("started_at" in waiting.last_turn, false);
  assert.equal(needsInput.current_turn.attention.kind, "other");
});

test("nils #1120 canonical producer fixture bytes decode without consumer translation", async () => {
  const bytes = await readFile(
    new URL("./fixtures/nils-1120-ff24ea72-activity-stream-v1-multi-session.json", import.meta.url),
  );
  assert.equal(createHash("sha256").update(bytes).digest("hex"), NILS_1120_CANONICAL_FIXTURE_SHA256);

  const event = normalizeActivityStreamEvent(JSON.parse(bytes.toString("utf8")), "summit");

  assert.ok(event?.type === "snapshot");
  assert.deepEqual(event.sessions.map((session) => session.id), [
    "working-minimal",
    "completed-minimal",
    "no-activity",
  ]);
  assert.equal(event.sessions[2]?.turn_state, null);
});

test("turn-state normalization treats omitted and null Rust Option fields identically", () => {
  const starting = {
    schema_version: "agent-session.turn-state.v1",
    phase: "starting",
    phase_changed_at: "2026-07-12T02:30:00Z",
    revision: 1,
    source: { kind: "runtime", confidence: "observed" },
  };
  const working = {
    ...starting,
    phase: "working",
    source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
    current_turn: { started_at: "2026-07-12T02:30:00Z" },
  };
  const waiting = {
    ...starting,
    phase: "waiting",
    source: { kind: "provider_hook", provider: "claude", confidence: "authoritative" },
    last_turn: { completed_at: "2026-07-12T02:30:00Z", outcome: "completed" },
  };
  const cases: Array<[string, unknown, unknown]> = [
    ["source.provider", starting, { ...starting, source: { ...starting.source, provider: null } }],
    ["current_turn", starting, { ...starting, current_turn: null }],
    ["last_turn", starting, { ...starting, last_turn: null }],
    ["current_turn.provider_turn_id", working, {
      ...working,
      current_turn: { ...working.current_turn, provider_turn_id: null },
    }],
    ["current_turn.last_progress_at", working, {
      ...working,
      current_turn: { ...working.current_turn, last_progress_at: null },
    }],
    ["current_turn.attention", working, {
      ...working,
      current_turn: { ...working.current_turn, attention: null },
    }],
    ["last_turn.provider_turn_id", waiting, {
      ...waiting,
      last_turn: { ...waiting.last_turn, provider_turn_id: null },
    }],
    ["last_turn.started_at", waiting, {
      ...waiting,
      last_turn: { ...waiting.last_turn, started_at: null },
    }],
  ];

  for (const [name, omitted, explicitNull] of cases) {
    const canonical = normalizeActivityTurnState(omitted);
    assert.ok(canonical, name);
    assert.deepEqual(normalizeActivityTurnState(explicitNull), canonical, name);
  }
});

test("shared turn-state normalization keeps strict timestamps and provider identifiers", () => {
  for (const phase_changed_at of ["2026-02-30T12:00:00Z", "2026-01-01T24:00:00Z"]) {
    assert.equal(normalizeActivityTurnState({ ...waitingState, phase_changed_at }), null);
  }
  assert.equal(normalizeActivityTurnState({
    ...waitingState,
    phase: "working",
    current_turn: {
      started_at: "2026-07-11T12:00:00Z",
      last_progress_at: "2026-02-30T12:00:00Z",
    },
  }), null);
  assert.equal(normalizeActivityTurnState({
    ...waitingState,
    last_turn: { ...waitingState.last_turn, started_at: "2026-01-01T24:00:00Z" },
  }), null);
  assert.equal(normalizeActivityTurnState({
    ...waitingState,
    source: { ...waitingState.source, provider: "secret prompt\n\u0007tool output" },
  }), null);
});

test("activity stream normalization strips content-forbidden and unknown fields", () => {
  const event = normalizeActivityStreamEvent({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "reset",
    stream_id: "boot-a",
    sequence: 12,
    machine: "untrusted-daemon-name",
    observed_at: "2026-07-11T12:00:02Z",
    prompt: "secret prompt",
    terminal_output: "secret output",
    sessions: [{
      id: "session-1",
      transcript_path: "/private/transcript",
      turn_state: {
        ...waitingState,
        command: "rm -rf /",
        source: { ...waitingState.source, api_key: "secret-token" },
        last_turn: { ...waitingState.last_turn, response: "private response" },
      },
    }],
  }, "mesa");

  assert.ok(event);
  assert.equal(event.machine, "mesa");
  const serialized = JSON.stringify(event);
  for (const forbidden of [
    "secret prompt",
    "secret output",
    "/private/transcript",
    "rm -rf /",
    "secret-token",
    "private response",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("activity heartbeats reject session projections while snapshots require them", () => {
  assert.ok(normalizeActivityStreamEvent({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "heartbeat",
    stream_id: "boot-a",
    sequence: 13,
    machine: "summit",
    observed_at: "2026-07-11T12:00:03Z",
  }));
  assert.equal(normalizeActivityStreamEvent({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "heartbeat",
    stream_id: "boot-a",
    sequence: 14,
    machine: "summit",
    observed_at: "2026-07-11T12:00:04Z",
    sessions: [],
  }), null);
  assert.equal(normalizeActivityStreamEvent({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "snapshot",
    stream_id: "boot-a",
    sequence: 15,
    machine: "summit",
    observed_at: "2026-07-11T12:00:05Z",
  }), null);
});

test("activity stream ids reject SSE line-breaking control characters", () => {
  for (const control of ["\r", "\n", "\0", "\u001f", "\u007f"]) {
    assert.equal(normalizeActivityStreamEvent({
      schema_version: "agent-session.activity-stream.event.v1",
      type: "heartbeat",
      stream_id: `boot-a${control}forged`,
      sequence: 16,
      machine: "summit",
      observed_at: "2026-07-11T12:00:06Z",
    }), null, JSON.stringify(control));
  }
});

test("oversized snapshot reset is the only reset allowed to omit sessions", () => {
  const base = {
    schema_version: "agent-session.activity-stream.event.v1",
    type: "reset",
    stream_id: "boot-a",
    sequence: 17,
    machine: "summit",
    observed_at: "2026-07-11T12:00:07Z",
  };

  assert.deepEqual(normalizeActivityStreamEvent({ ...base, reason: "oversized_snapshot" }), {
    ...base,
    reason: "oversized_snapshot",
  });
  assert.equal(normalizeActivityStreamEvent(base), null);
  assert.equal(normalizeActivityStreamEvent({ ...base, reason: "unknown" }), null);
  assert.equal(normalizeActivityStreamEvent({ ...base, reason: "oversized_snapshot", sessions: [] }), null);
  assert.ok(normalizeActivityStreamEvent({ ...base, sessions: [] }));
  assert.equal(normalizeActivityStreamEvent({ ...base, type: "snapshot" }), null);
});

test("fragmented near-limit SSE data lines decode with bounded overhead and preserve CRLF semantics", () => {
  const payload = JSON.stringify({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "heartbeat",
    stream_id: "large-frame",
    sequence: 18,
    machine: "summit",
    observed_at: "2026-07-11T12:00:08Z",
    additive_padding: "x".repeat(5 * 1024 * 1024),
  });
  const frame = `event: heartbeat\r\ndata: ${payload}\r\n\r\n`;
  const decode = (chunkBytes: number) => {
    const decoder = new ActivitySseDecoder();
    const started = performance.now();
    const events = [];
    for (let offset = 0; offset < frame.length; offset += chunkBytes) {
      events.push(...decoder.push(frame.slice(offset, offset + chunkBytes)));
    }
    const elapsedMs = performance.now() - started;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.stream_id, "large-frame");
    return elapsedMs;
  };

  decode(frame.length);
  const baselineMs = Math.min(decode(frame.length), decode(frame.length));
  const fragmented64KiBMs = decode(64 * 1024);
  const fragmented16KiBMs = decode(16 * 1024);
  const limitMs = Math.max(100, baselineMs * 12);
  assert.ok(
    fragmented64KiBMs <= limitMs,
    JSON.stringify({ baselineMs, fragmented64KiBMs, limitMs }),
  );
  assert.ok(
    fragmented16KiBMs <= limitMs,
    JSON.stringify({ baselineMs, fragmented16KiBMs, limitMs }),
  );
});

test("SSE decoder drops over-cap accumulation and recovers on the next frame", () => {
  const decoder = new ActivitySseDecoder();
  assert.deepEqual(decoder.push(`data: ${"x".repeat(8 * 1024 * 1024)}x`), []);
  assert.equal(decoder.push(`\n\nevent: heartbeat\ndata: ${JSON.stringify({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "heartbeat",
    stream_id: "after-cap",
    sequence: 19,
    machine: "summit",
    observed_at: "2026-07-11T12:00:09Z",
  })}\n\n`)[0]?.stream_id, "after-cap");
});

test("SSE decoder enforces the 8 MiB cap in UTF-8 bytes and recovers after multibyte input", () => {
  const decoder = new ActivitySseDecoder();
  const oversizedPayload = JSON.stringify({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "heartbeat",
    stream_id: "multibyte-over-cap",
    sequence: 20,
    machine: "summit",
    observed_at: "2026-07-11T12:00:10Z",
    additive_padding: "🦀".repeat(2_200_000),
  });
  const oversizedFrame = `event: heartbeat\ndata: ${oversizedPayload}\n\n`;
  assert.ok(oversizedFrame.length < 8 * 1024 * 1024, "the UTF-16 code-unit count stays below the cap");
  assert.ok(Buffer.byteLength(oversizedFrame, "utf8") > 8 * 1024 * 1024, "the UTF-8 byte count exceeds the cap");
  const validFrame = `event: heartbeat\ndata: ${JSON.stringify({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "heartbeat",
    stream_id: "after-multibyte-cap",
    sequence: 21,
    machine: "summit",
    observed_at: "2026-07-11T12:00:11Z",
  })}\n\n`;
  const recovered = decoder.push(oversizedFrame + validFrame);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.stream_id, "after-multibyte-cap");
});

test("SSE decoder counts a surrogate pair split across chunks as one UTF-8 scalar", () => {
  const frameWithPadding = (padding: string) => `event: heartbeat\ndata: ${JSON.stringify({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "heartbeat",
    stream_id: "split-surrogate-at-cap",
    sequence: 22,
    machine: "summit",
    observed_at: "2026-07-11T12:00:12Z",
    additive_padding: padding,
  })}\n\n`;
  const fixedFrame = frameWithPadding("🦀");
  const frame = frameWithPadding("x".repeat(8 * 1024 * 1024 - Buffer.byteLength(fixedFrame, "utf8")) + "🦀");
  assert.equal(Buffer.byteLength(frame, "utf8"), 8 * 1024 * 1024);
  const splitAt = frame.lastIndexOf("🦀") + 1;
  const decoder = new ActivitySseDecoder();

  assert.deepEqual(decoder.push(frame.slice(0, splitAt)), []);
  assert.equal(decoder.push(frame.slice(splitAt))[0]?.stream_id, "split-surrogate-at-cap");
});

test("SSE decoder accepts split frames and ignores malformed events", () => {
  const valid = normalizeActivityStreamEvent({
    schema_version: "agent-session.activity-stream.event.v1",
    type: "snapshot",
    stream_id: "boot-a",
    sequence: 1,
    machine: "summit",
    observed_at: "2026-07-11T12:00:00Z",
    sessions: [{ id: "session-1", turn_state: waitingState }],
  });
  assert.ok(valid);
  const encoded = serializeActivitySseEvent(valid);
  const decoder = new ActivitySseDecoder();
  const midpoint = Math.floor(encoded.length / 2);

  assert.deepEqual(decoder.push(encoded.slice(0, midpoint)), []);
  assert.deepEqual(decoder.push(`${encoded.slice(midpoint)}event: snapshot\ndata: not-json\n\n`), [valid]);
  assert.deepEqual(decoder.finish(), []);
});

test("delivery loss signals are metadata-only and ignored by legacy activity decoders", () => {
  const signal = normalizeActivityDeliveryEvent({
    schema_version: "agent-console.activity-delivery.event.v1",
    type: "delivery",
    machine: "summit",
    state: "reconnecting",
    observed_at: "2026-07-11T12:00:06Z",
    error: "secret upstream failure",
    sessions: [{ id: "private-session" }],
  });

  assert.deepEqual(signal, {
    schema_version: "agent-console.activity-delivery.event.v1",
    type: "delivery",
    machine: "summit",
    state: "reconnecting",
    observed_at: "2026-07-11T12:00:06Z",
  });
  const encoded = serializeActivityDeliverySseEvent(signal!);
  assert.equal(encoded.includes("secret upstream failure"), false);
  assert.equal(encoded.includes("private-session"), false);
  assert.deepEqual(new ActivitySseDecoder().push(encoded), [], "old clients safely ignore the additive signal");
  assert.deepEqual(new ActivityFeedSseDecoder().push(encoded), [signal]);
});

// #937: the daemon names a failed turn's cause only for an allowlisted kind; keep it, drop anything else.
test("last turn keeps an allowlisted provider failure kind only on a failed turn", () => {
  const lastTurn = (outcome: string, kind: unknown) => normalizeActivityTurnState({
    ...waitingState, last_turn: { ...waitingState.last_turn, outcome, provider_failure_kind: kind },
  })?.last_turn;
  assert.equal(lastTurn("failed", "authentication")?.provider_failure_kind, "authentication");
  assert.equal(lastTurn("failed", "provider_capacity")?.provider_failure_kind, "provider_capacity");
  for (const [outcome, kind] of [["failed", "usage_exhausted"], ["failed", 7], ["completed", "authentication"]] as const) {
    const turn = lastTurn(outcome, kind);
    assert.equal(turn?.outcome, outcome, `${outcome}/${kind} remains a valid last turn`);
    assert.equal(turn && "provider_failure_kind" in turn, false, `${outcome}/${kind} carries no failure kind`);
  }
});
