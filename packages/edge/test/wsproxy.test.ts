import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildUpstreamHandshake, stripTokenProtocol, injectResponseSubprotocol } from "../src/wsproxy.ts";

const rawHeaders = [
  "Host", "console.example.example.com",
  "Upgrade", "websocket",
  "Connection", "Upgrade",
  "Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version", "13",
  "Cookie", "ac_session=browsersecret",
  "Authorization", "Bearer should-not-forward",
];

test("buildUpstreamHandshake targets the daemon path + host", () => {
  const out = buildUpstreamHandshake({
    daemonPath: "/sessions/hs-codex-1/attach",
    daemonHost: "127.0.0.1:8781",
    rawHeaders,
    token: "machine-token",
  });
  assert.match(out, /^GET \/sessions\/hs-codex-1\/attach HTTP\/1\.1\r\n/);
  assert.match(out, /\r\nHost: 127\.0\.0\.1:8781\r\n/);
});

test("buildUpstreamHandshake injects the machine bearer token", () => {
  const out = buildUpstreamHandshake({
    daemonPath: "/sessions/x/attach",
    daemonHost: "127.0.0.1:8781",
    rawHeaders,
    token: "machine-token",
  });
  assert.match(out, /\r\nAuthorization: Bearer machine-token\r\n/);
});

test("buildUpstreamHandshake forwards WebSocket handshake headers", () => {
  const out = buildUpstreamHandshake({
    daemonPath: "/sessions/x/attach",
    daemonHost: "127.0.0.1:8781",
    rawHeaders,
    token: "t",
  });
  assert.match(out, /\r\nUpgrade: websocket\r\n/i);
  assert.match(out, /\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n/);
  assert.match(out, /\r\nSec-WebSocket-Version: 13\r\n/);
});

test("buildUpstreamHandshake never forwards the browser cookie or its Authorization", () => {
  const out = buildUpstreamHandshake({
    daemonPath: "/sessions/x/attach",
    daemonHost: "127.0.0.1:8781",
    rawHeaders,
    token: "machine-token",
  });
  assert.doesNotMatch(out, /browsersecret/);
  assert.doesNotMatch(out, /should-not-forward/);
  assert.doesNotMatch(out, /\r\nCookie:/i);
});

test("buildUpstreamHandshake ends with a blank line", () => {
  const out = buildUpstreamHandshake({
    daemonPath: "/sessions/x/attach",
    daemonHost: "127.0.0.1:8781",
    rawHeaders,
    token: "t",
  });
  assert.ok(out.endsWith("\r\n\r\n"));
});

test("stripTokenProtocol removes ac-token.* and drops the header when only the token", () => {
  assert.equal(stripTokenProtocol("ac-token.secret"), null);
  assert.equal(stripTokenProtocol("ac-token-b64.Y2xpZW50OnNlY3JldA"), null);
  assert.equal(stripTokenProtocol("chat, ac-token.secret, other"), "chat, other");
  assert.equal(stripTokenProtocol("chat, ac-token-b64.Y2xpZW50OnNlY3JldA, other"), "chat, other");
  assert.equal(stripTokenProtocol("chat"), "chat");
  // removes EVERY ac-token entry (no partial-strip token leak upstream)
  assert.equal(stripTokenProtocol("ac-token.a, ac-token.b"), null);
  assert.equal(stripTokenProtocol("ac-token.a, ac-token-b64.Yg"), null);
  assert.equal(stripTokenProtocol("chat, ac-token.a, ac-token.b"), "chat");
});

test("injectResponseSubprotocol is a no-op when the head has no terminator", () => {
  const partial = "HTTP/1.1 101 x\r\nUpgrade: websocket";
  assert.equal(injectResponseSubprotocol(partial, "ac-token.x"), partial);
});

test("buildUpstreamHandshake never forwards the client token subprotocol upstream", () => {
  const out = buildUpstreamHandshake({
    daemonPath: "/sessions/x/attach",
    daemonHost: "127.0.0.1:8781",
    rawHeaders: ["Sec-WebSocket-Protocol", "ac-token.superSecret", "Sec-WebSocket-Key", "k", "Upgrade", "websocket"],
    token: "machine",
  });
  assert.doesNotMatch(out, /superSecret/);
  assert.doesNotMatch(out, /ac-token/); // the whole subprotocol header is dropped
});

test("injectResponseSubprotocol echoes the subprotocol into a 101 head", () => {
  const head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: abc\r\n\r\n";
  const out = injectResponseSubprotocol(head, "ac-token.secret");
  assert.match(out, /\r\nSec-WebSocket-Protocol: ac-token\.secret\r\n/);
  assert.ok(out.endsWith("\r\n\r\n"));
});

test("injectResponseSubprotocol is a no-op on non-101 or when already present", () => {
  const notUpgrade = "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n";
  assert.equal(injectResponseSubprotocol(notUpgrade, "ac-token.x"), notUpgrade);
  const already = "HTTP/1.1 101 x\r\nSec-WebSocket-Protocol: keep\r\n\r\n";
  assert.equal(injectResponseSubprotocol(already, "ac-token.x"), already);
});
