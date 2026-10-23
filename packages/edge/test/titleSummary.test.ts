import { strict as assert } from "node:assert";
import { test } from "node:test";
import { composeTitle } from "@agent-console/shared/title";
import {
  summarizeTitle,
  summarizeTitleWithDiagnostics,
  fallbackTitleSummary,
  titleSummarizerChildEnv,
  type TitleSummarizerCommandRunner,
} from "../src/titleSummary.ts";

function controlledRunner(
  output: string,
  inspect?: (input: Record<string, unknown>) => void,
): TitleSummarizerCommandRunner {
  return async (_config, input) => {
    inspect?.(JSON.parse(input) as Record<string, unknown>);
    return output;
  };
}

test("fallbackTitleSummary appends prompt text to the base title", () => {
  const out = fallbackTitleSummary({ baseTitle: "agent-console", prompt: "Fix auto titles\nwith details" });
  assert.equal(out.title, "agent-console - Fix auto titles");
  assert.equal(out.source, "fallback");
});

test("fallbackTitleSummary suppresses credential-like prompt lines", () => {
  assert.deepEqual(fallbackTitleSummary({
    baseTitle: "agent-console",
    prompt: "AUTHORIZATION=Bearer abcdef1234567890",
  }), {
    title: "agent-console",
    titleState: {
      topic: "agent-console",
      topic_source: "user",
      references: [],
      activity: null,
    },
    source: "fallback",
  });
  assert.deepEqual(fallbackTitleSummary({
    baseTitle: null,
    prompt: "sk-proj-1234567890abcdef",
  }), {
    title: null,
    titleState: {
      topic: null,
      topic_source: "none",
      references: [],
      activity: null,
    },
    source: "fallback",
  });
  assert.deepEqual(fallbackTitleSummary({
    baseTitle: null,
    prompt: "api https://example.test key=hunter2",
  }), {
    title: null,
    titleState: {
      topic: null,
      topic_source: "none",
      references: [],
      activity: null,
    },
    source: "fallback",
  });
});

test("summarizeTitle sends URL-leading task text but rejects credential-bearing URLs", async () => {
  const prompt = "https://github.com/example-user/agent-runtime-kit/issues/657 處理掉這個 issue 要考慮到 codex 的情況 反正有 .tera 能做不同版本的規則對吧";
  let receivedPrompt: unknown;
  const result = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: null,
    prompt,
  }, controlledRunner("處理 agent runtime issue", (input) => {
    receivedPrompt = input.prompt;
  }));

  assert.equal(receivedPrompt, "處理掉這個 issue 要考慮到 codex 的情況 反正有 .tera 能做不同版本的規則對吧");
  assert.equal(result.source, "summarizer");
  assert.equal(result.title, "處理 agent runtime issue");

  for (const sensitivePrompt of [
    "https://alice:hunter2@example.com/issues/657 Fix the issue",
    "https://example.test/issues/657?token=secret-value Fix the issue",
  ]) {
    let runnerCalled = false;
    const sensitiveResult = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      baseTitle: null,
      prompt: sensitivePrompt,
    }, controlledRunner("Must not run", () => { runnerCalled = true; }));
    assert.equal(runnerCalled, false, sensitivePrompt);
    assert.equal(sensitiveResult.title, null, sensitivePrompt);
  }
});

test("summarizeTitle evolves automatic topics but never rewrites a user topic", async () => {
  const output = JSON.stringify({
    topic_action: "set",
    topic: "Structured retitles",
    activity: "Implement issue #317",
  });
  const auto = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: null, topic_source: "none", references: [], activity: "Discuss naming" },
    prompt: "Implement issue #317",
  }, controlledRunner(output));
  assert.deepEqual(auto.titleState, {
    topic: "Structured retitles",
    topic_source: "auto",
    references: ["#317"],
    activity: "Implement issue",
  });
  assert.equal(auto.title, "Structured retitles #317 - Implement issue");

  const evolved = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: auto.titleState,
    prompt: "Prepare PR #412",
  }, controlledRunner(JSON.stringify({
    topic_action: "set",
    topic: "Retitle rollout",
    activity: "Prepare PR #412",
  })));
  assert.deepEqual(evolved.titleState, {
    topic: "Retitle rollout",
    topic_source: "auto",
    references: ["#412"],
    activity: "Prepare PR",
  });

  const user = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: "My fixed title", topic_source: "user", references: [], activity: null },
    prompt: "Implement issue #317",
  }, controlledRunner(output));
  assert.equal(user.titleState?.topic, "My fixed title");
  assert.equal(user.titleState?.topic_source, "user");
});

