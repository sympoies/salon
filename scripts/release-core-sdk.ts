import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PackageMetadata = { name: string; version: string; asset: string; bytes: number; sha256: string };
type Manifest = { version: string; name: string; sourceCommit: string; dirty: boolean; packages: PackageMetadata[] };
type Repository = { full_name: string; private: boolean; visibility: string };
type ReleaseAsset = { id: number; name: string; state: string; size: number; digest: string };
type Release = { id: number; html_url: string; tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] };
type TagRef = { object?: { type: string; sha: string } };

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "sympoies/salon";
const version = "0.1.27";
const tag = `v${version}`;
const names = ["shared", "edge", "ui"];
const assets = [...names.map(name => `${name}.tgz`), "manifest.json"];
const [source, notesPath, mode, ...extra] = process.argv.slice(2);
const requireValue: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
requireValue(/^[0-9a-f]{40}$/.test(source ?? "") && notesPath && !extra.length && (!mode || mode === "--dry-run"),
  "Usage: release.sh <approved-full-source-sha> <notes-file> [--dry-run]");
requireValue(process.versions.node.split(".")[0] === "24", "SDK release requires Node 24");
const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: root, encoding: "utf8" });
const git = (args: string[]) => run("git", args).trim();
const readJson = (path: string): Manifest => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const api = <T>(path: string): T => JSON.parse(run("gh", ["api", `repos/${repository}${path ? `/${path}` : ""}`, "--method", "GET"]));
const assertPublic = () => {
  const repo = api<Repository>("");
  requireValue(repo.full_name === repository && repo.private === false && repo.visibility === "public", "SDK release requires the public Salon repository");
};
const assertSource = () => {
  requireValue(git(["rev-parse", "HEAD"]) === source, "Checkout must match the exact approved source");
  requireValue(git(["status", "--porcelain", "--untracked-files=normal"]) === "", "SDK release requires a clean checkout");
};

assertSource();
assertPublic();
requireValue(api<{ merge_base_commit?: { sha: string } }>(`compare/${source}...main`).merge_base_commit?.sha === source,
  "Approved source must be merged into main; a later main does not change the release source");
requireValue(run("pnpm", ["--version"]).trim() === "11.9.0", "SDK release requires pnpm 11.9.0");
requireValue(readJson("package.json").version === version, "Root SDK version must match the release version");
for (const name of names) {
  const manifest = readJson(`packages/${name}/package.json`);
  requireValue(manifest.name === `@agent-console/${name}` && manifest.version === version, "SDK package name/version mismatch");
}
const notes = resolve(notesPath);
requireValue(readFileSync(notes, "utf8").includes(source), "Release notes must name the exact approved source");
requireValue(!api<{ ref: string }[]>(`git/matching-refs/tags/${tag}`).some(ref => ref.ref === `refs/tags/${tag}`),
  "SDK release tag already exists; do not replace or reuse published identities");

execFileSync("pnpm", ["run", "pack:core"], { cwd: root, stdio: "inherit" });
assertSource();
const manifest = readJson("dist-packages/manifest.json");
requireValue(manifest.sourceCommit === source && manifest.dirty === false, "Packed manifest must bind clean approved source");
requireValue(Array.isArray(manifest.packages) && manifest.packages.length === names.length, "Expected exactly three SDK packages");
const files = new Map<string, Buffer>();
for (const name of names) {
  const asset = `${name}.tgz`;
  const entries = manifest.packages.filter(pkg => pkg.name === `@agent-console/${name}` && pkg.asset === asset);
  requireValue(entries.length === 1 && entries[0].version === version, "Packed SDK package name/version mismatch");
  const path = resolve(root, "dist-packages", asset);
  const bytes = readFileSync(path);
  requireValue(entries[0].bytes === bytes.length && entries[0].sha256 === hash(bytes), `Packed size/hash mismatch: ${asset}`);
  const paths = run("tar", ["-tzf", path]).trim().split("\n");
  requireValue(paths.every(entry => entry.startsWith("package/") && !entry.split("/").includes("..")), "Unexpected SDK archive path");
  requireValue(run("tar", ["-tvzf", path]).trim().split("\n").every(line => /^[d-]/.test(line)), "SDK archive must not contain links");
  requireValue(paths.some(entry => /\.m?js$/.test(entry)) && paths.some(entry => entry.endsWith(".d.ts")) && paths.includes("package/dist-package/LICENSE"), "SDK payload must contain compiled JS, declarations and its license");
  requireValue(!paths.some(entry => /\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")), "SDK payload must not contain implementation TypeScript");
  const packed = JSON.parse(run("tar", ["-xOzf", path, "package/package.json"]));
  requireValue(packed.name === `@agent-console/${name}` && packed.version === version, "Actual packed SDK version differs from manifest");
  files.set(asset, bytes);
}
files.set("manifest.json", readFileSync(resolve(root, "dist-packages/manifest.json")));
// Repeat the scope check after the potentially long build, immediately before
// handing the verified artifacts to the native publisher.
assertPublic();
const create = ["release", "create", tag, ...assets.map(asset => `dist-packages/${asset}`),
  "--repo", repository, "--target", source, "--title", `Salon core SDK ${version}`,
  "--notes-file", notes, "--prerelease", "--latest", "false", "--format", "json"];
execFileSync("forge-cli", [...create, "--dry-run"], { cwd: root, stdio: "inherit" });
if (mode === "--dry-run") {
  console.log("\nPublic SDK provenance and native release dry-run passed; no publication.");
} else {
  execFileSync("forge-cli", create, { cwd: root, stdio: "inherit" });
  assertPublic();
  const ref = api<TagRef>(`git/ref/tags/${tag}`);
  requireValue(ref.object?.type === "commit" && ref.object.sha === source, "Published tag does not resolve to approved source");
  const release = api<Release>(`releases/tags/${tag}`);
  requireValue(release.tag_name === tag && release.draft === false && release.prerelease === true, "Published release must be the SDK prerelease");
  requireValue(Array.isArray(release.assets) && release.assets.length === assets.length && new Set(release.assets.map(asset => asset.name)).size === assets.length, "Published release must have exactly four distinct assets");
  const verified = [];
  for (const name of assets) {
    const metadata = release.assets.find(asset => asset.name === name);
    const bytes = files.get(name)!;
    requireValue(metadata && Number.isSafeInteger(metadata.id) && metadata.id > 0 && metadata.state === "uploaded" && metadata.size === bytes.length && metadata.digest === `sha256:${hash(bytes)}`, `Provider asset size/digest mismatch: ${name}`);
    const downloaded = execFileSync("gh", ["api", `repos/${repository}/releases/assets/${metadata.id}`, "--method", "GET", "-H", "Accept: application/octet-stream"], { cwd: root, maxBuffer: Math.max(bytes.length + 1, 1024 * 1024) });
    requireValue(downloaded.equals(bytes), `Downloaded asset-ID bytes differ: ${name}`);
    verified.push({ id: metadata.id, name, bytes: metadata.size, digest: metadata.digest });
  }
  console.log("\n" + JSON.stringify({ repository, private: false, tag, sourceCommit: source,
    releaseId: release.id, url: release.html_url, prerelease: true, assets: verified }, null, 2));
}
