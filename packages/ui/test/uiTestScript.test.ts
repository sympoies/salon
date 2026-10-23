import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("the UI test command overlaps files but bounds the worker count to three", () => {
  const fixture = mkdtempSync(join(tmpdir(), "ui-test-concurrency-"));
  try {
    mkdirSync(join(fixture, "test"));
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(fixture, "node_modules"), "dir");
    copyFileSync(new URL("./domAssertSafety.test.ts", import.meta.url), join(fixture, "test/domAssertSafety.test.ts"));
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(fixture, `test/worker${i}.test.ts`), [
        'import { test } from "node:test";',
        'import { appendFileSync } from "node:fs";',
        `test("worker ${i}", async () => {`,
        `  appendFileSync("events", "start ${i}\\n");`,
        '  await new Promise(resolve => setTimeout(resolve, 400));',
        `  appendFileSync("events", "end ${i}\\n");`,
        '});',
      ].join("\n"));
    }
    const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(scripts.test, {
      cwd: fixture, env, shell: true, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    let active = 0;
    let peak = 0;
    const events = readFileSync(join(fixture, "events"), "utf8").trim().split("\n");
    assert.equal(events.length, 12, "all six files execute exactly once");
    for (const event of events) {
      active += event.startsWith("start ") ? 1 : -1;
      peak = Math.max(peak, active);
    }
    assert.equal(active, 0);
    assert.ok(peak > 1, `expected overlapping workers, got ${peak}`);
    assert.ok(peak <= 3, `expected at most three workers, got ${peak}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

for (const failure of [
  { name: "exit code", action: "process.exit(7)", diagnostic: /exitCode: 7/ },
  { name: "signal", action: 'process.kill(process.pid, "SIGTERM")', diagnostic: /signal: '?SIGTERM'?/ },
]) {
  test(`the UI test command retains a file failure's ${failure.name} after passing assertions`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "ui-file-diagnostics-"));
    try {
      mkdirSync(join(fixture, "test"));
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
      symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(fixture, "node_modules"), "dir");
      copyFileSync(new URL("./domAssertSafety.test.ts", import.meta.url), join(fixture, "test/domAssertSafety.test.ts"));
      writeFileSync(join(fixture, "test/fileFailure.test.ts"), [
        'import { after, test } from "node:test";',
        'test("passing assertion before file failure", () => {});',
        // Give the runner time to report the passing assertion before abrupt exit.
        `after(async () => { await new Promise(resolve => setTimeout(resolve, 50)); ${failure.action}; });`,
      ].join("\n"));
      const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(scripts.test, {
        cwd: fixture,
        env,
        shell: true,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.notEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert.match(output, /passing assertion before file failure/);
      assert.match(output, failure.diagnostic);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test("the UI test command rejects hazardous assertions before executing test files", () => {
  const fixture = mkdtempSync(join(tmpdir(), "ui-dom-preflight-"));
  try {
    mkdirSync(join(fixture, "test"));
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(fixture, "node_modules"), "dir");
    copyFileSync(new URL("./domAssertSafety.test.ts", import.meta.url), join(fixture, "test/domAssertSafety.test.ts"));
    // This has the hazardous syntax, but returns a scalar so the red run cannot
    // inspect a real DOM graph. The marker proves whether it was executed.
    writeFileSync(join(fixture, "test/aUnsafe.test.ts"), [
      'import assert from "node:assert/strict";',
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("unsafe-executed", "yes");',
      'const root = { querySelector: () => 1 };',
      'assert.equal(root.querySelector(".missing"), null);',
    ].join("\n"));
    const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(scripts.test, {
      cwd: fixture,
      env,
      shell: true,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /hazardous assertion/);
    assert.equal(existsSync(join(fixture, "unsafe-executed")), false,
      "the guard must stop the command before the hazardous file executes");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
