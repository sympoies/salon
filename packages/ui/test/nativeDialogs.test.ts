import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("UI source uses themed dialogs in place of native browser dialogs", () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  const nativeDialog = /\bwindow\s*(?:\??\.\s*(?:confirm|alert|prompt)\b|(?:\?\.)?\[\s*["'](?:confirm|alert|prompt)["']\s*\])/;
  const violations = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
    .filter(path => nativeDialog.test(readFileSync(path, "utf8")))
    .map(path => relative(src, path))
    .sort();
  assert.deepEqual(violations, []);
});
