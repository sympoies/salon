import { strict as assert } from "node:assert";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import {
  applyActivityStreamEvent,
  activityDeliveryAfterConnection,
  activityDeliveryAfterEvent,
  activityDeliveryAfterFeedEvent,
  createActivityReconcileGeneration,
  createActivityDeliveryState,
  createActivityStreamCursorState,
  runActivityStream,
} from "../src/activityStream.ts";
import { makeSession } from "./support/fixtures.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function event(
  machine: string,
  streamId: string,
  sequence: number,
  type: "snapshot" | "heartbeat" | "reset" = "snapshot",
) {
  return {
    schema_version: "agent-session.activity-stream.event.v1" as const,
    type,
    stream_id: streamId,
    sequence,
    machine,
    observed_at: `2026-07-11T12:00:${sequence.toString().padStart(2, "0")}Z`,
    ...(type === "heartbeat" ? {} : {
      sessions: [{
        id: "session-1",
        turn_state: {
          schema_version: "agent-session.turn-state.v1",
          phase: sequence % 2 === 0 ? "waiting" : "working",
          phase_changed_at: "2026-07-11T12:00:00Z",
          revision: sequence,
          source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
          current_turn: sequence % 2 === 0 ? null : { started_at: "2026-07-11T12:00:00Z" },
          last_turn: sequence % 2 === 0
            ? { completed_at: "2026-07-11T12:00:00Z", outcome: "completed" }
            : null,
        },
      }],
    }),
  };
}

test("stream snapshots update existing session activity without duplicating session records", () => {
  const current = [makeSession({ id: "session-1", machine: "summit" })];
  const result = applyActivityStreamEvent({
    cursors: createActivityStreamCursorState(),
    enabledMachines: ["summit"],
    sessions: current,
    event: event("summit", "boot-a", 2),
    receivedMonotonicMs: 5_000,
  });

  assert.equal(result.decision, "applied");
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.turn_state?.phase, "waiting");
  assert.equal(result.needsReconcile, false);
});

test("duplicate and out-of-order stream events are ignored", () => {
  const current = [makeSession({ id: "session-1", machine: "summit" })];
  const first = applyActivityStreamEvent({
    cursors: createActivityStreamCursorState(),
    enabledMachines: ["summit"],
    sessions: current,
    event: event("summit", "boot-a", 2),
    receivedMonotonicMs: 5_000,
  });
  for (const sequence of [2, 1]) {
    const duplicate = applyActivityStreamEvent({
      cursors: first.cursors,
      enabledMachines: ["summit"],
      sessions: first.sessions,
      event: event("summit", "boot-a", sequence),
      receivedMonotonicMs: 6_000,
    });
    assert.equal(duplicate.decision, "duplicate");
    assert.equal(duplicate.sessions, first.sessions);
    assert.equal(duplicate.needsReconcile, false);
  }
});

test("authoritative same and lower sequence resets reconcile and safely rebase the cursor", () => {
  const current = [makeSession({ id: "session-1", machine: "summit" })];
  const first = applyActivityStreamEvent({
    cursors: createActivityStreamCursorState(),
    enabledMachines: ["summit"],
    sessions: current,
    event: event("summit", "boot-a", 5),
    receivedMonotonicMs: 5_000,
  });

  for (const resetSequence of [5, 2]) {
    const reset = applyActivityStreamEvent({
      cursors: first.cursors,
      enabledMachines: ["summit"],
      sessions: first.sessions,
      event: event("summit", "boot-a", resetSequence, "reset"),
      receivedMonotonicMs: 6_000,
    });
    assert.equal(reset.decision, "applied", `reset sequence ${resetSequence}`);
    assert.equal(reset.needsReconcile, true, `reset sequence ${resetSequence}`);
    assert.deepEqual(
      reset.cursors.get("summit"),
      { streamId: "boot-a", sequence: resetSequence },
      `reset sequence ${resetSequence}`,
    );
    assert.equal(
      reset.sessions[0]?.turn_state?.revision,
      resetSequence,
      "a reset projection is authoritative even when its revision rebases lower",
    );

    const next = applyActivityStreamEvent({
      cursors: reset.cursors,
      enabledMachines: ["summit"],
      sessions: reset.sessions,
      event: event("summit", "boot-a", resetSequence + 1),
      receivedMonotonicMs: 7_000,
    });
    assert.equal(next.decision, "applied", `post-reset sequence ${resetSequence + 1}`);
    assert.deepEqual(next.cursors.get("summit"), {
      streamId: "boot-a",
      sequence: resetSequence + 1,
    });
  }
});

