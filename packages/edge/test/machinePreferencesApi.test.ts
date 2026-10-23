import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEdgeServer } from "../src/server.ts";
import { makeEdgeConfig, listenOnLoopback, loginCookie } from "./support.ts";

async function withPreferences(run: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "agent-console-machine-prefs-"));
  const server = createEdgeServer(makeEdgeConfig({ multiUser: true, openAccess: false, accessDbPath: join(dir, "state.sqlite"),
    principals: [
      { id: "fixture-owner", token: "owner-fixture-token", machines: ["fixture-a"], permissions: [] },
      { id: "fixture-other", token: "other-fixture-token", machines: ["fixture-b"], permissions: [] },
    ], machines: [
      { name: "fixture-a", url: "http://127.0.0.1:9", token: "daemon-fixture-a" },
      { name: "fixture-b", url: "http://127.0.0.1:9", token: "daemon-fixture-b" },
    ] }));
  const { base } = await listenOnLoopback(server);
  try { await run(base); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
}

const auth = { authorization: "Bearer owner-fixture-token" };

test("initialization-only API seeds an absent value and rejects overwriting an existing account value", async () => {
  await withPreferences(async base => {
    const put = (body: unknown) => fetch(`${base}/api/machine-preferences/fixture-a`, { method: "PUT",
      headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await put({ enabled: false, reason: "Device migration", initialize_only: true })).status, 200);
    assert.equal((await put({ enabled: true, reason: "Stale device migration", initialize_only: true })).status, 409);
    assert.equal((await put({ enabled: true, reason: "Invalid option", initialize_only: false })).status, 400);
    const current = await fetch(`${base}/api/machine-preferences`, { headers: auth });
    const row = (await current.json()).data.machines[0];
    assert.equal(row.enabled, false); assert.equal(row.last_change.revision, 1);
    assert.equal((await put({ enabled: true, reason: "Explicit manual restoration" })).status, 200);
  });
});
test("authenticated machine preferences expose only the caller's granted hosts", async () => {
  await withPreferences(async base => {
    const response = await fetch(`${base}/api/machine-preferences`, { headers: auth });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.machines, [{ name: "fixture-a", enabled: true, active: true, last_change: null }]);
  });
});

test("manual disable requires a reason and exposes a caller-bound audit receipt", async () => {
  await withPreferences(async base => {
    const response = await fetch(`${base}/api/machine-preferences/fixture-a`, { method: "PUT",
      headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ enabled: false, reason: "Planned maintenance" }) });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.machine.enabled, false);
    assert.equal(data.machine.last_change.actor, "principal:fixture-owner");
    assert.equal(data.machine.last_change.reason, "Planned maintenance");
    assert.ok(Number.isFinite(Date.parse(data.machine.last_change.at)));
    const again = await fetch(`${base}/api/machine-preferences`, { headers: auth });
    assert.equal((await again.json()).data.machines[0].enabled, false);
  });
});

test("preferences preserve auth, CSRF and machine grants and reject forged actors", async () => {
  await withPreferences(async base => {
    assert.equal((await fetch(`${base}/api/machine-preferences`)).status, 401);
    const put = (machine: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/api/machine-preferences/${machine}`, {
      method: "PUT", headers: { ...auth, "content-type": "application/json", ...extra }, body: JSON.stringify(body),
    });
    assert.equal((await put("fixture-b", { enabled: false, reason: "Not granted" })).status, 403);
    assert.equal((await put("fixture-a", { enabled: false })).status, 400);
    assert.equal((await put("fixture-a", { enabled: false, reason: " " })).status, 400);
    assert.equal((await put("fixture-a", { enabled: false, reason: "Valid reason", actor: "forged" })).status, 400);
    assert.equal((await put("fixture-a", { enabled: false, reason: "Cross-origin" }, { origin: "https://foreign.example.test" })).status, 403);
  });
});

test("one client's disable applies to another client's session poll, without changing another principal", async () => {
  await withPreferences(async base => {
    const cookie = await loginCookie(base, "owner-fixture-token");
    const put = await fetch(`${base}/api/machine-preferences/fixture-a`, { method: "PUT",
      headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ enabled: false, reason: "Shared maintenance" }) });
    assert.equal(put.status, 200);
    const poll = await fetch(`${base}/api/sessions?machines=fixture-a`, { headers: { cookie } });
    const { data } = await poll.json();
    assert.deepEqual(data.machines, [{ name: "fixture-a", ok: false, active: false }]);
    const other = await fetch(`${base}/api/machine-preferences`, { headers: { authorization: "Bearer other-fixture-token" } });
    assert.equal((await other.json()).data.machines[0].enabled, true);
    const enable = await fetch(`${base}/api/machine-preferences/fixture-a`, { method: "PUT",
      headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ enabled: true, reason: "Maintenance completed" }) });
    assert.equal(enable.status, 200);
    const restored = await fetch(`${base}/api/machine-preferences`, { headers: { cookie } });
    assert.equal((await restored.json()).data.machines[0].enabled, true);
  });
});

test("an existing session resource subscription observes another client's manual change", async () => {
  await withPreferences(async base => {
    const control = new AbortController();
    const timeout = setTimeout(() => control.abort(), 12_000);
    try {
      const response = await fetch(`${base}/api/resources/events?resources=sessions&machines=fixture-a`, {
        headers: auth, signal: control.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      let buffer = "";
      const nextRevision = async () => {
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const line = frame.split("\n").find(value => value.startsWith("data: "));
            if (line) return JSON.parse(line.slice(6));
          } else {
            const chunk = await reader.read(); assert.equal(chunk.done, false);
            buffer += new TextDecoder().decode(chunk.value);
          }
        }
      };
      const before = await nextRevision();
      const cookie = await loginCookie(base, "owner-fixture-token");
      const changed = await fetch(`${base}/api/machine-preferences/fixture-a`, { method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, reason: "Maintenance from another client" }) });
      assert.equal(changed.status, 200);
      const after = await nextRevision();
      assert.equal(after.type, "changed");
      assert.ok(after.revision > before.revision);
      assert.deepEqual(Object.keys(after).sort(), ["resource", "revision", "schema_version", "type"]);
      await reader.cancel();
    } finally { clearTimeout(timeout); control.abort(); }
  });
});

// #1003: the Android and macOS apps send their token with the app-shell
// Origin. Like every other state-changing route, a token-authenticated save
// is not a CSRF risk; an ambient cookie from a foreign origin still is.
test("#1003 the native app saves a host preference with its token and app-shell origin", async () => {
  await withPreferences(async base => {
    const response = await fetch(`${base}/api/machine-preferences/fixture-a`, { method: "PUT",
      headers: { ...auth, origin: "http://tauri.localhost", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, reason: "Retired hardware" }) });
    assert.equal(response.status, 200, await response.text());
    const again = await fetch(`${base}/api/machine-preferences`, { headers: auth });
    assert.equal((await again.json()).data.machines[0].enabled, false);
  });
});
test("#1003 a cookie save from a foreign origin is still refused", async () => {
  await withPreferences(async base => {
    const cookie = await loginCookie(base, "owner-fixture-token");
    const response = await fetch(`${base}/api/machine-preferences/fixture-a`, { method: "PUT",
      headers: { cookie, origin: "https://foreign.example", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, reason: "Forged" }) });
    assert.equal(response.status, 403);
    const current = await fetch(`${base}/api/machine-preferences`, { headers: auth });
    assert.equal((await current.json()).data.machines[0].enabled, true);
  });
});
