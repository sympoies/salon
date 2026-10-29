import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MANUAL_RETITLE_GLANCE_TAIL,
  MANUAL_RETITLE_PROMPT,
  applyManualRetitleSummary,
  applyTurnCompletionAutoTitleSummary,
  commitSummarizedTitle,
  applyTurnPromptAutoTitleSummary,
  applyCreatePromptAutoTitleSummary,
  createdSessionAutoTitleState,
  prepareCreateSessionAutoTitle,
  resolveSummaryCandidate,
  resolveCreatedSession,
  resolveCreateTitleSession,
  runSummaryTitleFlow,
} from "../src/autoTitleFlow.ts";
import type { TitleSummaryResult } from "../src/api.ts";
import { makeSession } from "./support/fixtures.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const EMPTY_TITLE_STATE = {
  topic: null,
  topic_source: "none" as const,
  references: [],
  activity: null,
};

test("prepareCreateSessionAutoTitle stages prompt text outside the backend create body", () => {
  const prepared = prepareCreateSessionAutoTitle({
    agent: "codex",
    cwd: "/repo",
    title: "agent-console",
    title_state: {
      topic: "agent-console",
      topic_source: "user",
      references: [],
      activity: null,
    },
    prompt: "Fix mobile title flow\nwith details",
  });

  assert.equal(prepared.prompt, "Fix mobile title flow\nwith details");
  assert.equal(prepared.titlePrompt, "Fix mobile title flow");
  assert.equal(prepared.baseTitle, "agent-console");
  assert.equal(prepared.fallbackTitle, "agent-console - Fix mobile title flow");
  assert.deepEqual(prepared.createBody, {
    agent: "codex",
    cwd: "/repo",
    title: "agent-console",
    title_state: {
      topic: "agent-console",
      topic_source: "user",
      references: [],
      activity: null,
    },
  });
});

test("prepareCreateSessionAutoTitle derives safe title context from the reported URL-leading prompt", () => {
  const prompt = "https://github.com/sampleRepo/agent-runtime-kit/issues/657 處理掉這個 issue 要考慮到 codex 的情況 反正有 .tera 能做不同版本的規則對吧";
  const titlePrompt = "處理掉這個 issue 要考慮到 codex 的情況 反正有 .tera 能做不同版本的規則對吧";
  const prepared = prepareCreateSessionAutoTitle({ agent: "codex", prompt });

  assert.equal(prepared.prompt, prompt);
  assert.equal(prepared.titlePrompt, titlePrompt);
  assert.equal(prepared.fallbackTitle, titlePrompt);
  assert.deepEqual(prepared.createBody, {
    agent: "codex",
    title_state: EMPTY_TITLE_STATE,
  });
});

test("prepareCreateSessionAutoTitle keeps the reported document-name prompt titleable", () => {
  const prompt = "2026-07-24-session-overview-layout-state-repair.md check whether this is finished";
  const prepared = prepareCreateSessionAutoTitle({ agent: "claude", prompt });

  // A long hyphenated plan filename used to read as an opaque credential, which
  // left titlePrompt/fallbackTitle null and skipped the create-time summary
  // entirely, so the session stayed untitled through every later turn.
  assert.equal(prepared.titlePrompt, prompt);
  assert.equal(prepared.fallbackTitle, prompt);
});

test("createdSessionAutoTitleState owns fresh provider-resumable placeholders but rejects imports", () => {
  const createdSession = makeSession({
    title: "New Claude session",
    provider_resume: { provider: "claude", session_id: "fresh-session-id" },
  });

  assert.deepEqual(createdSessionAutoTitleState({
    createBody: { agent: "claude", title: "New Claude session" },
    createdSession,
    prompt: null,
    baseTitle: null,
    fallbackTitle: null,
  }), {
    baseTitle: null,
    baseTitleConfirmed: false,
    disabled: false,
    ownedTitle: "New Claude session",
  });
  assert.equal(createdSessionAutoTitleState({
    createBody: { agent: "claude", provider_resume_id: "imported-session-id" },
    createdSession,
    prompt: null,
    baseTitle: null,
    fallbackTitle: null,
  }), null);
});

test("createdSessionAutoTitleState keeps an untitled prompt placeholder provisional", () => {
  const createdSession = makeSession({ title: "New Codex session" });

  assert.deepEqual(createdSessionAutoTitleState({
    createBody: { agent: "codex", title: "New Codex session" },
    createdSession,
    prompt: "Evaluate retitle behavior",
    baseTitle: null,
    fallbackTitle: "Evaluate retitle behavior",
  }), {
    baseTitle: null,
    baseTitleConfirmed: false,
    disabled: false,
    ownedTitle: "New Codex session",
  });
});

