import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { AccessStore } from "../src/accessStore.ts";
import { loadConfig } from "../src/config.ts";
import { createEdgeServer } from "../src/server.ts";
import { TestCredentialStore, testCredentialHash } from "../src/testCredentials.ts";
import { listenOnLoopback, loginCookie } from "./support.ts";

const principalId = "tester-fixture";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "console-generation-"));
  const path = join(dir, "access.sqlite");
  const owner = new TestCredentialStore(path);
  let oldToken = "";
  let replacementToken = "";
  owner.issue(principalId, value => { oldToken = value; });
  const daemon = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: { sessions: [
      { id: "fixture-session", session_incarnation: "fixture-inc", agent: "codex", status: "running" },
    ] } }));
  });
  const upstream = await listenOnLoopback(daemon);
  const config = loadConfig({
    AGENT_CONSOLE_STATE_DB: path, AGENT_CONSOLE_INSECURE_COOKIE: "1",
    AGENT_CONSOLE_MACHINES: JSON.stringify([{ name: "acceptance", url: upstream.base, token: "daemon-fixture" }]),
    AGENT_CONSOLE_PRINCIPALS: JSON.stringify([
      { id: principalId, managedCredential: true, machines: ["acceptance"], permissions: [] },
    ]),
  });
  const access = new AccessStore(path);
  access.claimSession({ principalId, machine: "acceptance", sessionId: "fixture-session", incarnation: "fixture-inc" });
  access.close();
  const edge = createEdgeServer(config);
  const edgeSockets = new Set<Duplex>();
  edge.on("connection", socket => {
    edgeSockets.add(socket);
    socket.once("close", () => edgeSockets.delete(socket));
  });
  const { base } = await listenOnLoopback(edge);
  const status = async (headers: Record<string, string>) =>
    (await (await fetch(`${base}/api/auth/status`, { headers })).json()).authenticated as boolean;
  const readBuffer = async (cookie: string): Promise<boolean> => {
    try {
      const response = await fetch(`${base}/api/sessions/acceptance/fixture-session/buffer`, {
        headers: { cookie }, signal: AbortSignal.timeout(2000),
      });
      await response.arrayBuffer();
      return response.status === 200;
    } catch { return false; } // revoked responses may close without a body
  };
  return {
    owner, oldToken, base, status, readBuffer,
    replacement: () => replacementToken,
    replace() {
      owner.revoke(principalId);
      owner.issue(principalId, value => { replacementToken = value; });
    },
    async close() {
      for (const socket of edgeSockets) socket.destroy();
      await new Promise<void>(resolve => edge.close(() => resolve()));
      await new Promise<void>(resolve => daemon.close(() => resolve()));
      owner.close(); rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("old-token login cannot bind a cookie to a credential reissued after authentication", { timeout: 10000 }, async () => {
  const f = await fixture();
  const authenticate = TestCredentialStore.prototype.authenticate;
  let interleaved = false;
  try {
    TestCredentialStore.prototype.authenticate = function(token) {
      const matched = authenticate.call(this, token);
      if (matched === principalId && token === f.oldToken && !interleaved) {
        interleaved = true;
        f.replace(); // separate owner DB commits between the two edge lookups
      }
      return matched;
    };
    const cookie = await loginCookie(f.base, f.oldToken);
    assert.equal(interleaved, true);
    assert.equal(await f.status({ authorization: `Bearer ${f.oldToken}` }), false);
    assert.equal(await f.status({ authorization: `Bearer ${f.replacement()}` }), true);
    assert.equal(await f.status({ cookie }), false,
      "old-token login must not mint replacement-generation authorization");
  } finally {
    TestCredentialStore.prototype.authenticate = authenticate;
    await f.close();
  }
});

test("old-cookie read cannot use the replacement credential when its checked generation is reissued", { timeout: 10000 }, async () => {
  const f = await fixture();
  const fingerprint = TestCredentialStore.prototype.fingerprint;
  let interleaved = false;
  try {
    const cookie = await loginCookie(f.base, f.oldToken);
    assert.equal(await f.readBuffer(cookie), true, "fixture cookie can read its granted session before revocation");
    const oldFingerprint = testCredentialHash(f.oldToken);
    TestCredentialStore.prototype.fingerprint = function(id) {
      const matched = fingerprint.call(this, id);
      if (id === principalId && matched === oldFingerprint && !interleaved) {
        interleaved = true;
        f.replace(); // after store.get's credential snapshot, before principal reread
      }
      return matched;
    };
    const racedRead = await f.readBuffer(cookie);
    assert.equal(interleaved, true);
    assert.equal(await f.status({ cookie }), false);
    assert.equal(await f.status({ authorization: `Bearer ${f.replacement()}` }), true);
    assert.equal(racedRead, false, "revoked cookie must not use replacement-generation authorization for a protected read");
  } finally {
    TestCredentialStore.prototype.fingerprint = fingerprint;
    await f.close();
  }
});
