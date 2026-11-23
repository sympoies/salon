import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import type { ChildProcess } from "node:child_process";
import { parse } from "@decimalturn/toml-patch";

async function fixture(t: TestContext, { earlyExit = false, refuseHookSetup = false } = {}) {
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
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
  const daemon = `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
if (process.argv[2] === "activity") {
  writeFileSync(root + '/hook-setup.json', JSON.stringify({ args: process.argv.slice(2), env: process.env }));
  process.exit(${refuseHookSetup ? 65 : 0});
}
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
import { startEdge } from ${JSON.stringify(new URL("../packages/edge/src/start.ts", import.meta.url).href)};
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
export function startWorkspaceEdge({ daemonToken, clientToken, accessDbPath, onShutdown }) {
 const root = ${JSON.stringify(root)};
 const daemon = existsSync(root + '/daemon.json') ? JSON.parse(readFileSync(root + '/daemon.json', 'utf8')) : {};
 const edge = startEdge({
  AGENT_CONSOLE_TOKEN: clientToken, AGENT_CONSOLE_EDGE_PORT: '0', AGENT_CONSOLE_STATE_DB: accessDbPath,
 }, {}, onShutdown);
 // Signal readiness only after edge shutdown handlers are installed and listening.
 edge.once('listening', () => writeFileSync(root + '/edge.json', JSON.stringify({
  ready: existsSync(root + '/ready'), daemonMatches: daemonToken === daemon.token,
  distinct: daemonToken !== clientToken, clientToken, port: edge.address().port,
  hookSetupAttempted: existsSync(root + '/hook-setup.json'),
 })));
 return edge;
}
`);
  const home = join(root, "home");
  const workspace = join(home, "Project/workspace");
  const codexHome = join(home, ".codex");
  const env = {
    PATH: bin + ":/usr/bin:/bin", HOME: home, CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: join(home, ".claude"), DISABLE_UPDATES: "1",
    XDG_STATE_HOME: join(home, ".local/state"), XDG_RUNTIME_DIR: join(root, "run"),
    NODE_OPTIONS: `--conditions=source --import=${join(root, "readiness.mjs")}`,
    ANTHROPIC_API_KEY: "fixture-inherited-provider-credential",
    AGENT_SESSION_TOKEN: "fixture-inherited-daemon-credential",
    AGENT_CONSOLE_TOKEN: "fixture-inherited-browser-credential",
    AGENT_CONSOLE_MACHINES: "fixture-inherited-upstream-credential",
  };
  function start(cwd = workspace) {
    const child = spawn(process.execPath, [join(root, "docker/start.ts")], {
      cwd, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    children.push(child);
    return { child, output: () => output };
  }
  return { root, home, workspace, codexHome, start };
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
  assert.equal(daemon.env.CLAUDE_CONFIG_DIR, join(f.home, ".claude"));
  assert.equal(daemon.env.DISABLE_UPDATES, "1");
  for (const name of ["AGENT_SESSION_TOKEN", "AGENT_CONSOLE_TOKEN", "AGENT_CONSOLE_MACHINES", "ANTHROPIC_API_KEY", "NODE_OPTIONS"]) {
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

test("initializes trust for only the default Codex workspace across restarts", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const config = join(f.codexHome, "config.toml");
  const first = f.start();
  await waitFile(join(f.root, "edge.json"), first);
  const initial = await readFile(config, "utf8");
  const { projects } = parse(initial);
  assert.deepEqual(Object.keys(projects), [f.workspace]);
  assert.equal(projects[f.workspace].trust_level, "trusted");

  const exited = once(first.child, "exit");
  first.child.kill("SIGTERM");
  await exited;
  for (const name of ["ready", "edge.json", "stopped"]) await unlink(join(f.root, name));

  const second = f.start();
  await waitFile(join(f.root, "edge.json"), second);
  assert.equal(await readFile(config, "utf8"), initial);
});

test("adds Codex workspace trust alongside existing user settings", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const config = join(f.codexHome, "config.toml");
  const initial = '# User settings\nmodel = "example-model"\n\n[projects."/other/project"]\ntrust_level = "untrusted"\n';
  await mkdir(f.codexHome);
  await writeFile(config, initial);

  await waitFile(join(f.root, "edge.json"), f.start());
  const updated = await readFile(config, "utf8");
  assert.ok(updated.startsWith('# User settings\nmodel = "example-model"\n'));
  const { projects } = parse(updated);
  assert.equal(projects["/other/project"].trust_level, "untrusted");
  assert.equal(projects[f.workspace].trust_level, "trusted");
});

test("preserves an explicit Codex workspace trust decision", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const config = join(f.codexHome, "config.toml");
  const initial = `projects = { '${f.workspace}' = { trust_level = 'untrusted' } } # User decision\n`;
  await mkdir(f.codexHome);
  await writeFile(config, initial);

  await waitFile(join(f.root, "edge.json"), f.start());
  assert.equal(await readFile(config, "utf8"), initial);
});

