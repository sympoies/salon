import { pathToFileURL } from "node:url";
import { AccessStore } from "../src/accessStore.ts";
import { loadConfig, type EdgeConfig, type MachineConfig } from "../src/config.ts";
import type { EdgeExtension } from "../src/extensions.ts";
import { daemonFetch } from "../src/upstream.ts";

interface LiveRecord {
  readonly machine: string;
  readonly id: string;
  readonly incarnation: string;
  readonly provider?: string;
  readonly providerSessionId?: string;
  readonly runtimeStartedAt?: string;
}

interface HistoryRecord {
  readonly machine: string;
  readonly id: string;
  readonly provider: string;
  readonly providerSessionId: string;
}

export interface OwnershipImportResult {
  readonly principals: 1;
  readonly machines: number;
  readonly liveSessions: number;
  readonly historySessions: number;
  readonly repairMode?: "check" | "apply";
}

export interface ScopedOwnershipRepair {
  readonly machine: string;
  readonly sessionId: string;
  readonly expectedOldIncarnation: string;
  readonly expectedCurrentIncarnation: string;
  readonly checkOnly?: boolean;
}

export interface ScopedSessionClaim {
  readonly machine: string;
  readonly sessionId: string;
  readonly expectedIncarnation: string;
  readonly checkOnly?: boolean;
}

export interface ScopedProviderImport {
  readonly machine: string;
  readonly provider: string;
  readonly providerSessionId: string;
  readonly checkOnly?: boolean;
}

export function importErrorMessage(error: unknown, mode: "repair" | "provider" | "claim" | "bulk"): string {
  const safeRepairErrors = new Set([
    "multi-user state is not configured", "unknown principal",
    "exact old and current session identities are required", "machine is not allowed for principal",
    "machine is not configured", "daemon inventory request failed",
    "daemon session inventory is invalid", "exact daemon session was not found",
    "daemon session runtime changed", "daemon session has no exact provider identity",
    "session and provider ownership do not match", "session ownership changed during repair",
  ]);
  const safeProviderErrors = new Set([
    "multi-user state is not configured", "unknown principal",
    "machine is not allowed for principal", "machine is not configured",
    "exact provider identity is required", "daemon inventory request failed",
    "daemon history inventory is invalid", "daemon history inventory lacks an exact identity",
    "daemon history cursor did not advance", "exact provider history was not found",
  ]);
  const safeClaimErrors = new Set([
    "multi-user state is not configured", "unknown principal",
    "exact session identity is required", "machine is not allowed for principal",
    "machine is not configured", "daemon inventory request failed",
    "daemon session inventory is invalid", "exact daemon session was not found",
    "daemon session runtime changed", "session is already owned by another principal",
    "provider is already owned by another principal",
  ]);
  const safe = { repair: safeRepairErrors, provider: safeProviderErrors, claim: safeClaimErrors, bulk: new Set<string>() }[mode];
  if (error instanceof Error && safe.has(error.message)) return error.message;
  return mode === "repair" ? "ownership repair failed" : mode === "claim" ? "ownership claim failed" : "ownership import failed";
}

// Grants one running session that has no owner, such as a session an agent
// started with `agent-session start` before owned child sessions existed. The
// exact current incarnation is required, and a session another principal owns
// is refused, never transferred.
export async function claimSessionOwner(
  config: EdgeConfig, principalId: string, scope: ScopedSessionClaim,
): Promise<OwnershipImportResult> {
  if (!config.multiUser || !config.accessDbPath) throw new Error("multi-user state is not configured");
  const principal = config.principals.find((candidate) => candidate.id === principalId);
  if (!principal) throw new Error("unknown principal");
  if (!scope.machine || !scope.sessionId || !scope.expectedIncarnation) {
    throw new Error("exact session identity is required");
  }
  if (!principal.machines.includes(scope.machine)) throw new Error("machine is not allowed for principal");
  const machine = config.machines.find((candidate) => candidate.name === scope.machine);
  if (!machine) throw new Error("machine is not configured");
  const data = daemonData(await daemonFetch(machine, "/sessions"));
  if (!Array.isArray(data.sessions)) throw new Error("daemon session inventory is invalid");
  const matches = data.sessions.filter((value) => (
    value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).id === scope.sessionId
  ));
  if (matches.length !== 1) throw new Error("exact daemon session was not found");
  const session = matches[0] as Record<string, unknown>;
  if (session.status !== "running" || session.session_incarnation !== scope.expectedIncarnation) {
    throw new Error("daemon session runtime changed");
  }
  const resume = session.provider_resume as { provider?: unknown; session_id?: unknown } | undefined;
  const provider = typeof resume?.provider === "string" && resume.provider
    && typeof resume.session_id === "string" && resume.session_id
    ? { provider: resume.provider, providerSessionId: resume.session_id } : undefined;
  const store = new AccessStore(config.accessDbPath);
  try {
    store.claimImport({
      principalId,
      sessions: [{
        principalId, machine: machine.name, sessionId: scope.sessionId, incarnation: scope.expectedIncarnation,
        ...(typeof session.runtime_started_at === "string" ? { runtimeStartedAt: session.runtime_started_at } : {}),
        ...provider,
      }],
      providers: provider ? [{ machine: machine.name, ...provider }] : [],
      histories: [],
    }, scope.checkOnly);
  } finally {
    store.close();
  }
  return {
    principals: 1, machines: 1, liveSessions: 1, historySessions: 0,
    repairMode: scope.checkOnly ? "check" : "apply",
  };
}

