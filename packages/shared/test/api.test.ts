import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyDebugEvent,
  debugRouteFamily,
  normalizeDebugErrorEnvelope,
  normalizeAgentConsolePrincipal,
  MAX_ORDER_ENTRIES,
  normalizeAgentLaunchProfiles,
  normalizeAgentLaunchProfileId,
  normalizeAgentSessionCapabilities,
  normalizeLayoutDocument,
  normalizeOrder,
  normalizePublicSessionDeleteResult,
  normalizeResumeBlockedReason,
  projectPublicAgentSession,
} from "../src/api.ts";

// A layout order is a small ranked list of session keys ("machine/id"). Shared
// owns the defensive contract used by both edge and UI callers.

test("normalizeOrder reads the { order: [...] } envelope", () => {
  assert.deepEqual(normalizeOrder({ order: ["summit/a", "summit/b"] }), ["summit/a", "summit/b"]);
});

test("public session projection preserves only bounded context usage fields", () => {
  assert.deepEqual(projectPublicAgentSession({
    id: "s",
    context_usage: {
      used_tokens: 244000,
      window_tokens: 1000000,
      source: "codex-rollout",
      observed_at: "2026-10-14T00:00:00Z",
      model: "gpt-example",
      private_extra: "drop me",
    },
  }).context_usage, {
    used_tokens: 244000,
    window_tokens: 1000000,
    source: "codex-rollout",
    observed_at: "2026-10-14T00:00:00Z",
    model: "gpt-example",
  });
  assert.equal(projectPublicAgentSession({ id: "s", context_usage: { used_tokens: -1, window_tokens: 0 } }).context_usage, null);
  assert.deepEqual(projectPublicAgentSession({ id: "s", context_usage: { used_tokens: 5, window_tokens: 10, source: null, observed_at: null, model: null } }).context_usage, {
    used_tokens: 5,
    window_tokens: 10,
    source: null,
    observed_at: null,
    model: null,
  });
  for (const model of ["sk-secret-canary", "/private/model"]) {
    assert.deepEqual(projectPublicAgentSession({
      id: "s",
      context_usage: { used_tokens: 5, window_tokens: 10, source: null, observed_at: null, model },
    }).context_usage, { used_tokens: 5, window_tokens: 10, source: null, observed_at: null, model: null });
  }
  assert.deepEqual(projectPublicAgentSession({
    id: "s",
    context_usage: { used_tokens: 130, window_tokens: null, source: "claude-transcript", observed_at: null, model: null },
  }).context_usage, { used_tokens: 130, window_tokens: null, source: "claude-transcript", observed_at: null, model: null });
  assert.equal(projectPublicAgentSession({ id: "s" }).context_usage, undefined);
});

test("normalizeOrder also accepts a bare array body", () => {
  assert.deepEqual(normalizeOrder(["summit/a", "summit/b"]), ["summit/a", "summit/b"]);
});

test("normalizeOrder drops non-string and empty entries", () => {
  assert.deepEqual(
    normalizeOrder({ order: ["summit/a", 1, null, {}, "", "summit/b"] }),
    ["summit/a", "summit/b"],
  );
});

test("normalizeOrder dedupes keeping the first occurrence", () => {
  assert.deepEqual(normalizeOrder({ order: ["a", "b", "a", "c", "b"] }), ["a", "b", "c"]);
});

test("normalizeOrder caps the entry count", () => {
  const many = Array.from({ length: MAX_ORDER_ENTRIES + 50 }, (_, i) => `m/${i}`);
  const out = normalizeOrder({ order: many });
  assert.equal(out.length, MAX_ORDER_ENTRIES);
  assert.equal(out[0], "m/0");
  assert.equal(out[MAX_ORDER_ENTRIES - 1], `m/${MAX_ORDER_ENTRIES - 1}`);
});

test("normalizeOrder drops absurdly long keys", () => {
  const longKey = "x".repeat(4096);
  assert.deepEqual(normalizeOrder({ order: ["summit/a", longKey, "summit/b"] }), [
    "summit/a",
    "summit/b",
  ]);
});

