import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { closeServers, listenOnLoopback, makeEdgeConfig } from "./support.ts";

// The per-principal header Claude choice (#582) is retired: the header follows
// the fleet default Claude account (`/api/claude/default-account`) instead.

test("the retired claude-display route is gone", async () => {
  const edge = createEdgeServer(makeEdgeConfig());
  const { base } = await listenOnLoopback(edge);
  try {
    const read = await fetch(`${base}/api/usage/claude-display`);
    assert.equal(read.status, 404);
  } finally {
    closeServers(edge);
  }
});

test("opening the access store drops the retired Claude display table", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-display-"));
  const path = join(dir, "access.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE principal_claude_display (principal_id TEXT PRIMARY KEY, account TEXT NOT NULL) STRICT;
      INSERT INTO principal_claude_display VALUES ('tess', 'team@example.com');`);
    legacy.close();
    const store = new AccessStore(path);
    store.close();
    const check = new DatabaseSync(path);
    const rows = check.prepare("SELECT name FROM sqlite_master WHERE name = 'principal_claude_display'").all();
    check.close();
    assert.deepEqual(rows, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
