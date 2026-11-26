// Console succession stop v1, relay side: the service-issued grant registry routes, the
// delegated successor stop and receipt routes, and read-only reconciliation. The contract is
// the frozen console-succession-stop-v1 specification; see docs/coordination-resume.md.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccessStore, SuccessionStopGrant, SuccessionStopIdentity } from "./accessStore.ts";
import { bearerToken, timingSafeEqualStr } from "./auth.ts";
import type { CoordinationRelayConfig, EdgeConfig, MachineConfig, PrincipalConfig } from "./config.ts";
import { readRawBody } from "./http.ts";
import { OutboxError, type OutboxStore, type OutboxTarget, type StopBinding, type StopOperation, type UnresolvedStop } from "./outboxStore.ts";
import { uniqueKeys } from "./resumeMove.ts";

const MEDIA = "application/vnd.agent-session.console-succession-stop.v1";
const STOP_SCHEMA = "agent-session.console-succession-stop.v1";
const GRANT_SCHEMA = "agent-session.console-succession-stop-delegation.v1";
const BINDING_SCHEMA = "agent-session.console-succession-stop-binding.v1";
const GRANT_ROUTE = "/api/coordination/succession-stop-delegations/v1";
const STOP_ROUTE = /^\/api\/coordination\/sessions\/([^/]+)\/([^/]+)\/stop\/v1(?:\/([^/]+))?$/;
const CALLER_HEADER = "x-agent-session-succession-caller";
const MAX_BODY_BYTES = 8 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_BINDING_CHARS = 2048;
const POST_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const STATUS: Readonly<Record<string, number>> = {
  "invalid-request": 400, unauthorized: 401,
  "succession-stop-delegation-missing": 403, "succession-stop-delegation-revoked": 403, "succession-stop-delegation-mismatch": 403, "succession-stop-owner-mismatch": 403,
  "stop-operation-not-found": 404,
  "session-incarnation-conflict": 409, "session-mailbox-not-empty": 409, "session-already-stopped": 409, "session-stop-busy": 409,
  "outbox-pending-replies": 409, "outbox-lifecycle-pending": 409, "operation-id-conflict": 409, "stop-operation-expired": 409,
  "unsupported-media-type": 415,
  "session-mailbox-unknown": 503, "succession-stop-unavailable": 503, "session-stop-outcome-unknown": 503,
};
// Typed destination refusals that leave no effect and settle an operation as refused.
const DESTINATION_REFUSALS: ReadonlySet<string> = new Set(["session-incarnation-conflict", "session-mailbox-not-empty", "session-stop-busy", "session-mailbox-unknown", "stop-operation-expired"]);
const STORE_REFUSALS: ReadonlySet<string> = new Set(["outbox-pending-replies", "outbox-lifecycle-pending", "session-stop-busy", "operation-id-conflict", "stop-operation-not-found"]);

class Refusal extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, details?: unknown) { super(code); this.code = code; this.details = details; }
}
const refuse = (code: string): never => { throw new Refusal(code); };

export interface SuccessionStopContext {
  readonly config: EdgeConfig;
  readonly store: AccessStore | null;
  readonly outbox: OutboxStore | null;
  readonly disabledMachines: (principal: PrincipalConfig) => ReadonlySet<string>;
}

export function isSuccessionStopGrantPath(pathname: string): boolean {
  return pathname === GRANT_ROUTE || pathname.startsWith(`${GRANT_ROUTE}/`);
}
export function isSuccessionStopPath(pathname: string): boolean { return STOP_ROUTE.test(pathname); }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exactKeys(entry: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(entry).length === keys.length && keys.every(key => Object.hasOwn(entry, key));
}
function nullFree(value: unknown): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) return value.every(nullFree);
  const entry = object(value);
  return entry ? Object.values(entry).every(nullFree) : true;
}
function headerCount(req: IncomingMessage, name: string): number {
  return req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
}
const canonicalUuid = (value: unknown): value is string => typeof value === "string" && CANONICAL_UUID.test(value) && value !== NIL_UUID;
const nowEpoch = () => Math.floor(Date.now() / 1000);

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": MEDIA, "cache-control": "no-store" }).end(JSON.stringify(body));
}
function failure(res: ServerResponse, schema: string, error: unknown): void {
  const refusal = error instanceof Refusal ? error : new Refusal("succession-stop-unavailable");
  respond(res, STATUS[refusal.code] ?? 503, { schema_version: schema, ok: false,
    error: { code: refusal.code, ...(refusal.details !== undefined ? { details: refusal.details } : {}) } });
}
function fromStore(error: unknown): Refusal {
  return error instanceof OutboxError && STORE_REFUSALS.has(error.code) ? new Refusal(error.code) : new Refusal("succession-stop-unavailable");
}