test("prepareCreateSessionAutoTitle preserves separators inside an explicit user title", () => {
  const prepared = prepareCreateSessionAutoTitle({
    agent: "codex",
    title: "Review API - security boundaries",
    prompt: "Find bugs",
  });

  assert.equal(prepared.baseTitle, "Review API - security boundaries");
  assert.equal(prepared.fallbackTitle, "Review API — security boundaries - Find bugs");
  assert.equal(prepared.createBody.title, "Review API - security boundaries");
  assert.equal(prepared.createBody.title_state?.topic_source, "user");
  assert.equal(prepared.createBody.title_state?.topic, "Review API - security boundaries");
});

test("prepareCreateSessionAutoTitle canonicalizes explicit whitespace once for title and state", () => {
  const prepared = prepareCreateSessionAutoTitle({
    agent: "codex",
    title: "Release  checklist",
  });

  assert.equal(prepared.createBody.title, "Release checklist");
  assert.equal(prepared.createBody.title_state?.topic, "Release checklist");
});

test("prepareCreateSessionAutoTitle bounds explicit titles before constructing structured state", () => {
  for (const input of ["a".repeat(121), "😀".repeat(121)]) {
    const prepared = prepareCreateSessionAutoTitle({
      agent: "codex",
      title: input,
    });

    assert.equal(Array.from(prepared.baseTitle ?? "").length, 120);
    assert.equal(prepared.createBody.title, prepared.baseTitle);
    assert.equal(prepared.createBody.title_state?.topic, prepared.baseTitle);
    assert.equal(prepared.createBody.title_state?.topic_source, "user");
  }
});

test("prepareCreateSessionAutoTitle uses normalized skill context while staging the submitted prompt", () => {
  const prepared = prepareCreateSessionAutoTitle({
    agent: "codex",
    prompt: "$pr:deliver-pr 23",
  });

  assert.equal(prepared.prompt, "$pr:deliver-pr 23");
  assert.equal(prepared.titlePrompt, "pr:deliver-pr 23");
  assert.equal(prepared.fallbackTitle, "pr:deliver-pr 23");
  assert.deepEqual(prepared.createBody, {
    agent: "codex",
    title_state: EMPTY_TITLE_STATE,
  });
});

test("prepareCreateSessionAutoTitle excludes whitespace-separated credentials from skill title context", () => {
  const prompt = "$private-secrets\npassword hunter2\nRotate the credential";
  const prepared = prepareCreateSessionAutoTitle({
    agent: "codex",
    prompt,
  });

  assert.equal(prepared.prompt, prompt);
  assert.equal(prepared.titlePrompt, "private-secrets Rotate the credential");
  assert.equal(prepared.fallbackTitle, "private-secrets Rotate the credential");
  assert.deepEqual(prepared.createBody, {
    agent: "codex",
    title_state: EMPTY_TITLE_STATE,
  });
});

test("prepareCreateSessionAutoTitle seeds an agent label, not the repo name, for blank untitled sessions", () => {
  const prepared = prepareCreateSessionAutoTitle({
    agent: "codex",
    cwd: "/home/runner/Project/summit/agent-console/",
  });

  assert.equal(prepared.prompt, null);
  assert.equal(prepared.titlePrompt, null);
  // The cwd (repo) name is shown by the header repo badge, so it must not leak
  // into the composable base title nor the seeded title.
  assert.equal(prepared.baseTitle, null);
  assert.equal(prepared.fallbackTitle, null);
  assert.deepEqual(prepared.createBody, {
    agent: "codex",
    cwd: "/home/runner/Project/summit/agent-console/",
    title_state: EMPTY_TITLE_STATE,
  });
});

test("prepareCreateSessionAutoTitle falls back to a non-duplicating agent session title without cwd", () => {
  const prepared = prepareCreateSessionAutoTitle({
    agent: "claude",
  });

  assert.equal(prepared.baseTitle, null);
  assert.deepEqual(prepared.createBody, {
    agent: "claude",
    title_state: EMPTY_TITLE_STATE,
  });
});

test("prepareCreateSessionAutoTitle ignores the cwd entirely and seeds the agent label", () => {
  const prepared = prepareCreateSessionAutoTitle({
    agent: "codex",
    cwd: "/home/runner/codex",
  });

  assert.equal(prepared.baseTitle, null);
  assert.deepEqual(prepared.createBody, {
    agent: "codex",
    cwd: "/home/runner/codex",
    title_state: EMPTY_TITLE_STATE,
  });
});

