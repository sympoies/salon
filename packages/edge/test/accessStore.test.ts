import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { AccessStore, OUTSIDE_COORDINATOR_TREE } from "../src/accessStore.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "agent-console-access-store-"));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

test("AccessStore persists exact session ownership without token coupling", () => {
  const path = join(tempRoot, "persist.sqlite");
  const first = new AccessStore(path);
  first.claimSession({
    principalId: "tess",
    machine: "summit",
    sessionId: "session-1",
    incarnation: "incarnation-1",
  });
  assert.equal(first.ownsSession("tess", "summit", "session-1", "incarnation-1"), true);
  assert.equal(first.sessionIncarnation("tess", "summit", "session-1"), "incarnation-1");
  assert.equal(first.sessionIncarnation("dana", "summit", "session-1"), undefined);
  assert.equal(first.ownsSession("dana", "summit", "session-1", "incarnation-1"), false);
  assert.equal(first.ownsSession("tess", "summit", "session-1", "replacement"), false);
  first.close();

  const reopened = new AccessStore(path);
  assert.equal(reopened.ownsSession("tess", "summit", "session-1", "incarnation-1"), true);
  assert.throws(() => reopened.claimSession({
    principalId: "dana",
    machine: "summit",
    sessionId: "session-1",
    incarnation: "incarnation-2",
  }));
  reopened.close();
});

