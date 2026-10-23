import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyCodexAccountMutationOutcome,
  normalizeCodexAccountReadiness,
  normalizeCodexAccountStatus,
  normalizeAccountSummaries,
} from "../src/api.ts";

test("Codex account status retains only the v1 metadata contract", () => {
  assert.deepEqual(normalizeCodexAccountStatus({
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "bound",
    selected_account: "account-a",
    revision: 4,
    applied_runtime_id: "runtime-7",
    next: {
      account: "account-b",
      revision: 2,
      state: "queued",
      access_token: "must-not-cross-edge",
      provider_account_id: "private-provider-id",
    },
    access_token: "must-not-cross-edge",
  }), {
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "bound",
    selected_account: "account-a",
    revision: 4,
    applied_runtime_id: "runtime-7",
    next: {
      account: "account-b",
      revision: 2,
      state: "queued",
    },
  });
});

test("Codex account status exposes the effective account and selection source", () => {
  assert.deepEqual(normalizeCodexAccountStatus({
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "bound",
    selected_account: "account-a",
    effective_account: "account-a",
    selection_source: "default_at_launch",
    revision: 1,
    applied_runtime_id: "runtime-1",
    private_identity: "drop-me",
  }), {
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "bound",
    selected_account: "account-a",
    effective_account: "account-a",
    selection_source: "default_at_launch",
    revision: 1,
    applied_runtime_id: "runtime-1",
  });
});

test("Codex next account status preserves safe lifecycle states and failure reasons", () => {
  for (const next of [
    { account: "account-b", revision: 2, state: "queued" },
    { account: "account-b", revision: 2, state: "applying" },
    { account: "account-b", revision: 2, state: "failed", failure_reason: "apply_failed" },
  ]) {
    const status = normalizeCodexAccountStatus({
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "account-a",
      revision: 4,
      applied_runtime_id: "runtime-7",
      next: { ...next, auth_path: "/private/auth.json", arbitrary_error: "private daemon text" },
    });
    assert.deepEqual(status?.next, next);
  }
});

test("Codex next account status can establish an unbound session's first explicit account", () => {
  assert.deepEqual(normalizeCodexAccountStatus({
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "unbound",
    revision: 0,
    next: {
      account: "account-b",
      revision: 1,
      state: "queued",
      access_token: "must-not-cross-edge",
    },
  }), {
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "unbound",
    revision: 0,
    next: {
      account: "account-b",
      revision: 1,
      state: "queued",
    },
  });
});

test("Codex account mutation outcomes share one bound and unbound classification contract", () => {
  const bound = {
    schema_version: "agent-session.codex-account.v1" as const,
    supported: true,
    state: "bound" as const,
    selected_account: "account-a",
    revision: 4,
    applied_runtime_id: "runtime-7",
  };
  assert.equal(
    classifyCodexAccountMutationOutcome(
      { ...bound, selected_account: "account-b" },
      "account-b",
      "runtime-7",
    ),
    "applied",
  );
  for (const state of ["queued", "applying", "failed", "unknown"] as const) {
    assert.equal(
      classifyCodexAccountMutationOutcome(
        {
          ...bound,
          next: {
            account: "account-b",
            revision: 2,
            state,
            ...(state === "failed" ? { failure_reason: "apply_failed" as const } : {}),
          },
        },
        "account-b",
        "runtime-7",
      ),
      "bound-next",
      state,
    );
  }
  assert.equal(
    classifyCodexAccountMutationOutcome(
      {
        ...bound,
        selected_account: "account-b",
        next: { account: "account-b", revision: 2, state: "queued" },
      },
      "account-b",
      "runtime-7",
    ),
    "invalid",
  );
  assert.equal(
    classifyCodexAccountMutationOutcome(
      {
        schema_version: "agent-session.codex-account.v1",
        supported: true,
        state: "unbound",
        revision: 0,
        next: { account: "account-b", revision: 1, state: "queued" },
      },
      "account-b",
      "runtime-7",
    ),
    "unbound-queued",
  );
  for (const state of ["applying", "failed", "unknown"] as const) {
    assert.equal(
      classifyCodexAccountMutationOutcome(
        {
          schema_version: "agent-session.codex-account.v1",
          supported: true,
          state: "unbound",
          revision: 0,
          next: {
            account: "account-b",
            revision: 1,
            state,
            ...(state === "failed" ? { failure_reason: "apply_failed" as const } : {}),
          },
        },
        "account-b",
        "runtime-7",
      ),
      "invalid",
      state,
    );
  }
});

