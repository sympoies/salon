#!/usr/bin/env node
// Strict generic checks over core source, tests, assets and emitted packages.
// No private term list or baseline is part of this repository.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skipped = new Set(["node_modules", "dist", "target", ".vite", ".cache"]);
const patterns = [
  ["credential", /gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/u],
  ["credential", /(?<![A-Za-z0-9_-])sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{32,}/u],
  ["credential", /tskey-(?:auth|api|client)-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}/u],
  ["credential", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u],
  ["personal path", /\/home\/(?!runner\/|node\/)[a-z][a-z0-9._-]*\/|\/Users\/(?!runner\/|Shared\/)[A-Za-z][A-Za-z0-9._-]*\//u],
  ["personal path", /(?:~|\$HOME)\/Project\//u],
  ["email", /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|users\.noreply\.github\.com\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/u],
];

function* walk(root, dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && !skipped.has(entry.name)) yield* walk(root, path);
    else if (entry.isFile()) yield path;
    else if (entry.isSymbolicLink()) throw new Error(`${path}: unexpected symlink in core`);
  }
}

let root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length > 2) {
  if (process.argv.length !== 4 || process.argv[2] !== "--root") throw new Error("Usage: privacy-scan.mjs [--root <repo>]");
  root = resolve(process.argv[3]);
}
const files = [...walk(root, "packages")];
if (files.length === 0) throw new Error("No core files to scan");
let findings = 0;
for (const file of files) {
  const bytes = readFileSync(join(root, file));
  const lines = [file, ...(bytes.includes(0) ? [] : bytes.toString("utf8").split("\n"))];
  lines.forEach((text, line) => {
    for (const [kind, pattern] of patterns) {
      if (pattern.test(text)) {
        findings += 1;
        // Report the category and position, never the matched credential.
        console.error(`${file}:${line}: ${kind}`);
      }
    }
  });
}
console.log(`privacy scan: ${files.length} file(s), ${findings} finding(s)`);
if (findings > 0) process.exitCode = 1;
