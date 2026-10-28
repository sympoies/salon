import { isAbsolute, resolve } from "node:path";
import {
  AGENT_CONSOLE_PERMISSIONS,
  type AgentConsolePermission,
} from "@agent-console/shared/api";
import { parseBoardRetention, type BoardRetention } from "./board/record.ts";
import { parseHostReader, parseHostReaderWithPath, type HostReader } from "./hostReader.ts";

// One configured `agent-session serve` endpoint. The array keeps machine
// selection data-driven: adding a daemon is a configuration change, not a code
// path.
export interface MachineConfig {
  readonly name: string;
  readonly url: string;
  readonly token: string;
  /** An explicit machine retirement/maintenance switch; never inferred from reachability. */
  readonly active?: boolean;
}

export interface CoordinationRelayConfig {
  readonly machine: string;
  readonly token: string;
  readonly ingress_token: string;
}

export type MessagingSelector = { readonly role: "coordinator" } | { readonly repo_name: string };
export type MessagingRecipient = MessagingSelector;
export interface CrossOwnerMessagingRule {
  readonly from: string;
  readonly to: string;
  readonly recipients: readonly MessagingRecipient[];
  readonly senders?: readonly MessagingSelector[];
}

export interface CrossOwnerSessionSelector {
  readonly machine: string;
  readonly session_id: string;
}
// Lets `viewer` see and message the `owner`'s selected sessions and every
// session they dispatched or launched. Ownership never changes.
export interface CrossOwnerSessionAccessRule {
  readonly owner: string;
  readonly viewer: string;
  readonly sessions: readonly CrossOwnerSessionSelector[];
}

export interface SpeechProviderConfig {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly token: string;
  readonly machine?: string;
}

export const PRINCIPAL_PERMISSIONS = AGENT_CONSOLE_PERMISSIONS;
export type PrincipalPermission = AgentConsolePermission;

export interface PrincipalConfig {
  readonly id: string;
  readonly token: string;
  /** A read-only tester credential issued/revoked through the owner-local SQLite tool. */
  readonly managedCredential?: boolean;
  readonly machines: readonly string[];
  /** Core permissions (PrincipalPermission) and permissions declared by edge extensions. */
  readonly permissions: readonly string[];
  /** Secondary machines enabled by default on a browser/device with no saved choice. */
  readonly defaultVisibleMachines?: readonly string[];
  /** Machine preselected by New session; must also be visible by default or primary. */
  readonly defaultCreateMachine?: string;
}

// Root is a distinct credential identity, never an elevation of an ordinary
// principal. Its session scope follows every registered daemon automatically.
export function isRootPrincipal(principal: PrincipalConfig): boolean {
  return principal.id === "root";
}

export function principalCanAccessMachine(principal: PrincipalConfig, machine: string): boolean {
  return isRootPrincipal(principal) || principal.machines.includes(machine);
}

// Global session visibility does not grant an interactive terminal. Ordinary
// principals retain their existing machine and session-owner authorization.
export function principalCanUseTerminal(principal: PrincipalConfig): boolean {
  return !principal.managedCredential
    && (!isRootPrincipal(principal) || principal.permissions.includes("terminal"));
}

