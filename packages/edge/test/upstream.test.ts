import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";
import { aggregateSessions, daemonFetch } from "../src/upstream.ts";
import type { MachineConfig } from "../src/config.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function envelope(sessions: unknown[]): string {
  return JSON.stringify({ schema_version: "cli.agent-session.serve.v1", ok: true, data: { sessions } });
}

const m = (name: string): MachineConfig => ({ name, url: `http://127.0.0.1:8781`, token: `${name}-token` });

test("explicitly inactive fleet machines are not probed or counted as offline", async () => {
  let probes = 0;
  globalThis.fetch = (async () => { probes++; return new Response(envelope([]), { status: 200 }); }) as typeof fetch;
  const out = await aggregateSessions([{ ...m("fixture-retired"), active: false }]);
  assert.equal(probes, 0);
  assert.deepEqual(out.sessions, []);
  assert.deepEqual(out.machines, [{ name: "fixture-retired", ok: false, active: false }]);
});

test("daemonFetch injects the machine bearer token", async () => {
  let seenAuth = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seenAuth = (init.headers as Record<string, string>).authorization ?? "";
    return new Response(envelope([]), { status: 200 });
  }) as typeof fetch;
  await daemonFetch(m("summit"), "/sessions");
  assert.equal(seenAuth, "Bearer summit-token");
});

test("daemonFetch serializes object bodies as JSON", async () => {
  let seenBody = "";
  let seenContentType = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seenBody = init.body as string;
    seenContentType = (init.headers as Record<string, string>)["content-type"] ?? "";
    return new Response(envelope([]), { status: 200 });
  }) as typeof fetch;
  await daemonFetch(m("summit"), "/sessions", { method: "POST", body: { cwd: "/repo" } });
  assert.equal(seenBody, JSON.stringify({ cwd: "/repo" }));
  assert.equal(seenContentType, "application/json");
});

test("daemonFetch serializes JavaScript string bodies as JSON values", async () => {
  let seenBody = "";
  let seenContentType = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seenBody = init.body as string;
    seenContentType = (init.headers as Record<string, string>)["content-type"] ?? "";
    return new Response(envelope([]), { status: 200 });
  }) as typeof fetch;
  await daemonFetch(m("summit"), "/sessions/abc/send", { method: "POST", body: "hello" });
  assert.equal(seenBody, JSON.stringify("hello"));
  assert.equal(seenContentType, "application/json");
});

test("daemonFetch forwards raw Buffer bodies with the caller content type", async () => {
  let seenBody: unknown;
  let seenContentType = "";
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seenBody = init.body;
    seenContentType = (init.headers as Record<string, string>)["content-type"] ?? "";
    return new Response(envelope([]), { status: 200 });
  }) as typeof fetch;
  const body = Buffer.from("hello");
  await daemonFetch(m("summit"), "/sessions/abc/attachments", { method: "POST", body, contentType: "text/plain" });
  assert.equal(seenBody, body);
  assert.equal(seenContentType, "text/plain");
});

test("aggregateSessions tags each session with its machine", async () => {
  globalThis.fetch = (async () =>
    new Response(envelope([{ id: "hs-1", status: "running" }]), { status: 200 })) as typeof fetch;
  const out = await aggregateSessions([m("summit")]);
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0]?.machine, "summit");
  assert.deepEqual(out.machines, [{ name: "summit", ok: true }]);
});