test("summarizeTitle repairs an automatic topic that already ends with its activity", async () => {
  const duplicatedTopic = "qm-ai project setup — Implement MAPLE.4 rejection detection";
  const activity = "Implement MAPLE.4 rejection detection";
  for (const [nextActivity, expectedTitle] of [
    [activity, `qm-ai project setup - ${activity}`],
    ["Verify MAPLE.5 validation", "qm-ai project setup - Verify MAPLE.5 validation"],
    [null, "qm-ai project setup"],
  ] as const) {
    const output = JSON.stringify({
      topic_action: "keep",
      topic: null,
      activity: nextActivity,
    });

    const auto = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      titleState: {
        topic: duplicatedTopic,
        topic_source: "auto",
        references: [],
        activity,
      },
      currentTitle: `${duplicatedTopic} - ${activity}`,
      prompt: "Generate a concise title for this session from the current title and recent terminal output.",
      recentOutput: "Continue implementing and validating the current milestone.",
    }, controlledRunner(output));

    assert.deepEqual(auto.titleState, {
      topic: "qm-ai project setup",
      topic_source: "auto",
      references: [],
      activity: nextActivity,
    });
    assert.equal(auto.title, expectedTitle);
  }

  for (const [nextActivity, expectedTitle] of [
    ["Verify MAPLE.5 validation", "qm-ai project setup - Verify MAPLE.5 validation"],
    [null, "qm-ai project setup"],
  ] as const) {
    const auto = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      titleState: {
        topic: duplicatedTopic,
        topic_source: "auto",
        references: [],
        activity,
      },
      prompt: "Generate a concise title for this session from the current title and recent terminal output.",
      recentOutput: "Continue implementing and validating the current milestone.",
    }, controlledRunner(JSON.stringify({
      topic_action: "set",
      topic: duplicatedTopic,
      activity: nextActivity,
    })));

    assert.equal(auto.titleState?.topic, "qm-ai project setup");
    assert.equal(auto.title, expectedTitle);
  }

  const output = JSON.stringify({
    topic_action: "keep",
    topic: null,
    activity,
  });

  const user = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: {
      topic: duplicatedTopic,
      topic_source: "user",
      references: [],
      activity,
    },
    prompt: "Keep the explicit user title while refreshing activity.",
  }, controlledRunner(output));

  assert.equal(user.titleState?.topic, duplicatedTopic);
  assert.equal(user.titleState?.topic_source, "user");
});

test("summarizeTitle keeps sensitive structured state out of model input", async () => {
  let receivedInput: Record<string, unknown> | undefined;
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: {
      topic: "TOKEN=secret-value",
      topic_source: "user",
      references: ["#317"],
      activity: "Inspect /home/runner/private/repo",
    },
    currentTitle: "TOKEN=secret-value - Inspect /home/runner/private/repo",
    prompt: "Continue issue #317",
  }, controlledRunner(
    JSON.stringify({ topic_action: "keep", topic: null, activity: "Continue issue #317" }),
    (input) => { receivedInput = input; },
  ));

  assert.deepEqual(receivedInput?.title_state, {
    topic: null,
    topic_source: "user",
    references: ["#317"],
    activity: null,
  });
  assert.equal(receivedInput?.current_title, undefined);
  assert.equal(JSON.stringify(receivedInput).includes("secret-value"), false);
  assert.equal(JSON.stringify(receivedInput).includes("/home/runner"), false);
  assert.equal(out.titleState?.topic, "TOKEN=secret-value");
});

test("summarizeTitle keeps private paths out of every model and output field", async () => {
  // A path never reaches the model or the title, but the task words around it
  // still do: the line describes the work, and only the path is private.
  for (const path of [
    "/private/var/folders/secret/work",
    "~/workspace/private/work",
    "C:\\Users\\tess\\Project\\private\\work",
    "path:/home/runner/private/work",
    "`/home/runner/private/work`",
    "file:///home/runner/private/work",
    "file://localhost/home/runner/private/work",
    "/secret",
    "/secret now",
  ]) {
    let receivedPromptInput: Record<string, unknown> | undefined;
    const result = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      titleState: { topic: null, topic_source: "none", references: [], activity: null },
      prompt: `Inspect ${path}`,
    }, controlledRunner(
      JSON.stringify({ topic_action: "set", topic: "Inspection", activity: "Inspecting" }),
      (input) => { receivedPromptInput = input; },
    ));
    assert.equal(JSON.stringify(receivedPromptInput ?? {}).includes(path), false, path);
    assert.equal(JSON.stringify(result).includes(path), false, path);
    assert.equal(String(receivedPromptInput?.prompt ?? "").includes("Inspect"), true, path);
    assert.equal(result.source, "summarizer", path);
  }

  let privatePromptInput: Record<string, unknown> | undefined;
  const privatePrompt = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: null, topic_source: "none", references: [], activity: null },
    prompt: "Inspect /root/.ssh/config",
  }, controlledRunner(
    JSON.stringify({ topic_action: "set", topic: "Inspection", activity: "Inspecting" }),
    (input) => { privatePromptInput = input; },
  ));
  assert.equal(JSON.stringify(privatePromptInput ?? {}).includes("/root"), false);
  assert.equal(JSON.stringify(privatePrompt).includes("/root"), false);

  // A prompt that is only a path leaves no task words, so it stays vetoed.
  let pathOnlyPromptRan = false;
  const pathOnly = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: null, topic_source: "none", references: [], activity: null },
    prompt: "/home/runner/private/work/notes.md",
  }, controlledRunner("unused", () => { pathOnlyPromptRan = true; }));
  assert.equal(pathOnlyPromptRan, false);
  assert.equal(pathOnly.source, "fallback");
  assert.equal(JSON.stringify(pathOnly).includes("/home/runner"), false);

  let receivedInput: Record<string, unknown> | undefined;
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: null, topic_source: "none", references: [], activity: null },
    prompt: "Review normal output",
    recentOutput: "cwd=/home/runner/private/repo\nReview normal output",
  }, controlledRunner(
    JSON.stringify({ topic_action: "keep", topic: null, activity: "Read ~/.ssh/config" }),
    (input) => { receivedInput = input; },
  ));

  assert.equal(JSON.stringify(receivedInput).includes("/home/runner"), false);
  assert.equal(JSON.stringify(receivedInput).includes("~/.ssh"), false);
  assert.notEqual(out.titleState?.activity, "Read ~/.ssh/config");

  let receivedCommandInput: Record<string, unknown> | undefined;
  await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: "/review /home/runner/private/work",
    currentTitle: "/review /home/runner/private/work - Inspecting",
    prompt: "Review safe output",
  }, controlledRunner("Reviewing output", (input) => { receivedCommandInput = input; }));
  assert.equal(JSON.stringify(receivedCommandInput).includes("/home/runner/private/work"), false);

  for (const path of [
    "//home/runner/private/work",
    "///home/runner/private/work",
    "-I/home/runner/private/work",
    "-isystem/home/runner/private/work",
    "--sysroot=///home/runner/private/work",
    "file://localhost/home/runner/private/work",
  ]) {
    let receivedBypassInput: Record<string, unknown> | undefined;
    const bypassOutput = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      baseTitle: `/review ${path}`,
      currentTitle: `/review ${path} - Inspecting`,
      prompt: "Review safe output",
    }, controlledRunner(
      JSON.stringify({ topic_action: "keep", topic: null, activity: `Inspect ${path}` }),
      (input) => { receivedBypassInput = input; },
    ));
    assert.equal(JSON.stringify(receivedBypassInput).includes(path), false, path);
    assert.equal(JSON.stringify(bypassOutput).includes(path), false, path);
  }
});

