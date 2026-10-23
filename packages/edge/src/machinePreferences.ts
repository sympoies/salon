import { DatabaseSync } from "node:sqlite";
import type { MachinePreference, MachinePreferenceChange } from "@agent-console/shared/api";
import type { MachineConfig } from "./config.ts";

interface PreferenceRow {
  machine: string;
  enabled: number;
  actor: string;
  reason: string;
  at: string;
  revision: number;
}

export class MachinePreferenceInitializedError extends Error {
  constructor() { super("machine preference is already initialized"); }
}

export function validPreferenceReason(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !value.includes("\0");
}

// Share the retained state file, but own only these two tables. The owner-local
// CLI must not run authentication, ownership or layout migrations.
export class MachinePreferencesStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS machine_preferences (
        principal_id TEXT NOT NULL, machine TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        actor TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        PRIMARY KEY (principal_id,machine)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS machine_preference_audit (
        change_id INTEGER PRIMARY KEY, principal_id TEXT NOT NULL,
        machine TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        actor TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL,
        revision INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS machine_preference_audit_principal
        ON machine_preference_audit (principal_id,change_id);
    `);
  }
  close(): void { this.#db.close(); }

  read(principalId: string): ReadonlyMap<string, PreferenceRow> {
    const rows = this.#db.prepare("SELECT machine,enabled,actor,reason,at,revision FROM machine_preferences WHERE principal_id=?").all(principalId) as unknown as PreferenceRow[];
    return new Map(rows.map(row => [row.machine, row]));
  }

  disabled(principalId: string): ReadonlySet<string> {
    return new Set([...this.read(principalId).values()].filter(row => row.enabled === 0).map(row => row.machine));
  }

  snapshot(principalId: string, machines: readonly MachineConfig[]): MachinePreference[] {
    const preferences = this.read(principalId);
    return machines.map(machine => {
      const row = preferences.get(machine.name);
      const enabled = row?.enabled !== 0;
      return { name: machine.name, enabled, active: machine.active !== false && enabled,
        last_change: row ? { actor: row.actor, reason: row.reason, at: row.at, revision: row.revision } : null };
    });
  }

  write(principalId: string, machine: string, enabled: boolean, reason: string, actor: string, initializeOnly = false): MachinePreferenceChange {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(principalId)
      || !machine || machine.length > 512 || /[\x00-\x1f\x7f]/.test(machine)
      || typeof enabled !== "boolean" || !validPreferenceReason(reason)
      || !actor || actor.length > 128 || /[\x00-\x1f\x7f]/.test(actor)) throw new Error("invalid machine preference");
    const at = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#db.prepare("SELECT revision FROM machine_preferences WHERE principal_id=? AND machine=?").get(principalId, machine) as { revision: number } | undefined;
      if (initializeOnly && current) throw new MachinePreferenceInitializedError();
      const revision = (current?.revision ?? 0) + 1;
      this.#db.prepare(`INSERT INTO machine_preferences (principal_id,machine,enabled,actor,reason,at,revision)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(principal_id,machine) DO UPDATE SET
        enabled=excluded.enabled,actor=excluded.actor,reason=excluded.reason,at=excluded.at,revision=excluded.revision
      `).run(principalId, machine, enabled ? 1 : 0, actor, reason.trim(), at, revision);
      this.#db.prepare(`INSERT INTO machine_preference_audit (principal_id,machine,enabled,actor,reason,at,revision)
        VALUES (?,?,?,?,?,?,?)`).run(principalId, machine, enabled ? 1 : 0, actor, reason.trim(), at, revision);
      this.#db.exec("COMMIT");
      return { actor, reason: reason.trim(), at, revision };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  audit(principalId: string): readonly (PreferenceRow & { change_id: number })[] {
    return this.#db.prepare("SELECT change_id,machine,enabled,actor,reason,at,revision FROM machine_preference_audit WHERE principal_id=? ORDER BY change_id").all(principalId) as unknown as (PreferenceRow & { change_id: number })[];
  }
}

export function applyMachinePreferences(machines: readonly MachineConfig[], disabled: ReadonlySet<string>): MachineConfig[] {
  return machines.map(machine => disabled.has(machine.name) ? { ...machine, active: false } : machine);
}
