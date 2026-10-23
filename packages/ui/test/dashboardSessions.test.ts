import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  applySessionListResult,
  reconcileAgentProfilesByMachine,
  dashboardActivityObservation,
  unavailableSessionList,
  withDashboardActivityObservation,
} from "../src/dashboardSessions.ts";

test("an older poll cannot restore a launch profile removed by a newer observation", () => {
  const newer = reconcileAgentProfilesByMachine({}, new Map(), [{
    name: "summit",
    ok: true,
    observed_at: "2026-07-17T15:00:20Z",
    agent_profiles: [],
  }]);
  const older = reconcileAgentProfilesByMachine(newer.profiles, newer.observations, [{
    name: "summit",
    ok: true,
    observed_at: "2026-07-17T15:00:19Z",
    agent_profiles: [{ id: "custom-claude", label: "Custom Claude", agent: "claude" }],
  }]);

  assert.deepEqual(older.profiles.summit, []);
  assert.equal(older.observations.get("summit"), "2026-07-17T15:00:20Z");
});
import { DASHBOARD_UNAVAILABLE_SINCE, type DashboardSession, type Session, type SessionsResponse } from "../src/types.ts";
import { makeSession } from "./support/fixtures.ts";

function setValues<T>() {
  const values: T[] = [];
  return {
    values,
    setter: (value: T) => values.push(value),
  };
}

test("applySessionListResult updates session refs, reachability, known machines, and error state", () => {
  const alpha = makeSession({ machine: "alpha", id: "a" });
  const beta = makeSession({ machine: "beta", id: "b" });
  const response: SessionsResponse = {
    ok: true,
    sessions: [alpha, beta],
    machines: [
      { name: "alpha", ok: true },
      { name: "beta", ok: false, error: "offline" },
    ],
  };
  const sessionsRef = { current: [] as DashboardSession[] };
  const reachableRef = { current: new Set<string>() as ReadonlySet<string> };
  const knownRef = { current: new Set(["stale"]) as ReadonlySet<string> };
  const sessions = setValues<DashboardSession[]>();
  const reachable = setValues<ReadonlySet<string>>();
  const errors = setValues<string | null>();

  const applied = applySessionListResult(response, {
    sessionsRef,
    reachableMachineNamesRef: reachableRef,
    knownMachineNamesRef: knownRef,
    setSessions: sessions.setter,
    setReachableMachineNames: reachable.setter,
    setError: errors.setter,
  });

  assert.deepEqual(sessionsRef.current, [alpha, beta]);
  assert.deepEqual(sessions.values, [[alpha, beta]]);
  assert.deepEqual([...reachableRef.current], ["alpha"]);
  assert.deepEqual([...reachable.values[0]], ["alpha"]);
  assert.deepEqual([...knownRef.current].sort(), ["alpha", "beta"]);
  assert.equal(applied.error, "beta: offline");
  assert.deepEqual(errors.values, ["beta: offline"]);
});

test("explicit host retirement removes cached rows without an offline warning", () => {
  const active = makeSession({ machine: "fixture-active", id: "active" });
  const retired = makeSession({ machine: "fixture-retired", id: "old" });
  const sessionsRef = { current: [active, retired] as DashboardSession[] };
  const errors = setValues<string | null>();
  const result = applySessionListResult({ ok: true, sessions: [active], machines: [
    { name: "fixture-active", ok: true }, { name: "fixture-retired", ok: false, active: false },
  ] }, { sessionsRef, reachableMachineNamesRef: { current: new Set<string>() }, knownMachineNamesRef: { current: new Set<string>() },
    setSessions() {}, setReachableMachineNames() {}, setError: errors.setter });
  assert.deepEqual(sessionsRef.current, [active]);
  assert.equal(result.error, null);
  assert.deepEqual(errors.values, [null]);
});

