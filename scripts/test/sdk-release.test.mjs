import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = "a".repeat(40);
const assets = ["shared.tgz", "edge.tgz", "ui.tgz", "manifest.json"];
const repo = fileURLToPath(new URL("../../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Only subprocess transports are replaced. The entrypoint reads real manifests,
// lists real tarballs and verifies the actual bytes returned by immutable IDs.
const transport = `#!/usr/bin/env node
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
const root = process.env.SDK_RELEASE_FIXTURE;
const statePath = join(root, "state.json");
const state = JSON.parse(readFileSync(statePath));
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
appendFileSync(join(root, "calls.jsonl"), JSON.stringify({ command, args }) + "\\n");
const save = () => writeFileSync(statePath, JSON.stringify(state));
const json = data => process.stdout.write(JSON.stringify(data));
if (command === "git") {
  if (args[0] === "rev-parse") console.log(state.source);
  else if (args[0] === "status") console.log(state.scenario === "dirty" ? " M package.json" : "");
  else throw new Error("unexpected git invocation");
} else if (command === "pnpm") {
  if (args[0] === "--version") console.log("11.9.0");
  else {
    if (args.join(" ") !== "run pack:core") throw new Error("unexpected pack command");
    mkdirSync(join(root, "dist-packages"), { recursive: true });
    for (const name of state.assets) cpSync(join(root, "packs", name), join(root, "dist-packages", name));
    state.packed = true; save();
  }
} else if (command === "forge-cli") {
  if (args.slice(0, 3).join(" ") !== "release create v0.1.7") throw new Error("unexpected publisher");
  if (!args.includes("--dry-run")) { state.published = true; save(); }
  json({ ok: true });
} else if (command === "gh") {
  if (args[0] !== "api") throw new Error("only API reads expected");
  const path = args[1];
  if (path === "repos/sympoies/salon") {
    const privateScope = !(state.scenario === "public" || (state.scenario === "public-after-pack" && state.packed));
    json({ full_name: "sympoies/salon", private: privateScope, visibility: privateScope ? "private" : "public" });
  } else if (path.includes("/compare/")) {
    json({ merge_base_commit: { sha: state.scenario === "unapproved" ? "b".repeat(40) : state.source } });
  } else if (path.includes("/git/matching-refs/")) json([]);
  else if (path.includes("/git/ref/tags/")) json({ object: { type: "commit", sha: state.source } });
  else if (path.includes("/releases/tags/")) {
    const metadata = state.assets.map((name, index) => {
      const bytes = readFileSync(join(root, "packs", name));
      return { id: 100 + index, name, size: bytes.length, state: "uploaded", digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
    });
    json({ id: 20, tag_name: "v0.1.7", draft: false, prerelease: true, html_url: "https://example.com/release", assets: metadata });
  } else if (path.includes("/releases/assets/")) {
    const index = Number(path.split("/").at(-1)) - 100;
    const bytes = readFileSync(join(root, "packs", state.assets[index]));
    if (state.scenario === "download-corruption" && index === 2) bytes[0] ^= 1;
    process.stdout.write(bytes);
  } else throw new Error("unexpected API read: " + path);
} else throw new Error("unexpected transport");
`;

function fixture(scenario = "valid") {
  const root = mkdtempSync("/tmp/sdk-release-");
  for (const directory of ["bin", "packs", ".agents/scripts", "scripts"]) mkdirSync(join(root, directory), { recursive: true });
  for (const path of [".agents/scripts/release.sh", "scripts/release-core-sdk.mjs"]) cpSync(join(repo, path), join(root, path));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "salon", version: "0.1.7" }));
  const packages = [];
  for (const name of ["shared", "edge", "ui"]) {
      const metadata = { name: `@agent-console/${name}`, version: "0.1.7" };
    const packageRoot = join(root, "packages", name);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify(metadata));
    const staging = join(root, "staging", name, "package");
    mkdirSync(join(staging, "dist-package"), { recursive: true });
    writeFileSync(join(staging, "package.json"), JSON.stringify(metadata));
    writeFileSync(join(staging, "dist-package/index.js"), "export const value = 1;\n");
    writeFileSync(join(staging, "dist-package/index.d.ts"), "export declare const value: number;\n");
    writeFileSync(join(staging, "dist-package/LICENSE"), "MIT\n");
    if (scenario === "implementation-source" && name === "ui") writeFileSync(join(staging, "dist-package/source.ts"), "export const value: number = 1;\n");
    const asset = `${name}.tgz`;
    const path = join(root, "packs", asset);
    execFileSync("tar", ["-czf", path, "-C", dirname(staging), "package"]);
    const bytes = readFileSync(path);
    packages.push({ ...metadata, asset, bytes: bytes.length, sha256: scenario === "hash-mismatch" && name === "ui" ? "0".repeat(64) : hash(bytes) });
  }
  writeFileSync(join(root, "packs/manifest.json"), JSON.stringify({ sourceCommit: source, dirty: false, packages }));
  writeFileSync(join(root, "notes.md"), `Core SDK at ${source}.\n`);
  writeFileSync(join(root, "state.json"), JSON.stringify({ source, scenario, assets }));
  for (const command of ["git", "pnpm", "gh", "forge-cli"]) writeFileSync(join(root, "bin", command), transport, { mode: 0o755 });
  const run = (...extra) => spawnSync("bash", [join(root, ".agents/scripts/release.sh"), source, join(root, "notes.md"), ...extra], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, SDK_RELEASE_FIXTURE: root },
  });
  const calls = () => readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { root, run, calls, close: () => rmSync(root, { recursive: true, force: true }) };
}

