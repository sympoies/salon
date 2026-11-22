import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// Run inside a fresh Compose workspace with no Codex credentials.
test("default Codex creation reaches provider sign-in", { timeout: 30_000 }, async () => {
  const origin = "http://127.0.0.1:3000";
  const signal = AbortSignal.timeout(25_000);
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

  const response = await fetch(origin + "/api/sessions/workspace", {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ agent: "codex" }),
    signal,
  });
  const result = await response.json() as { error?: { code?: string; details?: { reason?: string } } };
  // The daemon stops an unauthenticated launch after recognizing the provider prompt.
  assert.equal(result.error?.code, "start-failed", "the provider starts far enough to return a setup reason");
  assert.equal(result.error.details?.reason, "startup-prompt-required", "Codex reaches the sign-in screen");
});
