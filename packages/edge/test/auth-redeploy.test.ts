import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SessionStore, SESSION_MAX_AGE } from "../src/auth.ts";
import { createEdgeServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { listenOnLoopback, loginCookie } from "./support.ts";

for (const multiUser of [true, false]) {
  test(`cookie survives edge replacement with retained state (${multiUser ? "multi-user" : "legacy"})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "console-redeploy-"));
    const config = loadConfig({
      AGENT_CONSOLE_STATE_DB: join(dir, "access.sqlite"),
      AGENT_CONSOLE_INSECURE_COOKIE: "1",
      ...(multiUser ? { AGENT_CONSOLE_PRINCIPALS: JSON.stringify([
        { id: "fixture", token: "fixture-token", machines: [], permissions: [] },
      ]) } : { AGENT_CONSOLE_TOKEN: "fixture-token" }),
    });
    let edge = createEdgeServer(config);
    const stop = async () => { await new Promise<void>((resolve, reject) => edge.close(error => error ? reject(error) : resolve())); };
    try {
      let { base } = await listenOnLoopback(edge);
      const cookie = await loginCookie(base, "fixture-token");
      const status = async () => (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json() as Promise<{ authenticated: boolean }>;
      assert.equal((await status()).authenticated, true);
      await stop();
      edge = createEdgeServer(config);
      ({ base } = await listenOnLoopback(edge));
      assert.equal((await status()).authenticated, true, "redeploy must retain the session");
      assert.equal((await (await fetch(`${base}/api/auth/status`, { headers: { cookie: "ac_session=forged" } })).json()).authenticated, false);
      const crossOrigin = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie, origin: "https://other.example" } });
      assert.equal(crossOrigin.status, 403);
      const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
      assert.equal(logout.status, 200);
      await stop();
      edge = createEdgeServer(config);
      ({ base } = await listenOnLoopback(edge));
      assert.equal((await status()).authenticated, false, "logout must remain effective across redeploy");
    } finally {
      await stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("retained sessions enforce original 12-hour expiry and credential revocation", () => {
  const dir = mkdtempSync(join(tmpdir(), "console-session-expiry-"));
  const path = join(dir, "access.sqlite");
  let now = 1000;
  let store = new SessionStore(path, () => now);
  try {
    const expiring = store.create("fixture", "fixture-token");
    const rotated = store.create("fixture", "fixture-token");
    const removed = store.create("fixture", "fixture-token");
    store.close();
    const db = new DatabaseSync(path);
    const rows = db.prepare("SELECT * FROM auth_sessions").all();
    assert.equal(JSON.stringify(rows).includes(expiring), false, "cookie is never stored in cleartext");
    assert.equal(JSON.stringify(rows).includes("fixture-token"), false, "credential is never stored in cleartext");
    assert.equal(JSON.stringify(rows).includes(createHash("sha256").update("fixture-token").digest("hex")), false,
      "database alone must not provide an offline verifier for credential guesses");
    db.close();
    now += SESSION_MAX_AGE * 1000 - 1;
    store = new SessionStore(path, () => now);
    assert.equal(store.get(expiring, () => "fixture-token"), "fixture");
    assert.equal(store.get(rotated, () => "changed-fixture-token"), undefined);
    assert.equal(store.get(removed, () => undefined), undefined);
    store.close();
    now++;
    store = new SessionStore(path, () => now);
    assert.equal(store.get(expiring, () => "fixture-token"), undefined, "restart and reads never renew expiry");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
