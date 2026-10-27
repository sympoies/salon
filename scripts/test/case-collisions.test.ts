import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertCaseDistinctPaths } from "../check-case-collisions.ts";

test("distinct model, component and directory paths remain portable", () => {
  assert.doesNotThrow(() => assertCaseDistinctPaths([
    "src/HeaderUsage.js", "src/headerUsageModel.js", "test/HeaderUsage.js",
  ], "package output"));
});

test("compiled JavaScript and declarations reject case collisions", () => {
  assert.throws(() => assertCaseDistinctPaths([
    "src/HeaderUsage.js", "src/headerUsage.js",
    "src/HeaderUsage.d.ts", "src/headerUsage.d.ts",
  ], "ui package output"), (error) => {
    assert.match((error as Error).message, /ui package output: case-insensitive path collisions/);
    assert.match((error as Error).message, /src\/HeaderUsage\.js \/ src\/headerUsage\.js/);
    assert.match((error as Error).message, /src\/HeaderUsage\.d\.ts \/ src\/headerUsage\.d\.ts/);
    return true;
  });
});

test("the CLI rejects case-only tracked paths before compilation", () => {
  const root = mkdtempSync(join(tmpdir(), "case-collisions-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    // Populate the index directly so this also works on case-insensitive hosts.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: "", encoding: "utf8" }).trim();
    for (const path of ["src/Pane.ts", "src/pane.ts"]) {
      execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { cwd: root });
    }
    const checker = fileURLToPath(new URL("../check-case-collisions.ts", import.meta.url));
    const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Tracked files: case-insensitive path collisions/);
    assert.match(result.stderr, /src\/Pane\.ts \/ src\/pane\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
