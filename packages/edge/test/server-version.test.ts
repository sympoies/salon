import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback } from "./support.ts";

test("server version reports configured values only to authenticated readers", async () => {
  for (const configured of [true, false]) {
    const config = loadConfig({ AGENT_CONSOLE_TOKEN: "fixture-token", ...(configured ? { AGENT_CONSOLE_SERVER_VERSION: "1.2.3", AGENT_CONSOLE_SERVER_BUILD: "abc123" } : {}) });
    const server = createEdgeServer(config);
    const { base } = await listenOnLoopback(server);
    try {
      assert.equal((await fetch(`${base}/api/server-version`)).status, 401);
      const response = await fetch(`${base}/api/server-version`, { headers: { authorization: "Bearer fixture-token" } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), configured ? { version: "1.2.3", build: "abc123" } : {});
    } finally { server.close(); }
  }
});