export interface EdgeConfig {
  readonly host: string;
  readonly port: number;
  // The legacy client-facing bearer token. The browser trades it for an httpOnly
  // session cookie; the per-machine tokens above never reach the client.
  // May be empty only in open-access mode; open-access may still carry a token
  // (open mode wins the auth gate, but a set token still works for device auth).
  readonly clientToken: string;
  // Multi-user mode replaces the legacy process-wide client token with stable
  // principals. Tokens are credentials only; durable ownership uses `id`.
  readonly principals: readonly PrincipalConfig[];
  readonly multiUser: boolean;
  readonly accessDbPath: string | null;
  // Skip the client-facing auth gate entirely (AGENT_CONSOLE_NO_AUTH). For a
  // private-network deploy where network access is already the trust boundary and the
  // login token is just friction. The edge still injects each machine's bearer
  // token upstream; only the browser/device gate is removed.
  readonly openAccess: boolean;
  readonly machines: readonly MachineConfig[];
  readonly coordinationRelays?: readonly CoordinationRelayConfig[];
  readonly crossOwnerMessaging?: readonly CrossOwnerMessagingRule[];
  readonly crossOwnerSessionAccess?: readonly CrossOwnerSessionAccessRule[];
  // Edge-reachable ASR services. Host URLs and bearer tokens never reach the UI.
  readonly speechProviders: readonly SpeechProviderConfig[];
  readonly uiDir: string;
  readonly secureCookie: boolean;
  readonly maxAttachmentBytes: number;
  // The host-local usage reader the edge proxies to (`/api/usage`). `null`
  // disables the codex/claude usage panel: the hardened edge container cannot
  // read the host home (where the usage files + API keys live), so unset means
  // "report unreachable", never "read host files". Set via
  // AGENT_CONSOLE_USAGE_URL (+ optional AGENT_CONSOLE_USAGE_TOKEN).
  // AGENT_CONSOLE_USAGE_PATH selects the route: `/usage` (default, a host
  // helper) or `/usage/v1` on `agent-session serve`.
  readonly usage: HostReader | null;
  // Dedicated host-local mutation boundary for earned Codex rate-limit resets.
  // It accepts only an account nickname plus an idempotency UUID; provider
  // credentials remain outside the edge container. AGENT_CONSOLE_CODEX_RESET_PATH
  // selects `/reset` (default, a host helper) or `/codex/reset/v1` on serve.
  readonly codexReset: HostReader | null;
  // The same mutation boundary for Claude limit resets on `agent-session serve`
  // (`/claude/reset/v1`, AGENT_CONSOLE_CLAUDE_RESET_URL/TOKEN/PATH). It accepts
  // only a token-authority profile nickname, a program, and an idempotency UUID;
  // the account's credentials stay on the host that owns them.
  readonly claudeReset: HostReader | null;
  // Guarded restart controller for exactly one configured machine. The host
  // controller owns the fixed systemd target and tmux-preservation checks; the
  // edge forwards only the machine identity and an empty request object.
  // Optional host session-layout store that `GET/PUT /api/layout` proxies to
  // outside multi-user mode; multi-user mode persists layout per principal in
  // access.sqlite and ignores it. `null` disables single-user cross-device
  // order persistence: the route reports unreachable and the UI falls back to
  // per-device localStorage. Set via AGENT_CONSOLE_LAYOUT_URL (+ optional
  // AGENT_CONSOLE_LAYOUT_TOKEN). This is the first read-write member of the
  // host-reader pattern.
  readonly layout: HostReader | null;
  readonly titleSummarizer: TitleSummarizerConfig | null;
  // Session board aggregation (board.sqlite). Unset keeps the board off.
  readonly board?: BoardConfig | null;
}

export interface BoardConfig {
  readonly dbPath: string;
  readonly retention: BoardRetention;
}

export interface TitleSummarizerConfig {
  readonly command: readonly string[];
  readonly timeoutMs: number;
}

type Env = Record<string, string | undefined>;

export function parseCrossOwnerMessaging(raw: string | undefined, principals: readonly PrincipalConfig[]): CrossOwnerMessagingRule[] {
  if (!raw?.trim()) return [];
  const invalid = (): never => { throw new Error("AGENT_CONSOLE_CROSS_OWNER_MESSAGING must contain unique configured owner pairs, explicit recipient selectors and optional nonempty sender selectors"); };
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { return invalid(); }
  if (!Array.isArray(entries)) return invalid();
  const owners = new Set(principals.map(p => p.id));
  const pairs = new Set<string>();
  return entries.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid();
    const v = entry as Record<string, unknown>;
    if (Object.keys(v).some(key => !["from", "to", "recipients", "senders"].includes(key)) || typeof v.from !== "string" || typeof v.to !== "string"
      || !owners.has(v.from) || !owners.has(v.to) || v.from === v.to
      || !Array.isArray(v.recipients) || !v.recipients.length) return invalid();
    const pair = JSON.stringify([v.from, v.to]);
    if (pairs.has(pair)) return invalid();
    pairs.add(pair);
    const selectors = (values: unknown): MessagingSelector[] => {
      if (!Array.isArray(values) || !values.length) return invalid();
      return values.map((value): MessagingSelector => {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return invalid();
        const selector = value as Record<string, unknown>;
        if (selector.role === "coordinator") return { role: "coordinator" };
        if (typeof selector.repo_name === "string" && selector.repo_name.trim().length > 0
          && selector.repo_name.length <= 256) return { repo_name: selector.repo_name };
        return invalid();
      });
    };
    const recipients = selectors(v.recipients);
    return { from: v.from, to: v.to, recipients,
      ...("senders" in v ? { senders: selectors(v.senders) } : {}) };
  });
}

