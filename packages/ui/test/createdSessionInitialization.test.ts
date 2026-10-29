import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  defaultAutoResumeForCreate,
  initializeCreatedSession,
  recoverableCreatedPrompt,
  submittedCreatedPrompt,
  type DefaultAutoResumeInitialization,
} from "../src/createdSessionInitialization.ts";
import { CreateLifecycleDeadlineError } from "../src/createLifecycle.ts";
import type { SendSessionInputBody } from "../src/api.ts";

interface SendCall {
  readonly machine: string;
  readonly id: string;
  readonly body: SendSessionInputBody;
}

interface PromptCall {
  readonly machine: string;
  readonly id: string;
  readonly body: {
    readonly text: string;
    readonly expected_session_incarnation?: string;
  };
}

const disabled = { enabled: false } as const;

test("initializeCreatedSession submits a staged prompt only through the fenced provider route", async () => {
  const terminalCalls: SendCall[] = [];
  const promptCalls: PromptCall[] = [];
  const result = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdSessionIncarnation: "created-1-incarnation",
    prompt: "Fix init prompt flow",
    defaultAutoResume: disabled,
    sendSessionInput: async (machine, id, body) => {
      terminalCalls.push({ machine, id, body });
      return { ok: true };
    },
    submitSessionPrompt: async (machine, id, body) => {
      promptCalls.push({ machine, id, body });
      return { ok: true };
    },
  });

  assert.deepEqual(result, {
    autoResume: { status: "skipped", reason: "disabled" },
    prompt: { status: "submitted", session: { machine: "maple", id: "created-1" } },
  });
  assert.deepEqual(terminalCalls, []);
  assert.deepEqual(promptCalls, [{
    machine: "maple",
    id: "created-1",
    body: {
      text: "Fix init prompt flow",
      expected_session_incarnation: "created-1-incarnation",
    },
  }]);
});

test("initializeCreatedSession skips every post-create mutation for a reported startup failure and retains the prompt", async () => {
  const calls: string[] = [];
  const prompt = "Keep this prompt";
  const result = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdStartup: {
      schema_version: "agent-session.startup.v1",
      state: "failed",
      stage: "runtime",
      started_at: "2026-07-14T10:00:00Z",
      failure_code: "agent-binary-unavailable",
      message: "The selected agent CLI could not be started.",
      occurred_at: "2026-07-14T10:00:01Z",
      retry_safe: false,
    },
    prompt,
    defaultAutoResume: {
      enabled: true,
      setSessionAutoResume: async () => {
        calls.push("auto-resume");
        return { ok: true };
      },
    },
    sendSessionInput: async () => {
      calls.push("submit");
      return { ok: true };
    },
  });

  assert.deepEqual(result, {
    autoResume: { status: "skipped", reason: "startup-failed" },
    prompt: { status: "skipped", reason: "startup-failed" },
  });
  assert.deepEqual(calls, []);
  assert.equal(recoverableCreatedPrompt(prompt, result), prompt);
  assert.equal(submittedCreatedPrompt(prompt, result), null);
});

test("initializeCreatedSession fails closed for invalid startup metadata and unfenced prompt submission", async () => {
  const calls: string[] = [];
  const invalidResult = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdStartup: null,
    prompt: "Keep this prompt",
    defaultAutoResume: {
      enabled: true,
      setSessionAutoResume: async () => {
        calls.push("invalid-auto-resume");
        return { ok: true };
      },
    },
    sendSessionInput: async () => {
      calls.push("invalid-submit");
      return { ok: true };
    },
  });
  assert.deepEqual(invalidResult, {
    autoResume: { status: "skipped", reason: "startup-unknown" },
    prompt: { status: "skipped", reason: "startup-unknown" },
  });

  const unfencedResult = await initializeCreatedSession({
    machine: "maple",
    createdId: "old-created",
    prompt: "Retain for old daemon",
    defaultAutoResume: {
      enabled: true,
      setSessionAutoResume: async () => {
        calls.push("old-auto-resume");
        return { ok: true };
      },
    },
    sendSessionInput: async () => {
      calls.push("old-terminal-submit");
      return { ok: true };
    },
    submitSessionPrompt: async () => {
      calls.push("old-structured-submit");
      return { ok: true };
    },
  });
  assert.deepEqual(unfencedResult, {
    autoResume: {
      status: "enabled",
      session: { machine: "maple", id: "old-created" },
    },
    prompt: {
      status: "failed",
      session: { machine: "maple", id: "old-created" },
      error: "Initial prompt submission requires an authoritative runtime incarnation; copy and submit this retained prompt manually.",
    },
  });
  assert.deepEqual(calls, ["old-auto-resume"]);
});

