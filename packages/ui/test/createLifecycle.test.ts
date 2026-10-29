import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACCOUNT_CREATE_TIMEOUT_MS, PROMPT_CREATE_TIMEOUT_MS } from "@agent-console/shared/api";
import {
  CREATE_REQUEST_TIMEOUT_MARGIN_MS,
  CreateLifecycleDeadlineError,
  MAX_CREATE_PROMPT_RECOVERIES,
  MAX_CREATE_PROMPT_RECOVERY_BYTES,
  MAX_INITIAL_PROMPT_BYTES,
  boundedInitialPromptUpdate,
  createRequestTimeoutMs,
  initialPromptByteLength,
  promptRecoveryCapacityError,
  requestWithCreateLifecycleDeadline,
  validateInitialPrompt,
} from "../src/createLifecycle.ts";

const createDialogSource = readFileSync(new URL("../src/CreateDialog.tsx", import.meta.url), "utf8");

test("CreateDialog cannot be dismissed by an outside click", () => {
  // The dialog carries unsaved input, so an accidental backdrop click must not
  // discard it. Dismissal is routed through the shared Modal wrapper, which
  // replays an attention pulse on outside clicks instead of closing.
  assert.match(createDialogSource, /<Modal\b[\s\S]*?onClose=\{onClose\}[\s\S]*?busy=\{busy\}/);
  assert.doesNotMatch(createDialogSource, /className="modal-backdrop"/);
});

test("oversized initial-prompt input is rejected without truncating the prior value", () => {
  assert.deepEqual(
    boundedInitialPromptUpdate("complete prior prompt", "a".repeat(MAX_INITIAL_PROMPT_BYTES + 1)),
    {
      prompt: "complete prior prompt",
      error: `Initial prompt is too large (maximum ${MAX_INITIAL_PROMPT_BYTES} UTF-8 bytes).`,
    },
  );
  assert.deepEqual(boundedInitialPromptUpdate("prior", "valid replacement"), {
    prompt: "valid replacement",
    error: null,
  });
  assert.doesNotMatch(createDialogSource, /maxLength=/);
});

test("create lifecycle requests reject and abort at their bounded deadline", async () => {
  let signal: AbortSignal | undefined;
  const pending = requestWithCreateLifecycleDeadline(
    "initial prompt submission",
    (requestSignal) => {
      signal = requestSignal;
      return new Promise<never>(() => {});
    },
    5,
  );

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof CreateLifecycleDeadlineError);
    assert.equal(error.stage, "initial prompt submission");
    return true;
  });
  assert.equal(signal?.aborted, true);
});

test("initial prompt and recovery budgets are byte-based and fail closed", () => {
  assert.equal(MAX_INITIAL_PROMPT_BYTES, 16 * 1024);
  assert.equal(validateInitialPrompt("a".repeat(MAX_INITIAL_PROMPT_BYTES)), null);
  assert.match(
    validateInitialPrompt("a".repeat(MAX_INITIAL_PROMPT_BYTES + 1)) ?? "",
    /too large/i,
  );
  assert.equal(initialPromptByteLength("é"), 2);

  const countBound = Array.from({ length: MAX_CREATE_PROMPT_RECOVERIES }, () => ({ prompt: "retained" }));
  assert.match(promptRecoveryCapacityError(countBound, "next") ?? "", /retained prompts/i);

  const byteBound = [{ prompt: "a".repeat(MAX_CREATE_PROMPT_RECOVERY_BYTES - 1) }];
  assert.equal(promptRecoveryCapacityError(byteBound, "a"), null);
  assert.match(promptRecoveryCapacityError(byteBound, "é") ?? "", /retained prompt storage/i);
});

test("createRequestTimeoutMs outlasts the edge budget for slow create paths", () => {
  assert.equal(createRequestTimeoutMs({ agent: "claude" }), undefined);
  // The daemon binds its default Codex account even when the create names none.
  assert.equal(
    createRequestTimeoutMs({ agent: "codex" }),
    ACCOUNT_CREATE_TIMEOUT_MS.codex + CREATE_REQUEST_TIMEOUT_MARGIN_MS,
  );
  // The edge probes the profile (up to 3 s) and gives a prompt-carrying create 30 s.
  assert.equal(createRequestTimeoutMs({ agent: "claude", prompt: "hi" }), 40_000);
  for (const provider of ["codex", "claude"] as const) {
    const body = { agent: provider, [`${provider}_account`]: "work" };
    assert.equal(
      createRequestTimeoutMs(body),
      ACCOUNT_CREATE_TIMEOUT_MS[provider] + CREATE_REQUEST_TIMEOUT_MARGIN_MS,
    );
    // The daemon binds the account before it pastes the prompt.
    assert.equal(
      createRequestTimeoutMs({ ...body, prompt: "hi" }),
      ACCOUNT_CREATE_TIMEOUT_MS[provider] + PROMPT_CREATE_TIMEOUT_MS + CREATE_REQUEST_TIMEOUT_MARGIN_MS,
    );
  }
});
