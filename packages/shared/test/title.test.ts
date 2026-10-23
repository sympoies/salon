import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MAX_TITLE_CHARS,
  composedTitleBase,
  composeTitle,
  isSensitiveTitleLine,
  normalizeSessionTitleState,
  oneLineTitle,
  promptTitleSuffix,
  renderSessionTitleState,
  safeTitleLine,
  stripComposedTitleBase,
  titleActionSegments,
  truncateTitle,
  userSessionTitleState,
} from "../src/title.ts";

test("oneLineTitle uses the first meaningful line and collapses whitespace", () => {
  assert.equal(oneLineTitle("  Fix  the\tdashboard title\n\nMore detail here  "), "Fix the dashboard title");
  assert.equal(oneLineTitle("\n\n\t"), null);
  assert.equal(oneLineTitle(null), null);
});

test("safe title lines reject credential-like values", () => {
  for (const line of [
    "TOKEN=ghp_1234567890abcdef",
    "Authorization: Bearer abcdef1234567890",
    "sk-proj-1234567890abcdef",
    "psql postgresql://alice:hunter2@db/prod",
    "curl -u alice:hunter2 https://api.example.test",
    "DATABASE_URL=postgres://alice:hunter2@db/prod",
    "SENTRY_DSN=https://abc123@example.com/2",
  ]) {
    assert.equal(isSensitiveTitleLine(line), true, line);
    assert.equal(safeTitleLine(line), null, line);
  }
});

test("long hyphenated document names and repo paths stay title-eligible", () => {
  const reportedPrompt = "2026-07-24-session-overview-layout-state-repair.md check whether this is finished";

  assert.equal(isSensitiveTitleLine(reportedPrompt), false, reportedPrompt);
  assert.equal(promptTitleSuffix(reportedPrompt), reportedPrompt);
  assert.equal(
    promptTitleSuffix("docs/provider-activity-state-contract.md check this"),
    "docs/provider-activity-state-contract.md check this",
  );
  assert.equal(
    promptTitleSuffix("packages/ui/test/sessionListNavigationIntegration.test.ts is failing"),
    "packages/ui/test/sessionListNavigationIntegration.test.ts is failing",
  );
  assert.equal(
    promptTitleSuffix("/deliver-pr docs/plans/2026-07-24-session-overview-layout-state-repair.md"),
    "deliver-pr docs/plans/2026-07-24-session-overview-layout-state-repair.md",
  );
});

test("separated long tokens stay opaque unless every segment is a word or date part", () => {
  const opaqueTokens = [
    `${"aB3dE9fG1hJ2-".repeat(4)}aB3dE9fG1hJ2`,
    `${"ABCDE-".repeat(8)}ABCDE`,
    "dGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgc2VjcmV0IHZhbHVl",
    "c299c11418ef5b3352453931da84d5ad1d7d8376a74d216a24bfba2f4abab4fe",
  ];

  for (const token of opaqueTokens) {
    const line = `Rotate ${token} today`;
    assert.equal(isSensitiveTitleLine(line), true, line);
    // The opaque run is removed rather than vetoing the surrounding task words.
    assert.equal(promptTitleSuffix(line), "Rotate today", line);
  }
});

test("promptTitleSuffix normalizes, filters, and truncates prompt text", () => {
  assert.equal(promptTitleSuffix("  Fix the dashboard title\n\nMore detail here  "), "Fix the dashboard title");
  assert.equal(promptTitleSuffix("password=hunter2"), null);
  assert.equal(promptTitleSuffix("x ".repeat(200))?.length, MAX_TITLE_CHARS);
});

test("promptTitleSuffix removes ordinary web URLs while preserving adjacent task text", () => {
  const reportedPrompt = "https://github.com/example-user/agent-runtime-kit/issues/657 處理掉這個 issue 要考慮到 codex 的情況 反正有 .tera 能做不同版本的規則對吧";

  assert.equal(
    promptTitleSuffix(reportedPrompt),
    "處理掉這個 issue 要考慮到 codex 的情況 反正有 .tera 能做不同版本的規則對吧",
  );
  assert.equal(promptTitleSuffix("Review https://github.com/example-org/agent-console/issues/359 now"), "Review now");
  assert.equal(promptTitleSuffix("https://github.com/example-org/agent-console/issues/359"), null);
});

