#!/usr/bin/env node
import { constants, closeSync, fstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TestCredentialStore, validTesterId } from "../src/testCredentials.ts";

export function runTestCredential(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    db: { type: "string" }, principal: { type: "string" }, "out-file": { type: "string" },
  } });
  const [action] = positionals;
  if (positionals.length !== 1 || !["create", "revoke", "audit"].includes(action ?? "")
    || !values.db || !isAbsolute(values.db)
    || (values.principal !== undefined && !validTesterId(values.principal))
    || (action !== "audit" && !values.principal)
    || (action === "create" && (!values["out-file"] || !isAbsolute(values["out-file"])))
    || (action !== "create" && values["out-file"])) {
    throw new Error("invalid arguments");
  }
  const store = new TestCredentialStore(values.db);
  let outputCreated = false;
  try {
    if (action === "create") {
      store.issue(values.principal!, token => {
        const fd = openSync(values["out-file"]!, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        outputCreated = true;
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("unsafe credential output");
          writeFileSync(fd, token + "\n");
        } finally { closeSync(fd); }
      });
      console.log(JSON.stringify({ ok: true, action, principal: values.principal }));
    } else if (action === "revoke") {
      console.log(JSON.stringify({ ok: true, action, principal: values.principal, revoked: store.revoke(values.principal!) }));
    } else {
      console.log(JSON.stringify({ ok: true, audit: store.audit(values.principal) }));
    }
  } catch (error) {
    if (outputCreated) {
      try { unlinkSync(values["out-file"]!); } catch { /* unusable file, never echo it */ }
    }
    throw error;
  } finally { store.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try { runTestCredential(process.argv.slice(2)); }
  catch {
    // SQLite/OS/argument errors can include paths or user input. Fixed output
    // deliberately excludes raw errors, credentials, token hashes and argv.
    console.error("test-credential: operation failed; check action, tester principal, database and private output path");
    process.exitCode = 1;
  }
}
