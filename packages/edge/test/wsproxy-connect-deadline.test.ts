import { strict as assert } from "node:assert";
import { test } from "node:test";
import net from "node:net";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { MachineHealth } from "../src/machineHealth.ts";
import { proxyUpgrade } from "../src/wsproxy.ts";

const request = { headers: {}, rawHeaders: [] } as unknown as IncomingMessage;

test("a stalled upstream connect ends the attach at the deadline and opens the attach breaker", async () => {
  const health = new MachineHealth({ stallMs: 10 });
  const client = new PassThrough();
  const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  const started = Date.now();

  proxyUpgrade(
    request,
    client,
    Buffer.alloc(0),
    { name: "mesa", url: "http://127.0.0.1:9", token: "machine-secret" },
    "/sessions/x/attach",
    // A socket that never connects, like a black-holed network SYN.
    { health, connectTimeoutMs: 40, connect: () => new net.Socket() },
  );

  await closed;
  assert.ok(Date.now() - started < 2000, "the attach must end at the connect deadline");
  assert.equal(health.shouldProbe("mesa"), false);
});