function rejectedBeforePublishing(scenario, pattern) {
  const setup = fixture(scenario);
  try {
    const result = setup.run();
    assert.equal(setup.calls().filter(call => call.command === "forge-cli").length, 0, "invalid input reached the release publisher");
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, pattern);
  } finally { setup.close(); }
}

test("SDK publication refuses dirty or unapproved source before publishing", () => {
  rejectedBeforePublishing("dirty", /clean/);
  rejectedBeforePublishing("unapproved", /approved|main/);
});

test("SDK publication refuses public scope including a change during packing", () => {
  rejectedBeforePublishing("public", /private/);
  rejectedBeforePublishing("public-after-pack", /private/);
});

test("SDK publication checks actual packed hashes and implementation TypeScript before publishing", () => {
  rejectedBeforePublishing("hash-mismatch", /digest|hash/);
  rejectedBeforePublishing("implementation-source", /TypeScript|compiled/);
});

test("SDK dry-run validates the fixed private release without a live create", () => {
  const setup = fixture();
  try {
    const result = setup.run("--dry-run");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const creates = setup.calls().filter(call => call.command === "forge-cli");
    assert.equal(creates.length, 1);
    assert.ok(creates[0].args.includes("--dry-run"));
    assert.equal(JSON.parse(readFileSync(join(setup.root, "state.json"))).published, undefined);
  } finally { setup.close(); }
});

test("SDK release publishes exactly four assets then verifies tag and actual asset-ID bytes", () => {
  const setup = fixture();
  try {
    const result = setup.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = setup.calls();
    const creates = calls.filter(call => call.command === "forge-cli");
    assert.equal(creates.length, 2);
    const live = creates.find(call => !call.args.includes("--dry-run")).args;
    assert.deepEqual(live.slice(3, 7), assets.map(name => `dist-packages/${name}`));
    assert.equal(live[live.indexOf("--target") + 1], source);
    assert.ok(live.includes("--prerelease"));
    assert.equal(live[live.indexOf("--latest") + 1], "false");
    assert.equal(calls.filter(call => call.command === "gh" && call.args[1].includes("/releases/assets/")).length, 4);
    assert.match(result.stdout, /"sourceCommit"/);
  } finally { setup.close(); }
});

test("SDK release never reports success when asset-ID bytes disagree with provider digests", () => {
  const setup = fixture("download-corruption");
  try {
    const result = setup.run();
    assert.notEqual(result.status, 0, "corrupt immutable asset bytes were accepted");
    assert.match(result.stderr, /download|bytes|digest/);
  } finally { setup.close(); }
});