export async function importProviderOwner(
  config: EdgeConfig, principalId: string, scope: ScopedProviderImport,
): Promise<OwnershipImportResult> {
  if (!config.multiUser || !config.accessDbPath) throw new Error("multi-user state is not configured");
  const principal = config.principals.find((candidate) => candidate.id === principalId);
  if (!principal) throw new Error("unknown principal");
  if (!principal.machines.includes(scope.machine)) throw new Error("machine is not allowed for principal");
  const machine = config.machines.find((candidate) => candidate.name === scope.machine);
  if (!machine) throw new Error("machine is not configured");
  if (!scope.provider || !scope.providerSessionId) throw new Error("exact provider identity is required");
  const history = await collectExactProviderHistory(machine, scope.provider, scope.providerSessionId);
  if (history.length !== 1) throw new Error("exact provider history was not found");
  const store = new AccessStore(config.accessDbPath);
  try {
    store.claimImport({
      principalId, sessions: [], providers: [],
      histories: history.map((record) => ({
        machine: record.machine, historyId: record.id,
        provider: record.provider, providerSessionId: record.providerSessionId,
      })),
    }, scope.checkOnly);
  } finally {
    store.close();
  }
  return {
    principals: 1, machines: 1, liveSessions: 0, historySessions: 1,
    repairMode: scope.checkOnly ? "check" : "apply",
  };
}

function daemonData(result: { readonly status: number; readonly body: unknown }): Record<string, unknown> {
  const body = result.body as { ok?: unknown; data?: unknown } | undefined;
  if (
    result.status < 200 || result.status >= 300
    || body?.ok === false
    || !body?.data
    || typeof body.data !== "object"
    || Array.isArray(body.data)
  ) throw new Error("daemon inventory request failed");
  return body.data as Record<string, unknown>;
}

async function collectExactProviderHistory(
  machine: MachineConfig, provider: string, providerSessionId: string,
): Promise<HistoryRecord[]> {
  const matches: HistoryRecord[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (;;) {
    const query = new URLSearchParams({ q: providerSessionId, provider, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const data = daemonData(await daemonFetch(machine, `/history/sessions?${query.toString()}`));
    if (!Array.isArray(data.sessions)) throw new Error("daemon history inventory is invalid");
    for (const value of data.sessions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("daemon history inventory is invalid");
      }
      const record = value as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.provider !== "string"
        || typeof record.provider_session_id !== "string") {
        throw new Error("daemon history inventory lacks an exact identity");
      }
      if (record.provider === provider && record.provider_session_id === providerSessionId) {
        matches.push({ machine: machine.name, id: record.id, provider, providerSessionId });
        if (matches.length > 1) throw new Error("exact provider history was not found");
      }
    }
    if (typeof data.next_cursor !== "string" || data.next_cursor.length === 0) break;
    if (seenCursors.has(data.next_cursor)) throw new Error("daemon history cursor did not advance");
    seenCursors.add(data.next_cursor);
    cursor = data.next_cursor;
  }
  return matches;
}

async function collectMachine(machine: MachineConfig): Promise<{
  readonly live: LiveRecord[];
  readonly history: HistoryRecord[];
}> {
  const liveData = daemonData(await daemonFetch(machine, "/sessions"));
  if (!Array.isArray(liveData.sessions)) throw new Error("daemon session inventory is invalid");
  const live = liveData.sessions.map((value): LiveRecord => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("daemon session inventory is invalid");
    }
    const session = value as Record<string, unknown>;
    if (
      typeof session.id !== "string"
      || typeof session.session_incarnation !== "string"
      || session.id.length === 0
      || session.session_incarnation.length === 0
    ) throw new Error("daemon session inventory lacks an exact incarnation");
    const resume = session.provider_resume as { provider?: unknown; session_id?: unknown } | undefined;
    return {
      machine: machine.name,
      id: session.id,
      incarnation: session.session_incarnation,
      ...(typeof session.runtime_started_at === "string"
        ? { runtimeStartedAt: session.runtime_started_at } : {}),
      ...(typeof resume?.provider === "string" && typeof resume.session_id === "string"
        ? { provider: resume.provider, providerSessionId: resume.session_id }
        : {}),
    };
  });

  const history: HistoryRecord[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (;;) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const data = daemonData(await daemonFetch(machine, `/history/sessions?${query.toString()}`));
    if (!Array.isArray(data.sessions)) throw new Error("daemon history inventory is invalid");
    for (const value of data.sessions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("daemon history inventory is invalid");
      }
      const session = value as Record<string, unknown>;
      if (
        typeof session.id !== "string"
        || typeof session.provider !== "string"
        || typeof session.provider_session_id !== "string"
      ) throw new Error("daemon history inventory lacks an exact identity");
      history.push({
        machine: machine.name,
        id: session.id,
        provider: session.provider,
        providerSessionId: session.provider_session_id,
      });
    }
    if (typeof data.next_cursor !== "string" || data.next_cursor.length === 0) break;
    if (seenCursors.has(data.next_cursor)) throw new Error("daemon history cursor did not advance");
    seenCursors.add(data.next_cursor);
    cursor = data.next_cursor;
  }
  return { live, history };
}