test("web URL filtering stays closed for credentials and secret-like values", () => {
  for (const prompt of [
    "https://alice:hunter2@example.com/issues/359 Fix the issue",
    "Inspect_https://alice:hunter2@example.com/issues/359 now",
    "https://example.test/issues/359?token=secret-value Fix the issue",
    'Review https://example.test/?%74oken="hunter2" now',
    "Review https://example.test/?%74oken=`hunter2` now",
    "Review https://example.test/?%74oken=<hunter2> now",
    "Review https://example.test/?%74oken= hunter2 now",
    'Review https://example.test/?access_token="hunter2" now',
    "Review https://example.test/?refresh_token= hunter2 now",
    "Review https://example.test/?client_secret=<hunter2> now",
    'Review https://example.test/#%74oken="hunter2" now',
    "api https://example.test key=hunter2",
    `https://example.test/issues/359?state=${"a".repeat(40)} Fix the issue`,
  ]) {
    assert.equal(promptTitleSuffix(prompt), null, prompt);
  }
});

test("an opaque token is dropped from an otherwise safe line", () => {
  assert.equal(
    promptTitleSuffix(`Inspect ${"a".repeat(40)} while fixing the issue`),
    "Inspect while fixing the issue",
  );
  assert.equal(promptTitleSuffix("a".repeat(40)), null);
  // An explicit credential shape still taints its whole line.
  assert.equal(promptTitleSuffix(`Set token ${"a".repeat(40)} for the run`), null);
});

test("promptTitleSuffix preserves skill intent across dollar and slash forms", () => {
  assert.equal(promptTitleSuffix("/deliver-pr 23"), "deliver-pr 23");
  assert.equal(promptTitleSuffix("$pr:deliver-pr 23"), "pr:deliver-pr 23");
  assert.equal(
    promptTitleSuffix("/code-review\nReview the authentication module"),
    "code-review Review the authentication module",
  );
  assert.equal(
    promptTitleSuffix("$review\nTOKEN=secret-value\nFind concurrency bugs"),
    "review Find concurrency bugs",
  );
  assert.equal(promptTitleSuffix("/home/runner/Project"), "/home/runner/Project");
  assert.equal(promptTitleSuffix("$HOME/bin"), "$HOME/bin");
});

test("promptTitleSuffix skips whitespace-separated credentials in standalone skill details", () => {
  assert.equal(
    promptTitleSuffix("$private-secrets\npassword hunter2\nRotate the credential"),
    "private-secrets Rotate the credential",
  );
  assert.equal(
    promptTitleSuffix("/private-secrets\napi key hunter2\nRotate the credential"),
    "private-secrets Rotate the credential",
  );
  assert.equal(
    promptTitleSuffix("$review\ntoken short-secret\nFind concurrency bugs"),
    "review Find concurrency bugs",
  );
  assert.equal(promptTitleSuffix("$private-secrets\nsecret hunter2"), "private-secrets");
});

test("credential filtering preserves ordinary auth, token, and secret task language", () => {
  assert.equal(safeTitleLine("auth module"), "auth module");
  assert.equal(safeTitleLine("token bucket implementation"), "token bucket implementation");
  assert.equal(safeTitleLine("secret manager integration"), "secret manager integration");
  assert.equal(promptTitleSuffix("$review\nauth module\nFind bugs"), "review auth module");
});

