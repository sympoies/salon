#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { OutboxStore } from "../src/outboxStore.ts";
import { applyLegacyLifecycleRepair, planLegacyLifecycleRepair } from "../src/outboxLifecycleRepair.ts";

function privateFile(path: string): void {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) {
    throw new Error("input must be a private regular file owned by the current Unix user");
  }
}
try {
  const { values } = parseArgs({ options: {
    db: { type: "string" }, machine: { type: "string" }, session: { type: "string" },
    "proof-file": { type: "string" }, "apply-plan": { type: "string" },
  } });
  if (!values.db || !values.machine || !values.session || (values["apply-plan"] && !values["proof-file"])) {
    throw new Error("usage: --db PATH --machine NAME --session ID [--proof-file PATH [--apply-plan PATH]]");
  }
  for (const path of [values.db, values["proof-file"], values["apply-plan"]]) if (path) privateFile(path);
  const store = new OutboxStore(values.db);
  try {
    if (!values["proof-file"]) {
      process.stdout.write(JSON.stringify({ fence: store.lifecycle(values.machine, values.session) ?? null }) + "\n");
    } else {
      const proof = readFileSync(values["proof-file"], "utf8");
      if (values["apply-plan"]) {
        applyLegacyLifecycleRepair(store, values.machine, values.session, proof, readFileSync(values["apply-plan"], "utf8"));
        process.stdout.write(JSON.stringify({ repaired: true }) + "\n");
      } else {
        process.stdout.write(JSON.stringify(planLegacyLifecycleRepair(store, values.machine, values.session, proof)) + "\n");
      }
    }
  } finally { store.close(); }
} catch {
  // Never echo private file paths, evidence contents or database diagnostics.
  process.stderr.write("Lifecycle repair refused: check the private inputs, verified archive proof and current dry-run plan.\n");
  process.exitCode = 1;
}
