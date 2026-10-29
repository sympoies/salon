import { strict as assert } from "node:assert";
import { test } from "node:test";
import { projectPublicAgentSession } from "@agent-console/shared/api";
import {
  compactRepoBadgeLines,
  describeUnreachable,
  formatResetCountdown,
  relativeEpochSeconds,
  isSessionResumeAvailable,
  relativeTime,
  resumeCommand,
  sessionCopyAction,
  sessionCommand,
  sessionLabel,
  sessionRepoLabel,
  sessionStatusLabel,
  sortByDefaultSessionOrder,
  type SessionLike,
} from "../src/format.ts";

test("sortByDefaultSessionOrder ignores activity changes within a machine", () => {
  const out = sortByDefaultSessionOrder([
    {
      id: "second",
      machine: "summit",
      created_at: "2026-07-04T11:00:00Z",
      updated_at: "2026-07-04T12:10:00Z",
    },
    {
      id: "first",
      machine: "summit",
      created_at: "2026-07-04T10:00:00Z",
      updated_at: "2026-07-04T12:30:00Z",
    },
    {
      id: "third",
      machine: "summit",
      created_at: "2026-07-04T12:00:00Z",
      updated_at: "2026-07-04T09:00:00Z",
    },
  ]);
  assert.deepEqual(out.map((s) => s.id), ["first", "second", "third"]);
});

test("sortByDefaultSessionOrder uses configured machine order and stable fallback", () => {
  const out = sortByDefaultSessionOrder(
    [
      { id: "z", machine: "mesa" },
      { id: "b", machine: "summit", created_at: "2026-07-04T10:00:00Z" },
      { id: "a", machine: "summit", created_at: "2026-07-04T10:00:00Z" },
      { id: "a", machine: "mesa" },
    ],
    ["summit", "mesa"],
  );
  assert.deepEqual(
    out.map((s) => `${s.machine}/${s.id}`),
    ["summit/a", "summit/b", "mesa/a", "mesa/z"],
  );
});

test("relativeTime buckets", () => {
  const now = Date.parse("2026-07-04T12:00:00Z");
  assert.equal(relativeTime("2026-07-04T11:59:30Z", now), "30s ago");
  assert.equal(relativeTime("2026-07-04T11:30:00Z", now), "30m ago");
  assert.equal(relativeTime("2026-07-04T09:00:00Z", now), "3h ago");
  assert.equal(relativeTime("2026-07-01T12:00:00Z", now), "3d ago");
  assert.equal(relativeTime(undefined, now), "—");
  assert.equal(relativeTime("not-a-date", now), "—");
});

test("sessionLabel prefers a non-empty title, then provider resume id, else id", () => {
  assert.equal(sessionLabel({ id: "hs-1", title: "build" }), "build");
  assert.equal(
    sessionLabel({
      id: "hs-1",
      title: "  ",
      provider_resume: { provider: "codex", session_id: "019f31ee-85dc-7ac0-93e9-b4c2d81ed91e" },
    }),
    "019f31ee-85dc-7ac0-93e9-b4c2d81ed91e",
  );
  assert.equal(
    sessionLabel({
      id: "hs-1",
      title: null,
      provider_resume: { provider: "claude", session_id: "2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209" },
    }),
    "2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209",
  );
  assert.equal(sessionLabel({ id: "hs-1" }), "hs-1");
});

test("resumeCommand prefers daemon resume args and only composes known provider commands", () => {
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: {
        provider: "codex",
        session_id: "019f31ee-85dc-7ac0-93e9-b4c2d81ed91e",
        resume_args: [
          "resume",
          "019f31ee-85dc-7ac0-93e9-b4c2d81ed91e",
          "--cd",
          "/home/runner/Project/agent console",
          "--no-alt-screen",
        ],
      },
    }),
    "codex resume 019f31ee-85dc-7ac0-93e9-b4c2d81ed91e --cd '/home/runner/Project/agent console' --no-alt-screen",
  );
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: {
        provider: "claude",
        session_id: "2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209",
        resume_args: ["--resume", "2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209"],
      },
    }),
    "claude --resume 2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209",
  );
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: { provider: "codex", session_id: "019f31ee-85dc-7ac0-93e9-b4c2d81ed91e" },
    }),
    "codex resume 019f31ee-85dc-7ac0-93e9-b4c2d81ed91e",
  );
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: { provider: "codex", session_id: "abc; touch /tmp/pwn" },
    }),
    "codex resume 'abc; touch /tmp/pwn'",
  );
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: { provider: "claude", session_id: "provider id" },
    }),
    "claude --resume 'provider id'",
  );
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: { provider: "codex", session_id: "--help" },
    }),
    null,
  );
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: { provider: "codex", session_id: "--dangerously-bypass-approvals-and-sandbox" },
    }),
    null,
  );
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: { provider: "claude", session_id: "-pwn" },
    }),
    null,
  );
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: { provider: "other", session_id: "provider-session", command: "evil --command" } as never,
    }),
    null,
  );
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: { provider: "other", session_id: "provider-session" },
    }),
    null,
  );
  assert.equal(resumeCommand({ id: "hs-1", provider_resume: { provider: "codex", session_id: "  " } }), null);
  assert.equal(
    resumeCommand({
      id: "hs-1",
      provider_resume: { provider: "codex", session_id: "fallback", resume_args: ["resume", 42] as never },
    }),
    "codex resume fallback",
  );
  assert.equal(sessionLabel({ id: "hs-1", provider_resume: { session_id: 42 } as never }), "hs-1");
  assert.equal(resumeCommand({ id: "hs-1", provider_resume: { provider: 42, session_id: "x" } as never }), null);
  assert.equal(resumeCommand({ id: "hs-1", provider_resume: { provider: "codex", session_id: 42 } as never }), null);
  assert.equal(
    resumeCommand({ id: "hs-1", provider_resume: { provider: "codex", command: "codex resume x" } as never }),
    null,
  );
  assert.equal(resumeCommand({ id: "hs-1", provider_resume: 42 as never }), null);
  assert.equal(resumeCommand({ id: "hs-1" }), null);
});