async function readObject(req: IncomingMessage, keys: readonly string[]): Promise<{ entry: Record<string, unknown>; bytes: Buffer }> {
  if (headerCount(req, "content-type") !== 1 || req.headers["content-type"] !== MEDIA) throw new Refusal("unsupported-media-type");
  let bytes: Buffer;
  try { bytes = await readRawBody(req, MAX_BODY_BYTES); } catch { throw new Refusal("invalid-request"); }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const entry = object(JSON.parse(text));
    if (entry && uniqueKeys(text) && nullFree(entry) && exactKeys(entry, keys)) return { entry, bytes };
  } catch { /* fall through */ }
  throw new Refusal("invalid-request");
}
async function requireEmptyBody(req: IncomingMessage): Promise<void> {
  try { await readRawBody(req, 0); } catch { throw new Refusal("invalid-request"); }
}
function tuple(value: unknown): SuccessionStopIdentity | null {
  const entry = object(value);
  if (!entry || !exactKeys(entry, ["machine", "session_id", "session_incarnation"])) return null;
  const { machine, session_id, session_incarnation } = entry;
  if (typeof machine !== "string" || !machine || Buffer.byteLength(machine) > 128 || typeof session_id !== "string" || !SAFE_ID.test(session_id) || !canonicalUuid(session_incarnation)) return null;
  return { machine, session_id, session_incarnation };
}
const sameTuple = (left: SuccessionStopIdentity, right: SuccessionStopIdentity) =>
  left.machine === right.machine && left.session_id === right.session_id && left.session_incarnation === right.session_incarnation;

function secureDestination(machine: MachineConfig): boolean {
  try {
    const url = new URL(machine.url);
    return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}

// ---- grant issue and revoke -------------------------------------------------------------

function issuerAuthorized(config: EdgeConfig, req: IncomingMessage): boolean {
  const token = bearerToken(req.headers.authorization);
  return !!config.successionStopIssuerToken && !!token && headerCount(req, "authorization") === 1 && timingSafeEqualStr(config.successionStopIssuerToken, token);
}

export async function handleSuccessionStopGrant(ctx: SuccessionStopContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    // Every other caller is refused before any selector or body is read.
    if (!issuerAuthorized(ctx.config, req)) throw new Refusal("unauthorized");
    if (!ctx.store) throw new Refusal("succession-stop-unavailable");
    if (url.search) throw new Refusal("invalid-request");
    if (req.method === "POST" && url.pathname === GRANT_ROUTE) {
      const { entry } = await readObject(req, ["schema_version", "delegation_id", "operation_id", "caller", "predecessor"]);
      const caller = tuple(entry.caller), predecessor = tuple(entry.predecessor);
      if (entry.schema_version !== GRANT_SCHEMA || !canonicalUuid(entry.delegation_id) || typeof entry.operation_id !== "string" || !UUID_V7.test(entry.operation_id)
        || !caller || !predecessor || (caller.machine === predecessor.machine && caller.session_id === predecessor.session_id)) throw new Refusal("invalid-request");
      const store = ctx.store;
      const result = store.issueSuccessionStopGrant({ delegation_id: entry.delegation_id, operation_id: entry.operation_id, caller, predecessor }, nowEpoch(),
        () => grantOwner(ctx, store, caller, predecessor));
      if (result.kind === "conflict") throw new Refusal("operation-id-conflict");
      if (result.kind === "mismatch") throw new Refusal("succession-stop-delegation-mismatch");
      if (result.kind === "owner-mismatch") throw new Refusal("succession-stop-owner-mismatch");
      return respond(res, 200, { schema_version: GRANT_SCHEMA, ok: true, data: result.grant });
    }
    const revoke = req.method === "DELETE" && url.pathname.startsWith(`${GRANT_ROUTE}/`) ? url.pathname.slice(GRANT_ROUTE.length + 1) : null;
    if (revoke !== null) {
      await requireEmptyBody(req);
      if (!canonicalUuid(revoke)) throw new Refusal("invalid-request");
      const grant = ctx.store.revokeSuccessionStopGrant(revoke, nowEpoch());
      if (!grant) throw new Refusal("succession-stop-delegation-missing");
      return respond(res, 200, { schema_version: GRANT_SCHEMA, ok: true, data: grant });
    }
    throw new Refusal("invalid-request");
  } catch (error) { failure(res, GRANT_SCHEMA, error); }
}