test("summarizeTitle salvage takes the whole run a private path sits in", async () => {
  // `.ssh`, `.local`, and `.internal` match a marker segment, so removing only
  // the match would leave an internal host label or a parent directory behind.
  for (const { prompt, forbidden, kept } of [
    { prompt: "Check svc-billing.internal/status now", forbidden: "svc-billing", kept: "Check" },
    { prompt: "Copy work/.ssh/id_rsa.pub to the box", forbidden: "id_rsa", kept: "Copy" },
    { prompt: "Read cache/.local/share/state.json again", forbidden: "state.json", kept: "Read" },
  ]) {
    let receivedInput: Record<string, unknown> | undefined;
    const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      titleState: { topic: null, topic_source: "none", references: [], activity: null },
      prompt,
    }, controlledRunner(
      JSON.stringify({ topic_action: "set", topic: "Host check", activity: "checking" }),
      (input) => { receivedInput = input; },
    ));
    const sentPrompt = String(receivedInput?.prompt ?? "");
    assert.equal(sentPrompt.includes(forbidden), false, prompt);
    assert.equal(JSON.stringify(out).includes(forbidden), false, prompt);
    assert.equal(sentPrompt.includes(kept), true, prompt);
  }

  // Task words in a script without spaces are not path characters, so a path
  // glued to them loses the path only.
  let receivedGlued: Record<string, unknown> | undefined;
  await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: null, topic_source: "none", references: [], activity: null },
    prompt: "看/home/runner/private/notes.md的內容",
  }, controlledRunner(
    JSON.stringify({ topic_action: "set", topic: "Note review", activity: "reading" }),
    (input) => { receivedGlued = input; },
  ));
  const gluedPrompt = String(receivedGlued?.prompt ?? "");
  assert.equal(gluedPrompt.includes("/home/runner"), false);
  assert.equal(gluedPrompt.includes("看"), true);
  assert.equal(gluedPrompt.includes("的內容"), true);
});

test("summarizeTitle titles a prompt that starts with a pasted attachment path", async () => {
  let receivedInput: Record<string, unknown> | undefined;
  const attachmentPath = "/home/runner/.local/state/agent-session/sessions/20260803-230311-claude/attachments/shot.png";
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: null, topic_source: "none", references: [], activity: null },
    prompt: `'${attachmentPath}' claude init prompts never retitle, find out why`,
  }, controlledRunner(
    JSON.stringify({ topic_action: "set", topic: "Init prompt retitle", activity: "investigating the title flow" }),
    (input) => { receivedInput = input; },
  ));

  assert.equal(String(receivedInput?.prompt ?? "").includes("never retitle"), true);
  assert.equal(JSON.stringify(receivedInput).includes("/home/runner"), false);
  assert.equal(JSON.stringify(receivedInput).includes(".local"), false);
  assert.equal(out.source, "summarizer");
  assert.equal(out.title, "Init prompt retitle - investigating the title flow");
});

test("summarizeTitle drops an activity that only repeats the topic it set", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: null, topic_source: "none", references: [], activity: null },
    prompt: "Clean up every reclaimable worktree and merge the rest back",
  }, controlledRunner(JSON.stringify({
    topic_action: "set",
    topic: "Worktree cleanup",
    activity: "Worktree cleanup",
  })));

  assert.deepEqual(out.titleState, {
    topic: "Worktree cleanup",
    topic_source: "auto",
    references: [],
    activity: null,
  });
  assert.equal(out.title, "Worktree cleanup");

  const composed = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: null, topic_source: "none", references: [], activity: null },
    prompt: "Clean up every reclaimable worktree",
  }, controlledRunner(JSON.stringify({
    topic_action: "set",
    topic: "Worktree cleanup",
    activity: "Worktree cleanup - pruning merged branches",
  })));
  assert.equal(composed.titleState?.activity, "pruning merged branches");
  assert.equal(composed.title, "Worktree cleanup - pruning merged branches");
});

