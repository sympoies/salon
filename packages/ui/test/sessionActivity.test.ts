import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildSessionActivityDetails,
  completionAcknowledgementKey,
  formatActivityHeaderText,
  formatActivityDuration,
  formatElapsedDuration,
  WORKING_ATTENTION_PROGRESS_FRESH_MS,
  STARTING_PHASE_FRESH_MS,
  selectSessionActivity,
} from "../src/sessionActivity.ts";
import { makeSession } from "./support/fixtures.ts";
import { DASHBOARD_UNAVAILABLE_SINCE, type DashboardSession } from "../src/types.ts";
import { withDashboardActivityObservation } from "../src/dashboardSessions.ts";

const now = Date.parse("2026-07-10T12:10:00Z");

// A provider with no hook integration reports `starting` and never advances it,
// because only a provider event moves the phase on. Bound it so such a session
// reads as its terminal heartbeat instead of an endless "Connecting…".
function startingStateChangedMsAgo(elapsedMs: number, semanticEventMsAgo?: number) {
  return {
    schema_version: "agent-session.turn-state.v1" as const,
    phase: "starting" as const,
    phase_changed_at: new Date(now - elapsedMs).toISOString(),
    revision: 1,
    source: { kind: "runtime" as const, confidence: "authoritative" as const },
    ...(semanticEventMsAgo === undefined
      ? {}
      : {
        semantic_event: {
          kind: "turn_started" as const,
          observed_at: new Date(now - semanticEventMsAgo).toISOString(),
        },
      }),
  };
}

function providerState(phase: "starting" | "working" | "waiting" | "needs_input" | "unknown") {
  return {
    schema_version: "agent-session.turn-state.v1" as const,
    phase,
    phase_changed_at: "2026-07-10T12:08:00Z",
    revision: 7,
    source: { kind: "provider_hook" as const, provider: "codex", confidence: "observed" as const },
    current_turn: {
      provider_turn_id: "opaque-turn",
      started_at: "2026-07-10T12:07:46Z",
      attention:
        phase === "needs_input"
          ? {
              kind: "approval" as const,
              requested_at: "2026-07-10T12:09:18Z",
              pending_count: 2,
              certainty: "exact" as const,
            }
          : undefined,
    },
    last_turn: {
      provider_turn_id: "opaque-previous",
      started_at: "2026-07-10T12:01:00Z",
      completed_at: "2026-07-10T12:05:00Z",
      outcome: "completed" as const,
    },
  };
}

test("idle turn state uses waiting completion and acknowledgement behavior", () => {
  const session = makeSession({ turn_state: { ...providerState("waiting"), phase: "idle" } });
  const activity = selectSessionActivity({ session, machineReachable: true, focused: false, nowMs: now });
  assert.equal(activity.kind, "completed");
  assert.ok(completionAcknowledgementKey(session));
});

