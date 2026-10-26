import {normalizeSessionRole} from "@agent-console/shared/lineage";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OUTSIDE_COORDINATOR_TREE, type AccessStore, type SessionStartMark } from "./accessStore.ts";
import { bearerToken, timingSafeEqualStr } from "./auth.ts";
import type { CrossOwnerMessagingRule, EdgeConfig, MachineConfig, MessagingSelector, PrincipalConfig } from "./config.ts";
import { readJsonBody, sendJson } from "./http.ts";
import { BoardQueryError } from "./board/query.ts";
import { boardViewForRequest } from "./board/routes.ts";
import type { BoardService } from "./board/service.ts";

const MESSAGE_SCHEMA_V1 = "agent-session.remote-message.v1";
const MESSAGE_SCHEMA_V2 = "agent-session.remote-message.v2";
const CATEGORIES = new Set(["uncategorized", "progress", "handoff", "blocker", "decision", "report"]);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_FORWARD_HOPS = 8;
const MAX_RECIPIENT_TRANSFERS = 8;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TTL_SECONDS = 7 * 24 * 3600;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
interface Identity { machine: string; session_id: string; session_incarnation: string }
interface Envelope {
  schema_version: typeof MESSAGE_SCHEMA_V1 | typeof MESSAGE_SCHEMA_V2;
  message_id: string;
  from: Identity;
  to: Identity;
  body: string;
  body_sha256: string;
  created_at_epoch: number;
  expires_at_epoch: number;
  reply_to?: string | null;
  reply_depth: number;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identity(value: unknown): Identity | null {
  const entry = object(value);
  // Machine labels are inventory identities, not session identifiers. Existing
  // configured labels such as user@host retain their exact spelling; routing
  // and authorization below require an exact configured inventory match.
  if (!entry || Object.keys(entry).length !== 3
    || typeof entry.machine !== "string" || entry.machine.length === 0 || Buffer.byteLength(entry.machine) > 128
    || ![entry.session_id, entry.session_incarnation].every(v => typeof v === "string" && SAFE_ID.test(v))) return null;
  return entry as unknown as Identity;
}
function exactKeys(entry: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(entry).length === keys.length && keys.every(key => Object.hasOwn(entry, key));
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return left.machine === right.machine && left.session_id === right.session_id && left.session_incarnation === right.session_incarnation;
}
function epoch(value: unknown): value is number {
  return Number.isSafeInteger(value);
}
function serviceOrigin(value: unknown): boolean {
  const origin = object(value);
  return !!origin && exactKeys(origin, ["machine", "service_id", "service_generation"])
    && typeof origin.machine === "string" && origin.machine.length > 0 && Buffer.byteLength(origin.machine) <= 128
    && [origin.service_id, origin.service_generation].every(value => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value));
}
// Historical identities are untrusted daemon-attested provenance. Only the
// immediate envelope sender/recipient participate in ownership and live checks.
function validForwarding(value: unknown, entry: Record<string, unknown>, now: number): boolean {
  const root = object(value);
  if (!root || !exactKeys(root, ["attestation", "original_message_id", "original_sender", "original_recipient",
    "original_created_at_epoch", "original_expires_at_epoch", "body_sha256", "hops"])
    || root.attestation !== "forwarder" || typeof root.original_message_id !== "string" || !UUID.test(root.original_message_id)
    || root.body_sha256 !== entry.body_sha256
    || !epoch(root.original_created_at_epoch) || !epoch(root.original_expires_at_epoch)
    || root.original_created_at_epoch > now + 60 || root.original_expires_at_epoch <= root.original_created_at_epoch
    || root.original_expires_at_epoch - root.original_created_at_epoch > MAX_TTL_SECONDS
    || (entry.expires_at_epoch as number) > root.original_expires_at_epoch
    || !Array.isArray(root.hops) || root.hops.length === 0 || root.hops.length > MAX_FORWARD_HOPS) return false;
  const originalSender = identity(root.original_sender);
  const originalRecipient = identity(root.original_recipient);
  if ((!originalSender && !serviceOrigin(root.original_sender)) || !originalRecipient) return false;
  const participants: Identity[] = originalSender ? [originalSender, originalRecipient] : [originalRecipient];
  let previousRecipient = originalRecipient;
  let previousTime = root.original_created_at_epoch;
  let transferCount = 0;
  let lastTransfer: { messageId: string; revision: number } | null = null;
  for (const [index, value] of root.hops.entries()) {
    const hop = object(value);
    if (!hop || !exactKeys(hop, ["source_message_id", "source_revision", "forwarder", "recipient", "forwarded_at_epoch",
      ...(Object.hasOwn(hop, "recipient_transfers") ? ["recipient_transfers"] : [])])
      || typeof hop.source_message_id !== "string" || !UUID.test(hop.source_message_id)
      || (index === 0 && hop.source_message_id !== root.original_message_id)
      || !Number.isSafeInteger(hop.source_revision) || (hop.source_revision as number) < 1
      || !epoch(hop.forwarded_at_epoch) || hop.forwarded_at_epoch < previousTime || hop.forwarded_at_epoch > now + 60) return false;
    if (lastTransfer && (hop.source_message_id !== lastTransfer.messageId
      || (hop.source_revision as number) <= lastTransfer.revision)) return false;
    const forwarder = identity(hop.forwarder);
    const recipient = identity(hop.recipient);
    if (!forwarder || !recipient || !sameIdentity(forwarder, previousRecipient)
      || participants.some(prior => prior.machine === recipient.machine && prior.session_id === recipient.session_id)) return false;
    if (index === root.hops.length - 1
      && (!sameIdentity(forwarder, entry.from as Identity) || !sameIdentity(recipient, entry.to as Identity))) return false;
    participants.push(recipient);
    previousRecipient = recipient;
    previousTime = hop.forwarded_at_epoch;
    lastTransfer = null;
    const transfers = Object.hasOwn(hop, "recipient_transfers") ? hop.recipient_transfers : [];
    if (!Array.isArray(transfers) || (transferCount += transfers.length) > MAX_RECIPIENT_TRANSFERS
      // Incoming claims cannot retarget the authenticated destination. Carry
      // evidence is appended locally by the receiving controller, then retained
      // on historical hops when the resumed recipient forwards a fresh hop.
      || (index === root.hops.length - 1 && transfers.length !== 0)) return false;
    for (const value of transfers) {
      const transfer = object(value);
      if (!transfer || !exactKeys(transfer, ["message_id", "from", "to", "controller", "source_revision", "transferred_at_epoch"])
        || typeof transfer.message_id !== "string" || !UUID.test(transfer.message_id)
        || !Number.isSafeInteger(transfer.source_revision) || (transfer.source_revision as number) < 1
        || !epoch(transfer.transferred_at_epoch) || transfer.transferred_at_epoch < previousTime
        || transfer.transferred_at_epoch > now + 60) return false;
      const from = identity(transfer.from);
      const to = identity(transfer.to);
      const controller = identity(transfer.controller);
      if (!from || !to || !controller || !sameIdentity(from, previousRecipient)
        || from.machine !== to.machine || from.session_id !== to.session_id
        || from.session_incarnation === to.session_incarnation
        || !sameIdentity(controller, forwarder) || controller.machine !== from.machine
        || (lastTransfer && (transfer.message_id !== lastTransfer.messageId
          || (transfer.source_revision as number) <= lastTransfer.revision))) return false;
      previousRecipient = to;
      previousTime = transfer.transferred_at_epoch;
      lastTransfer = { messageId: transfer.message_id, revision: transfer.source_revision as number };
    }
  }
  return true;
}
function envelope(value: unknown): Envelope | null {
  const entry = object(value);
  if (!entry) return null;
  const v2 = entry.schema_version === MESSAGE_SCHEMA_V2;
  const keys = ["schema_version", "message_id", "from", "to", "body", "body_sha256", "created_at_epoch", "expires_at_epoch", "reply_to", "reply_depth"];
  if (v2) keys.push("category", "forwarding");
  if (Object.keys(entry).some(key => !keys.includes(key))) return null;
  const now = Math.floor(Date.now() / 1000);
  if ((entry.schema_version !== MESSAGE_SCHEMA_V1 && !v2) || typeof entry.message_id !== "string" || !UUID.test(entry.message_id)
    || !identity(entry.from) || !identity(entry.to)
    || typeof entry.body !== "string" || Buffer.byteLength(entry.body) > MAX_BODY_BYTES || entry.body.length === 0
    || typeof entry.body_sha256 !== "string" || createHash("sha256").update(entry.body).digest("hex") !== entry.body_sha256
    || !Number.isSafeInteger(entry.created_at_epoch) || !Number.isSafeInteger(entry.expires_at_epoch)
    || (entry.created_at_epoch as number) > now + 60 || (entry.created_at_epoch as number) < 0
    || (entry.expires_at_epoch as number) <= (entry.created_at_epoch as number)
    || (entry.expires_at_epoch as number) - (entry.created_at_epoch as number) > MAX_TTL_SECONDS
    || !Number.isInteger(entry.reply_depth) || (entry.reply_depth as number) < 0 || (entry.reply_depth as number) > 16
    || (entry.reply_to !== undefined && entry.reply_to !== null && (typeof entry.reply_to !== "string" || !SAFE_ID.test(entry.reply_to)))) return null;
  if (v2 && ((entry.category == null && entry.forwarding == null)
    || (entry.category != null && (typeof entry.category !== "string" || !CATEGORIES.has(entry.category)))
    || (entry.forwarding != null && !validForwarding(entry.forwarding, entry, now)))) return null;
  return entry as unknown as Envelope;
}
class RelayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, string | number>;
  constructor(status: number, code: string, message: string, details?: Record<string, string | number>) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
