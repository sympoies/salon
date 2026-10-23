import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ACCOUNT_CREATE_TIMEOUT_MS,
  PROMPT_CREATE_TIMEOUT_MS,
  confirmsCreatedAccountBinding,
  createSessionTimeoutMs,
  normalizeAccountNickname,
  normalizeAccountStatus,
  normalizeClaudeAccountStatus,
  normalizeCodexAccountStatus,
} from "../src/api.ts";

const codexBound = {
  schema_version: "agent-session.codex-account.v1",
  supported: true,
  state: "bound",
  selected_account: "alpha",
  selection_source: "explicit",
  revision: 2,
  applied_runtime_id: "launch-1",
} as const;

const claudeBound = {
  ...codexBound,
  schema_version: "agent-session.claude-account.v1",
} as const;

test("one nickname rule covers every account name", () => {
  for (const name of ["galaxy", "20X", "a.b-c_d", "x".repeat(64)]) {
    assert.equal(normalizeAccountNickname(name), name);
  }
  for (const name of ["", "-x", "--format", ".hidden", "_x", "..", "a/b", "x".repeat(65), 7, null]) {
    assert.equal(normalizeAccountNickname(name), null, String(name));
  }
});

test("both providers refuse a session view naming a flag-like account", () => {
  assert.equal(normalizeCodexAccountStatus({ ...codexBound, selected_account: "-x" }), null);
  assert.equal(normalizeClaudeAccountStatus({ ...claudeBound, selected_account: "-x" }), null);
});

test("a malformed next account stays visible as unknown for both providers", () => {
  const next = { account: "beta", revision: 0, state: "queued" };
  assert.deepEqual(normalizeCodexAccountStatus({ ...codexBound, next })?.next?.state, "unknown");
  assert.deepEqual(normalizeClaudeAccountStatus({ ...claudeBound, next })?.next, { revision: 0, state: "unknown" });
});

test("normalizeAccountStatus reads each provider's own view", () => {
  assert.equal(normalizeAccountStatus("codex", codexBound)?.selected_account, "alpha");
  assert.equal(normalizeAccountStatus("claude", claudeBound)?.selected_account, "alpha");
  assert.equal(normalizeAccountStatus("codex", claudeBound), null);
  assert.equal(normalizeAccountStatus("claude", codexBound), null);
});

test("a created binding is confirmed only for the runtime the create started", () => {
  for (const provider of ["codex", "claude"] as const) {
    const account = normalizeAccountStatus(provider, provider === "codex" ? codexBound : claudeBound)!;
    assert.equal(confirmsCreatedAccountBinding(account, "alpha", "launch-1"), true, provider);
    assert.equal(confirmsCreatedAccountBinding(account, "alpha", "launch-2"), false, provider);
    assert.equal(confirmsCreatedAccountBinding(account, "beta", "launch-1"), false, provider);
  }
});

test("a create budget adds the account binding and the prompt paste", () => {
  assert.equal(createSessionTimeoutMs({ agent: "claude" }), undefined);
  assert.equal(createSessionTimeoutMs({ agent: "dsh", prompt: "   " }), undefined);
  assert.equal(createSessionTimeoutMs({ agent: "dsh", prompt: "hi" }), PROMPT_CREATE_TIMEOUT_MS);
  // 5 s DSH launch delay + 15 s pane-ready deadline + paste settle, with margin.
  assert.ok(PROMPT_CREATE_TIMEOUT_MS >= 25_000);
  for (const provider of ["codex", "claude"] as const) {
    const body = { agent: provider, [`${provider}_account`]: "alpha" };
    assert.equal(createSessionTimeoutMs(body), ACCOUNT_CREATE_TIMEOUT_MS[provider]);
    assert.equal(
      createSessionTimeoutMs({ ...body, prompt: "hi" }),
      ACCOUNT_CREATE_TIMEOUT_MS[provider] + PROMPT_CREATE_TIMEOUT_MS,
    );
  }
});

test("a Codex create without a named account keeps the account binding budget", () => {
  // The daemon binds its default Codex account to every Codex create, so a
  // create that names no account still waits for that binding (and, with a
  // prompt, for structured prompt control) before it answers.
  assert.equal(createSessionTimeoutMs({ agent: "codex" }), ACCOUNT_CREATE_TIMEOUT_MS.codex);
  assert.equal(
    createSessionTimeoutMs({ agent: "codex", prompt: "hi" }),
    ACCOUNT_CREATE_TIMEOUT_MS.codex + PROMPT_CREATE_TIMEOUT_MS,
  );
});
