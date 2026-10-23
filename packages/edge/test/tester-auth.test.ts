import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parsePrincipals } from "../src/config.ts";

test("tester identity can use owner-managed credentials without a token in config", () => {
  const [tester] = parsePrincipals(JSON.stringify([
    { id: "tester-resident", managedCredential: true, machines: ["acceptance"], permissions: [] },
  ]), [{ name: "acceptance", url: "http://127.0.0.1:1", token: "daemon-fixture" }]);
  assert.equal(tester?.id, "tester-resident");
  assert.equal(tester?.token, "");
  assert.deepEqual(tester?.permissions, []);
});

import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { TestCredentialStore } from "../src/testCredentials.ts";
import { AccessStore } from "../src/accessStore.ts";
import { createEdgeServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { listenOnLoopback, loginCookie } from "./support.ts";

test("managed config cannot elevate root or combine owner-issued and configured credentials", () => {
  for (const principal of [
    { id: "root", managedCredential: true },
    { id: "owner", managedCredential: true },
    { id: "tester-resident", managedCredential: true, token: "static-fixture" },
    { id: "tester-resident", managedCredential: "yes", token: "static-fixture" },
  ]) assert.throws(() => parsePrincipals(JSON.stringify([{ ...principal, machines: [], permissions: [] }]), []));
  const principals = parsePrincipals(JSON.stringify([
    { id: "tester-one", managedCredential: true, machines: [], permissions: [] },
    { id: "tester-two", managedCredential: true, machines: [], permissions: [] },
  ]), []);
  assert.equal(principals.length, 2);
});

test("owner issuance is atomic and audit never includes credentials or hashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "console-tester-store-"));
  const path = join(dir, "access.sqlite");
  const store = new TestCredentialStore(path);
  try {
    assert.throws(() => store.issue("owner", () => {}));
    assert.throws(() => store.issue("tester-resident", () => { throw new Error("fixture output failure"); }));
    assert.equal(store.fingerprint("tester-resident"), undefined);
    assert.deepEqual(store.audit(), []);
    let token = "";
    store.issue("tester-resident", value => { token = value; });
    assert.match(token, /^ac_test_[A-Za-z0-9_-]{43}$/);
    assert.throws(() => store.issue("tester-resident", () => {}));
    assert.equal(store.authenticate(token), "tester-resident");
    assert.equal(store.authenticate("forged"), undefined);
    store.signIn("tester-resident");
    assert.equal(store.revoke("tester-resident"), true);
    assert.equal(store.revoke("tester-resident"), false);
    assert.equal(store.authenticate(token), undefined);
    const audit = store.audit();
    assert.deepEqual(audit.map(row => row.action), ["create", "sign-in", "revoke"]);
    assert.ok(audit.every(row => row.actor && row.occurred_at));
    assert.equal(JSON.stringify(audit).includes(token), false);
    const db = new DatabaseSync(path);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM test_credentials").all()).includes(token), false);
    db.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function cli(args: string[]) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/test-credential.ts", import.meta.url)), ...args], { env: { ...process.env, NODE_DEBUG: "", DEBUG: "" } });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const [code] = await once(child, "close");
  return { code, output, argv: child.spawnargs };
}

test("owner CLI writes only a new private file and keeps secret values out of diagnostics and argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "console-tester-cli-"));
  const path = join(dir, "access.sqlite");
  const file = join(dir, "credential");
  try {
    const result = await cli(["create", "--db", path, "--principal", "tester-resident", "--out-file", file]);
    assert.equal(result.code, 0);
    const token = readFileSync(file, "utf8").trim();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(result.output.includes(token), false);
    assert.equal(result.argv.join(" ").includes(token), false);
    const duplicate = await cli(["create", "--db", path, "--principal", "tester-resident", "--out-file", file]);
    assert.equal(duplicate.code, 1);
    assert.equal(readFileSync(file, "utf8").trim(), token);
    const audit = await cli(["audit", "--db", path]);
    assert.equal(audit.code, 0);
    assert.equal(audit.output.includes(token), false);
    assert.equal(audit.output.includes("token_hash"), false);
    const revoke = await cli(["revoke", "--db", path, "--principal", "tester-resident"]);
    assert.equal(revoke.code, 0);
    const link = join(dir, "link");
    symlinkSync(file, link);
    assert.equal((await cli(["create", "--db", path, "--principal", "tester-another", "--out-file", link])).code, 1);
    assert.equal(readFileSync(file, "utf8").trim(), token);
    const leakedError = await cli(["create", "--db", path, "--principal", "tester-another", "--out-file", token]);
    assert.equal(leakedError.code, 1);
    assert.equal(leakedError.output.includes(token), false, "raw argument errors must be suppressed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tester cookies/native auth stay scoped across redeploy and revoke immediately without owner changes", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "console-tester-edge-"));
  const path = join(dir, "access.sqlite");
  const credentials = new TestCredentialStore(path);
  let token = "";
  credentials.issue("tester-resident", value => { token = value; });
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") res.end(JSON.stringify({ ok: true, data: { sessions: [
      { id: "tester-session", session_incarnation: "tester-inc", agent: "codex", status: "running" },
      { id: "owner-session", session_incarnation: "owner-inc", agent: "codex", status: "running" },
    ] } }));
    else { res.statusCode = 404; res.end("{}"); }
  });
  const daemonAddress = await listenOnLoopback(daemon);
  const config = loadConfig({
    AGENT_CONSOLE_STATE_DB: path, AGENT_CONSOLE_INSECURE_COOKIE: "1",
    AGENT_CONSOLE_MACHINES: JSON.stringify([
      { name: "acceptance", url: daemonAddress.base, token: "daemon-fixture" },
      { name: "private", url: daemonAddress.base, token: "private-daemon-fixture" },
    ]),
    AGENT_CONSOLE_PRINCIPALS: JSON.stringify([
      { id: "owner", token: "owner-fixture", machines: ["acceptance", "private"], permissions: ["usage"] },
      { id: "tester-resident", managedCredential: true, machines: ["acceptance"], permissions: [] },
    ]),
  });
  const access = new AccessStore(path);
  access.claimSession({ principalId: "tester-resident", machine: "acceptance", sessionId: "tester-session", incarnation: "tester-inc" });
  access.claimSession({ principalId: "owner", machine: "acceptance", sessionId: "owner-session", incarnation: "owner-inc" });
  access.close();
  let edge = createEdgeServer(config);
  const stop = async () => { await new Promise<void>(resolve => edge.close(() => resolve())); };
  try {
    let { base } = await listenOnLoopback(edge);
    const cookie = await loginCookie(base, token);
    const ownerCookie = await loginCookie(base, "owner-fixture");
    const status = async (headers: Record<string, string>) => (await (await fetch(`${base}/api/auth/status`, { headers })).json());
    assert.equal((await status({ cookie })).principal.id, "tester-resident");
    const sessions = await (await fetch(`${base}/api/sessions`, { headers: { cookie } })).json();
    assert.deepEqual(sessions.data.sessions.map((session: { id: string }) => session.id), ["tester-session"]);
    assert.equal(JSON.stringify(sessions).includes("owner-session"), false);
    assert.equal(JSON.stringify(sessions).includes("private-daemon-fixture"), false);
    const denied = await fetch(`${base}/api/usage`, { headers: { cookie } });
    assert.equal(denied.status, 403);
    assert.equal((await status({ authorization: `Bearer ${token}`, cookie: ownerCookie })).principal.id, "tester-resident");
    assert.equal((await status({ authorization: "Bearer invalid-fixture", cookie: ownerCookie })).authenticated, false);
    await stop();
    edge = createEdgeServer(config);
    ({ base } = await listenOnLoopback(edge));
    assert.equal((await status({ cookie })).authenticated, true);
    const streamSignal = AbortSignal.timeout(2000);
    const testerRead = await fetch(`${base}/api/resources/events?resources=sessions`, {
      headers: { cookie }, signal: streamSignal,
    });
    assert.equal(testerRead.status, 200);
    const reader = testerRead.body!.getReader();
    assert.equal((await reader.read()).done, false);
    credentials.revoke("tester-resident");
    // An idle read stream must close without another request or edge restart.
    try { while (!(await reader.read()).done) { /* drain pre-revoke chunks */ } }
    catch { assert.equal(streamSignal.aborted, false, "revocation must close the stream before the fixture timeout"); }
    assert.equal((await status({ cookie })).authenticated, false);
    assert.equal((await status({ authorization: `Bearer ${token}` })).authenticated, false);
    const rejectedLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(rejectedLogin.status, 401);
    const ownerStatus = await status({ cookie: ownerCookie });
    assert.equal(ownerStatus.principal.id, "owner");
    credentials.issue("tester-resident", value => { token = value; });
    assert.equal((await status({ cookie })).authenticated, false, "reissue does not revive old cookies");
    await loginCookie(base, token);
    const audit = JSON.stringify(credentials.audit());
    assert.equal(audit.includes(token), false);
    assert.equal(audit.includes("owner-fixture"), false);
  } finally {
    await stop();
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    credentials.close(); rmSync(dir, { recursive: true, force: true });
  }
});
