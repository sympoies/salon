import { strict as assert } from "node:assert";
import { test } from "node:test";
import { projectPublicAgentSession } from "../src/api.ts";

// What an agent-session 1.31.9+ daemon reports for a session a coordinator
// started through Agent Console (nils-cli session-lineage-work-v1).
const parent = {
  machine: "moss", session_id: "boss-1", session_created_at: "2026-10-02T09:00:00Z", session_incarnation: "boss-inc",
};
const root = { machine: "moss", session_id: "boss-1", session_created_at: "2026-10-02T09:00:00Z" };
const daemonSession = {
  id: "child-1",
  agent: "claude",
  status: "running",
  lineage: {
    schema_version: "agent-session.session-lineage.v1",
    machine: "cedar",
    parent,
    root,
    depth: 1,
    starter: { kind: "session", via: "console" },
    budget: null,
    host_only: "dropped",
  },
  work: {
    program: { provider: "github", repository: "example-org/agent-console", number: 2 },
    issues: [{ provider: "github", repository: "example-org/agent-console", number: 665 }],
    inherited: true,
    revision: 3,
  },
  lineage_adoption: { adopted_by: { ...root, session_id: "boss-2" }, revision: 1, updated_at: "2026-10-02T12:00:00Z" },
  role: "coordinator",
};

for (const role of ["coordinator", "domain-coordinator", "custom.worker", "a".repeat(128)] as const) {
  test(`public session preserves the explicit ${role} resident role`, () => {
    assert.equal(projectPublicAgentSession({ ...daemonSession, role }).role, role);
  });
}

test("the public session keeps lineage, work, adoption, and role in their documented shape", () => {
  const session = projectPublicAgentSession(daemonSession);
  assert.deepEqual(session.lineage, {
    schema_version: "agent-session.session-lineage.v1",
    parent,
    root,
    depth: 1,
    starter: { kind: "session", via: "console" },
  });
  assert.deepEqual(session.work, daemonSession.work);
  assert.deepEqual(session.lineage_adoption, daemonSession.lineage_adoption);
  assert.equal(session.role, "coordinator");
  const rootSession = projectPublicAgentSession({
    ...daemonSession,
    lineage: { ...daemonSession.lineage, parent: null, depth: 0, starter: { kind: "operator", via: "http" } },
    work: null,
    lineage_adoption: { adopted_by: null, revision: 2, updated_at: "2026-10-02T12:30:00Z" },
    role: null,
  });
  assert.equal((rootSession.lineage as { parent: unknown }).parent, null);
  assert.equal(rootSession.work, null);
  assert.equal((rootSession.lineage_adoption as { adopted_by: unknown }).adopted_by, null);
  assert.equal(Object.hasOwn(rootSession, "role"), false, "no role is no field");
});

test("malformed lineage, work, adoption, or role is dropped, not half-projected", () => {
  for (const lineage of [
    "root",
    { ...daemonSession.lineage, depth: -1 },
    { ...daemonSession.lineage, depth: 1.5 },
    { ...daemonSession.lineage, root: null },
    { ...daemonSession.lineage, parent: { machine: "moss" } },
    { ...daemonSession.lineage, starter: { kind: "session" } },
    { ...daemonSession.lineage, schema_version: 7 },
    { ...daemonSession.lineage, parent: null },
    { ...daemonSession.lineage, depth: 0 },
  ]) {
    assert.equal(Object.hasOwn(projectPublicAgentSession({ ...daemonSession, lineage }), "lineage"), false, JSON.stringify(lineage));
  }
  for (const work of [
    "a/b#1",
    { ...daemonSession.work, issues: "a/b#1" },
    { ...daemonSession.work, program: { provider: "github", repository: "a/b", number: "1" } },
  ]) {
    assert.equal(Object.hasOwn(projectPublicAgentSession({ ...daemonSession, work }), "work"), false, JSON.stringify(work));
  }
  assert.equal(
    Object.hasOwn(projectPublicAgentSession({ ...daemonSession, lineage_adoption: { adopted_by: "boss-2" } }), "lineage_adoption"),
    false,
  );
  for (const role of ["", "a".repeat(129), "bad role", "../escape", "a\nb", 7, {}, "worker/role"]) {
    assert.equal(Object.hasOwn(projectPublicAgentSession({ ...daemonSession, role }), "role"), false);
  }
  const legacy = projectPublicAgentSession({ id: "old", agent: "codex", status: "running" });
  for (const key of ["lineage", "work", "lineage_adoption", "role"]) {
    assert.equal(Object.hasOwn(legacy, key), false, `a pre-lineage daemon reports no ${key}`);
  }
});