test("prepareCreateSessionAutoTitle drops the repo name so titles do not duplicate the repo badge", () => {
  const prepared = prepareCreateSessionAutoTitle({
    agent: "codex",
    cwd: "/home/runner/Project/summit/agent-console/",
    prompt: "codex multi-account info assessment\nwith more context lines",
  });

  // The raw prompt remains staged summarizer/input context only; the
  // provisional title is neutral and the repo stays in its badge.
  assert.equal(prepared.baseTitle, null);
  assert.equal(prepared.fallbackTitle, "codex multi-account info assessment");
  assert.deepEqual(prepared.createBody, {
    agent: "codex",
    cwd: "/home/runner/Project/summit/agent-console/",
    title_state: EMPTY_TITLE_STATE,
  });
});

test("prepareCreateSessionAutoTitle preserves blank provider resume imports", () => {
  const prepared = prepareCreateSessionAutoTitle({
    agent: "claude",
    provider_resume_id: "external-claude-session",
  });

  assert.equal(prepared.prompt, null);
  assert.equal(prepared.titlePrompt, null);
  assert.equal(prepared.baseTitle, null);
  assert.equal(prepared.fallbackTitle, null);
  assert.deepEqual(prepared.createBody, {
    agent: "claude",
    provider_resume_id: "external-claude-session",
  });
});

test("prepareCreateSessionAutoTitle does not title credential-like prompts", () => {
  const prepared = prepareCreateSessionAutoTitle({
    agent: "codex",
    prompt: "API_KEY=sk-proj-1234567890abcdef",
  });

  assert.equal(prepared.prompt, "API_KEY=sk-proj-1234567890abcdef");
  assert.equal(prepared.titlePrompt, null);
  assert.equal(prepared.baseTitle, null);
  assert.equal(prepared.fallbackTitle, null);
  assert.deepEqual(prepared.createBody, {
    agent: "codex",
    title_state: EMPTY_TITLE_STATE,
  });
});

test("resolveCreatedSession requires an explicit id or one unambiguous new session", () => {
  const sessions = [
    makeSession({ machine: "maple", id: "old" }),
    makeSession({ machine: "maple", id: "new" }),
    makeSession({ machine: "maple", id: "other" }),
  ];
  assert.equal(resolveCreatedSession(sessions, new Set(["maple/old"]), { machine: "maple", id: "new" })?.id, "new");
  assert.equal(resolveCreatedSession(sessions, new Set(["maple/old"]), undefined), null);
  assert.equal(resolveCreatedSession(sessions.slice(0, 2), new Set(["maple/old"]), undefined)?.id, "new");
});

test("resolveCreateTitleSession prefers fresh same-incarnation reconciliation without claiming replacements", () => {
  const created = makeSession({
    title_revision: 0,
    session_incarnation: "created-incarnation",
  });
  const reconciled = makeSession({
    title_revision: 1,
    session_incarnation: "created-incarnation",
  });
  const replacement = makeSession({
    title_revision: 0,
    session_incarnation: "replacement-incarnation",
  });

  assert.equal(resolveCreateTitleSession(created, null), created);
  assert.equal(resolveCreateTitleSession(undefined, reconciled), reconciled);
  assert.equal(resolveCreateTitleSession(created, reconciled), reconciled);
  assert.equal(resolveCreateTitleSession(created, replacement), null);
});

test("resolveSummaryCandidate returns only distinct valid summaries", () => {
  assert.deepEqual(resolveSummaryCandidate({ ok: false, error: "failed" }, "Old title"), { result: "summary-failed" });
  assert.deepEqual(resolveSummaryCandidate({ ok: true, title: "Old title", source: "summarizer" }, "Old title"), {
    result: "unchanged",
  });
  assert.deepEqual(
    resolveSummaryCandidate({ ok: true, title: "New title", source: "fallback" }, "Old title", {
      requireSource: "summarizer",
    }),
    { result: "summary-failed" },
  );
  assert.deepEqual(resolveSummaryCandidate({ ok: true, title: "New title", source: "summarizer" }, "Old title"), {
    result: "candidate",
    title: "New title",
  });

  const activityState = {
    topic: null,
    topic_source: "none" as const,
    references: [],
    activity: "Fix retitle",
  };
  const autoTopicState = {
    topic: "Fix retitle",
    topic_source: "auto" as const,
    references: [],
    activity: null,
  };
  assert.deepEqual(resolveSummaryCandidate({
    ok: true,
    title: "Old-edge title",
    source: "summarizer",
  }, "Fix retitle", { unchangedTitleState: autoTopicState }), {
    result: "summary-failed",
  });
  assert.deepEqual(resolveSummaryCandidate({
    ok: true,
    title: "Fix retitle",
    titleState: autoTopicState,
    source: "summarizer",
  }, "Fix retitle", { unchangedTitleState: activityState }), {
    result: "candidate",
    title: "Fix retitle",
    titleState: autoTopicState,
  });
  assert.deepEqual(resolveSummaryCandidate({
    ok: true,
    title: null,
    titleState: EMPTY_TITLE_STATE,
    source: "summarizer",
  }, "Discuss naming", { unchangedTitleState: activityState }), {
    result: "candidate",
    title: null,
    titleState: EMPTY_TITLE_STATE,
  });
});