test("summarizeTitle rejects malformed JSON-looking output instead of persisting it as activity", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: null, topic_source: "none", references: [], activity: null },
    prompt: "Implement structured retitle",
  }, controlledRunner("{"));

  assert.equal(out.source, "fallback");
  assert.notEqual(out.titleState?.activity, "{");
});

test("summarizeTitle can leave an exploratory session untitled", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    titleState: { topic: null, topic_source: "none", references: [], activity: null },
    prompt: "Maybe we should revisit how this works",
  }, controlledRunner(JSON.stringify({
    topic_action: "keep",
    topic: null,
    activity: null,
  })));

  assert.deepEqual(out, {
    title: null,
    titleState: { topic: null, topic_source: "none", references: [], activity: null },
    source: "summarizer",
  });
});

test("summarizeTitle returns fallback when no command is configured", async () => {
  const out = await summarizeTitle(null, { baseTitle: null, prompt: "Summarize this prompt" });
  assert.equal(out.title, "Summarize this prompt");
  assert.equal(out.source, "fallback");
});

test("summarizeTitleWithDiagnostics classifies accepted and fallback outcomes without content", async () => {
  const accepted = await summarizeTitleWithDiagnostics(
    { command: ["unused-in-test"], timeoutMs: 1 },
    { baseTitle: null, prompt: "Summarize this prompt" },
    controlledRunner(JSON.stringify({
      topic_action: "keep",
      topic: null,
      activity: "Summarizing prompt",
    })),
  );
  assert.deepEqual(accepted, {
    result: {
      title: "Summarizing prompt",
      titleState: {
        topic: null,
        topic_source: "none",
        references: [],
        activity: "Summarizing prompt",
      },
      source: "summarizer",
    },
    reason: "accepted",
  });

  const invalid = await summarizeTitleWithDiagnostics(
    { command: ["unused-in-test"], timeoutMs: 1 },
    { baseTitle: null, prompt: "Summarize this prompt" },
    controlledRunner('{"unexpected":true}'),
  );
  assert.equal(invalid.result.source, "fallback");
  assert.equal(invalid.reason, "fallback_invalid_output");

  const unavailable = await summarizeTitleWithDiagnostics(
    null,
    { baseTitle: null, prompt: "Summarize this prompt" },
  );
  assert.equal(unavailable.result.source, "fallback");
  assert.equal(unavailable.reason, "fallback_not_configured");
  const unsafePrompt = await summarizeTitleWithDiagnostics(
    { command: ["unused-in-test"], timeoutMs: 1 },
    { baseTitle: null, prompt: "TOKEN=private-value" },
    controlledRunner("Should not run"),
  );
  assert.equal(unsafePrompt.reason, "fallback_unsafe_prompt");

  const unsafeActivity = await summarizeTitleWithDiagnostics(
    { command: ["unused-in-test"], timeoutMs: 1 },
    { baseTitle: null, prompt: "Summarize this prompt" },
    controlledRunner(JSON.stringify({
      topic_action: "keep",
      topic: null,
      activity: "TOKEN=private-value",
    })),
  );
  assert.equal(unsafeActivity.reason, "fallback_unsafe_activity");

  const invalidTopic = await summarizeTitleWithDiagnostics(
    { command: ["unused-in-test"], timeoutMs: 1 },
    { baseTitle: null, prompt: "Summarize this prompt" },
    controlledRunner(JSON.stringify({
      topic_action: "set",
      topic: "1234 is the PIN",
      activity: null,
    })),
  );
  assert.equal(invalidTopic.reason, "fallback_invalid_topic");

  const unapprovedReference = await summarizeTitleWithDiagnostics(
    { command: ["unused-in-test"], timeoutMs: 1 },
    { baseTitle: null, prompt: "Summarize this prompt" },
    controlledRunner(JSON.stringify({
      topic_action: "keep",
      topic: null,
      activity: "Working on #999",
    })),
  );
  assert.equal(unapprovedReference.reason, "fallback_unapproved_reference");

  const commandError = await summarizeTitleWithDiagnostics(
    { command: ["unused-in-test"], timeoutMs: 1 },
    { baseTitle: null, prompt: "Summarize this prompt" },
    async () => { throw new Error("failed"); },
  );
  assert.equal(commandError.reason, "fallback_command_error");
  assert.doesNotMatch(
    JSON.stringify([
      accepted.reason,
      invalid.reason,
      unavailable.reason,
      unsafePrompt.reason,
      unsafeActivity.reason,
      invalidTopic.reason,
      unapprovedReference.reason,
      commandError.reason,
    ]),
    /Summarize|private-value/,
  );
});

test("summarizeTitle accepts a controlled command runner", async () => {
  let receivedInput: Record<string, unknown> | undefined;
  const out = await summarizeTitle(
    { command: ["unused-in-test"], timeoutMs: 1 },
    {
      baseTitle: "agent-console",
      prompt: "A long user prompt",
      recentOutput: "Implemented the requested change",
    },
    async (_config, input) => {
      receivedInput = JSON.parse(input) as Record<string, unknown>;
      return "Controlled title";
    },
  );

  assert.equal(out.title, "agent-console - Controlled title");
  assert.equal(out.source, "summarizer");
  assert.equal(receivedInput?.prompt, "A long user prompt");
  assert.equal(receivedInput?.recent_output, "Implemented the requested change");
});

