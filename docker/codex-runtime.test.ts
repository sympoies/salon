import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const inContainer = process.env.SALON_CODEX_SMOKE === "container";

test("Codex uses the sandbox policy for its launch environment", { timeout: 20_000 }, async t => {
  const options: Parameters<typeof spawn>[2] = { stdio: ["pipe", "pipe", "inherit"] };
  if (!inContainer) {
    // Use an empty host config and working directory without touching a real account.
    const root = await mkdtemp(join(tmpdir(), "salon-codex-host-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const codexHome = join(root, "codex");
    await mkdir(codexHome);
    options.cwd = root;
    options.env = { PATH: process.env.PATH, LANG: "C.UTF-8", CODEX_HOME: codexHome };
  }

  const app = spawn("codex", ["app-server", "--stdio", "--strict-config"], options);
  const closed = once(app, "close");
  t.after(async () => {
    app.kill();
    await closed;
  });
  assert.ok(app.stdin && app.stdout);
  const stdin = app.stdin;
  const events = createInterface({ input: app.stdout })[Symbol.asyncIterator]();
  const warnings: string[] = [];
  let requestId = 0;

  async function request<Result>(method: string, params: object): Promise<Result> {
    const id = ++requestId;
    stdin.write(JSON.stringify({ id, method, params }) + "\n");

    for (;;) {
      const next = await events.next();
      assert.equal(next.done, false, `Codex exited before answering ${method}`);
      const event = JSON.parse(next.value);
      if (event.method === "configWarning") warnings.push(event.params.summary);
      if (event.id !== id) continue;
      assert.ok(!event.error, `${method}: ${event.error?.message}`);
      return event.result as Result;
    }
  }

  await request("initialize", {
    clientInfo: { name: "salon-smoke", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  stdin.write(JSON.stringify({ method: "initialized" }) + "\n");

  if (!inContainer) {
    const thread = await request<{ sandbox: { type: string } }>("thread/start", { ephemeral: true });
    assert.match(thread.sandbox.type, /^(readOnly|workspaceWrite)$/, "host Codex keeps its own sandbox");
    return;
  }

  // A standalone app-server command uses the configured policy without a provider login.
  const command = await request<{ exitCode: number; stdout: string; stderr: string }>("command/exec", {
    command: ["/usr/bin/printf", "salon-codex-ok"],
    timeoutMs: 5_000,
  });
  await t.test("container startup has zero config warnings", () => {
    assert.deepEqual(warnings, []);
  });
  await t.test("Codex runs a tool command with the default container policy", () => {
    assert.equal(command.exitCode, 0, command.stderr);
    assert.equal(command.stdout, "salon-codex-ok");
  });
});