test("applySessionListResult retains a last prompt through explicit same-runtime pending state", () => {
  const previous = makeSession({
    id: "same",
    session_incarnation: "launch-same",
    runtime_started_at: "2026-07-22T12:00:00Z",
    last_prompt_continuity: "a".repeat(32),
    last_prompt: { text: "Keep this prompt", truncated: false },
  });
  const pending = {
    ...makeSession({
      id: "same",
      session_incarnation: "launch-same",
      runtime_started_at: "2026-07-22T12:00:00Z",
      last_prompt_continuity: "a".repeat(32),
    }),
    last_prompt_state: "pending" as const,
  };

  const result = applySessionListResult({
    ok: true,
    sessions: [pending],
    machines: [{ name: "summit", ok: true }],
  }, {
    sessionsRef: { current: [previous] },
    reachableMachineNamesRef: { current: new Set(["summit"]) },
    knownMachineNamesRef: { current: new Set(["summit"]) },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  });

  assert.deepEqual(result.sessions[0]?.last_prompt, previous.last_prompt);
});

test("last-prompt reconciliation clears or replaces outside explicit same-runtime pending", () => {
  const priorPrompt = { text: "Previous prompt", truncated: false };
  const base = makeSession({
    id: "same",
    session_incarnation: "launch-same",
    runtime_started_at: "2026-07-22T12:00:00Z",
    last_prompt_continuity: "a".repeat(32),
  });
  const apply = (previous: Session, incoming: Session): Session | undefined => applySessionListResult({
    ok: true,
    sessions: [incoming],
    machines: [{ name: "summit", ok: true }],
  }, {
    sessionsRef: { current: [previous] },
    reachableMachineNamesRef: { current: new Set(["summit"]) },
    knownMachineNamesRef: { current: new Set(["summit"]) },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  }).sessions[0];

  const previous = { ...base, last_prompt: priorPrompt };
  assert.deepEqual(apply(previous, {
    ...base,
    last_prompt_state: "current",
    last_prompt: { text: "Authoritative prompt", truncated: false },
  })?.last_prompt, { text: "Authoritative prompt", truncated: false });
  assert.equal(apply(previous, { ...base, last_prompt_state: "current" })?.last_prompt, undefined);
  assert.equal(apply(previous, { ...base, last_prompt_state: "unavailable" })?.last_prompt, undefined);
  assert.equal(apply(previous, base)?.last_prompt, undefined, "legacy omission must retain replacement behavior");
  assert.equal(apply(previous, {
    ...base,
    session_incarnation: "launch-replacement",
    last_prompt_state: "pending",
  })?.last_prompt, undefined);

  const noIdentityPrevious = {
    ...base,
    session_incarnation: undefined,
    runtime_started_at: undefined,
    last_prompt: priorPrompt,
  };
  assert.equal(apply(noIdentityPrevious, {
    ...noIdentityPrevious,
    last_prompt: undefined,
    last_prompt_state: "pending",
  })?.last_prompt, undefined);

  const fallbackPrevious = {
    ...base,
    session_incarnation: undefined,
    last_prompt: priorPrompt,
  };
  assert.deepEqual(apply(fallbackPrevious, {
    ...base,
    session_incarnation: undefined,
    last_prompt_state: "pending",
  })?.last_prompt, priorPrompt);
  assert.equal(apply(fallbackPrevious, {
    ...base,
    session_incarnation: undefined,
    runtime_started_at: "2026-07-22T12:01:00Z",
    last_prompt_state: "pending",
  })?.last_prompt, undefined);

  const priorContinuity = {
    ...base,
    last_prompt: priorPrompt,
    last_prompt_continuity: "a".repeat(32),
  } as Session;
  assert.equal(apply(priorContinuity, {
    ...base,
    last_prompt_state: "pending",
    last_prompt_continuity: "b".repeat(32),
  } as Session)?.last_prompt, undefined, "a client that missed invalidation cannot retain across continuity tokens");
});

test("applySessionListResult preserves known machines when a response has no machine status rows", () => {
  const existingKnown = new Set(["summit"]);
  const response: SessionsResponse = {
    ok: true,
    sessions: [],
    machines: [],
  };
  const knownRef = { current: existingKnown as ReadonlySet<string> };

  const applied = applySessionListResult(response, {
    sessionsRef: { current: [makeSession()] },
    reachableMachineNamesRef: { current: new Set(["summit"]) as ReadonlySet<string> },
    knownMachineNamesRef: knownRef,
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  });

  assert.equal(knownRef.current, existingKnown);
  assert.deepEqual([...applied.knownMachineNames], []);
  assert.equal(applied.error, null);
});

