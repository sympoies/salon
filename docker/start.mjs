import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

let daemon;
let edge;
let stopping = false;

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  edge?.closeAllConnections();
  edge?.close();
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill("SIGTERM");
    const deadline = setTimeout(() => {
      daemon.kill("SIGKILL");
      process.exit(code);
    }, 5000);
    deadline.unref();
    await exited;
    clearTimeout(deadline);
  }
  process.exit(code);
}

process.once("SIGTERM", () => void shutdown(0));
process.once("SIGINT", () => void shutdown(0));

try {
  const state = join(process.env.XDG_STATE_HOME, "salon");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const credential = join(state, "browser-token");
  try {
    await writeFile(credential, randomBytes(32).toString("hex") + "\n", {
      flag: "wx", mode: 0o600,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await chmod(credential, 0o600);
  const clientToken = (await readFile(credential, "utf8")).trim();
  if (!clientToken) throw new Error("Empty browser credential");
  const daemonToken = randomBytes(32).toString("hex");

  // Only runtime paths and terminal settings enter provider ancestry. Neither
  // operator credential is exported to the daemon, tmux or provider children.
  const env = { LANG: "C.UTF-8", TERM: "xterm-256color" };
  for (const key of ["PATH", "HOME", "CODEX_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "AGENT_HOME", "AGENT_SESSION_STATE_DIR", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  daemon = spawn("agent-session", ["serve", "--bind", "127.0.0.1:8781",
    "--machine", "workspace", "--host", "workspace", "--token-stdin"], {
    env, stdio: ["pipe", "inherit", "inherit"],
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
  const { startWorkspaceEdge } = await import("../apps/workspace/src/server.mjs");
  edge = startWorkspaceEdge({ daemonToken, clientToken });
  edge.once("error", () => void shutdown(1));
  edge.once("close", () => { if (!stopping) void shutdown(1); });
} catch {
  console.error("Salon startup failed.");
  await shutdown(1);
}