test("Codex next account status keeps future and malformed projections visible but non-actionable", () => {
  const base = {
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "bound",
    selected_account: "account-a",
    revision: 4,
    applied_runtime_id: "runtime-7",
  };
  assert.deepEqual(normalizeCodexAccountStatus({
    ...base,
    next: { account: "account-b", revision: 3, state: "future-state", failure_reason: "future-reason" },
  })?.next, {
    account: "account-b",
    revision: 3,
    state: "unknown",
    failure_reason: "unknown",
  });
  assert.deepEqual(normalizeCodexAccountStatus({
    ...base,
    next: { account: "account-b", revision: 3, state: "failed", failure_reason: "future-reason" },
  })?.next, {
    account: "account-b",
    revision: 3,
    state: "failed",
    failure_reason: "unknown",
  });
  for (const next of [
    { account: "../auth.json", revision: 1, state: "queued" },
    { account: "account-b", revision: -1, state: "queued" },
    { account: "account-b", revision: 1.5, state: "queued" },
    { revision: 1, state: "queued" },
    { account: "account-b", revision: 1, state: "queued", failure_reason: "apply_failed" },
    { account: "account-b", revision: 1, state: "failed" },
  ]) {
    assert.deepEqual(normalizeCodexAccountStatus({ ...base, next })?.next, {
      revision: 0,
      state: "unknown",
      failure_reason: "unknown",
    });
  }
});

test("Codex next account status preserves the daemon next-invalid sentinel", () => {
  const status = normalizeCodexAccountStatus({
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "bound",
    selected_account: "account-a",
    revision: 4,
    applied_runtime_id: "runtime-7",
    next: {
      revision: 0,
      state: "failed",
      failure_reason: "next_invalid",
      secret: "must-not-cross-edge",
    },
  });
  assert.deepEqual(status?.next, {
    revision: 0,
    state: "failed",
    failure_reason: "next_invalid",
  });
});

test("Codex account status fails closed on future enums and rejects unsafe nicknames", () => {
  assert.deepEqual(normalizeCodexAccountStatus({
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "future-state",
    revision: 8,
    failure_reason: "future-reason",
  }), {
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "unknown",
    revision: 8,
    failure_reason: "unknown",
  });
  assert.equal(normalizeCodexAccountStatus({
    schema_version: "agent-session.codex-account.v1",
    supported: true,
    state: "bound",
    selected_account: "../auth.json",
    revision: 1,
  }), null);
});

test("Codex account status rejects semantically inconsistent states", () => {
  for (const value of [
    {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "galaxy",
      revision: 0,
      applied_runtime_id: "runtime-7",
    },
    {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "bound",
      selected_account: "galaxy",
      revision: 1,
    },
    {
      schema_version: "agent-session.codex-account.v1",
      supported: true,
      state: "unbound",
      selected_account: "galaxy",
      revision: 1,
    },
    {
      schema_version: "agent-session.codex-account.v1",
      supported: false,
      state: "bound",
      selected_account: "galaxy",
      revision: 1,
      applied_runtime_id: "runtime-7",
    },
  ]) {
    assert.equal(normalizeCodexAccountStatus(value), null);
  }
});

test("Codex account summaries expose nickname labels only", () => {
  assert.deepEqual(normalizeAccountSummaries([
    { account: "galaxy", label: "Galaxy", plan: "team", access_token: "secret" },
    { account: "../bad", label: "bad" },
    { account: "sym", label: "Sym", plan: null },
  ]), [
    { account: "galaxy", label: "Galaxy", plan: "team" },
    { account: "sym", label: "Sym" },
  ]);
});

test("Codex account readiness retains only the bounded capability contract", () => {
  assert.deepEqual(normalizeCodexAccountReadiness({
    schema_version: "agent-session.codex-account-readiness.v1",
    supported: true,
    provider_version: "0.144.5",
    access_token: "must-not-cross-edge",
  }), {
    schema_version: "agent-session.codex-account-readiness.v1",
    supported: true,
    provider_version: "0.144.5",
  });
  assert.deepEqual(normalizeCodexAccountReadiness({
    schema_version: "agent-session.codex-account-readiness.v1",
    supported: false,
    provider_version: "0.143.9",
    reason_code: "codex-version-too-old",
  }), {
    schema_version: "agent-session.codex-account-readiness.v1",
    supported: false,
    provider_version: "0.143.9",
    reason_code: "codex-version-too-old",
  });
});

test("Codex account readiness preserves private runtime failure reasons", () => {
  for (const reason of [
    "codex-app-server-runtime-dir-unavailable", "codex-app-server-runtime-dir-unsafe",
    "codex-app-server-socket-path-too-long", "codex-app-server-runtime-unavailable",
  ]) {
    const readiness = { schema_version: "agent-session.codex-account-readiness.v1", supported: false, reason_code: reason };
    assert.deepEqual(normalizeCodexAccountReadiness(readiness), readiness);
  }
});

test("Codex account readiness fails closed on malformed or inconsistent capability data", () => {
  for (const value of [
    {
      schema_version: "agent-session.codex-account-readiness.v2",
      supported: true,
    },
    {
      schema_version: "agent-session.codex-account-readiness.v1",
      supported: true,
      reason_code: "codex-version-too-old",
    },
    {
      schema_version: "agent-session.codex-account-readiness.v1",
      supported: false,
    },
    {
      schema_version: "agent-session.codex-account-readiness.v1",
      supported: false,
      provider_version: "0.144.5-beta",
      reason_code: "future-reason",
    },
  ]) {
    assert.equal(normalizeCodexAccountReadiness(value), null);
  }
});