/** The shared owner of two exact identities, or the reason they cannot be delegated. */
function grantOwner(ctx: SuccessionStopContext, store: AccessStore, caller: SuccessionStopIdentity, predecessor: SuccessionStopIdentity): string | "mismatch" | "owner-mismatch" {
  const relays = ctx.config.coordinationRelays ?? [];
  const callerGrant = store.sessionGrant(caller.machine, caller.session_id), predecessorGrant = store.sessionGrant(predecessor.machine, predecessor.session_id);
  if (!callerGrant || !predecessorGrant || callerGrant.incarnation !== caller.session_incarnation || predecessorGrant.incarnation !== predecessor.session_incarnation) return "mismatch";
  if (callerGrant.principalId !== predecessorGrant.principalId) return "owner-mismatch";
  const principal = ctx.config.principals.find(item => item.id === callerGrant.principalId);
  const disabled = principal ? ctx.disabledMachines(principal) : new Set<string>();
  const usable = (machine: string) => !!principal && principal.machines.includes(machine) && !disabled.has(machine)
    && ctx.config.machines.some(item => item.name === machine && item.active !== false) && relays.some(relay => relay.machine === machine);
  return usable(caller.machine) && usable(predecessor.machine) ? callerGrant.principalId : "mismatch";
}

// ---- successor stop and receipt ---------------------------------------------------------

interface Authorized {
  readonly owner: string;
  readonly grant: SuccessionStopGrant;
  readonly caller: SuccessionStopIdentity;
  readonly predecessor: SuccessionStopIdentity;
  readonly target: OutboxTarget;
  readonly binding: StopBinding;
}

function attestedCaller(req: IncomingMessage, relay: CoordinationRelayConfig): SuccessionStopIdentity {
  const value = req.headers[CALLER_HEADER];
  if (headerCount(req, CALLER_HEADER) !== 1 || typeof value !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(value)) return refuse("succession-stop-delegation-mismatch");
  try {
    const decoded = Buffer.from(value, "base64url");
    const entry = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)));
    if (entry && exactKeys(entry, ["session_id", "session_incarnation"]) && typeof entry.session_id === "string" && SAFE_ID.test(entry.session_id)
      && canonicalUuid(entry.session_incarnation) && decoded.toString("base64url") === value) {
      return { machine: relay.machine, session_id: entry.session_id, session_incarnation: entry.session_incarnation };
    }
  } catch { /* fall through */ }
  return refuse("succession-stop-delegation-mismatch");
}

/**
 * Synchronous on purpose: no await separates the checks from the claim or the downstream
 * request they authorize, so a revocation cannot interleave with them.
 */