test("credential filtering rejects alphabetic-only declaration values", () => {
  assert.equal(promptTitleSuffix("$review\npassword huntertwo\nFind bugs"), "review Find bugs");
  assert.equal(safeTitleLine("api key alphabeticsecret"), null);
  assert.equal(safeTitleLine("private key alphabeticsecret"), null);
  assert.equal(safeTitleLine("token alphabeticsecret"), null);
  assert.equal(safeTitleLine("secret alphabeticsecret"), null);
  assert.equal(safeTitleLine("api key=alphabeticsecret"), null);
  assert.equal(safeTitleLine("api key: alphabeticsecret"), null);
  assert.equal(safeTitleLine("private key=alphabeticsecret"), null);
  assert.equal(safeTitleLine("access key: alphabeticsecret"), null);
  assert.equal(
    promptTitleSuffix("$review\napi key: alphabeticsecret\nFind bugs"),
    "review Find bugs",
  );
});

test("credential filtering keeps ambiguous bare declarations closed while preserving action phrasing", () => {
  for (const task of [
    "password reset flow",
    "api key rotation",
    "private key rotation",
    "credential cleanup task",
    "token refresh",
    "secret manager",
  ]) {
    assert.equal(safeTitleLine(task), null);
    const action = `Review ${task}`;
    assert.equal(safeTitleLine(action), action);
    assert.equal(promptTitleSuffix(`$review\n${action}\nFind bugs`), `review ${action}`);
  }
});

test("composeTitle preserves the shared base/suffix length contract", () => {
  assert.equal(composeTitle("agent-console", "Fix title flow"), "agent-console - Fix title flow");
  assert.equal(composeTitle(null, "Fix title flow"), "Fix title flow");

  const title = composeTitle("agent-console", "x ".repeat(200));
  assert.equal(title?.length, MAX_TITLE_CHARS);
  assert.match(title ?? "", /^agent-console - /);
});

test("structured title state renders without inferring topic ownership from delimiters", () => {
  assert.equal(renderSessionTitleState({
    topic: null,
    topic_source: "none",
    references: [],
    activity: "中文說明",
  }), "中文說明");
  assert.equal(renderSessionTitleState({
    topic: "Retitle rules",
    topic_source: "auto",
    references: ["#317"],
    activity: "Implement daemon contract",
  }), "Retitle rules #317 - Implement daemon contract");
  assert.equal(renderSessionTitleState({
    topic: "Retitle #317 rules",
    topic_source: "user",
    references: ["#317"],
    activity: null,
  }), "Retitle #317 rules");
  assert.deepEqual(userSessionTitleState("Review API - security boundaries"), {
    topic: "Review API - security boundaries",
    topic_source: "user",
    references: [],
    activity: null,
  });
});

test("structured title state normalization canonicalizes valid input and rejects malformed ownership", () => {
  assert.deepEqual(normalizeSessionTitleState({
    topic: "  Retitle   rules  ",
    topic_source: "auto",
    references: ["#317", "#317"],
    activity: "  Implement   contract ",
  }), {
    topic: "Retitle rules",
    topic_source: "auto",
    references: ["#317"],
    activity: "Implement contract",
  });
  for (const invalid of [
    { topic: "Retitle", topic_source: "future", references: [], activity: null },
    { topic: "Retitle", topic_source: "none", references: [], activity: null },
    { topic: "Retitle", topic_source: "auto", references: ["317"], activity: null },
    { topic: "x".repeat(MAX_TITLE_CHARS + 1), topic_source: "auto", references: [], activity: null },
  ]) {
    assert.equal(normalizeSessionTitleState(invalid), null);
  }
});