test("initializeCreatedSession retains a prompt whose submission outcome is unknown", async () => {
  const prompt = "Fix init prompt flow";
  const result = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdSessionIncarnation: "created-1-incarnation",
    prompt,
    defaultAutoResume: disabled,
    sendSessionInput: async () => ({ ok: true }),
    submitSessionPrompt: async () => {
      throw new CreateLifecycleDeadlineError("Initial prompt submission");
    },
  });

  assert.deepEqual(result, {
    autoResume: { status: "skipped", reason: "disabled" },
    prompt: {
      status: "unknown",
      session: { machine: "maple", id: "created-1" },
      error: "Initial prompt submission outcome is unknown; check the created session before submitting the retained prompt manually.",
    },
  });
  assert.equal(recoverableCreatedPrompt(prompt, result), prompt);
  assert.equal(submittedCreatedPrompt(prompt, result), null);
});

test("initializeCreatedSession treats a server-indeterminate send as unknown", async () => {
  const prompt = "Fix init prompt flow";
  const result = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdSessionIncarnation: "created-1-incarnation",
    prompt,
    defaultAutoResume: disabled,
    sendSessionInput: async () => ({ ok: true }),
    submitSessionPrompt: async () => ({
      ok: false,
      error: "upstream timeout",
      outcomeUnknown: true,
    }),
  });

  assert.equal(result.prompt.status, "unknown");
  assert.equal(recoverableCreatedPrompt(prompt, result), prompt);
  assert.equal(submittedCreatedPrompt(prompt, result), null);
});

test("initializeCreatedSession submits single-line and multiline Codex prompts through the structured route", async () => {
  const prompts = [
    "https://github.com/sampleRepo/agent-runtime-kit/issues/657 處理掉這個 issue 要考慮到 codex 的情況 反正有 .tera 能做不同版本的規則對吧",
    "line one\nline two",
  ];
  for (const prompt of prompts) {
    const sendCalls: SendCall[] = [];
    const promptCalls: PromptCall[] = [];
    const result = await initializeCreatedSession({
      machine: "maple",
      createdId: "created-1",
      createdSessionIncarnation: "created-1-incarnation",
      agent: "codex",
      prompt,
      defaultAutoResume: disabled,
      sendSessionInput: async (machine, id, body) => {
        sendCalls.push({ machine, id, body });
        return { ok: true };
      },
      submitSessionPrompt: async (machine, id, body) => {
        promptCalls.push({ machine, id, body });
        return { ok: true };
      },
    });

    assert.deepEqual(result, {
      autoResume: { status: "skipped", reason: "disabled" },
      prompt: { status: "submitted", session: { machine: "maple", id: "created-1" } },
    });
    assert.deepEqual(sendCalls, []);
    assert.deepEqual(promptCalls, [{
      machine: "maple",
      id: "created-1",
      body: {
        text: prompt,
        expected_session_incarnation: "created-1-incarnation",
      },
    }]);
  }
});

test("initializeCreatedSession retains unsupported Claude prompts without terminal fallback", async () => {
  const sendCalls: SendCall[] = [];
  const promptCalls: PromptCall[] = [];
  const prompt = "line one\nline two";

  const result = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdSessionIncarnation: "created-1-incarnation",
    agent: "claude",
    prompt,
    defaultAutoResume: disabled,
    sendSessionInput: async (machine, id, body) => {
      sendCalls.push({ machine, id, body });
      return { ok: true };
    },
    submitSessionPrompt: async (machine, id, body) => {
      promptCalls.push({ machine, id, body });
      return { ok: false, error: "this session does not provide structured prompt submission" };
    },
  });

  assert.deepEqual(result, {
    autoResume: { status: "skipped", reason: "disabled" },
    prompt: {
      status: "failed",
      session: { machine: "maple", id: "created-1" },
      error: "this session does not provide structured prompt submission",
    },
  });
  assert.deepEqual(sendCalls, []);
  assert.deepEqual(promptCalls, [{
    machine: "maple",
    id: "created-1",
    body: {
      text: prompt,
      expected_session_incarnation: "created-1-incarnation",
    },
  }]);
});

