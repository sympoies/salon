import net from "node:net";
import tls from "node:tls";
import type { IncomingMessage } from "node:http";
import { Transform, type Duplex } from "node:stream";
import type { MachineConfig } from "./config.ts";
import type { MachineHealth } from "./machineHealth.ts";
import { WS_TOKEN_PROTO_B64_PREFIX, WS_TOKEN_PROTO_PREFIX, wsProtocolEcho } from "./auth.ts";

// Only these request headers are relayed to the daemon; everything else
// (the browser Cookie, the browser Authorization, the client-facing Host) is dropped.
const FORWARD = new Set([
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
]);

export interface HandshakeInput {
  readonly daemonPath: string;
  readonly daemonHost: string;
  readonly rawHeaders: readonly string[];
  readonly token: string;
}

// Drop `ac-token.*` entries from a Sec-WebSocket-Protocol value; returns the
// remaining list, or null if none remain. The daemon must never see the client
// token, so the edge strips it before forwarding.
export function stripTokenProtocol(value: string): string | null {
  const kept = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "" && !p.startsWith(WS_TOKEN_PROTO_PREFIX) && !p.startsWith(WS_TOKEN_PROTO_B64_PREFIX));
  return kept.length ? kept.join(", ") : null;
}

// Build the HTTP/1.1 upgrade request sent to the daemon. The browser cannot set
// an Authorization header on a WebSocket, so the edge injects the machine bearer
// token here (and never puts it in the ws:// URL). The client-token subprotocol
// is stripped so it never reaches the daemon. Otherwise a byte-transparent relay:
// the Sec-WebSocket-Key/Accept handshake stays end-to-end browser<->daemon.
export function buildUpstreamHandshake(input: HandshakeInput): string {
  const lines = [`GET ${input.daemonPath} HTTP/1.1`, `Host: ${input.daemonHost}`];
  for (let i = 0; i + 1 < input.rawHeaders.length; i += 2) {
    const name = (input.rawHeaders[i] as string).toLowerCase();
    let value = input.rawHeaders[i + 1] as string;
    if (!FORWARD.has(name)) {
      continue;
    }
    if (name === "sec-websocket-protocol") {
      const stripped = stripTokenProtocol(value);
      if (stripped === null) {
        continue; // only the token subprotocol was offered -> drop the header
      }
      value = stripped;
    }
    lines.push(`${input.rawHeaders[i]}: ${value}`);
  }
  lines.push(`Authorization: Bearer ${input.token}`);
  return lines.join("\r\n") + "\r\n\r\n";
}

// Insert a Sec-WebSocket-Protocol header into a 101 response head so a WebView
// that offered the token subprotocol sees it echoed (else it fails the
// handshake). No-op if not a 101 or a subprotocol header is already present.
export function injectResponseSubprotocol(head: string, proto: string): string {
  if (!/^HTTP\/1\.1 101/i.test(head)) {
    return head;
  }
  if (/\r\nSec-WebSocket-Protocol:/i.test(head)) {
    return head;
  }
  const idx = head.indexOf("\r\n\r\n");
  if (idx < 0) {
    return head;
  }
  return `${head.slice(0, idx)}\r\nSec-WebSocket-Protocol: ${proto}${head.slice(idx)}`;
}

// Upstream connect deadline: a daemon host that black-holes SYNs must not leave
// a half-open upstream until the OS default (~2min). It matches the session-list
// probe, so an attach does not wait longer than the poll that calls a machine
// unreachable.
const CONNECT_TIMEOUT_MS = 3_000;

interface UpstreamTarget {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
}

export interface ProxyUpgradeOptions {
  // Attach reachability breaker: a connect that stalls to the deadline opens it,
  // so the caller can refuse the next attaches without holding their handshake.
  readonly health?: MachineHealth;
  // Managed tester credentials are revocable while a relay is established.
  readonly isAuthorized?: () => boolean;
  readonly connectTimeoutMs?: number;
  readonly connect?: (target: UpstreamTarget, onConnect: () => void) => net.Socket;
}