export async function importOwner(
  config: EdgeConfig,
  principalId: string,
  repair?: ScopedOwnershipRepair,
): Promise<OwnershipImportResult> {
  if (!config.multiUser || !config.accessDbPath) throw new Error("multi-user state is not configured");
  const principal = config.principals.find((candidate) => candidate.id === principalId);
  if (!principal) throw new Error("unknown principal");
  if (repair) {
    if (
      !repair.machine || !repair.sessionId || !repair.expectedOldIncarnation
      || !repair.expectedCurrentIncarnation
      || repair.expectedOldIncarnation === repair.expectedCurrentIncarnation
    ) throw new Error("exact old and current session identities are required");
    if (!principal.machines.includes(repair.machine)) throw new Error("machine is not allowed for principal");
    const machine = config.machines.find((candidate) => candidate.name === repair.machine);
    if (!machine) throw new Error("machine is not configured");
    const data = daemonData(await daemonFetch(machine, "/sessions"));
    if (!Array.isArray(data.sessions)) throw new Error("daemon session inventory is invalid");
    const matches = data.sessions.filter((value) => (
      value && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).id === repair.sessionId
    ));
    if (matches.length !== 1) throw new Error("exact daemon session was not found");
    const session = matches[0] as Record<string, unknown>;
    if (
      session.status !== "running"
      || session.session_incarnation !== repair.expectedCurrentIncarnation
    ) throw new Error("daemon session runtime changed");
    const resume = session.provider_resume as { provider?: unknown; session_id?: unknown } | undefined;
    if (
      typeof resume?.provider !== "string" || !resume.provider
      || typeof resume.session_id !== "string" || !resume.session_id
    ) throw new Error("daemon session has no exact provider identity");
    const store = new AccessStore(config.accessDbPath);
    try {
      if (
        !store.ownsSession(principalId, machine.name, repair.sessionId, repair.expectedOldIncarnation)
        || !store.ownsProvider(principalId, machine.name, resume.provider, resume.session_id)
      ) throw new Error("session and provider ownership do not match");
      if (!store.repairSessionIncarnation(
        principalId, machine.name, repair.sessionId,
        repair.expectedOldIncarnation, repair.expectedCurrentIncarnation,
        resume.provider, resume.session_id, true, repair.checkOnly,
        typeof session.runtime_started_at === "string" ? session.runtime_started_at : undefined,
      )) throw new Error("session ownership changed during repair");
    } finally {
      store.close();
    }
    return {
      principals: 1, machines: 1, liveSessions: 1, historySessions: 0,
      repairMode: repair.checkOnly ? "check" : "apply",
    };
  }
  const allowed = new Set(principal.machines);
  const machines = config.machines.filter((machine) => allowed.has(machine.name));
  const inventories = [];
  for (const machine of machines) inventories.push(await collectMachine(machine));

  // Inventory is fully validated before the first write. Repeating the same
  // principal import is idempotent; conflicting ownership fails closed.
  const store = new AccessStore(config.accessDbPath);
  try {
    store.claimImport({
      principalId,
      sessions: inventories.flatMap((inventory) => inventory.live.map((session) => ({
          principalId,
          machine: session.machine,
          sessionId: session.id,
          incarnation: session.incarnation,
          ...(session.runtimeStartedAt ? { runtimeStartedAt: session.runtimeStartedAt } : {}),
          ...(session.provider && session.providerSessionId
            ? { provider: session.provider, providerSessionId: session.providerSessionId }
            : {}),
      }))),
      providers: inventories.flatMap((inventory) => inventory.live.flatMap((session) => (
        session.provider && session.providerSessionId
          ? [{
            machine: session.machine,
            provider: session.provider,
            providerSessionId: session.providerSessionId,
          }]
          : []
      ))),
      histories: inventories.flatMap((inventory) => inventory.history.map((history) => ({
        machine: history.machine,
        historyId: history.id,
        provider: history.provider,
        providerSessionId: history.providerSessionId,
      }))),
    });
  } finally {
    store.close();
  }
  return {
    principals: 1,
    machines: machines.length,
    liveSessions: inventories.reduce((sum, inventory) => sum + inventory.live.length, 0),
    historySessions: inventories.reduce((sum, inventory) => sum + inventory.history.length, 0),
  };
}

