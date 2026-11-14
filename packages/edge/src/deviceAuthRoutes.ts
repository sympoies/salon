import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { TLSSocket } from "node:tls";
import type { EdgeConfig, PrincipalConfig } from "./config.ts";
import { SESSION_COOKIE, serializeSetCookie } from "./auth.ts";
import { readJsonBody, sendJson } from "./http.ts";
import { sameOrigin, forbidCrossOrigin } from "./csrf.ts";
import { DEVICE_COOKIE_MAX_AGE, DeviceCredentialStore, PairingError,
  type DeviceIdentity, type PairingClaim, type PairingExchange } from "./deviceCredentials.ts";

interface Context {
  readonly config: EdgeConfig;
  readonly store: DeviceCredentialStore;
  readonly principal: PrincipalConfig | undefined;
  readonly device: DeviceIdentity | undefined;
  readonly sourceSession: string | undefined;
  readonly live: () => boolean;
  readonly csrfExempt: () => boolean;
}

export function deviceCookie(credential: string, secure: boolean): string {
  return serializeSetCookie(SESSION_COOKIE, credential,
    { httpOnly: true, sameSite: "Strict", secure, maxAge: DEVICE_COOKIE_MAX_AGE });
}

function peerIdentity(address: string): string {
  const version = isIP(address);
  if (!version) return "";
  // Canonicalize IPv6 spelling and IPv4-mapped socket addresses without DNS.
  return new URL(`http://[${version === 4 ? `::ffff:${address}` : address}]`).hostname;
}

function pairingScheme(req: IncomingMessage, config: EdgeConfig): "https" | "http" {
  if (req.socket instanceof TLSSocket && req.socket.encrypted) return "https";
  const peer = peerIdentity(req.socket.remoteAddress ?? "");
  if (peer && config.pairingTrustedProxyPeers?.some(address => peerIdentity(address) === peer)
    && req.headers["x-forwarded-proto"] === "https") return "https";
  const loopback = (value: string) => ["[::1]", "[::ffff:7f00:1]"].includes(peerIdentity(value));
  const hostname = new URL(`http://${req.headers.host}`).hostname;
  if (!config.secureCookie && loopback(req.socket.remoteAddress ?? "") && loopback(req.socket.localAddress ?? "")
    && (hostname === "localhost" || loopback(hostname.replace(/^\[|\]$/g, "")))) return "http";
  throw new PairingError(403, "Secure pairing transport required.");
}

/** Intercept the complete credential boundary so untrusted parser/storage errors never reach debug/log paths. */
export async function handleDeviceAuth(req: IncomingMessage, res: ServerResponse, url: URL, ctx: Context): Promise<boolean> {
  const path = url.pathname;
  if (!/^\/api\/auth\/(pairings|devices)(\/|$)/.test(path)) return false;
  const method = req.method ?? "GET";
  const anonymous = path === "/api/auth/pairings/claim" || path === "/api/auth/pairings/exchange";
  const pairing = path.startsWith("/api/auth/pairings");
  try {
    if (ctx.config.openAccess || ctx.principal?.managedCredential) throw new PairingError(404, "Not found.");
    if (pairing) ctx.store.limit(`address:${req.socket.remoteAddress ?? "unknown"}`, 60);
    const scheme = pairing ? pairingScheme(req, ctx.config) : undefined;
    if (!anonymous && !ctx.principal) throw new PairingError(401, "Unauthorized.");
    if (ctx.principal && !anonymous) ctx.store.ownerLimit(ctx.principal.id);
    if (method !== "GET") {
      if (anonymous ? !sameOrigin(req, res) : !ctx.csrfExempt()) {
        if (!res.writableEnded) forbidCrossOrigin(res);
        return true;
      }
    }
    if (!anonymous && (pairing || path.endsWith("/renew")) && ctx.device) throw new PairingError(403, "Main credential required.");
    let body: Record<string, unknown> = {};
    if (method === "POST") {
      if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new PairingError();
      const raw = await readJsonBody(req, 2048).catch(() => { throw new PairingError(); });
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PairingError();
      body = raw as Record<string, unknown>;
    }
    if (ctx.principal && !ctx.live()) throw new PairingError(401, "Unauthorized.");
    const owner = ctx.principal?.id ?? "";
    const origin = new URL(`${scheme ?? (ctx.config.secureCookie ? "https" : "http")}://${req.headers.host}`).origin;
    if (method === "POST" && path === "/api/auth/pairings") {
      const data = ctx.store.create(owner, ctx.principal!.token, ctx.sourceSession, ctx.config.pairingTtlMs ?? 300_000);
      sendJson(res, 201, { ok: true, data }); return true;
    }
    if (method === "POST" && path === "/api/auth/pairings/claim") {
      if (typeof body.code !== "string" || typeof body.challenge !== "string" || typeof body.name !== "string"
        || !["native", "browser"].includes(body.delivery as string)) throw new PairingError();
      const data = ctx.store.claim({ ...body, origin } as unknown as PairingClaim);
      sendJson(res, 200, { ok: true, data }); return true;
    }
    if (method === "POST" && path === "/api/auth/pairings/exchange") {
      for (const field of ["code", "verifier", "principal", "challenge", "origin", "delivery"])
        if (typeof body[field] !== "string") throw new PairingError();
      if (body.confirmed !== true || body.origin !== origin) throw new PairingError();
      const issued = ctx.store.exchange(body as unknown as PairingExchange, ctx.principal?.id);
      if (body.delivery === "browser") {
        res.setHeader("set-cookie", deviceCookie(issued.credential, ctx.config.secureCookie));
        const { credential: _credential, ...data } = issued;
        sendJson(res, 200, { ok: true, data });
      } else sendJson(res, 200, { ok: true, data: issued });
      return true;
    }
    const match = /^\/api\/auth\/pairings\/([a-f0-9-]{36})(\/approve)?$/.exec(path);
    if (match) {
      const id = match[1]!;
      if (method === "GET" && !match[2]) sendJson(res, 200, { ok: true, data: ctx.store.status(id, owner) });
      else if (method === "DELETE" && !match[2]) { ctx.store.cancel(id, owner); sendJson(res, 200, { ok: true }); }
      else if (method === "POST" && match[2]) {
        if (typeof body.code !== "string" || typeof body.challenge !== "string") throw new PairingError();
        ctx.store.approve(id, owner, body.code, body.challenge); sendJson(res, 200, { ok: true });
      } else throw new PairingError(405, "Method not allowed.");
      return true;
    }
    if (method === "GET" && path === "/api/auth/devices") {
      sendJson(res, 200, { ok: true, data: { can_manage: !ctx.device,
        devices: ctx.store.list(owner, ctx.device?.id) } }); return true;
    }
    const device = /^\/api\/auth\/devices\/([a-f0-9-]{36})(\/renew)?$/.exec(path);
    if (device && method === "DELETE" && !device[2]) {
      ctx.store.revoke(device[1]!, owner); sendJson(res, 200, { ok: true }); return true;
    }
    if (device && method === "POST" && device[2]) {
      const data = ctx.store.renew(device[1]!, owner, ctx.sourceSession ? "main-session" : "main-token");
      sendJson(res, 200, { ok: true, data }); return true;
    }
    throw new PairingError(404, "Not found.");
  } catch (error) {
    const safe = error instanceof PairingError ? error : new PairingError(500);
    if (!res.headersSent) sendJson(res, safe.status, { ok: false, error: { message: safe.message } });
    return true;
  }
}