test("event gaps, resets, stream replacement, and unknown sessions request immediate polling reconciliation", () => {
  const current = [makeSession({ id: "session-1", machine: "summit" })];
  const first = applyActivityStreamEvent({
    cursors: createActivityStreamCursorState(),
    enabledMachines: ["summit"],
    sessions: current,
    event: event("summit", "boot-a", 1),
    receivedMonotonicMs: 1_000,
  });

  for (const next of [
    event("summit", "boot-a", 3),
    event("summit", "boot-a", 2, "reset"),
    event("summit", "boot-b", 1),
    {
      ...event("summit", "boot-a", 2),
      sessions: [{ id: "not-in-the-poll-yet", turn_state: null }],
    },
  ]) {
    const result = applyActivityStreamEvent({
      cursors: first.cursors,
      enabledMachines: ["summit"],
      sessions: first.sessions,
      event: next,
      receivedMonotonicMs: 2_000,
    });
    assert.equal(result.needsReconcile, true);
  }
});

test("disabled machine events are ignored and heartbeats only advance observation freshness", () => {
  const current = [makeSession({ id: "session-1", machine: "summit" })];
  const cursors = createActivityStreamCursorState();
  const disabled = applyActivityStreamEvent({
    cursors,
    enabledMachines: ["summit"],
    sessions: current,
    event: event("mesa", "boot-mesa", 1),
    receivedMonotonicMs: 2_000,
  });
  assert.equal(disabled.decision, "disabled");
  assert.equal(disabled.sessions, current);

  const heartbeat = applyActivityStreamEvent({
    cursors,
    enabledMachines: ["summit"],
    sessions: current,
    event: event("summit", "boot-a", 1, "heartbeat"),
    receivedMonotonicMs: 3_000,
  });
  assert.equal(heartbeat.decision, "applied");
  assert.equal(heartbeat.sessions.length, 1);
  assert.equal(heartbeat.sessions[0]?.turn_state, current[0]?.turn_state);
  assert.equal(heartbeat.needsReconcile, true, "a heartbeat without an initial snapshot has no convergence baseline");
});

test("a full projection can clear stale cached activity without removing the session", () => {
  const current = [makeSession({
    id: "session-1",
    machine: "summit",
    turn_state: event("summit", "boot-a", 2).sessions?.[0]?.turn_state,
  })];
  const result = applyActivityStreamEvent({
    cursors: createActivityStreamCursorState(),
    enabledMachines: ["summit"],
    sessions: current,
    event: { ...event("summit", "boot-a", 3), sessions: [{ id: "session-1", turn_state: null }] },
    receivedMonotonicMs: 4_000,
  });

  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.turn_state, null);
  assert.equal(result.needsReconcile, false);
});