function fail(status: number, code: string, message: string, details?: Record<string, string | number>): never {
  throw new RelayError(status, code, message, details);
}

// Dedicated bounded transport: neither request/response content nor raw upstream
// errors enter the browser debug ring or the process logger. Redirects cannot
// export the operator/ingress credential to an unconfigured destination.
async function requestJson(machine: MachineConfig, path: string, body?: Envelope, ingressToken?: string, timeoutMs = 10_000): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${machine.url}${path}`, {
      method: body ? "POST" : "GET", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${machine.token}`, ...(body ? { "content-type": "application/json", "x-agent-session-relay-token": ingressToken! } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("response limit"); }
      chunks.push(chunk.value);
    }
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } finally { clearTimeout(timer); }
}
interface Snapshot { sessions: Record<string, unknown>[]; supported: boolean }
async function snapshot(machine: MachineConfig, timeoutMs = 10_000): Promise<Snapshot> {
  try {
    const result = await requestJson(machine, "/sessions", undefined, undefined, timeoutMs);
    const root = object(result.body);
    const data = object(root?.data);
    if (result.status !== 200 || root?.ok !== true || !data || !Array.isArray(data.sessions)) throw new Error("snapshot unavailable");
    return { sessions: data.sessions.map(object).filter((v): v is Record<string, unknown> => v !== null), supported: object(data.coordination)?.remote_messaging_supported === true };
  } catch { return fail(503, "remote-messaging-unavailable", "machine session snapshot is unavailable"); }
}
function messagingUnavailableReason(snapshot: Snapshot, session: Record<string, unknown>): string | null {
  if (!snapshot.supported) return "daemon-unsupported";
  if (!["advisory", "enforce"].includes(String(session.coordination_mode))) return "coordination-disabled";
  if (session.coordination_available !== true) return "coordination-unavailable";
  return null;
}
function supports(snapshot: Snapshot, session: Record<string, unknown>): boolean {
  return messagingUnavailableReason(snapshot, session) === null;
}
// Only native, fixed startup codes are public diagnostics. Never copy a raw
// upstream startup message, additional fields, or an arbitrary failure code.
const STARTUP_FAILURE_CODES = new Set([
  "runtime-helper-unavailable", "agent-binary-unavailable", "working-directory-unavailable",
  "terminal-runtime-create-failed", "app-server-start-failed", "proxy-start-failed",
  "provider-client-exited", "provider-configuration-rejected", "startup-timeout", "startup-exited",
]);
function peerDiagnostics(snapshot: Snapshot, session: Record<string, unknown>) {
  const runtime_status = session.status === "running" || session.status === "stopped" ? session.status : "unknown";
  const reason = messagingUnavailableReason(snapshot, session);
  const startup = object(session.startup);
  const code = startup?.state === "failed" && typeof startup.failure_code === "string"
    && STARTUP_FAILURE_CODES.has(startup.failure_code) ? startup.failure_code : undefined;
  return { runtime_status, messaging_supported: reason === null, messaging_unavailable_reason: reason,
    ...(code ? { startup_failure_code: code } : {}) };
}
const OWNERSHIP_RECOVERY = "refresh sessions; if the conflict persists, ask the maintainer to recover session ownership with scoped import-owner --repair-session";
function grant(store: AccessStore, target: Identity, state?: Snapshot): string {
  const grant = store.sessionGrant(target.machine, target.session_id);
  if (!grant) return fail(403, "ownership-unknown", `session ownership is unknown; ${OWNERSHIP_RECOVERY}`);
  if (grant.incarnation !== target.session_incarnation) {
    const session = state?.sessions.find(s => s.id === target.session_id);
    const resume = object(session?.provider_resume);
    // Only the configured machine's live snapshot can prove a native resume.
    // Advance the existing owner's exact grant; never claim or rebind identity.
    if (!session || session.status !== "running" || session.session_incarnation !== target.session_incarnation
      || !grant.provider || !grant.providerSessionId
      || resume?.provider !== grant.provider || resume.session_id !== grant.providerSessionId
      || !store.advanceSessionIncarnation(grant.principalId, target.machine, target.session_id,
        grant.incarnation, target.session_incarnation)) {
      return fail(409, "session-incarnation-conflict", `session continuity is unproven; ${OWNERSHIP_RECOVERY}`);
    }
  }
  return grant.principalId;
}
function current(snapshot: Snapshot, target: Identity): Record<string, unknown> {
  const session = snapshot.sessions.find(s => s.id === target.session_id);
  if (!session) return fail(404, "message-not-found", "session is unavailable");
  if (session.session_incarnation !== target.session_incarnation) return fail(409, "session-incarnation-conflict", "session incarnation changed");
  if (!supports(snapshot, session)) return fail(422, "remote-messaging-unsupported", "remote messaging is unsupported");
  return session;
}
function principalFor(config: EdgeConfig, store: AccessStore, target: Identity, state?: Snapshot): PrincipalConfig {
  const id = grant(store, target, state);
  const principal = config.principals.find(p => p.id === id);
  if (!principal || !principal.machines.includes(target.machine)) return fail(403, "machine-forbidden", "machine is not permitted");
  return principal;
}