test("initializeCreatedSession retains Codex prompts rejected by an old daemon without terminal fallback", async () => {
  const prompt = "line one\nline two";
  const sendCalls: SendCall[] = [];
  const promptCalls: PromptCall[] = [];
  const result = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdSessionIncarnation: "created-1-incarnation",
    agent: "codex",
    prompt,
    defaultAutoResume: disabled,
    sendSessionInput: async (machine, id, body) => {
      sendCalls.push({ machine, id, body });
      return { ok: true };
    },
    submitSessionPrompt: async (machine, id, body) => {
      promptCalls.push({ machine, id, body });
      return { ok: false, error: "structured prompt endpoint unavailable" };
    },
  });

  assert.deepEqual(result, {
    autoResume: { status: "skipped", reason: "disabled" },
    prompt: {
      status: "failed",
      session: { machine: "maple", id: "created-1" },
      error: "structured prompt endpoint unavailable",
    },
  });
  assert.deepEqual(sendCalls, []);
  assert.deepEqual(promptCalls, [{
    machine: "maple",
    id: "created-1",
    body: {
      text: prompt,
      expected_session_incarnation: "created-1-incarnation",
    },
  }]);
  assert.equal(recoverableCreatedPrompt(prompt, result), prompt);
});

test("initializeCreatedSession keeps an indeterminate Codex prompt recoverable without terminal fallback", async () => {
  const prompt = "Inspect structured submission";
  let terminalSendCalled = false;
  const result = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdSessionIncarnation: "created-1-incarnation",
    agent: "codex",
    prompt,
    defaultAutoResume: disabled,
    sendSessionInput: async () => {
      terminalSendCalled = true;
      return { ok: true };
    },
    submitSessionPrompt: async () => ({
      ok: false,
      error: "provider acknowledgement timed out",
      outcomeUnknown: true,
    }),
  });

  assert.equal(result.prompt.status, "unknown");
  assert.equal(terminalSendCalled, false);
  assert.equal(recoverableCreatedPrompt(prompt, result), prompt);
  assert.equal(submittedCreatedPrompt(prompt, result), null);
});

test("initializeCreatedSession retains prompts containing unsafe terminal controls", async () => {
  const prompts = [
    "line one\rline two",
    "word\tcompletion",
    "nul\u0000byte",
    "delete\u007fbyte",
    "first\u001b[201~/command",
  ];
  for (const prompt of prompts) {
    const calls: SendCall[] = [];
    const result = await initializeCreatedSession({
      machine: "maple",
      createdId: "created-1",
      prompt,
      defaultAutoResume: disabled,
      sendSessionInput: async (machine, id, body) => {
        calls.push({ machine, id, body });
        return { ok: true };
      },
    });

    assert.deepEqual(result, {
      autoResume: { status: "skipped", reason: "disabled" },
      prompt: {
        status: "failed",
        session: { machine: "maple", id: "created-1" },
        error: "Initial prompts containing unsafe terminal controls were not submitted; copy and submit this retained prompt manually.",
      },
    });
    assert.deepEqual(calls, []);
    assert.equal(recoverableCreatedPrompt(prompt, result), prompt);
  }
});

test("initializeCreatedSession enables default auto-resume before provider submission", async () => {
  const calls: string[] = [];
  const result = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdSessionIncarnation: "created-1-incarnation",
    prompt: "Continue the task",
    defaultAutoResume: {
      enabled: true,
      setSessionAutoResume: async (machine, id, enabled) => {
        calls.push(`auto-resume ${machine}/${id} ${enabled}`);
        return { ok: true };
      },
    },
    sendSessionInput: async () => ({ ok: true }),
    submitSessionPrompt: async (machine, id, body) => {
      calls.push(`submit ${machine}/${id}`);
      assert.deepEqual(body, {
        text: "Continue the task",
        expected_session_incarnation: "created-1-incarnation",
      });
      return { ok: true };
    },
  });

  assert.deepEqual(result, {
    autoResume: { status: "enabled", session: { machine: "maple", id: "created-1" } },
    prompt: { status: "submitted", session: { machine: "maple", id: "created-1" } },
  });
  assert.deepEqual(calls, ["auto-resume maple/created-1 true", "submit maple/created-1"]);
});

