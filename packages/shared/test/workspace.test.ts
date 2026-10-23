import { strict as assert } from "node:assert";
import { test } from "node:test";
import { projectPublicAgentSession } from "../src/api.ts";

test("public sessions preserve workspace and only the public origin parent identity", () => {
  const parent = { session_id: "parent", machine: "host-a" };
  assert.deepEqual(projectPublicAgentSession({ workspace: "team-a", origin: { parent: { ...parent, private: "discard" }, private: "discard" } }),
    { workspace: "team-a", origin: { parent } });
  assert.deepEqual(projectPublicAgentSession({ workspace: null, origin: { parent: null } }), { workspace: null, origin: { parent: null } });
  assert.deepEqual(projectPublicAgentSession({}), {});
});

test("workspace projection follows the producer slug grammar and drops malformed origin data", () => {
  for (const workspace of ["example-workspace", "team.2", "2", "a".repeat(64)]) {
    assert.equal(projectPublicAgentSession({ workspace }).workspace, workspace);
  }
  for (const workspace of ["Team", "a_b", "a--b", "a..b", "a.-b", "-a", "a-", "a/b", "a".repeat(65), "sk-example", 42, {}]) {
    assert.equal(projectPublicAgentSession({ workspace }).workspace, null);
  }
  for (const origin of [null, [], {}, { parent: {} }, { parent: { session_id: "x", machine: 42 } }]) {
    assert.equal(projectPublicAgentSession({ origin }).origin, undefined);
  }
});
