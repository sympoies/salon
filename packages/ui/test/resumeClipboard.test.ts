import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createSessionBody } from "../src/createSessionBody.ts";
import { copySessionCommandToClipboard } from "../src/resumeClipboard.ts";

test("copySessionCommandToClipboard writes daemon resume args as a shell-safe command", async () => {
  let copied = "";
  const result = await copySessionCommandToClipboard(
    {
      id: "hs-1",
      provider_resume: {
        provider: "codex",
        session_id: "019f31ee-85dc-7ac0-93e9-b4c2d81ed91e",
        resume_args: [
          "resume",
          "019f31ee-85dc-7ac0-93e9-b4c2d81ed91e",
          "--cd",
          "/home/runner/Project/agent console",
          "--no-alt-screen",
        ],
      },
    },
    {
      writeText: (text) => {
        copied = text;
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    command:
      "codex resume 019f31ee-85dc-7ac0-93e9-b4c2d81ed91e --cd '/home/runner/Project/agent console' --no-alt-screen",
  });
  assert.equal(copied, result.command);
});

test("copySessionCommandToClipboard labels profiled fallback values as provider session ids", async () => {
  let copied = "";
  const result = await copySessionCommandToClipboard(
    {
      id: "profiled",
      agent: "claude",
      agent_profile: "custom-claude",
      provider_resume: { provider: "claude", session_id: "profile-provider-id" },
    },
    { writeText: (text) => { copied = text; } },
  );

  assert.deepEqual(result, {
    ok: true,
    command: "profile-provider-id",
    kind: "provider-session-id",
  });
  assert.equal(copied, "profile-provider-id");
});

test("profiled provider ID copy round-trips through Resume by ID", async () => {
  const copied = await copySessionCommandToClipboard(
    {
      id: "profiled",
      agent: "claude",
      agent_profile: "custom-claude",
      provider_resume: { provider: "claude", session_id: "profile-provider-id" },
    },
    { writeText: () => {} },
  );
  assert.equal(copied.ok, true);
  assert.deepEqual(createSessionBody({
    mode: "resume",
    agent: "claude",
    agentProfile: "custom-claude",
    title: "",
    workdirSelection: { displayValue: "", selectedPath: "" },
    prompt: "",
    providerResumeId: copied.command ?? "",
    account: "",
  }), {
    agent: "claude",
    agent_profile: "custom-claude",
    provider_resume_id: "profile-provider-id",
  });
});

test("copySessionCommandToClipboard requires Codex metadata and has no DSH fallback", async () => {
  let copied = "";
  const codex = await copySessionCommandToClipboard(
    {
      id: "hs-codex",
      agent: "codex",
      status: "running",
      ssh_attach_command: "ssh -t summit 'tmux attach -t hs-codex-1'",
      attach_command: "tmux attach -t hs-codex-1",
    },
    {
      writeText: (text) => {
        copied = text;
      },
    },
  );

  assert.deepEqual(codex, { ok: false, reason: "no-command" });
  assert.equal(copied, "");

  const dsh = await copySessionCommandToClipboard(
    {
      id: "hs-1",
      agent: "dsh",
      agent_profile: "dsh-workbench",
      status: "running",
      ssh_attach_command: "ssh -t summit 'tmux attach -t hs-dsh-1'",
      attach_command: "tmux attach -t hs-dsh-1",
    },
    {
      writeText: (text) => {
        copied = text;
      },
    },
  );

  assert.deepEqual(dsh, { ok: false, reason: "no-command" });
  assert.equal(copied, "");
});

test("copySessionCommandToClipboard reports no-command when metadata is absent", async () => {
  const result = await copySessionCommandToClipboard({ id: "hs-1" }, { writeText: () => assert.fail("no write") });
  assert.deepEqual(result, { ok: false, reason: "no-command" });
});

test("copySessionCommandToClipboard rejects option-shaped fallback provider ids", async () => {
  const result = await copySessionCommandToClipboard(
    {
      id: "hs-1",
      provider_resume: { provider: "codex", session_id: "--help" },
    },
    { writeText: () => assert.fail("no write") },
  );

  assert.deepEqual(result, { ok: false, reason: "no-command" });
});

test("copySessionCommandToClipboard reports unavailable clipboard without writing", async () => {
  const result = await copySessionCommandToClipboard({
    id: "hs-1",
    provider_resume: {
      provider: "claude",
      session_id: "2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209",
      resume_args: ["--resume", "2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209"],
    },
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "clipboard-unavailable",
    command: "claude --resume 2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209",
  });
});

test("copySessionCommandToClipboard reports write failure", async () => {
  const result = await copySessionCommandToClipboard(
    {
      id: "hs-1",
      provider_resume: {
        provider: "claude",
        session_id: "2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209",
        resume_args: ["--resume", "2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209"],
      },
    },
    { writeText: () => Promise.reject(new Error("denied")) },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "write-failed",
    command: "claude --resume 2d9cf8d1-fb0d-49b6-9f40-3a5e0eb32209",
  });
});
