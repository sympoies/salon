import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resumeCommand, type SessionLike } from "../src/format.ts";
import {
  parseProviderResumeInput,
  planResumeFieldInput,
  planResumePaste,
} from "../src/providerResume.ts";

const CODEX_ID = "019f4cd4-54fc-7663-b88f-9da49b1cc9d4";
const CLAUDE_ID = "6b8f2c11-0a3d-4e5f-9a7b-2c1d3e4f5a6b";

test("parses a full codex resume command copied from the session menu", () => {
  assert.deepEqual(
    parseProviderResumeInput(
      `codex resume ${CODEX_ID} --cd /home/runner/Project/summit/agent-console --no-alt-screen`,
    ),
    { id: CODEX_ID, provider: "codex" },
  );
});

test("parses a full claude resume command", () => {
  assert.deepEqual(parseProviderResumeInput(`claude --resume ${CLAUDE_ID}`), {
    id: CLAUDE_ID,
    provider: "claude",
  });
});

test("parses the claude -r short flag", () => {
  assert.deepEqual(parseProviderResumeInput(`claude -r ${CLAUDE_ID}`), {
    id: CLAUDE_ID,
    provider: "claude",
  });
});

test("ignores a UUID sitting inside the --cd path and keeps the real session id", () => {
  const result = parseProviderResumeInput(
    `codex resume ${CODEX_ID} --cd /srv/runs/${CLAUDE_ID}/repo --no-alt-screen`,
  );
  assert.equal(result.id, CODEX_ID);
  assert.equal(result.provider, "codex");
});

test("trims surrounding whitespace/newlines from a pasted command", () => {
  assert.deepEqual(parseProviderResumeInput(`\n  codex resume ${CODEX_ID}  \n`), {
    id: CODEX_ID,
    provider: "codex",
  });
});

test("passes a bare uuid through unchanged with no provider", () => {
  assert.deepEqual(parseProviderResumeInput(`  ${CODEX_ID}  `), { id: CODEX_ID });
});

test("keeps a non-uuid bare id verbatim (lenient fallback)", () => {
  assert.deepEqual(parseProviderResumeInput("  external-claude-id  "), {
    id: "external-claude-id",
  });
});

test("returns an empty id for blank input", () => {
  assert.deepEqual(parseProviderResumeInput("   "), { id: "" });
});

// A provider-prefixed command that carries no usable id must NOT echo the
// command text back as a bogus session id (it would otherwise be submittable).
test("returns an empty id for a provider command with no session id", () => {
  assert.deepEqual(parseProviderResumeInput("claude --resume"), { id: "", provider: "claude" });
  assert.deepEqual(parseProviderResumeInput("codex"), { id: "", provider: "codex" });
  assert.deepEqual(parseProviderResumeInput("codex foo bar"), { id: "", provider: "codex" });
  assert.deepEqual(parseProviderResumeInput("codex resume --cd /x"), { id: "", provider: "codex" });
});

test("keeps a non-uuid id that follows an explicit resume marker", () => {
  assert.deepEqual(parseProviderResumeInput("claude --resume external-id"), {
    id: "external-id",
    provider: "claude",
  });
});

test("strips surrounding quotes from the token after the resume marker", () => {
  assert.deepEqual(parseProviderResumeInput("claude --resume 'external-id'"), {
    id: "external-id",
    provider: "claude",
  });
});

test("preserves uppercase UUIDs", () => {
  const upper = CODEX_ID.toUpperCase();
  assert.deepEqual(parseProviderResumeInput(`codex resume ${upper}`), {
    id: upper,
    provider: "codex",
  });
});

test("skips a flag directly after the marker and scans for the UUID", () => {
  assert.deepEqual(parseProviderResumeInput(`claude -r --verbose ${CLAUDE_ID}`), {
    id: CLAUDE_ID,
    provider: "claude",
  });
});

// Security boundary: the parser normalizes, it does not sanitize. These pin the
// intended passthrough so any future "sanitize here" change is deliberate.
test("passes hostile-looking tokens through without sanitizing", () => {
  assert.deepEqual(parseProviderResumeInput("codex resume ;reboot --cd x"), {
    id: ";reboot",
    provider: "codex",
  });
  assert.deepEqual(parseProviderResumeInput("codex resume 'a;b'"), { id: "a;b", provider: "codex" });
  assert.deepEqual(parseProviderResumeInput("-rf"), { id: "-rf" });
});

// Round-trip: whatever `resumeCommand` produces must parse back to the same id.
test("round-trips a codex command produced by resumeCommand", () => {
  const session: SessionLike = {
    id: "sess-1",
    provider_resume: {
      provider: "codex",
      session_id: CODEX_ID,
      resume_args: ["resume", CODEX_ID, "--cd", "/home/runner/repo", "--no-alt-screen"],
    },
  };
  const command = resumeCommand(session);
  assert.ok(command);
  assert.deepEqual(parseProviderResumeInput(command), { id: CODEX_ID, provider: "codex" });
});

test("round-trips a claude command produced by resumeCommand", () => {
  const session: SessionLike = {
    id: "sess-2",
    provider_resume: { provider: "claude", session_id: CLAUDE_ID },
  };
  const command = resumeCommand(session);
  assert.ok(command);
  assert.deepEqual(parseProviderResumeInput(command), { id: CLAUDE_ID, provider: "claude" });
});

test("planResumePaste intercepts a full command and normalizes to the id", () => {
  assert.deepEqual(planResumePaste(`codex resume ${CODEX_ID} --cd /x --no-alt-screen`), {
    intercept: true,
    id: CODEX_ID,
    provider: "codex",
    hint: "Detected codex session ID",
  });
});

test("planResumeFieldInput normalizes an Android-style input event without a paste event", () => {
  assert.deepEqual(
    planResumeFieldInput(
      "codex resume 019f5313-5c8b-7593-a793-7ba7f175c88b --cd /home/runner/Project/sampleRepo/agent-runtime-kit --no-alt-screen",
    ),
    {
      normalized: true,
      value: "019f5313-5c8b-7593-a793-7ba7f175c88b",
      provider: "codex",
      hint: "Detected codex session ID",
    },
  );
  assert.deepEqual(planResumeFieldInput("claude --resume external-id", "insertFromPaste"), {
    normalized: true,
    value: "external-id",
    provider: "claude",
    hint: "Detected claude session ID",
  });
});

test("planResumeFieldInput preserves manual and bare-id edits", () => {
  assert.deepEqual(planResumeFieldInput(CODEX_ID), {
    normalized: false,
    value: CODEX_ID,
    hint: null,
  });
  assert.deepEqual(planResumeFieldInput("external-claude-id"), {
    normalized: false,
    value: "external-claude-id",
    hint: null,
  });
  assert.deepEqual(planResumeFieldInput("codex resume 0"), {
    normalized: false,
    value: "codex resume 0",
    hint: null,
  });
});

test("planResumePaste does not intercept a bare id paste", () => {
  assert.deepEqual(planResumePaste(CODEX_ID), { intercept: false, id: CODEX_ID, hint: null });
  assert.deepEqual(planResumePaste("external-claude-id"), {
    intercept: false,
    id: "external-claude-id",
    hint: null,
  });
});

test("planResumePaste does not intercept an id-less command", () => {
  assert.deepEqual(planResumePaste("claude --resume"), { intercept: false, id: "", hint: null });
});
