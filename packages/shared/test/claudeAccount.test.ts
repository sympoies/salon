import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyClaudeAccountMutationOutcome,
  normalizeAgentSessionCapabilities,
  normalizeClaudeAccountStatus,
  normalizeAccountSummaries,
  projectPublicAgentSession,
} from "../src/api.ts";

const bound = {
  schema_version: "agent-session.claude-account.v1",
  supported: true,
  state: "bound",
  selected_account: "alpha",
  selection_source: "explicit",
  revision: 2,
  applied_runtime_id: "launch-1",
} as const;

test("Claude account status keeps only the path-free v1 view", () => {
  assert.deepEqual(normalizeClaudeAccountStatus({
    ...bound,
    config_dir: "/home/runner/.claude-accounts/alpha",
    next: { account: "beta", revision: 3, state: "queued", config_dir: "/private" },
    access_token: "must-not-cross-edge",
  }), {
    ...bound,
    next: { account: "beta", revision: 3, state: "queued" },
  });
});

test("Claude account status accepts unbound, unsupported, and invalid-binding views", () => {
  assert.deepEqual(normalizeClaudeAccountStatus({
    schema_version: "agent-session.claude-account.v1",
    supported: true,
    state: "unbound",
    revision: 0,
  }), {
    schema_version: "agent-session.claude-account.v1",
    supported: true,
    state: "unbound",
    revision: 0,
  });
  assert.equal(normalizeClaudeAccountStatus({
    ...bound,
    supported: false,
    state: "unsupported",
  })?.state, "unsupported");
  assert.deepEqual(normalizeClaudeAccountStatus({
    schema_version: "agent-session.claude-account.v1",
    supported: true,
    state: "failed",
    revision: 0,
    failure_reason: "binding_invalid",
    next: { revision: 0, state: "failed" },
  }), {
    schema_version: "agent-session.claude-account.v1",
    supported: true,
    state: "failed",
    revision: 0,
    failure_reason: "binding_invalid",
    next: { revision: 0, state: "failed" },
  });
});

test("Claude account status fails closed on malformed or foreign views", () => {
  for (const value of [
    null,
    [],
    { ...bound, schema_version: "agent-session.codex-account.v1" },
    { ...bound, supported: "yes" },
    { ...bound, selected_account: "../escape" },
    { ...bound, revision: -1 },
    { ...bound, state: "bound", selected_account: undefined },
    { ...bound, supported: true, state: "unsupported" },
    { ...bound, supported: false, state: "bound" },
  ]) {
    assert.equal(normalizeClaudeAccountStatus(value), null, JSON.stringify(value));
  }
});

test("Claude account summaries are nickname-only and drop unsafe entries", () => {
  assert.deepEqual(normalizeAccountSummaries([
    { account: "alpha", label: "Alpha", plan: "max", config_dir: "/private" },
    { account: "alpha", label: "Duplicate" },
    { account: "../bad" },
    { account: "beta" },
  ]), [
    { account: "alpha", label: "Alpha", plan: "max" },
    { account: "beta" },
  ]);
});

test("Claude account mutations confirm an applied switch or a queued next account only", () => {
  assert.equal(
    classifyClaudeAccountMutationOutcome({ ...bound, applied_runtime_id: "launch-2" }, "alpha", "launch-1", "launch-2"),
    "applied",
  );
  assert.equal(
    classifyClaudeAccountMutationOutcome(
      normalizeClaudeAccountStatus({ ...bound, next: { account: "beta", revision: 3, state: "queued" } })!,
      "beta",
      "launch-1",
      "launch-1",
    ),
    "queued",
  );
  assert.equal(
    classifyClaudeAccountMutationOutcome(
      normalizeClaudeAccountStatus({
        schema_version: "agent-session.claude-account.v1",
        supported: true,
        state: "unbound",
        revision: 0,
        next: { account: "beta", revision: 1, state: "queued" },
      })!,
      "beta",
      "launch-1",
      "launch-1",
    ),
    "queued",
  );
  // A queued answer must echo the fenced incarnation; an applied one must name
  // the runtime it now runs on.
  assert.equal(
    classifyClaudeAccountMutationOutcome(
      normalizeClaudeAccountStatus({ ...bound, next: { account: "beta", revision: 3, state: "queued" } })!,
      "beta",
      "launch-1",
      "launch-other",
    ),
    "invalid",
  );
  assert.equal(classifyClaudeAccountMutationOutcome(bound, "alpha", "launch-1", "launch-2"), "invalid");
  assert.equal(classifyClaudeAccountMutationOutcome(bound, "beta", "launch-1", "launch-1"), "invalid");
});

test("Claude account switch capability and session view are additive", () => {
  assert.deepEqual(normalizeAgentSessionCapabilities({ claude_account_switch: true }), {
    claude_account_switch: true,
  });
  assert.deepEqual(normalizeAgentSessionCapabilities({ claude_account_switch: "true" }), {});
  const projected = projectPublicAgentSession({
    id: "c1",
    agent: "claude",
    claude_account: { ...bound, config_dir: "/private" },
  });
  assert.deepEqual(projected.claude_account, bound);
  assert.equal(projectPublicAgentSession({ id: "c1", agent: "claude" }).claude_account, undefined);
  assert.equal(projectPublicAgentSession({ id: "c1", agent: "claude", claude_account: { bad: true } }).claude_account, null);
});
