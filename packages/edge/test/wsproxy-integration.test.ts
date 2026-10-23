import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import net from "node:net";
import { createEdgeServer } from "../src/server.ts";
import { MachineHealth } from "../src/machineHealth.ts";
import { listenOnLoopback, loginCookie, makeEdgeConfig } from "./support.ts";

// A fake daemon: records the upstream handshake and replies 101 WITHOUT a
// subprotocol (like agent-session serve, which never sees the client token). The
// edge must inject the echoed subprotocol for the device path.
let daemonReceived = "";
const daemon = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString();
    if (buf.includes("\r\n\r\n") && daemonReceived === "") {
      daemonReceived = buf;
      sock.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: testaccept=\r\n\r\n",
      );
    }
  });
  sock.on("error", () => {});
});

let server: ReturnType<typeof createEdgeServer>;
let edgePort = 0;
let daemonPort = 0;

before(async () => {
  daemonPort = (await listenOnLoopback(daemon)).port;
  const config = makeEdgeConfig({
    clientToken: "client-secret",
    machines: [{ name: "wsm", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
    uiDir: "/tmp",
    openAccess: false,
  });
  server = createEdgeServer(config);
  edgePort = (await listenOnLoopback(server)).port;
});
after(() => {
  server.close();
  daemon.close();
});

// Send a raw upgrade to the edge and return the full response head it writes back.
function upgrade(path: string, extraHeaders: string, port = edgePort, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
          extraHeaders +
          `\r\n`,
      );
    });
    let buf = "";
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(buf);
    };
    s.setTimeout(timeoutMs);
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n")) fin();
    });
    s.on("timeout", fin);
    s.on("close", fin);
    s.on("error", fin);
  });
}

async function login(): Promise<string> {
  return loginCookie(`http://127.0.0.1:${edgePort}`);
}

test("device upgrade (subprotocol auth, foreign Origin) -> 101 with the subprotocol echoed", async () => {
  daemonReceived = "";
  const head = await upgrade(
    "/api/sessions/wsm/x/attach",
    "Origin: http://tauri.localhost\r\nSec-WebSocket-Protocol: ac-token.client-secret\r\n",
  );
  assert.match(head, /HTTP\/1\.1 101/); // Origin exemption + subprotocol auth both pass
  assert.match(head, /Sec-WebSocket-Protocol: ac-token\.client-secret/); // echoed for the WebView
  // the daemon received the machine bearer, never the client token subprotocol
  assert.match(daemonReceived, /Authorization: Bearer machine-secret/);
  assert.doesNotMatch(daemonReceived, /ac-token/);
});

test("device upgrade with base64url token subprotocol supports separator characters", async () => {
  const encoded = Buffer.from("client:secret", "utf8").toString("base64url");
  const colonTokenServer = createEdgeServer(makeEdgeConfig({
    clientToken: "client:secret",
    machines: [{ name: "wsm", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
    uiDir: "/tmp",
    openAccess: false,
  }));
  const { port } = await listenOnLoopback(colonTokenServer);
  try {
    daemonReceived = "";
    const head = await upgrade(
      "/api/sessions/wsm/x/attach",
      `Origin: http://tauri.localhost\r\nSec-WebSocket-Protocol: ac-token-b64.${encoded}\r\n`,
      port,
    );
    assert.match(head, /HTTP\/1\.1 101/);
    assert.match(head, new RegExp(`\\r\\nSec-WebSocket-Protocol: ac-token-b64\\.${encoded}\\r\\n`));
    assert.match(daemonReceived, /Authorization: Bearer machine-secret/);
    assert.doesNotMatch(daemonReceived, /client:secret/);
    assert.doesNotMatch(daemonReceived, /ac-token-b64/);
  } finally {
    colonTokenServer.close();
  }
});

test("browser upgrade (cookie) -> 101 with NO injected subprotocol (byte-transparent relay)", async () => {
  daemonReceived = "";
  const cookie = await login();
  const head = await upgrade("/api/sessions/wsm/x/attach", `Cookie: ${cookie}\r\n`);
  assert.match(head, /HTTP\/1\.1 101/);
  assert.doesNotMatch(head, /Sec-WebSocket-Protocol/); // browser path injects nothing
});

test("an attach to a machine whose attach breaker is open is refused before any upstream connect", async () => {
  const attachHealth = new MachineHealth();
  attachHealth.recordFailure("wsm", 3000); // an earlier attach connect stalled
  const gatedServer = createEdgeServer(makeEdgeConfig({
    clientToken: "client-secret",
    machines: [{ name: "wsm", url: `http://127.0.0.1:${daemonPort}`, token: "machine-secret" }],
    uiDir: "/tmp",
    openAccess: false,
  }), { attachHealth });
  const { port } = await listenOnLoopback(gatedServer);
  try {
    daemonReceived = "";
    const head = await upgrade(
      "/api/sessions/wsm/x/attach",
      "Origin: http://tauri.localhost\r\nSec-WebSocket-Protocol: ac-token.client-secret\r\n",
      port,
    );
    assert.match(head, /HTTP\/1\.1 503/);
    assert.equal(daemonReceived, "", "a refused attach must not reach the daemon");
  } finally {
    gatedServer.close();
  }
});

test("a stalled attach connect opens the server's attach breaker, so the next attach is refused at once", async () => {
  // An https machine whose port accepts and never answers: the TLS handshake
  // never completes, so the upstream connect stalls on loopback.
  let stalledConnections = 0;
  const stalled = net.createServer((sock) => {
    stalledConnections += 1;
    sock.on("error", () => {});
  });
  const stalledPort = (await listenOnLoopback(stalled)).port;
  const stalledServer = createEdgeServer(makeEdgeConfig({
    clientToken: "client-secret",
    machines: [{ name: "wsm", url: `https://127.0.0.1:${stalledPort}`, token: "machine-secret" }],
    uiDir: "/tmp",
    openAccess: false,
  }));
  const { port } = await listenOnLoopback(stalledServer);
  const headers = "Origin: http://tauri.localhost\r\nSec-WebSocket-Protocol: ac-token.client-secret\r\n";
  try {
    const started = Date.now();
    const first = await upgrade("/api/sessions/wsm/x/attach", headers, port, 8000);
    const firstAttachMs = Date.now() - started;
    assert.equal(first, "", "a stalled attach ends without a response head");
    assert.ok(firstAttachMs >= 2500 && firstAttachMs < 5000, `connect deadline took ${firstAttachMs} ms`);

    const second = await upgrade("/api/sessions/wsm/x/attach", headers, port);
    assert.match(second, /HTTP\/1\.1 503/);
    assert.equal(stalledConnections, 1, "the refused attach must not open a second upstream connection");
  } finally {
    stalledServer.close();
    stalled.close();
  }
});