export function parseCrossOwnerSessionAccess(
  raw: string | undefined, machines: readonly MachineConfig[], principals: readonly PrincipalConfig[],
): CrossOwnerSessionAccessRule[] {
  if (!raw?.trim()) return [];
  const invalid = (): never => { throw new Error("AGENT_CONSOLE_CROSS_OWNER_SESSION_ACCESS must contain unique configured owner and viewer pairs and explicit unique machine and session selectors"); };
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { return invalid(); }
  if (!Array.isArray(entries)) return invalid();
  const owners = new Set(principals.map(p => p.id));
  const names = new Set(machines.map(m => m.name));
  const pairs = new Set<string>();
  return entries.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid();
    const v = entry as Record<string, unknown>;
    if (Object.keys(v).some(key => !["owner", "viewer", "sessions"].includes(key)) || typeof v.owner !== "string" || typeof v.viewer !== "string"
      || !owners.has(v.owner) || !owners.has(v.viewer) || v.owner === v.viewer
      || !Array.isArray(v.sessions) || !v.sessions.length) return invalid();
    const pair = JSON.stringify([v.owner, v.viewer]);
    if (pairs.has(pair)) return invalid();
    pairs.add(pair);
    const seen = new Set<string>();
    const sessions = v.sessions.map((value): CrossOwnerSessionSelector => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
      const selector = value as Record<string, unknown>;
      if (Object.keys(selector).length !== 2 || typeof selector.machine !== "string" || !names.has(selector.machine)
        || typeof selector.session_id !== "string" || selector.session_id.trim().length === 0
        || selector.session_id.length > 256) return invalid();
      const key = JSON.stringify([selector.machine, selector.session_id]);
      if (seen.has(key)) return invalid();
      seen.add(key);
      return { machine: selector.machine, session_id: selector.session_id };
    });
    return { owner: v.owner, viewer: v.viewer, sessions };
  });
}

export function parseCoordinationRelays(raw: string | undefined, machines: readonly MachineConfig[], principals: readonly PrincipalConfig[]): CoordinationRelayConfig[] {
  if (!raw?.trim()) return [];
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { throw new Error("AGENT_CONSOLE_COORDINATION_RELAYS must be a JSON array"); }
  if (!Array.isArray(entries)) throw new Error("AGENT_CONSOLE_COORDINATION_RELAYS must be a JSON array");
  if (entries.length && !principals.length) throw new Error("coordination relay requires multi-user ownership");
  const names = new Set(machines.map(m => m.name));
  const seen = new Set<string>();
  const tokens = new Set([...machines.map(m => m.token), ...principals.map(p => p.token)]);
  return entries.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid coordination relay entry");
    const value = entry as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || typeof value.machine !== "string" || !names.has(value.machine) || seen.has(value.machine)
      || !isNonEmptyString(value.token) || !isNonEmptyString(value.ingress_token)
      || Buffer.byteLength(value.token) < 32 || Buffer.byteLength(value.ingress_token) < 32
      || tokens.has(value.token) || tokens.has(value.ingress_token) || value.token === value.ingress_token) throw new Error("coordination relay needs unique machine and dedicated credentials");
    seen.add(value.machine); tokens.add(value.token); tokens.add(value.ingress_token);
    return { machine: value.machine, token: value.token, ingress_token: value.ingress_token };
  });
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
const MAX_CONFIGURED_ATTACHMENT_BYTES = 16 * 1024 * 1024 * 1024;

function parseMaxAttachmentBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_ATTACHMENT_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONFIGURED_ATTACHMENT_BYTES) {
    throw new Error(
      `AGENT_CONSOLE_MAX_ATTACHMENT_BYTES must be an integer from 1 to ${MAX_CONFIGURED_ATTACHMENT_BYTES}`,
    );
  }
  return value;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function parseMachines(raw: string | undefined): MachineConfig[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`AGENT_CONSOLE_MACHINES is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("AGENT_CONSOLE_MACHINES must be a JSON array of {name,url,token}");
  }
  const seen = new Set<string>();
  return parsed.map((entry, idx) => {
    const e = entry as Record<string, unknown>;
    if (!isNonEmptyString(e.name) || !isNonEmptyString(e.url) || !isNonEmptyString(e.token)) {
      throw new Error(`AGENT_CONSOLE_MACHINES[${idx}] must have non-empty name, url, token`);
    }
    if (seen.has(e.name)) {
      throw new Error(`AGENT_CONSOLE_MACHINES has a duplicate machine name: ${e.name}`);
    }
    seen.add(e.name);
    if (e.active !== undefined && typeof e.active !== "boolean") throw new Error(`AGENT_CONSOLE_MACHINES[${idx}].active must be a boolean`);
    return { name: e.name, url: e.url.replace(/\/+$/, ""), token: e.token,
      ...(e.active === undefined ? {} : { active: e.active as boolean }) };
  });
}

export function parseSpeechProviders(raw: string | undefined, machines: readonly MachineConfig[]): SpeechProviderConfig[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_CONSOLE_SPEECH_PROVIDERS must be a JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("AGENT_CONSOLE_SPEECH_PROVIDERS must be a JSON array");
  const ids = new Set<string>();
  const machineNames = new Set(machines.map((machine) => machine.name));
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`AGENT_CONSOLE_SPEECH_PROVIDERS[${index}] must be an object`);
    }
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== "string" || !SAFE_PRINCIPAL_ID.test(value.id) || ids.has(value.id)) {
      throw new Error(`AGENT_CONSOLE_SPEECH_PROVIDERS[${index}].id is invalid or duplicate`);
    }
    if (!isNonEmptyString(value.label) || value.label.length > 80 || !isNonEmptyString(value.token)) {
      throw new Error(`AGENT_CONSOLE_SPEECH_PROVIDERS[${index}] needs a label and token`);
    }
    if (typeof value.url !== "string") throw new Error(`AGENT_CONSOLE_SPEECH_PROVIDERS[${index}].url is invalid`);
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      throw new Error(`AGENT_CONSOLE_SPEECH_PROVIDERS[${index}].url is invalid`);
    }
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    ) {
      throw new Error(`AGENT_CONSOLE_SPEECH_PROVIDERS[${index}].url must be HTTPS or loopback HTTP origin`);
    }
    if (value.machine !== undefined && (typeof value.machine !== "string" || !machineNames.has(value.machine))) {
      throw new Error(`AGENT_CONSOLE_SPEECH_PROVIDERS[${index}].machine is unknown`);
    }
    ids.add(value.id);
    return {
      id: value.id,
      label: value.label,
      url: url.origin,
      token: value.token,
      ...(value.machine === undefined ? {} : { machine: value.machine }),
    };
  });
}

const SAFE_PRINCIPAL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PRINCIPAL_PERMISSION_SET = new Set<string>(PRINCIPAL_PERMISSIONS);

export function parsePrincipals(
  raw: string | undefined,
  machines: readonly MachineConfig[],
  extraPermissions: readonly string[] = [],
): PrincipalConfig[] {
  const knownPermissions = new Set<string>([...PRINCIPAL_PERMISSION_SET, ...extraPermissions]);
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`AGENT_CONSOLE_PRINCIPALS is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("AGENT_CONSOLE_PRINCIPALS must be a non-empty JSON array");
  }
  const configuredMachines = new Set(machines.map((machine) => machine.name));
  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`AGENT_CONSOLE_PRINCIPALS[${index}] must be an object`);
    }
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== "string" || !SAFE_PRINCIPAL_ID.test(value.id)) {
      throw new Error(`AGENT_CONSOLE_PRINCIPALS[${index}].id is invalid`);
    }
    if (value.managedCredential !== undefined && typeof value.managedCredential !== "boolean") {
      throw new Error("managedCredential must be boolean");
    }
    const managed = value.managedCredential === true;
    if (managed && (!/^tester-[a-z0-9][a-z0-9._-]{0,56}$/.test(value.id) || value.token !== undefined)) {
      throw new Error("managed credentials require a tester- principal and no configured token");
    }
    if (!managed && !isNonEmptyString(value.token)) {
      throw new Error(`AGENT_CONSOLE_PRINCIPALS[${index}].token must be non-empty`);
    }
    const token = managed ? "" : value.token as string;
    if (seenIds.has(value.id)) throw new Error(`duplicate principal id: ${value.id}`);
    if (!managed && seenTokens.has(token)) throw new Error("principal access tokens must be unique");
    if (!Array.isArray(value.machines) || !value.machines.every(isNonEmptyString)) {
      throw new Error(`AGENT_CONSOLE_PRINCIPALS[${index}].machines must be a string array`);
    }
    if (!Array.isArray(value.permissions) || !value.permissions.every(isNonEmptyString)) {
      throw new Error(`AGENT_CONSOLE_PRINCIPALS[${index}].permissions must be a string array`);
    }
    const allowedMachines = [...new Set(value.machines)];
    const permissions = [...new Set(value.permissions)];
    if (managed && permissions.length !== 0) {
      throw new Error("managed tester principals are read-only and require empty permissions");
    }
    if (allowedMachines.length !== value.machines.length) {
      throw new Error(`AGENT_CONSOLE_PRINCIPALS[${index}].machines contains duplicates`);
    }
    if (permissions.length !== value.permissions.length) {
      throw new Error(`AGENT_CONSOLE_PRINCIPALS[${index}].permissions contains duplicates`);
    }
    for (const name of allowedMachines) {
      if (!configuredMachines.has(name)) {
        throw new Error(`principal ${value.id} references unknown machine: ${name}`);
      }
    }
    let defaultVisibleMachines: string[] | undefined;
    if (value.defaultVisibleMachines !== undefined) {
      if (!Array.isArray(value.defaultVisibleMachines) || !value.defaultVisibleMachines.every(isNonEmptyString)) {
        throw new Error(`AGENT_CONSOLE_PRINCIPALS[${index}].defaultVisibleMachines must be a string array`);
      }
      defaultVisibleMachines = [...new Set(value.defaultVisibleMachines)];
      if (defaultVisibleMachines.length !== value.defaultVisibleMachines.length) {
        throw new Error(`AGENT_CONSOLE_PRINCIPALS[${index}].defaultVisibleMachines contains duplicates`);
      }
      if (defaultVisibleMachines.some((name) => !allowedMachines.includes(name))) {
        throw new Error(`principal ${value.id} defaultVisibleMachines must be in its machine grants`);
      }
    }
    let defaultCreateMachine: string | undefined;
    if (value.defaultCreateMachine !== undefined) {
      if (!isNonEmptyString(value.defaultCreateMachine) || !allowedMachines.includes(value.defaultCreateMachine)) {
        throw new Error(`principal ${value.id} defaultCreateMachine must be in its machine grants`);
      }
      const primaryMachine = machines.find((machine) => allowedMachines.includes(machine.name))?.name;
      if (value.defaultCreateMachine !== primaryMachine && !defaultVisibleMachines?.includes(value.defaultCreateMachine)) {
        throw new Error(`principal ${value.id} defaultCreateMachine must be visible by default`);
      }
      defaultCreateMachine = value.defaultCreateMachine;
    }
    for (const permission of permissions) {
      if (!knownPermissions.has(permission)) {
        throw new Error(`principal ${value.id} has unknown permission: ${permission}`);
      }
    }
    seenIds.add(value.id);
    if (!managed) seenTokens.add(token);
    return {
      id: value.id,
      token,
      ...(managed ? { managedCredential: true } : {}),
      machines: allowedMachines,
      permissions,
      ...(defaultVisibleMachines === undefined ? {} : { defaultVisibleMachines }),
      ...(defaultCreateMachine === undefined ? {} : { defaultCreateMachine }),
    };
  });
}

