import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEVICE_LIFETIME_MS = 30 * 86_400_000;
// Storage retention is independent of the server's fixed authorization deadline.
export const DEVICE_COOKIE_MAX_AGE = 90 * 86_400;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEVICE_TOKEN = /^salon_device_[A-Za-z0-9_-]{43}$/;
const CHALLENGE = /^[a-f0-9]{64}$/;
export const credentialHash = (value: string): string => createHash("sha256").update(value).digest("hex");
const generation = (secret: string, main: string): string => createHmac("sha256", secret).update(main).digest("hex");
const equalHash = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class PairingError extends Error {
  readonly status: number;
  constructor(status = 400, message = "Pairing unavailable.") { super(message); this.status = status; }
}

interface PairingRow {
  id: string; code_hash: string; principal: string; source_session: string | null; generation: string;
  created: number; expires_at: number; challenge: string | null; name: string | null;
  delivery: string | null; origin: string | null; approved: number | null;
  consumed: number | null; revoked: number | null;
}
interface DeviceRow {
  id: string; token_hash: string; principal: string; generation: string; name: string;
  created: number; last_used: number; expires_at: number; revoked: number | null;
}
export interface DeviceIdentity { readonly id: string; readonly credential: string; readonly principal: string; }
export interface PairingClaim {
  readonly code: string; readonly challenge: string; readonly name: string;
  readonly delivery: "browser" | "native"; readonly origin: string;
}
export interface PairingExchange extends Omit<PairingClaim, "name"> {
  readonly verifier: string; readonly principal: string; readonly confirmed: boolean;
}

function codeHash(raw: string): string {
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== 20 || [...code].some(char => !ALPHABET.includes(char))) throw new PairingError();
  return credentialHash(code);
}
function metadata(row: DeviceRow, current?: string) {
  return { id: row.id, name: row.name, principal: row.principal, created: row.created,
    last_used: row.last_used, expires_at: row.expires_at, revoked: row.revoked,
    current: row.id === current };
}