test("normalizeOrder keeps a key at the length boundary and drops the one just past it", () => {
  const atLimit = "x".repeat(512);
  const overLimit = "y".repeat(513);
  assert.deepEqual(normalizeOrder({ order: [atLimit, overLimit] }), [atLimit]);
});

test("normalizeOrder returns [] for a garbage/absent body (never throws)", () => {
  assert.deepEqual(normalizeOrder(null), []);
  assert.deepEqual(normalizeOrder(undefined), []);
  assert.deepEqual(normalizeOrder("nope"), []);
  assert.deepEqual(normalizeOrder({}), []);
  assert.deepEqual(normalizeOrder({ order: "not-an-array" }), []);
});

test("normalizeAgentLaunchProfileId owns the shared bounded identifier contract", () => {
  assert.equal(normalizeAgentLaunchProfileId("custom-claude"), "custom-claude");
  assert.equal(normalizeAgentLaunchProfileId("a".repeat(32)), "a".repeat(32));
  for (const value of ["", "Custom-Claude", "-claude", "custom_claude", "a".repeat(33), null]) {
    assert.equal(normalizeAgentLaunchProfileId(value), undefined);
  }
});

test("shared profile projection is bounded, deduplicated, and public-safe", () => {
  const profiles = normalizeAgentLaunchProfiles([
    { id: "custom-claude", label: " Custom Claude ", agent: "claude", provider_resume_import_supported: true },
    { id: "custom-claude", label: "Duplicate", agent: "claude" },
    { id: "bad", label: "Bad\nLabel", agent: "claude" },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `codex-${index}`,
      label: `Codex ${index}`,
      agent: "codex",
      agent_bin: `/private/codex-${index}`,
    })),
  ]);

  assert.equal(profiles.length, 14);
  assert.deepEqual(profiles[0], {
    id: "custom-claude",
    label: "Custom Claude",
    agent: "claude",
    provider_resume_import_supported: true,
  });
  assert.doesNotMatch(JSON.stringify(profiles), /private|agent_bin/);
  assert.equal(profiles.at(-1)?.id, "codex-12");
});

test("shared profile projection keeps DSH history resume and retires the hermes kind", () => {
  const profiles = normalizeAgentLaunchProfiles([
    {
      id: "dsh-workbench",
      label: "DSH",
      agent: "dsh",
      provider_resume_import_supported: false,
      history_resume_supported: true,
    },
    // A hermes-base DSH row is dropped like any unknown agent.
    { id: "dsh-tui", label: "DSH TUI", agent: "hermes", history_resume_supported: true },
    { id: "legacy", label: "Legacy", agent: "gemini" },
    { id: "plain", label: "Plain", agent: "codex", history_resume_supported: "yes" },
  ]);

  assert.deepEqual(profiles, [
    { id: "dsh-workbench", label: "DSH", agent: "dsh", history_resume_supported: true },
    { id: "plain", label: "Plain", agent: "codex" },
  ]);
});

test("public session projection drops unknown profile context at every nesting level", () => {
  const session = projectPublicAgentSession({
    id: "profiled",
    agent: "claude",
    agent_profile: "custom-claude",
    status: "stopped",
    resumable: true,
    provider_resume: {
      provider: "claude",
      session_id: "provider-id",
      resume_args: ["--resume", "provider-id"],
      provider_config_dir: "/private/provider-root",
    },
    profile_resume_context: { provider_config_dir: "/private/provider-root" },
    runtime: { extra: { readiness_env: { TOKEN: "private" } } },
    launcher_path: "/private/launcher",
  });

  assert.deepEqual(session, {
    id: "profiled",
    agent: "claude",
    status: "stopped",
    agent_profile: "custom-claude",
    resumable: true,
    provider_resume: {
      provider: "claude",
      session_id: "provider-id",
      resume_args: ["--resume", "provider-id"],
    },
  });
  assert.doesNotMatch(JSON.stringify(session), /private|provider_config_dir|runtime|launcher/);
});