test("limits automatic Codex trust to the default workspace when startup uses another directory", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const otherDirectory = join(f.home, "Project/extra");
  await mkdir(otherDirectory);

  await waitFile(join(f.root, "edge.json"), f.start(otherDirectory));
  const { projects } = parse(await readFile(join(f.codexHome, "config.toml"), "utf8"));
  assert.deepEqual(Object.keys(projects), [f.workspace]);
  assert.equal(projects[f.workspace].trust_level, "trusted");
});

test("attempts Claude activity setup before the edge starts and tolerates a refusal", { timeout: 8000 }, async t => {
  const f = await fixture(t, { refuseHookSetup: true });
  const running = f.start();
  const edge = await waitFile(join(f.root, "edge.json"), running);
  assert.equal(edge.hookSetupAttempted, true);
  const setup = JSON.parse(await readFile(join(f.root, "hook-setup.json"), "utf8"));
  assert.deepEqual(setup.args, ["activity", "setup", "--agent", "claude", "--apply"]);
  assert.equal(setup.env.CLAUDE_CONFIG_DIR, join(f.home, ".claude"));
  assert.equal(setup.env.ANTHROPIC_API_KEY, undefined);
  assert.match(running.output(), /Claude activity hook setup failed/);
});

test("keeps a browser session in the runtime state volume across restarts", { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const first = f.start();
  const edge = await waitFile(join(f.root, "edge.json"), first);
  const origin = "http://127.0.0.1:" + edge.port;
  const login = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token: edge.clientToken }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0]?.split(";", 1)[0];
  assert.ok(cookie);
  await login.arrayBuffer();

  const exited = once(first.child, "exit");
  first.child.kill("SIGTERM");
  await exited;
  for (const name of ["ready", "edge.json", "stopped"]) await unlink(join(f.root, name));

  const second = await waitFile(join(f.root, "edge.json"), f.start());
  const status = await fetch("http://127.0.0.1:" + second.port + "/api/auth/status", { headers: { cookie } });
  assert.equal((await status.json()).authenticated, true);
  assert.ok((await stat(join(f.home, ".local/state/salon/access.sqlite"))).isFile());
});

test("the Claude API-key helper can be added and removed without losing activity hooks", async t => {
  const root = await mkdtemp(join(tmpdir(), "salon-claude-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  const initial = {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "agent-hook" }] }] },
    permissions: { defaultMode: "default" },
  };
  await writeFile(settingsPath, JSON.stringify(initial), { mode: 0o600 });
  const script = fileURLToPath(new URL("./claude-api-key-helper.ts", import.meta.url));
  const run = promisify(execFile);
  const options = { env: { CLAUDE_CONFIG_DIR: root } };

  await run(process.execPath, [script, "add"], options);
  const { apiKeyHelper, ...settings } = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(settings, initial);
  await writeFile(join(root, "api-key"), "synthetic-key", { mode: 0o600 });
  const helper = await run("/bin/sh", ["-c", apiKeyHelper], {
    env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: root },
  });
  assert.equal(helper.stdout, "synthetic-key", "Claude's helper reads the key file");
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);

  await run(process.execPath, [script, "remove"], options);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), initial);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);

  const custom = JSON.stringify({ ...initial, apiKeyHelper: "example-secret-manager read" });
  await writeFile(settingsPath, custom);
  for (const operation of ["add", "remove"]) {
    await assert.rejects(run(process.execPath, [script, operation], options), /different API-key helper/);
    assert.equal(await readFile(settingsPath, "utf8"), custom);
  }
});
