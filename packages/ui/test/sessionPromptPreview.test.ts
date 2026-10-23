import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sessionLastPromptPreview } from "../src/sessionPromptPreview.ts";
import { makeSession } from "./support/fixtures.ts";

test("retirement suppresses historical generated launch plumbing and preserves user prompts", () => {
  const preview = (text: string) => sessionLastPromptPreview(makeSession({ last_prompt: { text, truncated: false } }));
  assert.equal(preview("Run exactly `/private/bin/main-agent bootstrap --idempotency-key old` now."), null);
  assert.equal(preview("Please investigate the old main-agent bootstrap command."), "Please investigate the old main-agent bootstrap command.");
  assert.equal(sessionLastPromptPreview(makeSession({ last_prompt_state: "current" })), null);
});
