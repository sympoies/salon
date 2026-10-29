import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { SessionRetitleV3Readiness } from "@agent-console/shared/session-retitle";
import {
  createManualSessionRetitleRequest,
  sessionRetitlePath,
  sessionRetitleErrorMessage,
  sessionRetitleStatusMessage,
  sessionRetitleV3FailureMessage,
  sessionRetitleV3StatusMessage,
} from "../src/sessionRetitle.ts";

test("retitle negotiation selects v3 only when edge and machine both advertise it", () => {
  assert.equal(
    sessionRetitlePath(
      { session_retitle_v2: true, session_retitle_v3: true },
      { session_retitle_v2: true, session_retitle_v3: true },
    ),
    "daemon_v3",
  );
  assert.equal(
    sessionRetitlePath(
      { session_retitle_v2: true, session_retitle_v3: true },
      { session_retitle_v2: true },
    ),
    "daemon_v2",
  );
  assert.equal(
    sessionRetitlePath(
      { session_retitle_v2: true },
      { session_retitle_v2: true, session_retitle_v3: true },
    ),
    "daemon_v2",
  );
  assert.equal(sessionRetitlePath({}, { session_retitle_v2: true }), "legacy_edge");
});

test("manual v2 requests are fresh, fenced, and content-free", () => {
  const first = createManualSessionRetitleRequest({
    session_incarnation: "launch-s1",
    title_revision: 4,
  }, () => "11111111-1111-4111-8111-111111111111");
  const second = createManualSessionRetitleRequest({
    session_incarnation: "launch-s1",
    title_revision: 4,
  }, () => "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(first, {
    schema_version: "agent-session.session-retitle.request.v2",
    trigger: "manual",
    idempotency_key: "console-manual-11111111-1111-4111-8111-111111111111",
    expected_session_incarnation: "launch-s1",
    expected_title_revision: 4,
  });
  assert.notEqual(first?.idempotency_key, second?.idempotency_key);
  assert.equal(JSON.stringify(first).includes("prompt"), false);
  assert.equal(createManualSessionRetitleRequest({ title_revision: 4 }), null);
});

test("readiness reasons render bounded actionable messages", () => {
  assert.match(sessionRetitleV3StatusMessage({ reason_code: "no_usable_objective" } as SessionRetitleV3Readiness), /Send one and try again/);
  assert.match(sessionRetitleErrorMessage("retitle-v3-objective-unavailable"), /Send one and try again/);
  assert.equal(
    sessionRetitleStatusMessage({ status: "unavailable", reason_code: "account_missing", next_action: "select_account" }),
    "Retitle account is unavailable. Select or configure an account on the host.",
  );
  assert.equal(
    sessionRetitleStatusMessage({ status: "degraded", reason_code: "legacy_command_provider", next_action: "migrate_provider" }),
    "Retitle is using the legacy command provider. Migrate the host when convenient.",
  );
  assert.equal(
    sessionRetitleStatusMessage({ status: "degraded", reason_code: "fallback_ready", next_action: "restore_primary" }),
    "Retitle is using the fallback provider while the primary provider is unavailable.",
  );
});

test("v3 outcome messages name the daemon failure class and keep the cached-title wording", () => {
  assert.equal(
    sessionRetitleV3FailureMessage("terminal_failure", "retitle-v3-history-conflict"),
    sessionRetitleErrorMessage("retitle-v3-history-conflict"),
  );
  assert.equal(
    sessionRetitleV3FailureMessage("terminal_failure", "rate_limited"),
    "The retitle provider is rate limited. Wait and try again.",
  );
  assert.equal(
    sessionRetitleV3FailureMessage("terminal_failure"),
    "Retitle could not create a usable title. Inspect the host runtime and try again.",
  );
  assert.equal(
    sessionRetitleV3FailureMessage("terminal_failure", "not_a_known_class"),
    "Retitle failed on the host (not_a_known_class). Inspect the host runtime and try again.",
  );
  assert.equal(
    sessionRetitleV3FailureMessage("degraded_cached"),
    "Retitle refresh is degraded; the existing cached title was preserved.",
  );
  assert.equal(
    sessionRetitleV3FailureMessage("degraded_cached", "timeout"),
    "The existing cached title was preserved. The retitle provider timed out. Try again.",
  );
});

test("a failure class that is also a request error code has exactly one wording", () => {
  // The daemon reports the same condition as a rejected request or as a
  // terminal failure class; the console must not explain it two ways.
  for (const code of [
    "retitle-v3-history-conflict",
    "retitle-v3-history-stale",
    "retitle-v3-state-conflict",
    "retitle-v3-turn-conflict",
  ] as const) {
    assert.equal(sessionRetitleV3FailureMessage("terminal_failure", code), sessionRetitleErrorMessage(code));
  }
});

test("readiness names the model that is actually producing titles", () => {
  assert.equal(
    sessionRetitleStatusMessage({
      status: "degraded",
      reason_code: "fallback_ready",
      next_action: "restore_primary",
      model_label: "qwen3.6-apex-compact",
    }),
    "Retitle is using the fallback provider while the primary provider is unavailable."
      + " Titles are coming from qwen3.6-apex-compact.",
  );
  // Without a label the message is unchanged.
  assert.equal(
    sessionRetitleStatusMessage({
      status: "degraded",
      reason_code: "fallback_ready",
      next_action: "restore_primary",
    }),
    "Retitle is using the fallback provider while the primary provider is unavailable.",
  );
});