test("summarizeTitle accepts a plain-text command response", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: "agent-console",
    prompt: "A long user prompt",
  }, controlledRunner("Short title"));
  assert.equal(out.title, "agent-console - Short title");
  assert.equal(out.source, "summarizer");
});

test("summarizeTitle preserves explicit issue and PR references omitted by the model", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: null,
    prompt: "Generate a concise title for this session",
    recentOutput: "Implement issue #123 and finish PR #55 before delivery.",
  }, controlledRunner("Detailed session focus ".repeat(10).trim()));

  assert.equal(out.source, "summarizer");
  assert.match(out.title ?? "", /#123/);
  assert.match(out.title ?? "", /#55/);
  assert.ok(Array.from(out.title ?? "").length <= 120);
});

test("summarizeTitle preserves bare work-item references from the safe prompt", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: null,
    prompt: "Fix #123 and review #55",
  }, controlledRunner("Finish session navigation"));

  assert.equal(out.source, "summarizer");
  assert.match(out.title ?? "", /#123\b/);
  assert.match(out.title ?? "", /#55\b/);
});

test("summarizeTitle distinguishes prefix-sharing work-item references", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: null,
    prompt: "Retitle the current work",
    recentOutput: "Issue #12 prepares PR #123.",
  }, controlledRunner("Finish PR #123"));

  assert.equal(out.source, "summarizer");
  assert.match(out.title ?? "", /#12\b/);
  assert.match(out.title ?? "", /#123\b/);
});

test("summarizeTitle prioritizes current work over stale title references", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: null,
    prompt: "Retitle the current work",
    currentTitle: "Old work #12 #34",
    recentOutput: "Implement issue #56 now.",
  }, controlledRunner("Implement latest issue"));

  assert.equal(out.source, "summarizer");
  assert.match(out.title ?? "", /#56\b/);
});

test("summarizeTitle prioritizes the newest explicit references in recent output", async () => {
  for (const modelTitle of ["Implement latest issue", "Implement issue #56"]) {
    const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      baseTitle: null,
      prompt: "Retitle the current work",
      recentOutput: [
        "Finished issue #12.",
        "Reviewed PR #34.",
        "Now implementing issue #56.",
      ].join("\n"),
    }, controlledRunner(modelTitle));

    assert.equal(out.source, "summarizer");
    assert.match(out.title ?? "", /#56\b/);
  }
});

test("summarizeTitle does not recover references from sensitive context lines", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: null,
    prompt: "Retitle the current work",
    recentOutput: "TOKEN=secret-value for issue #999\nImplement issue #123 safely.",
  }, controlledRunner("Safe implementation"));

  assert.equal(out.source, "summarizer");
  assert.match(out.title ?? "", /#123\b/);
  assert.doesNotMatch(out.title ?? "", /#999\b/);
});

test("summarizeTitle does not promote numeric credentials from recent output", async () => {
  for (const [recentOutput, credentialReference] of [
    ["OTP #123456", "#123456"],
    ["PIN #1234", "#1234"],
    ["verification code #654321", "#654321"],
  ]) {
    let receivedRecentOutput = "";
    const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      baseTitle: null,
      prompt: "Retitle the authentication work",
      recentOutput,
    }, controlledRunner(`${credentialReference} Verify login flow`, (input) => {
      receivedRecentOutput = String(input.recent_output ?? "");
    }));

    assert.doesNotMatch(receivedRecentOutput, /OTP|PIN|verification code/i);
    assert.doesNotMatch(out.title ?? "", new RegExp(`${credentialReference}\\b`));
  }
});

test("summarizeTitle rejects number-first numeric credential context", async () => {
  for (const [credentialText, credentialReference, request] of [
    [
      "#123456 is your verification code",
      "#123456",
      { prompt: "Retitle the authentication work", recentOutput: "#123456 is your verification code" },
    ],
    [
      "1234 is the PIN",
      "#1234",
      { prompt: "Retitle the authentication work", currentTitle: "1234 is the PIN" },
    ],
    [
      "Use #654321 as your one-time code",
      "#654321",
      { prompt: "Use #654321 as your one-time code" },
    ],
  ] as const) {
    let receivedInput = "";
    const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      baseTitle: null,
      ...request,
    }, async (_config, input) => {
      receivedInput = input;
      return `${credentialReference} Verify login`;
    });

    assert.doesNotMatch(receivedInput, new RegExp(credentialText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    assert.doesNotMatch(out.title ?? "", new RegExp(`${credentialReference}\\b`));
  }
});