// An HTTPS machine (for example, a laptop behind a TLS reverse proxy)
// terminates TLS, so the attach relay must TLS-connect; a raw plaintext socket
// to its TLS port never completes the handshake. A loopback http daemon (the
// hub's serve) stays a plain TCP connect. SNI is set so the upstream's
// certificate validates against its configured host name.
function connectUpstream(target: UpstreamTarget, onConnect: () => void): net.Socket {
  return target.tls
    ? tls.connect({ host: target.host, port: target.port, servername: target.host }, onConnect)
    : net.connect({ host: target.host, port: target.port }, onConnect);
}

function hostPort(url: string): UpstreamTarget {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  const port = u.port ? Number(u.port) : secure ? 443 : 80;
  return { host: u.hostname, port, tls: secure };
}

// Relay a browser/WebView WebSocket upgrade to a machine's daemon attach
// endpoint, injecting that machine's bearer token. The browser cookie path is a
// pure byte relay; a device client that authenticated via the token subprotocol
// additionally gets that subprotocol echoed on the 101.
export function proxyUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  machine: MachineConfig,
  daemonPath: string,
  options: ProxyUpgradeOptions = {},
): void {
  const target = hostPort(machine.url);
  const { host, port } = target;
  const echoProto = wsProtocolEcho(req.headers["sec-websocket-protocol"]) ?? null;
  const health = options.health;
  const connectStartedAt = health?.now() ?? 0;

  const relay = () => {
    if (!options.isAuthorized) {
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      return;
    }
    const gate = () => new Transform({ transform(chunk, _encoding, callback) {
      if (!options.isAuthorized!()) { teardown(); callback(); return; }
      callback(null, chunk);
    } });
    const inbound = gate();
    const outbound = gate();
    upstream.pipe(inbound).pipe(clientSocket);
    clientSocket.pipe(outbound).pipe(upstream);
    clientSocket.once("close", () => { inbound.destroy(); outbound.destroy(); });
  };

  const onConnect = () => {
    if (options.isAuthorized && !options.isAuthorized()) { teardown(); return; }
    upstream.setTimeout(0); // clear the connect deadline once established
    upstream.setNoDelay(true);
    upstream.write(
      buildUpstreamHandshake({
        daemonPath,
        daemonHost: `${host}:${port}`,
        rawHeaders: req.rawHeaders,
        token: machine.token,
      }),
    );
    if (head && head.length > 0) {
      upstream.write(head);
    }

    if (!echoProto) {
      // Browser cookie path: byte-transparent relay (unchanged).
      relay();
      return;
    }

    // Device path: buffer the 101 head, echo the token subprotocol, then relay.
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      if (options.isAuthorized && !options.isAuthorized()) { teardown(); return; }
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) {
        if (buf.length > 16384) {
          teardown(); // runaway response head
        }
        return;
      }
      upstream.off("data", onData);
      const headEnd = sep + 4;
      const rewritten = injectResponseSubprotocol(buf.subarray(0, headEnd).toString("latin1"), echoProto);
      clientSocket.write(Buffer.from(rewritten, "latin1"));
      const rest = buf.subarray(headEnd);
      if (rest.length > 0) {
        clientSocket.write(rest);
      }
      relay();
    };
    upstream.on("data", onData);
  };

  const upstream: net.Socket = (options.connect ?? connectUpstream)(target, onConnect);

  upstream.setTimeout(options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
  upstream.on("timeout", () => {
    health?.recordFailure(machine.name, health.now() - connectStartedAt);
    upstream.destroy();
  });

  const teardown = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  const revocationTimer = options.isAuthorized ? setInterval(() => {
    if (!options.isAuthorized!()) teardown();
  }, 250) : undefined;
  revocationTimer?.unref();
  clientSocket.once("close", () => { if (revocationTimer) clearInterval(revocationTimer); });
  upstream.on("error", teardown);
  clientSocket.on("error", teardown);
  upstream.on("close", () => clientSocket.destroy());
  clientSocket.on("close", () => upstream.destroy());
}