test("aggregateSessions drops retired orchestration and its private nested members", async () => {
  globalThis.fetch = (async () => new Response(envelope([{
    id: "worker-1",
    agent: "codex",
    status: "running",
    orchestration: {
      schema_version: "agent-session.session-orchestration.v1",
      run_id: "run-1",
      role: "worker",
      assignment_id: "assignment-1",
      primary_manager: {
        session_id: "main-1",
        session_incarnation: "main-incarnation",
        session_created_at: "2026-07-22T12:00:00Z",
        capability: "secret",
      },
      relationship_revision: 2,
      run_state: "active",
      assignment_state: "working",
      objective_summary: "Ship orchestration",
      private_packet: { prompt: "secret" },
    },
  }]), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);
  assert.equal("orchestration" in out.sessions[0]!, false);
  assert.equal((out.sessions[0]?.orchestration as Record<string, unknown>)?.private_packet, undefined);
  assert.doesNotMatch(JSON.stringify(out.sessions), /capability|private_packet|prompt|secret/);
});

test("aggregateSessions projects only safe ready agent profile summaries", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    schema_version: "cli.agent-session.serve.v1",
    ok: true,
    data: {
      sessions: [],
      capabilities: {
        profile_resume_import: true,
        managed_resume_command: true,
        resume_blocked_reason: true,
        private_path: "/drop/me",
      },
      agent_profiles: [
        {
          id: "custom-claude",
          label: " Custom Claude ",
          agent: "claude",
          provider_resume_import_supported: true,
          agent_bin: "/private/launcher",
          provider_config_dir: "/private/config",
        },
        { id: "../unsafe", label: "Unsafe", agent: "claude" },
        { id: "custom-claude", label: "Duplicate", agent: "claude" },
        { id: "unknown", label: "Unknown", agent: "future" },
      ],
    },
  }), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);
  assert.deepEqual(out.machines, [{
    name: "summit",
    ok: true,
    capabilities: {
      profile_resume_import: true,
      managed_resume_command: true,
      resume_blocked_reason: true,
    },
    agent_profiles: [{
      id: "custom-claude",
      label: "Custom Claude",
      agent: "claude",
      provider_resume_import_supported: true,
    }],
  }]);
  assert.doesNotMatch(JSON.stringify(out.machines), /agent_bin|provider_config_dir|private_path|private\//);
});

test("aggregateSessions projects only bounded profile resume blocking reasons", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true,
    data: {
      capabilities: { resume_blocked_reason: true },
      sessions: [
        { id: "removed", resumable: false, resume_blocked_reason: "agent-profile-unavailable" },
        {
          id: "leak",
          resumable: false,
          resume_blocked_reason: "/private/profile/root is missing",
          agent_bin: "/private/launcher",
          provider_config_dir: "/private/profile/root",
          agent_profile_provider_config_dir: "/private/profile/root-exact",
          readiness_command: ["/private/check"],
          readiness_args: ["--private-check"],
          agent_env: { SECRET: "drop-me-too" },
          env: { SECRET: "drop-me" },
          profile_resume_context: { provider_config_dir: "/private/nested-profile-root" },
          runtime: { extra: { readiness_env: { TOKEN: "nested-private" } } },
          launcher_path: "/private/unknown-launcher",
          provider_resume: {
            provider: "claude",
            session_id: "safe-provider-id",
            provider_config_dir: "/private/nested-provider-root",
          },
        },
      ],
    },
  }), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);
  assert.equal(out.sessions[0]?.resume_blocked_reason, "agent-profile-unavailable");
  assert.equal(Object.hasOwn(out.sessions[1] ?? {}, "resume_blocked_reason"), false);
  assert.doesNotMatch(
    JSON.stringify(out.sessions),
    /private|SECRET|agent_bin|provider_config_dir|readiness_command|readiness_args|agent_env|profile_resume_context|launcher_path|runtime/,
  );
  assert.deepEqual(out.sessions[1]?.provider_resume, {
    provider: "claude",
    session_id: "safe-provider-id",
  });
});

