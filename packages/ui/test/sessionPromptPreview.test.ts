import { strict as assert } from "node:assert";
import { test } from "node:test";
import { projectPublicAgentSession } from "@agent-console/shared/api";
import { sessionCardPreview, sessionLastPromptPreview } from "../src/sessionPromptPreview.ts";
import { makeSession } from "./support/fixtures.ts";

test("retirement suppresses historical generated launch plumbing and preserves user prompts", () => {
  const preview = (text: string) => sessionLastPromptPreview(makeSession({ last_prompt: { text, truncated: false } }));
  assert.equal(preview("Run exactly `/private/bin/main-agent bootstrap --idempotency-key old` now."), null);
  assert.equal(preview("Please investigate the old main-agent bootstrap command."), "Please investigate the old main-agent bootstrap command.");
  assert.equal(sessionLastPromptPreview(makeSession({ last_prompt_state: "current" })), null);
});

test("normalized notices are marked in both modes without replacing a genuine prompt", () => {
  const header = "<!-- agent-notice:v1 kind=mailbox source=fixture -->";
  const preview = (prompt: string, message?: string, role: "user" | "assistant" = "user") => {
    const session = makeSession(projectPublicAgentSession({
      last_prompt: { text: prompt },
      ...(message ? { last_message: { text: message, role } } : {}),
    }));
    return [sessionCardPreview(session, "last-prompt"), sessionCardPreview(session, "latest-message")];
  };
  const notice = `${header}\n\nSynthetic update\nMore details`;
  assert.deepEqual(preview(notice), ["Notice: Synthetic update", "Notice: Synthetic update"]);
  assert.deepEqual(preview("Genuine prompt", notice), ["Genuine prompt", "Notice: Synthetic update"]);
  assert.deepEqual(preview("Genuine prompt", notice, "assistant"), ["Genuine prompt", "Agent: Notice: Synthetic update"]);
  for (const text of [header + "\nBody", header.replace(":v1", ":v2") + "\n\nBody", "Ordinary message"]) {
    const unchanged = text.replace(/\s+/g, " ").trim();
    assert.deepEqual(preview(text, text), [unchanged, unchanged]);
  }
});