test("a whole-poll failure retains and marks every known machine session", () => {
  const previous = [
    makeSession({ machine: "alpha", id: "a" }),
    makeSession({ machine: "beta", id: "b" }),
  ];
  const targets = {
    sessionsRef: { current: previous },
    reachableMachineNamesRef: { current: new Set(["alpha", "beta"]) as ReadonlySet<string> },
    knownMachineNamesRef: { current: new Set(["alpha", "beta"]) as ReadonlySet<string> },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  };

  const failed = applySessionListResult(
    { ok: false, sessions: [], machines: [] },
    targets,
    Date.parse("2026-07-10T12:10:00Z"),
  );

  assert.equal(failed.sessions.length, 2);
  assert.equal(
    failed.sessions.every((session) => session[DASHBOARD_UNAVAILABLE_SINCE] === "2026-07-10T12:10:00.000Z"),
    true,
  );
  assert.equal(failed.error, "Session list unavailable");
  assert.deepEqual([...failed.knownMachineNames].sort(), ["alpha", "beta"]);
});

test("unavailableSessionList converts a rejected poll into explicit machine failures", () => {
  assert.deepEqual(unavailableSessionList(["alpha", "beta"], "network down"), {
    ok: false,
    sessions: [],
    machines: [
      { name: "alpha", ok: false, error: "network down" },
      { name: "beta", ok: false, error: "network down" },
    ],
    error: "Console server is unreachable: network down",
  });
});

test("a rejected poll is reported once as a console-server failure, not per machine", () => {
  const previous = [
    makeSession({ machine: "alpha", id: "a" }),
    makeSession({ machine: "beta", id: "b" }),
  ];
  const targets = () => ({
    sessionsRef: { current: previous },
    reachableMachineNamesRef: { current: new Set(["alpha", "beta"]) as ReadonlySet<string> },
    knownMachineNamesRef: { current: new Set(["alpha", "beta"]) as ReadonlySet<string> },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  });

  const timedOut = applySessionListResult(
    unavailableSessionList(["alpha", "beta"], "Request timed out"),
    targets(),
    Date.parse("2026-09-30T08:12:08Z"),
  );
  assert.equal(timedOut.error, "Console server is unreachable: Request timed out");
  assert.deepEqual([...timedOut.reachableMachineNames], []);
  assert.equal(
    timedOut.sessions.every((session) => session[DASHBOARD_UNAVAILABLE_SINCE] === "2026-09-30T08:12:08.000Z"),
    true,
  );

  // Native transports reject without a message.
  const silent = applySessionListResult(unavailableSessionList(["alpha", "beta"]), targets());
  assert.equal(silent.error, "Console server is unreachable");
});

test("one authoritative poll removes externally tombstoned cards but preserves stopped listed sessions", () => {
  const removed = makeSession({ machine: "summit", id: "deleted-worker", status: "stopped", resumable: false });
  const resumable = makeSession({ machine: "summit", id: "resumable-main", status: "stopped", resumable: true });
  const targets = {
    sessionsRef: { current: [removed, resumable] as DashboardSession[] },
    reachableMachineNamesRef: { current: new Set(["summit"]) as ReadonlySet<string> },
    knownMachineNamesRef: { current: new Set(["summit"]) as ReadonlySet<string> },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  };

  const applied = applySessionListResult({
    ok: true,
    sessions: [resumable],
    machines: [{ name: "summit", ok: true }],
  }, targets);

  assert.deepEqual(applied.sessions.map((item) => item.id), ["resumable-main"]);
  assert.equal(applied.sessions[0]?.status, "stopped");
  assert.equal(applied.sessions[0]?.resumable, true);
});

test("applySessionListResult retains last-known sessions while one machine is unavailable", () => {
  const alpha = makeSession({ machine: "alpha", id: "a", turn_state: {
    schema_version: "agent-session.turn-state.v1",
    phase: "working",
    phase_changed_at: "2026-07-10T12:00:00Z",
    revision: 2,
    source: { kind: "provider_hook", confidence: "observed", provider: "codex" },
  } });
  const beta = makeSession({ machine: "beta", id: "b" });
  const sessionsRef = { current: [alpha, beta] as DashboardSession[] };

  const applied = applySessionListResult(
    {
      ok: false,
      sessions: [beta],
      machines: [
        { name: "alpha", ok: false, error: "offline" },
        { name: "beta", ok: true },
      ],
    },
    {
      sessionsRef,
      reachableMachineNamesRef: { current: new Set(["alpha", "beta"]) as ReadonlySet<string> },
      knownMachineNamesRef: { current: new Set(["alpha", "beta"]) as ReadonlySet<string> },
      setSessions: () => {},
      setReachableMachineNames: () => {},
      setError: () => {},
    },
    Date.parse("2026-07-10T12:10:00Z"),
  );

  assert.equal(applied.sessions.length, 2);
  const stale = applied.sessions.find((session) => session.machine === "alpha");
  assert.equal(stale?.[DASHBOARD_UNAVAILABLE_SINCE], "2026-07-10T12:10:00.000Z");
  assert.equal(stale?.turn_state?.phase, "working");
});