test("aggregateSessions preserves explicit structured-title capability independently of title state", async () => {
  globalThis.fetch = (async () => new Response(envelope([
    {
      id: "supported-valid",
      status: "running",
      title_state_supported: true,
      title_state: {
        topic: "  Retitle   rules ",
        topic_source: "auto",
        references: ["#317", "#317"],
        activity: " Implement contract ",
      },
    },
    {
      id: "supported-invalid",
      status: "running",
      title_state_supported: true,
      title_state: { topic: "Retitle rules", topic_source: "future", references: [], activity: null },
    },
    { id: "supported-empty", status: "running", title_state_supported: true },
    { id: "old-daemon", status: "running" },
    { id: "invalid-capability", status: "running", title_state_supported: false },
  ]), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);

  assert.deepEqual(out.sessions[0]?.title_state, {
    topic: "Retitle rules",
    topic_source: "auto",
    references: ["#317"],
    activity: "Implement contract",
  });
  assert.equal(out.sessions[0]?.title_state_supported, true);
  assert.equal(Object.hasOwn(out.sessions[1] ?? {}, "title_state"), false);
  assert.equal(out.sessions[1]?.title_state_supported, true);
  assert.equal(out.sessions[2]?.title_state_supported, true);
  assert.equal(Object.hasOwn(out.sessions[2] ?? {}, "title_state"), false);
  assert.equal(Object.hasOwn(out.sessions[3] ?? {}, "title_state_supported"), false);
  assert.equal(Object.hasOwn(out.sessions[4] ?? {}, "title_state_supported"), false);
});

test("aggregateSessions maps each daemon observation anchor onto its machine and sessions", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true,
    data: {
      observed_at: "2026-07-11T12:00:00Z",
      sessions: [{ id: "hs-1", status: "running" }],
    },
  }), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);

  assert.equal(out.machines[0]?.observed_at, "2026-07-11T12:00:00Z");
  assert.equal(out.sessions[0]?.activity_observed_at, "2026-07-11T12:00:00Z");
});

test("aggregateSessions strips daemon-supplied session observation anchors without a validated top-level anchor", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true,
    data: {
      sessions: [{
        id: "hs-1",
        status: "running",
        activity_observed_at: "2020-01-01T00:00:00Z",
      }],
    },
  }), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);

  assert.equal(out.machines[0]?.observed_at, undefined);
  assert.equal(out.sessions[0]?.activity_observed_at, undefined);
});

test("aggregateSessions rejects component-invalid top-level observation anchors", async () => {
  for (const invalidTimestamp of ["2026-02-30T12:00:00Z", "2026-07-11T24:00:00Z"]) {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      data: {
        observed_at: invalidTimestamp,
        sessions: [{
          id: "hs-1",
          status: "running",
          activity_observed_at: "2020-01-01T00:00:00Z",
        }],
      },
    }), { status: 200 })) as typeof fetch;

    const out = await aggregateSessions([m("summit")]);

    assert.equal(out.machines[0]?.observed_at, undefined, invalidTimestamp);
    assert.equal(out.sessions[0]?.activity_observed_at, undefined, invalidTimestamp);
  }
});

test("aggregateSessions preserves provider resume metadata unchanged", async () => {
  const providerResume = {
    provider: "codex",
    session_id: "019f31ee-85dc-7ac0-93e9-b4c2d81ed91e",
    resume_args: [
      "resume",
      "019f31ee-85dc-7ac0-93e9-b4c2d81ed91e",
      "--cd",
      "/home/runner/Project/agent-console",
      "--no-alt-screen",
    ],
  };
  globalThis.fetch = (async () =>
    new Response(envelope([{ id: "hs-1", status: "running", provider_resume: providerResume }]), {
      status: 200,
    })) as typeof fetch;
  const out = await aggregateSessions([m("summit")]);
  assert.deepEqual(out.sessions[0]?.provider_resume, providerResume);
  assert.equal(out.sessions[0]?.machine, "summit");
});

