import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SESSION_MAX_AGE = 12 * 60 * 60; // 12h, fixed from login (never sliding)
export const SESSION_COOKIE = "ac_session";

// A native Tauri client can't set an Authorization header on a WebSocket, and
// the daemon trust model forbids the long-lived token in the ws:// URL. Current
// clients prefer one-time attach tickets, but this legacy subprotocol auth path
// stays as a compatibility fallback: the edge validates it, strips it before
// proxying, and echoes it on the 101 so the WebView handshake completes. HTTP
// requests from native clients use a normal bearer header via the Tauri HTTP
// plugin. The browser build keeps using the httpOnly session cookie.
export const WS_TOKEN_PROTO_PREFIX = "ac-token.";
export const WS_TOKEN_PROTO_B64_PREFIX = "ac-token-b64.";
const WS_PROTOCOL_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Extract a bearer token from an Authorization header, or undefined.
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const m = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : undefined;
}

// Extract the client token from a Sec-WebSocket-Protocol list (comma-separated),
// picking the first `ac-token.<token>` entry.
export function wsProtocolToken(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) {
    return undefined;
  }
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (p.startsWith(WS_TOKEN_PROTO_B64_PREFIX)) {
      const token = decodeBase64UrlToken(p.slice(WS_TOKEN_PROTO_B64_PREFIX.length));
      if (token !== undefined) {
        return token;
      }
    }
    if (p.startsWith(WS_TOKEN_PROTO_PREFIX)) {
      const t = p.slice(WS_TOKEN_PROTO_PREFIX.length);
      if (t !== "") {
        return t;
      }
    }
  }
  return undefined;
}

export function wsProtocolEcho(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) {
    return undefined;
  }
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (p === "" || !WS_PROTOCOL_TOKEN_RE.test(p)) {
      continue;
    }
    if (p.startsWith(WS_TOKEN_PROTO_B64_PREFIX)) {
      if (decodeBase64UrlToken(p.slice(WS_TOKEN_PROTO_B64_PREFIX.length)) !== undefined) {
        return p;
      }
      continue;
    }
    if (p.startsWith(WS_TOKEN_PROTO_PREFIX) && p.slice(WS_TOKEN_PROTO_PREFIX.length) !== "") {
      return p;
    }
  }
  return undefined;
}

function decodeBase64UrlToken(encoded: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return undefined;
  }
  try {
    const token = Buffer.from(encoded, "base64url").toString("utf8");
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name === "") {
      continue;
    }
    const value = part.slice(eq + 1).trim();
    try {
      out.set(name, decodeURIComponent(value));
    } catch {
      out.set(name, value);
    }
  }
  return out;
}

export interface CookieOptions {
  readonly httpOnly?: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
  readonly secure?: boolean;
  readonly path?: string;
  readonly maxAge?: number;
}

export function serializeSetCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  }
  if (opts.sameSite) {
    parts.push(`SameSite=${opts.sameSite}`);
  }
  if (opts.httpOnly) {
    parts.push("HttpOnly");
  }
  if (opts.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

// Constant-time string comparison. An empty candidate never authorizes: length
// mismatch fails closed before the constant-time step.
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// Store only hashes of random session IDs, never bearer credentials or cookies.
// The configured state volume survives container replacement; memory is reserved
// for local/test configurations without a state path.
export class SessionStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(path = ":memory:", now: () => number = Date.now) {
    this.#now = now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.#db.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (
      id_hash TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT`);
    this.#prune();
  }

  close(): void { this.#db.close(); }

  create(principalId: string, credential = ""): string {
    this.#prune();
    const id = randomBytes(32).toString("hex");
    this.#db.prepare("INSERT INTO auth_sessions VALUES (?, ?, ?, ?)").run(
      this.#hash(id), principalId, this.#fingerprint(id, credential), this.#now() + SESSION_MAX_AGE * 1000,
    );
    return id;
  }

  has(id: string | undefined): boolean { return this.get(id) !== undefined; }

  get(id: string | undefined, credentialFor?: (principalId: string) => string | undefined): string | undefined {
    if (!id) return undefined;
    const row = this.#db.prepare("SELECT principal_id, credential_hash, expires_at FROM auth_sessions WHERE id_hash = ?")
      .get(this.#hash(id)) as { principal_id: string; credential_hash: string; expires_at: number } | undefined;
    if (!row) return undefined;
    const credential = credentialFor?.(row.principal_id);
    if (row.expires_at <= this.#now()
      || (credentialFor && (credential === undefined || !timingSafeEqualStr(row.credential_hash, this.#fingerprint(id, credential))))) {
      this.delete(id);
      return undefined;
    }
    return row.principal_id;
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").run(this.#hash(id));
  }

  #fingerprint(id: string, credential: string): string {
    return createHmac("sha256", id).update(credential).digest("hex");
  }

  #hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
  #prune(): void { this.#db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(this.#now()); }
}

export interface WsTicket {
  readonly machine: string;
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly principalId?: string;
  readonly incarnation?: string;
  readonly credentialFingerprint?: string;
}

export interface WsTicketOwnership {
  readonly principalId: string;
  readonly incarnation: string;
  readonly credentialFingerprint?: string;
}

// Short-lived one-time WebSocket attach tickets for device clients. They avoid
// relying on front proxies preserving Sec-WebSocket-Protocol while still keeping
// the long-lived client token out of the WebSocket URL.
export class WsTicketStore {
  #tickets = new Map<string, WsTicket>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  create(machine: string, sessionId: string, ttlMs = 30_000, ownership?: WsTicketOwnership): string {
    this.#prune();
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, {
      machine,
      sessionId,
      expiresAt: this.#now() + ttlMs,
      ...(ownership ?? {}),
    });
    return ticket;
  }

  take(ticket: string | null | undefined, machine: string, sessionId: string): boolean {
    return this.takeDetails(ticket, machine, sessionId) !== undefined;
  }

  takeDetails(ticket: string | null | undefined, machine: string, sessionId: string): WsTicket | undefined {
    if (!ticket) {
      return undefined;
    }
    const record = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (!record || record.expiresAt < this.#now()) {
      return undefined;
    }
    return record.machine === machine && record.sessionId === sessionId ? record : undefined;
  }

  #prune(): void {
    const now = this.#now();
    for (const [ticket, record] of this.#tickets) {
      if (record.expiresAt < now) {
        this.#tickets.delete(ticket);
      }
    }
  }
}