function authorize(ctx: SuccessionStopContext, store: AccessStore, outbox: OutboxStore, caller: SuccessionStopIdentity, predecessor: SuccessionStopIdentity,
  operationId: string, receipt: boolean): Authorized {
  const callerGrant = store.sessionGrant(caller.machine, caller.session_id);
  if (!callerGrant || callerGrant.incarnation !== caller.session_incarnation) return refuse("succession-stop-delegation-mismatch");
  const predecessorGrant = store.sessionGrant(predecessor.machine, predecessor.session_id);
  const target: OutboxTarget = { principalId: callerGrant.principalId, machine: predecessor.machine, sessionId: predecessor.session_id, incarnation: predecessor.session_incarnation };
  if (predecessorGrant) {
    if (predecessorGrant.incarnation !== predecessor.session_incarnation) return refuse("succession-stop-delegation-mismatch");
    if (predecessorGrant.principalId !== callerGrant.principalId) return refuse("succession-stop-owner-mismatch");
  } else {
    // After verified removal only the retained original binding stands in, for receipt access.
    let retained = false;
    if (receipt) { try { outbox.stopOperation(target, operationId); retained = true; } catch { /* not retained */ } }
    if (!retained) return refuse("succession-stop-delegation-mismatch");
  }
  const principal = ctx.config.principals.find(item => item.id === callerGrant.principalId);
  const disabled = principal ? ctx.disabledMachines(principal) : new Set<string>();
  if (!principal || ![caller.machine, predecessor.machine].every(machine => principal.machines.includes(machine) && !disabled.has(machine))
    || !ctx.config.machines.some(item => item.name === predecessor.machine && item.active !== false)) return refuse("succession-stop-delegation-mismatch");
  const matches = store.successionStopMatches(principal.id, caller, predecessor);
  const active = matches.filter(item => item.state === "active");
  if (active.length > 1) return refuse("succession-stop-delegation-mismatch");
  const grant = active[0];
  if (!grant) return refuse(matches.length ? "succession-stop-delegation-revoked" : "succession-stop-delegation-missing");
  if (grant.operation_id !== operationId) return refuse("succession-stop-delegation-mismatch");
  return { owner: principal.id, grant, caller, predecessor, target,
    binding: { delegationId: grant.delegation_id, callerMachine: caller.machine, callerSessionId: caller.session_id, callerIncarnation: caller.session_incarnation, retryUntilEpoch: grant.retry_until_epoch } };
}

interface Projection {
  readonly operation_id: string;
  readonly caller: SuccessionStopIdentity;
  readonly predecessor: SuccessionStopIdentity;
  readonly state: "pending" | "unknown" | "refused" | "stopped";
  readonly stop_result: "exited" | "already_stopped" | null;
  readonly code: string | null;
  readonly retry_until_epoch: number;
}
function projection(operationId: string, target: OutboxTarget, op: StopOperation): Projection {
  return { operation_id: operationId,
    caller: { machine: op.callerMachine, session_id: op.callerSessionId, session_incarnation: op.callerIncarnation },
    predecessor: { machine: target.machine, session_id: target.sessionId, session_incarnation: target.incarnation },
    state: op.state, stop_result: op.stopResult, code: op.code, retry_until_epoch: op.retryUntilEpoch };
}

type Classified =
  | { readonly kind: "projection"; readonly value: Projection }
  | { readonly kind: "already-stopped" }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "unknown" };

interface Reply { readonly status: number; readonly type: string | null; readonly body: unknown }

/** Dedicated bounded transport. Redirects are an error: credentials never leave the pinned peer. */
async function exchange(machine: MachineConfig, path: string, headers: Record<string, string>, body: Buffer | null, timeoutMs: number): Promise<Reply | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${machine.url}${path}`, { method: body ? "POST" : "GET", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${machine.token}`, ...headers, ...(body ? { "content-type": MEDIA } : {}) }, ...(body ? { body: body as RequestInit["body"] } : {}) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_REPLY_BYTES) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
    let parsed: unknown = null;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { /* unverifiable */ }
    return { status: response.status, type: response.headers.get("content-type"), body: parsed };
  } catch { return null; } finally { clearTimeout(timer); }
}