test("aggregateSessions preserves valid turn state and fails closed on malformed contracts", async () => {
  const sessions = [
    { id: "old", status: "running" },
    {
      id: "valid",
      status: "running",
      runtime_started_at: "2026-07-10T11:44:02Z",
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "working",
        phase_changed_at: "2026-07-10T12:07:46Z",
        revision: 7,
        source: { kind: "provider_hook", provider: "codex", confidence: "observed" },
        current_turn: { started_at: "2026-07-10T12:07:46Z" },
      },
    },
    { id: "partial", status: "running", turn_state: { schema_version: "agent-session.turn-state.v1" } },
    {
      id: "mixed",
      status: "running",
      turn_state: {
        schema_version: "agent-session.turn-state.v1",
        phase: "needs_input",
        phase_changed_at: "2026-07-10T12:09:18Z",
        revision: 8,
        source: { kind: "provider_hook", provider: "claude", confidence: "observed" },
        current_turn: {
          started_at: "2026-07-10T12:07:46Z",
          last_progress_at: "2026-07-10T12:09:30Z",
          attention: { kind: "clarification", requested_at: "2026-07-10T12:09:18Z", pending_count: 1 },
        },
      },
    },
    { id: "future", status: "running", turn_state: { schema_version: "agent-session.turn-state.v99", phase: "working" } },
  ];
  globalThis.fetch = (async () => new Response(envelope(sessions), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);
  const canonicalMixedSession = structuredClone(sessions[3]) as Record<string, any>;
  canonicalMixedSession.turn_state.current_turn.attention.certainty = "conservative";

  assert.deepEqual(
    out.sessions.map(({ machine: _machine, ...session }) => session),
    [
      sessions[0],
      sessions[1],
      { id: "partial", status: "running", turn_state: null },
      canonicalMixedSession,
      { id: "future", status: "running", turn_state: null },
    ],
  );
});