test("stale session timestamp is stable and recovery replaces the snapshot", () => {
  const stale = makeSession({
    machine: "alpha",
    id: "a",
    title: "old",
  }) as DashboardSession;
  Object.defineProperty(stale, DASHBOARD_UNAVAILABLE_SINCE, {
    value: "2026-07-10T12:10:00.000Z",
    enumerable: true,
  });
  const targets = {
    sessionsRef: { current: [stale] as DashboardSession[] },
    reachableMachineNamesRef: { current: new Set<string>() as ReadonlySet<string> },
    knownMachineNamesRef: { current: new Set(["alpha"]) as ReadonlySet<string> },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  };
  const down = applySessionListResult(
    { ok: false, sessions: [], machines: [{ name: "alpha", ok: false }] },
    targets,
    Date.parse("2026-07-10T12:12:00Z"),
  );
  assert.equal(down.sessions[0]?.[DASHBOARD_UNAVAILABLE_SINCE], "2026-07-10T12:10:00.000Z");

  targets.sessionsRef.current = down.sessions;
  const recovered = applySessionListResult(
    {
      ok: true,
      sessions: [makeSession({ machine: "alpha", id: "a", title: "live" })],
      machines: [{ name: "alpha", ok: true }],
    },
    targets,
    Date.parse("2026-07-10T12:13:00Z"),
  );
  assert.equal(recovered.sessions[0]?.title, "live");
  assert.equal(recovered.sessions[0]?.[DASHBOARD_UNAVAILABLE_SINCE], undefined);
});

test("machine recovery drops deleted stale cards and accepts additions", () => {
  const targets = {
    sessionsRef: {
      current: [
        makeSession({ machine: "alpha", id: "keep", title: "stale keep" }),
        makeSession({ machine: "alpha", id: "delete", title: "stale delete" }),
      ] as DashboardSession[],
    },
    reachableMachineNamesRef: { current: new Set(["alpha"]) as ReadonlySet<string> },
    knownMachineNamesRef: { current: new Set(["alpha"]) as ReadonlySet<string> },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  };
  const down = applySessionListResult(
    { ok: false, sessions: [], machines: [{ name: "alpha", ok: false }] },
    targets,
    Date.parse("2026-07-10T12:10:00Z"),
  );
  targets.sessionsRef.current = down.sessions;

  const recovered = applySessionListResult(
    {
      ok: true,
      sessions: [
        makeSession({ machine: "alpha", id: "keep", title: "live keep" }),
        makeSession({ machine: "alpha", id: "add", title: "live add" }),
      ],
      machines: [{ name: "alpha", ok: true }],
    },
    targets,
    Date.parse("2026-07-10T12:12:00Z"),
  );

  assert.deepEqual(
    recovered.sessions.map((session) => `${session.id}:${session.title}`),
    ["keep:live keep", "add:live add"],
  );
  assert.equal(recovered.sessions.every((session) => session[DASHBOARD_UNAVAILABLE_SINCE] === undefined), true);
});

