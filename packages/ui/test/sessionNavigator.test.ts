import { strict as assert } from "node:assert";
import { test } from "node:test";

type NavigatorGroup = {
  label: "In grid" | "More sessions";
  sessionKeys: string[];
};

type NavigatorSelection =
  | { kind: "focus-grid"; sessionKey: string }
  | {
      kind: "open-fullscreen";
      sessionKey: string;
      restorePromptTargetKey: string | null;
    };

type SessionNavigatorModule = {
  adjacentPromptTargetKey(input: {
    orderedSessionKeys: string[];
    promptTargetKeys: string[];
    currentSessionKey: string | null;
    direction: -1 | 1;
  }): string | null;
  filteredGridSessionKeys(input: {
    filteredSessionKeys: string[];
    slotSessionKeys: Array<string | null>;
  }): string[];
  groupNavigableSessionKeys(input: {
    filteredSessionKeys: string[];
    gridSessionKeys: string[];
  }): NavigatorGroup[];
  resolveOverviewPromptTargetFocus(input: {
    currentPromptTargetKey: string | null;
    focusedSessionKey: string | null;
    focusedTerminalKey: string;
    gridSessionKeys: string[];
  }): string | null;
  resolveSessionNavigatorSelection(input: {
    selectedSessionKey: string;
    gridSessionKeys: string[];
    promptTargetKey: string | null;
    mobileOverview: boolean;
  }): NavigatorSelection;
};

test("prompt-target arrows skip stopped sessions while preserving full-list order", async () => {
  const { adjacentPromptTargetKey } = await loadSessionNavigator();
  const orderedSessionKeys = [
    "machine/s1",
    "machine/s2",
    "machine/s3",
    "machine/s4",
    "machine/s5",
    "machine/s6",
    "machine/s7",
    "machine/s8",
  ];
  const promptTargetKeys = orderedSessionKeys.filter((key) => key !== "machine/s5");

  assert.equal(
    adjacentPromptTargetKey({
      orderedSessionKeys,
      promptTargetKeys,
      currentSessionKey: "machine/s4",
      direction: 1,
    }),
    "machine/s6",
  );
  assert.equal(
    adjacentPromptTargetKey({
      orderedSessionKeys,
      promptTargetKeys,
      currentSessionKey: "machine/s6",
      direction: -1,
    }),
    "machine/s4",
  );
  assert.equal(
    adjacentPromptTargetKey({
      orderedSessionKeys,
      promptTargetKeys,
      currentSessionKey: "machine/s8",
      direction: 1,
    }),
    "machine/s1",
  );
});

test("prompt-target arrows return no target when every session is stopped", async () => {
  const { adjacentPromptTargetKey } = await loadSessionNavigator();

  assert.equal(
    adjacentPromptTargetKey({
      orderedSessionKeys: ["machine/s1", "machine/s2"],
      promptTargetKeys: [],
      currentSessionKey: "machine/s1",
      direction: 1,
    }),
    null,
  );
});

async function loadSessionNavigator(): Promise<SessionNavigatorModule> {
  const moduleUrl = new URL("../src/sessionNavigator.ts", import.meta.url).href;
  const sessionNavigator = (await import(moduleUrl).catch(() => null)) as
    | SessionNavigatorModule
    | null;

  assert.ok(
    sessionNavigator,
    "sessionNavigator helper should exist for prompt-target selection",
  );
  return sessionNavigator;
}

test("session navigator groups grid sessions before filtered overflow sessions", async () => {
  const { groupNavigableSessionKeys } = await loadSessionNavigator();

  assert.deepEqual(
    groupNavigableSessionKeys({
      filteredSessionKeys: ["machine/s4", "machine/s2", "machine/s1"],
      gridSessionKeys: ["machine/s1", "machine/s2", "machine/s3"],
    }),
    [
      { label: "In grid", sessionKeys: ["machine/s1", "machine/s2"] },
      { label: "More sessions", sessionKeys: ["machine/s4"] },
    ],
  );
});

test("navigator grid keys exclude slots hidden by the active machine filter", async () => {
  const { filteredGridSessionKeys } = await loadSessionNavigator();

  assert.deepEqual(
    filteredGridSessionKeys({
      filteredSessionKeys: ["machine-a/s1", "machine-a/s3"],
      slotSessionKeys: ["machine-a/s1", "machine-b/s2", null, "machine-a/s3"],
    }),
    ["machine-a/s1", "machine-a/s3"],
  );
});

test("fullscreen terminal focus cannot replace the overview grid prompt target", async () => {
  const { resolveOverviewPromptTargetFocus } = await loadSessionNavigator();
  const input = {
    currentPromptTargetKey: "machine/s1",
    gridSessionKeys: ["machine/s1", "machine/s2"],
  };

  assert.equal(
    resolveOverviewPromptTargetFocus({
      ...input,
      focusedSessionKey: "machine/s3",
      focusedTerminalKey: "machine/s3",
    }),
    "machine/s1",
  );
  assert.equal(
    resolveOverviewPromptTargetFocus({
      ...input,
      focusedSessionKey: null,
      focusedTerminalKey: "machine/s2",
    }),
    "machine/s2",
  );
});

test("desktop selection focuses grid input and opens overflow without changing slots", async () => {
  const { resolveSessionNavigatorSelection } = await loadSessionNavigator();
  const input = {
    gridSessionKeys: ["machine/s1", "machine/s2"],
    promptTargetKey: "machine/s1",
    mobileOverview: false,
  };

  assert.deepEqual(
    resolveSessionNavigatorSelection({
      ...input,
      selectedSessionKey: "machine/s2",
    }),
    { kind: "focus-grid", sessionKey: "machine/s2" },
  );
  assert.deepEqual(
    resolveSessionNavigatorSelection({
      ...input,
      selectedSessionKey: "machine/s3",
    }),
    {
      kind: "open-fullscreen",
      sessionKey: "machine/s3",
      restorePromptTargetKey: "machine/s1",
    },
  );
});

test("mobile overview opens every selected session fullscreen", async () => {
  const { resolveSessionNavigatorSelection } = await loadSessionNavigator();

  assert.deepEqual(
    resolveSessionNavigatorSelection({
      selectedSessionKey: "machine/s1",
      gridSessionKeys: ["machine/s1"],
      promptTargetKey: null,
      mobileOverview: true,
    }),
    {
      kind: "open-fullscreen",
      sessionKey: "machine/s1",
      restorePromptTargetKey: null,
    },
  );
});
