import { cpSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertCaseDistinctPaths } from "./check-case-collisions.ts";

const name = process.argv[2];
if (!["shared", "edge", "ui"].includes(name)) throw new Error("Expected shared, edge or ui");
const packageRoot = new URL(`../packages/${name}/`, import.meta.url);
rmSync(new URL("dist-package/", packageRoot), { recursive: true, force: true });
execFileSync("tsc", ["-p", "tsconfig.build.json"], { cwd: fileURLToPath(packageRoot), stdio: "inherit" });
cpSync(new URL("../LICENSE", import.meta.url), new URL("dist-package/LICENSE", packageRoot));
if (name === "ui") {
  execFileSync("tsc", ["-p", "tsconfig.vite.json"], { cwd: fileURLToPath(packageRoot), stdio: "inherit" });
  const root = new URL("../packages/ui/", import.meta.url);
  // Keep relative CSS/font/image URLs identical to the source module layout.
  cpSync(new URL("src/", root), new URL("dist-package/src/", root), {
    recursive: true,
    filter: path => !/\.(?:ts|tsx)$/.test(path),
  });
  cpSync(new URL("public/", root), new URL("dist-package/public/", root), { recursive: true });
}
// Check real emitted JS/declarations and copied assets: .ts/.tsx inputs can
// collide after compilation even when their complete source paths differ.
assertCaseDistinctPaths(readdirSync(new URL("dist-package/", packageRoot), { recursive: true, encoding: "utf8" }), `${name} package output`);
