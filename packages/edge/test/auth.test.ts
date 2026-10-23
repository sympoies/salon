import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseCookies,
  serializeSetCookie,
  timingSafeEqualStr,
  SessionStore,
  WsTicketStore,
  SESSION_COOKIE,
  bearerToken,
  wsProtocolToken,
  wsProtocolEcho,
  WS_TOKEN_PROTO_PREFIX,
} from "../src/auth.ts";

test("parseCookies handles undefined and empty", () => {
  assert.equal(parseCookies(undefined).size, 0);
  assert.equal(parseCookies("").size, 0);
});

test("parseCookies parses multiple cookies", () => {
  const c = parseCookies("a=1; ac_session=abc; b=two");
  assert.equal(c.get("a"), "1");
  assert.equal(c.get(SESSION_COOKIE), "abc");
  assert.equal(c.get("b"), "two");
});

test("parseCookies url-decodes values", () => {
  const c = parseCookies("x=hello%20world");
  assert.equal(c.get("x"), "hello world");
});

test("serializeSetCookie sets flags", () => {
  const s = serializeSetCookie(SESSION_COOKIE, "v", {
    httpOnly: true,
    sameSite: "Strict",
    secure: true,
    path: "/",
    maxAge: 3600,
  });
  assert.match(s, /^ac_session=v/);
  assert.match(s, /HttpOnly/);
  assert.match(s, /SameSite=Strict/);
  assert.match(s, /Secure/);
  assert.match(s, /Path=\//);
  assert.match(s, /Max-Age=3600/);
});

test("serializeSetCookie omits Secure when false", () => {
  const s = serializeSetCookie(SESSION_COOKIE, "v", { httpOnly: true, secure: false });
  assert.doesNotMatch(s, /Secure/);
});

test("timingSafeEqualStr compares correctly", () => {
  assert.equal(timingSafeEqualStr("abc", "abc"), true);
  assert.equal(timingSafeEqualStr("abc", "abd"), false);
  assert.equal(timingSafeEqualStr("abc", "abcd"), false);
  assert.equal(timingSafeEqualStr("", ""), false); // empty never authorizes
  assert.equal(timingSafeEqualStr("", "real"), false); // empty candidate vs real
  assert.equal(timingSafeEqualStr("real", ""), false);
});

test("SessionStore issues opaque ids and validates membership", () => {
  const store = new SessionStore();
  const id = store.create("tess");
  assert.ok(id.length >= 32);
  assert.equal(store.has(id), true);
  assert.equal(store.get(id), "tess");
  assert.equal(store.has("nope"), false);
  assert.equal(store.get("nope"), undefined);
  store.delete(id);
  assert.equal(store.has(id), false);
  assert.equal(store.get(id), undefined);
});

test("SessionStore ids are unique", () => {
  const store = new SessionStore();
  const a = store.create("tess");
  const b = store.create("dana");
  assert.notEqual(a, b);
  assert.equal(store.get(a), "tess");
  assert.equal(store.get(b), "dana");
});

test("WsTicketStore issues one-time session-bound tickets with expiry", () => {
  let now = 1_000;
  const store = new WsTicketStore(() => now);

  const wrongSession = store.create("maple", "s1", 50);
  assert.equal(store.take(wrongSession, "maple", "s2"), false);
  assert.equal(store.take(wrongSession, "maple", "s1"), false);

  const wrongMachine = store.create("maple", "s1", 50);
  assert.equal(store.take(wrongMachine, "m2", "s1"), false);
  assert.equal(store.take(wrongMachine, "maple", "s1"), false);

  const accepted = store.create("maple", "s1", 50);
  assert.match(accepted, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(store.take(accepted, "maple", "s1"), true);
  assert.equal(store.take(accepted, "maple", "s1"), false);

  const expired = store.create("maple", "s1", 50);
  now += 51;
  assert.equal(store.take(expired, "maple", "s1"), false);
});

test("bearerToken extracts a Bearer value (case-insensitive), else undefined", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer   xyz"), "xyz");
  assert.equal(bearerToken("Basic abc"), undefined);
  assert.equal(bearerToken(undefined), undefined);
  assert.equal(bearerToken(""), undefined);
});

test("wsProtocolToken picks the ac-token.* entry from a subprotocol list", () => {
  assert.equal(wsProtocolToken(`${WS_TOKEN_PROTO_PREFIX}secret`), "secret");
  assert.equal(wsProtocolToken(`chat, ${WS_TOKEN_PROTO_PREFIX}secret, other`), "secret");
  assert.equal(wsProtocolToken(["chat", `${WS_TOKEN_PROTO_PREFIX}secret`]), "secret");
  assert.equal(wsProtocolToken("chat, other"), undefined);
  assert.equal(wsProtocolToken(WS_TOKEN_PROTO_PREFIX), undefined); // empty token
  assert.equal(wsProtocolToken(undefined), undefined);
  // picks the FIRST ac-token entry when several are offered
  assert.equal(wsProtocolToken(`${WS_TOKEN_PROTO_PREFIX}first, ${WS_TOKEN_PROTO_PREFIX}second`), "first");
});

test("wsProtocolToken decodes base64url token subprotocols for separator characters", () => {
  const encoded = Buffer.from("client:secret-token", "utf8").toString("base64url");
  assert.equal(wsProtocolToken(`ac-token-b64.${encoded}`), "client:secret-token");
  assert.equal(wsProtocolToken(`chat, ac-token-b64.${encoded}`), "client:secret-token");
});

test("wsProtocolEcho returns the safe offered subprotocol for the response", () => {
  const encoded = Buffer.from("client:secret-token", "utf8").toString("base64url");
  assert.equal(wsProtocolEcho(`chat, ac-token-b64.${encoded}`), `ac-token-b64.${encoded}`);
  assert.equal(wsProtocolEcho(`${WS_TOKEN_PROTO_PREFIX}legacy-token`), `${WS_TOKEN_PROTO_PREFIX}legacy-token`);
  assert.equal(wsProtocolEcho("ac-token-b64.not?token"), undefined);
});