function verifiedProjection(value: unknown, operationId: string, target: OutboxTarget, binding: StopBinding): Projection | null {
  const entry = object(value);
  if (!entry || !exactKeys(entry, ["operation_id", "caller", "predecessor", "state", "stop_result", "code", "retry_until_epoch"])) return null;
  const caller = tuple(entry.caller), predecessor = tuple(entry.predecessor);
  if (entry.operation_id !== operationId || !caller || !predecessor || entry.retry_until_epoch !== binding.retryUntilEpoch
    || !sameTuple(caller, { machine: binding.callerMachine, session_id: binding.callerSessionId, session_incarnation: binding.callerIncarnation })
    || !sameTuple(predecessor, { machine: target.machine, session_id: target.sessionId, session_incarnation: target.incarnation })) return null;
  const { state, stop_result, code } = entry;
  if (state !== "pending" && state !== "unknown" && state !== "refused" && state !== "stopped") return null;
  if (state === "stopped" ? stop_result !== "exited" && stop_result !== "already_stopped" : stop_result !== null) return null;
  if (state === "refused" ? typeof code !== "string" || !DESTINATION_REFUSALS.has(code) : code !== null) return null;
  return { operation_id: operationId, caller, predecessor, state, stop_result: stop_result as Projection["stop_result"], code: code as string | null, retry_until_epoch: binding.retryUntilEpoch };
}

/** Trusts nothing but an exact, typed v1 reply bound to this operation. */
function classify(reply: Reply | null, operationId: string, target: OutboxTarget, binding: StopBinding): Classified {
  const root = object(reply?.body);
  if (!reply || reply.type !== MEDIA || !root || root.schema_version !== STOP_SCHEMA) return { kind: "unknown" };
  if (reply.status === 200 && root.ok === true && exactKeys(root, ["schema_version", "ok", "data"])) {
    const value = verifiedProjection(root.data, operationId, target, binding);
    return value ? { kind: "projection", value } : { kind: "unknown" };
  }
  const error = object(root.error);
  if (root.ok !== false || !error || typeof error.code !== "string" || !(["schema_version", "ok", "error"] as const).every(key => Object.hasOwn(root, key)) || Object.keys(root).length !== 3) return { kind: "unknown" };
  if (STATUS[error.code] !== reply.status) return { kind: "unknown" };
  if (error.code === "session-already-stopped") {
    const details = object(error.details);
    const value = details ? verifiedProjection(details.receipt, operationId, target, binding) : null;
    return value?.state === "stopped" && value.stop_result === "already_stopped" ? { kind: "already-stopped" } : { kind: "unknown" };
  }
  if (error.code === "stop-operation-not-found") return { kind: "not-found" };
  return DESTINATION_REFUSALS.has(error.code) ? { kind: "refused", code: error.code } : { kind: "unknown" };
}

function bindingHeader(scope: "stop" | "receipt" | "reconcile", owner: string, operationId: string, target: OutboxTarget, binding: StopBinding, body: Uint8Array): string | null {
  const encoded = Buffer.from(JSON.stringify({ schema_version: BINDING_SCHEMA, scope, delegation_id: binding.delegationId, owner,
    caller_machine: binding.callerMachine, caller_session_id: binding.callerSessionId, caller_session_incarnation: binding.callerIncarnation,
    machine: target.machine, session_id: target.sessionId, session_incarnation: target.incarnation, operation_id: operationId,
    retry_until_epoch: String(binding.retryUntilEpoch), body_sha256: createHash("sha256").update(body).digest("hex") })).toString("base64url");
  return encoded.length <= MAX_BINDING_CHARS ? encoded : null;
}

function destinationFor(config: EdgeConfig, machineName: string): { machine: MachineConfig; ingress: string } | null {
  const machine = config.machines.find(item => item.name === machineName && item.active !== false);
  const ingress = config.coordinationRelays?.find(item => item.machine === machineName)?.ingress_token;
  return machine && ingress && secureDestination(machine) ? { machine, ingress } : null;
}
function destinationHeaders(ingress: string, binding: string): Record<string, string> {
  return { "x-agent-session-relay-token": ingress, "x-agent-session-succession-stop-binding": binding };
}

/** One in-process dispatch or read per operation; a second concurrent caller sees an unresolved outcome. */
const inFlight = new Set<string>();

function readPath(target: OutboxTarget, operationId: string): string {
  return `/sessions/${encodeURIComponent(target.sessionId)}/succession-stop/v1/${operationId}?expected_session_incarnation=${target.incarnation}`;
}
async function readDestination(config: EdgeConfig, owner: string, operationId: string, target: OutboxTarget, binding: StopBinding, scope: "receipt" | "reconcile"): Promise<Classified> {
  const destination = destinationFor(config, target.machine);
  const header = bindingHeader(scope, owner, operationId, target, binding, new Uint8Array());
  if (!destination || !header) return { kind: "unknown" };
  return classify(await exchange(destination.machine, readPath(target, operationId), destinationHeaders(destination.ingress, header), null, READ_TIMEOUT_MS), operationId, target, binding);
}

