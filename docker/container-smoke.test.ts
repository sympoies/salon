import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// Run inside a fresh, disposable Compose workspace with no provider credentials.
test("the image starts with Claude activity hooks configured", () => {
  const options = { encoding: "utf8", timeout: 10_000 } as const;
  execFileSync("agent-hook", ["--version"], options);
  const preview = JSON.parse(execFileSync("agent-session",
    ["activity", "setup", "--agent", "claude", "--dry-run", "--format", "json"], options));
  assert.equal(preview.data?.configured, true, "Claude hooks are configured after startup");
  assert.equal(preview.data?.would_change, false, "hook setup is already converged");
  assert.ok(preview.data.owned_events.includes("SessionStart"), "Claude startup is tracked");
  assert.ok(preview.data.owned_events.includes("UserPromptSubmit"), "Claude prompts are tracked");
  assert.ok(preview.data.owned_events.includes("Stop"), "Claude stop is tracked");
});

test("the running image accepts a shared reply without a provider login", { timeout: 30_000 }, async t => {
  const id = "smoke-" + randomUUID();
  const directory = await mkdtemp(join(process.cwd(), ".salon-smoke-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = join(directory, "provider");
  await writeFile(provider, "#!/bin/sh\nprintf 'Synthetic provider ready\\n'\nexec sleep 60\n", { mode: 0o700 });

  // Exercise the real daemon and edge using an inert Claude process.
  const options = { encoding: "utf8", timeout: 10_000 } as const;
  execFileSync("agent-session", ["start", "--agent", "claude", "--agent-bin", provider, "--id", id], options);
  // Stop the pane here. The disposable container's teardown reaps any descendants.
  t.after(() => { execFileSync("agent-session", ["delete", "--leave-processes", id], options); });
  const origin = "http://127.0.0.1:3000";
  const signal = AbortSignal.timeout(5_000);
  const token = (await readFile(join(process.env.XDG_STATE_HOME!, "salon/browser-token"), "utf8")).trim();
  const login = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token }),
    signal,
  });
  assert.equal(login.status, 200, "Salon accepts its browser credential");
  const cookie = login.headers.getSetCookie()[0]?.split(";", 1)[0];
  assert.ok(cookie, "Salon creates a browser session");
  await login.arrayBuffer();

  const sessions = await fetch(origin + "/api/sessions", { headers: { cookie }, signal });
  assert.equal(sessions.status, 200);
  const { data } = await sessions.json();
  const session = data.sessions.find((entry: { id: string }) => entry.id === id);
  assert.ok(session?.session_incarnation, "the daemon lists the synthetic session");

  const intent = randomUUID();
  const path = ["/api/sessions/workspace", id, "outbox", intent].join("/");
  const headers = { cookie, origin, "content-type": "application/json", "x-console-expected-principal": "legacy" };
  const response = await fetch(origin + path, {
    method: "PUT", headers, signal,
    body: JSON.stringify({ expected_session_incarnation: session.session_incarnation, text: "Synthetic reply" }),
  });
  const result = await response.json();
  assert.equal(response.status, 201, result.error?.code);
  assert.equal(result.data?.item.id, intent);
});