test("commitSummarizedTitle remembers before patching and refreshes on failures", async () => {
  const events: string[] = [];
  const titleState = {
    topic: "Retitle rules",
    topic_source: "auto" as const,
    references: ["#317"],
    activity: "Implement contract",
  };

  assert.equal(await commitSummarizedTitle({
    session: { machine: "maple", id: "s1" },
    rememberTitle: (_machine, _id, title, state) => events.push(`remember:${title}:${state?.references[0]}`),
    updateTitle: async (_machine, _id, title, state) => {
      assert.deepEqual(state, titleState);
      events.push(`update:${title}`);
      return { ok: true };
    },
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  }, "Shared title", titleState), "updated");

  assert.deepEqual(events, ["remember:Shared title:#317", "update:Shared title"]);

  const failures: string[] = [];
  assert.equal(await commitSummarizedTitle({
    session: { machine: "maple", id: "s1" },
    rememberTitle: (_machine, _id, title) => failures.push(`remember:${title}`),
    updateTitle: async () => ({ ok: false, error: "title update failed" }),
    onError: (message) => failures.push(`error:${message}`),
    refresh: () => failures.push("refresh"),
  }, "Failed title"), "update-failed");

  assert.deepEqual(failures, ["remember:Failed title", "error:title update failed", "refresh"]);
});

test("commitSummarizedTitle publishes a resolved intent only after a successful PATCH", async () => {
  const committed: string[] = [];
  assert.equal(await commitSummarizedTitle({
    session: { machine: "maple", id: "s1" },
    rememberTitle: () => undefined,
    updateTitle: async () => ({ ok: true }),
    onTitleCommitted: (title) => committed.push(title),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  }, "Review auth module"), "updated");
  assert.deepEqual(committed, ["Review auth module"]);

  assert.equal(await commitSummarizedTitle({
    session: { machine: "maple", id: "s1" },
    rememberTitle: () => undefined,
    updateTitle: async () => ({ ok: false, error: "failed" }),
    onTitleCommitted: () => assert.fail("failed PATCH must not publish an intent anchor"),
    onError: () => undefined,
    refresh: () => undefined,
  }, "Uncommitted title"), "update-failed");
});

test("runSummaryTitleFlow applies guard order and commit tail once", async () => {
  const events: string[] = [];
  const result = await runSummaryTitleFlow({
    session: { machine: "maple", id: "s1" },
    summarizeTitle: async (body) => {
      events.push(`summary:${body.prompt}`);
      return { ok: true, title: "New shared title", source: "summarizer" };
    },
    rememberTitle: (_machine, _id, title) => events.push(`remember:${title}`),
    updateTitle: async (_machine, _id, title) => {
      events.push(`update:${title}`);
      return { ok: true };
    },
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  }, {
    isDisabled: () => {
      events.push("disabled?");
      return false;
    },
    prepare: () => {
      events.push("prepare");
      return {
        request: { prompt: "Update title", baseTitle: null },
        unchangedTitle: "Old title",
        expectedCurrentTitle: "Old title",
        currentTitle: async () => {
          events.push("current");
          return "Old title";
        },
      };
    },
  });

  assert.equal(result, "updated");
  assert.deepEqual(events, [
    "disabled?",
    "prepare",
    "summary:Update title",
    "disabled?",
    "current",
    "remember:New shared title",
    "update:New shared title",
  ]);
});

test("runSummaryTitleFlow makes missing current-title stale only when requested", async () => {
  const staleDeps = {
    session: { machine: "maple", id: "s1" },
    summarizeTitle: async () => ({ ok: true, title: "New title", source: "summarizer" }) satisfies TitleSummaryResult,
    rememberTitle: () => assert.fail("stale flow should not remember"),
    updateTitle: async () => {
      assert.fail("stale flow should not patch");
      return { ok: true };
    },
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  };
  const prepare = (staleOnMissingCurrentTitle: boolean) => ({
    request: { prompt: "Update title", baseTitle: null },
    unchangedTitle: "Fallback title",
    expectedCurrentTitle: "Fallback title",
    currentTitle: async () => undefined,
    staleOnMissingCurrentTitle,
  });

  assert.equal(await runSummaryTitleFlow(staleDeps, { prepare: () => prepare(true) }), "stale-title");

  const events: string[] = [];
  assert.equal(await runSummaryTitleFlow({
    session: { machine: "maple", id: "s1" },
    summarizeTitle: async () => ({ ok: true, title: "New title", source: "summarizer" }),
    rememberTitle: (_machine, _id, title) => events.push(`remember:${title}`),
    updateTitle: async (_machine, _id, title) => {
      events.push(`update:${title}`);
      return { ok: true };
    },
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  }, { prepare: () => prepare(false) }), "updated");
  assert.deepEqual(events, ["remember:New title", "update:New title"]);
});