async function ownedSnapshot(config: EdgeConfig, store: AccessStore, target: Identity, machine: MachineConfig): Promise<Snapshot> {
  const owner = store.sessionGrant(target.machine, target.session_id);
  if (!owner) return fail(403, "ownership-unknown", `session ownership is unknown; ${OWNERSHIP_RECOVERY}`);
  if (!config.principals.some(p => p.id === owner.principalId && p.machines.includes(machine.name))) {
    return fail(403, "machine-forbidden", "machine is not permitted");
  }
  return snapshot(machine);
}

// This policy belongs only to mailbox discovery/delivery. Never use it for
// browser access, board visibility, session creation, or transcript access.
function matchesMessagingSelectors(selectors: readonly MessagingSelector[], consoleRole: "coordinator" | null, session: Record<string, unknown>): boolean {
  return selectors.some(selector => "role" in selector
    ? consoleRole === selector.role
    : session.repo_name === selector.repo_name);
}
function rulesForSender(config: EdgeConfig, store: AccessStore, sender: PrincipalConfig, from: Identity, session: Record<string, unknown>): readonly CrossOwnerMessagingRule[] {
  const ownership = store.sessionGrant(from.machine, from.session_id);
  if (!ownership || ownership.incarnation !== from.session_incarnation || ownership.principalId !== sender.id) return [];
  return (config.crossOwnerMessaging ?? []).filter(rule => rule.from === sender.id
    && (!rule.senders || matchesMessagingSelectors(rule.senders, ownership.consoleRole, session)));
}
function mayMessage(config: EdgeConfig, store: AccessStore, sender: PrincipalConfig, from: Identity, sourceSession: Record<string, unknown>, target: Identity, session: Record<string, unknown>): boolean {
  const ownership = store.sessionGrant(target.machine, target.session_id);
  if (!ownership || ownership.incarnation !== target.session_incarnation) return false;
  const recipient = config.principals.find(p => p.id === ownership.principalId);
  if (!recipient || !recipient.machines.includes(target.machine)) return false;
  if (recipient.id === sender.id) return true;
  return rulesForSender(config, store, sender, from, sourceSession).some(rule => rule.to === recipient.id
    && matchesMessagingSelectors(rule.recipients, ownership.consoleRole, session));
}
const DESTINATION_ERRORS = new Set(["session-incarnation-conflict", "message-not-found", "remote-messaging-unsupported", "message-expired", "idempotency-key-conflict", "quota-exceeded", "rate-limited", "remote-message-invalid", "invalid-request", "unauthorized", "coordination-unauthorized", "remote-messaging-unavailable", "delivery-unknown"]);