test("summarizeTitle does not let ANSI sequences mask numeric credentials", async () => {
  for (const [credentialReference, request, modelTitle] of [
    [
      "#123456",
      {
        prompt: "Retitle the authentication work",
        recentOutput: "OTP: \u001b]8;;https://example.com\u0007#123456\u001b]8;;\u0007",
      },
      "#123456 Verify login",
    ],
    [
      "#654321",
      { prompt: "Use \u001b[33m#654321\u001b[0m as your one-time code" },
      "#654321 Verify login",
    ],
    [
      "#123456",
      {
        prompt: "Retitle the authentication work",
        currentTitle: "\u001b[1m#123456\u001b[0m is your verification code",
      },
      "#123456 Verify login",
    ],
    [
      "#123456",
      { prompt: "Retitle the authentication work" },
      "OTP: \u001b[32m123456\u001b[0m",
    ],
    [
      "#654321",
      { prompt: "Use #654321\u001b[ as your one-time code" },
      "#654321 Verify login",
    ],
  ] as const) {
    let receivedInput = "";
    const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      baseTitle: null,
      ...request,
    }, async (_config, input) => {
      receivedInput = input;
      return modelTitle;
    });

    assert.doesNotMatch(receivedInput, new RegExp(credentialReference.slice(1)));
    assert.doesNotMatch(out.title ?? "", new RegExp(credentialReference.slice(1)));
    assert.doesNotMatch(out.title ?? "", /[\u001b\u009b]/);
  }
});

test("summarizeTitle preserves legitimate authentication and dependency work", async () => {
  for (const [prompt, reference] of [
    ["Pin dependency version in PR #55", "#55"],
    ["Fix OTP login flow for issue #123", "#123"],
    ["Review recovery code UX in PR #77", "#77"],
    ["Fix issue #1234 OTP login flow", "#1234"],
    ["Fix PR #5678 PIN entry bug", "#5678"],
  ]) {
    const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      baseTitle: null,
      prompt,
    }, controlledRunner("Complete current work"));

    assert.equal(out.source, "summarizer", prompt);
    assert.match(out.title ?? "", new RegExp(`${reference}\\b`), prompt);
  }
});

test("summarizeTitle preserves punctuation-separated explicit references", async () => {
  for (const recentOutput of [
    "Fix PR#123",
    "Fix PR: #123",
    "Fix issue: #123",
    "Fix pull-request #123",
  ]) {
    const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
      baseTitle: null,
      prompt: "Retitle the current work",
      recentOutput,
    }, controlledRunner("Resolve review comments"));

    assert.match(out.title ?? "", /#123\b/, recentOutput);
  }
});

test("summarizeTitle preserves references truncated out of a long base title", async () => {
  const baseTitle = `${"Long initial intent ".repeat(8)}#123`;
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle,
    prompt: "Retitle the current work",
    currentTitle: `${baseTitle} - Previous action`,
    recentOutput: "Continue issue #123.",
  }, controlledRunner("Finish implementation"));

  assert.equal(out.source, "summarizer");
  assert.match(out.title ?? "", /#123\b/);
  assert.ok(Array.from(out.title ?? "").length <= 120);
});

test("summarizeTitle sends bounded turn context without sensitive output lines", async () => {
  const resetToken = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef";
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: "agent-console",
    prompt: "please update the title after this turn",
    currentTitle: "agent-console - Old title",
    recentOutput: `TOKEN=secret-value\nDATABASE_URL=postgres://alice:hunter2@db/prod\nSENTRY_DSN=https://abc123@example.com/2\napi  key hunter2\nprivate   key hunter2\npassword huntertwo\napi key: alphabeticsecret\nprivate key=alphabeticsecret\nReset link: https://example.test/reset/${resetToken}\nAccess token: https://example.test/?access_token="boundarysecret"\nFragment token: https://example.test/#%74oken=<fragmentsecret>\nImplemented the idle title refresh\n`,
    agent: "codex",
    repoName: "example-org/agent-console",
  }, controlledRunner("Updated title", (input) => {
    const recentOutput = String(input.recent_output);
    assert.doesNotMatch(recentOutput, /TOKEN=|DATABASE_URL|SENTRY_DSN|hunter2|huntertwo|alphabeticsecret|boundarysecret|fragmentsecret/);
    assert.doesNotMatch(recentOutput, /https:\/\/|ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef/);
    assert.match(recentOutput, /Reset link:/);
    assert.match(recentOutput, /Implemented the idle title refresh/);
    assert.equal(input.current_title, "agent-console - Old title");
    assert.equal(input.agent, "codex");
    assert.equal(input.repo_name, "example-org/agent-console");
  }));
  assert.equal(out.title, "agent-console - Updated title");
  assert.equal(out.source, "summarizer");
});

test("summarizeTitle sends only the safe prompt suffix to the command", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: "agent-console",
    prompt: "Fix the visible title\nDATABASE_URL=postgres://alice:hunter2@db/prod",
    currentTitle: "DATABASE_URL=postgres://alice:hunter2@db/prod",
  }, controlledRunner("Safe title", (input) => {
    assert.equal(input.prompt, "Fix the visible title");
    assert.equal(input.current_title, undefined);
    assert.doesNotMatch(JSON.stringify(input), /DATABASE_URL/);
  }));
  assert.equal(out.title, "agent-console - Safe title");
  assert.equal(out.source, "summarizer");
});

test("summarizeTitle sends a truncated safe prompt suffix to the command", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: "agent-console",
    prompt: "x ".repeat(200),
  }, controlledRunner("Truncated title", (input) => {
    assert.equal(String(input.prompt).length, 120);
    assert.match(String(input.prompt), /\.\.\.$/);
  }));
  assert.equal(out.title, "agent-console - Truncated title");
  assert.equal(out.source, "summarizer");
});

test("summarizeTitle rejects sensitive summarizer output", async () => {
  const out = await summarizeTitle({
    command: ["unused-in-test"],
    timeoutMs: 1,
  }, {
    baseTitle: "agent-console",
    prompt: "Fix the visible title",
  }, controlledRunner("DATABASE_URL=postgres://alice:hunter2@db/prod"));
  assert.equal(out.title, "agent-console - Fix the visible title");
  assert.equal(out.source, "fallback");
});