test("legacy ownership rows migrate without silently acquiring a provider binding", () => {
  const path = join(tempRoot, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE session_ownership (
      machine TEXT NOT NULL, session_id TEXT NOT NULL, incarnation TEXT NOT NULL,
      principal_id TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (machine, session_id)
    ) STRICT;
    INSERT INTO session_ownership (machine, session_id, incarnation, principal_id)
    VALUES ('summit', 'legacy-session', 'old-inc', 'tess');
  `);
  legacy.close();
  const store = new AccessStore(path);
  assert.equal(store.sessionGrant("summit", "legacy-session")?.launcher, null);
  store.claimProvider("tess", "summit", "codex", "provider-1");
  assert.equal(store.repairSessionIncarnation(
    "tess", "summit", "legacy-session", "old-inc", "new-inc", "codex", "provider-1",
  ), false);
  assert.equal(store.bindSessionProvider(
    "tess", "summit", "legacy-session", "old-inc", "codex", "provider-1",
    "2026-09-21T00:00:00Z",
  ), true);
  assert.equal(store.repairSessionIncarnation(
    "tess", "summit", "legacy-session", "old-inc", "new-inc", "codex", "provider-1",
    false, false, "2026-09-22T00:00:00Z",
  ), true);
  store.close();
  const reopened = new AccessStore(path);
  assert.equal(reopened.ownsSession("tess", "summit", "legacy-session", "new-inc"), true);
  reopened.close();
});

test("AccessStore maps provider and history identities to one principal", () => {
  const store = new AccessStore(join(tempRoot, "history.sqlite"));
  store.claimProvider("tess", "summit", "codex", "provider-1");
  assert.equal(store.ownsProvider("tess", "summit", "codex", "provider-1"), true);
  assert.equal(store.ownsProvider("dana", "summit", "codex", "provider-1"), false);
  assert.throws(() => store.claimProvider("dana", "summit", "codex", "provider-1"));

  store.claimHistory("tess", "summit", "history-1", "codex", "provider-1");
  assert.equal(store.ownsHistory("tess", "summit", "history-1"), true);
  assert.equal(store.ownsHistory("dana", "summit", "history-1"), false);
  store.close();
});

test("AccessStore advances only the exact owned session incarnation", () => {
  const store = new AccessStore(join(tempRoot, "advance.sqlite"));
  store.claimSession({
    principalId: "tess", machine: "summit", sessionId: "session-1", incarnation: "before",
  });
  assert.equal(store.advanceSessionIncarnation("dana", "summit", "session-1", "before", "after"), false);
  assert.equal(store.advanceSessionIncarnation("tess", "summit", "session-1", "wrong", "after"), false);
  assert.equal(store.advanceSessionIncarnation("tess", "summit", "session-1", "before", "after"), true);
  assert.equal(store.ownsSession("tess", "summit", "session-1", "before"), false);
  assert.equal(store.ownsSession("tess", "summit", "session-1", "after"), true);
  store.close();
});

test("AccessStore rolls back an ownership import when any identity conflicts", () => {
  const store = new AccessStore(join(tempRoot, "atomic-import.sqlite"));
  store.claimProvider("dana", "summit", "codex", "provider-1");
  assert.throws(() => store.claimImport({
    principalId: "tess",
    sessions: [{
      principalId: "tess",
      machine: "summit",
      sessionId: "session-1",
      incarnation: "incarnation-1",
    }],
    providers: [{ machine: "summit", provider: "codex", providerSessionId: "provider-1" }],
    histories: [],
  }));
  assert.equal(store.ownsSession("tess", "summit", "session-1", "incarnation-1"), false);
  store.close();
});

test("AccessStore keeps revisioned layouts isolated by principal", () => {
  const store = new AccessStore(join(tempRoot, "layout.sqlite"));
  assert.deepEqual(store.readLayout("tess"), { order: [], revision: 0 });
  assert.deepEqual(store.writeLayout("tess", ["summit:s1"], 0), {
    ok: true,
    order: ["summit:s1"],
    revision: 1,
  });
  assert.deepEqual(store.readLayout("dana"), { order: [], revision: 0 });
  assert.deepEqual(store.writeLayout("tess", ["summit:s2"], 0), {
    ok: false,
    order: ["summit:s1"],
    revision: 1,
  });
  store.close();
});

test("AccessStore keeps a recorded dispatcher through later claims of the same session", () => {
  const store = new AccessStore(join(tempRoot, "dispatcher.sqlite"));
  const dispatcher = { machine: "summit", sessionId: "legacy-root-session", repoName: "legacy-root" };
  store.claimSession({ principalId: "tess", machine: "cedar", sessionId: "child", incarnation: "inc-1", dispatcher });
  assert.deepEqual(store.sessionGrant("cedar", "child")?.dispatcher, dispatcher);
  store.claimSession({ principalId: "tess", machine: "cedar", sessionId: "child", incarnation: "inc-2" });
  assert.deepEqual(store.sessionGrant("cedar", "child")?.dispatcher, dispatcher);
  store.claimSession({ principalId: "tess", machine: "cedar", sessionId: "plain", incarnation: "inc-1" });
  assert.equal(store.sessionGrant("cedar", "plain")?.dispatcher, null);
  store.claimSession({
    principalId: "tess", machine: "cedar", sessionId: "no-repo", incarnation: "inc-1",
    dispatcher: { machine: "summit", sessionId: "other" },
  });
  assert.deepEqual(store.sessionGrant("cedar", "no-repo")?.dispatcher, { machine: "summit", sessionId: "other" });
  store.close();
});

test("a history entry keeps the coordinator tree mark of the grant that recorded how its session started", () => {
  const path = join(tempRoot, "provider-session.sqlite");
  const store = new AccessStore(path, { legacyCoordinatorRepositories: ["legacy-root"] });
  try {
    const claim = (sessionId: string, extra = {}) => store.claimImport({
      principalId: "tess",
      sessions: [{ principalId: "tess", machine: "maple", sessionId, incarnation: `${sessionId}-inc`, provider: "claude", providerSessionId: `p-${sessionId.split("-")[0]}`, ...extra }],
      providers: [{ machine: "maple", provider: "claude", providerSessionId: `p-${sessionId.split("-")[0]}` }],
      histories: [],
    });
    claim("boss", { consoleRole: "coordinator", treeDepth: 0 });
    claim("kid", { dispatcher: { machine: "maple", sessionId: "boss", repoName: "legacy-root" }, treeDepth: 1 });
    // A later resume from History is a session the user starts: its grant is
    // recorded outside every tree and must not hide how the session started.
    claim("boss-resumed", { treeDepth: OUTSIDE_COORDINATOR_TREE });
    claim("kid-resumed", { treeDepth: OUTSIDE_COORDINATOR_TREE });
    // CURRENT_TIMESTAMP has one-second resolution: make the resumes strictly newer.
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE session_ownership SET updated_at = '2999-01-01 00:00:00' WHERE session_id LIKE '%-resumed'").run();
    raw.close();
    const depthOf = (providerSessionId: string) => {
      const sessionId = store.providerSession("tess", "maple", "claude", providerSessionId);
      return sessionId === null ? null : store.coordinatorTreeDepth("maple", sessionId);
    };
    assert.equal(depthOf("p-boss"), 0, "a closed coordinator keeps its star in History");
    assert.equal(depthOf("p-kid"), 1);
    assert.equal(store.providerSession("dana", "maple", "claude", "p-kid"), null, "another principal finds nothing");
    // A worker whose legacy-root dispatcher has no grant here (started before the
    // console owned it) is still one level below a coordinator.
    claim("orphan", { dispatcher: { machine: "maple", sessionId: "unclaimed-legacy-root", repoName: "legacy-root" } });
    assert.equal(store.coordinatorTreeDepth("maple", "orphan"), 1);
    const core = new AccessStore(path);
    assert.equal(core.coordinatorTreeDepth("maple", "orphan"), null);
    core.close();
    claim("stray", { dispatcher: { machine: "maple", sessionId: "unclaimed-other", repoName: "nils-cli" } });
    assert.equal(store.coordinatorTreeDepth("maple", "stray"), null);
  } finally {
    store.close();
  }
});

test("AccessStore atomically preserves the original launcher across claims and reopen", () => {
  const path = join(tempRoot, "launcher.sqlite");
  const store = new AccessStore(path);
  const launcher = { machine: "hub", sessionId: "caller", repoName: "coordinator" };
  store.claimImport({ principalId: "tess", sessions: [{
    principalId: "tess", machine: "spoke", sessionId: "root", incarnation: "inc", launcher,
  }], providers: [], histories: [] });
  assert.deepEqual(store.sessionGrant("spoke", "root")?.launcher, launcher);
  store.claimSession({ principalId: "tess", machine: "spoke", sessionId: "root", incarnation: "inc-2", launcher: { machine: "other", sessionId: "later" } });
  assert.deepEqual(store.sessionGrant("spoke", "root")?.launcher, launcher);
  store.close();
  const reopened = new AccessStore(path);
  assert.deepEqual(reopened.sessionGrant("spoke", "root")?.launcher, launcher);
  reopened.close();
});
