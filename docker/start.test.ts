import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ChildProcess } from "node:child_process";

async function fixture(t: TestContext, { earlyExit = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "salon-start-"));
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const bin = join(root, "bin");
  for (const dir of ["bin", "docker", "apps/workspace/src", "home/Project/workspace"]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await copyFile(new URL("./start.ts", import.meta.url), join(root, "docker/start.ts"));
  const daemon = `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
const input = [];
process.stdin.on('data', chunk => input.push(chunk));
process.stdin.on('end', () => {
  const token = Buffer.concat(input).toString().trim();
  writeFileSync(root + '/daemon.json', JSON.stringify({ pid: process.pid, token, args: process.argv.slice(2), env: process.env }));
  ${earlyExit ? "process.exit(7);" : "setTimeout(() => writeFileSync(root + '/ready', ''), 250);"}
});
process.on('SIGTERM', () => { writeFileSync(root + '/stopped', ''); process.exit(0); });
setInterval(() => {}, 1000);
`;
  await writeFile(join(bin, "agent-session"), daemon);
  await chmod(join(bin, "agent-session"), 0o755);
  // Only the readiness network call is replaced. The startup process and child
  // stdin/env, durable files, signal delivery and HTTP server are real.
  await writeFile(join(root, "readiness.mjs"), `
import { existsSync } from 'node:fs';
globalThis.fetch = async () => new Response("", { status: existsSync(${JSON.stringify(join(root, "ready"))}) ? 200 : 503 });
`);
  await writeFile(join(root, "apps/workspace/src/server.ts"), `
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
export function startWorkspaceEdge({ daemonToken, clientToken }) {
 const root = ${JSON.stringify(root)};
 const daemon = existsSync(root + '/daemon.json') ? JSON.parse(readFileSync(root + '/daemon.json', 'utf8')) : {};
 writeFileSync(root + '/edge.json', JSON.stringify({
  ready: existsSync(root + '/ready'), daemonMatches: daemonToken === daemon.token,
  distinct: daemonToken !== clientToken, clientToken,
 }));
 const server = createServer((req, res) => res.end('fixture'));
 server.listen(0, '127.0.0.1');
 return server;
}
`);
  const home = join(root, "home");
  const env = {
    PATH: bin + ":/usr/bin:/bin", HOME: home, CODEX_HOME: join(home, ".codex"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_RUNTIME_DIR: join(root, "run"),
    NODE_OPTIONS: `--import=${join(root, "readiness.mjs")}`,
    AGENT_SESSION_TOKEN: "fixture-inherited-daemon-credential",
    AGENT_CONSOLE_TOKEN: "fixture-inherited-browser-credential",
    AGENT_CONSOLE_MACHINES: "fixture-inherited-upstream-credential",
  };
  function start() {
    const child = spawn(process.execPath, [join(root, "docker/start.ts")], {
      cwd: join(home, "Project/workspace"), env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    children.push(child);
    return { child, output: () => output };
  }
  return { root, home, start };
}

async function waitFile(path: string, running: { child: ChildProcess; output: () => string }) {
  for (let i = 0; i < 150; i++) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (running.child.exitCode !== null) {
      assert.fail(`Startup exited before ready: ${running.output()}`);
    }
    await delay(20);
  }
  assert.fail(`Startup did not become ready: ${running.output()}`);
}

test("waits for daemon readiness, keeps credentials separate and stable, and stops both children", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const first = f.start();
  const edge = await waitFile(join(f.root, "edge.json"), first);
  assert.equal(edge.ready, true, "edge must not start before the daemon is ready");
  assert.equal(edge.daemonMatches, true, "daemon receives its token through stdin");
  assert.equal(edge.distinct, true, "browser credential must not grant daemon access");
  const daemon = JSON.parse(await readFile(join(f.root, "daemon.json"), "utf8"));
  for (const name of ["AGENT_SESSION_TOKEN", "AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_MACHINES", "NODE_OPTIONS"]) {
    assert.equal(daemon.env[name], undefined, `${name} must not enter provider ancestry`);
  }
  assert.equal(daemon.args.includes(daemon.token), false);
  assert.ok(daemon.args.includes("--token-stdin"));
  const credentialPath = join(f.home, ".local/state/salon/browser-token");
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(credentialPath, "utf8")).trim(), edge.clientToken);
  const exited = once(first.child, "exit");
  first.child.kill("SIGTERM");
  await exited;
  assert.equal(await readFile(join(f.root, "stopped"), "utf8"), "");
  assert.equal(first.output().includes(daemon.token), false);
  assert.equal(first.output().includes(edge.clientToken), false);
  for (const name of ["ready", "edge.json", "stopped"]) await unlink(join(f.root, name));
  const second = f.start();
  // The new edge overwrites this file only after its daemon becomes ready.
  const again = await waitFile(join(f.root, "edge.json"), second);
  assert.equal(again.clientToken, edge.clientToken, "container restart retains browser login credential");
});

test("daemon startup failure terminates the container without starting edge", { timeout: 8000 }, async t => {
  const f = await fixture(t, { earlyExit: true });
  const running = f.start();
  const [code] = await once(running.child, "exit");
  assert.notEqual(code, 0);
  await assert.rejects(readFile(join(f.root, "edge.json")), { code: "ENOENT" });
});
