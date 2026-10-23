// The WS attach proxy must speak TLS to an https-fronted machine (e.g. the mesa
// laptop behind a TLS reverse proxy on port 443). Before the fix, proxyUpgrade used a
// raw plaintext net.connect, so an https upstream got a plaintext HTTP upgrade
// on its TLS port and never completed the handshake.
//
// A throwaway self-signed cert is generated at runtime (never committed), so the
// test process disables TLS peer verification; production keeps verification on
// (the reverse proxy presents a valid server certificate).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { strict as assert } from "node:assert";
import { test, before, after } from "node:test";
import tls from "node:tls";
import net from "node:net";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createEdgeServer } from "../src/server.ts";
import { listenOnLoopback, makeEdgeConfig } from "./support.ts";

// Generate a self-signed localhost cert+key in a temp dir via openssl. Returns
// null if openssl is unavailable so the test skips rather than fails.
function makeSelfSigned(): { key: Buffer; cert: Buffer; dir: string } | null {
  try {
    const dir = mkdtempSync(join(os.tmpdir(), "ac-tls-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
      "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")), dir };
  } catch {
    return null;
  }
}

const material = makeSelfSigned();

let daemonReceived = "";
let tlsDaemon: tls.Server | undefined;
let server: ReturnType<typeof createEdgeServer> | undefined;
let edgePort = 0;
let tlsPort = 0;

before(async () => {
  if (!material) return;
  tlsDaemon = tls.createServer({ key: material.key, cert: material.cert }, (sock) => {
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
  tlsPort = (await listenOnLoopback(tlsDaemon)).port;
  const config = makeEdgeConfig({
    clientToken: "client-secret",
    // https:// upstream — the edge must TLS-connect, not plaintext.
    machines: [{ name: "mesa", url: `https://localhost:${tlsPort}`, token: "machine-secret" }],
    uiDir: "/tmp",
    openAccess: false,
  });
  server = createEdgeServer(config);
  edgePort = (await listenOnLoopback(server)).port;
});
after(() => {
  server?.close();
  tlsDaemon?.close();
  if (material) rmSync(material.dir, { recursive: true, force: true });
});

function upgrade(path: string, extraHeaders: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(edgePort, "127.0.0.1", () => {
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${edgePort}\r\n` +
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
    s.setTimeout(3000);
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n")) fin();
    });
    s.on("timeout", fin);
    s.on("close", fin);
    s.on("error", fin);
  });
}

test("device attach to an https machine completes the TLS upgrade -> 101", { skip: !material ? "openssl unavailable" : false }, async () => {
  daemonReceived = "";
  const head = await upgrade(
    "/api/sessions/mesa/x/attach",
    "Origin: http://tauri.localhost\r\nSec-WebSocket-Protocol: ac-token.client-secret\r\n",
  );
  assert.match(head, /HTTP\/1\.1 101/);
  assert.match(head, /Sec-WebSocket-Protocol: ac-token\.client-secret/);
  // The TLS daemon received the injected machine bearer, never the client token.
  assert.match(daemonReceived, /Authorization: Bearer machine-secret/);
  assert.doesNotMatch(daemonReceived, /ac-token/);
});
