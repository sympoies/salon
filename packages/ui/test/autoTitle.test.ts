import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  autoTitleFromPrompt,
  autoTitleStatesEqual,
  composeAutoTitle,
  deriveAutoTitleStateFromSession,
  isAutoTitlePlaceholder,
  pruneAutoTitleStates,
  promptTitleSuffix,
  readAutoTitleStates,
  recoverAutoTitleBase,
  titleCandidateFromSummary,
  writeAutoTitleStates,
} from "../src/autoTitle.ts";
import { MAX_SESSION_TITLE_LEN } from "../src/sessionTitle.ts";

test("promptTitleSuffix collapses whitespace and uses the first meaningful prompt line", () => {
  assert.equal(promptTitleSuffix("  Fix the dashboard title\n\nMore detail here  "), "Fix the dashboard title");
  assert.equal(promptTitleSuffix("\n\n\t"), null);
});

test("promptTitleSuffix suppresses credential-like prompt lines", () => {
  assert.equal(promptTitleSuffix("TOKEN=ghp_1234567890abcdef\nuse this"), null);
  assert.equal(promptTitleSuffix("Authorization: Bearer abcdef1234567890"), null);
  assert.equal(promptTitleSuffix("sk-proj-1234567890abcdef"), null);
  assert.equal(promptTitleSuffix("psql postgresql://alice:hunter2@db/prod"), null);
  assert.equal(promptTitleSuffix("curl -u alice:hunter2 https://api.example.test"), null);
  assert.equal(promptTitleSuffix("DATABASE_URL=postgres://alice:hunter2@db/prod"), null);
  assert.equal(promptTitleSuffix("SENTRY_DSN=https://abc123@example.com/2"), null);
});

test("composeAutoTitle appends the latest prompt suffix to a base title", () => {
  assert.equal(composeAutoTitle("agent-console", "Fix title flow"), "agent-console - Fix title flow");
  assert.equal(composeAutoTitle(null, "Fix title flow"), "Fix title flow");
});

test("autoTitleFromPrompt respects the shared title length limit", () => {
  const title = autoTitleFromPrompt("agent-console", "x ".repeat(200));
  assert.equal(title?.length, MAX_SESSION_TITLE_LEN);
  assert.match(title ?? "", /^agent-console - /);
});

test("autoTitleFromPrompt falls back to the base title for credential-like prompts", () => {
  assert.equal(autoTitleFromPrompt("agent-console", "password=hunter2"), "agent-console");
  assert.equal(autoTitleFromPrompt(null, "password=hunter2"), null);
});

test("titleCandidateFromSummary accepts a complete edge-generated title", () => {
  assert.equal(titleCandidateFromSummary({ title: "agent-console - title summarizer" }), "agent-console - title summarizer");
  assert.equal(titleCandidateFromSummary({ title: "title summarizer" }), "title summarizer");
  assert.equal(titleCandidateFromSummary({}), null);
});

test("recoverAutoTitleBase reads explicit state and never parses the rendered title", () => {
  assert.equal(
    recoverAutoTitleBase("Review auth module - Finding bugs", {
      topic: "Review auth module",
      topic_source: "auto",
      references: [],
      activity: "Finding bugs",
    }),
    "Review auth module",
  );
  assert.equal(recoverAutoTitleBase("Review auth module - Finding bugs"), null);
  assert.equal(recoverAutoTitleBase("New Codex session"), null);
  assert.equal(recoverAutoTitleBase(null), null);
});

test("session snapshots derive automatic ownership from structured state, never rendered activity", () => {
  assert.deepEqual(deriveAutoTitleStateFromSession(
    { baseTitle: null, baseTitleConfirmed: false, disabled: false, ownedTitle: "New Codex session" },
    "Retitle rules #317 - Implement contract",
    {
      topic: "Retitle rules",
      topic_source: "auto",
      references: ["#317"],
      activity: "Implement contract",
    },
  ), {
    baseTitle: "Retitle rules",
    baseTitleConfirmed: true,
    disabled: false,
    ownedTitle: "Retitle rules #317 - Implement contract",
  });
  assert.deepEqual(deriveAutoTitleStateFromSession(
    undefined,
    "Implement contract",
    { topic: null, topic_source: "none", references: [], activity: "Implement contract" },
  ), {
    baseTitle: null,
    baseTitleConfirmed: false,
    disabled: false,
    ownedTitle: "Implement contract",
  });
});