test("structured title state keeps references visible when a long topic is truncated", () => {
  const rendered = renderSessionTitleState({
    topic: `${"x".repeat(100)} #317`,
    topic_source: "auto",
    references: ["#317"],
    activity: "Implement contract",
  });

  assert.match(rendered ?? "", /#317 - Implement contract$/);
});

test("structured title state accepts and renders a cross-repository reference", () => {
  const state = normalizeSessionTitleState({
    topic: "Improve session titles",
    topic_source: "auto",
    references: ["#12", "agent-console #3"],
    activity: null,
  });
  assert.ok(state);
  assert.equal(renderSessionTitleState(state), "Improve session titles #12 agent-console #3");
  assert.equal(renderSessionTitleState({
    topic: "Investigate fooXbar #3",
    topic_source: "auto",
    references: ["foo.bar #3"],
    activity: null,
  }), "Investigate fooXbar #3 foo.bar #3");
  assert.equal(renderSessionTitleState({
    topic: "Fix agent-console #3",
    topic_source: "auto",
    references: ["#3", "agent-console #3"],
    activity: null,
  }), "Fix agent-console #3 #3");
  assert.equal(renderSessionTitleState({
    topic: "Fix myagent-console #3",
    topic_source: "auto",
    references: ["agent-console #3"],
    activity: null,
  }), "Fix myagent-console #3 agent-console #3");
});

test("long qualified references retain both issue numbers within title limit", () => {
  const state = normalizeSessionTitleState({
    topic: "Investigate cross-repository work",
    topic_source: "auto",
    references: [`a${"x".repeat(63)} #1234567890`, `b${"y".repeat(63)} #9876543210`],
    activity: null,
  });
  assert.ok(state);
  const title = renderSessionTitleState(state);
  assert.ok(title);
  assert.ok(Array.from(title).length <= MAX_TITLE_CHARS);
  assert.match(title, /#1234567890/);
  assert.match(title, /#9876543210/);
});

test("structured title state requires an ASCII word-token boundary after references", () => {
  const render = (topic: string) => renderSessionTitleState({
    topic,
    topic_source: "auto",
    references: ["#317"],
    activity: "Implement fix",
  });

  assert.equal(render("Parser #317alpha"), "Parser #317alpha #317 - Implement fix");
  assert.equal(render("Parser #317_foo"), "Parser #317_foo #317 - Implement fix");
  assert.equal(render("Parser #317"), "Parser #317 - Implement fix");
});

test("composed title helpers recover and remove the stable intent", () => {
  assert.equal(composedTitleBase("Review auth module - Finding bugs"), "Review auth module");
  assert.equal(composedTitleBase("PR #23"), "PR #23");
  assert.equal(stripComposedTitleBase("PR #23", "PR #23 - Resolving review threads"), "Resolving review threads");
  assert.equal(stripComposedTitleBase("PR #23", "PR #23"), null);
  assert.equal(stripComposedTitleBase("PR #23", "Review another PR"), "Review another PR");
  assert.equal(stripComposedTitleBase("PR #23", "PR #23 — Finding bugs"), "Finding bugs");
  assert.equal(stripComposedTitleBase("PR #23", "PR #23 – Finding bugs"), "Finding bugs");
  assert.equal(
    stripComposedTitleBase(
      "Review API - security boundaries",
      "Review API - security boundaries - Finding bugs",
    ),
    "Finding bugs",
  );

  const longBase = "Review auth module ".repeat(8).slice(0, MAX_TITLE_CHARS);
  const composed = composeTitle(longBase, "Finding bugs");
  assert.equal(stripComposedTitleBase(longBase, composed), "Finding bugs");
  assert.equal(composeTitle(longBase, stripComposedTitleBase(longBase, composed)), composed);
});

test("composeTitle reserves the intent-action delimiter by canonicalizing base separators", () => {
  const composed = composeTitle("Review API - security boundaries", "Finding bugs");
  assert.equal(composed, "Review API — security boundaries - Finding bugs");
  assert.equal(composedTitleBase(composed), "Review API — security boundaries");
  assert.deepEqual(titleActionSegments("PR #23 — Finding bugs – Updating tests"), [
    "PR #23",
    "Finding bugs",
    "Updating tests",
  ]);
});

test("truncateTitle is unicode-aware and uses ellipsis dots when possible", () => {
  assert.equal(truncateTitle("abcdef", 6), "abcdef");
  assert.equal(truncateTitle("abcdef", 5), "ab...");
  assert.equal(truncateTitle("abcdef", 3), "abc");
  assert.equal(truncateTitle("abcd😀", 5), "abcd😀");
});
