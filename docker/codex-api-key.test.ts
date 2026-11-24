import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

// Run inside a fresh disposable Salon image with --network none.
test("managed Codex accepts initial and Conversation prompts with API-key auth", { timeout: 60_000 }, async t => {
  assert.ok(Object.values(networkInterfaces()).every(addresses => addresses?.every(address => address.internal)),
    "run the synthetic API-key test with networking disabled");
  const auth = join(process.env.CODEX_HOME!, "auth.json");
  await writeFile(auth, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic-offline" }),
    { mode: 0o600, flag: "wx" });
  t.after(() => unlink(auth));

  let providerReached = false;
  const provider = createServer((req, res) => {
    if (req.url?.split("?")[0] === "/v1/responses") providerReached = true;
    req.resume();
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Synthetic provider unavailable" } }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => {
    const closed = once(provider, "close");
    provider.close();
    provider.closeAllConnections();
    await closed;
  });
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const providerOrigin = `http://127.0.0.1:${address.port}`;
  const configPath = join(process.env.CODEX_HOME!, "config.toml");
  const config = await readFile(configPath, "utf8");
  t.after(() => writeFile(configPath, config));
  await writeFile(configPath,
    `openai_base_url = "${providerOrigin}/v1"\nchatgpt_base_url = "${providerOrigin}/chatgpt"\n\n${config}`);

  const origin = "http://127.0.0.1:3000";
  const token = (await readFile(join(process.env.XDG_STATE_HOME!, "salon/browser-token"), "utf8")).trim();
  const json = { origin, "content-type": "application/json" };
  const login = await fetch(origin + "/api/auth/login", {
    method: "POST", headers: json, body: JSON.stringify({ token }), signal: AbortSignal.timeout(5_000),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0]?.split(";", 1)[0];
  assert.ok(cookie);
  await login.arrayBuffer();

  const request = async (path: string, method = "GET", body?: object) => {
    const response = await fetch(origin + path, {
      method,
      headers: { ...json, cookie, "x-console-expected-principal": "legacy" },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json() };
  };

  const created = await request("/api/sessions/workspace", "POST", { agent: "codex" });
  assert.equal(created.status, 200, created.body.error?.code);
  const { id, session_incarnation: incarnation } = created.body.data.session;
  assert.ok(id && incarnation, "create returns the exact session incarnation");
  const path = "/api/sessions/workspace/" + encodeURIComponent(id);

  const initial = await request(path + "/prompt/v2", "POST", {
    text: "Synthetic initial prompt", expected_session_incarnation: incarnation,
  });
  const intent = randomUUID();
  const outboxPath = path + "/outbox/" + intent;
  const admission = await request(outboxPath, "PUT", {
    text: "Synthetic Conversation reply", expected_session_incarnation: incarnation,
  });
  assert.equal(admission.status, 201, admission.body.error?.code);

  const deadline = Date.now() + 20_000;
  let reply = admission.body.data.item;
  while (Date.now() < deadline && (reply.state === "queued" || reply.state === "sending")) {
    await delay(250);
    const snapshot = await request(outboxPath + "?expected_session_incarnation=" + encodeURIComponent(incarnation));
    assert.equal(snapshot.status, 200, snapshot.body.error?.code);
    reply = snapshot.body.data.item;
  }

  const outcomes = {
    initial: [initial.status, initial.body.data?.submitted ?? initial.body.error?.code],
    reply: [reply.state, reply.receipt?.outcome ?? reply.error_code, reply.receipt?.code ?? null],
  };
  assert.deepEqual(outcomes, { initial: [200, true], reply: ["submitted", "submitted", null] });
  const providerDeadline = Date.now() + 5_000;
  while (!providerReached && Date.now() < providerDeadline) await delay(50);
  assert.ok(providerReached, "Codex reached the loopback provider");
});
