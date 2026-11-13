import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/publish-image.yml", import.meta.url), "utf8");
// Execute the release-note step itself, replacing only its provider transport.
const step = workflow.split("  record-digest:\n")[1].split("        run: |\n")[1]
  .split("\n").map((line) => line.replace(/^          /, "")).join("\n");
const reference = `ghcr.io/example/workspace@sha256:${"a".repeat(64)}`;
const imageSection = (ref: string) => `## Container image\n\nPin this immutable reference in \`SALON_IMAGE\`:\n\n\`\`\`text\n${ref}\n\`\`\`\n`;

function run(notes: string) {
  const root = mkdtempSync(join(tmpdir(), "salon-image-notes-"));
  try {
    writeFileSync(join(root, "body.md"), notes);
    writeFileSync(join(root, "gh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == 'release view v1.2.3 --json body --jq .body' ]]; then
  cat "$RUNNER_TEMP/body.md"
elif [[ "$#" == 5 && "$1 $2 $3 $4" == 'release edit v1.2.3 --notes-file' ]]; then
  cp "$5" "$RUNNER_TEMP/edited.md"
else
  echo 'Unexpected release command' >&2
  exit 2
fi
`);
    chmodSync(join(root, "gh"), 0o755);
    const result = spawnSync("bash", ["-c", step], {
      encoding: "utf8", env: { PATH: `${root}:/usr/bin:/bin`, RUNNER_TEMP: root, TAG: "v1.2.3", REFERENCE: reference },
    });
    let edited: string | undefined;
    try { edited = readFileSync(join(root, "edited.md"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { status: result.status, err: result.stderr, edited };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the first pinned image is appended without losing release notes", () => {
  const result = run("Release highlights\n");
  assert.equal(result.status, 0, result.err);
  assert.equal(result.edited, `Release highlights\n\n${imageSection(reference)}`);
});

test("an identical pinned image rerun leaves release notes untouched", () => {
  const result = run(`Release highlights\n\n${imageSection(reference)}`);
  assert.equal(result.status, 0, result.err);
  assert.equal(result.edited, undefined);
});

test("a different digest is refused without editing release notes", () => {
  const oldReference = reference.replace("a".repeat(64), "b".repeat(64));
  const result = run(`Release highlights\n\n${imageSection(oldReference)}\n## Other notes\n\nKeep these too.\n`);
  assert.equal(result.status, 1);
  assert.equal(result.edited, undefined);
  assert.match(result.err, /Container image.*different.*reference/i);
});