test("aggregateSessions normalizes auto-resume metadata and drops content-bearing extras", async () => {
  globalThis.fetch = (async () => new Response(envelope([{
    id: "claude-reset",
    status: "running",
    auto_resume: {
      schema_version: "agent-session.auto-resume.v1",
      supported: true,
      enabled: true,
      state: "scheduled",
      scheduled_at: "2026-07-12T12:34:56Z",
      continuation: "untrusted content",
    },
  }]), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);

  assert.deepEqual(out.sessions[0]?.auto_resume, {
    schema_version: "agent-session.auto-resume.v1",
    supported: true,
    enabled: true,
    state: "scheduled",
    scheduled_at: "2026-07-12T12:34:56Z",
  });
});

test("aggregateSessions preserves old-daemon absence and marks malformed metadata unavailable", async () => {
  globalThis.fetch = (async () => new Response(envelope([
    { id: "old", status: "running" },
    { id: "bad", status: "running", auto_resume: { schema_version: "wrong", supported: true } },
  ]), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);

  assert.equal("auto_resume" in (out.sessions[0] ?? {}), false);
  assert.equal(out.sessions[1]?.auto_resume, null);
});

test("aggregateSessions normalizes startup metadata without leaking daemon diagnostics", async () => {
  globalThis.fetch = (async () => new Response(envelope([{
    id: "failed",
    status: "stopped",
    startup: {
      schema_version: "agent-session.startup.v1",
      state: "failed",
      stage: "proxy",
      started_at: "2026-07-14T10:00:00Z",
      failure_code: "proxy-start-failed",
      message: "Agent Console could not connect the terminal to the agent runtime.",
      occurred_at: "2026-07-14T10:00:03Z",
      retry_safe: true,
      stderr: "Bearer daemon-secret",
      cwd: "/home/runner/repo",
    },
  }]), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);

  assert.deepEqual(out.sessions[0]?.startup, {
    schema_version: "agent-session.startup.v1",
    state: "failed",
    stage: "proxy",
    started_at: "2026-07-14T10:00:00Z",
    failure_code: "proxy-start-failed",
    message: "Agent Console could not connect the terminal to the agent runtime.",
    occurred_at: "2026-07-14T10:00:03Z",
    retry_safe: true,
  });
  assert.equal(JSON.stringify(out).includes("daemon-secret"), false);
  assert.equal(JSON.stringify(out).includes("/home/runner"), false);
});

test("aggregateSessions preserves startup absence and nulls malformed metadata without dropping neighbors", async () => {
  globalThis.fetch = (async () => new Response(envelope([
    { id: "old", status: "stopped" },
    { id: "bad", status: "stopped", startup: { schema_version: "future", state: "failed" } },
    { id: "healthy", status: "running" },
  ]), { status: 200 })) as typeof fetch;

  const out = await aggregateSessions([m("summit")]);

  assert.deepEqual(out.sessions.map((session) => session.id), ["old", "bad", "healthy"]);
  assert.equal("startup" in (out.sessions[0] ?? {}), false);
  assert.equal(out.sessions[1]?.startup, null);
  assert.equal("startup" in (out.sessions[2] ?? {}), false);
});

test("aggregateSessions preserves starting to ready and starting to failed transitions for stable session ids", async () => {
  let poll = 0;
  const starting = (id: string) => ({
    id,
    status: "running",
    startup: {
      schema_version: "agent-session.startup.v1",
      state: "starting",
      stage: "provider_client",
      started_at: "2026-07-14T10:00:00Z",
    },
  });
  globalThis.fetch = (async () => {
    poll += 1;
    return new Response(envelope(poll === 1
      ? [starting("becomes-ready"), starting("becomes-failed")]
      : [
          {
            id: "becomes-ready",
            status: "running",
            startup: {
              schema_version: "agent-session.startup.v1",
              state: "ready",
              stage: "initial_connection",
              started_at: "2026-07-14T10:00:00Z",
            },
          },
          {
            id: "becomes-failed",
            status: "stopped",
            startup: {
              schema_version: "agent-session.startup.v1",
              state: "failed",
              stage: "provider_client",
              started_at: "2026-07-14T10:00:00Z",
              failure_code: "provider-client-exited",
              message: "The agent exited before the session was ready.",
              occurred_at: "2026-07-14T10:00:02Z",
              retry_safe: true,
            },
          },
        ]), { status: 200 });
  }) as typeof fetch;

  const first = await aggregateSessions([m("summit")]);
  const second = await aggregateSessions([m("summit")]);

  assert.deepEqual(first.sessions.map((session) => [session.id, (session.startup as { state: string }).state]), [
    ["becomes-ready", "starting"],
    ["becomes-failed", "starting"],
  ]);
  assert.deepEqual(second.sessions.map((session) => [session.id, (session.startup as { state: string }).state]), [
    ["becomes-ready", "ready"],
    ["becomes-failed", "failed"],
  ]);
});

test("aggregateSessions keeps healthy machines when another is down", async () => {
  // Distinguish machines by their injected token: "up" answers, "down" throws.
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization ?? "";
    if (auth === "Bearer up-token") {
      return new Response(envelope([{ id: "s-up" }]), { status: 200 });
    }
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const out = await aggregateSessions([m("up"), m("down")]);
  assert.deepEqual(
    out.sessions.map((s) => s.id),
    ["s-up"],
  );
  assert.equal(out.sessions[0]?.machine, "up");
  const down = out.machines.find((x) => x.name === "down");
  assert.equal(down?.ok, false);
  assert.ok(down?.error);
});

test("aggregateSessions maps a non-200 daemon to an error status", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
  const out = await aggregateSessions([m("summit")]);
  assert.deepEqual(out.sessions, []);
  assert.equal(out.machines[0]?.ok, false);
  assert.match(out.machines[0]?.error ?? "", /503/);
});

test("aggregation retains workspace and public origin for Console filtering across mixed server versions", async () => {
  const parent = { session_id: "parent", machine: "host-a" };
  globalThis.fetch = (async () => new Response(envelope([
    { id: "worker", agent: "codex", workspace: "team-a", origin: { parent, private: "discard" } },
    { id: "manual", agent: "codex", workspace: null, origin: { parent: null } },
    { id: "legacy", agent: "codex" },
  ]), { status: 200 })) as typeof fetch;
  const out = await aggregateSessions([m("host-a")]);
  assert.deepEqual(out.sessions.map(row => [row.workspace, row.origin]), [["team-a", { parent }], [null, { parent: null }], [undefined, undefined]]);
});
