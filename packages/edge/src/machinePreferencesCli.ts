import { lstatSync } from "node:fs";
import { parseArgs } from "node:util";
import { MachinePreferencesStore, validPreferenceReason } from "./machinePreferences.ts";

// Owner-local administration; no HTTP identity or credential is impersonated.
// Run as the retained database's Unix owner. Target and actor are explicit.
try {
  const { values } = parseArgs({ options: {
    db: { type: "string" }, principal: { type: "string" }, machine: { type: "string" },
    enable: { type: "boolean" }, disable: { type: "boolean" }, reason: { type: "string" }, actor: { type: "string" },
  } });
  if (!values.db || !values.principal || !values.machine || !values.actor
    || !/^[a-zA-Z0-9._-]{1,64}$/.test(values.actor)
    || Boolean(values.enable) === Boolean(values.disable) || !validPreferenceReason(values.reason)) {
    throw new Error("usage: --db PATH --principal ID --machine NAME (--enable|--disable) --reason TEXT --actor LABEL");
  }
  const file = lstatSync(values.db);
  const uid = process.getuid?.();
  if (uid === undefined || !file.isFile() || file.isSymbolicLink() || file.uid !== uid || (file.mode & 0o077) !== 0) {
    throw new Error("database must be a private regular file owned by the current Unix user");
  }
  const store = new MachinePreferencesStore(values.db);
  try {
    const change = store.write(values.principal, values.machine, Boolean(values.enable), values.reason, `owner-local:${uid}:${values.actor}`);
    process.stdout.write(JSON.stringify({ principal: values.principal, machine: values.machine, enabled: Boolean(values.enable), change }) + "\n");
  } finally { store.close(); }
} catch (error) {
  process.stderr.write(`machine preference failed: ${error instanceof Error ? error.message : "unknown failure"}\n`);
  process.exitCode = 1;
}
