import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const edgeRoot = new URL("../", import.meta.url);

test("startEdge serves health and the configured UI directory", async () => {
  const { startEdge } = await import("../src/start.ts");
  const ui = mkdtempSync(join(tmpdir(), "edge-start-ui-"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>dist-probe</title>");
  const server = startEdge({ AGENT_CONSOLE_NO_AUTH: "1", AGENT_CONSOLE_EDGE_PORT: "0", AGENT_CONSOLE_UI_DIR: ui });
  try {
    if (!server.listening) await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /dist-probe/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(ui, { recursive: true, force: true });
  }
});

test("startEdge serves the routes of the edge extensions it is given (#918)", async () => {
  const { startEdge } = await import("../src/start.ts");
  const server = startEdge({ AGENT_CONSOLE_NO_AUTH: "1", AGENT_CONSOLE_EDGE_PORT: "0" }, {
    extensions: [{ id: "probe", permissions: ["probe_read"], routes: [{ id: "ping", pattern: "/api/ext/probe/ping", methods: ["GET"], permission: "probe_read",
      handle: ({ sendJson }) => sendJson(200, { ok: true, data: "pong" }) }] }],
  });
  try {
    if (!server.listening) await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/ext/probe/ping`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: "pong" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("startEdge accepts principals that hold an extension's declared permission (#918)", async () => {
  const { startEdge } = await import("../src/start.ts");
  const dir = mkdtempSync(join(tmpdir(), "edge-start-ext-"));
  const server = startEdge({
    AGENT_CONSOLE_EDGE_PORT: "0", AGENT_CONSOLE_STATE_DB: join(dir, "state.sqlite"),
    AGENT_CONSOLE_PRINCIPALS: JSON.stringify([{ id: "owner", token: "owner-token", machines: [], permissions: ["probe_read"] }]),
  }, {
    extensions: [{ id: "probe", permissions: ["probe_read"], routes: [{ id: "ping", pattern: "/api/ext/probe/ping", methods: ["GET"], permission: "probe_read",
      handle: ({ sendJson, principal }) => sendJson(200, { ok: true, data: principal.id }) }] }],
  });
  try {
    if (!server.listening) await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/ext/probe/ping`, { headers: { authorization: "Bearer owner-token" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: "owner" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the core edge entry delegates to startEdge with the process environment", () => {
  const index = readFileSync(new URL("src/index.ts", edgeRoot), "utf8");
  assert.match(index, /import \{ startEdge \} from "\.\/start\.ts";/);
  assert.match(index, /^startEdge\(process\.env\);$/m);
});

test("the edge package exports its start entry for distribution entries", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", edgeRoot), "utf8")) as { exports?: Record<string, { source: string }> };
  assert.equal(manifest.exports?.["./start"]?.source, "./src/start.ts");
});