test("isAutoTitlePlaceholder recognizes only normalized new-session labels", () => {
  assert.equal(isAutoTitlePlaceholder("New Codex session"), true);
  assert.equal(isAutoTitlePlaceholder("  new Claude session  "), true);
  assert.equal(isAutoTitlePlaceholder("Codex session"), false);
  assert.equal(isAutoTitlePlaceholder("New Codex session - Fix title"), false);
  assert.equal(isAutoTitlePlaceholder(null), false);
});

test("auto title state survives localStorage round trips", () => {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  writeAutoTitleStates(localStorage, {
    "maple:s1": {
      baseTitle: "agent-console",
      baseTitleConfirmed: true,
      disabled: false,
      ownedTitle: "agent-console - Fix title flow",
    },
    "maple:s2": { baseTitle: null, baseTitleConfirmed: false, disabled: true, ownedTitle: null },
  });
  assert.deepEqual(readAutoTitleStates(localStorage), {
    "maple:s1": {
      baseTitle: "agent-console",
      baseTitleConfirmed: true,
      disabled: false,
      ownedTitle: "agent-console - Fix title flow",
    },
    "maple:s2": { baseTitle: null, baseTitleConfirmed: false, disabled: true, ownedTitle: null },
  });
});

test("legacy auto title state without lineage migrates fail closed", () => {
  const storage = {
    getItem: () => JSON.stringify({ "maple:s1": { baseTitle: "agent-console", disabled: false } }),
    setItem: () => undefined,
  };
  assert.deepEqual(readAutoTitleStates(storage), {
    "maple:s1": { baseTitle: "agent-console", baseTitleConfirmed: false, disabled: true },
  });
});

test("legacy auto title state with lineage marks its base as unconfirmed", () => {
  const storage = {
    getItem: () => JSON.stringify({
      "maple:s1": {
        baseTitle: "Original first prompt",
        disabled: false,
        ownedTitle: "Original first prompt",
      },
    }),
    setItem: () => undefined,
  };
  assert.deepEqual(readAutoTitleStates(storage), {
    "maple:s1": {
      baseTitle: "Original first prompt",
      baseTitleConfirmed: false,
      disabled: false,
      ownedTitle: "Original first prompt",
    },
  });
});

test("auto title state tolerates blocked localStorage reads and writes", () => {
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota");
    },
  };

  assert.deepEqual(readAutoTitleStates(blocked), {});
  assert.doesNotThrow(() => {
    writeAutoTitleStates(blocked, {
      "maple:s1": { baseTitle: "agent-console", disabled: false },
    });
  });
});

test("auto title state equality compares persisted title controls", () => {
  assert.equal(autoTitleStatesEqual({}, {}), true);
  assert.equal(autoTitleStatesEqual({
    "maple:s1": { baseTitle: "agent-console", disabled: false },
  }, {
    "maple:s1": { baseTitle: "agent-console", disabled: false },
  }), true);
  assert.equal(autoTitleStatesEqual({
    "maple:s1": { baseTitle: "agent-console", disabled: false },
  }, {
    "maple:s1": { baseTitle: "agent-console", disabled: true },
  }), false);
});

test("auto title state pruning drops closed sessions without rewriting unchanged state", () => {
  const states = {
    "maple:s1": { baseTitle: "agent-console", disabled: false },
    "maple:s2": { baseTitle: null, disabled: true },
  };
  assert.deepEqual(pruneAutoTitleStates(states, ["maple:s1"]), {
    "maple:s1": { baseTitle: "agent-console", disabled: false },
  });
  assert.equal(pruneAutoTitleStates(states, ["maple:s1", "maple:s2"]), states);
});