/** Pairing secrets are delivered once. Only hashes and secret-keyed main-generation bindings reach SQLite. */
export class DeviceCredentialStore {
  readonly #db: DatabaseSync;
  readonly mainFor: (id: string) => string | undefined;
  readonly sourceActive: (hash: string, principal: string) => boolean;
  readonly now: () => number;
  constructor(path: string, mainFor: (id: string) => string | undefined,
    sourceActive: (hash: string, principal: string) => boolean,
    now: () => number = Date.now) {
    this.mainFor = mainFor; this.sourceActive = sourceActive; this.now = now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS device_pairings (
        id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, principal TEXT NOT NULL,
        source_session TEXT, generation TEXT NOT NULL, created INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        challenge TEXT, name TEXT, delivery TEXT, origin TEXT, approved INTEGER, consumed INTEGER, revoked INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS device_credentials (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, principal TEXT NOT NULL, generation TEXT NOT NULL,
        name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS device_credential_audit (
        id INTEGER PRIMARY KEY, actor TEXT NOT NULL, credential_kind TEXT NOT NULL,
        device TEXT NOT NULL, occurred_at INTEGER NOT NULL, previous_expiry INTEGER NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS device_pairing_limits (
        bucket TEXT PRIMARY KEY, started INTEGER NOT NULL, attempts INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT 'address'
      ) STRICT;`);
    const columns = this.#db.prepare("PRAGMA table_info(device_pairing_limits)").all() as { name: string }[];
    if (!columns.some(column => column.name === "category")) {
      this.#db.exec("ALTER TABLE device_pairing_limits ADD COLUMN category TEXT NOT NULL DEFAULT 'address'; DELETE FROM device_pairing_limits;");
    }
  }
  close(): void { this.#db.close(); }

  limit(key: string, max: number, window = 60_000): void {
    const now = this.now();
    this.#db.prepare("DELETE FROM device_pairing_limits WHERE started <= ?").run(now - 600_000);
    const bucket = credentialHash(key);
    const category = key.startsWith("address:") ? "address" : "credential";
    const counted = this.#db.prepare(`INSERT INTO device_pairing_limits(bucket,started,attempts,category)
      SELECT ?, ?, 1, ? WHERE ? != 'address' OR EXISTS(SELECT 1 FROM device_pairing_limits WHERE bucket=?)
        OR (SELECT COUNT(*) FROM device_pairing_limits WHERE category='address')<10000
      ON CONFLICT(bucket) DO UPDATE SET
        started=CASE WHEN device_pairing_limits.started<=? THEN excluded.started ELSE device_pairing_limits.started END,
        attempts=CASE WHEN device_pairing_limits.started<=? THEN 1 ELSE device_pairing_limits.attempts+1 END
      RETURNING attempts`).get(bucket, now, category, category, bucket, now - window, now - window) as { attempts: number } | undefined;
    if (!counted) throw new PairingError(429, "Too many pairing requests.");
    const attempts = counted.attempts;
    if (attempts > max) throw new PairingError(429, "Too many pairing requests.");
  }
  ownerLimit(owner: string, anonymous = false): void {
    try { this.limit(`${anonymous ? "claimant" : "owner"}:${owner}`, 120); }
    catch (error) { if (anonymous && error instanceof PairingError) throw new PairingError(); throw error; }
  }
  create(principal: string, main: string, source: string | undefined, ttl: number) {
    this.limit(`creation:${principal}`, 5, 600_000);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      this.#db.prepare("DELETE FROM device_pairings WHERE expires_at <= ?").run(now);
      const active = this.#db.prepare(`SELECT COUNT(*) AS n FROM device_pairings
        WHERE principal=? AND revoked IS NULL AND consumed IS NULL`).get(principal) as { n: number };
      if (active.n >= 3) throw new PairingError(429, "Too many pairing requests.");
      const code = [...randomBytes(20)].map(byte => ALPHABET[byte & 31]).join("");
      const id = randomUUID();
      const expires_at = now + ttl;
      this.#db.prepare(`INSERT INTO device_pairings
        (id,code_hash,principal,source_session,generation,created,expires_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id, credentialHash(code), principal, source ?? null, generation(code, main), now, expires_at);
      this.#db.exec("COMMIT");
      return { id, code: code.match(/.{4}/g)!.join("-"), expires_at };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #usable(row: PairingRow | undefined, rawCode?: string): PairingRow {
    if (!row || row.expires_at <= this.now() || row.revoked !== null || row.consumed !== null
      || (row.source_session !== null && !this.sourceActive(row.source_session, row.principal))) throw new PairingError();
    if (rawCode !== undefined) {
      const main = this.mainFor(row.principal);
      const code = rawCode.toUpperCase().replace(/[\s-]/g, "");
      if (!main || !equalHash(row.generation, generation(code, main))) throw new PairingError();
    }
    return row;
  }
  #byCode(code: string): PairingRow {
    const row = this.#db.prepare("SELECT * FROM device_pairings WHERE code_hash=?").get(codeHash(code)) as PairingRow | undefined;
    if (row) this.ownerLimit(row.principal, true);
    return this.#usable(row, code);
  }
  #owned(id: string, principal: string): PairingRow {
    const row = this.#db.prepare("SELECT * FROM device_pairings WHERE id=? AND principal=?").get(id, principal) as PairingRow | undefined;
    if (!row) throw new PairingError(404, "Not found.");
    return row;
  }
  claim(input: PairingClaim) {
    if (!CHALLENGE.test(input.challenge) || !["native", "browser"].includes(input.delivery)
      || !input.name.trim() || input.name.length > 80 || /[\u0000-\u001f\u007f]/.test(input.name)) throw new PairingError();
    const row = this.#byCode(input.code);
    this.#db.prepare(`UPDATE device_pairings SET challenge=?,name=?,delivery=?,origin=?
      WHERE id=? AND challenge IS NULL AND revoked IS NULL AND consumed IS NULL AND expires_at>?`)
      .run(input.challenge, input.name.trim(), input.delivery, input.origin, row.id, this.now());
    const claimed = this.#usable(this.#owned(row.id, row.principal), input.code);
    if (claimed.challenge !== input.challenge || claimed.delivery !== input.delivery
      || claimed.origin !== input.origin || claimed.name !== input.name.trim()) throw new PairingError();
    return this.status(claimed.id, claimed.principal);
  }
  status(id: string, principal: string) {
    const row = this.#owned(id, principal);
    return { id: row.id, principal: row.principal, challenge: row.challenge, name: row.name,
      delivery: row.delivery, origin: row.origin, expires_at: row.expires_at,
      verification: row.challenge ? [...Buffer.from(row.challenge, "hex").subarray(0, 8)].map(byte => ALPHABET[byte & 31]).join("") : null, approved: row.approved !== null,
      unavailable: row.revoked !== null || row.consumed !== null || row.expires_at <= this.now() };
  }
  approve(id: string, principal: string, code: string, challenge: string): void {
    const row = this.#usable(this.#owned(id, principal), code);
    if (row.code_hash !== codeHash(code) || !row.challenge || row.challenge !== challenge) throw new PairingError();
    this.#db.prepare("UPDATE device_pairings SET approved=? WHERE id=? AND revoked IS NULL AND consumed IS NULL AND expires_at>?")
      .run(this.now(), id, this.now());
  }
  cancel(id: string, principal: string): void {
    this.#owned(id, principal);
    this.#db.prepare("UPDATE device_pairings SET revoked=? WHERE id=? AND principal=?").run(this.now(), id, principal);
  }
  exchange(input: PairingExchange, currentPrincipal?: string) {
    // Failed exchanges still consume the owner budget outside the credential transaction.
    const candidate = this.#byCode(input.code);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#usable(this.#owned(candidate.id, candidate.principal), input.code);
      if (!input.confirmed || row.approved === null || row.principal !== input.principal
        || (currentPrincipal !== undefined && currentPrincipal !== row.principal)
        || !/^[A-Za-z0-9_-]{43}$/.test(input.verifier) || row.challenge !== credentialHash(input.verifier)
        || row.challenge !== input.challenge || row.delivery !== input.delivery || row.origin !== input.origin) throw new PairingError();
      const main = this.mainFor(row.principal);
      if (!main) throw new PairingError();
      const credential = `salon_device_${randomBytes(32).toString("base64url")}`;
      const id = randomUUID();
      const now = this.now();
      this.#db.prepare("UPDATE device_pairings SET consumed=? WHERE id=?").run(now, row.id);
      this.#db.prepare("INSERT INTO device_credentials VALUES (?,?,?,?,?,?,?,?,NULL)")
        .run(id, credentialHash(credential), row.principal, generation(credential, main), row.name!, now, now, now + DEVICE_LIFETIME_MS);
      this.#db.exec("COMMIT");
      return { id, principal: row.principal, credential, expires_at: now + DEVICE_LIFETIME_MS };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  authenticate(credential: string, touch = true): DeviceIdentity | undefined {
    if (!DEVICE_TOKEN.test(credential)) return undefined;
    const row = this.#db.prepare("SELECT * FROM device_credentials WHERE token_hash=?").get(credentialHash(credential)) as DeviceRow | undefined;
    const main = row && this.mainFor(row.principal);
    if (!row || !main || row.revoked !== null || row.expires_at <= this.now()
      || !equalHash(row.generation, generation(credential, main))) return undefined;
    if (touch) this.#db.prepare("UPDATE device_credentials SET last_used=? WHERE id=?").run(this.now(), row.id);
    return { id: row.id, credential, principal: row.principal };
  }
  /** Outbox generation checks separately bind the current main token and machine. */
  activeDevice(id: string, principal: string): boolean {
    return Boolean(this.mainFor(principal) && this.#db.prepare(`SELECT 1 FROM device_credentials
      WHERE id=? AND principal=? AND revoked IS NULL AND expires_at>?`).get(id, principal, this.now()));
  }
  list(principal: string, current?: string) {
    return (this.#db.prepare("SELECT * FROM device_credentials WHERE principal=? ORDER BY created DESC").all(principal) as unknown as DeviceRow[])
      .map(row => metadata(row, current));
  }
  revoke(id: string, principal: string): void {
    const result = this.#db.prepare("UPDATE device_credentials SET revoked=? WHERE id=? AND principal=?")
      .run(this.now(), id, principal);
    if (!result.changes) throw new PairingError(404, "Not found.");
  }
  renew(id: string, principal: string, kind: string) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      const row = this.#db.prepare(`SELECT * FROM device_credentials
        WHERE id=? AND principal=? AND revoked IS NULL AND expires_at>?`).get(id, principal, now) as DeviceRow | undefined;
      if (!row) throw new PairingError(404, "Not found.");
      const expires = now + DEVICE_LIFETIME_MS;
      this.#db.prepare(`UPDATE device_credentials SET expires_at=?
        WHERE id=? AND principal=? AND revoked IS NULL AND expires_at>?`).run(expires, id, principal, now);
      this.#db.prepare(`INSERT INTO device_credential_audit
        (actor,credential_kind,device,occurred_at,previous_expiry,expires_at) VALUES (?,?,?,?,?,?)`)
        .run(principal, kind, id, now, row.expires_at, expires);
      this.#db.exec("COMMIT");
      return metadata({ ...row, expires_at: expires });
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
}
