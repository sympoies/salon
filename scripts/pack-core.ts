import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Build first. This command writes local artifacts; it never publishes them.
const root = fileURLToPath(new URL("../", import.meta.url));
const destination = resolve(process.argv[2] ?? "dist-packages");
mkdirSync(destination, { recursive: true });
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sourceCommit = git(["rev-parse", "HEAD"]);
const dirty = git(["status", "--porcelain", "--untracked-files=normal"]) !== "";
const packages = [];
for (const name of ["shared", "edge", "ui"]) {
  const packageRoot = resolve(root, "packages", name);
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { name: string; version: string };
  const asset = `${name}.tgz`;
  execFileSync("pnpm", ["pack", "--out", resolve(destination, asset)], { cwd: packageRoot, stdio: "inherit" });
  const bytes = readFileSync(resolve(destination, asset));
  packages.push({ name: manifest.name, version: manifest.version, asset, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") });
}
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({
  sourceCommit, dirty, packages,
}, null, 2) + "\n");
for (const pkg of packages) console.log(`${pkg.sha256}  ${pkg.asset}`);
if (dirty) console.warn("Local package manifest marks this worktree dirty; these are development artifacts.");
