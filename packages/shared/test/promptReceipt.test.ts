import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizePromptReceipt } from "../src/promptReceipt.ts";

const identity = { request_id: "command-attempt", session_id: "session-one", session_incarnation: "launch-one" };
const dispatched = { ...identity, outcome: "command_dispatched", code: null };

test("a command_dispatched receipt is accepted only with a null code and the exact binding", () => {
  assert.deepEqual(normalizePromptReceipt({ ...dispatched, private_debug: "dropped" }, identity), dispatched);
  for (const change of [{ code: "busy" }, { code: "" }, { code: undefined }, { request_id: "other" },
    { session_id: "other" }, { session_incarnation: "other" }]) {
    assert.equal(normalizePromptReceipt({ ...dispatched, ...change }, identity), null, JSON.stringify(change));
  }
});