test("applyCreatePromptAutoTitleSummary writes only distinct summarizer titles", async () => {
  const remembered: string[] = [];
  const updates: string[] = [];
  const result = await applyCreatePromptAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    prompt: "Fix title flow",
    baseTitle: "agent-console",
    fallbackTitle: "agent-console - Fix title flow",
    isDisabled: () => false,
    summarizeTitle: async (body) => {
      assert.deepEqual(body, { baseTitle: "agent-console", prompt: "Fix title flow" });
      return { ok: true, title: "agent-console - Better title", source: "summarizer" };
    },
    updateTitle: async (_machine, _id, title) => {
      updates.push(title ?? "");
      return { ok: true };
    },
    rememberTitle: (_machine, _id, title) => remembered.push(title ?? ""),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });

  assert.equal(result, "updated");
  assert.deepEqual(remembered, ["agent-console - Better title"]);
  assert.deepEqual(updates, ["agent-console - Better title"]);
});

test("applyCreatePromptAutoTitleSummary accepts a concise title equal to the never-persisted prompt", async () => {
  const updates: Array<string | null> = [];
  const result = await applyCreatePromptAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    prompt: "Fix login",
    baseTitle: null,
    fallbackTitle: "Fix login",
    expectedCurrentTitle: "New Codex session",
    isDisabled: () => false,
    summarizeTitle: async () => ({ ok: true, title: "Fix login", source: "summarizer" }),
    updateTitle: async (_machine, _id, title) => {
      updates.push(title);
      return { ok: true };
    },
    rememberTitle: () => undefined,
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });

  assert.equal(result, "updated");
  assert.deepEqual(updates, ["Fix login"]);
});

test("applyCreatePromptAutoTitleSummary skips PATCH when manual rename disables auto-title", async () => {
  let disabled = false;
  const summary = deferred<TitleSummaryResult>();
  const applied = applyCreatePromptAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    prompt: "Fix title flow",
    baseTitle: "agent-console",
    fallbackTitle: "agent-console - Fix title flow",
    isDisabled: () => disabled,
    summarizeTitle: () => summary.promise,
    updateTitle: async () => {
      assert.fail("summary title should not be patched after manual disable");
    },
    rememberTitle: () => assert.fail("summary title should not be remembered after manual disable"),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });

  disabled = true;
  summary.resolve({ ok: true, title: "agent-console - Better title", source: "summarizer" });
  assert.equal(await applied, "disabled");
});

test("applyCreatePromptAutoTitleSummary skips PATCH when the server title changed", async () => {
  const result = await applyCreatePromptAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    prompt: "Fix title flow",
    baseTitle: "agent-console",
    fallbackTitle: "agent-console - Fix title flow",
    isDisabled: () => false,
    summarizeTitle: async () => ({ ok: true, title: "agent-console - Better title", source: "summarizer" }),
    currentTitle: async () => "Manual title from another client",
    updateTitle: async () => {
      assert.fail("summary title should not overwrite a remote title change");
    },
    rememberTitle: () => assert.fail("summary title should not be remembered after a remote title change"),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });

  assert.equal(result, "stale-title");
});

test("applyCreatePromptAutoTitleSummary reports update failures and refreshes", async () => {
  const errors: string[] = [];
  let refreshes = 0;
  const result = await applyCreatePromptAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    prompt: "Fix title flow",
    baseTitle: "agent-console",
    fallbackTitle: "agent-console - Fix title flow",
    isDisabled: () => false,
    summarizeTitle: async () => ({ ok: true, title: "agent-console - Better title", source: "summarizer" }),
    updateTitle: async () => ({ ok: false, error: "title update failed" }),
    rememberTitle: () => undefined,
    onError: (message) => errors.push(message),
    refresh: () => {
      refreshes += 1;
    },
  });

  assert.equal(result, "update-failed");
  assert.deepEqual(errors, ["title update failed"]);
  assert.equal(refreshes, 1);
});