test("public session projection surfaces a bounded single-line last_prompt and drops unknown members", () => {
  const session = projectPublicAgentSession({
    id: "s1",
    agent: "claude",
    status: "running",
    last_prompt: {
      text: "line one\nline two\twith   spaces",
      submitted_at: "2026-07-19T00:00:00Z",
      truncated: false,
      leaked_transcript_path: "/private/transcript.jsonl",
    },
  });
  assert.deepEqual(session.last_prompt, {
    text: "line one line two with spaces",
    submitted_at: "2026-07-19T00:00:00Z",
    truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(session), /leaked_transcript_path|private/);
});

test("public session projection omits an empty or malformed last_prompt", () => {
  assert.equal(
    projectPublicAgentSession({ id: "s", agent: "claude", status: "running", last_prompt: { text: "   " } }).last_prompt,
    undefined,
  );
  assert.equal(
    projectPublicAgentSession({ id: "s", agent: "claude", status: "running", last_prompt: "not-an-object" }).last_prompt,
    undefined,
  );
});

/* A captured prompt can carry harness scaffolding the user never typed — a
   shell echo the client wrapped, a slash-command header, an injected reminder.
   Those are transport, not intent, so they must not become the card preview. */

function previewFor(text: string): unknown {
  return (projectPublicAgentSession({ id: "s", agent: "claude", status: "running", last_prompt: { text } })
    .last_prompt as { text?: string } | undefined)?.text;
}

test("public last_prompt drops harness wrapper blocks and keeps what the user typed", () => {
  assert.equal(previewFor("ship the release <bash-input>git status</bash-input>"), "ship the release");
  assert.equal(
    previewFor("<command-name>/rename</command-name><command-message>rename</command-message>check the deploy"),
    "check the deploy",
  );
  // The capture is length-capped upstream, so a wrapper often arrives unclosed;
  // everything from the opening tag on is scaffolding.
  assert.equal(previewFor("look at this <bash-stdout>Updating af5d884..ad6197e Fast-forward"), "look at this");
});

test("public last_prompt is omitted when only harness scaffolding remains", () => {
  // Exactly the mobile card regression: a bash echo rendered as the preview.
  assert.equal(previewFor("<bash-stdout>Updating 3a77fbd..af5d884 Fast-forward docs/devlog/2026-07.md</bash-stdout>"), undefined);
  assert.equal(previewFor("<system-reminder>background note</system-reminder>"), undefined);
});

test("public last_prompt leaves ordinary angle brackets alone", () => {
  // Only the known wrapper names are scaffolding; markup the user actually
  // wrote about is content.
  assert.equal(previewFor("wrap it in a <div> and see"), "wrap it in a <div> and see");
  assert.equal(previewFor("compare <b>bold</b> vs <i>italic</i>"), "compare <b>bold</b> vs <i>italic</i>");
});

test("public session projection allowlists last_prompt_state values", () => {
  for (const state of ["current", "pending", "unavailable"]) {
    assert.equal(projectPublicAgentSession({
      id: state,
      agent: "codex",
      status: "running",
      last_prompt_state: state,
    }).last_prompt_state, state);
  }
  assert.equal(projectPublicAgentSession({
    id: "future",
    agent: "codex",
    status: "running",
    last_prompt_state: "future",
  }).last_prompt_state, undefined);
  assert.equal(projectPublicAgentSession({
    id: "malformed",
    agent: "codex",
    status: "running",
    last_prompt_state: true,
  }).last_prompt_state, undefined);
});

test("public session projection enforces the relational last-prompt state contract", () => {
  const prompt = { text: "Only a current or legacy prompt is authoritative", truncated: false };
  assert.deepEqual(projectPublicAgentSession({
    id: "current",
    agent: "codex",
    status: "running",
    last_prompt_state: "current",
    last_prompt: prompt,
  }).last_prompt, prompt);
  assert.deepEqual(projectPublicAgentSession({
    id: "legacy",
    agent: "codex",
    status: "running",
    last_prompt: prompt,
  }).last_prompt, prompt);
  for (const state of ["pending", "unavailable", "future"]) {
    assert.equal(projectPublicAgentSession({
      id: state,
      agent: "codex",
      status: "running",
      last_prompt_state: state,
      last_prompt: prompt,
    }).last_prompt, undefined);
  }
});

test("public session projection forwards only bounded opaque last-prompt continuity tokens", () => {
  const continuity = "opaque_token-version_1";
  assert.equal(projectPublicAgentSession({
    id: "current",
    agent: "codex",
    status: "running",
    last_prompt_state: "current",
    last_prompt_continuity: continuity,
  }).last_prompt_continuity, continuity);
  assert.equal(projectPublicAgentSession({
    id: "malformed",
    agent: "codex",
    status: "running",
    last_prompt_state: "pending",
    last_prompt_continuity: "../transcript.jsonl",
  }).last_prompt_continuity, undefined);
});

test("public session projection ignores retired orchestration relationships", () => {
  const session = projectPublicAgentSession({
    id: "worker-1",
    agent: "codex",
    status: "running",
    orchestration: {
      schema_version: "agent-session.session-orchestration.v1",
      run_id: "run-1",
      role: "worker",
      assignment_id: "assignment-1",
      primary_manager: {
        machine: "summit",
        session_id: "main-1",
        session_incarnation: "main-incarnation",
        session_created_at: "2026-07-22T12:00:00Z",
        capability: "private-capability",
        raw_path: "/private/main",
      },
      relationship_revision: 7,
      relationship_state: "borrowed",
      run_state: "active",
      assignment_state: "working",
      objective_summary: "Ship recoverable orchestration",
      collaborators: [{
        machine: "summit",
        session_id: "collaborator-1",
        session_incarnation: "collaborator-incarnation",
        session_created_at: "2026-07-22T12:01:00Z",
        prompt: "private prompt",
      }],
      borrowed_by: [{
        machine: "summit",
        session_id: "borrower-1",
        session_incarnation: "borrower-incarnation",
        session_created_at: "2026-07-22T12:02:00Z",
        mailbox_body: "private body",
      }],
      objective_packet_digest: "sha256:private",
      private_packet: { prompt: "secret" },
      transcript: "/private/transcript.jsonl",
      environment: { TOKEN: "secret" },
      tmux_session: "private-tmux",
      pid: 4242,
    },
  });

  assert.equal("orchestration" in session, false);
});

test("public session projection drops unsupported or oversized orchestration metadata", () => {
  const oversized = "x".repeat(513);
  assert.equal(projectPublicAgentSession({
    id: "legacy",
    agent: "claude",
    status: "stopped",
    orchestration: { schema_version: "future", run_id: "run-1", role: "main" },
  }).orchestration, undefined);
  assert.equal(projectPublicAgentSession({
    id: "oversized",
    agent: "claude",
    status: "stopped",
    orchestration: {
      schema_version: "agent-session.session-orchestration.v1",
      run_id: oversized,
      role: "main",
      relationship_revision: 1,
      run_state: "active",
      objective_summary: "safe",
    },
  }).orchestration, undefined);
});

test("logical-delete acknowledgement keeps cleanup state and drops physical private details", () => {
  assert.deepEqual(normalizePublicSessionDeleteResult({
    id: "worker-1",
    deleted: true,
    killed: false,
    cleanup_pending: true,
    tmux_session: "private-tmux",
    session_dir: "/private/session",
    pid: 42,
  }, "worker-1"), {
    id: "worker-1",
    deleted: true,
    killed: false,
    cleanup_pending: true,
  });
  assert.equal(normalizePublicSessionDeleteResult({ id: "replacement", deleted: true }, "worker-1"), null);
});

test("shared capability normalization accepts lifecycle flags and drops non-true", () => {
  assert.deepEqual(normalizeAgentSessionCapabilities({
    last_prompt: true,
    history: true,
    archive: true,
    group_archive: true,
  }), {
    last_prompt: true,
    history: true,
    archive: true,
  });
  assert.deepEqual(normalizeAgentSessionCapabilities({ last_prompt: "true", group_archive: "true" }), {});
});

test("shared capability and blocking-reason normalization fails closed", () => {
  assert.deepEqual(normalizeAgentSessionCapabilities({
    profile_resume_import: true,
    managed_resume_command: "true",
    resume_blocked_reason: true,
    private_capability: true,
  }), {
    profile_resume_import: true,
    resume_blocked_reason: true,
  });
  assert.equal(normalizeResumeBlockedReason("agent-profile-context-mismatch"), "agent-profile-context-mismatch");
  assert.equal(normalizeResumeBlockedReason("/private/profile/root"), undefined);
});

test("normalizeLayoutDocument preserves a safe revision while accepting old order envelopes", () => {
  assert.deepEqual(normalizeLayoutDocument({ order: ["summit/a"], revision: 7 }), {
    order: ["summit/a"],
    revision: 7,
  });
  assert.deepEqual(normalizeLayoutDocument({ order: ["summit/a"] }), {
    order: ["summit/a"],
    revision: null,
  });
  assert.deepEqual(normalizeLayoutDocument({ order: ["summit/a"], revision: -1 }), {
    order: ["summit/a"],
    revision: null,
  });
});

test("normalizeAgentConsolePrincipal accepts only stable ids and explicit permissions", () => {
  assert.deepEqual(normalizeAgentConsolePrincipal({ id: "root", permissions: ["terminal"] }),
    { id: "root", permissions: ["terminal"] });
  assert.deepEqual(normalizeAgentConsolePrincipal({
    id: "tess",
    permissions: ["debug", "usage", "codex_reset"],
    token: "must-not-project",
  }), {
    id: "tess",
    permissions: ["debug", "usage", "codex_reset"],
  });
  assert.equal(normalizeAgentConsolePrincipal({ id: "../dana", permissions: [] }), null);
  assert.equal(normalizeAgentConsolePrincipal({ id: "dana", permissions: ["invalid permission"] }), null);
  assert.equal(normalizeAgentConsolePrincipal({ id: "dana", permissions: ["usage", "usage"] }), null);
  assert.deepEqual(normalizeAgentConsolePrincipal({
    id: "dana", permissions: [], defaultVisibleMachines: ["maple"], defaultCreateMachine: "maple",
  }), {
    id: "dana", permissions: [], defaultVisibleMachines: ["maple"], defaultCreateMachine: "maple",
  });
  assert.equal(normalizeAgentConsolePrincipal({
    id: "dana", permissions: [], defaultVisibleMachines: ["maple", "maple"],
  }), null);
  assert.equal(normalizeAgentConsolePrincipal({
    id: "dana", permissions: [], defaultCreateMachine: 42,
  }), null);
});

test("debug rows are classified so failures and lifecycle outcomes get their own retention", () => {
  assert.equal(classifyDebugEvent({ ok: true }), "traffic");
  assert.equal(classifyDebugEvent({ ok: null }), "traffic");
  assert.equal(classifyDebugEvent({ ok: false }), "signal");
  assert.equal(classifyDebugEvent({ ok: null, operation: "title" }), "signal");
  assert.equal(classifyDebugEvent({ ok: true, code: "retitle-v3-history-conflict" }), "signal");
});

test("debugRouteFamily groups a de-identified route into a filterable family", () => {
  assert.equal(debugRouteFamily("/api/sessions"), "sessions");
  assert.equal(debugRouteFamily("/api/sessions/:machine"), "sessions");
  assert.equal(debugRouteFamily("/api/sessions/:machine/:id"), "sessions");
  assert.equal(debugRouteFamily("/api/sessions/:machine/:id/retitle-v3"), "sessions/retitle-v3");
  assert.equal(debugRouteFamily("/api/machines/:machine/workdirs"), "machines/workdirs");
  assert.equal(debugRouteFamily("/title-lifecycle"), "lifecycle");
  assert.equal(debugRouteFamily("/"), "other");
});

test("the failure envelope projection keeps bounded decisions and drops everything else", () => {
  assert.deepEqual(
    normalizeDebugErrorEnvelope({
      ok: false,
      error: {
        code: "retitle-v3-history-conflict",
        message: "The session history changed. Refresh and try again.",
        details: {
          retryable: true,
          next_action: "refresh_session",
          recovery: { strategy: "refresh_and_retry", safe_to_retry: true },
        },
      },
    }),
    {
      code: "retitle-v3-history-conflict",
      retryable: true,
      next_action: "refresh_session",
      recovery_strategy: "refresh_and_retry",
      recovery_safe_to_retry: true,
    },
  );
  // A successful envelope contributes nothing, and neither do free-text values
  // that would otherwise smuggle a response body into a debug ring.
  assert.deepEqual(normalizeDebugErrorEnvelope({ ok: true, data: { title: "a real title" } }), {});
  assert.deepEqual(
    normalizeDebugErrorEnvelope({
      ok: false,
      error: { code: "a whole sentence about what went wrong", details: { next_action: "go and fix it" } },
    }),
    {},
  );
});

test("public session projection preserves effective model and effort without account inference", () => {
  for (const agent of ["codex", "claude", "dsh"]) {
    const row = projectPublicAgentSession({ id: "s", agent, model: "example-model", reasoning_effort: "medium" });
    assert.equal(row.model, "example-model");
    assert.equal(row.reasoning_effort, "medium");
  }
  const unknown = projectPublicAgentSession({ id: "s", agent: "codex", codex_account: { account: "example-account" } });
  assert.equal(unknown.model, undefined);
  assert.equal(unknown.reasoning_effort, undefined);
  const explicitUnknown = projectPublicAgentSession({ id: "s", agent: "claude", model: null, reasoning_effort: null });
  assert.equal(explicitUnknown.model, null);
  assert.equal(explicitUnknown.reasoning_effort, null);
});

test("principal projection retains configured extension permissions and rejects malformed identifiers", () => {
  assert.deepEqual(normalizeAgentConsolePrincipal({ id: "owner", permissions: ["usage", "account_control"] }), { id: "owner", permissions: ["usage", "account_control"] });
  for (const permissions of [["bad permission"], ["x".repeat(65)], ["usage", "usage"], [1]]) {
    assert.equal(normalizeAgentConsolePrincipal({ id: "owner", permissions }), null);
  }
});


test("public last_message uses prompt hygiene, bounded metadata and exact roles", () => {
  const project = (last_message: unknown) => projectPublicAgentSession({ id: "s", agent: "codex", status: "running", last_message }).last_message;
  for (const role of ["user", "assistant"]) {
    assert.deepEqual(project({ role, text: "<system-reminder>scaffold</system-reminder>Done\nwith\tspaces", submitted_at: "2026-10-25T00:00:00Z", truncated: false, private_field: "omit" }),
      { role, text: "Done with spaces", submitted_at: "2026-10-25T00:00:00Z", truncated: false });
    const long = "x".repeat(3000);
    assert.equal((project({role, text: long}) as {text: string}).text.length,
      (projectPublicAgentSession({last_prompt: {text: long}}).last_prompt as {text: string}).text.length);
  }
  for (const value of [null, [], "text", {role: "tool", text: "No"}, {role: "assistant", text: "\u0000bad"}, {role: "user", text: "   "}, {role: "assistant", text: "<system-reminder>only scaffold</system-reminder>"}]) {
    assert.equal(project(value), undefined);
  }
  assert.deepEqual(project({role: "assistant", text: "Done", submitted_at: "x".repeat(65), truncated: "true"}), {role: "assistant", text: "Done"});
  assert.deepEqual(normalizeAgentSessionCapabilities({last_message: true}), {last_message: true});
  assert.deepEqual(normalizeAgentSessionCapabilities({last_message: "true"}), {});
});

test("notice previews strip only strict v1 headers in both public text fields", () => {
  const header = "<!-- agent-notice:v1 kind=mailbox source=fixture -->";
  for (const field of ["last_prompt", "last_message"]) {
    const preview = (text: string) => (projectPublicAgentSession({
      [field]: { role: "user", text, truncated: false },
    })[field] as { text: string } | undefined)?.text;
    assert.equal(preview(`${header}\n\nSynthetic update\nSecond line`), "Notice: Synthetic update");
    assert.equal(preview(`${header}\r\n\r\nSynthetic update\r\nSecond line`), "Notice: Synthetic update");
    for (const raw of [header + "\nBody", header.replace(":v1", ":v2") + "\n\nBody", "Ordinary\nmessage"]) {
      assert.equal(preview(raw), raw.replace(/\s+/g, " ").trim());
    }
    assert.equal(preview(`${header}\n\n<system-reminder>hidden</system-reminder>Update\nIgnored`), "Notice: Update");
    assert.equal(preview(`${header}\n\nBad\u0000body`), undefined);
    assert.equal(preview(`${header}\n\n${"x".repeat(3000)}`)?.length, 2048);
  }
});