export function parseImportArgs(args: readonly string[]): {
  readonly principalId: string;
  readonly repair?: ScopedOwnershipRepair;
  readonly providerImport?: ScopedProviderImport;
  readonly sessionClaim?: ScopedSessionClaim;
} {
  const flags = new Map<string, string>();
  let checkOnly = false;
  const allowed = new Set([
    "--principal", "--repair-session", "--machine",
    "--expected-old-incarnation", "--expected-current-incarnation",
    "--import-provider", "--provider-session-id",
    "--claim-session", "--expected-incarnation",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--check") {
      if (checkOnly) throw new Error("exact scoped repair arguments are required");
      checkOnly = true;
      continue;
    }
    const value = args[index + 1];
    if (!flag || !allowed.has(flag) || flags.has(flag) || !value || value.startsWith("--")) {
      throw new Error("exact scoped repair arguments are required");
    }
    flags.set(flag, value);
    index += 1;
  }
  const principalId = flags.get("--principal");
  if (!principalId) throw new Error("--principal is required");
  if (flags.size === 1 && !checkOnly) return { principalId };
  if (flags.has("--import-provider")) {
    const required = ["--principal", "--machine", "--import-provider", "--provider-session-id"];
    if (flags.size !== required.length || !required.every((flag) => flags.has(flag))) {
      throw new Error("exact scoped repair arguments are required");
    }
    return { principalId, providerImport: {
      machine: flags.get("--machine")!, provider: flags.get("--import-provider")!,
      providerSessionId: flags.get("--provider-session-id")!, checkOnly,
    } };
  }
  if (flags.has("--claim-session")) {
    const required = ["--principal", "--machine", "--claim-session", "--expected-incarnation"];
    if (flags.size !== required.length || !required.every((flag) => flags.has(flag))) {
      throw new Error("exact scoped repair arguments are required");
    }
    return { principalId, sessionClaim: {
      machine: flags.get("--machine")!, sessionId: flags.get("--claim-session")!,
      expectedIncarnation: flags.get("--expected-incarnation")!, checkOnly,
    } };
  }
  const repairFlags = ["--principal", "--repair-session", "--machine",
    "--expected-old-incarnation", "--expected-current-incarnation"];
  if (flags.size !== repairFlags.length || !repairFlags.every((flag) => flags.has(flag))) {
    throw new Error("exact scoped repair arguments are required");
  }
  return {
    principalId,
    repair: {
      machine: flags.get("--machine")!,
      sessionId: flags.get("--repair-session")!,
      expectedOldIncarnation: flags.get("--expected-old-incarnation")!,
      expectedCurrentIncarnation: flags.get("--expected-current-incarnation")!,
      checkOnly,
    },
  };
}

// Run the ownership CLI. A distribution entry passes its edge extensions so
// principals may hold the permissions they declare, as with startEdge (#918).
export async function runOwnershipCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { extensions?: readonly EdgeExtension[] } = {},
): Promise<void> {
  let parsed: ReturnType<typeof parseImportArgs>;
  try {
    parsed = parseImportArgs(args);
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "invalid arguments",
    }));
    process.exitCode = 2;
    return;
  }
  try {
    const config = loadConfig(env, { extraPermissions: (options.extensions ?? []).flatMap((extension) => extension.permissions ?? []) });
    const result = parsed.providerImport
      ? await importProviderOwner(config, parsed.principalId, parsed.providerImport)
      : parsed.sessionClaim
        ? await claimSessionOwner(config, parsed.principalId, parsed.sessionClaim)
        : await importOwner(config, parsed.principalId, parsed.repair);
    console.log(JSON.stringify({ ok: true, data: result }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: importErrorMessage(
        error,
        parsed.repair ? "repair" : parsed.providerImport ? "provider" : parsed.sessionClaim ? "claim" : "bulk",
      ),
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runOwnershipCli(process.argv.slice(2), process.env);
}