test("applyTurnPromptAutoTitleSummary summarizes the latest prompt with safe glance context", async () => {
  const remembered: string[] = [];
  const updates: string[] = [];
  const result = await applyTurnPromptAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    prompt: "please make the mobile terminal title follow each turn",
    baseTitle: "agent-console",
    expectedCurrentTitle: "agent-console - Old title",
    isDisabled: () => false,
    glance: async (machine, id, tail) => {
      assert.equal(machine, "maple");
      assert.equal(id, "s1");
      assert.equal(tail, 80);
      return {
        id: "s1",
        agent: "codex",
        title: "agent-console - Old title",
        status: "running",
        repo_name: "exampleOrg/agent-console",
        tail: "Implemented an idle turn title refresh.",
      };
    },
    summarizeTitle: async (body) => {
      assert.deepEqual(body, {
        baseTitle: "agent-console",
        prompt: "please make the mobile terminal title follow each turn",
        currentTitle: "agent-console - Old title",
        recentOutput: "Implemented an idle turn title refresh.",
        agent: "codex",
        repoName: "exampleOrg/agent-console",
      });
      return { ok: true, title: "agent-console - Per-turn title refresh", source: "summarizer" };
    },
    currentTitle: async () => "agent-console - Old title",
    updateTitle: async (_machine, _id, title) => {
      updates.push(title ?? "");
      return { ok: true };
    },
    rememberTitle: (_machine, _id, title) => remembered.push(title ?? ""),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });

  assert.equal(result, "updated");
  assert.deepEqual(remembered, ["agent-console - Per-turn title refresh"]);
  assert.deepEqual(updates, ["agent-console - Per-turn title refresh"]);
});

test("applyTurnPromptAutoTitleSummary updates sessions whose daemon title is still null", async () => {
  const updates: string[] = [];
  const result = await applyTurnPromptAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    prompt: "Run review on my current changes",
    baseTitle: "agent-console",
    expectedCurrentTitle: null,
    isDisabled: () => false,
    glance: async () => ({
      id: "s1",
      agent: "codex",
      title: null,
      status: "running",
      repo_name: "agent-console",
      tail: "Reviewing the current changes.",
    }),
    summarizeTitle: async (body) => {
      assert.deepEqual(body, {
        baseTitle: "agent-console",
        prompt: "Run review on my current changes",
        currentTitle: null,
        recentOutput: "Reviewing the current changes.",
        agent: "codex",
        repoName: "agent-console",
      });
      return { ok: true, title: "agent-console - Review current changes", source: "summarizer" };
    },
    currentTitle: async () => null,
    updateTitle: async (_machine, _id, title) => {
      updates.push(title ?? "");
      return { ok: true };
    },
    rememberTitle: () => undefined,
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });

  assert.equal(result, "updated");
  assert.deepEqual(updates, ["agent-console - Review current changes"]);
});

test("applyTurnCompletionAutoTitleSummary uses safe glance context and stale guards", async () => {
  const updates: string[] = [];
  const result = await applyTurnCompletionAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    baseTitle: null,
    expectedCurrentTitle: "New Codex session",
    isDisabled: () => false,
    glance: async () => ({
      id: "s1",
      agent: "codex",
      status: "running",
      title: "New Codex session",
      repo_name: "agent-console",
      tail: "Implemented startup retitle recovery.\nAll focused tests pass.",
    }),
    summarizeTitle: async (body) => {
      assert.deepEqual(body, {
        baseTitle: null,
        prompt: "Completed agent task",
        currentTitle: "New Codex session",
        recentOutput: "Implemented startup retitle recovery.",
        agent: "codex",
        repoName: "agent-console",
      });
      return { ok: true, title: "Startup retitle recovery", source: "summarizer" };
    },
    currentTitle: async () => "New Codex session",
    updateTitle: async (_machine, _id, title) => {
      updates.push(title ?? "");
      return { ok: true };
    },
    rememberTitle: () => undefined,
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });
  assert.equal(result, "updated");
  assert.deepEqual(updates, ["Startup retitle recovery"]);

  assert.equal(await applyTurnCompletionAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    baseTitle: null,
    expectedCurrentTitle: "New Codex session",
    isDisabled: () => false,
    glance: async () => ({
      id: "s1",
      agent: "codex",
      status: "running",
      title: "Manual remote title",
      tail: "Safe output",
    }),
    summarizeTitle: async () => assert.fail("stale glance must skip summary"),
    currentTitle: async () => assert.fail("stale glance must skip title read"),
    updateTitle: async () => assert.fail("stale glance must skip update"),
    rememberTitle: () => assert.fail("stale glance must skip remember"),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  }), "stale-title");
});