/** Records what a verified reply establishes. The block is durable before anything is projected. */
function settle(outbox: OutboxStore, operationId: string, target: OutboxTarget, outcome: Classified): void {
  try {
    if (outcome.kind === "already-stopped") outbox.resolveStop(target, operationId, "stopped", { stopResult: "already_stopped" });
    else if (outcome.kind === "refused") outbox.resolveStop(target, operationId, "refused", { code: outcome.code });
    else if (outcome.kind === "projection") {
      const { state, stop_result, code } = outcome.value;
      if (state === "stopped") outbox.resolveStop(target, operationId, "stopped", { stopResult: stop_result! });
      else if (state === "refused") outbox.resolveStop(target, operationId, "refused", { code: code! });
      else outbox.resolveStop(target, operationId, "unknown");
    } else outbox.resolveStop(target, operationId, "unknown");
  } catch { /* the stored operation keeps its state; the next read retries */ }
}

function answer(res: ServerResponse, operationId: string, target: OutboxTarget, op: StopOperation, post: boolean): void {
  const value = projection(operationId, target, op);
  if (!post) return respond(res, 200, { schema_version: STOP_SCHEMA, ok: true, data: value });
  if (op.state === "stopped" && op.stopResult === "already_stopped") throw new Refusal("session-already-stopped", { receipt: value });
  if (op.state === "stopped") return respond(res, 200, { schema_version: STOP_SCHEMA, ok: true, data: value });
  throw new Refusal(op.state === "refused" ? op.code! : "session-stop-outcome-unknown");
}