// Narrow the configured machines to a client-supplied allowlist (the
// `?machines=` query on /api/sessions). A null param (absent) means "all
// machines" — backward compatible. A present param (even empty) is an explicit
// allowlist: only configured machines whose name appears are kept, in config
// order, so a client that has disabled a spoke (e.g. a laptop) simply omits it and the
// edge never connects to it. Unknown names are ignored.
export function selectMachines(all: readonly MachineConfig[], param: string | null): MachineConfig[] {
  if (param === null) {
    return [...all];
  }
  const wanted = new Set(
    param
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  return all.filter((m) => wanted.has(m.name));
}

export function parseTitleSummarizer(raw: string | undefined, timeoutRaw?: string): TitleSummarizerConfig | null {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`AGENT_CONSOLE_TITLE_SUMMARIZER must be a JSON argv array: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isNonEmptyString)) {
    throw new Error("AGENT_CONSOLE_TITLE_SUMMARIZER must be a non-empty JSON array of non-empty strings");
  }
  const timeoutMs = Number(timeoutRaw ?? "8000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("AGENT_CONSOLE_TITLE_SUMMARIZER_TIMEOUT_MS must be a positive number");
  }
  return { command: parsed, timeoutMs };
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

// Opt-in: the board aggregator runs only when AGENT_CONSOLE_BOARD_DB names an
// absolute board.sqlite path. The retention is validated even when it is off so
// a typo fails at startup rather than when the board is enabled.
export function parseBoard(env: Env): BoardConfig | null {
  const retention = parseBoardRetention(env.AGENT_CONSOLE_BOARD_RETENTION);
  const dbPath = (env.AGENT_CONSOLE_BOARD_DB ?? "").trim();
  if (!dbPath) return null;
  if (!isAbsolute(dbPath)) throw new Error("AGENT_CONSOLE_BOARD_DB must be an absolute path");
  return { dbPath, retention };
}

export interface LoadConfigOptions {
  /** Permissions declared by the distribution's edge extensions. */
  readonly extraPermissions?: readonly string[];
}

export function loadConfig(env: Env, options: LoadConfigOptions = {}): EdgeConfig {
  const openAccess = truthy(env.AGENT_CONSOLE_NO_AUTH);
  const clientToken = env.AGENT_CONSOLE_TOKEN ?? "";
  const machines = parseMachines(env.AGENT_CONSOLE_MACHINES);

  const principals = parsePrincipals(env.AGENT_CONSOLE_PRINCIPALS, machines, options.extraPermissions);
  const multiUser = principals.length > 0;
  const accessDbPath = (env.AGENT_CONSOLE_STATE_DB ?? "").trim();
  if (multiUser && openAccess) {
    throw new Error("AGENT_CONSOLE_NO_AUTH cannot be enabled with AGENT_CONSOLE_PRINCIPALS");
  }
  if (multiUser && clientToken !== "") {
    throw new Error("AGENT_CONSOLE_TOKEN cannot be combined with AGENT_CONSOLE_PRINCIPALS");
  }
  if ((multiUser && !accessDbPath) || (accessDbPath && !isAbsolute(accessDbPath))) {
    throw new Error("AGENT_CONSOLE_STATE_DB must be an absolute path (required in multi-user mode)");
  }
  // The client token is required unless open-access mode is explicitly enabled.
  if (!multiUser && !openAccess && !isNonEmptyString(clientToken)) {
    throw new Error("AGENT_CONSOLE_TOKEN is required (or set AGENT_CONSOLE_NO_AUTH=1 for a private-network open deploy)");
  }
  const defaultUiDir = resolve(import.meta.dirname, "../../ui/dist");
  return {
    host: env.AGENT_CONSOLE_EDGE_HOST ?? "127.0.0.1",
    port: Number(env.AGENT_CONSOLE_EDGE_PORT ?? "8790"),
    clientToken,
    principals,
    multiUser,
    accessDbPath: accessDbPath || null,
    openAccess,
    machines,
    coordinationRelays: parseCoordinationRelays(env.AGENT_CONSOLE_COORDINATION_RELAYS, machines, principals),
    crossOwnerMessaging: parseCrossOwnerMessaging(env.AGENT_CONSOLE_CROSS_OWNER_MESSAGING, principals),
    crossOwnerSessionAccess: parseCrossOwnerSessionAccess(env.AGENT_CONSOLE_CROSS_OWNER_SESSION_ACCESS, machines, principals),
    speechProviders: parseSpeechProviders(env.AGENT_CONSOLE_SPEECH_PROVIDERS, machines),
    uiDir: env.AGENT_CONSOLE_UI_DIR ?? defaultUiDir,
    // Fail closed on cookie security: the deploy is HTTPS-only behind
    // a TLS reverse proxy, so the session cookie carries `Secure` by default.
    // Local http dev must opt out with AGENT_CONSOLE_INSECURE_COOKIE=1.
    secureCookie: !truthy(env.AGENT_CONSOLE_INSECURE_COOKIE),
    maxAttachmentBytes: parseMaxAttachmentBytes(env.AGENT_CONSOLE_MAX_ATTACHMENT_BYTES),
    usage: parseHostReaderWithPath(env, "USAGE"),
    codexReset: parseHostReaderWithPath(env, "CODEX_RESET"),
    claudeReset: parseHostReaderWithPath(env, "CLAUDE_RESET"),
    layout: parseHostReader(env, "LAYOUT"),
    titleSummarizer: parseTitleSummarizer(
      env.AGENT_CONSOLE_TITLE_SUMMARIZER,
      env.AGENT_CONSOLE_TITLE_SUMMARIZER_TIMEOUT_MS,
    ),
    board: parseBoard(env),
  };
}