test("applyTurnCompletionAutoTitleSummary never promotes terminal output through fallback", async () => {
  const updates: string[] = [];
  assert.equal(await applyTurnCompletionAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    baseTitle: null,
    expectedCurrentTitle: "New Codex session",
    isDisabled: () => false,
    glance: async () => ({
      id: "s1",
      agent: "codex",
      status: "running",
      title: "New Codex session",
      tail: "Recovery code 1234-5678",
    }),
    summarizeTitle: async (body) => {
      assert.equal(body.prompt, "Completed agent task");
      assert.equal(body.recentOutput, "Recovery code 1234-5678");
      return { ok: true, title: body.prompt, source: "fallback" };
    },
    currentTitle: async () => "New Codex session",
    updateTitle: async (_machine, _id, title) => {
      updates.push(title ?? "");
      return { ok: true };
    },
    rememberTitle: () => undefined,
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  }), "updated");
  assert.deepEqual(updates, ["Completed agent task"]);
});

test("applyTurnCompletionAutoTitleSummary rejects sensitive glance context", async () => {
  assert.equal(await applyTurnCompletionAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    baseTitle: null,
    expectedCurrentTitle: "New Codex session",
    isDisabled: () => false,
    glance: async () => ({
      id: "s1",
      agent: "codex",
      status: "running",
      title: "New Codex session",
      tail: "TOKEN=secret-value",
    }),
    summarizeTitle: async () => assert.fail("sensitive output must skip summary"),
    currentTitle: async () => assert.fail("sensitive output must skip title read"),
    updateTitle: async () => assert.fail("sensitive output must skip update"),
    rememberTitle: () => assert.fail("sensitive output must skip remember"),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  }), "glance-failed");
});

test("applyManualRetitleSummary summarizes live session context with a retitle prompt", async () => {
  const remembered: string[] = [];
  const updates: string[] = [];
  const result = await applyManualRetitleSummary({
    session: { machine: "maple", id: "s1" },
    baseTitle: "Review auth module",
    expectedCurrentTitle: "Stale UI title",
    glance: async (machine, id, tail) => {
      assert.equal(machine, "maple");
      assert.equal(id, "s1");
      assert.equal(tail, MANUAL_RETITLE_GLANCE_TAIL);
      return {
        id: "s1",
        agent: "codex",
        title: "Live multi-turn title",
        status: "running",
        repo_name: "exampleOrg/agent-console",
        tail: "Discussed URL clicks.\nNow debugging manual retitle after multiple turns.",
      };
    },
    summarizeTitle: async (body) => {
      assert.deepEqual(body, {
        baseTitle: "Review auth module",
        prompt: MANUAL_RETITLE_PROMPT,
        currentTitle: "Live multi-turn title",
        recentOutput: "Discussed URL clicks.\nNow debugging manual retitle after multiple turns.",
        agent: "codex",
        repoName: "exampleOrg/agent-console",
      });
      return { ok: true, title: "Review auth module - Finding bugs", source: "summarizer" };
    },
    currentTitle: async () => "Live multi-turn title",
    updateTitle: async (_machine, _id, title) => {
      updates.push(title ?? "");
      return { ok: true };
    },
    rememberTitle: (_machine, _id, title) => remembered.push(title ?? ""),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });

  assert.equal(result, "updated");
  assert.deepEqual(remembered, ["Review auth module - Finding bugs"]);
  assert.deepEqual(updates, ["Review auth module - Finding bugs"]);
});

test("applyManualRetitleSummary skips stale live title changes", async () => {
  const result = await applyManualRetitleSummary({
    session: { machine: "maple", id: "s1" },
    baseTitle: "Review auth module",
    expectedCurrentTitle: "Stale UI title",
    glance: async () => ({
      id: "s1",
      agent: "codex",
      title: "Live multi-turn title",
      status: "running",
      repo_name: "exampleOrg/agent-console",
      tail: "Recent session context for manual retitle.",
    }),
    summarizeTitle: async (body) => {
      assert.deepEqual(body, {
        baseTitle: "Review auth module",
        prompt: MANUAL_RETITLE_PROMPT,
        currentTitle: "Live multi-turn title",
        recentOutput: "Recent session context for manual retitle.",
        agent: "codex",
        repoName: "exampleOrg/agent-console",
      });
      return { ok: true, title: "Manual retitle from stale context", source: "summarizer" };
    },
    currentTitle: async () => "Manual title from another client",
    updateTitle: async () => {
      assert.fail("stale manual retitle should not patch titles");
    },
    rememberTitle: () => assert.fail("stale manual retitle should not be remembered"),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });

  assert.equal(result, "stale-title");
});