test("initializeCreatedSession reports auto-resume failure but still submits through provider control", async () => {
  const calls: string[] = [];
  const result = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdSessionIncarnation: "created-1-incarnation",
    prompt: "Continue the task",
    defaultAutoResume: {
      enabled: true,
      setSessionAutoResume: async () => {
        calls.push("auto-resume");
        return { ok: false, error: "unsupported runtime" };
      },
    },
    sendSessionInput: async () => ({ ok: true }),
    submitSessionPrompt: async () => {
      calls.push("submit");
      return { ok: true };
    },
  });

  assert.deepEqual(result, {
    autoResume: {
      status: "failed",
      session: { machine: "maple", id: "created-1" },
      error: "Default auto-resume could not be enabled: unsupported runtime",
    },
    prompt: { status: "submitted", session: { machine: "maple", id: "created-1" } },
  });
  assert.deepEqual(calls, ["auto-resume", "submit"]);
});

test("initializeCreatedSession suppresses prompt submission when auto-resume outcome is unknown", async () => {
  const calls: string[] = [];
  const result = await initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdSessionIncarnation: "created-1-incarnation",
    prompt: "Continue the task",
    defaultAutoResume: {
      enabled: true,
      setSessionAutoResume: async () => {
        calls.push("auto-resume");
        return { ok: false, error: "auto-resume outcome is unknown", outcomeUnknown: true };
      },
    },
    sendSessionInput: async () => {
      calls.push("submit");
      return { ok: true };
    },
  });

  assert.deepEqual(result, {
    autoResume: {
      status: "unknown",
      session: { machine: "maple", id: "created-1" },
      error: "Default auto-resume outcome is unknown; the initial prompt was not submitted. Check the session and submit it manually.",
    },
    prompt: { status: "skipped", reason: "auto-resume-outcome-unknown" },
  });
  assert.deepEqual(calls, ["auto-resume"]);
});

test("initializeCreatedSession waits for authoritative auto-resume before provider submission", async () => {
  const calls: string[] = [];
  let resolveAutoResume!: (result: { ok: true }) => void;
  const autoResume = new Promise<{ ok: true }>((resolve) => {
    resolveAutoResume = resolve;
  });
  const resultPromise = initializeCreatedSession({
    machine: "maple",
    createdId: "created-1",
    createdSessionIncarnation: "created-1-incarnation",
    prompt: "Continue the task",
    defaultAutoResume: {
      enabled: true,
      setSessionAutoResume: async () => {
        calls.push("auto-resume");
        return autoResume;
      },
    },
    sendSessionInput: async () => ({ ok: true }),
    submitSessionPrompt: async () => {
      calls.push("submit");
      return { ok: true };
    },
  });

  await Promise.resolve();
  assert.deepEqual(calls, ["auto-resume"]);
  resolveAutoResume({ ok: true });
  const result = await resultPromise;

  assert.deepEqual(result, {
    autoResume: { status: "enabled", session: { machine: "maple", id: "created-1" } },
    prompt: { status: "submitted", session: { machine: "maple", id: "created-1" } },
  });
  assert.deepEqual(calls, ["auto-resume", "submit"]);
});

test("initializeCreatedSession refuses post-create mutation without an authoritative id", async () => {
  const calls: string[] = [];
  const result = await initializeCreatedSession({
    machine: "maple",
    prompt: "",
    defaultAutoResume: {
      enabled: true,
      setSessionAutoResume: async (machine, id) => {
        calls.push(`auto-resume ${machine}/${id}`);
        return { ok: true };
      },
    },
    sendSessionInput: async () => {
      calls.push("submit");
      return { ok: true };
    },
  });

  assert.deepEqual(result, {
    autoResume: { status: "skipped", reason: "no-session" },
    prompt: { status: "skipped", reason: "blank-prompt" },
  });
  assert.deepEqual(calls, []);
});

