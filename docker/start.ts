import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TomlDocument } from "@decimalturn/toml-patch";

let daemon: ChildProcessByStdio<Writable, null, null> | undefined;
let edge: ReturnType<typeof import("../apps/workspace/src/server.ts").startWorkspaceEdge> | undefined;
let stopping = false;

async function initializeCodexTrust(codexHome: string, workspace: string) {
  const configPath = join(codexHome, "config.toml");
  const existing = await readFile(configPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const document = new TomlDocument(existing ?? "");
  const config: { projects?: Record<string, { trust_level?: string }> } = document.toJsObject;
  const projects = config.projects ??= {};
  const project = projects[workspace] ??= {};
  if (Object.hasOwn(project, "trust_level")) return;

  project.trust_level = "trusted";
  document.patch(config, { inlineTableStart: 2 });

  // Keep the old config intact until the replacement is fully written.
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const target = existing ? await realpath(configPath) : configPath;
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, document.toTomlString, { flag: "wx", mode: 0o600 });
    if (existing) await chmod(temporary, (await stat(target)).mode & 0o777);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function stopDaemon() {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill("SIGTERM");
    const deadline = setTimeout(() => {
      daemon!.kill("SIGKILL");
      process.exit(1);
    }, 5000);
    deadline.unref();
    await exited;
    clearTimeout(deadline);
  }
}

async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  await Promise.all([edge?.shutdown(), stopDaemon()]);
  process.exit(code);
}

const startupSignal = () => { if (stopping) process.exit(1); void shutdown(0); };
process.on("SIGTERM", startupSignal);
process.on("SIGINT", startupSignal);

try {
  const state = join(process.env.XDG_STATE_HOME!, "salon");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const credential = join(state, "browser-token");
  try {
    await writeFile(credential, randomBytes(32).toString("hex") + "\n", {
      flag: "wx", mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await chmod(credential, 0o600);
  const clientToken = (await readFile(credential, "utf8")).trim();
  if (!clientToken) throw new Error("Empty browser credential");
  const daemonToken = randomBytes(32).toString("hex");

  // Keep automatic trust confined to the workspace volume's default mount.
  const workspace = join(process.env.HOME!, "Project/workspace");
  await initializeCodexTrust(process.env.CODEX_HOME!, workspace);

  // Only runtime paths and terminal settings enter provider ancestry. Neither
  // operator credential is exported to the daemon, tmux or provider children.
  const env: NodeJS.ProcessEnv = { LANG: "C.UTF-8", TERM: "xterm-256color" };
  for (const key of ["PATH", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "DISABLE_UPDATES",
    "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "AGENT_HOME", "AGENT_SESSION_STATE_DIR", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Start a separate process session so Linux tmux identity checks do not
  // see the daemon inheriting process session 1 from the container init.
  daemon = spawn("agent-session", ["serve", "--bind", "127.0.0.1:8781",
    "--machine", "workspace", "--host", "workspace", "--token-stdin"], {
    detached: true, env, stdio: ["pipe", "inherit", "inherit"],
  });
  daemon.once("error", () => { daemon = undefined; void shutdown(1); });
  daemon.once("exit", () => void shutdown(1));
  daemon.stdin.on("error", () => void shutdown(1));
  daemon.stdin.end(daemonToken + "\n");

  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8781/healthz", {
        signal: AbortSignal.timeout(500),
      });
      // Consume the response so readiness never leaves a connection body open.
      await response.arrayBuffer();
      if (response.ok) { ready = true; break; }
    } catch { /* The daemon has not bound its listener yet. */ }
    await delay(100);
  }
  if (!ready) throw new Error("Daemon readiness timed out");
  const { startWorkspaceEdge } = await import("../apps/workspace/src/server.ts");
  process.off("SIGTERM", startupSignal);
  process.off("SIGINT", startupSignal);
  edge = startWorkspaceEdge({ daemonToken, clientToken, onShutdown: async () => { stopping = true; await stopDaemon(); } });
  edge.once("error", () => void shutdown(1));
  edge.once("close", () => { if (!stopping) void shutdown(1); });
} catch {
  console.error("Salon startup failed.");
  await shutdown(1);
}