test("summarizeTitle accepts JSON command stdout with a title", async () => {
  const out = await summarizeTitle({
    command: ["unused-in-test"],
    timeoutMs: 1,
  }, {
    baseTitle: "agent-console",
    prompt: "A long user prompt",
  }, controlledRunner(JSON.stringify({ title: "JSON title" })));
  assert.equal(out.title, "agent-console - JSON title");
  assert.equal(out.source, "summarizer");
});

test("summarizeTitle accepts full-title command output without duplicating the base", async () => {
  for (const commandOutput of [
    "PR #23 - Resolving review threads",
    JSON.stringify({ title: "PR #23 - Resolving review threads" }),
  ]) {
    const out = await summarizeTitle({
      command: ["unused-in-test"],
      timeoutMs: 1,
    }, {
      baseTitle: "PR #23",
      prompt: "Resolve review threads",
    }, controlledRunner(commandOutput));
    assert.equal(out.title, "PR #23 - Resolving review threads");
    assert.equal(out.source, "summarizer");
  }
});

test("summarizeTitle de-duplicates a full title with a rendered long base", async () => {
  const baseTitle = "Review auth module ".repeat(8).slice(0, 120);
  const currentTitle = composeTitle(baseTitle, "Finding bugs");
  assert.ok(currentTitle);
  const out = await summarizeTitle({
    command: ["unused-in-test"],
    timeoutMs: 1,
  }, {
    baseTitle,
    prompt: "Find more bugs",
    currentTitle,
  }, controlledRunner(currentTitle));

  assert.equal(out.title, currentTitle);
  assert.equal(out.source, "summarizer");
});

test("summarizeTitle de-duplicates raw and Unicode delimiter full-title output", async () => {
  for (const [baseTitle, commandTitle, expectedTitle] of [
    [
      "Review API - security boundaries",
      "Review API - security boundaries - Finding bugs",
      "Review API - security boundaries - Finding bugs",
    ],
    ["PR #23", "PR #23 — Finding bugs", "PR #23 - Finding bugs"],
    ["PR #23", "PR #23 – Finding bugs", "PR #23 - Finding bugs"],
  ] as const) {
    const out = await summarizeTitle({
      command: ["unused-in-test"],
      timeoutMs: 1,
    }, {
      baseTitle,
      prompt: "Find bugs",
    }, controlledRunner(commandTitle));
    assert.equal(out.title, expectedTitle);
    assert.equal(out.source, "summarizer");
  }
});

test("summarizeTitle rejects credentials exposed after full-title prefix removal", async () => {
  for (const commandTitle of [
    "PR #23 - password huntertwo",
    "PR #23 — password huntertwo",
    "PR #23 – password huntertwo",
  ]) {
    const out = await summarizeTitle({
      command: ["unused-in-test"],
      timeoutMs: 1,
    }, {
      baseTitle: "PR #23",
      prompt: "Resolve review threads",
    }, controlledRunner(commandTitle));
    assert.equal(out.title, "PR #23 - Resolve review threads");
    assert.equal(out.source, "fallback");
  }
});

test("summarizeTitle rejects credentials hidden behind repeated or nested title segments", async () => {
  for (const commandTitle of [
    "PR #23 - PR #23 - password huntertwo",
    "PR #23 — PR #23 – password huntertwo",
    "PR #23 - Finding bugs - password huntertwo",
    "PR #23 — Finding bugs – api key: alphabeticsecret",
  ]) {
    const out = await summarizeTitle({
      command: ["unused-in-test"],
      timeoutMs: 1,
    }, {
      baseTitle: "PR #23",
      prompt: "Resolve review threads",
    }, controlledRunner(commandTitle));
    assert.equal(out.title, "PR #23 - Resolve review threads");
    assert.equal(out.source, "fallback");
  }
});

test("summarizeTitle rejects malformed delimiter runs before sensitive segments", async () => {
  for (const commandTitle of [
    "PR #23 - Finding bugs - - password huntertwo",
    "PR #23 - - password huntertwo",
    "- password huntertwo",
  ]) {
    for (const jsonOutput of [false, true]) {
      const renderedOutput = jsonOutput ? JSON.stringify({ title: commandTitle }) : commandTitle;
      const out = await summarizeTitle({
        command: ["unused-in-test"],
        timeoutMs: 1,
      }, {
        baseTitle: "PR #23",
        prompt: "Resolve review threads",
      }, controlledRunner(renderedOutput));
      assert.equal(out.title, "PR #23 - Resolve review threads");
      assert.equal(out.source, "fallback");
    }
  }
});

test("summarizeTitle preserves safe non-prompt context while normalizing skill prompts", async () => {
  const out = await summarizeTitle({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: "/release 23",
    prompt: "$review 23",
    currentTitle: "$release 23 - Finding bugs",
    agent: "/codex",
    repoName: "$agent-console",
  }, controlledRunner("Reviewing release", (input) => {
    assert.equal(input.prompt, "review 23");
    assert.equal(input.base_title, "/release 23");
    assert.equal(input.current_title, "$release 23 - Finding bugs");
    assert.equal(input.agent, "/codex");
    assert.equal(input.repo_name, "$agent-console");
  }));
  assert.equal(out.title, "/release 23 - Reviewing release");
  assert.equal(out.source, "summarizer");
});

