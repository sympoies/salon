import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { AccessStore } from "../src/accessStore.ts";
import { loadConfig } from "../src/config.ts";
import { DeviceCredentialStore, credentialHash } from "../src/deviceCredentials.ts";
import { createEdgeServer, type EdgeServerOptions } from "../src/server.ts";
import { cookieFrom, listenOnLoopback, loginCookie } from "./support.ts";

const DAY = 86_400_000;
type Data = Record<string, any>;

async function fixture(multiUser = false, daemon?: string, options: EdgeServerOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pairing-fixture-"));
  const path = join(dir, "state.sqlite");
  let now = Date.now();
  const config = loadConfig({ AGENT_CONSOLE_STATE_DB: path, AGENT_CONSOLE_INSECURE_COOKIE: "1",
    ...(daemon ? { AGENT_CONSOLE_MACHINES: JSON.stringify([{ name: "fixture", url: daemon, token: "daemon-fixture" }]) } : {}),
    ...(multiUser ? { AGENT_CONSOLE_PRINCIPALS: JSON.stringify([
      { id: "primary", token: "primary-fixture", machines: daemon ? ["fixture"] : [], permissions: ["debug"] },
      { id: "other", token: "other-fixture", machines: [], permissions: [] },
    ]) } : { AGENT_CONSOLE_TOKEN: "primary-fixture" }),
  });
  if (daemon && multiUser) {
    const access = new AccessStore(path);
    access.claimSession({ principalId: "primary", machine: "fixture", sessionId: "fixture-session", incarnation: "fixture-inc" });
    access.claimHistory("primary", "fixture", "history", "codex", "provider-fixture");
    access.close();
  }
  let edge = createEdgeServer(config, { ...options, authNow: () => now });
  let { base } = await listenOnLoopback(edge);
  const cookie = await loginCookie(base, "primary-fixture");
  const call = async (route: string, body?: unknown, auth: Record<string, string> = {}, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${base}/api/auth/${route}`, { method,
      headers: { "content-type": "application/json", ...auth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, status: response.status, body: await response.json() as Data };
  };
  const create = async () => {
    const result = await call("pairings", {}, { cookie });
    assert.equal(result.status, 201, "main-authenticated pairing creation is available");
    return result.body.data;
  };
  const claim = async (pair: Data, delivery = "native") => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("hex");
    const result = await call("pairings/claim", { code: pair.code, challenge, name: "Test device", delivery });
    assert.equal(result.status, 200);
    return { code: pair.code, verifier, challenge, delivery, principal: result.body.data.principal,
      origin: base, confirmed: true };
  };
  const approve = (pair: Data, claim: Data, auth = { cookie }) => call(`pairings/${pair.id}/approve`,
    { code: pair.code, challenge: claim.challenge }, auth);
  const issue = async (delivery = "native") => {
    const pair = await create();
    const bound = await claim(pair, delivery);
    assert.equal((await approve(pair, bound)).status, 200);
    const result = await call("pairings/exchange", bound);
    assert.equal(result.status, 200);
    return { pair, bound, result, token: result.body.data.credential as string, id: result.body.data.id as string };
  };
  return { get base() { return base; }, path, cookie, call, create, claim, approve, issue,
    async restart(main = "primary-fixture") {
      edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve()));
      edge = createEdgeServer({ ...config,
        clientToken: multiUser ? "" : main,
        principals: config.principals.map(principal => principal.id === "primary" ? { ...principal, token: main } : principal),
      }, { ...options, authNow: () => now });
      ({ base } = await listenOnLoopback(edge));
    },
    advance(ms: number) { now += ms; },
    async close() { edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); rmSync(dir, { recursive: true }); },
  };
}

for (const fate of ["revoked", "expired", "revoked-during-observation"]) test(`the ${fate} device cannot dispatch its persisted queued outbox intentions`, async () => {
  let running = false;
  let pauseObservation = false;
  let observed = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const posts: string[] = [];
  const daemon = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/sessions") {
      if (pauseObservation) { pauseObservation = false; observed = true; await pending; }
      return void res.end(JSON.stringify({ ok: true, data: { sessions: [{
      id: "fixture-session", status: running ? "running" : "stopped", agent: "codex", session_incarnation: "fixture-inc",
      provider_resume: { provider: "codex", session_id: "provider-fixture" },
      }] } }));
    }
    if (req.method === "POST" && req.url === "/sessions/fixture-session/prompt/v2") {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw); posts.push(body.text);
      return void res.end(JSON.stringify({ ok: true, data: { submitted: true, session_incarnation: "fixture-inc", receipt: {
        request_id: body.request_id, session_id: "fixture-session", session_incarnation: "fixture-inc", outcome: "submitted", code: null,
      } } }));
    }
    res.writeHead(404); res.end("{}");
  });
  const { base } = await listenOnLoopback(daemon);
  const f = await fixture(true, base, { outboxPollIntervalMs: 20 });
  const main = { authorization: "Bearer primary-fixture" };
  const path = "/api/sessions/fixture/fixture-session/outbox";
  const admit = async (id: string, text: string, token: string) => {
    const response = await fetch(`${f.base}${path}/${id}`, { method: "PUT", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "x-console-expected-principal": "primary",
    }, body: JSON.stringify({ text, expected_session_incarnation: "fixture-inc" }) });
    assert.equal(response.status, 201);
  };
  try {
    const first = await f.issue(); const second = await f.issue();
    await admit("retired-device", "Must not dispatch", first.token);
    await admit("active-device", "Active device intention", second.token);
    await admit("main-intention", "Main intention", "primary-fixture");
    assert.deepEqual(posts, [], "stopped sessions keep all three intentions pending");
    if (fate === "revoked") {
      assert.equal((await f.call(`devices/${first.id}`, undefined, main, "DELETE")).status, 200);
      const response = await fetch(`${f.base}${path}?expected_session_incarnation=fixture-inc`, { headers: {
        ...main, "x-console-expected-principal": "primary",
      } });
      assert.equal((await response.json() as Data).data.items[0].state, "refused", "revocation immediately retires pending work");
    } else {
      if (fate === "revoked-during-observation") {
        running = true; pauseObservation = true;
        const deadline = Date.now() + 2000;
        while (!observed) {
          assert.ok(Date.now() < deadline, "dispatcher must start the controlled daemon observation");
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      const db = new DatabaseSync(f.path);
      db.prepare(fate === "expired" ? "UPDATE device_credentials SET expires_at=0 WHERE id=?"
        : "UPDATE device_credentials SET revoked=0 WHERE id=?").run(first.id); db.close();
    }
    if (fate !== "revoked-during-observation") await f.restart();
    running = true; release();
    const deadline = Date.now() + 3000;
    while (!posts.includes("Main intention")) {
      assert.ok(Date.now() < deadline, "the dispatcher must progress to the healthy main intention");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(posts, ["Active device intention", "Main intention"], "pending work cannot inherit the main credential after device retirement");
    const response = await fetch(`${f.base}${path}?expected_session_incarnation=fixture-inc`, { headers: {
      ...main, "x-console-expected-principal": "primary",
    } });
    const snapshot = await response.json() as Data;
    assert.equal(snapshot.data.items[0].state, "refused");
    assert.equal(snapshot.data.items[0].error_code, "outbox-authorization-changed");
    const db = new DatabaseSync(f.path);
    try {
      const rows = JSON.stringify(db.prepare("SELECT * FROM outbox_items").all());
      assert.equal(rows.includes(first.token), false); assert.equal(rows.includes(second.token), false);
      assert.equal(rows.includes(first.id), true, "only public issuing-device identity is retained");
    } finally { db.close(); }
  } finally {
    release();
    await f.close(); daemon.closeAllConnections(); await new Promise<void>(resolve => daemon.close(() => resolve()));
  }
});

test("device read saturation cannot block main metadata reads or selective revocation", async () => {
  const f = await fixture();
  try {
    const first = await f.issue(); const second = await f.issue();
    let limited = false;
    for (let i = 0; i < 130; i++) {
      const status = (await f.call("devices", undefined, { authorization: `Bearer ${first.token}` })).status;
      if (status === 429) { limited = true; break; } assert.equal(status, 200);
    }
    assert.equal(limited, true, "device reads have a bounded independent budget");
    assert.equal((await f.call(`devices/${first.id}`, undefined, { authorization: "Bearer primary-fixture" }, "DELETE")).status, 200);
    assert.equal((await f.call("devices", undefined, { cookie: f.cookie })).status, 200);
    assert.equal((await f.call("devices", undefined, { authorization: `Bearer ${second.token}` })).status, 200);
  } finally { await f.close(); }
});

test("a known-code holder cannot spend the main credential management budget", async () => {
  const f = await fixture();
  let store: DeviceCredentialStore | undefined;
  try {
    const device = await f.issue();
    const pair = await f.create(); const bound = await f.claim(pair); await f.approve(pair, bound);
    store = new DeviceCredentialStore(f.path, () => "primary-fixture", () => true);
    // Different source addresses share the code-owner budget; no forwarding header is trusted.
    for (let i = 0; i < 130; i++) assert.throws(() => store!.exchange({ ...bound, verifier: "x".repeat(43) } as any),
      (error: any) => error.status === 400 && error.message === "Pairing unavailable.");
    assert.equal((await f.call(`devices/${device.id}`, undefined, { cookie: f.cookie }, "DELETE")).status, 200);
    assert.equal((await f.call("devices", undefined, { cookie: f.cookie })).status, 200);
  } finally { store?.close(); await f.close(); }
});

test("anonymous address bucket capacity reserves authenticated owner operations", async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.path);
    try {
      db.exec("BEGIN");
      const insert = db.prepare("INSERT INTO device_pairing_limits(bucket,started,attempts) VALUES(?,?,1)");
      for (let i = 0; i < 10_000; i++) insert.run(credentialHash(`address:synthetic-${i}`), Date.now());
      db.exec("COMMIT");
    } finally { db.close(); }
    assert.equal((await f.call("devices", undefined, { cookie: f.cookie })).status, 200, "anonymous table saturation cannot deny the owner's first management request");
    assert.equal((await f.call("pairings/claim", {})).status, 429, "new anonymous address buckets remain bounded");
  } finally { await f.close(); }
});

for (const target of ["layout", "extension"]) test(`revoking an authenticated slow-body request prevents ${target} side effects`, async () => {
  let effects = 0;
  const f = await fixture(true, undefined, { extensions: [{ id: "fixture", routes: [{ id: "write",
    pattern: "/api/ext/fixture/write", methods: ["PUT"], permission: "debug", async handle(ctx) {
      await ctx.readJsonBody(); effects++; ctx.sendJson(200, { ok: true });
    }, }] }] });
  const db = new DatabaseSync(f.path);
  try {
    const { token, id } = await f.issue();
    const previous = (db.prepare("SELECT last_used FROM device_credentials WHERE id=?").get(id) as { last_used: number }).last_used;
    f.advance(1);
    const body = JSON.stringify({ order: ["fixture/session"], base_revision: 0 });
    let finish!: () => void;
    const result = new Promise<void>((resolve, reject) => {
      const req = httpRequest(`${f.base}/api/${target === "layout" ? "layout" : "ext/fixture/write"}`, { method: "PUT", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body),
      } }, res => { res.resume(); res.on("end", resolve); res.on("error", resolve); });
      req.on("error", error => { if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve(); else reject(error); });
      req.write(body.slice(0, 1)); finish = () => req.end(body.slice(1));
    });
    // last_used is a real authentication barrier, before the unfinished body can be parsed.
    const deadline = Date.now() + 2000;
    while ((db.prepare("SELECT last_used FROM device_credentials WHERE id=?").get(id) as { last_used: number }).last_used === previous) {
      assert.ok(Date.now() < deadline, "partial request must authenticate before revocation");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((await f.call(`devices/${id}`, undefined, { cookie: f.cookie }, "DELETE")).status, 200);
    finish(); await result;
    assert.equal(effects, 0, "extension must not commit after its credential is revoked");
    const layout = new AccessStore(f.path);
    try { assert.equal(layout.readLayout("primary").revision, 0, "layout must not commit after revocation"); }
    finally { layout.close(); }
  } finally { db.close(); await f.close(); }
});

test("extension authorization can fence a side effect after its own asynchronous work", async () => {
  let effects = 0;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(true, undefined, { extensions: [{ id: "fixture", routes: [{ id: "write",
    pattern: "/api/ext/fixture/write", methods: ["POST"], permission: "debug", async handle(ctx) {
      const body = await ctx.readJsonBody() as { defer: boolean };
      if (body.defer) { entered(); await pending; }
      ctx.assertAuthorized(); effects++; ctx.sendJson(200, { ok: true });
    }, }] }] });
  try {
    const { token, id } = await f.issue();
    const write = (defer: boolean) => fetch(`${f.base}/api/ext/fixture/write`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ defer }) });
    assert.equal((await write(false)).status, 200, "valid credential may commit an extension effect");
    effects = 0;
    const response = write(true).catch(() => undefined);
    await started;
    assert.equal((await f.call(`devices/${id}`, undefined, { cookie: f.cookie }, "DELETE")).status, 200);
    release(); await response;
    assert.equal(effects, 0, "custom awaits must retain the original device identity");
  } finally { release(); await f.close(); }
});

for (const multiUser of [false, true]) test(`pairing binds explicit consent and one credential in ${multiUser ? "principal" : "single-token"} mode`, async () => {
  const f = await fixture(multiUser);
  try {
    // Cheapest real HTTP transport probe: both current authentication paths arrive as the same principal.
    const bearer = { authorization: "Bearer primary-fixture" };
    const cookieStatus = await f.call("status", undefined, { cookie: f.cookie });
    const bearerStatus = await f.call("status", undefined, bearer);
    assert.equal(cookieStatus.body.authenticated, true);
    assert.deepEqual(cookieStatus.body.principal, bearerStatus.body.principal);
    const pair = await f.create();
    const bound = await f.claim(pair);
    const pending = await f.call("pairings/exchange", bound);
    assert.equal(pending.status, 400);
    assert.equal((await f.approve(pair, bound)).status, 200);
    assert.equal((await f.call("pairings/exchange", { ...bound, confirmed: false })).status, 400);
    const results = await Promise.all([f.call("pairings/exchange", bound), f.call("pairings/exchange", bound)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
    const issued = results.find(r => r.status === 200)!.body.data;
    const deviceAuth = { authorization: `Bearer ${issued.credential}` };
    assert.equal((await f.call("status", undefined, deviceAuth)).body.authenticated, true);
    const devices = await f.call("devices", undefined, deviceAuth);
    assert.equal(devices.body.data.can_manage, false);
    assert.equal(devices.body.data.devices.length, 1);
    assert.equal(devices.body.data.devices[0].expires_at - devices.body.data.devices[0].created, 30 * DAY);
    assert.equal(JSON.stringify(devices.body).includes(issued.credential), false);
    assert.equal(JSON.stringify(devices.body).includes("hash"), false);
    assert.equal((await f.call("pairings/exchange", bound)).body.error.message, pending.body.error.message);
    assert.equal((await f.call(`devices/${issued.id}`, undefined, { cookie: f.cookie }, "DELETE")).status, 200);
    assert.equal((await f.call("status", undefined, deviceAuth)).body.authenticated, false);
  } finally { await f.close(); }
});

test("device identity cannot escape through login, mixed credentials, pairing management or renewal", async () => {
  const f = await fixture(true);
  try {
    const { token, id } = await f.issue();
    const bearer = { authorization: `Bearer ${token}` };
    const login = await f.call("login", { token });
    const cookie = cookieFrom(login.response);
    const pair = await f.create();
    const bound = await f.claim(pair);
    for (const auth of [bearer, { cookie }, { ...bearer, cookie: f.cookie }]) {
      assert.equal((await f.call("pairings", {}, auth)).status, 403);
      assert.equal((await f.approve(pair, bound, auth)).status, 403);
      assert.equal((await f.call(`pairings/${pair.id}`, undefined, auth, "DELETE")).status, 403);
      assert.equal((await f.call(`devices/${id}/renew`, {}, auth)).status, 403);
    }
    const other = { cookie: await loginCookie(f.base, "other-fixture") };
    assert.equal((await f.approve(pair, bound, other)).status, 404);
    assert.equal((await f.call(`devices/${id}/renew`, {}, other)).status, 404);
    assert.equal((await f.call(`devices/${id}`, undefined, { cookie: f.cookie }, "DELETE")).status, 200);
    assert.equal((await f.call("status", undefined, { cookie })).body.authenticated, false);
    assert.equal((await f.call(`devices/${id}/renew`, {}, { cookie: f.cookie })).status, 404);
  } finally { await f.close(); }
});

test("browser expiry is server-authoritative, explicit Renew is audited and cannot resurrect expiry", async () => {
  const f = await fixture();
  try {
    const { id, result } = await f.issue("browser");
    assert.equal(result.body.data.credential, undefined);
    const cookie = cookieFrom(result.response);
    assert.match(result.response.headers.get("set-cookie")!, /HttpOnly;|; HttpOnly/);
    f.advance(29 * DAY);
    assert.equal((await f.call("status", undefined, { cookie })).body.authenticated, true);
    // Main bearer remains independent of the original 12-hour cookie expiry.
    const main = { authorization: "Bearer primary-fixture" };
    assert.equal((await f.call(`devices/${id}/renew`, {}, main)).status, 200);
    f.advance(2 * DAY);
    assert.equal((await f.call("status", undefined, { cookie })).body.authenticated, true);
    const db = new DatabaseSync(f.path);
    const audit = db.prepare("SELECT * FROM device_credential_audit").all();
    assert.equal(audit.length, 1);
    assert.equal(JSON.stringify(audit).includes(cookie.split("=")[1]!), false);
    db.close();
    f.advance(28 * DAY);
    assert.equal((await f.call("status", undefined, { cookie })).body.authenticated, false);
    assert.equal((await f.call(`devices/${id}/renew`, {}, main)).status, 404);
  } finally { await f.close(); }
});

test("expired, cancelled and unknown codes fail uniformly; malformed secret-bearing errors never reach logs", async () => {
  const f = await fixture(true);
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args.map(String).join(" ")); };
  try {
    const { token } = await f.issue();
    const pair = await f.create();
    const bound = await f.claim(pair);
    assert.equal((await f.approve(pair, bound)).status, 200);
    assert.equal((await f.call(`pairings/${pair.id}`, undefined, { cookie: f.cookie }, "DELETE")).status, 200);
    const revoked = await f.call("pairings/exchange", bound);
    const unknown = await f.call("pairings/exchange", { ...bound, code: "A".repeat(20) });
    assert.deepEqual(revoked.body, unknown.body);
    const expiredPair = await f.create();
    const expired = await f.claim(expiredPair);
    assert.equal((await f.approve(expiredPair, expired)).status, 200);
    f.advance(300_000);
    assert.deepEqual((await f.call("pairings/exchange", expired)).body, unknown.body);
    const response = await fetch(`${f.base}/api/auth/pairings/exchange`, { method: "POST",
      headers: { "content-type": "application/json" }, body: `{"code":"${pair.code}","verifier":"${bound.verifier}","credential":"${token}"` });
    const text = await response.text();
    const debug = await fetch(`${f.base}/api/debug/events`, { headers: { cookie: f.cookie } });
    assert.equal(debug.status, 200);
    const debugText = await debug.text();
    for (const secret of [pair.code, bound.verifier, token]) {
      assert.equal(text.includes(secret), false);
      assert.equal(logs.join(" ").includes(secret), false);
      assert.equal(debugText.includes(secret), false);
    }
    const db = new DatabaseSync(f.path);
    const rows = db.prepare("SELECT * FROM device_pairings").all();
    assert.equal(JSON.stringify(rows).includes(pair.code), false);
    assert.equal(JSON.stringify(rows).includes(bound.verifier), false);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM device_credentials").all()).includes(token), false);
    db.close();
  } finally { console.error = original; await f.close(); }
});

test("claims are immutable, sources are live, and foreign origins cannot claim or approve", async () => {
  const f = await fixture(true);
  try {
    const pair = await f.create();
    const bound = await f.claim(pair);
    const changed = await f.call("pairings/claim", { code: pair.code, name: "Other device", delivery: "native",
      challenge: createHash("sha256").update("different").digest("hex") });
    assert.equal(changed.status, 400);
    assert.equal((await f.call("pairings/claim", { code: pair.code }, { origin: "https://foreign.example.test" })).status, 403);
    assert.equal((await f.approve(pair, bound, { cookie: f.cookie, origin: "https://foreign.example.test" })).status, 403);
    assert.equal((await f.approve(pair, bound)).status, 200);
    const wrong = await f.call("pairings/exchange", { ...bound, verifier: randomBytes(32).toString("base64url") });
    assert.equal(wrong.status, 400);
    const otherCookie = await loginCookie(f.base, "other-fixture");
    assert.equal((await f.call("pairings/exchange", bound, { cookie: otherCookie })).status, 400);
    assert.equal((await f.call("logout", {}, { cookie: f.cookie })).status, 200);
    assert.equal((await f.call("pairings/exchange", bound)).status, 400, "logout invalidates the source of an approved request");
  } finally { await f.close(); }
});

test("address budgets count failed attempts without distinguishing existing and unknown codes", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 60; i++) assert.equal((await f.call("pairings/exchange", {
      code: "A".repeat(20), verifier: "x".repeat(43), principal: "legacy", challenge: "a".repeat(64),
      delivery: "native", origin: f.base, confirmed: true,
    })).status, 400);
    const limited = await f.call("pairings/claim", {});
    assert.equal(limited.status, 429);
    assert.equal(JSON.stringify(limited.body).includes("AAAAAAAA"), false);
    f.advance(60_000);
    assert.equal((await f.call("pairings/claim", {})).status, 400);
  } finally { await f.close(); }
});

test("concurrent revoke and Renew cannot resurrect a credential or write a failed renewal audit", async () => {
  const f = await fixture();
  try {
    const { token, id } = await f.issue();
    const main = { authorization: "Bearer primary-fixture" };
    const [renew, revoke] = await Promise.all([f.call(`devices/${id}/renew`, {}, main),
      f.call(`devices/${id}`, undefined, main, "DELETE")]);
    assert.equal(revoke.status, 200);
    assert.equal([200, 404].includes(renew.status), true);
    assert.equal((await f.call("status", undefined, { authorization: `Bearer ${token}` })).body.authenticated, false);
    assert.equal((await f.call(`devices/${id}/renew`, {}, main)).status, 404);
    const db = new DatabaseSync(f.path);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM device_credential_audit").get() as { n: number }).n,
      renew.status === 200 ? 1 : 0);
    db.close();
  } finally { await f.close(); }
});

for (const multiUser of [false, true]) test(`replacement retains device identity; main rotation invalidates it (${multiUser})`, async () => {
  const f = await fixture(multiUser);
  try {
    const { token, id, pair, bound } = await f.issue();
    const cookie = cookieFrom((await f.call("login", { token })).response);
    const db = new DatabaseSync(f.path);
    const stored = JSON.stringify(db.prepare("SELECT * FROM device_credentials").all());
    for (const secret of [token, pair.code, bound.verifier, "primary-fixture"]) assert.equal(stored.includes(secret), false);
    db.close();
    f.advance(1_000);
    await f.restart();
    assert.equal((await f.call("status", undefined, { cookie })).body.authenticated, true);
    const metadata = (await f.call("devices", undefined, { cookie })).body.data.devices[0];
    assert.equal(metadata.id, id);
    assert.equal(metadata.last_used > metadata.created, true);
    assert.equal(metadata.expires_at - metadata.created, 30 * DAY, "reads and restart never renew authorization");
    await f.restart("replacement-fixture");
    assert.equal((await f.call("status", undefined, { cookie })).body.authenticated, false);
    assert.equal((await f.call("status", undefined, { authorization: `Bearer ${token}` })).body.authenticated, false);
    assert.equal((await f.call("status", undefined, { authorization: "Bearer replacement-fixture" })).body.authenticated, true);
  } finally { await f.close(); }
});

test("pairing is unavailable in no-auth mode and TTL configuration is bounded", async () => {
  for (const value of ["0", "59", "601", "1.5", "not-a-number"])
    assert.throws(() => loadConfig({ AGENT_CONSOLE_NO_AUTH: "1", AGENT_CONSOLE_PAIRING_TTL_SECONDS: value }));
  const config = loadConfig({ AGENT_CONSOLE_NO_AUTH: "1", AGENT_CONSOLE_PAIRING_TTL_SECONDS: "60" });
  assert.equal(config.pairingTtlMs, 60_000);
  const edge = createEdgeServer(config);
  const { base } = await listenOnLoopback(edge);
  try {
    assert.equal((await (await fetch(`${base}/api/auth/status`)).json()).authenticated, true);
    for (const route of ["pairings", "devices"])
      assert.equal((await fetch(`${base}/api/auth/${route}`)).status, 404);
  } finally { edge.closeAllConnections(); await new Promise<void>(resolve => edge.close(() => resolve())); }
});

for (const multiUser of [false, true]) test(`selective revocation closes live SSE/WS and denies tickets, writes and image downloads (${multiUser})`, { timeout: 10_000 }, async () => {
  let writes = 0;
  let imageStarted: () => void = () => {};
  let releaseImage: () => void = () => {};
  const imageReady = new Promise<void>(resolve => { imageStarted = resolve; });
  const imageRelease = new Promise<void>(resolve => { releaseImage = resolve; });
  const daemon = createServer(async (req, res) => {
    if (req.url?.includes("/images/")) {
      imageStarted(); await imageRelease;
      res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from([137, 80, 78, 71])); return;
    }
    if (req.method === "POST") writes++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, data: req.url === "/sessions"
      ? { sessions: [{ id: "fixture-session", session_incarnation: "fixture-inc", agent: "codex", status: "running" }] }
      : {} }));
  });
  const upstreamSockets = new Set<import("node:net").Socket>();
  daemon.on("connection", socket => { upstreamSockets.add(socket); socket.once("close", () => upstreamSockets.delete(socket)); });
  daemon.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const address = await listenOnLoopback(daemon);
  const f = await fixture(multiUser, address.base);
  const clientSockets = new Set<import("node:net").Socket>();
  const upgrade = async (path: string, cookie?: string) => {
    let timedOut = false;
    const socket = connect(Number(new URL(f.base).port), "127.0.0.1");
    clientSockets.add(socket);
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    socket.setTimeout(2500, () => { timedOut = true; socket.destroy(); });
    let bytes = "";
    const status = await new Promise<number>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${new URL(f.base).host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n${cookie ? `Cookie: ${cookie}\r\n` : ""}\r\n`));
      socket.on("data", chunk => { bytes += chunk.toString(); if (bytes.includes("\r\n\r\n")) resolve(Number(bytes.split(" ")[1])); });
      socket.once("close", () => { if (!bytes) reject(new Error("upgrade closed without a response")); });
    });
    return { status, closed, timedOut: () => timedOut };
  };
  try {
    const first = await f.issue();
    const second = await f.issue();
    const auth = { authorization: `Bearer ${first.token}` };
    const login = await f.call("login", { token: first.token });
    const cookie = cookieFrom(login.response);
    const target = "/api/sessions/fixture/fixture-session";
    const ticketResponse = await fetch(`${f.base}${target}/attach-ticket`, { method: "POST", headers: auth });
    assert.equal(ticketResponse.status, 200);
    const ticket = (await ticketResponse.json() as Data).data.ticket;
    const active = await upgrade(`${target}/attach`, cookie);
    assert.equal(active.status, 101);
    const signal = AbortSignal.timeout(4000);
    const stream = await fetch(`${f.base}/api/resources/events?resources=sessions`, { headers: auth, signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    assert.equal((await reader.read()).done, false);
    const image = fetch(`${f.base}/api/history/sessions/fixture/history/images/${"a".repeat(16)}.0.0.${"b".repeat(32)}`, { headers: auth })
      .then(async response => ({ status: response.status, body: await response.text() })).catch(() => null);
    await imageReady;
    const sent = await fetch(`${f.base}${target}/send`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    assert.equal(sent.status, 200);
    const before = writes;
    assert.equal((await f.call(`devices/${first.id}`, undefined, { cookie: f.cookie }, "DELETE")).status, 200);
    releaseImage();
    assert.notEqual((await image)?.status, 200, "revoked in-flight download cannot deliver bytes");
    await active.closed;
    assert.equal(active.timedOut(), false, "live WS closes due to revocation before its fixture timeout");
    try { while (!(await reader.read()).done) { /* drain already buffered pre-revocation frames */ } }
    catch { assert.equal(signal.aborted, false); }
    assert.equal((await upgrade(`${target}/attach?ticket=${ticket}`)).status, 401);
    assert.equal((await fetch(`${f.base}${target}/send`, { method: "POST", headers: auth })).status, 401);
    assert.equal(writes, before);
    assert.equal((await f.call("status", undefined, { authorization: `Bearer ${second.token}` })).body.authenticated, true);
    assert.equal((await f.call("status", undefined, { cookie: f.cookie })).body.authenticated, true);
  } finally {
    releaseImage();
    for (const socket of clientSockets) socket.destroy();
    await f.close();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise<void>(resolve => daemon.close(() => resolve()));
  }
});
