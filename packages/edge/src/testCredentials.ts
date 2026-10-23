import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TESTER_ID = /^tester-[a-z0-9][a-z0-9._-]{0,56}$/;
export function validTesterId(id: string): boolean { return TESTER_ID.test(id); }
export function testCredentialHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Only owner-side tooling can write this store. Browser requests may authenticate
// and record sign-in, but cannot issue, replace, inspect or revoke credentials.
export class TestCredentialStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS test_credentials (
        principal_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS test_credential_audit (
        id INTEGER PRIMARY KEY,
        principal_id TEXT NOT NULL,
        action TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor TEXT NOT NULL
      ) STRICT;
    `);
  }
  close(): void { this.#db.close(); }

  issue(id: string, deliver: (token: string) => void): void {
    if (!validTesterId(id)) throw new Error("invalid tester principal");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.fingerprint(id)) throw new Error("tester credential already active");
      const token = `ac_test_${randomBytes(32).toString("base64url")}`;
      this.#db.prepare(`INSERT INTO test_credentials VALUES (?, ?, ?, NULL)
        ON CONFLICT(principal_id) DO UPDATE SET token_hash=excluded.token_hash,
          issued_at=excluded.issued_at, revoked_at=NULL`).run(id, testCredentialHash(token), new Date().toISOString());
      this.#audit(id, "create");
      // Write directly to a private owner file while the transaction is held.
      // If file delivery fails, no usable credential is committed.
      deliver(token);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  authenticate(token: string): string | undefined {
    if (!/^ac_test_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.#db.prepare("SELECT principal_id FROM test_credentials WHERE token_hash=? AND revoked_at IS NULL")
      .get(testCredentialHash(token)) as { principal_id: string } | undefined;
    return row?.principal_id;
  }

  fingerprint(id: string): string | undefined {
    const row = this.#db.prepare("SELECT token_hash FROM test_credentials WHERE principal_id=? AND revoked_at IS NULL")
      .get(id) as { token_hash: string } | undefined;
    return row?.token_hash;
  }

  signIn(id: string): void { this.#audit(id, "sign-in"); }

  revoke(id: string): boolean {
    if (!validTesterId(id)) throw new Error("invalid tester principal");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db.prepare("UPDATE test_credentials SET revoked_at=? WHERE principal_id=? AND revoked_at IS NULL")
        .run(new Date().toISOString(), id);
      if (result.changes) {
        // Revoke existing browser cookies as well as the credential. Edge checks
        // current fingerprint on every request, including native bearer auth.
        const sessions = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_sessions'").get();
        if (sessions) this.#db.prepare("DELETE FROM auth_sessions WHERE principal_id=?").run(id);
        this.#audit(id, "revoke");
      }
      this.#db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  audit(id?: string): Array<{ id: number; principal_id: string; action: string; occurred_at: string; actor: string }> {
    if (id !== undefined && !validTesterId(id)) throw new Error("invalid tester principal");
    return this.#db.prepare(`SELECT id, principal_id, action, occurred_at, actor FROM test_credential_audit
      WHERE (? IS NULL OR principal_id=?) ORDER BY id`).all(id ?? null, id ?? null) as ReturnType<TestCredentialStore["audit"]>;
  }

  #audit(id: string, action: "create" | "revoke" | "sign-in"): void {
    this.#db.prepare("INSERT INTO test_credential_audit(principal_id, action, occurred_at, actor) VALUES (?, ?, ?, ?)")
      .run(id, action, new Date().toISOString(), action === "sign-in" ? `principal:${id}` : `owner-local:${process.getuid?.() ?? "unknown"}`);
  }
}