test("summarizeTitle does not send credential-like prompts to the command", async () => {
  for (const prompt of [
    "api_key=sk-proj-1234567890abcdef",
    "psql postgresql://alice:hunter2@db/prod",
    "curl -u alice:hunter2 https://api.example.test",
    "DATABASE_URL=postgres://alice:hunter2@db/prod",
  ]) {
    let runnerCalled = false;
    const out = await summarizeTitle({
      command: ["unused-in-test"],
      timeoutMs: 1,
    }, {
      baseTitle: "agent-console",
      prompt,
    }, async () => {
      runnerCalled = true;
      return "Should not run";
    });
    assert.equal(runnerCalled, false);
    assert.equal(out.title, "agent-console");
    assert.equal(out.source, "fallback");
  }
});

test("summarizeTitle classifies empty output and timeout fallbacks", async () => {
  const empty = await summarizeTitleWithDiagnostics({ command: ["unused-in-test"], timeoutMs: 1 }, {
    baseTitle: "agent-console",
    prompt: "Fallback prompt",
  }, controlledRunner(""));
  assert.equal(empty.result.title, "agent-console - Fallback prompt");
  assert.equal(empty.reason, "fallback_invalid_output");

  const timedOut = await summarizeTitleWithDiagnostics({ command: [process.execPath, "-e", "setTimeout(() => {}, 1000)"], timeoutMs: 10 }, {
    baseTitle: "agent-console",
    prompt: "Timeout prompt",
  });
  assert.equal(timedOut.result.title, "agent-console - Timeout prompt");
  assert.equal(timedOut.reason, "fallback_timeout");

  const cleanupStartedAt = Date.now();
  const ignoresSigterm = await summarizeTitleWithDiagnostics({
    command: [
      process.execPath,
      "-e",
      "process.on('SIGTERM',()=>{}); process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('x'.repeat(5000))); setInterval(()=>{},1000)",
    ],
    timeoutMs: 8000,
  }, {
    baseTitle: "agent-console",
    prompt: "Cleanup prompt",
  });
  assert.equal(ignoresSigterm.reason, "fallback_command_error");
  assert.ok(Date.now() - cleanupStartedAt >= 200, "the slot must remain held through SIGKILL cleanup");
});

test("summarizeTitle falls back when the command fails", async () => {
  const out = await summarizeTitleWithDiagnostics({ command: [process.execPath, "-e", "process.exit(2)"], timeoutMs: 8000 }, {
    baseTitle: "agent-console",
    prompt: "Fallback prompt",
  });
  assert.equal(out.result.title, "agent-console - Fallback prompt");
  assert.equal(out.reason, "fallback_command_error");
});

test("summarizeTitle falls back when command output exceeds the limit", async () => {
  const out = await summarizeTitle({
    command: [
      process.execPath,
      "-e",
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('x'.repeat(5000)));",
    ],
    timeoutMs: 8000,
  }, {
    baseTitle: "agent-console",
    prompt: "Fallback prompt",
  });
  assert.equal(out.title, "agent-console - Fallback prompt");
  assert.equal(out.source, "fallback");
});

test("summarizeTitle queues bounded concurrency and reports only queue saturation as busy", async () => {
  const config = {
    command: [
      process.execPath,
      "-e",
      "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => console.log('Slow title'), 100));",
    ],
    timeoutMs: 8000,
  };
  const results = await Promise.all(Array.from(
    { length: 11 },
    (_, index) => summarizeTitleWithDiagnostics(config, {
      baseTitle: "agent-console",
      prompt: `Prompt ${index + 1}`,
    }),
  ));

  assert.equal(results.filter((item) => item.reason === "accepted").length, 10);
  assert.equal(results.filter((item) => item.reason === "fallback_busy").length, 1);
});

test("titleSummarizerChildEnv excludes edge secrets and keeps summarizer config", () => {
  const env = titleSummarizerChildEnv({
    PATH: "/bin",
    HOME: "/home/test",
    AGENT_CONSOLE_TOKEN: "client-secret",
    AGENT_CONSOLE_MACHINES: "[{\"token\":\"machine-secret\"}]",
    AGENT_CONSOLE_HERMES_TOKEN: "reader-secret",
    AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL: "http://127.0.0.1:1234/v1",
    AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL: "title-model",
    AGENT_CONSOLE_TITLE_SUMMARIZER_API_KEY: "title-key",
    AGENT_CONSOLE_TITLE_SUMMARIZER_SLOT_ID: "1",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/test");
  assert.equal(env.AGENT_CONSOLE_TITLE_SUMMARIZER_BASE_URL, "http://127.0.0.1:1234/v1");
  assert.equal(env.AGENT_CONSOLE_TITLE_SUMMARIZER_MODEL, "title-model");
  assert.equal(env.AGENT_CONSOLE_TITLE_SUMMARIZER_API_KEY, "title-key");
  assert.equal(env.AGENT_CONSOLE_TITLE_SUMMARIZER_SLOT_ID, "1");
  assert.equal(env.AGENT_CONSOLE_TOKEN, undefined);
  assert.equal(env.AGENT_CONSOLE_MACHINES, undefined);
  assert.equal(env.AGENT_CONSOLE_HERMES_TOKEN, undefined);
});