test("streaming fetch reconnects with bounded state changes and replays no duplicate client updates", async () => {
  const states: string[] = [];
  const received: number[] = [];
  const controller = new AbortController();
  let attempts = 0;
  const fetchImpl = async (_path: string, init?: RequestInit): Promise<Response> => {
    attempts += 1;
    assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
    if (attempts === 1) throw new Error("temporary disconnect");
    const payload = event("summit", "boot-a", 1);
    return new Response(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  };

  await runActivityStream({
    machines: ["summit"],
    signal: controller.signal,
    fetchImpl,
    onState: (state) => states.push(state),
    onEvent: (value) => {
      received.push(value.sequence);
      controller.abort();
    },
    sleep: async () => {},
  });

  assert.equal(attempts, 2);
  assert.deepEqual(states, ["connecting", "reconnecting", "connected"]);
  assert.deepEqual(received, [1]);
});

test("delivery capability stays per machine across mixed old/new daemons and reconnects", () => {
  const initial = createActivityDeliveryState(["summit", "mesa"]);
  assert.equal(initial.get("summit"), "polling");
  assert.equal(initial.get("mesa"), "polling");

  const streamed = activityDeliveryAfterEvent(initial, "summit");
  assert.equal(streamed.get("summit"), "realtime");
  assert.equal(streamed.get("mesa"), "polling", "an old daemon is not promoted by another machine's event");

  const reconnecting = activityDeliveryAfterConnection(streamed, "reconnecting");
  assert.equal(reconnecting.get("summit"), "reconnecting");
  assert.equal(reconnecting.get("mesa"), "polling");

  const recovered = activityDeliveryAfterEvent(reconnecting, "summit");
  assert.equal(recovered.get("summit"), "realtime");
  assert.equal(recovered.get("mesa"), "polling");
});

test("one upstream loss demotes only that machine until its next daemon event", () => {
  const initial = createActivityDeliveryState(["summit", "mesa"]);
  const bothRealtime = activityDeliveryAfterFeedEvent(
    activityDeliveryAfterFeedEvent(initial, event("summit", "boot-a", 1)),
    event("mesa", "boot-b", 1, "heartbeat"),
  );
  const exampleOrgLost = activityDeliveryAfterFeedEvent(bothRealtime, {
    schema_version: "agent-console.activity-delivery.event.v1",
    type: "delivery",
    machine: "summit",
    state: "reconnecting",
    observed_at: "2026-07-11T12:00:02Z",
  });

  assert.equal(exampleOrgLost.get("summit"), "reconnecting");
  assert.equal(exampleOrgLost.get("mesa"), "realtime");

  const otherHostStillLive = activityDeliveryAfterFeedEvent(exampleOrgLost, event("mesa", "boot-b", 2, "heartbeat"));
  assert.equal(otherHostStillLive.get("summit"), "reconnecting", "another machine cannot recover the lost upstream");
  assert.equal(otherHostStillLive.get("mesa"), "realtime");

  const exampleOrgRecovered = activityDeliveryAfterFeedEvent(otherHostStillLive, event("summit", "boot-a", 2, "heartbeat"));
  assert.equal(exampleOrgRecovered.get("summit"), "realtime");
  assert.equal(exampleOrgRecovered.get("mesa"), "realtime");
});

test("oversized snapshot reset preserves sessions and requests immediate reconciliation", () => {
  const sessions = [makeSession({ id: "session-1", machine: "summit" })];
  const result = applyActivityStreamEvent({
    cursors: createActivityStreamCursorState(),
    enabledMachines: ["summit"],
    sessions,
    event: {
      schema_version: "agent-session.activity-stream.event.v1",
      type: "reset",
      stream_id: "boot-a",
      sequence: 4,
      machine: "summit",
      observed_at: "2026-07-11T12:00:04Z",
      reason: "oversized_snapshot",
    },
    receivedMonotonicMs: 4_000,
  });

  assert.equal(result.decision, "applied");
  assert.equal(result.sessions, sessions);
  assert.equal(result.needsReconcile, true);
  assert.deepEqual(result.cursors.get("summit"), { streamId: "boot-a", sequence: 4 });
});

test("rejected activity feed responses cancel never-ending bodies before retry", async () => {
  for (const scenario of [
    { name: "unsupported 404", status: 404, contentType: "text/plain", attempts: 4 },
    { name: "non-ok 500", status: 500, contentType: "text/event-stream", attempts: 20 },
    { name: "non-SSE 200", status: 200, contentType: "text/plain", attempts: 4 },
  ]) {
    const controller = new AbortController();
    let attempts = 0;
    let activeBodies = 0;
    let peakActiveBodies = 0;
    let canceledBodies = 0;
    const fetchImpl = async (): Promise<Response> => {
      attempts += 1;
      const body = new ReadableStream<Uint8Array>({
        start() {
          activeBodies += 1;
          peakActiveBodies = Math.max(peakActiveBodies, activeBodies);
        },
        cancel() {
          activeBodies -= 1;
          canceledBodies += 1;
        },
      });
      return new Response(body, {
        status: scenario.status,
        headers: { "content-type": scenario.contentType },
      });
    };

    await runActivityStream({
      machines: ["summit"],
      signal: controller.signal,
      fetchImpl,
      onState: () => {},
      onEvent: () => {},
      sleep: async () => {
        if (attempts >= scenario.attempts) controller.abort();
      },
    });

    assert.equal(attempts, scenario.attempts, scenario.name);
    assert.equal(canceledBodies, attempts, scenario.name);
    assert.equal(activeBodies, 0, scenario.name);
    assert.equal(peakActiveBodies, 1, scenario.name);
  }
});

test("many reconnect attempts use distinct abort signals without parent listener or body growth", async () => {
  const controller = new AbortController();
  const attemptSignals: AbortSignal[] = [];
  const parentListenerCounts: number[] = [];
  let activeBodies = 0;
  let canceledBodies = 0;
  const attempts = 32;
  const fetchImpl = async (_path: string, init?: RequestInit): Promise<Response> => {
    assert.ok(init?.signal);
    attemptSignals.push(init.signal);
    parentListenerCounts.push(getEventListeners(controller.signal, "abort").length);
    const body = new ReadableStream<Uint8Array>({
      start() {
        activeBodies += 1;
      },
      cancel() {
        activeBodies -= 1;
        canceledBodies += 1;
      },
    });
    return new Response(body, {
      status: 500,
      headers: { "content-type": "text/event-stream" },
    });
  };

  await runActivityStream({
    machines: ["summit"],
    signal: controller.signal,
    fetchImpl,
    onState: () => {},
    onEvent: () => {},
    sleep: async () => {
      if (attemptSignals.length >= attempts) controller.abort();
    },
  });

  assert.equal(attemptSignals.length, attempts);
  assert.equal(new Set(attemptSignals).size, attempts, "each retry owns a fresh abort signal");
  assert.equal(parentListenerCounts.every((count) => count === 1), true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(canceledBodies, attempts);
  assert.equal(activeBodies, 0);
});

test("cancelled activity reconciliation cannot apply or clear a replacement generation", async () => {
  const oldGate = deferred();
  const newGate = deferred();
  const applied: string[] = [];
  let newRuns = 0;
  const oldController = new AbortController();
  const newController = new AbortController();
  const oldGeneration = createActivityReconcileGeneration(oldController.signal, async (signal) => {
    await oldGate.promise;
    if (!signal.aborted) applied.push("old");
  });
  const newGeneration = createActivityReconcileGeneration(newController.signal, async (signal) => {
    newRuns += 1;
    await newGate.promise;
    if (!signal.aborted) applied.push("new");
  });

  oldGeneration.reconcile();
  oldController.abort();
  newGeneration.reconcile();
  oldGate.resolve();
  await oldGate.promise;
  await Promise.resolve();
  newGeneration.reconcile();

  assert.deepEqual(applied, []);
  assert.equal(newRuns, 1, "the old finally cannot clear the new generation's pending reconciliation");

  newGate.resolve();
  await newGate.promise;
  await Promise.resolve();
  assert.deepEqual(applied, ["new"]);
});

test("activity reconciliation coalesces calls during a pending poll into one trailing run", async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  const controller = new AbortController();
  let runs = 0;
  const generation = createActivityReconcileGeneration(controller.signal, async () => {
    runs += 1;
    await (runs === 1 ? firstGate.promise : secondGate.promise);
  });

  generation.reconcile();
  await Promise.resolve();
  assert.equal(runs, 1);
  generation.reconcile();
  generation.reconcile();
  generation.reconcile();

  firstGate.resolve();
  await firstGate.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runs, 2, "one trailing reconciliation runs after the pending poll settles");

  secondGate.resolve();
  await secondGate.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runs, 2, "the dirty calls are coalesced into exactly one trailing run");
});