test("sessionCommand requires Codex provider resume", () => {
  assert.equal(
    sessionCommand({
      id: "hs-1",
      agent: "codex",
      status: "running",
      attach_command: "tmux attach -t hs-codex-1",
      ssh_attach_command: "ssh -t summit 'tmux attach -t hs-codex-1'",
    }),
    null,
  );
  assert.equal(
    sessionCommand({
      id: "hs-1",
      agent: "codex",
      status: "running",
      provider_resume: { provider: "codex", session_id: "codex-provider-id" },
    }),
    "codex resume codex-provider-id",
  );
  assert.equal(
    sessionCommand({
      id: "hs-1",
      agent: "hermes",
      status: "running",
      attach_command: "tmux attach -t hs-hermes-1",
    }),
    null,
  );
  assert.equal(
    sessionCommand({
      id: "stopped",
      agent: "codex",
      status: "stopped",
    }),
    null,
  );
  assert.equal(
    sessionCommand({
      id: "unknown-agent",
      agent: "other",
      status: "running",
      attach_command: "tmux attach -t other",
    }),
    null,
  );
});

test("sessionCopyAction uses the managed session id without provider resume metadata", () => {
  assert.deepEqual(
    sessionCopyAction({
      id: "managed-codex",
      agent: "codex",
      status: "running",
      managed_resume_command_available: true,
    }),
    { kind: "command", value: "agent-session resume managed-codex" },
  );
  assert.deepEqual(
    sessionCopyAction({
      id: "managed-codex-with-provider-metadata",
      agent: "codex",
      status: "running",
      managed_resume_command_available: true,
      provider_resume: { provider: "codex", session_id: "provider-session-id" },
    }),
    { kind: "command", value: "codex resume provider-session-id" },
  );
  assert.equal(
    sessionCopyAction({
      id: "--unsafe",
      agent: "codex",
      status: "running",
      managed_resume_command_available: true,
    }),
    null,
  );
});

test("sessionCopyAction never emits a base provider command for a profiled session", () => {
  assert.deepEqual(
    sessionCopyAction({
      id: "managed-profile",
      agent: "claude",
      agent_profile: "custom-claude",
      status: "stopped",
      managed_resume_command_available: true,
      provider_resume: { provider: "claude", session_id: "profile-provider-id" },
    }),
    { kind: "command", value: "agent-session resume managed-profile" },
  );
  assert.deepEqual(
    sessionCopyAction({
      id: "legacy-edge",
      agent: "claude",
      agent_profile: "custom-claude",
      status: "stopped",
      provider_resume: { provider: "claude", session_id: "profile-provider-id" },
    }),
    { kind: "provider-session-id", value: "profile-provider-id" },
  );
  assert.deepEqual(
    sessionCopyAction({
      id: "blocked-profile",
      agent: "claude",
      agent_profile: "custom-claude",
      status: "stopped",
      managed_resume_command_available: true,
      resume_blocked_reason: "agent-profile-unavailable",
      provider_resume: { provider: "claude", session_id: "profile-provider-id" },
    }),
    { kind: "provider-session-id", value: "profile-provider-id" },
  );
  assert.equal(
    sessionCopyAction({
      id: "unsafe-fallback",
      agent: "claude",
      agent_profile: "custom-claude",
      provider_resume: { provider: "claude", session_id: "--help" },
    }),
    null,
  );
});

test("projected malformed profile context copies only the labeled provider session id", () => {
  const projected = projectPublicAgentSession({
    id: "legacy-profile",
    agent: "claude",
    agent_profile: "../invalid-profile",
    status: "stopped",
    resumable: false,
    resume_blocked_reason: "agent-profile-metadata-unavailable",
    provider_resume: {
      provider: "claude",
      session_id: "profile-provider-id",
      resume_args: ["--resume", "profile-provider-id"],
    },
  });

  assert.equal(Object.hasOwn(projected, "agent_profile"), false);
  assert.deepEqual(sessionCopyAction(projected as unknown as SessionLike), {
    kind: "provider-session-id",
    value: "profile-provider-id",
  });
});