test("initializeCreatedSession reports unresolved targets and prompt send failures", async () => {
  assert.deepEqual(
    await initializeCreatedSession({
      machine: "maple",
      prompt: "Fix init prompt flow",
      defaultAutoResume: { enabled: true, setSessionAutoResume: async () => ({ ok: true }) },
      sendSessionInput: async () => ({ ok: true }),
    }),
    {
      autoResume: { status: "skipped", reason: "no-session" },
      prompt: { status: "skipped", reason: "no-session" },
    },
  );

  assert.deepEqual(
    await initializeCreatedSession({
      machine: "maple",
      createdId: "created-1",
      createdSessionIncarnation: "created-1-incarnation",
      prompt: "Fix init prompt flow",
      defaultAutoResume: disabled,
      sendSessionInput: async () => ({ ok: true }),
      submitSessionPrompt: async () => ({ ok: false, error: "session-not-running" }),
    }),
    {
      autoResume: { status: "skipped", reason: "disabled" },
      prompt: {
        status: "failed",
        session: { machine: "maple", id: "created-1" },
        error: "session-not-running",
      },
    },
  );
});

test("recoverableCreatedPrompt retains only nonblank prompts that were not submitted", () => {
  const session = { machine: "maple", id: "created-1" };
  const skippedAutoResume = { status: "skipped", reason: "disabled" } as const;

  assert.equal(recoverableCreatedPrompt("Keep this", {
    autoResume: { status: "skipped", reason: "no-session" },
    prompt: { status: "skipped", reason: "no-session" },
  }), "Keep this");
  assert.equal(recoverableCreatedPrompt("Keep this", {
    autoResume: { status: "unknown", session, error: "unknown" },
    prompt: { status: "skipped", reason: "auto-resume-outcome-unknown" },
  }), "Keep this");
  assert.equal(recoverableCreatedPrompt("Keep this", {
    autoResume: skippedAutoResume,
    prompt: { status: "failed", session, error: "send failed" },
  }), "Keep this");
  assert.equal(recoverableCreatedPrompt("Clear this", {
    autoResume: skippedAutoResume,
    prompt: { status: "submitted", session },
  }), null);
  assert.equal(recoverableCreatedPrompt("   ", {
    autoResume: skippedAutoResume,
    prompt: { status: "skipped", reason: "blank-prompt" },
  }), null);
});

test("submittedCreatedPrompt gates prompt-derived work on confirmed submission", () => {
  const session = { machine: "maple", id: "created-1" };
  const skippedAutoResume = { status: "skipped", reason: "disabled" } as const;

  assert.equal(submittedCreatedPrompt("Ran successfully", {
    autoResume: skippedAutoResume,
    prompt: { status: "submitted", session },
  }), "Ran successfully");
  assert.equal(submittedCreatedPrompt("Do not title this", {
    autoResume: skippedAutoResume,
    prompt: { status: "failed", session, error: "send failed" },
  }), null);
  assert.equal(submittedCreatedPrompt("Do not title this", {
    autoResume: { status: "unknown", session, error: "unknown" },
    prompt: { status: "skipped", reason: "auto-resume-outcome-unknown" },
  }), null);
});

test("defaultAutoResumeForCreate centralizes fresh supported-session eligibility", () => {
  const setter: Extract<DefaultAutoResumeInitialization, { enabled: true }>["setSessionAutoResume"] =
    async () => ({ ok: true });

  assert.deepEqual(defaultAutoResumeForCreate(false, { agent: "codex" }, setter), { enabled: false });
  assert.deepEqual(
    defaultAutoResumeForCreate(true, { agent: "codex", provider_resume_id: "existing" }, setter),
    { enabled: false },
  );
  assert.deepEqual(defaultAutoResumeForCreate(true, { agent: "codex" }, setter), {
    enabled: true,
    setSessionAutoResume: setter,
  });
  assert.deepEqual(defaultAutoResumeForCreate(true, { agent: "claude" }, setter), {
    enabled: true,
    setSessionAutoResume: setter,
  });
});