test("a slower poll cannot overwrite a newer streamed turn-state revision", () => {
  const previous = makeSession({
    id: "same",
    runtime_started_at: "2026-07-11T12:00:00Z",
    turn_state: {
      schema_version: "agent-session.turn-state.v1",
      phase: "waiting",
      phase_changed_at: "2026-07-11T12:00:10Z",
      revision: 12,
      source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
      last_turn: { completed_at: "2026-07-11T12:00:10Z", outcome: "completed" },
    },
  });
  const targets = {
    sessionsRef: { current: [previous] as DashboardSession[] },
    reachableMachineNamesRef: { current: new Set(["summit"]) as ReadonlySet<string> },
    knownMachineNamesRef: { current: new Set(["summit"]) as ReadonlySet<string> },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  };
  const result = applySessionListResult({
    ok: true,
    machines: [{ name: "summit", ok: true, observed_at: "2026-07-11T12:00:11Z" }],
    sessions: [makeSession({
      id: "same",
      runtime_started_at: "2026-07-11T12:00:00Z",
      activity_observed_at: "2026-07-11T12:00:11Z",
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "working",
        phase_changed_at: "2026-07-11T12:00:09Z",
        revision: 11,
        source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
        current_turn: { started_at: "2026-07-11T12:00:00Z" },
      },
    })],
  }, targets, Date.parse("2026-07-11T12:00:12Z"), 12_000);

  assert.equal(result.sessions[0]?.turn_state?.revision, 12);
  assert.equal(result.sessions[0]?.turn_state?.phase, "waiting");
});

test("an older poll cannot revive activity cleared by a newer stream observation", () => {
  const streamed = withDashboardActivityObservation(makeSession({
    id: "same",
    runtime_started_at: "2026-07-11T12:00:00Z",
    turn_state: null,
  }), {
    daemonObservedAt: "2026-07-11T12:00:20.000000900Z",
    receivedMonotonicMs: 20_000,
    transport: "stream",
  });
  const targets = {
    sessionsRef: { current: [streamed] as DashboardSession[] },
    reachableMachineNamesRef: { current: new Set(["summit"]) as ReadonlySet<string> },
    knownMachineNamesRef: { current: new Set(["summit"]) as ReadonlySet<string> },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  };

  const result = applySessionListResult({
    ok: true,
    machines: [{ name: "summit", ok: true, observed_at: "2026-07-11T12:00:20.000000100Z" }],
    sessions: [makeSession({
      id: "same",
      runtime_started_at: "2026-07-11T12:00:00Z",
      activity_observed_at: "2026-07-11T12:00:20.000000100Z",
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "working",
        phase_changed_at: "2026-07-11T12:00:09Z",
        revision: 8,
        source: { kind: "provider_hook", provider: "codex", confidence: "observed" },
        current_turn: { started_at: "2026-07-11T12:00:00Z" },
      },
    })],
  }, targets, Date.parse("2026-07-11T12:00:21Z"), 21_000);

  assert.equal(result.sessions[0]?.turn_state, null);
  assert.equal(
    dashboardActivityObservation(result.sessions[0]!)?.daemonObservedAt,
    "2026-07-11T12:00:20.000000900Z",
  );
});

test("an older pre-restart poll cannot replace a newer runtime observation", () => {
  const restarted = withDashboardActivityObservation(makeSession({
    id: "same",
    runtime_started_at: "2026-07-11T12:00:20Z",
    title: "new runtime",
    turn_state: null,
  }), {
    daemonObservedAt: "2026-07-11T12:00:21Z",
    receivedMonotonicMs: 21_000,
    transport: "poll",
  });
  const targets = {
    sessionsRef: { current: [restarted] as DashboardSession[] },
    reachableMachineNamesRef: { current: new Set(["summit"]) as ReadonlySet<string> },
    knownMachineNamesRef: { current: new Set(["summit"]) as ReadonlySet<string> },
    setSessions: () => {},
    setReachableMachineNames: () => {},
    setError: () => {},
  };

  const result = applySessionListResult({
    ok: true,
    machines: [{ name: "summit", ok: true, observed_at: "2026-07-11T12:00:19Z" }],
    sessions: [makeSession({
      id: "same",
      runtime_started_at: "2026-07-11T11:00:00Z",
      title: "old runtime",
      activity_observed_at: "2026-07-11T12:00:19Z",
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "waiting",
        phase_changed_at: "2026-07-11T12:00:18Z",
        revision: 99,
        source: { kind: "provider_hook", provider: "codex", confidence: "authoritative" },
        last_turn: { completed_at: "2026-07-11T12:00:18Z", outcome: "completed" },
      },
    })],
  }, targets, Date.parse("2026-07-11T12:00:22Z"), 22_000);

  assert.equal(result.sessions[0]?.runtime_started_at, "2026-07-11T12:00:20Z");
  assert.equal(result.sessions[0]?.title, "new runtime");
  assert.equal(result.sessions[0]?.turn_state, null);
});
