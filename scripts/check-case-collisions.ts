import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertCaseDistinctPaths(paths: Iterable<string>, context: string) {
  const seen = new Map<string, string>();
  const collisions = [];
  for (const path of paths) {
    const key = path.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined && previous !== path) {
      collisions.push(`${previous} / ${path}`);
    }
    seen.set(key, path);
  }
  if (collisions.length) {
    throw new Error(`${context}: case-insensitive path collisions:\n${collisions.join("\n")}`);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  assertCaseDistinctPaths(paths, "Tracked files");
  console.log("tracked path casing: ok");
}