export async function handleSuccessionStop(ctx: SuccessionStopContext, relay: CoordinationRelayConfig | null, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    if (!relay) throw new Refusal("unauthorized");
    const route = STOP_ROUTE.exec(url.pathname);
    const post = req.method === "POST";
    if (!route || (post ? route[3] !== undefined : req.method !== "GET" || route[3] === undefined)) throw new Refusal("invalid-request");
    const { store, outbox } = ctx;
    if (!store || !outbox || !ctx.config.multiUser) throw new Refusal("succession-stop-unavailable");
    let machine: string, sessionId: string;
    try { machine = decodeURIComponent(route[1]!); sessionId = decodeURIComponent(route[2]!); } catch { return refuse("invalid-request"); }
    if (!machine || Buffer.byteLength(machine) > 128 || !SAFE_ID.test(sessionId)) throw new Refusal("invalid-request");
    let operationId: string, expected: string, raw: Buffer;
    if (post) {
      if (url.search) throw new Refusal("invalid-request");
      const { entry, bytes } = await readObject(req, ["schema_version", "operation_id", "expected_session_incarnation"]);
      if (entry.schema_version !== STOP_SCHEMA || typeof entry.operation_id !== "string" || !UUID_V7.test(entry.operation_id) || !canonicalUuid(entry.expected_session_incarnation)) throw new Refusal("invalid-request");
      operationId = entry.operation_id; expected = entry.expected_session_incarnation; raw = bytes;
    } else {
      const params = [...url.searchParams.keys()];
      const incarnation = url.searchParams.get("expected_session_incarnation");
      if (params.length !== 1 || !canonicalUuid(incarnation) || !UUID_V7.test(route[3]!)) throw new Refusal("invalid-request");
      await requireEmptyBody(req);
      operationId = route[3]!; expected = incarnation; raw = Buffer.alloc(0);
    }
    const predecessor = { machine, session_id: sessionId, session_incarnation: expected };
    const caller = attestedCaller(req, relay);
    const authorized = authorize(ctx, store, outbox, caller, predecessor, operationId, !post);
    const { target, binding, owner } = authorized;
    const settleKey = `${target.machine}\0${target.sessionId}\0${operationId}`;

    if (!post) {
      let op = fromStoreOperation(outbox, target, operationId);
      if (op.state === "pending" || op.state === "unknown") {
        if (!inFlight.has(settleKey)) {
          inFlight.add(settleKey);
          try {
            const outcome = await readDestination(ctx.config, owner, operationId, target, binding, "receipt");
            settle(outbox, operationId, target, outcome);
          } finally { inFlight.delete(settleKey); }
        }
        authorize(ctx, store, outbox, caller, predecessor, operationId, true);
        op = fromStoreOperation(outbox, target, operationId);
      }
      return answer(res, operationId, target, op, false);
    }

    let existed = true;
    try { outbox.stopOperation(target, operationId); } catch (error) { if (error instanceof OutboxError && error.code === "stop-operation-not-found") existed = false; else throw fromStore(error); }
    if (!existed && nowEpoch() >= binding.retryUntilEpoch) throw new Refusal("stop-operation-expired");
    try { outbox.beginStop(target, operationId, binding); } catch (error) { throw fromStore(error); }
    let op = fromStoreOperation(outbox, target, operationId);
    if (op.state === "pending" || op.state === "unknown") {
      if (inFlight.has(settleKey)) throw new Refusal("session-stop-outcome-unknown");
      inFlight.add(settleKey);
      try {
        let outcome: Classified = { kind: "unknown" };
        let send = !existed;
        if (existed) {
          outcome = await readDestination(ctx.config, owner, operationId, target, binding, "receipt");
          // Only a verified absence of this exact ID, before the deadline, at a destination the operator asserts runs v1, permits one more copy under
          // the same fence. The destination deduplicates on the operation ID, so a late first copy cannot add an effect.
          send = outcome.kind === "not-found" && nowEpoch() < binding.retryUntilEpoch && !!ctx.config.successionStopDestinations?.includes(target.machine);
        }
        if (send) {
          const destination = destinationFor(ctx.config, target.machine);
          const header = destination ? bindingHeader("stop", owner, operationId, target, binding, raw) : null;
          outcome = { kind: "unknown" };
          if (destination && header) {
            outcome = classify(await exchange(destination.machine, `/sessions/${encodeURIComponent(target.sessionId)}/succession-stop/v1`,
              destinationHeaders(destination.ingress, header), raw, POST_TIMEOUT_MS), operationId, target, binding);
          }
        }
        settle(outbox, operationId, target, outcome);
      } finally { inFlight.delete(settleKey); }
      // A revocation during the exchange keeps the stored result and projects nothing.
      authorize(ctx, store, outbox, caller, predecessor, operationId, false);
      op = fromStoreOperation(outbox, target, operationId);
    }
    answer(res, operationId, target, op, true);
  } catch (error) { failure(res, STOP_SCHEMA, error); }
}

function fromStoreOperation(outbox: OutboxStore, target: OutboxTarget, operationId: string): StopOperation {
  try { return outbox.stopOperation(target, operationId); } catch (error) { throw fromStore(error); }
}

// ---- reconciliation ---------------------------------------------------------------------

/** Reads every unsettled operation from its pinned destination. Never dispatches a stop. */
export async function reconcileSuccessionStops(config: EdgeConfig, outbox: OutboxStore): Promise<void> {
  let unresolved: UnresolvedStop[];
  try { unresolved = outbox.unresolvedStops(); } catch { return; }
  for (const item of unresolved) {
    const key = `${item.target.machine}\0${item.target.sessionId}\0${item.operationId}`;
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    try {
      // The original durable binding supplies the owner, delegation and deadline; no live grant is consulted.
      const outcome = await readDestination(config, item.target.principalId, item.operationId, item.target, item.binding, "reconcile");
      settle(outbox, item.operationId, item.target, outcome);
    } catch { /* the next pass retries */ } finally { inFlight.delete(key); }
  }
}

/** Runs once at startup and then periodically until the returned function is called. */
export function startSuccessionStopReconciler(config: EdgeConfig, outbox: OutboxStore, intervalMs: number): () => void {
  let running = false;
  let stopped = false;
  const run = () => {
    if (running || stopped) return;
    running = true;
    void reconcileSuccessionStops(config, outbox).finally(() => { running = false; });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
