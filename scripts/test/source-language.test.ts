import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findSourceLanguageViolations, SOURCE_LANGUAGE_ALLOWLIST } from "../check-source-language.ts";

const [allowedPath, allowedLines] = Object.entries(SOURCE_LANGUAGE_ALLOWLIST)[0]!;

test("CJK text in package source is reported with its file and line", () => {
  const violations = findSourceLanguageViolations([
    ["packages/ui/src/Pane.tsx", "const a = 1;\nconst label = \"保存\";\n// ひらがな カタカナ 한글\n"],
  ]);
  assert.deepEqual(violations, ["packages/ui/src/Pane.tsx:2", "packages/ui/src/Pane.tsx:3"]);
});

test("fullwidth CJK punctuation and ideographic space count as CJK", () => {
  assert.deepEqual(findSourceLanguageViolations([["packages/edge/src/a.ts", "x = \"a，b\";\ny = \"c　d\";\n"]]), [
    "packages/edge/src/a.ts:1",
    "packages/edge/src/a.ts:2",
  ]);
});

test("ASCII, emoji and escaped code points pass, and tests and non-package files are not scanned", () => {
  assert.deepEqual(findSourceLanguageViolations([
    ["packages/ui/src/ok.ts", "const mic = \"🎙️ \";\nconst re = /[\\u3002\\uFF0C]/u;\n"],
    ["packages/ui/test/fixture.test.ts", "const sample = \"語音\";\n"],
    ["docs/notes.md", "語音\n"],
    ["packages/ui/package.json", "{\"name\": \"語音\"}\n"],
  ]), []);
});

test("only the fixed legacy-parser lines are allowed, and nothing else in their file", () => {
  const allowed = allowedLines.join("\n");
  assert.deepEqual(findSourceLanguageViolations([[allowedPath, `${allowed}\n`]]), []);
  assert.deepEqual(findSourceLanguageViolations([[allowedPath, `${allowed}\nconst other = "語音";\n`]]), [`${allowedPath}:${allowedLines.length + 1}`]);
  assert.deepEqual(findSourceLanguageViolations([["packages/ui/src/other.ts", `${allowed}\n`]]).length, allowedLines.length);
});

test("the CLI fails on tracked CJK source and passes a clean tree", () => {
  const root = mkdtempSync(join(tmpdir(), "source-language-"));
  const checker = join(dirname(fileURLToPath(import.meta.url)), "..", "check-source-language.ts");
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    mkdirSync(join(root, "packages/ui/src"), { recursive: true });
    writeFileSync(join(root, "packages/ui/src/clean.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    const clean = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    writeFileSync(join(root, "packages/ui/src/bad.ts"), "export const a = \"保存\";\n");
    execFileSync("git", ["add", "-A"], { cwd: root });
    const bad = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /packages\/ui\/src\/bad\.ts:1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
