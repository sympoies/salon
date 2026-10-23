import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const repoRoot = new URL("../../..", import.meta.url);
const productionRoots = ["packages/edge/src", "packages/ui/src"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, repoRoot), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

test("edge and ui production code import shared contracts through the package boundary", () => {
  const offenders = productionRoots
    .flatMap(sourceFiles)
    .filter((path) => readFileSync(new URL(path, repoRoot), "utf8").includes("../../shared/src"))
    .map((path) => relative(".", path));

  assert.deepEqual(offenders, []);
});
