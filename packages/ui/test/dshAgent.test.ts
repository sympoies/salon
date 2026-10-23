import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isDshAgent } from "../src/dshAgent.ts";

test("isDshAgent recognizes only the dsh kind", () => {
  assert.equal(isDshAgent("dsh"), true);
  // The retired hermes base kind is no longer treated as DSH.
  assert.equal(isDshAgent("hermes"), false);
  assert.equal(isDshAgent("codex"), false);
  assert.equal(isDshAgent("claude"), false);
  assert.equal(isDshAgent(""), false);
  assert.equal(isDshAgent(undefined), false);
  assert.equal(isDshAgent(null), false);
});