test("sessionRepoLabel prefers daemon repo_name, then cwd basename", () => {
  assert.equal(sessionRepoLabel({ id: "hs-1", repo_name: "nils-cli", cwd: "/workspace/Project/other" }), "nils-cli");
  assert.equal(sessionRepoLabel({ id: "hs-1", cwd: "/workspace/Project/agent-console/" }), "agent-console");
  assert.equal(sessionRepoLabel({ id: "hs-1", cwd: "" }), "unknown");
  assert.equal(sessionRepoLabel({ id: "hs-1" }), "unknown");
});

test("compactRepoBadgeLines balances hyphenated repo names across two lines", () => {
  assert.deepEqual(compactRepoBadgeLines("agent-console"), ["agent", "console"]);
  assert.deepEqual(compactRepoBadgeLines("exampleOrg/agent-console"), ["agent", "console"]);
  assert.deepEqual(compactRepoBadgeLines("nils-agent-console"), ["nils agent", "console"]);
  assert.deepEqual(compactRepoBadgeLines("agent-runtime-kit"), ["agent", "runtime kit"]);
  assert.deepEqual(compactRepoBadgeLines("nils"), ["nils"]);
  assert.deepEqual(compactRepoBadgeLines("  "), ["unknown"]);
});

test("session resume helpers follow the daemon boolean resumable contract", () => {
  assert.equal(isSessionResumeAvailable({ id: "hs-1", status: "stopped", resumable: true }), true);
  assert.equal(sessionStatusLabel({ id: "hs-1", status: "stopped", resumable: true }), "resumable");
  assert.equal(isSessionResumeAvailable({ id: "hs-1", status: "running", resumable: true }), false);
  assert.equal(sessionStatusLabel({ id: "hs-1", status: "running", resumable: true }), "running");
  assert.equal(isSessionResumeAvailable({ id: "hs-1", status: "stopped", resumable: false }), false);
  assert.equal(sessionStatusLabel({ id: "hs-1", status: "stopped", resumable: false }), "stopped");
  assert.equal(isSessionResumeAvailable({ id: "hs-1", status: "resumable" }), false);
  assert.equal(sessionStatusLabel({ id: "hs-1", status: "resumable" }), "unknown");
  assert.equal(isSessionResumeAvailable({ id: "hs-1", status: "resumable", resumable: true }), false);
  assert.equal(sessionStatusLabel({ id: "hs-1", status: "resumable", resumable: true }), "unknown");
  assert.equal(sessionStatusLabel({ id: "hs-1" }), "unknown");
});

test("describeUnreachable summarizes only down machines, else null", () => {
  assert.equal(describeUnreachable([{ name: "summit", ok: true }]), null);
  assert.equal(
    describeUnreachable([
      { name: "summit", ok: true },
      { name: "mesa", ok: false, error: "timeout" },
    ]),
    "mesa: timeout",
  );
  assert.equal(describeUnreachable([{ name: "mesa", ok: false }]), "mesa: unreachable");
});

// formatResetCountdown renders "time until the reset epoch" for the usage panel.
// It takes nowMs explicitly so it stays pure/testable (no Date.now() inside).
const NOW = Date.parse("2026-07-05T00:00:00Z"); // ms

test("formatResetCountdown renders — for a null reset", () => {
  assert.equal(formatResetCountdown(null, NOW), "—");
});

test("formatResetCountdown collapses a past/at reset to 'now'", () => {
  assert.equal(formatResetCountdown(NOW / 1000, NOW), "now");
  assert.equal(formatResetCountdown(NOW / 1000 - 600, NOW), "now");
});

test("formatResetCountdown scales seconds/minutes/hours/days", () => {
  assert.equal(formatResetCountdown(NOW / 1000 + 45, NOW), "45s");
  assert.equal(formatResetCountdown(NOW / 1000 + 42 * 60, NOW), "42m");
  // 2h14m -> hours carry minutes
  assert.equal(formatResetCountdown(NOW / 1000 + (2 * 60 + 14) * 60, NOW), "2h 14m");
  // exact hour drops the trailing 0m
  assert.equal(formatResetCountdown(NOW / 1000 + 3 * 3600, NOW), "3h");
  // 3d4h -> days carry hours
  assert.equal(formatResetCountdown(NOW / 1000 + (3 * 24 + 4) * 3600, NOW), "3d 4h");
  // exact day drops the trailing 0h
  assert.equal(formatResetCountdown(NOW / 1000 + 5 * 86400, NOW), "5d");
});

test("relativeEpochSeconds renders — for null and 'X ago' for a past epoch", () => {
  assert.equal(relativeEpochSeconds(null, NOW), "—");
  assert.equal(relativeEpochSeconds(NOW / 1000 - 90, NOW), "1m ago");
  assert.equal(relativeEpochSeconds(NOW / 1000 - 2 * 3600, NOW), "2h ago");
  // A not-yet-past observation reads as "just now" (delegates to relativeTime).
  assert.equal(relativeEpochSeconds(NOW / 1000 + 30, NOW), "just now");
});