test("selectSessionActivity maps provider phases to semantic timers", () => {
  const working = selectSessionActivity({
    session: makeSession({ turn_state: providerState("working") }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(working.kind, "working");
  assert.equal(working.primaryText, "Working 2m");
  assert.equal(working.timerStartedAt, "2026-07-10T12:08:00Z");

  const waiting = selectSessionActivity({
    session: makeSession({
      turn_state: {
        ...providerState("waiting"),
        last_turn: { completed_at: "2026-07-10T12:05:00Z", outcome: "completed" },
      },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(waiting.kind, "completed");
  assert.equal(waiting.primaryText, "Done 5m");
  assert.equal(waiting.ripple, false);

  const attention = selectSessionActivity({
    session: makeSession({ turn_state: providerState("needs_input") }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(attention.kind, "needs-input");
  assert.equal(attention.primaryText, "Needs input 42s");
  assert.equal(attention.attentionKind, "approval");
  assert.equal(attention.pendingCount, 2);
});

test("continuous Working age survives several new turns for every provider harness", () => {
  for (const agent of ["codex", "claude", "other-provider"]) {
    for (const turnAgeSeconds of [180, 90, 53]) {
      const session = makeSession({ agent, turn_state: {
        ...providerState("working"),
        phase_changed_at: "2026-07-10T11:27:00Z",
        revision: turnAgeSeconds,
        semantic_event: { kind: "turn_started", observed_at: new Date(now - turnAgeSeconds * 1000).toISOString() },
        current_turn: { provider_turn_id: `turn-${turnAgeSeconds}`, started_at: new Date(now - turnAgeSeconds * 1000).toISOString() },
      } });
      const input = { session, machineReachable: true, focused: false, nowMs: now };
      const effective = selectSessionActivity(input);
      assert.equal(effective.primaryText, "Working 43m");
      assert.equal(effective.timerStartedAt, "2026-07-10T11:27:00Z");
      assert.equal(formatActivityHeaderText(effective, now), "43m");
      const rows = new Map(buildSessionActivityDetails({ ...input, effective }).flatMap(group => group.rows.map(row => [row.label, row.value])));
      assert.equal(rows.get("Current state"), "Working 43m");
      assert.ok(rows.get("Current turn")?.endsWith(`${formatElapsedDuration(turnAgeSeconds * 1000)} ago`));
    }
  }
});

test("provider evidence age is distinct from fresh delivery and never invents idle", () => {
  const session = withDashboardActivityObservation(
    makeSession({
      turn_state: {
        ...providerState("working"),
        semantic_event: {
          kind: "progress",
          observed_at: "2026-07-10T12:00:00Z",
        },
        diagnostic: { reason: "completion_evidence_pending" },
        shadow_observation: {
          observer_version: "terminal-shadow.v1",
          rule_id: "codex_prompt_visible",
          observed_at: "2026-07-10T12:09:30Z",
          projection: "waiting",
          disagrees: true,
        },
      },
    }),
    {
      daemonObservedAt: "2026-07-10T12:10:00Z",
      receivedMonotonicMs: 1_000,
      transport: "stream",
    },
  );
  const input = {
    session,
    machineReachable: true,
    focused: false,
    nowMs: now,
    monotonicNowMs: 2_000,
    activityDeliveryState: "realtime" as const,
  };
  const effective = selectSessionActivity(input);
  const rows = new Map(buildSessionActivityDetails({ ...input, effective })
    .flatMap((group) => group.rows.map((row) => [row.label, row.value] as const)));

  assert.equal(effective.kind, "working-uncertain");
  assert.equal(effective.primaryText, "Working · evidence old 2m 1s");
  assert.equal(formatActivityHeaderText(effective, now), "2m");
  assert.equal(rows.get("Last provider event"), "Progress · 10m 1s ago");
  assert.equal(rows.get("Delivery"), "Realtime connected");
  assert.equal(rows.get("Diagnostic"), "Completion Evidence Pending");
  assert.equal(rows.get("Shadow observer"), "Waiting · Codex Prompt Visible · Disagrees");
});

test("provider evidence age falls back to phase_changed_at for older daemons", () => {
  const exactBoundary = selectSessionActivity({
    session: makeSession({
      turn_state: {
        ...providerState("working"),
        phase_changed_at: "2026-07-10T12:05:00Z",
        semantic_event: undefined,
      },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  const justFresh = selectSessionActivity({
    session: makeSession({
      turn_state: {
        ...providerState("working"),
        phase_changed_at: "2026-07-10T12:05:00.001Z",
        semantic_event: undefined,
      },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });

  assert.equal(exactBoundary.kind, "working-uncertain");
  assert.equal(justFresh.kind, "working");
});

test("attention certainty and the shared progress lease prevent indefinite definite prompts", () => {
  const base = providerState("needs_input");
  const conservative = {
    ...base,
    semantic_event: { kind: "progress", observed_at: "2026-07-10T12:05:00Z" },
    current_turn: {
      ...base.current_turn,
      last_progress_at: "2026-07-10T12:05:00Z",
      attention: {
        ...base.current_turn.attention,
        requested_at: "2026-07-10T12:04:00Z",
        certainty: "conservative",
      },
    },
  };
  const uncertain = selectSessionActivity({
    session: makeSession({ turn_state: conservative }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(uncertain.kind, "attention-unconfirmed");
  assert.equal(uncertain.primaryText, "Input may be needed 6m");

  const exact = selectSessionActivity({
    session: makeSession({
      turn_state: {
        ...conservative,
        current_turn: {
          ...conservative.current_turn,
          attention: { ...conservative.current_turn.attention, certainty: "exact" },
        },
      },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(exact.kind, "needs-input");
  assert.equal(exact.primaryText, "Needs input 6m");
});

test("terminal fallback labels provenance instead of implying provider idleness", () => {
  const active = selectSessionActivity({
    session: makeSession({ last_terminal_activity_at: "2026-07-10T12:09:52Z" }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(active.primaryText, "Terminal active 8s");

  const quiet = selectSessionActivity({
    session: makeSession({ last_terminal_activity_at: "2026-07-10T12:05:00Z" }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(quiet.primaryText, "Terminal quiet 5m");
});

test("Done is scoped to an unacknowledged completion identity", () => {
  const session = makeSession({
    machine: "summit",
    id: "session-1",
    session_incarnation: "incarnation-a",
    turn_state: {
      ...providerState("waiting"),
      revision: 12,
      last_turn: { completed_at: "2026-07-10T12:05:00Z", outcome: "completed" },
    },
  });
  const completionKey = completionAcknowledgementKey(session);
  assert.ok(completionKey);

  const unacknowledged = selectSessionActivity({
    session,
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(unacknowledged.kind, "completed");
  assert.equal(unacknowledged.primaryText, "Done 5m");

  const acknowledged = selectSessionActivity({
    session,
    machineReachable: true,
    focused: false,
    nowMs: now,
    acknowledgedCompletionKey: completionKey,
  });
  assert.equal(acknowledged.kind, "waiting");
  assert.equal(acknowledged.primaryText, "Waiting 5m");

  const unrelatedRevision = selectSessionActivity({
    session: {
      ...session,
      turn_state: { ...session.turn_state, revision: 13 },
    },
    machineReachable: true,
    focused: false,
    nowMs: now,
    acknowledgedCompletionKey: completionKey,
  });
  assert.equal(unrelatedRevision.kind, "waiting");
  assert.equal(unrelatedRevision.primaryText, "Waiting 5m");

  const later = selectSessionActivity({
    session: {
      ...session,
      turn_state: {
        ...session.turn_state,
        revision: 14,
        last_turn: { completed_at: "2026-07-10T12:09:30Z", outcome: "completed" },
      },
    },
    machineReachable: true,
    focused: false,
    nowMs: now,
    acknowledgedCompletionKey: completionKey,
  });
  assert.equal(later.kind, "completed");
  assert.equal(later.primaryText, "Done 30s");
});

test("completed activity uses a bounded halo while non-success outcomes remain waiting", () => {
  const recent = selectSessionActivity({
    session: makeSession({
      turn_state: {
        ...providerState("waiting"),
        last_turn: { completed_at: "2026-07-10T12:09:50Z", outcome: "completed" },
      },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(recent.kind, "completed");
  assert.equal(recent.primaryText, "Done 10s");
  assert.equal(recent.ripple, true);

  const settled = selectSessionActivity({
    session: makeSession({
      turn_state: {
        ...providerState("waiting"),
        last_turn: { completed_at: "2026-07-10T12:09:50Z", outcome: "completed" },
      },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now + 20_000,
  });
  assert.equal(settled.primaryText, "Done 30s");
  assert.equal(settled.ripple, false);

  for (const outcome of ["interrupted", "failed", "unknown"] as const) {
    const waiting = selectSessionActivity({
      session: makeSession({
        turn_state: {
          ...providerState("waiting"),
          last_turn: { completed_at: "2026-07-10T12:05:00Z", outcome },
        },
      }),
      machineReachable: true,
      focused: false,
      nowMs: now,
    });
    assert.equal(waiting.kind, "waiting", outcome);
    // #937: a failed last turn is not plain waiting.
    assert.equal(waiting.primaryText, outcome === "failed" ? "Failed 5m" : "Waiting 5m", outcome);
    assert.equal(waiting.ripple, false, outcome);
  }
  for (const [kind, label] of [["authentication", "Failed (sign-in required) 5m"], ["provider_capacity", "Failed (provider at capacity) 5m"]] as const) {
    const failed = selectSessionActivity({
      session: makeSession({
        turn_state: {
          ...providerState("waiting"),
          last_turn: { completed_at: "2026-07-10T12:05:00Z", outcome: "failed", provider_failure_kind: kind },
        },
      }),
      machineReachable: true,
      focused: false,
      nowMs: now,
    });
    assert.equal(failed.primaryText, label, kind);
  }
});

test("daemon observation plus monotonic elapsed makes phase age immune to browser wall-clock shifts", () => {
  const session = withDashboardActivityObservation(
    makeSession({
      turn_state: {
        ...providerState("waiting"),
        last_turn: { completed_at: "2026-07-10T12:05:00Z", outcome: "completed" },
      },
    }),
    {
      daemonObservedAt: "2026-07-10T12:10:00Z",
      receivedMonotonicMs: 1_000,
      transport: "stream",
    },
  );

  for (const shiftedWallNow of [
    Date.parse("2026-07-10T12:15:05Z"),
    Date.parse("2026-07-10T12:05:05Z"),
  ]) {
    const activity = selectSessionActivity({
      session,
      machineReachable: true,
      focused: false,
      nowMs: shiftedWallNow,
      monotonicNowMs: 6_000,
    });
    assert.equal(activity.primaryText, "Done 5m 5s");
    assert.equal(activity.observationStale, false);
    assert.equal(activity.observationTransport, "stream");
  }
});

test("activity details expose freshness, delivery, source, and confidence accessibly", () => {
  const session = withDashboardActivityObservation(
    makeSession({ turn_state: providerState("working") }),
    {
      daemonObservedAt: "2026-07-10T12:10:00Z",
      receivedMonotonicMs: 1_000,
      transport: "poll",
    },
  );
  const input = {
    session,
    machineReachable: true,
    focused: false,
    nowMs: Date.parse("2026-07-10T12:20:00Z"),
    monotonicNowMs: 41_000,
    activityDeliveryState: "reconnecting" as const,
  };
  const effective = selectSessionActivity(input);
  const details = buildSessionActivityDetails({ ...input, effective });
  const rows = new Map(details.flatMap((group) => group.rows.map((row) => [row.label, row.value] as const)));

  assert.equal(effective.observationStale, true);
  assert.equal(rows.get("Last synced"), "40s ago · Poll");
  assert.equal(rows.get("Freshness"), "Stale");
  assert.equal(rows.get("Delivery"), "Poll fallback · realtime reconnecting");
  assert.equal(rows.get("Confidence"), "Observed");
  assert.equal(rows.get("Source"), "Codex · Provider Hook");
});

test("activity delivery detail is session-scoped for mixed old and new daemons", () => {
  const oldDaemon = makeSession({ machine: "mesa", turn_state: providerState("waiting") });
  const streamingDaemon = makeSession({ machine: "summit", turn_state: providerState("waiting") });
  const detailsFor = (session: DashboardSession, activityDeliveryState: "polling" | "realtime") => {
    const input = {
      session,
      machineReachable: true,
      focused: false,
      nowMs: now,
      activityDeliveryState,
    } as const;
    const effective = selectSessionActivity(input);
    return new Map(buildSessionActivityDetails({ ...input, effective })
      .flatMap((group) => group.rows.map((row) => [row.label, row.value] as const)));
  };

  assert.equal(detailsFor(oldDaemon, "polling").get("Delivery"), "Polling only");
  assert.equal(detailsFor(streamingDaemon, "realtime").get("Delivery"), "Realtime connected");
});

test("mixed activity requires safe progress later than pending attention", () => {
  const mixedState = {
    ...providerState("needs_input"),
    current_turn: {
      ...providerState("needs_input").current_turn,
      last_progress_at: "2026-07-10T12:09:30Z",
    },
  };
  const original = structuredClone(mixedState);
  const mixed = selectSessionActivity({
    session: makeSession({ turn_state: mixedState, last_terminal_activity_at: "2026-07-10T12:09:55Z" }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(mixed.kind, "working-attention");
  assert.equal(mixed.primaryText, "Working 2m 14s");
  assert.equal(mixed.attentionText, "Input requested 42s");
  assert.equal(mixed.ariaText, "Working 2m 14s; input requested 42s; 2 pending");
  assert.equal(mixed.timerStartedAt, "2026-07-10T12:07:46Z");
  assert.equal(mixed.attentionTimerStartedAt, "2026-07-10T12:09:18Z");
  assert.equal(mixed.ripple, true, "mixed state preserves the bounded terminal activity ripple");
  assert.deepEqual(mixedState, original, "the presentation selector must stay pure");

  const reloaded = selectSessionActivity({
    session: makeSession({ turn_state: structuredClone(mixedState) }),
    machineReachable: true,
    focused: false,
    nowMs: now + 30_000,
  });
  assert.equal(reloaded.kind, "working-attention");
  assert.equal(reloaded.primaryText, "Working 2m 44s");
  assert.equal(reloaded.attentionText, "Input requested 1m 12s");

  for (const [requested_at, last_progress_at] of [
    ["2026-07-10T12:09:18.123000000Z", "2026-07-10T12:09:18.123456789Z"],
    ["2026-07-10T14:09:18.123000000+02:00", "2026-07-10T07:09:18.123456789-05:00"],
  ]) {
    const precise = selectSessionActivity({
      session: makeSession({
        turn_state: {
          ...mixedState,
          current_turn: {
            ...mixedState.current_turn,
            last_progress_at,
            attention: { kind: "clarification", requested_at, pending_count: 1, certainty: "exact" },
          },
        },
      }),
      machineReachable: true,
      focused: false,
      nowMs: now,
    });
    assert.equal(precise.kind, "working-attention", "sub-millisecond provider ordering must be preserved");
  }

  for (const last_progress_at of [
    "2026-07-10T12:09:18.122999999Z",
    "2026-07-10T12:09:18.123000000Z",
  ]) {
    const notLater = selectSessionActivity({
      session: makeSession({
        turn_state: {
          ...mixedState,
          current_turn: {
            ...mixedState.current_turn,
            last_progress_at,
            attention: {
              kind: "clarification",
              requested_at: "2026-07-10T12:09:18.123000000Z",
              pending_count: 1,
              certainty: "exact",
            },
          },
        },
      }),
      machineReachable: true,
      focused: false,
      nowMs: now,
    });
    assert.equal(notLater.kind, "needs-input", "equal or earlier sub-millisecond progress stays conservative");
  }

  for (const last_progress_at of [
    undefined,
    "2026-07-10T12:09:17Z",
    "2026-07-10T12:09:18Z",
    "2026-07-10T12:10:01Z",
  ]) {
    const conservative = selectSessionActivity({
      session: makeSession({
        turn_state: {
          ...providerState("needs_input"),
          current_turn: {
            ...providerState("needs_input").current_turn,
            last_progress_at,
          },
        },
      }),
      machineReachable: true,
      focused: false,
      nowMs: now,
    });
    assert.equal(conservative.kind, "needs-input");
    assert.equal(conservative.attentionText, undefined);
  }

  const cleared = selectSessionActivity({
    session: makeSession({
      turn_state: {
        ...providerState("working"),
        current_turn: {
          ...providerState("working").current_turn,
          last_progress_at: "2026-07-10T12:09:31Z",
        },
      },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(cleared.kind, "working");
  assert.equal(cleared.primaryText, "Working 2m");
  assert.equal(cleared.attentionText, undefined);
});

test("mixed activity requires recent progress, not just progress after the request", () => {
  const base = providerState("needs_input");
  const mixedWith = (requested_at: string, last_progress_at: string) => ({
    ...base,
    current_turn: {
      ...base.current_turn,
      started_at: "2026-07-10T12:03:00Z",
      last_progress_at,
      attention: { kind: "approval" as const, requested_at, pending_count: 2, certainty: "exact" as const },
    },
  });

  // A stuck needs_input phase: the attention has been pending for minutes and the
  // agent has stopped, so progress is frozen minutes ago even though it is still
  // later than the request. It must read as Needs input, not an endless Working.
  const stale = selectSessionActivity({
    session: makeSession({
      turn_state: mixedWith("2026-07-10T12:04:00Z", "2026-07-10T12:05:00Z"),
      last_terminal_activity_at: "2026-07-10T12:05:05Z",
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(stale.kind, "needs-input");
  assert.equal(stale.primaryText, "Needs input 6m");
  assert.equal(stale.attentionText, undefined);

  // Same long-pending attention, but progress is recent: the agent is genuinely
  // working, so the mixed Working + Input requested cue is preserved.
  const fresh = selectSessionActivity({
    session: makeSession({
      turn_state: mixedWith("2026-07-10T12:04:00Z", "2026-07-10T12:09:40Z"),
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(fresh.kind, "working-attention");
  assert.equal(fresh.primaryText, "Working 7m");
  assert.equal(fresh.attentionText, "Input requested 6m");
});

test("the shared working-attention lease has exact inclusive boundaries", () => {
  const progressAt = Date.parse("2026-07-10T12:05:00Z");
  const base = providerState("needs_input");
  const session = makeSession({
    turn_state: {
      ...base,
      current_turn: {
        ...base.current_turn,
        last_progress_at: new Date(progressAt).toISOString(),
        attention: {
          kind: "approval",
          requested_at: new Date(progressAt - 1_000).toISOString(),
          pending_count: 1,
          certainty: "exact",
        },
      },
    },
  });
  const kindAt = (elapsed: number) => selectSessionActivity({
    session,
    machineReachable: true,
    focused: false,
    nowMs: progressAt + elapsed,
  }).kind;

  assert.deepEqual(
    [
      WORKING_ATTENTION_PROGRESS_FRESH_MS - 1,
      WORKING_ATTENTION_PROGRESS_FRESH_MS,
      WORKING_ATTENTION_PROGRESS_FRESH_MS + 1,
    ].map(kindAt),
    ["working-attention", "working-attention", "needs-input"],
  );
});

test("mixed activity details preserve dual timers and stale health priority", () => {
  const turn_state = {
    ...providerState("needs_input"),
    current_turn: {
      ...providerState("needs_input").current_turn,
      last_progress_at: "2026-07-10T12:09:30Z",
    },
  };
  const liveSession = makeSession({ turn_state });
  const effective = selectSessionActivity({ session: liveSession, machineReachable: true, focused: false, nowMs: now });
  const rendered = JSON.stringify(
    buildSessionActivityDetails({ session: liveSession, effective, machineReachable: true, focused: false, nowMs: now }),
  );
  assert.match(rendered, /Working 2m 14s/);
  assert.match(rendered, /Input requested 42s/);
  assert.match(rendered, /Current turn/);
  assert.match(rendered, /Attention requested/);

  const staleSession = {
    ...liveSession,
    [DASHBOARD_UNAVAILABLE_SINCE]: "2026-07-10T12:10:00Z",
  } satisfies DashboardSession;
  const unavailable = selectSessionActivity({
    session: staleSession,
    machineReachable: false,
    focused: false,
    nowMs: now + 60_000,
  });
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(unavailable.lastKnown?.kind, "working-attention");
  assert.equal(unavailable.lastKnown?.attentionText, "Input requested 42s");
});

test("health exceptions override phase without erasing last-known activity", () => {
  const session = {
    ...makeSession({
    turn_state: providerState("working"),
    }),
    [DASHBOARD_UNAVAILABLE_SINCE]: "2026-07-10T12:09:30Z",
  } satisfies DashboardSession;
  const unavailable = selectSessionActivity({ session, machineReachable: false, focused: true, nowMs: now });
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(unavailable.primaryText, "Unavailable 30s");
  assert.equal(unavailable.lastKnown?.kind, "working");

  const stopped = selectSessionActivity({
    session: makeSession({ status: "stopped", resumable: true, turn_state: providerState("waiting") }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(stopped.kind, "resumable");
  assert.equal(stopped.primaryText, "Stopped · resumable");

  const connecting = selectSessionActivity({
    session: makeSession({ turn_state: providerState("needs_input") }),
    machineReachable: true,
    focused: true,
    terminalStatus: "connecting",
    nowMs: now,
  });
  assert.equal(connecting.kind, "connecting");
  assert.equal(connecting.lastKnown?.kind, "needs-input");
});

test("old, corrupt, and future state degrade to honest activity fallback", () => {
  const active = selectSessionActivity({
    session: makeSession({ last_terminal_activity_at: "2026-07-10T12:09:52Z" }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(active.kind, "active");
  assert.equal(active.primaryText, "Terminal active 8s");
  assert.equal(active.ripple, true);

  const quiet = selectSessionActivity({
    session: makeSession({
      last_terminal_activity_at: "2026-07-10T12:05:00Z",
      turn_state: { ...providerState("working"), schema_version: "agent-session.turn-state.v2" as never },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(quiet.kind, "quiet");
  assert.equal(quiet.primaryText, "Terminal quiet 5m");

  const unknown = selectSessionActivity({
    session: makeSession({ updated_at: "invalid", last_terminal_activity_at: undefined }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.primaryText, "State unknown");
});

test("duration formatting rejects future or invalid timestamps", () => {
  assert.equal(formatActivityDuration("2026-07-10T12:09:18Z", now), "42s");
  assert.equal(formatActivityDuration("2026-07-10T12:05:00Z", now), "5m");
  assert.equal(formatActivityDuration("2026-07-10T12:10:01Z", now), null);
  assert.equal(formatActivityDuration("not-a-date", now), null);
  assert.equal(formatElapsedDuration(0), "0s");
  assert.equal(formatElapsedDuration(240_000), "4m");
  assert.equal(formatElapsedDuration(-1), null);
});

test("selector priority and fallback thresholds are exact", () => {
  const contested = {
    ...makeSession({ status: "stopped", resumable: true, turn_state: providerState("needs_input") }),
    [DASHBOARD_UNAVAILABLE_SINCE]: "2026-07-10T12:09:30Z",
  } satisfies DashboardSession;
  assert.equal(
    selectSessionActivity({
      session: contested,
      machineReachable: false,
      focused: true,
      terminalStatus: "closed",
      nowMs: now,
    }).kind,
    "unavailable",
  );
  assert.equal(
    selectSessionActivity({
      session: makeSession({ status: "stopped", resumable: true, turn_state: providerState("needs_input") }),
      machineReachable: true,
      focused: true,
      terminalStatus: "closed",
      nowMs: now,
    }).kind,
    "resumable",
  );
  assert.equal(
    selectSessionActivity({
      session: makeSession({ turn_state: providerState("needs_input") }),
      machineReachable: true,
      focused: true,
      terminalStatus: "closed",
      nowMs: now,
    }).kind,
    "connecting",
  );

  const fallbackAt = (elapsedMs: number) =>
    selectSessionActivity({
      session: makeSession({ last_terminal_activity_at: new Date(now - elapsedMs).toISOString() }),
      machineReachable: true,
      focused: false,
      nowMs: now,
    });
  assert.deepEqual(
    [9_999, 10_000, 10_001].map((elapsed) => fallbackAt(elapsed).ripple),
    [true, true, false],
  );
  assert.deepEqual(
    [29_999, 30_000, 30_001].map((elapsed) => fallbackAt(elapsed).kind),
    ["active", "active", "quiet"],
  );

  const partial = selectSessionActivity({
    session: makeSession({
      last_terminal_activity_at: "2026-07-10T12:09:50Z",
      turn_state: { schema_version: "agent-session.turn-state.v1" },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(partial.kind, "active");
  const futureTimer = selectSessionActivity({
    session: makeSession({
      turn_state: {
        ...providerState("working"),
        current_turn: { started_at: "2026-07-10T12:10:01Z" },
      },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(futureTimer.primaryText, "Working 2m");
  assert.equal(futureTimer.timerStartedAt, "2026-07-10T12:08:00Z");
});

test("known-phase partial and wrong-typed v1 states fall back without throwing", () => {
  const malformedStates = [
    { schema_version: "agent-session.turn-state.v1", phase: "working" },
    {
      schema_version: "agent-session.turn-state.v1",
      phase: "needs_input",
      phase_changed_at: "2026-07-10T12:09:00Z",
      revision: 2,
      source: { kind: 7, confidence: { unsafe: true } },
      current_turn: { attention: { kind: ["approval"], pending_count: "many" } },
    },
    {
      ...providerState("needs_input"),
      current_turn: {
        started_at: "2026-07-10T12:07:46Z",
        attention: { kind: "approval", requested_at: "2026-07-10T12:09:18Z" },
      },
    },
    // Held inside the STARTING_PHASE_FRESH_MS window on purpose: `providerState`
    // pins a phase 120s old, which the starting-dwell bound would classify as a
    // terminal-heartbeat handover, so these two rows would assert "active" for a
    // reason unrelated to normalization and stop discriminating a rejection.
    {
      ...providerState("starting"),
      phase_changed_at: "2026-07-10T12:09:30Z",
      current_turn: { provider_turn_id: "opaque" },
    },
    {
      ...providerState("starting"),
      phase_changed_at: "2026-07-10T12:09:30Z",
      last_turn: { started_at: "2026-07-10T12:01:00Z" },
    },
    {
      ...providerState("needs_input"),
      current_turn: { ...providerState("needs_input").current_turn, last_progress_at: "not-a-time" },
    },
  ];

  for (const turn_state of malformedStates) {
    const session = makeSession({
      last_terminal_activity_at: "2026-07-10T12:09:50Z",
      turn_state: turn_state as never,
    });
    const effective = selectSessionActivity({ session, machineReachable: true, focused: false, nowMs: now });
    assert.equal(effective.kind, "active");
    assert.doesNotThrow(() =>
      buildSessionActivityDetails({ session, effective, machineReachable: true, focused: false, nowMs: now }),
    );
  }
});

test("phase-specific incomplete v1 states fall back", () => {
  const incompleteStates = [
    { ...providerState("working"), current_turn: undefined },
    { ...providerState("needs_input"), current_turn: { started_at: "2026-07-10T12:07:46Z" } },
    { ...providerState("waiting"), last_turn: { started_at: "2026-07-10T12:01:00Z" } },
  ];

  for (const turn_state of incompleteStates) {
    const effective = selectSessionActivity({
      session: makeSession({ last_terminal_activity_at: "2026-07-10T12:09:50Z", turn_state }),
      machineReachable: true,
      focused: false,
      nowMs: now,
    });
    assert.equal(effective.kind, "active");
  }
});

test("untrusted session status is mapped to fixed safe output", () => {
  for (const status of ["prompt: SECRET_TOKEN", { malicious: true }, ["running"]]) {
    const session = makeSession({ status: status as never });
    const effective = selectSessionActivity({ session, machineReachable: true, focused: false, nowMs: now });
    const rendered = JSON.stringify(
      buildSessionActivityDetails({ session, effective, machineReachable: true, focused: false, nowMs: now }),
    );
    assert.equal(effective.kind, "unavailable");
    assert.match(rendered, /\"Process\",\"value\":\"Unknown\"/);
    assert.doesNotMatch(rendered, /SECRET_TOKEN|malicious/);
  }
});

test("non-RFC3339 state timestamps and unsafe provider identifiers fall back", () => {
  for (const phase_changed_at of [
    "0",
    "01",
    "Thu Jul 10 2026",
    "2026-07-10T12:09:18",
    "2026-02-30T12:00:00Z",
    "2026-01-01T24:00:00Z",
  ]) {
    const session = makeSession({
      last_terminal_activity_at: "2026-07-10T12:09:50Z",
      turn_state: { ...providerState("working"), phase_changed_at },
    });
    const effective = selectSessionActivity({ session, machineReachable: true, focused: false, nowMs: now });
    assert.equal(effective.kind, "active");
  }

  const unsafeProvider = "secret prompt\n\u0007tool output";
  const session = makeSession({
    last_terminal_activity_at: "2026-07-10T12:09:50Z",
    turn_state: {
      ...providerState("working"),
      source: { kind: "provider_hook", confidence: "observed", provider: unsafeProvider },
    },
  });
  const effective = selectSessionActivity({ session, machineReachable: true, focused: false, nowMs: now });
  const rendered = JSON.stringify(
    buildSessionActivityDetails({ session, effective, machineReachable: true, focused: false, nowMs: now }),
  );
  assert.equal(effective.kind, "active");
  assert.equal(rendered.includes(unsafeProvider), false);

  const offset = selectSessionActivity({
    session: makeSession({
      turn_state: {
        ...providerState("working"),
        phase_changed_at: "2026-07-10T14:08:00+02:00",
        current_turn: { started_at: "2026-07-10T14:07:46+02:00" },
      },
    }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  });
  assert.equal(offset.primaryText, "Working 2m");
});

test("credential-shaped unknown providers never render in fresh or stale details", () => {
  const rawProvider = "ghp_1234567890abcdef";
  const liveSession = makeSession({
    turn_state: {
      ...providerState("working"),
      source: { kind: "provider_hook", confidence: "observed", provider: rawProvider },
    },
  });
  const live = selectSessionActivity({ session: liveSession, machineReachable: true, focused: false, nowMs: now });
  const liveDetails = JSON.stringify(
    buildSessionActivityDetails({ session: liveSession, effective: live, machineReachable: true, focused: false, nowMs: now }),
  );
  assert.equal(live.kind, "working");
  assert.equal(liveDetails.includes(rawProvider), false);
  assert.match(liveDetails, /Provider Hook/);

  const staleSession = {
    ...liveSession,
    [DASHBOARD_UNAVAILABLE_SINCE]: "2026-07-10T12:10:00Z",
  } satisfies DashboardSession;
  const stale = selectSessionActivity({ session: staleSession, machineReachable: false, focused: false, nowMs: now + 60_000 });
  const staleDetails = JSON.stringify(
    buildSessionActivityDetails({
      session: staleSession,
      effective: stale,
      machineReachable: false,
      focused: false,
      nowMs: now + 60_000,
    }),
  );
  assert.equal(stale.lastKnown?.kind, "working");
  assert.equal(staleDetails.includes(rawProvider), false);
});

test("unavailable cards freeze last-known activity at the observation time", () => {
  const session = {
    ...makeSession({ turn_state: providerState("working") }),
    [DASHBOARD_UNAVAILABLE_SINCE]: "2026-07-10T12:10:00Z",
  } satisfies DashboardSession;
  const firstNow = Date.parse("2026-07-10T12:12:00Z");
  const secondNow = Date.parse("2026-07-10T12:20:00Z");
  const first = selectSessionActivity({ session, machineReachable: false, focused: false, nowMs: firstNow });
  const second = selectSessionActivity({ session, machineReachable: false, focused: false, nowMs: secondNow });

  assert.equal(first.primaryText, "Unavailable 2m");
  assert.equal(second.primaryText, "Unavailable 10m");
  assert.equal(first.lastKnown?.primaryText, second.lastKnown?.primaryText);
  assert.equal(first.lastKnown?.primaryText, "Working 2m");

  const details = buildSessionActivityDetails({
    session,
    effective: second,
    machineReachable: false,
    focused: false,
    nowMs: secondNow,
  });
  const rendered = JSON.stringify(details);
  assert.match(rendered, /Last-known state/);
  assert.match(rendered, /Working 2m/);
  assert.match(rendered, /Unavailable since/);
});

test("activity detail rows contain timing and health metadata only", () => {
  const session = makeSession({
    created_at: "2026-07-10T11:00:00Z",
    runtime_started_at: "2026-07-10T11:44:02Z",
    last_terminal_activity_at: "2026-07-10T12:09:40Z",
    turn_state: providerState("needs_input"),
  });
  const effective = selectSessionActivity({ session, machineReachable: true, focused: true, terminalStatus: "open", nowMs: now });
  const groups = buildSessionActivityDetails({ session, effective, machineReachable: true, focused: true, terminalStatus: "open", nowMs: now });
  const rendered = JSON.stringify(groups);
  assert.match(rendered, /Observed/);
  assert.match(rendered, /Codex/);
  assert.match(rendered, /Approval/);
  assert.match(rendered, /Runtime started/);
  assert.match(rendered, /Previous turn/);
  assert.doesNotMatch(rendered, /prompt|assistant|tool_input|tool_output|terminal text/i);
});

test("activity detail timestamps use a padded date and 24-hour local time", () => {
  const createdAt = "2026-07-11T22:25:56Z";
  const createdDate = new Date(createdAt);
  const expected = [
    createdDate.getFullYear().toString().padStart(4, "0"),
    (createdDate.getMonth() + 1).toString().padStart(2, "0"),
    createdDate.getDate().toString().padStart(2, "0"),
  ].join("/") + `, ${[
    createdDate.getHours().toString().padStart(2, "0"),
    createdDate.getMinutes().toString().padStart(2, "0"),
    createdDate.getSeconds().toString().padStart(2, "0"),
  ].join(":")}`;
  const session = makeSession({ created_at: createdAt });
  const effective = selectSessionActivity({ session, machineReachable: true, focused: false, nowMs: now });
  const groups = buildSessionActivityDetails({
    session,
    effective,
    machineReachable: true,
    focused: false,
    nowMs: Date.parse("2026-07-12T00:00:00Z"),
  });
  const createdRow = groups.flatMap((group) => group.rows).find((row) => row.label === "Session created");

  assert.equal(createdRow?.value, `${expected} · 1h 34m ago`);
  assert.doesNotMatch(createdRow?.value ?? "", /\b(?:AM|PM)\b/i);
});

test("dismissing the active attention key suppresses the input-requested pill", () => {
  const mixedState = {
    ...providerState("needs_input"),
    current_turn: {
      ...providerState("needs_input").current_turn,
      last_progress_at: "2026-07-10T12:09:30Z",
    },
  };
  const session = makeSession({
    turn_state: mixedState,
    last_terminal_activity_at: "2026-07-10T12:09:55Z",
  });

  const active = selectSessionActivity({ session, machineReachable: true, focused: false, nowMs: now });
  assert.equal(active.kind, "working-attention");
  assert.equal(active.attentionText, "Input requested 42s");
  assert.ok(active.attentionDismissKey, "an active pill exposes a stable dismiss key");

  const dismissed = selectSessionActivity({
    session,
    machineReachable: true,
    focused: false,
    nowMs: now,
    dismissedAttentionKey: active.attentionDismissKey,
  });
  assert.equal(dismissed.kind, "working", "dismissing the pill falls back to plain Working");
  assert.equal(dismissed.primaryText, "Working 2m 14s", "the working timer is preserved across dismissal");
  assert.equal(dismissed.attentionText, undefined, "the input-requested pill is suppressed");
  assert.equal(dismissed.pendingCount, undefined);
  assert.equal(dismissed.attentionDismissKey, undefined);
  assert.equal(dismissed.ripple, true, "the terminal ripple is preserved");
});

test("a new attention fingerprint restores a previously dismissed pill", () => {
  const baseState = {
    ...providerState("needs_input"),
    current_turn: {
      ...providerState("needs_input").current_turn,
      last_progress_at: "2026-07-10T12:09:30Z",
    },
  };
  const staleKey = selectSessionActivity({
    session: makeSession({ turn_state: baseState, last_terminal_activity_at: "2026-07-10T12:09:55Z" }),
    machineReachable: true,
    focused: false,
    nowMs: now,
  }).attentionDismissKey;
  assert.ok(staleKey);

  // A later attention with a new requested_at + pending_count is a different
  // fingerprint, so the stale dismissal must not silence the fresh request.
  const renewed = makeSession({
    turn_state: {
      ...baseState,
      current_turn: {
        ...baseState.current_turn,
        last_progress_at: "2026-07-10T12:09:45Z",
        attention: {
          kind: "approval",
          requested_at: "2026-07-10T12:09:40Z",
          pending_count: 3,
          certainty: "exact",
        },
      },
    },
    last_terminal_activity_at: "2026-07-10T12:09:55Z",
  });
  const restored = selectSessionActivity({
    session: renewed,
    machineReachable: true,
    focused: false,
    nowMs: now,
    dismissedAttentionKey: staleKey,
  });
  assert.equal(restored.kind, "working-attention", "a new attention fingerprint restores the pill");
  assert.equal(restored.attentionText, "Input requested 20s");
  assert.equal(restored.pendingCount, 3);
  assert.notEqual(restored.attentionDismissKey, staleKey, "the restored pill carries the new key");

  // Dismissing again with the current key re-suppresses it.
  const reDismissed = selectSessionActivity({
    session: renewed,
    machineReachable: true,
    focused: false,
    nowMs: now,
    dismissedAttentionKey: restored.attentionDismissKey,
  });
  assert.equal(reDismissed.attentionText, undefined);
});

test("a starting phase stops reading as Connecting once it goes stale", () => {
  const activityAt = (
    elapsedMs: number,
    terminalActivityAt?: string,
    semanticEventMsAgo?: number,
  ) =>
    selectSessionActivity({
      session: makeSession({
        ...(terminalActivityAt ? { last_terminal_activity_at: terminalActivityAt } : {}),
        turn_state: startingStateChangedMsAgo(elapsedMs, semanticEventMsAgo) as never,
      }),
      machineReachable: true,
      focused: false,
      nowMs: now,
    });
  const kindAt = (
    elapsedMs: number,
    terminalActivityAt?: string,
    semanticEventMsAgo?: number,
  ) => activityAt(elapsedMs, terminalActivityAt, semanticEventMsAgo).kind;

  // A fresh launch still reads as Connecting; a stale one hands over to the
  // terminal heartbeat, which classifies busy vs idle on its own clock.
  assert.deepEqual(
    [
      STARTING_PHASE_FRESH_MS - 1,
      STARTING_PHASE_FRESH_MS,
      STARTING_PHASE_FRESH_MS + 1,
    ].map((elapsed) => kindAt(elapsed, "2026-07-10T12:09:50Z")),
    ["connecting", "active", "active"],
  );
  assert.equal(kindAt(STARTING_PHASE_FRESH_MS, "2026-07-10T12:00:00Z"), "quiet");

  // With no terminal heartbeat at all the handover is honestly unknown, which is
  // the outcome the bound exists to reach instead of a false "not connected".
  assert.deepEqual(activityAt(STARTING_PHASE_FRESH_MS), {
    kind: "unknown",
    primaryText: "State unknown",
    ripple: false,
  });

  // The bound measures phase dwell, so `semantic_event` must not move it in
  // either direction: a stale event cannot hand over a fresh launch, and a fresh
  // event cannot keep a long-stuck launch on "Connecting…".
  assert.equal(kindAt(10_000, "2026-07-10T12:09:50Z", 10 * 60_000), "connecting");
  assert.equal(kindAt(30 * 60_000, "2026-07-10T12:09:50Z", 1_000), "active");

  // A phase timestamp ahead of the clock yields no elapsed time; staying on
  // Connecting is deliberate, since an untrusted clock is not evidence of stall.
  assert.equal(kindAt(-5_000, "2026-07-10T12:09:50Z"), "connecting");
});
