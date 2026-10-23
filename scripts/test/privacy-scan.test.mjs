import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("../privacy-scan.mjs", import.meta.url));

function scan(files) {
  const root = mkdtempSync("/tmp/core-privacy-");
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    const result = spawnSync(process.execPath, [scanner, "--root", root], { encoding: "utf8" });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("generic fixtures pass and installed dependencies are excluded", () => {
  const result = scan({
    "packages/ui/src/example.ts": 'export const endpoint = "https://example.com";\n',
    "packages/ui/node_modules/vendor/index.js": "ghp_" + "A".repeat(32),
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1 file\(s\), 0 finding\(s\)/);
});

test("source and compiled output reject credential shapes without echoing the value", () => {
  for (const path of ["packages/edge/src/config.ts", "packages/edge/dist-package/src/config.js"]) {
    const value = "ghp_" + "A".repeat(32);
    const result = scan({ [path]: `export const token = "${value}";\n` });
    assert.equal(result.status, 1, result.output);
    assert.ok(result.output.includes(path));
    assert.match(result.output, /credential/);
    assert.ok(!result.output.includes(value), "diagnostics must not disclose matched data");
  }
});

test("personal paths and non-example email addresses fail in content and filenames", () => {
  for (const value of ["/home/" + "person/project/", "/Users/" + "Person/project/", "person@" + "private.invalid"]) {
    const result = scan({ "packages/shared/src/config.ts": JSON.stringify(value) });
    assert.equal(result.status, 1, result.output);
  }
  const result = scan({ ["packages/ui/public/person@" + "private.invalid.txt"]: Buffer.from([0, 1]) });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /:0: email/);
});

test("missing packages fail instead of establishing an empty privacy pass", () => {
  assert.equal(scan({}).status, 1);
});