test("applyManualRetitleSummary does not replace a title with fallback prompt text", async () => {
  const result = await applyManualRetitleSummary({
    session: { machine: "maple", id: "s1" },
    baseTitle: "Existing intent",
    expectedCurrentTitle: "Existing title",
    glance: async () => ({
      id: "s1",
      agent: "codex",
      title: "Existing title",
      status: "running",
      repo_name: "exampleOrg/agent-console",
      tail: "Useful session context",
    }),
    summarizeTitle: async () => ({
      ok: true,
      title: MANUAL_RETITLE_PROMPT,
      source: "fallback",
    }),
    currentTitle: async () => assert.fail("fallback summaries should skip title checks"),
    updateTitle: async () => assert.fail("fallback summaries should not patch titles"),
    rememberTitle: () => assert.fail("fallback summaries should not be remembered"),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });

  assert.equal(result, "summary-failed");
});

test("applyTurnPromptAutoTitleSummary skips stale manual title changes", async () => {
  const result = await applyTurnPromptAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    prompt: "update the title",
    baseTitle: null,
    expectedCurrentTitle: "Old title",
    isDisabled: () => false,
    glance: async () => ({
      id: "s1",
      agent: "codex",
      status: "running",
      title: "Manual title",
      tail: "done",
    }),
    summarizeTitle: async () => {
      assert.fail("stale glance title should be checked before summarizing");
    },
    currentTitle: async () => {
      assert.fail("stale glance title should not need a full current-title check");
    },
    updateTitle: async () => {
      assert.fail("stale title should not be patched");
    },
    rememberTitle: () => assert.fail("stale title should not be remembered"),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  });

  assert.equal(result, "stale-title");
});

test("applyTurnPromptAutoTitleSummary covers failure, unchanged, and late-stale paths", async () => {
  const baseDeps = {
    session: { machine: "maple", id: "s1" },
    prompt: "update title",
    baseTitle: null,
    expectedCurrentTitle: "Old title",
    isDisabled: () => false,
    rememberTitle: () => assert.fail("title should not be remembered"),
    onError: () => assert.fail("unexpected error"),
    refresh: () => assert.fail("unexpected refresh"),
  };

  assert.equal(await applyTurnPromptAutoTitleSummary({
    ...baseDeps,
    glance: async () => null,
    summarizeTitle: async () => assert.fail("glance failure should skip summary"),
    currentTitle: async () => assert.fail("glance failure should skip title check"),
    updateTitle: async () => assert.fail("glance failure should skip patch"),
  }), "glance-failed");

  assert.equal(await applyTurnPromptAutoTitleSummary({
    ...baseDeps,
    glance: async () => ({ id: "s1", agent: "codex", status: "running", title: "Old title", tail: "done" }),
    summarizeTitle: async () => ({ ok: false, error: "summary failed" }),
    currentTitle: async () => assert.fail("summary failure should skip title check"),
    updateTitle: async () => assert.fail("summary failure should skip patch"),
  }), "summary-failed");

  assert.equal(await applyTurnPromptAutoTitleSummary({
    ...baseDeps,
    glance: async () => ({ id: "s1", agent: "codex", status: "running", title: "Old title", tail: "done" }),
    summarizeTitle: async () => ({ ok: true, title: "Old title", source: "summarizer" }),
    currentTitle: async () => assert.fail("unchanged summary should skip title check"),
    updateTitle: async () => assert.fail("unchanged summary should skip patch"),
  }), "unchanged");

  assert.equal(await applyTurnPromptAutoTitleSummary({
    ...baseDeps,
    glance: async () => ({ id: "s1", agent: "codex", status: "running", title: "Old title", tail: "done" }),
    summarizeTitle: async () => ({ ok: true, title: "New title", source: "summarizer" }),
    currentTitle: async () => "Manual title",
    updateTitle: async () => assert.fail("late stale title should skip patch"),
  }), "stale-title");
});

test("applyTurnPromptAutoTitleSummary reports update failures", async () => {
  const errors: string[] = [];
  let refreshes = 0;
  const result = await applyTurnPromptAutoTitleSummary({
    session: { machine: "maple", id: "s1" },
    prompt: "update title",
    baseTitle: null,
    expectedCurrentTitle: "Old title",
    isDisabled: () => false,
    glance: async () => ({ id: "s1", agent: "codex", status: "running", title: "Old title", tail: "done" }),
    summarizeTitle: async () => ({ ok: true, title: "New title", source: "summarizer" }),
    currentTitle: async () => "Old title",
    updateTitle: async () => ({ ok: false, error: "title update failed" }),
    rememberTitle: () => {},
    onError: (message) => errors.push(message),
    refresh: () => {
      refreshes += 1;
    },
  });

  assert.equal(result, "update-failed");
  assert.deepEqual(errors, ["title update failed"]);
  assert.equal(refreshes, 1);
});
