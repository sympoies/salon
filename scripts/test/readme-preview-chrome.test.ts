import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as chrome from "../readme-previews/chrome.ts";

// The preview capture owns a headless Chrome and its profile directory. These
// tests use a stand-in executable and short-lived children, so no browser runs.
let directory = "";
let fake = "";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check: () => boolean, ms = 3000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return check();
};

before(() => {
  directory = mkdtempSync(join(tmpdir(), "readme-chrome-test-"));
  fake = join(directory, "fake-chrome.mjs");
  // FAKE_MODE=hang stays alive without ever exposing a DevTools port; exit leaves at once.
  writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const profile = process.argv.find(argument => argument.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length) ?? "";
writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ pid: process.pid, profile }));
if (process.env.FAKE_MODE === "exit") process.exit(3);
setTimeout(() => {}, 60_000);
`);
  chmodSync(fake, 0o755);
});
after(() => { rmSync(directory, { recursive: true, force: true }); });

async function launchFailure(mode: "hang" | "exit", portWaitMs: number) {
  const record = join(directory, `${mode}.json`);
  rmSync(record, { force: true });
  Object.assign(process.env, { CHROME_BIN: fake, FAKE_MODE: mode, FAKE_RECORD: record });
  const started = Date.now();
  const error = await chrome.launchPage({ portWaitMs }).then(() => undefined, (cause: unknown) => cause as Error);
  const { pid, profile } = JSON.parse(readFileSync(record, "utf8")) as { pid: number; profile: string };
  return { error, pid, profile, elapsed: Date.now() - started };
}

test("a launch that cannot reach the DevTools port reaps Chrome and removes its profile", async () => {
  const { error, pid, profile } = await launchFailure("hang", 400);
  assert.match(error?.message ?? "", /DevTools port/);
  assert.equal(await until(() => !alive(pid)), true, "the Chrome child is gone");
  assert.equal(existsSync(profile), false, "the generated profile directory is removed");
});

test("a Chrome that exits before exposing DevTools fails at once and leaves no profile", async () => {
  const { error, profile, elapsed } = await launchFailure("exit", 5000);
  assert.match(error?.message ?? "", /exited/);
  assert.ok(elapsed < 2500, `failed fast, not after the port wait (${elapsed} ms)`);
  assert.equal(existsSync(profile), false);
});

test("stopping a browser that has already exited finishes, and stopping twice is harmless", async () => {
  const profile = mkdtempSync(join(directory, "profile-"));
  mkdirSync(join(profile, "Default"));
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise(resolve => child.once("exit", resolve));
  const finished = (promise: Promise<void>) => Promise.race([promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000))]);
  assert.equal(await finished(chrome.stopBrowser(child, profile)), true, "does not wait for an exit event that already happened");
  assert.equal(existsSync(profile), false);
  assert.equal(await finished(chrome.stopBrowser(child, profile)), true);
});

test("stopping a live browser kills and reaps it before removing the profile", async () => {
  const profile = mkdtempSync(join(directory, "profile-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await chrome.stopBrowser(child, profile);
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(alive(child.pid!), false);
  assert.equal(existsSync(profile), false);
});
