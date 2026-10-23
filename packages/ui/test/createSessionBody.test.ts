import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createSessionBody } from "../src/createSessionBody.ts";

const selectedRepo = {
  displayValue: "agent-console",
  selectedPath: "/home/runner/Project/summit/agent-console",
};

test("createSessionBody builds a fresh create payload", () => {
  assert.deepEqual(
    createSessionBody({
      mode: "new",
      agent: "codex",
      title: "  Work on edge  ",
      workdirSelection: selectedRepo,
      prompt: "Initial prompt\nwith detail",
      providerResumeId: "",
      account: "account-secondary",
    }),
    {
      agent: "codex",
      title: "Work on edge",
      cwd: "/home/runner/Project/summit/agent-console",
      prompt: "Initial prompt\nwith detail",
      codex_account: "account-secondary",
    },
  );
});

test("createSessionBody keeps the Claude base agent for an advertised launch profile", () => {
  assert.deepEqual(
    createSessionBody({
      mode: "new",
      agent: "claude",
      agentProfile: "custom-claude",
      title: "GPT through Claude",
      workdirSelection: selectedRepo,
      prompt: "Use the local proxy",
      providerResumeId: "",
      account: "",
    }),
    {
      agent: "claude",
      agent_profile: "custom-claude",
      title: "GPT through Claude",
      cwd: "/home/runner/Project/summit/agent-console",
      prompt: "Use the local proxy",
    },
  );
});

test("createSessionBody sends a DSH launch profile without injected agent args", () => {
  // A launch profile owns its whole launch command, so nothing is layered on it.
  assert.deepEqual(
    createSessionBody({
      mode: "new",
      agent: "dsh",
      agentProfile: "dsh-workbench",
      title: "DSH",
      workdirSelection: selectedRepo,
      prompt: "",
      providerResumeId: "",
      account: "",
    }),
    {
      agent: "dsh",
      agent_profile: "dsh-workbench",
      title: "DSH",
      cwd: "/home/runner/Project/summit/agent-console",
    },
  );
});

test("createSessionBody builds a resume-id import payload without cwd or prompt", () => {
  assert.deepEqual(
    createSessionBody({
      mode: "resume",
      agent: "claude",
      title: "  Imported Claude  ",
      workdirSelection: selectedRepo,
      prompt: "ignored in resume mode",
      providerResumeId: "  external-claude-id  ",
      account: "account-secondary",
    }),
    {
      agent: "claude",
      title: "Imported Claude",
      provider_resume_id: "external-claude-id",
    },
  );
});

test("createSessionBody preserves an advertised launch profile for resume-id import", () => {
  assert.deepEqual(
    createSessionBody({
      mode: "resume",
      agent: "claude",
      agentProfile: "custom-claude",
      title: "Profile import",
      workdirSelection: selectedRepo,
      prompt: "ignored in resume mode",
      providerResumeId: "profile-owned-provider-id",
      account: "",
    }),
    {
      agent: "claude",
      agent_profile: "custom-claude",
      title: "Profile import",
      provider_resume_id: "profile-owned-provider-id",
    },
  );
});

test("createSessionBody extracts the session id from a pasted resume command", () => {
  assert.deepEqual(
    createSessionBody({
      mode: "resume",
      agent: "codex",
      title: "",
      workdirSelection: { displayValue: "", selectedPath: "" },
      prompt: "",
      providerResumeId:
        "codex resume 019f4cd4-54fc-7663-b88f-9da49b1cc9d4 --cd /home/runner/Project/summit/agent-console --no-alt-screen",
      account: "account-secondary",
    }),
    {
      agent: "codex",
      provider_resume_id: "019f4cd4-54fc-7663-b88f-9da49b1cc9d4",
    },
  );
});

test("createSessionBody refuses a provider command that carries no session id", () => {
  for (const providerResumeId of ["codex", "claude --resume", "codex resume --cd /x"]) {
    assert.equal(
      createSessionBody({
        mode: "resume",
        agent: "codex",
        title: "",
        workdirSelection: { displayValue: "", selectedPath: "" },
        prompt: "",
        providerResumeId,
        account: "",
      }),
      null,
      `expected null for ${JSON.stringify(providerResumeId)}`,
    );
  }
});

test("createSessionBody refuses blank resume ids", () => {
  assert.equal(
    createSessionBody({
      mode: "resume",
      agent: "codex",
      title: "",
      workdirSelection: { displayValue: "", selectedPath: "" },
      prompt: "",
      providerResumeId: "   ",
      account: "",
    }),
    null,
  );
});

test("createSessionBody refuses unsupported resume-id agents", () => {
  assert.equal(
    createSessionBody({
      mode: "resume",
      agent: "dsh",
      agentProfile: "dsh-workbench",
      title: "Imported DSH",
      workdirSelection: selectedRepo,
      prompt: "",
      providerResumeId: "external-dsh-id",
      account: "",
    }),
    null,
  );
});

test("a native session launch carries the workdir as context and scopes no access", () => {
  const anchored = createSessionBody({
    mode: "new",
    agent: "claude",
    title: "multi-repository work",
    workdirSelection: {
      displayValue: "repo-a",
      selectedPath: "/home/runner/Project/summit/repo-a",
    },
    prompt: "",
    providerResumeId: "",
    account: "",
  });
  // Exact: the launch contract carries one contextual path and no field that
  // could scope, root, or confine the session. A future scoping field derived
  // from the selection would fail here, which is why this stays exhaustive.
  assert.deepEqual(anchored, {
    agent: "claude",
    title: "multi-repository work",
    cwd: "/home/runner/Project/summit/repo-a",
  });
  // Starting with no selection is a supported native session, so a dirty or
  // unselected default checkout is never a prerequisite for launching.
  assert.deepEqual(
    createSessionBody({
      mode: "new",
      agent: "claude",
      title: "",
      workdirSelection: { displayValue: "", selectedPath: "" },
      prompt: "",
      providerResumeId: "",
      account: "",
    }),
    { agent: "claude" },
  );
});

test("createSessionBody carries the chosen account for its provider, except where a launch profile owns it", () => {
  const base = {
    mode: "new" as const,
    title: "",
    workdirSelection: { displayValue: "", selectedPath: "" },
    prompt: "",
    providerResumeId: "",
    account: "alpha",
  };
  assert.deepEqual(createSessionBody({ ...base, agent: "claude" }), { agent: "claude", claude_account: "alpha" });
  assert.deepEqual(createSessionBody({ ...base, agent: "codex" }), { agent: "codex", codex_account: "alpha" });
  // A Claude launch profile owns its configuration root; a Codex profile does not.
  assert.deepEqual(
    createSessionBody({ ...base, agent: "claude", agentProfile: "custom-claude" }),
    { agent: "claude", agent_profile: "custom-claude" },
  );
  assert.deepEqual(
    createSessionBody({ ...base, agent: "codex", agentProfile: "custom-codex" }),
    { agent: "codex", agent_profile: "custom-codex", codex_account: "alpha" },
  );
  assert.deepEqual(createSessionBody({ ...base, agent: "dsh" }), { agent: "dsh" });
  assert.deepEqual(createSessionBody({ ...base, agent: "claude", account: "" }), { agent: "claude" });
});