// Match the daemon CLI's content-free quota projection. Raw destination error
// messages, bodies and additional diagnostics never cross the relay boundary.
function quotaDetails(value: unknown): Record<string, string | number> | undefined {
  const details = object(value);
  if (!details) return undefined;
  const kept: Record<string, string | number> = {};
  for (const key of ["quota", "count", "limit", "host", "side"]) {
    const field = details[key];
    if ((typeof field === "number" && Number.isSafeInteger(field) && field >= 0)
      || (typeof field === "string" && Buffer.byteLength(field) <= 128)) kept[key] = field;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

// Creates a fresh session on `machine` claimed for `principal`, recording the
// start mark `startMark` resolves (its dispatcher, coordinator role, and
// coordinator tree depth), and writes the response, or returns false without
// writing (and without starting the mark lookup) when `session` is not a valid
// create-session body. `lineage` holds the verified lineage, work, and role
// members to forward in the daemon create body. The lookup never rejects.
export type OwnedSessionCreator = (principal: PrincipalConfig, machine: MachineConfig, session: Record<string, unknown>, startMark: () => Promise<SessionStartMark>, lineage: Record<string, unknown>) => Promise<boolean>;
// Starter kinds whose lineage names a parent (session-lineage-work-v1).
// Legacy starter values still require exact-parent authentication.
const PARENTED_STARTERS = new Set(["session", "main-agent"]);

// The session-lineage-work-v1 members of a relayed start. The caller's daemon
// builds `lineage` and `work` from the caller's record; `role` is what the
// caller asked for, and only a root start (a lineage with no parent, from
// `--no-parent`) may declare a coordinator, so a session cannot make one inside
// its own tree. A lineage that names a parent, and every session or
// main-agent lineage, must name the exact calling session (relay machine,
// session id, and incarnation), which the relay bearer and the caller's grant
// have already authenticated, so a caller cannot attribute a session to
// another parent. `root` and `depth` are taken from the caller's daemon. The
// target daemon validates the rest of each member. Absent members (an older
// daemon) are not forwarded.
function relayedLineage(session: Record<string, unknown>, caller: Identity): Record<string, unknown> {
  const forwarded: Record<string, unknown> = {};
  if (session.origin !== undefined) {
    const origin = object(session.origin);
    const parent = object(origin?.parent);
    if (!origin || Object.keys(origin).some(key => key !== "parent") || !parent
      || Object.keys(parent).some(key => key !== "machine" && key !== "session_id")
      || parent.machine !== caller.machine || parent.session_id !== caller.session_id) {
      return fail(400, "origin-invalid", "the origin parent is not the calling session");
    }
    // Origin describes the launcher even for --no-parent starts; it never
    // supplies identity or lineage authority. Rebuild it from the relay caller.
    forwarded.origin = { parent: { machine: caller.machine, session_id: caller.session_id } };
  }
  if (session.lineage !== undefined && session.lineage !== null) {
    const lineage = object(session.lineage);
    const kind = object(lineage?.starter)?.kind;
    if (!lineage || typeof kind !== "string") return fail(400, "lineage-invalid", "invalid session lineage");
    if (PARENTED_STARTERS.has(kind) || (lineage.parent !== null && lineage.parent !== undefined)) {
      const parent = object(lineage.parent);
      if (parent?.machine !== caller.machine || parent.session_id !== caller.session_id
        || parent.session_incarnation !== caller.session_incarnation) {
        return fail(400, "lineage-parent-mismatch", "the lineage parent is not the calling session");
      }
    }
    forwarded.lineage = lineage;
  }
  if (session.work !== undefined && session.work !== null) {
    if (!object(session.work)) return fail(400, "work-ref-invalid", "invalid session work");
    forwarded.work = session.work;
  }
  if (session.role !== undefined) {
    if (session.role !== null && !normalizeSessionRole(session.role)) return fail(400, "role-invalid", "invalid session role");
    if ((session.role === "coordinator" || session.role === "domain-coordinator") && object(forwarded.lineage)?.parent !== null) {
      return fail(400, "role-requires-root", "only a root start may declare the coordinator role");
    }
    forwarded.role = session.role;
  }
  if (session.title_mode !== undefined) {
    if (session.title_mode !== "auto" && session.title_mode !== "pinned") return fail(400, "title-mode-invalid", "invalid title mode");
    forwarded.title_mode = session.title_mode;
  }
  return forwarded;
}
const CREATE_REQUEST_KEYS = ["source_session_id", "source_incarnation", "machine", "session"];
const RESUME_OR_IDENTITY_KEYS = ["id", "provider_resume_id", "resume_id"];

export function isCoordinationRoute(path: string): boolean { return path.startsWith("/api/coordination/"); }
export async function handleCoordinationRelay(config: EdgeConfig, store: AccessStore | null, req: IncomingMessage, res: ServerResponse, url: URL, board: BoardService | null = null, createSession: OwnedSessionCreator | null = null, disabledMachines: (principal: PrincipalConfig) => ReadonlySet<string> = () => new Set(), decorateBoard: (principal: PrincipalConfig, view: import("./board/query.ts").BoardView) => import("./board/query.ts").BoardView = (_principal, view) => view): Promise<void> {
  try {
    const token = bearerToken(req.headers.authorization);
    const relay = token ? config.coordinationRelays?.find(r => timingSafeEqualStr(r.token, token)) : undefined;
    if (!relay) return fail(401, "unauthorized", "daemon relay authentication required");
    if (!store || !config.multiUser) return fail(503, "federation-disabled", "remote messaging is disabled");
    const source = config.machines.find(m => m.name === relay.machine);
    if (!source) return fail(403, "machine-forbidden", "machine is not permitted");
    if (req.method === "GET" && url.pathname === "/api/coordination/peers/v1") {
      if ([...url.searchParams.keys()].some(key => !["source_session_id", "source_incarnation"].includes(key))) return fail(400, "invalid-request", "invalid peer query");
      const from = identity({ machine: relay.machine, session_id: url.searchParams.get("source_session_id"), session_incarnation: url.searchParams.get("source_incarnation") });
      if (!from) return fail(400, "invalid-request", "source identity required");
      const sourceSnapshot = await ownedSnapshot(config, store, from, source);
      const principal = principalFor(config, store, from, sourceSnapshot);
      const sourceSession = current(sourceSnapshot, from);
      const recipientOwners = new Set([principal.id, ...rulesForSender(config, store, principal, from, sourceSession).map(r => r.to)]);
      const candidates = config.machines.filter(m => config.principals.some(p => recipientOwners.has(p.id) && p.machines.includes(m.name))
        && config.coordinationRelays?.some(r => r.machine === m.name));
      const peers = (await Promise.all(candidates.map(async machine => {
        let state: Snapshot;
        try { state = machine.name === source.name ? sourceSnapshot : await snapshot(machine); }
        catch { return []; }
        return state.sessions.flatMap(session => {
          const target = identity({ machine: machine.name, session_id: session.id, session_incarnation: session.session_incarnation });
          if (!target || !recipientOwners.has(store.sessionGrant(target.machine, target.session_id)?.principalId ?? "")) return [];
          try { grant(store, target, state); }
          catch (error) { if (error instanceof RelayError) return []; throw error; }
          if (!mayMessage(config, store, principal, from, sourceSession, target, session)) return [];
          return [{ ...target, ...peerDiagnostics(state, session) }];
        });
      }))).flat();
      sendJson(res, 200, { schema_version: "agent-session.remote-peers.v1", peers });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/coordination/board/v1") {
      // The view is scoped to the principal that owns the calling session, as
      // an exact grant for this relay machine, session, and incarnation. An
      // unattributable caller is refused (ownership-unknown), never served the
      // whole board.
      if (!board) return fail(404, "board-disabled", "the session board is not enabled");
      const caller = identity({ machine: relay.machine, session_id: url.searchParams.get("source_session_id"), session_incarnation: url.searchParams.get("source_incarnation") });
      if (!caller) return fail(400, "board-query-invalid", "source identity required");
      const principal = principalFor(config, store, caller);
      let view: unknown;
      try { view = decorateBoard(principal, boardViewForRequest(board, config, store, principal, url.searchParams, ["source_session_id", "source_incarnation"], false, disabledMachines(principal))); }
      catch (error) { if (error instanceof BoardQueryError) return fail(error.status, error.code, error.message); throw error; }
      sendJson(res, 200, view);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/coordination/sessions/v1") {
      // A managed session starts a child session owned by the principal that
      // owns the caller, as an exact grant for this relay machine, session, and
      // incarnation. The request has no field that names a principal, and a
      // caller without a grant is refused (ownership-unknown). Only fresh
      // sessions are created: the edge assigns the id, and provider resume
      // keeps its own ownership checks on the browser route.
      if (!createSession) return fail(404, "route-not-found", "unknown coordination route");
      const request = object(await readJsonBody(req).catch(() => null));
      if (!request || Object.keys(request).some(key => !CREATE_REQUEST_KEYS.includes(key))) return fail(400, "invalid-request", "invalid session create request");
      const caller = identity({ machine: relay.machine, session_id: request.source_session_id, session_incarnation: request.source_incarnation });
      if (!caller) return fail(400, "invalid-request", "source identity required");
      const session = object(request.session);
      if (!session || RESUME_OR_IDENTITY_KEYS.some(key => Object.hasOwn(session, key))
        || (request.machine !== undefined && (typeof request.machine !== "string" || request.machine.length === 0))) return fail(400, "invalid-request", "invalid session create request");
      const lineage = relayedLineage(session, caller);
      const principal = principalFor(config, store, caller);
      const machineName = request.machine ?? relay.machine;
      const machine = config.machines.find(m => m.name === machineName);
      if (!machine || !principal.machines.includes(machine.name)) return fail(403, "machine-forbidden", "machine is not permitted");
      // A root start (`agent-session start --via-console --no-parent`, such as
      // a coordinator's successor) names no parent in its lineage: the caller only
      // launched it, so it is not marked as dispatched by the caller. A
      // coordinator role (root starts only) makes it depth 0 of its own tree;
      // any other root start is outside every coordinator's tree.
      // Otherwise the caller is recorded as the child's dispatcher, with its
      // repository read best-effort so the mark outlives the caller (a
      // snapshot failure never blocks the create; the mark then has no
      // repository), and the child is one level below the caller in the
      // caller's coordinator tree. The depth is fixed now, so the child keeps
      // its marker after the caller and its own ancestors close.
      const rootStart = object(session.lineage)?.parent === null;
      const startMark = async (): Promise<SessionStartMark> => {
        let repoName: string | undefined;
        try {
          // This display-only lookup runs alongside create, but must settle
          // before its response allows the access database to be closed.
          const name = (await snapshot(source, 1_000)).sessions.find(s => s.id === caller.session_id)?.repo_name;
          if (typeof name === "string" && name.length > 0 && name.length <= 256) repoName = name;
        } catch { /* best effort */ }
        const launcher = { machine: caller.machine, sessionId: caller.session_id, ...(repoName ? { repoName } : {}) };
        if (rootStart) {
          return (lineage.role === "coordinator" || lineage.role === "domain-coordinator")
            ? { launcher, consoleRole: "coordinator", treeDepth: 0 }
            : { launcher, treeDepth: OUTSIDE_COORDINATOR_TREE };
        }
        const callerDepth = store.coordinatorTreeDepth(caller.machine, caller.session_id, repoName);
        return {
          launcher, dispatcher: launcher,
          ...(callerDepth !== null ? { treeDepth: callerDepth + 1 } : {}),
        };
      };
      if (!await createSession(principal, machine, session, startMark, lineage)) return fail(400, "invalid-request", "invalid session create request");
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/api/coordination/relay/v1") return fail(404, "route-not-found", "unknown coordination route");
    const payload = envelope(await readJsonBody(req, 128 * 1024).catch(() => null));
    if (!payload) return fail(400, "remote-message-invalid", "invalid remote message envelope");
    if (payload.from.machine !== relay.machine) return fail(403, "origin-forbidden", "source machine does not match relay identity");
    if (payload.expires_at_epoch <= Math.floor(Date.now() / 1000)) return fail(410, "message-expired", "remote message expired");
    const sourceState = await ownedSnapshot(config, store, payload.from, source);
    const principal = principalFor(config, store, payload.from, sourceState);
    const destination = config.machines.find(m => m.name === payload.to.machine);
    const ingress = config.coordinationRelays?.find(r => r.machine === payload.to.machine);
    if (!destination || !ingress) return fail(403, "machine-forbidden", "destination machine is not permitted");
    const sourceSession = current(sourceState, payload.from);
    const recipientOwners = new Set([principal.id, ...rulesForSender(config, store, principal, payload.from, sourceSession).map(r => r.to)]);
    // Admit the sender before foreign incarnation diagnostics or destination
    // I/O. An unknown target is eligible only on an allowed owner's machine.
    const targetGrant = store.sessionGrant(payload.to.machine, payload.to.session_id);
    if (targetGrant ? !recipientOwners.has(targetGrant.principalId)
      : !config.principals.some(p => recipientOwners.has(p.id) && p.machines.includes(payload.to.machine))) {
      return fail(403, "principal-forbidden", "recipient is not permitted");
    }
    const destinationState = destination.name === source.name ? sourceState : await snapshot(destination);
    const recipientPrincipal = principalFor(config, store, payload.to, destinationState);
    // Admit the recipient selector before exposing any foreign lifecycle
    // diagnostics. An unselected repository stays hidden even when unavailable.
    const candidate = destinationState.sessions.find(s => s.id === payload.to.session_id) ?? {};
    if (!mayMessage(config, store, principal, payload.from, sourceSession, payload.to, candidate)) {
      return fail(403, "principal-forbidden", "recipient is not permitted");
    }
    const recipientSession = current(destinationState, payload.to);
    // Ownership can change during asynchronous probes. Recheck immediately
    // before submission; destination independently fences its live incarnation.
    if (principalFor(config, store, payload.from).id !== principal.id
      || grant(store, payload.to) !== recipientPrincipal.id
      || !mayMessage(config, store, principal, payload.from, sourceSession, payload.to, recipientSession)) return fail(403, "principal-forbidden", "recipient is not permitted");
    let result: { status: number; body: unknown };
    try { result = await requestJson(destination, "/coordination/messages/receive/v1", payload, ingress.ingress_token); }
    catch { return fail(502, "delivery-unknown", "remote delivery result is unknown"); }
    const body = object(result.body);
    if (result.status >= 200 && result.status < 300) {
      const recipient = identity(body?.recipient);
      if (body?.schema_version !== "agent-session.remote-delivery.v1" || body.message_id !== payload.message_id || body.state !== "delivered" || !recipient || recipient.machine !== payload.to.machine || recipient.session_id !== payload.to.session_id || recipient.session_incarnation !== payload.to.session_incarnation || !Number.isSafeInteger(body.persisted_at_epoch)) return fail(502, "delivery-unknown", "remote delivery result is unknown");
      sendJson(res, 200, { schema_version: body.schema_version, message_id: body.message_id, state: body.state, recipient, persisted_at_epoch: body.persisted_at_epoch });
      return;
    }
    const destinationError = object(body?.error);
    const code = destinationError?.code;
    if (typeof code === "string" && DESTINATION_ERRORS.has(code)) {
      return fail(result.status, code, "destination rejected remote message",
        code === "quota-exceeded" ? quotaDetails(destinationError?.details) : undefined);
    }
    return fail(502, "delivery-unknown", "remote delivery result is unknown");
  } catch (error) {
    const failure = error instanceof RelayError ? error : new RelayError(500, "relay-error", "remote messaging service error");
    sendJson(res, failure.status, { ok: false, error: { code: failure.code, message: failure.message,
      ...(failure.details ? { details: failure.details } : {}) } });
  }
}
