import { forwardHistoryImage } from "./historyImages.ts";
import {isPromptRequestId,isPromptIncarnation} from "@agent-console/shared/prompt-receipt";
import {forwardPromptReceipt} from "./promptReceipts.ts";
import { normalizeOutboxAdmission, normalizeRefusedOutboxAction } from "@agent-console/shared/shared-outbox";
import { OutboxError, OutboxStore, type OutboxTarget } from "./outboxStore.ts";
import { outboxCredentialGeneration, SharedOutboxDispatcher } from "./sharedOutbox.ts";
import { TestCredentialStore, testCredentialHash } from "./testCredentials.ts";
import { normalizeEmergencyShell } from "@agent-console/shared/shell";
import { SharedActivityStreams } from "./sharedActivity.ts";
import { ResourceWatchRegistry } from "./resourceWatch.ts";
import { resourceKey, type ResourceSubscription } from "@agent-console/shared/resources";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { EdgeConfig, MachineConfig, PrincipalConfig, PrincipalPermission } from "./config.ts";
import { PRINCIPAL_PERMISSIONS, isRootPrincipal, principalCanAccessMachine, principalCanUseTerminal, selectMachines } from "./config.ts";
import {
  SESSION_COOKIE,
  SessionStore,
  SESSION_MAX_AGE,
  WsTicketStore,
  parseCookies,
  serializeSetCookie,
  timingSafeEqualStr,
  bearerToken,
  wsProtocolToken,
} from "./auth.ts";
import { matchPath, readJsonBody, requireParams, sendJson, sentErrorEnvelope, streamRequestBody } from "./http.ts";
import { serveStatic } from "./static.ts";
import {
  aggregateSessions,
  daemonFetch,
  machineAdvertisesAgentLaunchProfile,
  type DaemonDebugContext,
  type DaemonResult,
} from "./upstream.ts";
import { MachineHealth } from "./machineHealth.ts";
import { projectRuntimeHealth } from "./runtimeHealth.ts";
import { proxyUpgrade } from "./wsproxy.ts";
import { fetchUsage, scopeProviderHosts } from "./usage.ts";
import {
  normalizeCodexResetAccount,
  normalizeCodexResetIdempotencyKey,
  resetCodexRateLimit,
} from "./codexReset.ts";
import { normalizeClaudeResetRequest, resetClaudeLimit } from "./claudeReset.ts";
import { fetchLayoutOrder, normalizeOrder, normalizeRevision, writeLayoutOrder } from "./layout.ts";
import { summarizeTitleWithDiagnostics } from "./titleSummary.ts";
import {
  ACCOUNT_PROVIDERS,
  ACCOUNT_SWITCH_TIMEOUT_MS,
  TITLE_SUMMARY_PHASES,
  createSessionTimeoutMs,
  isAccountProvider,
  normalizeAccountNickname,
  normalizeAgentLaunchProfileId,
  normalizeSessionWorkspace,
  type TitleSummaryTrace,
} from "@agent-console/shared/api";
import { normalizeSessionTitleState } from "@agent-console/shared/title";
import { projectPublicAgentSession, type SessionDispatchedBy } from "@agent-console/shared/api";
import { SESSION_LINEAGE_SCHEMA } from "@agent-console/shared/lineage";
import {
  MAINTENANCE_SCHEMA_VERSION,
  MAINTENANCE_SCHEMA_VERSION_V2,
  maintenanceActionRequiresSuccessorContract,
  maintenanceContractVersion,
  normalizeSessionMaintenanceActionRequest,
  normalizeSessionMaintenanceActionResult,
  type MaintenanceContractVersion,
  type MaintenanceOperation,
  type SessionMaintenanceActionRequest,
} from "@agent-console/shared/maintenance";
import { DebugEventBuffer, isDebugRoute, requestIdFromHeader } from "./debugEvents.ts";
import { matchApiRoute, routeParam } from "./apiRoutes.ts";
import { createEdgeExtensionRegistry, type EdgeExtension, type EdgeRouteMethod } from "./extensions.ts";
import { createCsrfExempt, forbidCrossOrigin, sameOrigin, sameOriginOrNativeApp } from "./csrf.ts";
import { MachinePreferenceInitializedError, MachinePreferencesStore, applyMachinePreferences, validPreferenceReason } from "./machinePreferences.ts";
import {
  forwardAutoResumeDaemon,
  forwardArchiveDaemon,
  forwardAccountsDaemon,
  forwardSessionAccountDaemon,
  forwardCreateDaemon,
  forwardDaemon,
  forwardDisplayMetadataDaemon,
  forwardFencedStructuredPromptDaemon,
  forwardGlanceDaemon,
  forwardHistoryMessagesDaemon,
  projectHistoryMessagesDaemonData,
  forwardHistoryResumeDaemon,
  forwardHistoryStarDaemon,
  forwardHistorySessionsDaemon,
  forwardMaintenanceActionDaemon,
  forwardMaintenancePreviewDaemon,
  forwardSessionDeleteDaemon,
  forwardSessionRetitleDaemon,
  forwardSessionRetitleReadinessDaemon,
  forwardSessionRetitleV3Daemon,
  forwardSessionRetitleV3ReceiptsDaemon,
  forwardSessionRetitleV3ReadinessDaemon,
  maintenancePreviewFromDaemon,
  type SessionRetitleForwardSummary,
} from "./daemonEnvelope.ts";
import type { HostReader } from "./hostReader.ts";
import { asNonNegativeInt, asString, objectProp } from "./normalize.ts";
import { waitForDrainOrAbort } from "./activityStream.ts";
import { SessionMutationCoordinator } from "./sessionMutationCoordinator.ts";
import {
  AccessStore,
  OUTSIDE_COORDINATOR_TREE,
  publicCoordinatorTree,
  publicDispatchedBy,
  type SessionStartMark,
} from "./accessStore.ts";
import { handleCoordinationRelay, isCoordinationRoute, assertResumeOwnership, resumeFailure, resumeRefusal } from "./coordinationRelay.ts";
import { BoardQueryError } from "./board/query.ts";
import { boardViewForRequest } from "./board/routes.ts";
import { sessionViewerAccess } from "./crossOwnerSessionAccess.ts";
import { openBoardService, type BoardServiceOptions } from "./board/service.ts";
import { normalizeActivityTurnState } from "@agent-console/shared/activity";
import { MAX_SPEECH_BYTES, MAX_SPEECH_DURATION_SECONDS, readSpeechAudio, SpeechRequestError, transcribeSpeech } from "./speech.ts";
import {
  normalizeSessionRetitleRequest,
  normalizeSessionRetitleV3Request,
  sessionRetitleLifecycleOutcome,
} from "@agent-console/shared/session-retitle";

/**
 * A daemon that predates the successor maintenance contract rejects
 * `schema_version` as an unknown field. The rejection happens while decoding the
 * request, so nothing ran and the same request can be replayed under v1.
 */
function daemonRejectedContract(r: DaemonResult, code: string): boolean {
  if (r.status < 400 || r.status >= 500) return false;
  const error = (r.body as { error?: { code?: unknown } } | undefined)?.error;
  return error?.code === code;
}

function maintenanceQuerySuffix(contract: MaintenanceContractVersion): string {
  return contract === MAINTENANCE_SCHEMA_VERSION_V2
    ? `&schema_version=${encodeURIComponent(contract)}`
    : "";
}

function maintenanceRequestUnderV1(
  request: SessionMaintenanceActionRequest,
): SessionMaintenanceActionRequest {
  const { schema_version: _successorOnly, ...v1Request } = request;
  return v1Request;
}

const ORDINARY_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
// The lookup after a thrown create fits inside the callers' margins past the
// create budget: the browser's 10 s and the agent-session CLI's 120 s total.
const FAILED_CREATE_LOOKUP_MS = 5_000;
const FAILED_CREATE_LOOKUP_INTERVAL_MS = 1_000;
const FAILED_CREATE_LOOKUP_REQUEST_MS = 2_000;
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
// DSH history may use one bounded catalog adapter call followed by one bounded
// selected-page enrichment call. Let the daemon return its partial-result
// contract instead of aborting at the ordinary ten-second upstream default.
const HISTORY_DAEMON_TIMEOUT_MS = 25_000;
export const SESSION_RETITLE_PROVIDER_MAX_TIMEOUT_MS = 120_000;
export const SESSION_RETITLE_TIMEOUT_MS = SESSION_RETITLE_PROVIDER_MAX_TIMEOUT_MS + 5_000;
export const SESSION_RETITLE_READINESS_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_PROMPT_BYTES = 16 * 1024;
const MAX_SESSION_INCARNATION_BYTES = 128;

interface FencedStructuredPromptBody {
  readonly request_id?: string;
  readonly require_idle?: boolean;
  readonly text: string;
  readonly expected_session_incarnation: string;
}

function hasUnsafePromptControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 9 || (code >= 11 && code <= 31) || code === 127) return true;
  }
  return false;
}

function hasUnsafeIncarnationControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function fencedStructuredPromptBody(value: unknown): FencedStructuredPromptBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some(key => !["text", "expected_session_incarnation", "request_id", "require_idle"].includes(key))
    || (Object.hasOwn(body, "request_id") && !isPromptRequestId(body.request_id))
    || (Object.hasOwn(body, "require_idle") && typeof body.require_idle !== "boolean")
    || !Object.hasOwn(body, "text")
    || !Object.hasOwn(body, "expected_session_incarnation")
  ) {
    return null;
  }
  const text = body.text;
  const expectedSessionIncarnation = body.expected_session_incarnation;
  if (
    typeof text !== "string"
    || !text.trim()
    || Buffer.byteLength(text, "utf8") > MAX_PROVIDER_PROMPT_BYTES
    || hasUnsafePromptControl(text)
    || typeof expectedSessionIncarnation !== "string"
    || !expectedSessionIncarnation.trim()
    || Buffer.byteLength(expectedSessionIncarnation, "utf8") > MAX_SESSION_INCARNATION_BYTES
    || hasUnsafeIncarnationControl(expectedSessionIncarnation)
  ) {
    return null;
  }
  return { text, expected_session_incarnation: expectedSessionIncarnation,
    ...(Object.hasOwn(body,"request_id") ? {request_id:body.request_id as string} : {}),
    ...(Object.hasOwn(body,"require_idle") ? {require_idle:body.require_idle as boolean} : {}),
  };
}

export interface EdgeServerOptions {
  readonly outboxPollIntervalMs?: number;
  readonly attachmentUploadTimeoutMs?: number;
  readonly ordinaryRequestTimeoutMs?: number;
  readonly failedCreateLookupMs?: number;
  readonly failedCreateLookupIntervalMs?: number;
  readonly attachHealth?: MachineHealth;
  readonly board?: BoardServiceOptions;
  /** Edge extensions from the distribution entry; core passes none. */
  readonly extensions?: readonly EdgeExtension[];
}

export function createEdgeServer(config: EdgeConfig, options: EdgeServerOptions = {}): Server {
  const attachmentUploadTimeoutMs = options.attachmentUploadTimeoutMs ?? ATTACHMENT_UPLOAD_TIMEOUT_MS;
  const ordinaryRequestTimeoutMs = options.ordinaryRequestTimeoutMs ?? ORDINARY_REQUEST_TIMEOUT_MS;
  const failedCreateLookupMs = options.failedCreateLookupMs ?? FAILED_CREATE_LOOKUP_MS;
  const failedCreateLookupIntervalMs = options.failedCreateLookupIntervalMs ?? FAILED_CREATE_LOOKUP_INTERVAL_MS;
  // Validated before anything starts, so a bad extension fails startup.
  const extensions = createEdgeExtensionRegistry(options.extensions ?? []);
  const store = new SessionStore(config.accessDbPath ?? ":memory:");
  const testCredentials = config.multiUser && config.accessDbPath
    && config.principals.some(principal => principal.managedCredential)
    ? new TestCredentialStore(config.accessDbPath) : null;
  const wsTickets = new WsTicketStore();
  const byName = new Map<string, MachineConfig>(config.machines.map((m) => [m.name, m]));
  const debugEvents = new DebugEventBuffer();
  const sessionMutations = new SessionMutationCoordinator<DaemonResult>();
  const accountSwitches = new Set<string>();
  const requestDeadlines = new WeakMap<IncomingMessage, NodeJS.Timeout>();
  const requestPrincipals = new WeakMap<ServerResponse, PrincipalConfig>();
  const accessStore = config.multiUser && config.accessDbPath
    ? new AccessStore(config.accessDbPath, {
      legacyCoordinatorRepositories: extensions.extensions.flatMap(extension => extension.legacyCoordinatorRepositories ?? []),
    })
    : null;
  const machinePreferences = config.accessDbPath ? new MachinePreferencesStore(config.accessDbPath) : null;
  const outboxStore = config.accessDbPath && config.accessDbPath !== ":memory:" ? new OutboxStore(config.accessDbPath) : null;
  const sessionMachinesForReader = (principal: PrincipalConfig, machines: EdgeConfig["machines"]) =>
    machinePreferences ? applyMachinePreferences(machines, machinePreferences.disabled(principal.id)) : machines;
  // Reachability breaker shared across polls so a sleeping/moved spoke (e.g. a laptop)
  // is skipped fast instead of stalling every session-list fan-out.
  const machineHealth = new MachineHealth();
  // Attach has its own breaker: a slow session list must not refuse attaches
  // that would connect, and only a stalled attach connect opens this one.
  const attachHealth = options.attachHealth ?? new MachineHealth();
  const resourceWatches = new ResourceWatchRegistry();
  const activityStreams = new SharedActivityStreams();

  const allMachineNames = config.machines.map((machine) => machine.name);
  // The root-only terminal opt-in must not change legacy/open identity payloads.
  const clientPermissions = new Set<string>([...PRINCIPAL_PERMISSIONS, ...extensions.extensions.flatMap(extension => extension.clientPermissions ?? [])]);
  const allPermissions = [...clientPermissions].filter((permission) => permission !== "terminal");
  const configuredPrincipals = new Map(config.principals.map((principal) => [principal.id, principal]));
  const principalById = (id: string): PrincipalConfig | undefined => {
    const principal = configuredPrincipals.get(id);
    if (!principal?.managedCredential) return principal;
    const fingerprint = testCredentials?.fingerprint(id);
    return fingerprint ? { ...principal, token: fingerprint } : undefined;
  };
  const testerStillActive = (principal: PrincipalConfig): boolean =>
    !principal.managedCredential || testCredentials?.fingerprint(principal.id) === principal.token;
  const managedResponses = new Map<ServerResponse, PrincipalConfig>();
  const guardTesterResponse = (res: ServerResponse, principal: PrincipalConfig): void => {
    if (!principal.managedCredential) return;
    managedResponses.set(res, principal);
    res.once("close", () => managedResponses.delete(res));
    const write = res.write.bind(res);
    res.write = ((...args: Parameters<typeof res.write>) => {
      if (!testerStillActive(principal)) { res.destroy(); return false; }
      return write(...args);
    }) as typeof res.write;
    const end = res.end.bind(res);
    res.end = ((...args: Parameters<typeof res.end>) => {
      if (!testerStillActive(principal)) { res.destroy(); return res; }
      return end(...args);
    }) as typeof res.end;
  };
  // New operations and stream chunks check synchronously; idle streams are
  // disconnected within one poll, including when the owner CLI is a process
  // outside this edge. No restart or cache refresh is needed.
  const testerRevocationTimer = testCredentials ? setInterval(() => {
    for (const [res, principal] of managedResponses) if (!testerStillActive(principal)) res.destroy();
  }, 250) : undefined;
  testerRevocationTimer?.unref();
  const legacyPrincipal: PrincipalConfig = {
    id: "legacy",
    token: config.clientToken,
    machines: allMachineNames,
    permissions: allPermissions,
  };
  const openPrincipal: PrincipalConfig = {
    id: "open-access",
    token: "",
    machines: allMachineNames,
    permissions: allPermissions,
  };
  // A cross-owner viewer acts with the rule owner's rights on the selected
  // sessions. Every ownership write is made for that owner, so the viewer never
  // becomes an owner and the owner keeps full access.
  const viewerAccessFor = (principal: PrincipalConfig) =>
    isRootPrincipal(principal) ? null : sessionViewerAccess(config.crossOwnerSessionAccess, accessStore, principal.id);
  // The principal whose grant authorizes this principal on the session.
  const actingOwnerOf = (principal: PrincipalConfig, machine: string, sessionId: string): string | undefined => {
    if (!accessStore) return undefined;
    if (accessStore.ownsSession(principal.id, machine, sessionId)) return principal.id;
    return viewerAccessFor(principal)?.(machine, sessionId) ? accessStore.sessionGrant(machine, sessionId)?.principalId : undefined;
  };
  const actsForAnotherOwner = (principal: PrincipalConfig, machine: string, sessionId: string) =>
    isRootPrincipal(principal) || actingOwnerOf(principal, machine, sessionId) !== principal.id;
  const principalMayUseSession = (principal: PrincipalConfig, machine: string, sessionId: string, incarnation?: string) => {
    const owner = actingOwnerOf(principal, machine, sessionId);
    return owner !== undefined && Boolean(accessStore?.ownsSession(owner, machine, sessionId, incarnation));
  };
  const outboxAccess = (target: OutboxTarget) => {
    const principal = config.openAccess ? (target.principalId === openPrincipal.id ? openPrincipal : undefined)
      : config.multiUser ? principalById(target.principalId)
      : target.principalId === legacyPrincipal.id ? legacyPrincipal : undefined;
    const machine = byName.get(target.machine);
    if (!principal || principal.managedCredential || !machine || machine.active === false
      || !principalCanAccessMachine(principal, target.machine)
      || machinePreferences?.disabled(principal.id).has(target.machine)
      || (config.multiUser && !isRootPrincipal(principal)
        && !principalMayUseSession(principal, target.machine, target.sessionId, target.incarnation))) return null;
    return { principal, machine };
  };
  const outboxDispatcher = outboxStore ? new SharedOutboxDispatcher({
    store: outboxStore, access: outboxAccess, intervalMs: options.outboxPollIntervalMs,
  }) : null;
  const protectOutboxLifecycle = async (machine: string, sessionId: string, action: () => Promise<DaemonResult>) => {
    outboxStore?.beginLifecycle(machine, sessionId);
    const result = await action();
    const code = (result.body as { error?: { code?: unknown } } | undefined)?.error?.code;
    // These responses reject before any lifecycle action. Uncertain outcomes
    // retain the fence; a later admission must not race deletion of receipts.
    if (result.status === 401 || result.status === 403
      || (result.status >= 400 && result.status < 500 && [
        "invalid-json-body", "invalid-maintenance-action-request", "session-incarnation-mismatch",
      ].includes(String(code)))) outboxStore?.releaseLifecycle(machine, sessionId);
    return result;
  };

  // Root lists every session, so it reads every owner's history too (#935).
  // History writes (star, resume) stay with the owner.
  // A viewer reaches a history through the provider session of a selected session.
  const viewerHistoryOwner = (principal: PrincipalConfig, machine: string, provider: string, providerSessionId: string) => {
    const access = viewerAccessFor(principal);
    return access ? accessStore?.providerSessions(machine, provider, providerSessionId)
      .find(row => access(machine, row.sessionId)) : undefined;
  };
  // Whose provider claim covers a history entry for this principal, or undefined.
  const historyClaimant = (principal: PrincipalConfig, machine: string, provider: string, providerSessionId: string) => {
    if (accessStore?.ownsProvider(principal.id, machine, provider, providerSessionId)) return principal.id;
    const owner = viewerHistoryOwner(principal, machine, provider, providerSessionId)?.principalId;
    return owner !== undefined && accessStore?.ownsProvider(owner, machine, provider, providerSessionId) ? owner : undefined;
  };
  const historyActor = (principal: PrincipalConfig, machine: string, historyId: string): string | undefined => {
    if (accessStore?.ownsHistory(principal.id, machine, historyId)) return principal.id;
    const grant = accessStore?.historyGrant(machine, historyId);
    return grant && viewerHistoryOwner(principal, machine, grant.provider, grant.providerSessionId)?.principalId === grant.principalId
      ? grant.principalId : undefined;
  };
  const canReadHistory = (principal: PrincipalConfig, machine: string, historyId: string) =>
    isRootPrincipal(principal) || historyActor(principal, machine, historyId) !== undefined;

  const decorationContext = (principal: PrincipalConfig) => ({
    principal: { id: config.multiUser ? principal.id : "operator", permissions: principal.permissions },
    global: config.multiUser && isRootPrincipal(principal), multiUser: config.multiUser,
    machines: principal.machines,
    can: (permission: string) => !principal.managedCredential && (!config.multiUser || (principal.permissions as readonly string[]).includes(permission)),
    ownerOf: (machine: string, sessionId: string) => accessStore?.sessionGrant(machine, sessionId)?.principalId,
  });
  const decorateBoard = (principal: PrincipalConfig | null, view: import("./board/query.ts").BoardView) => {
    const metadata = Object.assign({}, ...extensions.extensions.map(extension => extension.decorateBoard?.(decorationContext(principal ?? legacyPrincipal), view)));
    return { ...metadata, ...view };
  };

  const decoratedSessionsForReader = (principal: PrincipalConfig, sessions: Array<Record<string, unknown>>) => {
    const scoped = config.multiUser ? visibleSessions(principal, sessions, accessStore, viewerAccessFor(principal)) : sessions;
    const metadata = Object.assign({}, ...extensions.extensions.map(extension => extension.decorateSessions?.(decorationContext(principal), scoped)));
    return { sessions: scoped, metadata };
  };
  const displaySessionsForReader = (principal: PrincipalConfig, sessions: Array<Record<string, unknown>>) =>
    decoratedSessionsForReader(principal, sessions).sessions;

  const principalForToken = (token: string | undefined): PrincipalConfig | undefined => {
    if (!token) return undefined;
    if (!config.multiUser) {
      return timingSafeEqualStr(token, config.clientToken) ? legacyPrincipal : undefined;
    }
    let match: PrincipalConfig | undefined;
    for (const principal of config.principals) {
      if (!principal.managedCredential && timingSafeEqualStr(token, principal.token)) match = principal;
    }
    const managedId = testCredentials?.authenticate(token);
    const managedPrincipal = managedId ? configuredPrincipals.get(managedId) : undefined;
    // Keep the fingerprint that authenticate matched, even if the owner
    // revokes/reissues before this request resolves its configured scope.
    return match ?? (managedPrincipal?.managedCredential
      ? { ...managedPrincipal, token: testCredentialHash(token) } : undefined);
  };

  // Native Tauri auth: the client token directly — as a bearer header on HTTP,
  // or as a legacy Sec-WebSocket-Protocol value on the WS upgrade (WebViews
  // can't set WS headers). Same trust as holding the token and trading it for a
  // cookie. A token-bearing request is NOT CSRF-able (the token isn't ambient
  // like a cookie), so it is also exempt from the same-origin gate below.
  const explicitToken = (req: IncomingMessage): string | undefined => (
    bearerToken(req.headers.authorization)
    ?? wsProtocolToken(req.headers["sec-websocket-protocol"])
  );

  const tokenPrincipal = (req: IncomingMessage): PrincipalConfig | undefined => (
    principalForToken(explicitToken(req))
  );

  const principalForRequest = (req: IncomingMessage): PrincipalConfig | undefined => {
    if (config.openAccess) return openPrincipal;
    // An explicit credential is the authoritative identity for this request.
    // Never let an ambient cookie from another principal supply broader access
    // while a bearer/subprotocol token supplies the CSRF exemption.
    const credential = explicitToken(req);
    if (credential !== undefined) return principalForToken(credential);
    let sessionPrincipal: PrincipalConfig | undefined;
    const sessionPrincipalId = store.get(parseCookies(req.headers.cookie).get(SESSION_COOKIE), id => {
      sessionPrincipal = config.multiUser ? principalById(id)
        : id === legacyPrincipal.id ? legacyPrincipal : undefined;
      return sessionPrincipal?.token;
    });
    // Return the same snapshot whose fingerprint validated this cookie. A
    // second lookup could upgrade the request to a reissued credential.
    return sessionPrincipalId ? sessionPrincipal : undefined;
  };

  const csrfExempt = createCsrfExempt(config, (req) => tokenPrincipal(req) !== undefined);

  const serializeSessionMutation = <T>(
    key: string,
    action: () => Promise<T>,
  ): Promise<T> => sessionMutations.serializeMutation(key, action);

  const coalesceMaintenancePreview = (
    cacheKey: string,
    sessionKey: string,
    action: () => Promise<DaemonResult>,
  ): Promise<DaemonResult> => sessionMutations.coalescePreview(cacheKey, sessionKey, action);

  const clearRequestDeadline = (req: IncomingMessage): void => {
    const timer = requestDeadlines.get(req);
    if (timer) clearTimeout(timer);
    requestDeadlines.delete(req);
  };

  const armRequestDeadline = (req: IncomingMessage, res: ServerResponse, timeoutMs: number): void => {
    clearRequestDeadline(req);
    const timer = setTimeout(() => {
      requestDeadlines.delete(req);
      if (res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        req.destroy();
        return;
      }
      res.setHeader("connection", "close");
      const payload = JSON.stringify({ ok: false, error: { message: "request timed out" } });
      res.writeHead(408, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(payload, () => req.destroy());
    }, timeoutMs);
    timer.unref();
    requestDeadlines.set(req, timer);
  };

  const server = createServer((req, res) => {
    armRequestDeadline(req, res, ordinaryRequestTimeoutMs);
    res.once("finish", () => clearRequestDeadline(req));
    res.once("close", () => clearRequestDeadline(req));
    handle(req, res).catch((err) => {
      if (err instanceof OutboxError && !res.headersSent) {
        sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.code } });
        return;
      }
      // Log the real cause server-side; never leak internals to the client.
      console.error("edge request error:", (err as Error).message);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: { message: "internal error" } });
      } else {
        res.end();
      }
    });
  });
  server.once("close", () => {
    outboxDispatcher?.stop(); outboxStore?.close();
    if (testerRevocationTimer) clearInterval(testerRevocationTimer);
    store.close(); testCredentials?.close();
  });
  if (accessStore) server.once("close", () => accessStore.close());
  if (machinePreferences) server.once("close", () => machinePreferences.close());
  const board = openBoardService(config, options.board);
  if (board) server.once("close", () => void board.close());
  server.requestTimeout = 0;
  server.once("listening", () => outboxDispatcher?.start());

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://edge.local");
    const path = url.pathname;
    const requestId = requestIdFromHeader(req.headers["x-agent-console-request-id"]);
    if (path.startsWith("/api/")) {
      res.setHeader("x-agent-console-request-id", requestId);
    }

    if (method === "GET" && path === "/healthz") {
      sendJson(res, 200, { ok: true, service: "agent-console-edge" });
      return;
    }

    // Daemon-only authentication is separate from browser/device auth, including
    // open-access mode. Relay traffic bypasses browser debug projections.
    if (isCoordinationRoute(path)) {
      await handleCoordinationRelay(config, accessStore, req, res, url, board, async (principal, machine, body, startMark, lineage) => {
        const projectedBody = projectCreateSessionBody(body);
        if (!projectedBody) return false;
        if (body.resume !== undefined) {
          if (typeof body.resume !== "string" || !body.resume) return false;
          projectedBody.resume = body.resume;
        }
        if (Object.hasOwn(body, "resume_account_explicit")) {
          if (typeof body.resume_account_explicit !== "boolean" || typeof projectedBody.resume !== "string") return false;
          // The resolved account pin is not evidence of explicit cancellation
          // consent. Carry the origin's original-request decision unchanged.
          projectedBody.resume_account_explicit = body.resume_account_explicit;
        }
        Object.assign(projectedBody, lineage);
        // The dispatcher lookup runs alongside the create and is awaited only
        // when the grant is recorded; it never rejects.
        const create = async () => {
          if (typeof projectedBody.resume === "string" && accessStore) assertResumeOwnership(accessStore, principal, machine, projectedBody);
          await createClaimedSession(res, principal, machine, projectedBody, typeof projectedBody.resume === "string" ? projectedBody.resume : undefined, undefined, startMark());
        };
        if (typeof projectedBody.resume === "string") {
          await serializeSessionMutation(`${machine.name}\u0000provider\u0000${String(projectedBody.agent)}\u0000${projectedBody.resume}`, create);
        } else {
          await create();
        }
        return true;
      }, principal => machinePreferences?.disabled(principal.id) ?? new Set(), decorateBoard);
      return;
    }

    if (method === "POST" && path === "/api/auth/login") {
      if (!sameOrigin(req, res)) return;
      const body = (await readJsonBody(req).catch(() => undefined)) as { token?: unknown } | undefined;
      const token = typeof body?.token === "string" ? body.token : "";
      const principal = principalForToken(token);
      if (!principal) {
        sendJson(res, 401, { ok: false, error: { message: "invalid token" } });
        return;
      }
      const id = store.create(principal.id, principal.token);
      if (principal.managedCredential) testCredentials?.signIn(principal.id);
      res.setHeader("set-cookie", sessionCookie(id, SESSION_MAX_AGE, config.secureCookie));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && path === "/api/auth/logout") {
      if (!sameOrigin(req, res)) return;
      const id = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (id) {
        store.delete(id);
      }
      res.setHeader("set-cookie", sessionCookie("", 0, config.secureCookie));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && path === "/api/auth/status") {
      // openAccess lets the UI hide the "Sign out" control in open mode (there is
      // no session to end; signing out would just drop to a dead login screen).
      const principal = principalForRequest(req);
      if (principal?.managedCredential && explicitToken(req)) testCredentials?.signIn(principal.id);
      sendJson(res, 200, {
        ok: true,
        authenticated: principal !== undefined,
        openAccess: config.openAccess,
        principal: principal
          ? {
            id: principal.id,
            // Only explicitly client-visible extension permissions leave the server.
            permissions: principal.permissions.filter((permission) => permission !== "provider_import"
              && clientPermissions.has(permission)),
            ...(principal.defaultVisibleMachines === undefined ? {} : { defaultVisibleMachines: principal.defaultVisibleMachines }),
            ...(principal.defaultCreateMachine === undefined ? {} : { defaultCreateMachine: principal.defaultCreateMachine }),
          }
          : null,
      });
      return;
    }

    // Everything below /api requires auth.
    if (path.startsWith("/api/")) {
      const principal = principalForRequest(req);
      if (!principal) {
        sendJson(res, 401, { ok: false, error: { message: "unauthorized" } });
        if (!isDebugRoute(path)) {
          debugEvents.record({
            source: "edge",
            request_id: requestId,
            method,
            route: path,
            status: 401,
            ok: false,
            duration_ms: 0,
            error: "unauthorized",
          });
        }
        return;
      }
      guardTesterResponse(res, principal);
      requestPrincipals.set(res, principal);
      if (isDebugRoute(path)) {
        await handleApi(req, res, method, path, url, requestId, principal);
        return;
      }
      const started = performance.now();
      try {
        await handleApi(req, res, method, path, url, requestId, principal);
        const envelope = sentErrorEnvelope(res);
        debugEvents.record({
          source: "edge",
          request_id: requestId,
          method,
          route: path,
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 400 && envelope === undefined,
          duration_ms: performance.now() - started,
          errorEnvelope: envelope,
        });
      } catch (err) {
        debugEvents.record({
          source: "edge",
          request_id: requestId,
          method,
          route: path,
          status: res.headersSent ? res.statusCode : 500,
          ok: false,
          duration_ms: performance.now() - started,
          error: (err as Error).message,
        });
        throw err;
      }
      return;
    }

    // Static UI (GET/HEAD only).
    if (method === "GET" || method === "HEAD") {
      serveStatic(res, config.uiDir, path, method === "HEAD");
      return;
    }
    sendJson(res, 405, { ok: false, error: { message: "method not allowed" } });
  }

  // Extension routes get the same gates as core routes: the caller is already
  // authenticated; managed testers are refused, as for core routes outside
  // their read-only allowlist; multi-user principals need the route's permission; :machine
  // and :machine + :id are scoped as in withMachine and handleApi; writes need
  // a same-origin or token-authenticated request.
  async function handleExtensionRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: URL,
    requestId: string,
    principal: PrincipalConfig,
  ): Promise<void> {
    const match = extensions.match(url.pathname, method);
    if (!match) {
      sendJson(res, 404, { ok: false, error: { message: "not found" } });
      return;
    }
    const route = match.route;
    if (!route) {
      methodNotAllowed(res);
      return;
    }
    if (principal.managedCredential || (config.multiUser && !principal.permissions.includes(route.permission))) {
      sendJson(res, 403, { ok: false, error: { message: "forbidden" } });
      return;
    }
    const machine = match.params.machine;
    if (machine !== undefined) {
      if (!byName.has(machine) || (config.multiUser && !principalCanAccessMachine(principal, machine))) {
        sendJson(res, 404, { ok: false, error: { message: `unknown machine: ${machine}` } });
        return;
      }
      const sessionId = match.params.id;
      if (config.multiUser && sessionId !== undefined && !(isRootPrincipal(principal)
        ? await currentSessionIncarnation(principal, machine, sessionId, requestId)
        : await ownsCurrentSession(principal, machine, sessionId, requestId))) {
        sendJson(res, 404, { ok: false, error: { message: "session not found" } });
        return;
      }
    }
    if (method !== "GET" && !csrfExempt(req)) return forbidCrossOrigin(res);
    await route.handle({
      req,
      res,
      method: method as EdgeRouteMethod,
      url,
      params: match.params,
      principal: { id: principal.id, permissions: principal.permissions },
      requestId,
      sendJson: (status, body) => sendJson(res, status, body),
      readJsonBody: (limitBytes) => readJsonBody(req, limitBytes),
    });
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    url: URL,
    requestId: string,
    _principal: PrincipalConfig,
  ): Promise<void> {
    const route = matchApiRoute(path, method);
    if (!route) {
      // Core routes always win; extensions only see paths core does not own.
      await handleExtensionRoute(req, res, method, url, requestId, _principal);
      return;
    }
    if (!route.methodAllowed) {
      methodNotAllowed(res);
      return;
    }

    // Managed testers have no ordinary-principal base powers. This allowlist
    // fails closed for new routes, including GET endpoints for shells/settings.
    if (_principal.managedCredential && (method !== "GET" || ![
      "machines", "sessions", "board", "history-sessions", "history-messages", "history-image",
      "resource-events", "activity-events", "glance", "buffer",
    ].includes(route.id))) {
      sendJson(res, 403, { ok: false, error: { message: "forbidden" } });
      return;
    }

    if (config.multiUser && ["shell", "shell-ticket", "attach-ticket"].includes(route.id)
      && !principalCanUseTerminal(_principal)) {
      sendJson(res, 403, { ok: false, error: { message: "forbidden" } });
      return;
    }

    let rootSessionIncarnation: string | undefined;
    const isHistoryItem = ["history-messages", "history-star", "history-resume", "history-image"].includes(route.id);
    if (config.multiUser && route.params.machine && route.params.id && !isHistoryItem) {
      const machine = routeParam(route, "machine");
      const sessionId = routeParam(route, "id");
      if (isRootPrincipal(_principal)) {
        rootSessionIncarnation = await currentSessionIncarnation(_principal, machine, sessionId, requestId);
      }
      if (isRootPrincipal(_principal) ? !rootSessionIncarnation
        : !await ownsCurrentSession(_principal, machine, sessionId, requestId)) {
        sendJson(res, 404, { ok: false, error: { message: "session not found" } });
        return;
      }
    }
    if (config.multiUser && isHistoryItem) {
      const machine = routeParam(route, "machine");
      const historyId = routeParam(route, "id");
      if (["history-messages", "history-image"].includes(route.id) ? !canReadHistory(_principal, machine, historyId)
        : historyActor(_principal, machine, historyId) === undefined) {
        sendJson(res, 404, { ok: false, error: { message: "history session not found" } });
        return;
      }
    }
    const permissionByRoute: Readonly<Record<string, PrincipalPermission | undefined>> = {
      debug: "debug",
      "runtime-health": "debug",
      "session-retitle-v3-receipts": "debug",
      usage: "usage",
      // Named for Codex, the permission guards every provider's limit reset.
      "codex-rate-limit-reset": "codex_reset",
      "claude-limit-reset": "codex_reset",
    };
    const requiredPermission = permissionByRoute[route.id];
    if (
      config.multiUser
      && requiredPermission
      && !_principal.permissions.includes(requiredPermission)
    ) {
      sendJson(res, 403, { ok: false, error: { message: "forbidden" } });
      return;
    }

    switch (route.id) {
      case "outbox":
      case "outbox-item": {
        if (method !== "GET" && !csrfExempt(req)) return forbidCrossOrigin(res);
        if (!outboxStore) throw new OutboxError("outbox-durability-unavailable", 503);
        // This is a client identity assertion, never an authorization source.
        // Another tab can replace the shared cookie without updating this tab.
        if (req.headers["x-console-expected-principal"] !== _principal.id) {
          throw new OutboxError("outbox-principal-changed", 409);
        }
        // Older clients may still expose queued-message editing. Retire the
        // operation explicitly instead of silently changing submitted text.
        const raw = method === "GET" ? undefined : await readJsonBody(req).catch(() => undefined);
        const admission = method === "PUT" ? normalizeOutboxAdmission(raw) : null;
        const action = method === "PATCH" && route.id === "outbox-item" ? normalizeRefusedOutboxAction(raw) : null;
        if (method === "PATCH" && !action) throw new OutboxError("outbox-actions-retired", 410);
        const incarnation = method === "GET" ? url.searchParams.get("expected_session_incarnation")
          : (admission ?? action)?.expected_session_incarnation;
        if (!isPromptIncarnation(incarnation)
          || (method === "GET" && (url.searchParams.getAll("expected_session_incarnation").length !== 1
            || [...url.searchParams.keys()].some(key => key !== "expected_session_incarnation")))
          || (method === "PUT" && !admission)) {
          throw new OutboxError("outbox-invalid-request", 400);
        }
        const sessionId = routeParam(route, "id");
        const intent = route.id === "outbox-item" ? routeParam(route, "intent") : null;
        if (intent !== null && !isPromptRequestId(intent)) throw new OutboxError("outbox-invalid-request", 400);
        await withMachine(res, routeParam(route, "machine"), async machine => {
          const target: OutboxTarget = { principalId: _principal.id, machine: machine.name, sessionId, incarnation };
          if (method === "GET") {
            const value = intent ? outboxStore.get(target, intent) : outboxStore.snapshot(target);
            if (!value) throw new OutboxError("outbox-intent-not-found", 404);
            sendJson(res, 200, { ok: true, data: intent ? { item: value } : value }); return;
          }
          if (admission || action?.operation === "retry_refused") {
            const observed = await aggregateSessions([machine]);
            if (!observed.machines.some(m => m.ok)) throw new OutboxError("outbox-target-unavailable", 503);
            const session = observed.sessions.find(s => s.id === sessionId);
            if (!session || session.session_incarnation !== incarnation) throw new OutboxError("outbox-session-changed", 409);
            const provider = (session.provider_resume as { provider?: unknown } | undefined)?.provider ?? session.agent;
            if (provider !== "codex" && provider !== "claude") {
              throw new OutboxError("outbox-provider-unsupported", 409);
            }
            if (!outboxAccess(target)) throw new OutboxError("outbox-authorization-changed", 403);
          }
          if (action && intent) {
            // Route authorization and the principal-scoped target already fence
            // discard. It sends nothing and may retire an earlier incarnation.
            const allowed = action.operation === "retry_refused" ? outboxAccess(target) : null;
            if (action.operation === "retry_refused" && !allowed) throw new OutboxError("outbox-authorization-changed", 403);
            const item = outboxStore.actOnRefused(target, intent, action,
              allowed ? outboxCredentialGeneration(allowed.principal, allowed.machine) : undefined);
            if (action.operation === "retry_refused") void outboxDispatcher?.tick();
            sendJson(res, 200, { ok: true, data: { item } }); return;
          }
          if (admission && intent) {
            const allowed = outboxAccess(target);
            if (!allowed) throw new OutboxError("outbox-authorization-changed", 403);
            const result = outboxStore.admit(target, intent, admission.text, outboxCredentialGeneration(allowed.principal, allowed.machine));
            void outboxDispatcher?.tick();
            sendJson(res, result.created ? 201 : 200, { ok: true, data: { item: result.item } }); return;
          }
        });
        return;
      }
      case "shell":
      case "shell-ticket": {
        if (method !== "GET" && !csrfExempt(req)) return forbidCrossOrigin(res);
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const owner = _principal.id;
          const daemonPath = `/shells/${encodeURIComponent(owner)}`;
          let body: unknown;
          if (method !== "GET") {
            body = await readJsonBody(req).catch(() => undefined);
            if (!body || typeof body !== "object" || Array.isArray(body)
              || (method === "DELETE"
                ? Object.keys(body).length !== 1 || typeof (body as { incarnation?: unknown }).incarnation !== "string"
                : Object.keys(body).length !== 0)) {
              sendJson(res, 422, { ok: false, error: { message: "invalid shell request" } });
              return;
            }
          }
          if (route.id === "shell-ticket") {
            const incarnation = routeParam(route, "incarnation");
            const result = await daemonFetch(machine, daemonPath);
            const shell = normalizeEmergencyShell((result.body as { data?: { shell?: unknown } })?.data?.shell);
            if (!daemonSucceeded(result) || !shell || shell.owner !== owner || shell.incarnation !== incarnation) {
              sendJson(res, 409, { ok: false, error: { message: "Shell runtime changed or is unavailable" } });
              return;
            }
            const ticket = wsTickets.create(machine.name, `shell:${incarnation}`, 30_000,
              { principalId: owner, incarnation,
                ...(_principal.managedCredential ? { credentialFingerprint: _principal.token } : {}) });
            sendJson(res, 200, { ok: true, data: { ticket, expiresInMs: 30_000 } });
            return;
          }
          const result = await daemonFetch(machine, daemonPath, {
            method, ...(method !== "GET" ? { body } : {}), debug: daemonDebug(requestId),
          });
          if (!daemonSucceeded(result)) { forwardDaemon(res, result); return; }
          const shell = normalizeEmergencyShell((result.body as { data?: { shell?: unknown } })?.data?.shell);
          if (!shell || shell.owner !== owner) {
            sendJson(res, 502, { ok: false, error: { message: "Invalid shell response" } });
            return;
          }
          sendJson(res, 200, { ok: true, data: { shell } });
        });
        return;
      }

      case "debug":
        sendJson(res, 200, {
          ok: true,
          data: {
            events: debugEvents.snapshot(),
            generated_at: new Date().toISOString(),
            max_events: debugEvents.maxEvents,
            max_signal_events: debugEvents.maxSignalEvents,
          },
        });
        return;

      case "machines":
        sendJson(res, 200, {
          ok: true,
          data: {
            machines: config.machines
              .filter((machine) => !config.multiUser || principalCanAccessMachine(_principal, machine.name))
              .map((machine) => ({ name: machine.name })),
          },
        });
        return;

      case "machine-preferences": {
        if (!machinePreferences) { sendJson(res, 503, { ok: false, error: { message: "durable machine preferences are not configured" } }); return; }
        const permitted = config.machines.filter(machine => !config.multiUser || principalCanAccessMachine(_principal, machine.name));
        sendJson(res, 200, { ok: true, data: { machines: machinePreferences.snapshot(_principal.id, permitted) } });
        return;
      }
      case "machine-preference": {
        // The native apps send their token with the app-shell Origin (#1003).
        if (!sameOriginOrNativeApp(req, res, tokenPrincipal(req) !== undefined)) return;
        if (!machinePreferences) { sendJson(res, 503, { ok: false, error: { message: "durable machine preferences are not configured" } }); return; }
        const name = routeParam(route, "machine");
        const machine = config.machines.find(candidate => candidate.name === name);
        if (!machine || (config.multiUser && !principalCanAccessMachine(_principal, name))) {
          sendJson(res, 403, { ok: false, error: { message: "machine is not granted" } }); return;
        }
        const body = objectProp(await readJsonBody(req).catch(() => undefined));
        if (!body || Object.keys(body).some(key => !["enabled", "reason", "initialize_only"].includes(key))
          || ("initialize_only" in body && body.initialize_only !== true)
          || typeof body.enabled !== "boolean" || !validPreferenceReason(body.reason)) {
          sendJson(res, 400, { ok: false, error: { message: "enabled and a non-empty reason are required" } }); return;
        }
        try {
          machinePreferences.write(_principal.id, name, body.enabled, body.reason, `principal:${_principal.id}`, body.initialize_only === true);
        } catch (error) {
          if (!(error instanceof MachinePreferenceInitializedError)) throw error;
          sendJson(res, 409, { ok: false, error: { message: "machine preference is already initialized" } }); return;
        }
        sendJson(res, 200, { ok: true, data: { machine: machinePreferences.snapshot(_principal.id, [machine])[0] } });
        return;
      }

      case "runtime-health": {
        const machineName = routeParam(route, "machine");
        await withMachine(res, machineName, async (machine) => {
          const result = await daemonFetch(machine, "/healthz", { timeoutMs: 5_000, debug: daemonDebug(requestId) });
          const runtime = result.status === 200 ? projectRuntimeHealth(result.body) : null;
          if (!runtime) {
            sendJson(res, 502, { ok: false, error: { message: "machine runtime health unavailable" } });
            return;
          }
          sendJson(res, 200, { ok: true, data: { machine: machineName, runtime } });
        });
        return;
      }

      case "speech-providers":
        sendJson(res, 200, {
          ok: true,
          data: {
            providers: config.speechProviders
              .filter((provider) => !provider.machine || !config.multiUser || principalCanAccessMachine(_principal, provider.machine))
              .map((provider) => ({
                id: provider.id,
                label: provider.label,
                max_duration_seconds: MAX_SPEECH_DURATION_SECONDS,
                max_bytes: MAX_SPEECH_BYTES,
              })),
          },
        });
        return;

      case "speech-transcription": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const provider = config.speechProviders.find((candidate) => candidate.id === routeParam(route, "provider"));
        if (!provider || (config.multiUser && provider.machine && !principalCanAccessMachine(_principal, provider.machine))) {
          sendJson(res, 404, { ok: false, error: { message: "speech provider not found" } });
          return;
        }
        armRequestDeadline(req, res, 15_000);
        try {
          const { audio, contentType } = await readSpeechAudio(req);
          armRequestDeadline(req, res, 125_000);
          const disconnect = new AbortController();
          const abortOnClose = () => {
            if (!res.writableEnded) disconnect.abort();
          };
          res.once("close", abortOnClose);
          try {
            const result = await transcribeSpeech(provider, audio, contentType, disconnect.signal);
            if (!res.destroyed) sendJson(res, 200, { ok: true, data: { ...result, provider: provider.id } });
          } finally {
            res.off("close", abortOnClose);
          }
        } catch (error) {
          if (!(error instanceof SpeechRequestError)) throw error;
          if (!res.destroyed) sendJson(res, error.status, { ok: false, error: { message: error.message } });
        }
        return;
      }

      case "title-summary": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const body = (await readJsonBody(req).catch(() => undefined)) as
          | {
              agent?: unknown;
              baseTitle?: unknown;
              titleState?: unknown;
              currentTitle?: unknown;
              prompt?: unknown;
              recentOutput?: unknown;
              repoName?: unknown;
              trace?: unknown;
            }
          | undefined;
        const prompt = typeof body?.prompt === "string" ? body.prompt : "";
        if (prompt.trim() === "") {
          sendJson(res, 422, { ok: false, error: { message: "prompt is required" } });
          return;
        }
        const baseTitle = typeof body?.baseTitle === "string" ? body.baseTitle : null;
        const titleState = normalizeSessionTitleState(body?.titleState);
        const currentTitle = typeof body?.currentTitle === "string" ? body.currentTitle : null;
        const recentOutput = typeof body?.recentOutput === "string" ? body.recentOutput : null;
        const agent = typeof body?.agent === "string" ? body.agent : null;
        const repoName = typeof body?.repoName === "string" ? body.repoName : null;
        const trace = normalizeTitleSummaryTrace(body?.trace);
        const trustedTrace = trace && byName.has(trace.machine) ? trace : undefined;
        const evaluation = await summarizeTitleWithDiagnostics(config.titleSummarizer, {
          agent,
          baseTitle,
          titleState,
          currentTitle,
          prompt,
          recentOutput,
          repoName,
        });
        if (trustedTrace) {
          const traceSessionId = titleTraceSessionCorrelation(trustedTrace.sessionId);
          const lifecycleEvent = {
            source: "edge" as const,
            request_id: requestId,
            route: "/title-lifecycle",
            ok: null,
            machine: trustedTrace.machine,
            session_id: traceSessionId,
            operation: "title",
            phase: trustedTrace.phase,
            outcome: evaluation.reason,
            provenance: "client_supplied",
            attempt_id: trustedTrace.attemptId,
            attempt: trustedTrace.attempt,
          };
          debugEvents.record(lifecycleEvent);
          console.log(JSON.stringify({
            event: "agent-console.title-lifecycle.v1",
            request_id: requestId,
            machine: trustedTrace.machine,
            session_id: traceSessionId,
            operation: "title",
            phase: trustedTrace.phase,
            outcome: evaluation.reason,
            trace_provenance: "client_supplied",
            attempt_id: trustedTrace.attemptId,
            attempt: trustedTrace.attempt,
          }));
        }
        sendJson(res, 200, {
          ok: true,
          data: { ...evaluation.result, diagnosticReason: evaluation.reason },
        });
        return;
      }

      case "retitle-readiness": {
        const machineName = routeParam(route, "machine");
        await withMachine(res, machineName, async (machine) => {
          forwardSessionRetitleReadinessDaemon(
            res,
            await daemonFetch(machine, "/retitle/readiness", {
              timeoutMs: SESSION_RETITLE_READINESS_TIMEOUT_MS,
              debug: daemonDebug(requestId),
            }),
            machineName,
          );
        });
        return;
      }

      case "retitle-v3-readiness": {
        const machineName = routeParam(route, "machine");
        const sessionId = routeParam(route, "id");
        await withMachine(res, machineName, async (machine) => {
          forwardSessionRetitleV3ReadinessDaemon(
            res,
            await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/retitle-v3/readiness`, {
              timeoutMs: SESSION_RETITLE_READINESS_TIMEOUT_MS,
              debug: daemonDebug(requestId),
            }),
            machineName,
          );
        });
        return;
      }

      case "workdirs": {
        const machineName = routeParam(route, "machine");
        await withMachine(res, machineName, async (machine) => {
          const qs = new URLSearchParams();
          const q = url.searchParams.get("q");
          const limit = url.searchParams.get("limit");
          const gitOnly = url.searchParams.get("git_only");
          const excludeWorktrees = url.searchParams.get("exclude_worktrees");
          if (q !== null) qs.set("q", q);
          if (limit !== null) qs.set("limit", limit);
          if (gitOnly !== null) qs.set("git_only", gitOnly);
          if (excludeWorktrees !== null) qs.set("exclude_worktrees", excludeWorktrees);
          const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
          forwardDaemon(res, await daemonFetch(machine, `/workdirs${suffix}`, { debug: daemonDebug(requestId) }));
        });
        return;
      }

      case "repo-url": {
        const cwd = url.searchParams.get("cwd")?.trim();
        if (!cwd) {
          sendJson(res, 400, { ok: false, error: { message: "missing cwd query parameter" } });
          return;
        }
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const qs = new URLSearchParams();
          qs.set("cwd", cwd);
          forwardDaemon(
            res,
            await daemonFetch(machine, `/repos/remote-url?${qs.toString()}`, { debug: daemonDebug(requestId) }),
          );
        });
        return;
      }

      case "accounts": {
        const provider = routeParam(route, "provider");
        if (!isAccountProvider(provider)) {
          sendJson(res, 404, { ok: false, error: { message: "not found" } });
          return;
        }
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          forwardAccountsDaemon(
            res,
            await daemonFetch(machine, `/${provider}/accounts`, { debug: daemonDebug(requestId) }),
            provider,
          );
        });
        return;
      }

      case "sessions": {
        // Optional `?machines=` allowlist keeps excluded hosts out of this
        // aggregate read (absent param = all permitted machines).
        const permitted = config.multiUser
          ? config.machines.filter((machine) => principalCanAccessMachine(_principal, machine.name))
          : config.machines;
        const only = selectMachines(permitted, url.searchParams.get("machines"));
        const aggregate = await aggregateSessions(sessionMachinesForReader(_principal, only), machineHealth, daemonDebug(requestId));
        const { sessions, metadata } = decoratedSessionsForReader(_principal, aggregate.sessions);
        sendJson(res, 200, {
          ok: true,
          data: {
            ...metadata,
            ...aggregate,
            sessions,
            capabilities: {
              // Extension flags first, so a core flag of the same name wins.
              ...extensions.sessionCapabilities({
                principal: { id: _principal.id, permissions: _principal.permissions },
                can: (permission) => !_principal.managedCredential
                  && (!config.multiUser || (_principal.permissions as readonly string[]).includes(permission)),
              }),
              auto_resume_control: true,
              profile_resume_import: true,
              managed_resume_command: true,
              resume_blocked_reason: true,
              last_prompt: true,
              last_message: true,
              history: true,
              archive: true,
              session_retitle_v2: true,
              session_retitle_v3: true,
              ...(board ? { session_board: true } : {}),
            },
          },
        });
        return;
      }

      case "board": {
        // Principal-scoped like the session list: the caller's machines and
        // its own sessions only (board/routes.ts).
        if (!board) {
          sendJson(res, 404, { ok: false, error: { code: "board-disabled", message: "the session board is not enabled" } });
          return;
        }
        try {
          sendJson(res, 200, { ok: true, data: { board: decorateBoard(_principal, boardViewForRequest(board, config, accessStore, config.multiUser ? _principal : null, url.searchParams, [], true, machinePreferences?.disabled(_principal.id) ?? new Set(), viewerAccessFor(_principal))) } });
        } catch (error) {
          if (!(error instanceof BoardQueryError)) throw error;
          sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
        }
        return;
      }

      case "history-sessions": {
        const machineName = url.searchParams.get("machine")?.trim();
        if (!machineName) {
          sendJson(res, 400, { ok: false, error: { message: "machine is required" } });
          return;
        }
        await withMachine(res, machineName, async (machine) => {
          const qs = new URLSearchParams();
          for (const key of ["q", "provider", "cursor", "limit"] as const) {
            const value = url.searchParams.get(key);
            if (value !== null) qs.set(key, value);
          }
          const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
          forwardHistorySessionsDaemon(
            res,
            await daemonFetch(machine, `/history/sessions${suffix}`, {
              timeoutMs: HISTORY_DAEMON_TIMEOUT_MS,
              debug: daemonDebug(requestId),
            }),
            config.multiUser
              ? (session) => {
                  const historyId = session.id;
                  const provider = session.provider;
                  const providerSessionId = session.provider_session_id;
                  if (
                    typeof historyId !== "string"
                    || typeof provider !== "string"
                    || typeof providerSessionId !== "string"
                    || !accessStore
                  ) return false;
                  if (accessStore.ownsHistory(_principal.id, machine.name, historyId)) return true;
                  // Claim before root's read-only access, so root still owns its own history (#936 F1).
                  const claimant = historyClaimant(_principal, machine.name, provider, providerSessionId);
                  if (claimant === undefined) {
                    return isRootPrincipal(_principal);
                  }
                  accessStore.claimHistory(
                    claimant,
                    machine.name,
                    historyId,
                    provider,
                    providerSessionId,
                  );
                  return true;
                }
              : undefined,
            config.multiUser && accessStore
              ? (session) => {
                  const provider = session.provider;
                  const providerSessionId = session.provider_session_id;
                  if (typeof provider !== "string" || typeof providerSessionId !== "string") return undefined;
                  const claimant = historyClaimant(_principal, machine.name, provider, providerSessionId) ?? _principal.id;
                  const dispatchedBy = publicDispatchedBy(
                    accessStore.providerDispatcher(claimant, machine.name, provider, providerSessionId),
                  );
                  const liveSession = accessStore.providerSession(claimant, machine.name, provider, providerSessionId);
                  const marks = {
                    ...(dispatchedBy ? { dispatched_by: dispatchedBy } : {}),
                    ...publicCoordinatorTree(liveSession === null ? null : accessStore.coordinatorTreeDepth(
                      machine.name, liveSession, typeof session.repo_name === "string" ? session.repo_name : null,
                    )),
                  };
                  return Object.keys(marks).length > 0 ? marks : undefined;
                }
              : undefined,
          );
        });
        return;
      }

      case "history-image": {
        await withMachine(res, routeParam(route, "machine"), (machine) =>
          forwardHistoryImage(res, machine, routeParam(route, "id"), routeParam(route, "image")));
        return;
      }

      case "history-messages": {
        const historyId = routeParam(route, "id");
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const qs = new URLSearchParams();
          for (const key of ["cursor", "limit", "direction"] as const) {
            const value = url.searchParams.get(key);
            if (value !== null) qs.set(key, value);
          }
          const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
          forwardHistoryMessagesDaemon(
            res,
            await daemonFetch(
              machine,
              `/history/sessions/${encodeURIComponent(historyId)}/messages${suffix}`,
              { timeoutMs: HISTORY_DAEMON_TIMEOUT_MS, debug: daemonDebug(requestId) },
            ),
          );
        });
        return;
      }

      case "history-star": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const historyId = routeParam(route, "id");
        const starred = objectProp(await readJsonBody(req).catch(() => undefined))?.starred;
        if (typeof starred !== "boolean") {
          sendJson(res, 422, { ok: false, error: { message: "starred must be a boolean" } });
          return;
        }
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          forwardHistoryStarDaemon(
            res,
            await daemonFetch(machine, `/history/sessions/${encodeURIComponent(historyId)}/star`, {
              method: "POST",
              body: { starred },
              timeoutMs: HISTORY_DAEMON_TIMEOUT_MS,
              debug: daemonDebug(requestId),
            }),
          );
        });
        return;
      }

      case "history-resume": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const body = await readJsonBody(req).catch(() => Symbol("invalid-history-resume-body"));
        if (body !== undefined) {
          sendJson(res, 422, { ok: false, error: { message: "history resume body must be empty" } });
          return;
        }
        const historyId = routeParam(route, "id");
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const daemonResult = await daemonFetch(machine, `/history/sessions/${encodeURIComponent(historyId)}/resume`, {
            method: "POST",
            timeoutMs: HISTORY_DAEMON_TIMEOUT_MS,
            debug: daemonDebug(requestId),
          });
          if (config.multiUser && accessStore && daemonSucceeded(daemonResult)) {
            // A viewer resumes through the owner's history; the new session stays with
            // the owner and descends from the selected session so the viewer keeps it.
            const actor = historyActor(_principal, machine.name, historyId) ?? _principal.id;
            const grant = actor === _principal.id ? undefined : accessStore.historyGrant(machine.name, historyId);
            const source = grant && viewerHistoryOwner(_principal, machine.name, grant.provider, grant.providerSessionId)?.sessionId;
            if (!claimCreatedDaemonSession(accessStore, actor, machine.name, daemonResult, undefined, undefined,
              source ? { treeDepth: OUTSIDE_COORDINATOR_TREE, launcher: { machine: machine.name, sessionId: source } } : undefined)) {
              sendJson(res, 502, { ok: false, error: { message: "history resume did not confirm an owned session" } });
              return;
            }
          }
          forwardHistoryResumeDaemon(
            res,
            daemonResult,
          );
        });
        return;
      }

      case "resource-events": {
        const permitted = config.machines.filter((machine) => !config.multiUser || principalCanAccessMachine(_principal, machine.name));
        const only = selectMachines(permitted, url.searchParams.get("machines"));
        const resources = [...new Set((url.searchParams.get("resources") ?? "").split(",").filter(Boolean))];
        if (_principal.managedCredential && resources.some(resource => resource !== "sessions")) {
          sendJson(res, 403, { ok: false, error: { message: "forbidden" } });
          return;
        }
        let conversations: unknown;
        try { conversations = JSON.parse(url.searchParams.get("conversations") ?? "[]"); }
        catch { conversations = null; }
        if (resources.some((resource) => !["sessions", "layout"].includes(resource))
          || !Array.isArray(conversations) || conversations.length > 8) {
          sendJson(res, 400, { ok: false, error: { message: "invalid resource subscriptions" } });
          return;
        }
        const subscriptions: ResourceSubscription[] = resources.map((resource) => resource === "sessions"
          ? { resource: "sessions", machines: only.map((machine) => machine.name) }
          : { resource: "layout" });
        for (const row of conversations) {
          const item = objectProp(row);
          if (typeof item?.machine !== "string" || typeof item.id !== "string" || !item.id || item.id.length > 256
            || !permitted.some((machine) => machine.name === item.machine)
            || (config.multiUser && !canReadHistory(_principal, item.machine, item.id))) {
            sendJson(res, 404, { ok: false, error: { message: "history session not found" } });
            return;
          }
          subscriptions.push({ resource: "conversation", machine: item.machine, id: item.id });
        }
        if (!resourceWatches.hasCapacity(subscriptions.map((subscription) => JSON.stringify([_principal.id, subscription])))) {
          sendJson(res, 503, { ok: false, error: { message: "resource watch capacity reached" } });
          return;
        }
        clearRequestDeadline(req);
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store",
          connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(": agent-console.resources.v1\n\n");
        const dispose: Array<() => void> = [];
        const closed = new Promise<void>((resolve) => res.once("close", resolve));
        try {
          for (const subscription of subscriptions) {
            const resource = resourceKey(subscription);
            const key = JSON.stringify([_principal.id, subscription]);
            const load = async (signal: AbortSignal): Promise<unknown> => {
              if (subscription.resource === "sessions") {
                const aggregate = await aggregateSessions(sessionMachinesForReader(_principal, only), machineHealth, undefined, signal);
                const sessions = displaySessionsForReader(_principal, aggregate.sessions);
                return { machines: aggregate.machines.map((machine) => ({ ...machine, observed_at: undefined })),
                  sessions: sessions.map((session) => ({ ...session, activity_observed_at: undefined })) };
              }
              if (subscription.resource === "layout") {
                if (config.multiUser && accessStore) return accessStore.readLayout(_principal.id);
                if (!config.layout) throw new Error("layout disabled");
                return fetchLayoutOrder(config.layout);
              }
              if (config.multiUser && !canReadHistory(_principal, subscription.machine, subscription.id)) {
                throw new Error("history unavailable");
              }
              const machine = byName.get(subscription.machine)!;
              const result = await daemonFetch(machine,
                `/history/sessions/${encodeURIComponent(subscription.id)}/messages?limit=50&direction=latest`,
                { timeoutMs: HISTORY_DAEMON_TIMEOUT_MS, signal });
              const data = result.status === 200 && objectProp(result.body)?.ok !== false ? projectHistoryMessagesDaemonData(objectProp(result.body)?.data) : null;
              if (!data) throw new Error("conversation unavailable");
              return data;
            };
            dispose.push(resourceWatches.subscribe(key, load,
              subscription.resource === "conversation" ? 3000 : subscription.resource === "sessions" ? 4000 : 5000,
              (observation) => {
                if (res.destroyed || res.writableEnded) return;
                // Credentials can expire or be revoked while the shared source
                // read is pending. Authorize this response at delivery, never
                // bind the principal-scoped producer to one subscriber's cookie.
                if (principalForRequest(req)?.id !== _principal.id) { res.end(); return; }
                // Never let a slow subscriber stall another principal or build
                // an unbounded queue. Reconnect obtains a fresh observation.
                if (res.writableLength > 64 * 1024) { res.destroy(); return; }
                const type = !observation.available ? "unavailable" : observation.changed ? "changed" : "heartbeat";
                const event = { schema_version: "agent-console.resource-event.v1", type, resource, revision: observation.revision };
                const metadata = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
                let frame = observation.value ? `event: ${type}\ndata: ${JSON.stringify({ ...event, conversation: observation.value })}\n\n` : metadata;
                // Snapshot bursts share the response's byte budget. Congestion
                // falls back to HTTP instead of reconnecting and replaying them.
                if (res.writableLength + Buffer.byteLength(frame) > 64 * 1024) frame = metadata;
                if (res.writableLength + Buffer.byteLength(frame) > 64 * 1024) { res.destroy(); return; }
                res.write(frame);
              }, subscription.resource === "conversation" && url.searchParams.get("conversation_snapshots") === "1"));
          }
          await closed;
        } finally { for (const stop of dispose) stop(); }
        return;
      }

      case "activity-events": {
        clearRequestDeadline(req);
        const permitted = config.multiUser
          ? config.machines.filter((machine) => principalCanAccessMachine(_principal, machine.name))
          : config.machines;
        const only = selectMachines(permitted, url.searchParams.get("machines")).filter(machine => machine.active !== false);
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.on("close", abort);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(": agent-console.activity-stream.v1\n\n");
        const running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
        const enabledForReader = (machine: MachineConfig) =>
          sessionMachinesForReader(_principal, [machine]).some(candidate => candidate.active !== false);
        const reconcile = () => {
          if (controller.signal.aborted) return;
          const enabled = new Set(sessionMachinesForReader(_principal, only)
            .filter(machine => machine.active !== false).map(machine => machine.name));
          for (const [name, stream] of running) if (!enabled.has(name)) {
            running.delete(name); stream.controller.abort();
          }
          for (const machine of only) {
            if (!enabled.has(machine.name) || running.has(machine.name) || controller.signal.aborted) continue;
            const stream = { controller: new AbortController(), promise: Promise.resolve() };
            running.set(machine.name, stream);
            const disconnect = () => {
              if (stream.controller.signal.aborted) return;
              controller.abort(); if (!res.writableEnded) res.end();
            };
            stream.promise = activityStreams.stream([machine], {
              onDisconnect: disconnect,
              initialEvent: async () => {
                // Recheck immediately before the source read; a preference can
                // change while this subscriber's initial projection is pending.
                const aggregate = await aggregateSessions(sessionMachinesForReader(_principal, [machine]),
                  machineHealth, daemonDebug(requestId), stream.controller.signal);
                const sessions = config.multiUser ? visibleSessions(_principal, aggregate.sessions, accessStore, viewerAccessFor(_principal)) : aggregate.sessions;
                return { schema_version: "agent-session.activity-stream.event.v1", type: "snapshot",
                  stream_id: `edge-initial-${randomUUID()}`, sequence: 0, machine: machine.name,
                  observed_at: new Date().toISOString(), sessions: sessions.flatMap(session => typeof session.id !== "string" ? [] : [{
                    id: session.id, turn_state: normalizeActivityTurnState(session.turn_state),
                  }]) };
              },
              signal: stream.controller.signal,
              write: chunk => {
                // Delivery metadata bypasses filterEvent in the shared layer.
                // This guard also blocks queued frames immediately after disable.
                if (controller.signal.aborted || !enabledForReader(machine)) { stream.controller.abort(); return true; }
                return res.write(chunk);
              },
              waitForDrain: () => waitForDrainOrAbort(res, stream.controller.signal),
              filterEvent: async event => {
                if (!enabledForReader(machine)) { stream.controller.abort(); return event; }
                if (!config.multiUser || !accessStore || event.type === "heartbeat" || !event.sessions) return event;
                // Activity visibility is checked before this ownership read.
                // The global helper also authorizes terminals and stays unchanged.
                const currentOwned = await currentOwnedSessions(_principal, event.machine, requestId);
                const byId = new Map(currentOwned.flatMap(session => typeof session.id === "string" ? [[session.id, session] as const] : []));
                return { ...event, sessions: event.sessions.flatMap(session => {
                  const current = byId.get(session.id);
                  if (!current) return [];
                  return [{ id: session.id, turn_state: normalizeActivityTurnState(current.turn_state) }];
                }) };
              },
            }).catch(disconnect).finally(() => { if (running.get(machine.name) === stream) running.delete(machine.name); });
          }
        };
        // Owner-local CLI writes have no HTTP notification. A bounded local
        // preference read cancels/restarts only this reader's subscriptions;
        // other principals keep the reference-counted shared upstream producer.
        const preferenceTimer = machinePreferences ? setInterval(reconcile, 1000) : undefined;
        preferenceTimer?.unref();
        try {
          reconcile();
          if (!controller.signal.aborted) {
            await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
          }
        } finally {
          if (preferenceTimer) clearInterval(preferenceTimer);
          const pending = [...running.values()];
          for (const stream of pending) stream.controller.abort();
          await Promise.allSettled(pending.map(stream => stream.promise));
          res.off("close", abort);
          if (!res.destroyed && !res.writableEnded) res.end();
        }
        return;
      }

      case "usage": {
        const forceUsageRefresh = url.searchParams.get("refresh") === "1";
        await sendReachableData(res, config.usage, { providers: [] }, async (reader) => {
          let pending = fetchUsage(reader, forceUsageRefresh);
          for (const extension of extensions.extensions) {
            if (extension.decorateUsage) pending = extension.decorateUsage(decorationContext(_principal), pending, forceUsageRefresh);
          }
          const providers = await pending;
          return {
            data: {
              providers: config.multiUser
                ? scopeProviderHosts(providers, _principal.machines)
                : providers,
            },
          };
        });
        return;
      }

      case "codex-rate-limit-reset": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const body = objectProp(await readJsonBody(req).catch(() => undefined));
        const account = normalizeCodexResetAccount(body?.account);
        const idempotencyKey = normalizeCodexResetIdempotencyKey(body?.idempotency_key);
        if (
          !body
          || !account
          || !idempotencyKey
          || Object.keys(body).some((key) => key !== "account" && key !== "idempotency_key")
        ) {
          sendJson(res, 422, {
            ok: false,
            error: { message: "body must contain only a safe account and canonical idempotency_key UUID" },
          });
          return;
        }
        if (!config.codexReset) {
          sendJson(res, 503, { ok: false, error: { message: "Codex reset controller not configured" } });
          return;
        }
        try {
          sendJson(res, 200, {
            ok: true,
            data: await resetCodexRateLimit(config.codexReset, account, idempotencyKey),
          });
        } catch (error) {
          sendJson(res, 502, {
            ok: false,
            error: { message: error instanceof Error ? error.message : "Codex reset controller unavailable" },
          });
        }
        return;
      }

      case "claude-limit-reset": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const request = normalizeClaudeResetRequest(await readJsonBody(req).catch(() => undefined));
        if (!request) {
          sendJson(res, 422, {
            ok: false,
            error: { message: "body must contain only a safe account, a reset program, and a canonical idempotency_key UUID" },
          });
          return;
        }
        if (!config.claudeReset) {
          sendJson(res, 503, { ok: false, error: { message: "Claude reset controller not configured" } });
          return;
        }
        try {
          sendJson(res, 200, { ok: true, data: await resetClaudeLimit(config.claudeReset, request) });
        } catch (error) {
          sendJson(res, 502, {
            ok: false,
            error: { message: error instanceof Error ? error.message : "Claude reset controller unavailable" },
          });
        }
        return;
      }

      case "layout":
        if (config.multiUser && accessStore) {
          if (method === "GET") {
            sendJson(res, 200, { ok: true, data: { ...accessStore.readLayout(_principal.id), reachable: true } });
            return;
          }
          if (!csrfExempt(req)) return forbidCrossOrigin(res);
          const body = objectProp(await readJsonBody(req).catch(() => undefined));
          const order = normalizeOrder(body?.order);
          const baseRevision = normalizeRevision(body?.base_revision);
          if (!order || baseRevision === null) {
            sendJson(res, 422, { ok: false, error: { message: "layout body must include order and base_revision" } });
            return;
          }
          const result = accessStore.writeLayout(_principal.id, order, baseRevision);
          sendJson(res, result.ok ? 200 : 409, {
            ok: result.ok,
            ...(!result.ok ? { error: { message: "layout revision conflict" } } : {}),
            data: { order: result.order, revision: result.revision, reachable: true },
          });
          return;
        }
        if (method === "GET") {
          await sendReachableData(res, config.layout, { order: [] }, async (reader) => {
            const layout = await fetchLayoutOrder(reader);
            return { data: { order: layout.order, revision: layout.revision } };
          });
          return;
        }
        if (method === "PUT") {
          if (!csrfExempt(req)) return forbidCrossOrigin(res);
          const body = await readJsonBody(req).catch(() => undefined);
          const rawBodyObject = objectProp(body);
          const rawOrder = Array.isArray(body)
            ? body
            : Array.isArray(rawBodyObject?.order)
              ? rawBodyObject.order
              : undefined;
          if (rawOrder === undefined) {
            sendJson(res, 422, { ok: false, error: { message: "layout body must be { order: string[] }" } });
            return;
          }
          const order = normalizeOrder(rawOrder);
          if (order.length === 0 && rawOrder.length > 0) {
            sendJson(res, 422, { ok: false, error: { message: "layout order has no valid session keys" } });
            return;
          }
          const baseRevision = normalizeRevision(rawBodyObject?.base_revision);
          const reason = asString(rawBodyObject?.reason)?.slice(0, 64);
          await sendReachableData(res, config.layout, {}, async (reader) => {
            const result = await writeLayoutOrder(reader, { order, baseRevision, reason });
            if (result.conflict) {
              return {
                status: 409,
                ok: false,
                error: { message: result.error ?? "layout revision conflict" },
                data: {
                  order: result.order,
                  revision: result.revision,
                  conflict: true,
                  error: result.error,
                },
              };
            }
            return { data: { order: result.order, revision: result.revision } };
          });
          return;
        }
        return;

      case "glance": {
        const sessionId = routeParam(route, "id");
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const tail = url.searchParams.get("tail");
          const q = tail ? `?tail=${encodeURIComponent(tail)}` : "";
          forwardGlanceDaemon(
            res,
            await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/glance${q}`, {
              debug: daemonDebug(requestId),
            }),
          );
        });
        return;
      }

      case "buffer": {
        const sessionId = routeParam(route, "id");
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          forwardDaemon(
            res,
            await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/buffer`, {
              debug: daemonDebug(requestId),
            }),
          );
        });
        return;
      }

      case "attach-ticket": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const machineName = routeParam(route, "machine");
        const sessionId = routeParam(route, "id");
        await withMachine(res, machineName, async () => {
          const incarnation = config.multiUser
            ? rootSessionIncarnation ?? accessStore?.sessionIncarnation(actingOwnerOf(_principal, machineName, sessionId) ?? _principal.id, machineName, sessionId)
            : undefined;
          if (config.multiUser && !incarnation) {
            sendJson(res, 404, { ok: false, error: { message: "session not found" } });
            return;
          }
          const ticket = wsTickets.create(
            machineName,
            sessionId,
            30_000,
            incarnation ? { principalId: _principal.id, incarnation,
              ...(_principal.managedCredential ? { credentialFingerprint: _principal.token } : {}) } : undefined,
          );
          sendJson(res, 200, { ok: true, data: { ticket, expiresInMs: 30_000 } });
        });
        return;
      }

      case "send": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const body = await readJsonBody(req).catch(() => undefined);
          forwardDaemon(
            res,
            await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/send`, {
              method: "POST",
              body: body ?? {},
              debug: daemonDebug(requestId),
            }),
          );
        });
        return;
      }

      case "prompt-receipt": {
        const sessionId=routeParam(route,"id"), promptRequestId=routeParam(route,"requestId");
        const incarnation=url.searchParams.get("expected_session_incarnation");
        if(!isPromptRequestId(promptRequestId)||!isPromptIncarnation(incarnation)
          ||url.searchParams.getAll("expected_session_incarnation").length!==1
          ||[...url.searchParams.keys()].some(key=>key!=="expected_session_incarnation")){
          sendJson(res,400,{ok:false,error:{message:"Invalid queued prompt receipt identity."}});return;
        }
        await withMachine(res,routeParam(route,"machine"),async machine=>{
          forwardPromptReceipt(res,await daemonFetch(machine,`/sessions/${encodeURIComponent(sessionId)}/prompt/v2/receipts/${encodeURIComponent(promptRequestId)}?expected_session_incarnation=${encodeURIComponent(incarnation)}`,{debug:daemonDebug(requestId)}),{session_id:sessionId,session_incarnation:incarnation,request_id:promptRequestId},true);
        });
        return;
      }
      case "fenced-structured-prompt": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        const rawBody = await readJsonBody(req).catch(() => undefined);
        const body = fencedStructuredPromptBody(rawBody);
        if (!body) {
          sendJson(res, 400, {
            ok: false,
            error: { message: "invalid fenced provider prompt request" },
          });
          return;
        }
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const result=await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/prompt/v2`, {
            method:"POST",body,debug:daemonDebug(requestId),
          });
          if(body.request_id!==undefined)forwardPromptReceipt(res,result,{session_id:sessionId,session_incarnation:body.expected_session_incarnation,request_id:body.request_id});
          else forwardFencedStructuredPromptDaemon(res,result,body.expected_session_incarnation);
        });
        return;
      }

      case "structured-prompt": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const body = await readJsonBody(req).catch(() => undefined);
          forwardDaemon(
            res,
            await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/prompt`, {
              method: "POST",
              body: body ?? {},
              debug: daemonDebug(requestId),
            }),
          );
        });
        return;
      }

      case "resume": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          await serializeSessionMutation(`${machine.name}\u0000${sessionId}`, async () => {
            const previousIncarnation = await currentSessionIncarnation(_principal, machine.name, sessionId, requestId);
            if (config.multiUser && accessStore) {
              const previewResult = await daemonFetch(
                machine,
                `/sessions/${encodeURIComponent(sessionId)}/maintenance?operation=resume`,
                { debug: daemonDebug(requestId) },
              );
              if (!daemonSucceeded(previewResult)) {
                forwardMaintenancePreviewDaemon(res, previewResult, {
                  sessionId, operation: "resume", schemaVersion: MAINTENANCE_SCHEMA_VERSION,
                });
                return;
              }
              const preview = maintenancePreviewFromDaemon(previewResult, {
                sessionId, operation: "resume", schemaVersion: MAINTENANCE_SCHEMA_VERSION,
              });
              if (!preview || !preview.actions.some((action) => action.id === "retry_resume")) {
                sendJson(res, 502, { ok: false, error: { message: "resume preview is invalid" } });
                return;
              }
              if (
                !previousIncarnation
                || preview.session_incarnation !== previousIncarnation
                || preview.session_generation === null
              ) {
                sendJson(res, 409, { ok: false, error: { message: "session ownership changed; refresh before resuming" } });
                return;
              }
              const request: SessionMaintenanceActionRequest = {
                operation: "resume",
                action: "retry_resume",
                expected_session_incarnation: preview.session_incarnation,
                expected_session_generation: preview.session_generation,
                expected_preview_digest: preview.preview_digest,
              };
              const result = await daemonFetch(
                machine,
                `/sessions/${encodeURIComponent(sessionId)}/maintenance/actions`,
                { method: "POST", body: request, debug: daemonDebug(requestId) },
              );
              if (daemonSucceeded(result)) {
                const actionResult = normalizeSessionMaintenanceActionResult(
                  (result.body as { data?: { maintenance_result?: unknown } } | undefined)?.data?.maintenance_result,
                  { sessionId, operation: "resume", action: "retry_resume", schemaVersion: MAINTENANCE_SCHEMA_VERSION },
                );
                if (actionResult?.outcome !== "resumed" || !advanceResumedSessionOwnership(
                  accessStore, _principal, actsForAnotherOwner(_principal, machine.name, sessionId), machine.name, sessionId,
                  previousIncarnation, actionResult.session_incarnation,
                )) {
                  sendJson(res, 502, { ok: false, error: { message: "resume did not confirm current ownership" } });
                  return;
                }
                const session = await confirmedResumedSession(
                  machine, sessionId, actionResult.session_incarnation, requestId,
                );
                if (!session) {
                  sendJson(res, 502, { ok: false, error: { message: "resumed session snapshot is unavailable; refresh sessions" } });
                  return;
                }
                sendJson(res, 200, { ok: true, data: { machine: machine.name, session } });
                return;
              }
              forwardMaintenanceActionDaemon(res, result, { sessionId, request });
              return;
            }
            const result = await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/resume`, {
              method: "POST",
              body: {},
              debug: daemonDebug(requestId),
            });
            forwardDaemon(res, result);
          });
        });
        return;
      }

      case "archive-session": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        const raw = await readJsonBody(req).catch(() => undefined);
        const expected = objectProp(raw)?.expected_session_incarnation;
        if (typeof expected !== "string" || expected.length < 1 || expected.length > 256) {
          sendJson(res, 422, {
            ok: false,
            error: { message: "expected_session_incarnation is required" },
          });
          return;
        }
        // Starring on archive is optional; anything but an explicit boolean is a
        // malformed request rather than a silently dropped intent.
        const starred = objectProp(raw)?.starred;
        if (starred !== undefined && typeof starred !== "boolean") {
          sendJson(res, 422, { ok: false, error: { message: "starred must be a boolean" } });
          return;
        }
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          await serializeSessionMutation(`${machine.name}\u0000${sessionId}`, async () => {
            const archiveGrant = accessStore?.sessionGrant(machine.name, sessionId);
            const archiveOwner = actsForAnotherOwner(_principal, machine.name, sessionId)
              ? archiveGrant?.incarnation === expected ? archiveGrant.principalId : undefined
              : _principal.id;
            const daemonResult = await protectOutboxLifecycle(machine.name, sessionId, () => daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/archive`, {
              method: "POST",
              body: {
                expected_session_incarnation: expected,
                ...(starred === true ? { starred: true } : {}),
              },
              debug: daemonDebug(requestId),
            }));
            if (config.multiUser && accessStore) {
              const archived = (daemonResult.body as {
                ok?: unknown;
                data?: { archived?: Record<string, unknown> };
              } | undefined)?.data?.archived;
              if (
                daemonResult.status >= 200 && daemonResult.status < 300
                && archiveOwner
                && archived
                && typeof archived.history_id === "string"
                && typeof archived.provider === "string"
                && typeof archived.provider_session_id === "string"
              ) {
                accessStore.claimHistory(
                  archiveOwner,
                  machine.name,
                  archived.history_id,
                  archived.provider,
                  archived.provider_session_id,
                );
              }
            }
            forwardArchiveDaemon(
              res,
              daemonResult,
              sessionId,
            );
          });
        });
        return;
      }

      case "maintenance-preview": {
        const sessionId = routeParam(route, "id");
        const operation = url.searchParams.get("operation") as MaintenanceOperation | null;
        if (!operation || !["resume", "delete", "attach", "inspect"].includes(operation)) {
          sendJson(res, 422, { ok: false, error: { message: "maintenance operation is invalid" } });
          return;
        }
        const requestedContract = maintenanceContractVersion(url.searchParams.get("schema_version"));
        if (!requestedContract) {
          sendJson(res, 422, { ok: false, error: { message: "maintenance schema version is invalid" } });
          return;
        }
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const key = `${machine.name}\u0000${sessionId}`;
          // Coalescing is keyed by the contract as well: two clients negotiating
          // different contracts must never share one upstream preview.
          const previewUnder = (contract: MaintenanceContractVersion) => coalesceMaintenancePreview(
            `${key}|${operation}|${contract}`,
            key,
            () => daemonFetch(
              machine,
              `/sessions/${encodeURIComponent(sessionId)}/maintenance?operation=${operation}`
                + maintenanceQuerySuffix(contract),
              { debug: daemonDebug(requestId) },
            ),
          );
          let contract = requestedContract;
          let result = await previewUnder(contract);
          if (
            contract === MAINTENANCE_SCHEMA_VERSION_V2
            && daemonRejectedContract(result, "invalid-maintenance-query")
          ) {
            // The daemon is v1-only. Degrade to the contract it does speak; the
            // echoed version tells the client which actions it may render.
            contract = MAINTENANCE_SCHEMA_VERSION;
            result = await previewUnder(contract);
          }
          forwardMaintenancePreviewDaemon(res, result, {
            sessionId,
            operation,
            schemaVersion: contract,
          });
        });
        return;
      }

      case "maintenance-actions": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        const body = normalizeSessionMaintenanceActionRequest(
          await readJsonBody(req).catch(() => undefined),
        );
        if (!body) {
          sendJson(res, 422, { ok: false, error: { message: "maintenance action body is invalid" } });
          return;
        }
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          await serializeSessionMutation(`${machine.name}\u0000${sessionId}`, async () => {
            const previousIncarnation = await currentSessionIncarnation(_principal, machine.name, sessionId, requestId);
            if (
              config.multiUser && accessStore
              && (body.action === "retry_resume" || body.action === "terminate_runtime_then_resume")
              && (body.expected_session_incarnation !== previousIncarnation
                || body.expected_session_generation === null)
            ) {
              sendJson(res, 409, { ok: false, error: { message: "session ownership changed; refresh before recovering" } });
              return;
            }
            // Tracks what was actually sent, so the echoed contract is checked
            // against the negotiated one even after a fallback.
            let outgoing = body;
            if (body.operation === "delete") outboxStore?.beginLifecycle(machine.name, sessionId);
            try {
              let result = await daemonFetch(
                machine,
                `/sessions/${encodeURIComponent(sessionId)}/maintenance/actions`,
                { method: "POST", body: outgoing, debug: daemonDebug(requestId) },
              );
              if (
                outgoing.schema_version !== undefined
                && daemonRejectedContract(result, "invalid-maintenance-action-request")
              ) {
                if (maintenanceActionRequiresSuccessorContract(outgoing.action)) {
                  // The action does not exist under v1, so there is nothing safe
                  // to retry: report it as unavailable on this machine.
                  sendJson(res, 501, {
                    ok: false,
                    error: {
                      code: "maintenance-unsupported",
                      message: "Session maintenance is unavailable on this machine.",
                    },
                  });
                  return;
                }
                // The daemon rejected the body while decoding it, so nothing ran
                // and the same action can be replayed under the contract it speaks.
                outgoing = maintenanceRequestUnderV1(outgoing);
                result = await daemonFetch(
                  machine,
                  `/sessions/${encodeURIComponent(sessionId)}/maintenance/actions`,
                  { method: "POST", body: outgoing, debug: daemonDebug(requestId) },
                );
              }
              if (config.multiUser && accessStore && daemonSucceeded(result)) {
                const actionResult = normalizeSessionMaintenanceActionResult(
                  (result.body as { data?: { maintenance_result?: unknown } } | undefined)
                    ?.data?.maintenance_result,
                  {
                    sessionId,
                    operation: outgoing.operation,
                    action: outgoing.action,
                    schemaVersion: outgoing.schema_version ?? MAINTENANCE_SCHEMA_VERSION,
                  },
                );
                if (actionResult?.outcome === "resumed") {
                  if (!advanceResumedSessionOwnership(
                    accessStore, _principal, actsForAnotherOwner(_principal, machine.name, sessionId), machine.name, sessionId,
                    previousIncarnation, actionResult.session_incarnation,
                  )) {
                    sendJson(res, 502, { ok: false, error: { message: "recovery did not confirm current ownership" } });
                    return;
                  }
                }
              }
              forwardMaintenanceActionDaemon(res, result, { sessionId, request: outgoing });
            } catch {
              const contract = outgoing.schema_version ?? MAINTENANCE_SCHEMA_VERSION;
              let maintenance = null;
              try {
                maintenance = maintenancePreviewFromDaemon(
                  await daemonFetch(
                    machine,
                    `/sessions/${encodeURIComponent(sessionId)}/maintenance?operation=${body.operation}`
                      + maintenanceQuerySuffix(contract),
                    { debug: daemonDebug(requestId) },
                  ),
                  { sessionId, operation: body.operation, schemaVersion: contract },
                );
              } catch {
                // The typed indeterminate response remains sufficient when
                // reconciliation is also unavailable.
              }
              sendJson(res, 504, {
                ok: false,
                error: {
                  code: "maintenance-outcome-unknown",
                  message: "The maintenance outcome is unknown. Inspect the session before retrying.",
                },
                ...(maintenance ? { data: { maintenance } } : {}),
              });
            }
          });
        });
        return;
      }

      case "auto-resume": {
        const sessionId = routeParam(route, "id");
        if (method !== "GET" && !csrfExempt(req)) return forbidCrossOrigin(res);
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          let body: {
            enabled: boolean;
            recovery_policy?: "wait_for_reset" | "next_account_then_resume";
          } | undefined;
          if (method === "PUT") {
            const raw = await readJsonBody(req).catch(() => undefined);
            if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as { enabled?: unknown }).enabled !== "boolean") {
              sendJson(res, 422, { ok: false, error: { message: "auto-resume body must be { enabled: boolean }" } });
              return;
            }
            const recoveryPolicy = (raw as { recovery_policy?: unknown }).recovery_policy;
            if (
              recoveryPolicy !== undefined
              && recoveryPolicy !== "wait_for_reset"
              && recoveryPolicy !== "next_account_then_resume"
            ) {
              sendJson(res, 422, { ok: false, error: { message: "auto-resume recovery policy is invalid" } });
              return;
            }
            body = {
              enabled: (raw as { enabled: boolean }).enabled,
              ...(recoveryPolicy ? { recovery_policy: recoveryPolicy } : {}),
            };
          }
          let daemonResult: Awaited<ReturnType<typeof daemonFetch>>;
          try {
            daemonResult = await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/auto-resume`, {
              method,
              ...(body ? { body } : {}),
              debug: daemonDebug(requestId),
            });
          } catch {
            sendJson(res, 504, {
              ok: false,
              error: {
                code: "auto-resume-outcome-unknown",
                message: method === "GET" ? "auto-resume status is unavailable" : "auto-resume outcome is unknown",
              },
            });
            return;
          }
          forwardAutoResumeDaemon(res, daemonResult);
        });
        return;
      }

      case "session-account": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        const raw = await readJsonBody(req).catch(() => undefined);
        const account = normalizeAccountNickname(
          raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as { account?: unknown }).account
            : undefined,
        );
        const expectedSessionIncarnation = raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as { expected_session_incarnation?: unknown }).expected_session_incarnation
          : undefined;
        if (
          account === null
          || typeof expectedSessionIncarnation !== "string"
          || expectedSessionIncarnation.length === 0
          || expectedSessionIncarnation.length > 128
        ) {
          sendJson(res, 422, { ok: false, error: { message: "account body requires nickname and session incarnation" } });
          return;
        }
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const mutationKey = `${machine.name}\u0000${sessionId}`;
          if (accountSwitches.has(mutationKey)) {
            sendJson(res, 409, { ok: false, error: { message: "an account switch is already in progress" } });
            return;
          }
          accountSwitches.add(mutationKey);
          try {
            await serializeSessionMutation(mutationKey, async () => {
            let daemonResult: Awaited<ReturnType<typeof daemonFetch>>;
            try {
              daemonResult = await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/account`, {
                method: "PUT",
                body: {
                  account,
                  expected_session_incarnation: expectedSessionIncarnation,
                  supports_unbound_account_queue: true,
                },
                timeoutMs: ACCOUNT_SWITCH_TIMEOUT_MS,
                debug: daemonDebug(requestId),
              });
            } catch {
              sendJson(res, 504, {
                ok: false,
                error: {
                  code: "account-switch-outcome-unknown",
                  message: "account switch outcome is unknown",
                },
              });
              return;
            }
              forwardSessionAccountDaemon(res, daemonResult, account, expectedSessionIncarnation);
            });
          } finally {
            accountSwitches.delete(mutationKey);
          }
        });
        return;
      }

      case "attachments": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        // Give the daemon timeout a short grace period to propagate an error
        // response before the outer request deadline tears down the socket.
        armRequestDeadline(req, res, attachmentUploadTimeoutMs + 1_000);
        const closeIncompleteUpload = (): void => {
          if (req.complete || req.destroyed) return;
          if (!res.headersSent) res.setHeader("connection", "close");
          const closeRequest = (): void => {
            res.off("finish", closeRequest);
            res.off("close", closeRequest);
            if (!req.destroyed) req.destroy();
          };
          res.once("finish", closeRequest);
          res.once("close", closeRequest);
        };
        const machineName = routeParam(route, "machine");
        const machine = byName.get(machineName);
        if (!machine) {
          closeIncompleteUpload();
          sendJson(res, 404, { ok: false, error: { message: `unknown machine: ${machineName}` } });
          return;
        }
        const declaredBytes = Number(req.headers["content-length"]);
        if (Number.isFinite(declaredBytes) && declaredBytes > config.maxAttachmentBytes) {
          closeIncompleteUpload();
          sendJson(res, 413, { ok: false, error: { message: "attachment exceeds the maximum allowed size" } });
          return;
        }
        const sessionId = routeParam(route, "id");
        const filename = url.searchParams.get("filename");
        const suffix = filename ? `?filename=${encodeURIComponent(filename)}` : "";
        const rawType = req.headers["content-type"];
        const uploadContentType = Array.isArray(rawType) ? rawType[0] : rawType;
        const uploadBody = streamRequestBody(req, config.maxAttachmentBytes);
        try {
          const daemonResult = await daemonFetch(
            machine,
            `/sessions/${encodeURIComponent(sessionId)}/attachments${suffix}`,
            {
              method: "POST",
              bodyStream: uploadBody,
              contentType: uploadContentType,
              timeoutMs: attachmentUploadTimeoutMs,
              debug: daemonDebug(requestId),
            },
          );
          closeIncompleteUpload();
          forwardDaemon(res, daemonResult);
        } catch (err) {
          closeIncompleteUpload();
          if (uploadBody.limitExceeded()) {
            sendJson(res, 413, { ok: false, error: { message: "attachment exceeds the maximum allowed size" } });
            return;
          }
          throw err;
        }
        return;
      }

      case "display-metadata": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        const raw = objectProp(await readJsonBody(req).catch(() => undefined));
        if (!raw || (raw.title_mode !== "auto" && raw.title_mode !== "pinned") ||
          !Number.isSafeInteger(raw.expected_revision) || Number(raw.expected_revision) < 0 ||
          typeof raw.expected_session_created_at !== "string" || raw.expected_session_created_at.length === 0 || raw.expected_session_created_at.length > 128) {
          sendJson(res, 422, {ok:false,error:{message:"Invalid title mode update."}});
          return;
        }
        // Browser clients can change title mode; role backfill is an operator action.
        const body = {title_mode:raw.title_mode,expected_revision:raw.expected_revision,expected_session_created_at:raw.expected_session_created_at};
        await withMachine(res, routeParam(route,"machine"), async machine => {
          await serializeSessionMutation(`${machine.name}\u0000${sessionId}`, async () => {
            forwardDisplayMetadataDaemon(res, machine.name, sessionId, await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}/display-metadata`, {method:"POST",body,debug:daemonDebug(requestId)}));
          });
        });
        return;
      }

      case "session-item": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const body = method === "PATCH" ? await readJsonBody(req).catch(() => undefined) : undefined;
          await serializeSessionMutation(`${machine.name}\u0000${sessionId}`, async () => {
            if (method === "PATCH") {
              forwardDaemon(
                res,
                await daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}`, {
                  method: "PATCH",
                  body: body ?? {},
                  debug: daemonDebug(requestId),
                }),
              );
              return;
            }
            forwardSessionDeleteDaemon(
              res,
              await protectOutboxLifecycle(machine.name, sessionId, () => daemonFetch(machine, `/sessions/${encodeURIComponent(sessionId)}`, {
                method: "DELETE",
                debug: daemonDebug(requestId),
              })),
              sessionId,
            );
          });
        });
        return;
      }

      case "session-retitle": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        const request = normalizeSessionRetitleRequest(await readJsonBody(req).catch(() => undefined));
        if (!request) {
          sendJson(res, 422, {
            ok: false,
            error: { code: "invalid-retitle-request", message: "Session retitle request is invalid." },
          });
          return;
        }
        const machineName = routeParam(route, "machine");
        await withMachine(res, machineName, async (machine) => {
          await serializeSessionMutation(`${machine.name}\u0000${sessionId}`, async () => {
            let daemonResult: DaemonResult;
            try {
              daemonResult = await daemonFetch(
                machine,
                `/sessions/${encodeURIComponent(sessionId)}/retitle`,
                {
                  method: "POST",
                  body: request,
                  timeoutMs: SESSION_RETITLE_TIMEOUT_MS,
                  debug: daemonDebug(requestId),
                },
              );
            } catch {
              sendJson(res, 504, {
                ok: false,
                error: {
                  code: "retitle-outcome-unknown",
                  message: "The retitle outcome is unknown. Refresh the session before retrying.",
                },
              });
              return;
            }
            recordRetitleLifecycle(
              requestId,
              machineName,
              sessionId,
              forwardSessionRetitleDaemon(res, daemonResult, machineName, request),
            );
          });
        });
        return;
      }

      case "session-retitle-v3": {
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        const sessionId = routeParam(route, "id");
        const request = normalizeSessionRetitleV3Request(await readJsonBody(req).catch(() => undefined));
        if (!request) {
          sendJson(res, 422, {
            ok: false,
            error: { code: "invalid-retitle-request", message: "Session retitle request is invalid." },
          });
          return;
        }
        const machineName = routeParam(route, "machine");
        await withMachine(res, machineName, async (machine) => {
          await serializeSessionMutation(`${machine.name}\u0000${sessionId}`, async () => {
            let daemonResult: DaemonResult;
            try {
              daemonResult = await daemonFetch(
                machine,
                `/sessions/${encodeURIComponent(sessionId)}/retitle-v3`,
                {
                  method: "POST",
                  body: request,
                  timeoutMs: SESSION_RETITLE_TIMEOUT_MS,
                  debug: daemonDebug(requestId),
                },
              );
            } catch {
              sendJson(res, 504, {
                ok: false,
                error: {
                  code: "retitle-outcome-unknown",
                  message: "The retitle outcome is unknown. Refresh the session before retrying.",
                },
              });
              return;
            }
            recordRetitleLifecycle(
              requestId,
              machineName,
              sessionId,
              forwardSessionRetitleV3Daemon(res, daemonResult, machineName, request),
            );
          });
        });
        return;
      }

      case "session-retitle-v3-receipts": {
        const sessionId = routeParam(route, "id");
        const machineName = routeParam(route, "machine");
        await withMachine(res, machineName, async (machine) => {
          forwardSessionRetitleV3ReceiptsDaemon(
            res,
            await daemonFetch(
              machine,
              `/sessions/${encodeURIComponent(sessionId)}/retitle-v3/operations`,
              { timeoutMs: SESSION_RETITLE_READINESS_TIMEOUT_MS, debug: daemonDebug(requestId) },
            ),
            machineName,
          );
        });
        return;
      }

      case "session-retitle-v3-operation": {
        const sessionId = routeParam(route, "id");
        const operationHash = routeParam(route, "operation");
        if (!/^sha256:[a-f0-9]{64}$/.test(operationHash)) {
          sendJson(res, 422, {
            ok: false,
            error: { code: "invalid-retitle-request", message: "Retitle operation identifier is invalid." },
          });
          return;
        }
        const machineName = routeParam(route, "machine");
        await withMachine(res, machineName, async (machine) => {
          recordRetitleLifecycle(
            requestId,
            machineName,
            sessionId,
            forwardSessionRetitleV3Daemon(
              res,
              await daemonFetch(
                machine,
                `/sessions/${encodeURIComponent(sessionId)}/retitle-v3/operations/${encodeURIComponent(operationHash)}`,
                { timeoutMs: SESSION_RETITLE_READINESS_TIMEOUT_MS, debug: daemonDebug(requestId) },
              ),
              machineName,
              undefined,
              operationHash,
            ),
          );
        });
        return;
      }

      case "create-session":
        if (!csrfExempt(req)) return forbidCrossOrigin(res);
        await withMachine(res, routeParam(route, "machine"), async (machine) => {
          const body = await readJsonBody(req).catch(() => undefined);
          const projectedBody = projectCreateSessionBody(body);
          if (!projectedBody) {
            sendJson(res, 422, { ok: false, error: { message: "invalid create-session body" } });
            return;
          }
          if (config.multiUser && projectedBody.id !== undefined) {
            sendJson(res, 422, { ok: false, error: { message: "session id is assigned by the edge" } });
            return;
          }
          // A browser create is a console root: the browser cannot name a
          // parent or a role (session-lineage-work-v1).
          projectedBody.lineage = CONSOLE_ROOT_LINEAGE;
          const providerResumeId = typeof projectedBody.provider_resume_id === "string"
            ? projectedBody.provider_resume_id
            : typeof projectedBody.resume_id === "string" ? projectedBody.resume_id : undefined;
          const create = async () => {
            if (config.multiUser && accessStore) {
              if (
                providerResumeId
                && (
                  typeof projectedBody.agent !== "string"
                  || !accessStore.ownsProvider(
                    _principal.id,
                    machine.name,
                    projectedBody.agent,
                    providerResumeId,
                  )
                  && (
                    accessStore.hasProviderOwner(machine.name, projectedBody.agent, providerResumeId)
                    || !_principal.permissions.includes("provider_import")
                  )
                )
              ) {
                sendJson(res, 404, { ok: false, error: { message: "provider session not found" } });
                return;
              }
            }
            await createClaimedSession(res, _principal, machine, projectedBody, providerResumeId, requestId);
          };
          if (config.multiUser && providerResumeId) {
            await serializeSessionMutation(
              `${machine.name}\u0000provider\u0000${String(projectedBody.agent)}\u0000${providerResumeId}`,
              create,
            );
          } else {
            await create();
          }
        });
        return;
    }
  }

  function daemonDebug(requestId: string) {
    return { requestId, record: debugEvents.record };
  }

  // Daemon-owned retitle work otherwise leaves no server-side trace: the HTTP
  // exchange succeeds while the operation itself fails, so a failure is only
  // ever visible in the browser. The bounded stable tokens the daemon already
  // projects are retained here for the process log and the debug ring; an
  // in-flight `accepted` poll is not an outcome and is skipped. The session id
  // is the authenticated route parameter, not client-supplied trace metadata.
  function recordRetitleLifecycle(
    requestId: string,
    machine: string,
    sessionId: string,
    summary: SessionRetitleForwardSummary,
  ): void {
    if (summary.outcome === "accepted") return;
    debugEvents.record({
      source: "edge",
      request_id: requestId,
      route: "/title-lifecycle",
      ok: null,
      machine,
      session_id: sessionId,
      operation: "title",
      phase: summary.trigger ?? "manual",
      outcome: sessionRetitleLifecycleOutcome(summary.path, summary.outcome, summary.failureClass),
      provenance: "edge_observed",
      failure_class: summary.failureClass,
      failure_stage: summary.failureStage,
      provider_kind: summary.providerKind,
      duration_bucket: summary.durationBucket,
    });
    console.log(JSON.stringify({
      event: "agent-console.title-lifecycle.v1",
      request_id: requestId,
      machine,
      session_id: sessionId,
      operation: "title",
      path: summary.path,
      trigger: summary.trigger ?? null,
      outcome: summary.outcome,
      failure_class: summary.failureClass ?? null,
      failure_stage: summary.failureStage ?? null,
      provider_kind: summary.providerKind ?? null,
      duration_bucket: summary.durationBucket ?? null,
      trace_provenance: "edge_observed",
    }));
  }

  async function currentOwnedSessions(
    principal: PrincipalConfig,
    machineName: string,
    requestId?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const machine = byName.get(machineName);
    if (!machine || !principalCanAccessMachine(principal, machineName) || !accessStore) return [];
    const aggregate = await aggregateSessions(
      [machine],
      machineHealth,
      requestId ? daemonDebug(requestId) : undefined,
    );
    return visibleSessions(principal, aggregate.sessions, accessStore, viewerAccessFor(principal));
  }

  async function confirmedResumedSession(
    machine: MachineConfig,
    sessionId: string,
    resultIncarnation: string | null,
    requestId: string,
  ): Promise<Record<string, unknown> | null> {
    const snapshot = await daemonFetch(machine, "/sessions", { debug: daemonDebug(requestId) });
    if (!daemonSucceeded(snapshot)) return null;
    const sessions = (snapshot.body as { data?: { sessions?: unknown } } | undefined)?.data?.sessions;
    if (!Array.isArray(sessions)) return null;
    const matches = sessions.filter((entry) => {
      const session = objectProp(entry);
      return session?.id === sessionId
        && session.status === "running"
        && typeof session.session_incarnation === "string"
        && session.session_incarnation.length > 0
        && (resultIncarnation === null || session.session_incarnation === resultIncarnation);
    });
    return matches.length === 1 ? projectPublicAgentSession(matches[0]) : null;
  }

  async function currentOwnedSessionIds(
    principal: PrincipalConfig,
    machineName: string,
    requestId?: string,
  ): Promise<Set<string>> {
    return new Set((await currentOwnedSessions(principal, machineName, requestId)).flatMap((session) => (
      typeof session.id === "string" ? [session.id] : []
    )));
  }

  async function currentSessionIncarnation(
    principal: PrincipalConfig, machine: string, sessionId: string, requestId?: string,
  ): Promise<string | undefined> {
    if (!isRootPrincipal(principal)) {
      const owner = actingOwnerOf(principal, machine, sessionId);
      return owner === undefined ? undefined : accessStore?.sessionIncarnation(owner, machine, sessionId);
    }
    const target = byName.get(machine);
    if (!target) return undefined;
    // One authoritative daemon snapshot is enough to authorize a root session
    // operation. Do not build a global owner projection for a single target.
    const aggregate = await aggregateSessions([target], machineHealth,
      requestId ? daemonDebug(requestId) : undefined);
    const session = aggregate.sessions.find((entry) => entry.id === sessionId);
    return typeof session?.session_incarnation === "string" ? session.session_incarnation : undefined;
  }

  async function ownsCurrentSession(
    principal: PrincipalConfig,
    machineName: string,
    sessionId: string,
    requestId?: string,
  ): Promise<boolean> {
    if (!isRootPrincipal(principal) && actingOwnerOf(principal, machineName, sessionId) === undefined) return false;
    return (await currentOwnedSessionIds(principal, machineName, requestId)).has(sessionId);
  }

  // Creates a session on a machine the principal may use and, in multi-user
  // mode, claims it for that principal before answering. The coordination relay
  // passes no request id, so its creates stay out of the browser debug ring.
  async function createClaimedSession(
    res: ServerResponse,
    principal: PrincipalConfig,
    machine: MachineConfig,
    projectedBody: Record<string, unknown>,
    providerResumeId: string | undefined,
    requestId?: string,
    startMark?: Promise<SessionStartMark>,
  ): Promise<void> {
    const debug = requestId ? daemonDebug(requestId) : undefined;
    const requestBody = projectedBody;
    if (config.multiUser) requestBody.id = randomUUID();
    const requestedAgentProfile = requestBody.agent_profile;
    if (typeof requestedAgentProfile === "string") {
      let advertised = false;
      try {
        advertised = await machineAdvertisesAgentLaunchProfile(
          machine,
          requestedAgentProfile,
          String(requestBody.agent),
          typeof requestBody.provider_resume_id === "string"
            || typeof requestBody.resume_id === "string",
          debug,
        );
      } catch {
        await startMark;
        sendJson(res, 503, {
          ok: false,
          error: {
            code: "agent-profile-unavailable",
            message: "agent launch profile is unavailable on this machine",
          },
        });
        return;
      }
      if (!advertised) {
        await startMark;
        sendJson(res, 409, {
          ok: false,
          error: {
            code: "agent-profile-unavailable",
            message: "agent launch profile is unavailable on this machine",
          },
        });
        return;
      }
    }
    const expectedProvider = providerResumeId
      ? { provider: String(requestBody.agent), sessionId: providerResumeId }
      : undefined;
    let daemonResult: DaemonResult;
    try {
      daemonResult = await daemonFetch(machine, typeof requestBody.resume === "string" ? "/sessions/resume/v1" : "/sessions", {
        method: "POST",
        body: requestBody,
        timeoutMs: createSessionTimeoutMs(projectedBody),
        debug,
      });
    } catch (error) {
      // The parent lookup uses the access database. Settle it before an early
      // failure response lets shutdown close that database.
      await startMark;
      if (await claimFailedCreate(
        res, principal, machine, requestBody.id, expectedProvider, true, startMark, debug,
      )) return;
      throw error;
    }
    await startMark;
    if (typeof requestBody.resume === "string" && !daemonSucceeded(daemonResult)) {
      const error = resumeRefusal(objectProp(daemonResult.body)?.error);
      if (daemonResult.status === 404 || daemonResult.status === 405 || error) {
        const unsupported = daemonResult.status === 404 || daemonResult.status === 405;
        sendJson(res, unsupported ? 422 : daemonResult.status, { ok: false,
          error: unsupported ? resumeFailure("resume-unsupported") : error });
        return;
      }
    }
    if (!daemonSucceeded(daemonResult)
      && await claimFailedCreate(
        res, principal, machine, requestBody.id, expectedProvider, false, startMark, debug,
      )) return;
    if (config.multiUser && accessStore && daemonSucceeded(daemonResult)) {
      if (!claimCreatedDaemonSession(
        accessStore, principal.id, machine.name, daemonResult, requestBody.id,
        expectedProvider, await startMark,
      )) {
        sendJson(res, 502, { ok: false, error: { message: "session creation did not confirm ownership" } });
        return;
      }
    }
    forwardCreateDaemon(res, requestBody, daemonResult);
  }

  // A create can fail after the daemon already started the session: serve
  // answers an error once its prompt submission outlives its own budget, and
  // the edge request can time out or lose its connection while serve keeps
  // going. In multi-user mode the edge assigned the id, so it looks that id up
  // and claims a session it finds for the requesting principal, as a
  // successful create would, and answers with the session id so the caller
  // does not start a duplicate. After a thrown request serve may still be
  // starting the session, so the lookup polls briefly.
  async function claimFailedCreate(
    res: ServerResponse,
    principal: PrincipalConfig,
    machine: MachineConfig,
    sessionId: unknown,
    expectedProvider: { readonly provider: string; readonly sessionId: string } | undefined,
    poll: boolean,
    startMark: Promise<SessionStartMark> | undefined,
    debug: DaemonDebugContext | undefined,
  ): Promise<boolean> {
    if (!config.multiUser || !accessStore || typeof sessionId !== "string") return false;
    const deadline = Date.now() + (poll ? failedCreateLookupMs : 0);
    for (;;) {
      const created = await createdSessionSnapshot(machine, sessionId, debug);
      // A machine the lookup cannot reach never received the create either.
      if (created === null) return false;
      if (created) {
        if (!claimCreatedDaemonSession(
          accessStore, principal.id, machine.name,
          { status: 200, body: { ok: true, data: { session: created } } },
          sessionId, expectedProvider, await startMark,
        )) return false;
        sendJson(res, 502, {
          ok: false,
          error: {
            code: "create-outcome-unknown",
            message: `session ${sessionId} was created and claimed, but its create did not finish; check it before starting another`,
          },
        });
        return true;
      }
      if (Date.now() >= deadline) return false;
      await delay(failedCreateLookupIntervalMs);
    }
  }

  async function createdSessionSnapshot(
    machine: MachineConfig,
    sessionId: string,
    debug: DaemonDebugContext | undefined,
  ): Promise<Record<string, unknown> | null | undefined> {
    let snapshot: DaemonResult;
    try { snapshot = await daemonFetch(machine, "/sessions", { timeoutMs: FAILED_CREATE_LOOKUP_REQUEST_MS, debug }); }
    catch { return null; }
    if (!daemonSucceeded(snapshot)) return undefined;
    const sessions = (snapshot.body as { data?: { sessions?: unknown } } | undefined)?.data?.sessions;
    if (!Array.isArray(sessions)) return undefined;
    return sessions.map(objectProp).find((session) => session?.id === sessionId) ?? undefined;
  }

  async function withMachine(
    res: ServerResponse,
    name: string,
    fn: (machine: MachineConfig) => Promise<void>,
  ): Promise<void> {
    const machine = byName.get(name);
    const principal = requestPrincipals.get(res);
    if (!machine || (config.multiUser && (!principal || !principalCanAccessMachine(principal, name)))) {
      sendJson(res, 404, { ok: false, error: { message: `unknown machine: ${name}` } });
      return;
    }
    await fn(machine);
  }

  // Relay an authorized attach. While the machine's last attach connect stalled,
  // refuse at once: browsers run one WebSocket handshake per host at a time, so
  // holding this one for the connect deadline would queue attaches to healthy
  // machines behind it.
  const relayAttach = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    machine: MachineConfig,
    daemonPath: string,
    principal?: PrincipalConfig,
  ): void => {
    if (!attachHealth.shouldProbe(machine.name)) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    proxyUpgrade(req, socket, head, machine, daemonPath, { health: attachHealth,
      ...(principal?.managedCredential ? { isAuthorized: () => testerStillActive(principal) } : {}) });
  };

  // Browser WebSocket attach -> daemon attach, injecting the machine bearer token.
  server.on("close", () => { resourceWatches.close(); activityStreams.close(); });
  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // A peer reset during a *rejected* upgrade must not crash the shared process:
    // attach an error listener before any write/destroy. The success path installs
    // its own handlers in proxyUpgrade.
    socket.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://edge.local");
    const shellTarget = requireParams(matchPath("/api/shells/:machine/:incarnation/attach", url.pathname), ["machine", "incarnation"]);
    if (shellTarget) {
      const ticket = wsTickets.takeDetails(url.searchParams.get("ticket"), shellTarget.machine, `shell:${shellTarget.incarnation}`);
      const principal = ticket
        ? config.openAccess ? openPrincipal : config.multiUser
          ? principalById(ticket.principalId ?? "")
          : ticket.principalId === legacyPrincipal.id ? legacyPrincipal : undefined
        : principalForRequest(req);
      const machine = byName.get(shellTarget.machine);
      const reject = (status: string) => { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
      if (!ticket && !csrfExempt(req)) { reject("403 Forbidden"); return; }
      if (!principal || (principal.managedCredential && ticket
        && ticket.credentialFingerprint !== principal.token)) { reject("401 Unauthorized"); return; }
      if (config.multiUser && !principalCanUseTerminal(principal)) { reject("403 Forbidden"); return; }
      if (!machine || !principalCanAccessMachine(principal, machine.name)
        || ticket && (ticket.principalId !== principal.id || ticket.incarnation !== shellTarget.incarnation)) {
        reject("404 Not Found"); return;
      }
      // The daemon checks the incarnation at upgrade and at every input/resize;
      // browser paths never select an owner and stale tickets never create a shell.
      const path = `/shells/${encodeURIComponent(principal.id)}/attach?incarnation=${encodeURIComponent(shellTarget.incarnation)}`;
      relayAttach(req, socket, head, machine, path, principal);
      return;
    }
    const m = requireParams(matchPath("/api/sessions/:machine/:id/attach", url.pathname), ["machine", "id"]);
    if (!m) {
      socket.destroy();
      return;
    }
    // Same CSRF gate as the HTTP write routes (csrfExempt). Native clients
    // attach with a foreign Origin (http://tauri.localhost) but authenticate via
    // a one-time attach ticket, or legacy token subprotocol fallback, so they
    // stay exempt without trusting ambient browser credentials.
    const ticket = wsTickets.takeDetails(url.searchParams.get("ticket"), m.machine, m.id);
    const ticketAuthed = ticket !== undefined;
    const requestPrincipal = ticket && config.multiUser
      ? principalById(ticket.principalId ?? "")
      : principalForRequest(req);
    if (!ticketAuthed && !csrfExempt(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if ((!ticketAuthed && !requestPrincipal)
      || ticketAuthed && requestPrincipal?.managedCredential && ticket.credentialFingerprint !== requestPrincipal.token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (config.multiUser && requestPrincipal && !principalCanUseTerminal(requestPrincipal)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const machine = byName.get(m.machine);
    let ticketIncarnationMatches = !ticket;
    let ownsCurrent = !config.multiUser;
    try {
      if (config.multiUser && requestPrincipal) {
        if (isRootPrincipal(requestPrincipal)) {
          const incarnation = await currentSessionIncarnation(requestPrincipal, m.machine, m.id);
          ticketIncarnationMatches = !ticket || ticket.incarnation !== undefined && ticket.incarnation === incarnation;
          ownsCurrent = incarnation !== undefined;
        } else {
          ticketIncarnationMatches = !ticket || ticket.incarnation !== undefined
            && accessStore?.sessionIncarnation(actingOwnerOf(requestPrincipal, m.machine, m.id) ?? requestPrincipal.id, m.machine, m.id) === ticket.incarnation;
          if (ticketIncarnationMatches) ownsCurrent = await ownsCurrentSession(requestPrincipal, m.machine, m.id);
        }
      }
    } catch {
      ownsCurrent = false;
    }
    if (
      !machine
      || config.multiUser && (!requestPrincipal || !ticketIncarnationMatches || !ownsCurrent)
    ) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    relayAttach(req, socket, head, machine, `/sessions/${encodeURIComponent(m.id)}/attach`, requestPrincipal);
  });

  return server;
}

function visibleSessions(
  principal: PrincipalConfig,
  sessions: Array<Record<string, unknown>>,
  store: AccessStore | null,
  viewerAccess: ((machine: string, sessionId: string) => boolean) | null = null,
): Array<Record<string, unknown>> {
  if (!store) return [];
  if (isRootPrincipal(principal)) {
    // Observation must not run ownership inheritance, repair, or provider
    // claims on behalf of root. The durable owner remains the original one.
    return sessions.map((session) => {
      const machine = typeof session.machine === "string" ? session.machine : "";
      const id = typeof session.id === "string" ? session.id : "";
      const grant = store.sessionGrant(machine, id);
      const dispatchedBy = publicDispatchedBy(grant?.dispatcher);
      const launchedBy = publicDispatchedBy(grant?.launcher);
      return {
        ...session,
        ...(dispatchedBy ? { dispatched_by: dispatchedBy } : {}),
        ...(launchedBy ? { launched_by: launchedBy } : {}),
        ...publicCoordinatorTree(store.coordinatorTreeDepth(machine, id,
          typeof session.repo_name === "string" ? session.repo_name : null)),
      };
    });
  }
  const principalId = principal.id;
  const visible = new Set<number>();
  const needsBinding = new Set<number>();
  const dispatchers = new Map<number, SessionDispatchedBy>();
  const launchers = new Map<number, SessionDispatchedBy>();
  const treeDepths = new Map<number, number>();
  // The principal each visible session is claimed for: the caller, or the rule
  // owner for a selected session, so ownership stays with the owner.
  const claimants = new Map<number, string>();
  const claimDirect = (session: Record<string, unknown>, index: number): boolean => {
    const machine = session.machine;
    const id = session.id;
    const incarnation = session.session_incarnation;
    const resume = session.provider_resume as { provider?: unknown; session_id?: unknown } | null | undefined;
    if (
      typeof machine !== "string"
      || typeof id !== "string"
      || typeof incarnation !== "string"
    ) return false;
    const grant = store.sessionGrant(machine, id);
    if (!grant) return false;
    const claimant = grant.principalId === principalId ? principalId
      : viewerAccess?.(machine, id) ? grant.principalId : undefined;
    if (claimant === undefined) return false;
    if (grant.incarnation !== incarnation) {
      if (
        session.status !== "running"
        || typeof resume?.provider !== "string"
        || typeof resume.session_id !== "string"
        || !store.repairSessionIncarnation(
          claimant, machine, id, grant.incarnation, incarnation, resume.provider, resume.session_id,
          false, false, typeof session.runtime_started_at === "string" ? session.runtime_started_at : undefined,
        ) && !store.ownsSession(claimant, machine, id, incarnation)
      ) return false;
    }
    visible.add(index);
    claimants.set(index, claimant);
    const dispatchedBy = publicDispatchedBy(grant.dispatcher);
    if (dispatchedBy) dispatchers.set(index, dispatchedBy);
    const launchedBy = publicDispatchedBy(grant.launcher);
    if (launchedBy) launchers.set(index, launchedBy);
    const treeDepth = store.coordinatorTreeDepth(machine, id, typeof session.repo_name === "string" ? session.repo_name : null);
    if (treeDepth !== null) treeDepths.set(index, treeDepth);
    const startedAt = typeof session.runtime_started_at === "string"
      ? Date.parse(session.runtime_started_at) : NaN;
    if (
      grant.provider === null && grant.providerSessionId === null
      || Number.isFinite(startedAt) && (
        grant.runtimeStartedAt === null || startedAt > Date.parse(grant.runtimeStartedAt)
      )
    ) needsBinding.add(index);
    return true;
  };
  sessions.forEach(claimDirect);

  return sessions.flatMap((session, index) => {
    if (!visible.has(index)) return [];
    const resume = session.provider_resume as { provider?: unknown; session_id?: unknown } | null | undefined;
    if (
      typeof session.machine === "string"
      && typeof resume?.provider === "string"
      && typeof resume.session_id === "string"
    ) {
      try {
        const claimant = claimants.get(index) ?? principalId;
        store.claimProvider(claimant, session.machine, resume.provider, resume.session_id);
        if (
          needsBinding.has(index)
          && typeof session.id === "string"
          && typeof session.session_incarnation === "string"
        ) {
          store.bindSessionProvider(
            claimant, session.machine, session.id, session.session_incarnation,
            resume.provider, resume.session_id,
            typeof session.runtime_started_at === "string" ? session.runtime_started_at : undefined,
          );
        }
      } catch {
        // A provider identity conflict must not transfer history ownership. The
        // exact live-session grant remains valid for the trusted collaborator.
      }
    }
    const dispatchedBy = dispatchers.get(index);
    const launchedBy = launchers.get(index);
    return [{
      ...session,
      ...(dispatchedBy ? { dispatched_by: dispatchedBy } : {}),
      ...(launchedBy ? { launched_by: launchedBy } : {}),
      ...publicCoordinatorTree(treeDepths.get(index)),
    }];
  });
}

function advanceResumedSessionOwnership(
  store: AccessStore,
  principal: PrincipalConfig,
  actsForOwner: boolean,
  machine: string,
  sessionId: string,
  previousIncarnation: string | undefined,
  nextIncarnation: unknown,
): boolean {
  const grant = store.sessionGrant(machine, sessionId);
  if (actsForOwner && (!grant || grant.incarnation !== previousIncarnation)) {
    return false;
  }
  return typeof previousIncarnation === "string"
    && typeof nextIncarnation === "string"
    && store.advanceSessionIncarnation(
      actsForOwner ? grant!.principalId : principal.id, machine, sessionId,
      previousIncarnation, nextIncarnation,
    );
}

function claimCreatedDaemonSession(
  store: AccessStore,
  principalId: string,
  machine: string,
  result: DaemonResult,
  expectedId?: unknown,
  expectedProvider?: { readonly provider: string; readonly sessionId: string },
  startMark?: SessionStartMark,
): boolean {
  const created = (result.body as {
    ok?: unknown;
    data?: { session?: Record<string, unknown> };
  } | undefined)?.data?.session;
  if (
    result.status < 200 || result.status >= 300
    || !created
    || typeof created.id !== "string"
    || typeof created.session_incarnation !== "string"
    || created.session_incarnation.length === 0
    || typeof expectedId === "string" && created.id !== expectedId
  ) return false;
  const resume = created.provider_resume as { provider?: unknown; session_id?: unknown } | undefined;
  if (expectedProvider && (resume?.provider !== expectedProvider.provider
    || resume.session_id !== expectedProvider.sessionId)) return false;
  store.claimImport({
    principalId,
    sessions: [{
      principalId,
      machine,
      sessionId: created.id,
      incarnation: created.session_incarnation,
      ...(typeof created.runtime_started_at === "string"
        ? { runtimeStartedAt: created.runtime_started_at } : {}),
      ...(typeof resume?.provider === "string" && typeof resume.session_id === "string"
        ? { provider: resume.provider, providerSessionId: resume.session_id }
        : {}),
      // A session the user starts (no relay start mark) is outside every
      // coordinator's tree.
      ...(startMark ?? { treeDepth: OUTSIDE_COORDINATOR_TREE }),
    }],
    providers: typeof resume?.provider === "string" && typeof resume.session_id === "string"
      ? [{ machine, provider: resume.provider, providerSessionId: resume.session_id }]
      : [],
    histories: [],
  });
  return true;
}

function daemonSucceeded(result: DaemonResult): boolean {
  return result.status >= 200
    && result.status < 300
    && (result.body as { ok?: unknown } | undefined)?.ok !== false;
}

function normalizeTitleSummaryTrace(value: unknown): TitleSummaryTrace | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const attemptId = raw.attemptId;
  const machine = raw.machine;
  const sessionId = raw.sessionId;
  const phase = raw.phase;
  const attempt = raw.attempt;
  if (
    typeof attemptId !== "string"
    || !/^title_[A-Za-z0-9_-]{8,72}$/.test(attemptId)
    || !safeTitleTraceIdentity(machine, 512)
    || !safeTitleTraceIdentity(sessionId, 512)
    || typeof phase !== "string"
    || !TITLE_SUMMARY_PHASES.includes(phase as TitleSummaryTrace["phase"])
    || typeof attempt !== "number"
    || !Number.isSafeInteger(attempt)
    || attempt < 1
    || attempt > 100
  ) {
    return undefined;
  }
  return {
    attemptId,
    machine,
    sessionId,
    phase: phase as TitleSummaryTrace["phase"],
    attempt,
  };
}

function safeTitleTraceIdentity(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function titleTraceSessionCorrelation(sessionId: string): string {
  return `trace_${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
}

// The create-request form of a root: the target daemon names the session
// itself as `root`, so a recorded lineage always has one.
const CONSOLE_ROOT_LINEAGE = {
  schema_version: SESSION_LINEAGE_SCHEMA,
  parent: null,
  root: null,
  depth: 0,
  starter: { kind: "console", via: "console" },
};

function projectCreateSessionBody(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.agent !== "string" || raw.agent.length === 0 || raw.agent.length > 32) return null;
  const body: Record<string, unknown> = { agent: raw.agent };
  if (raw.workspace !== undefined) {
    const workspace = normalizeSessionWorkspace(raw.workspace);
    if (raw.workspace !== null && workspace === null) return null;
    body.workspace = workspace;
  }
  if (raw.agent_profile !== undefined) {
    const agentProfile = normalizeAgentLaunchProfileId(raw.agent_profile);
    if (agentProfile === undefined) return null;
    body.agent_profile = agentProfile;
  }
  for (const field of ["id", "cwd", "title", "prompt", "provider_resume_id", "resume_id"] as const) {
    const item = raw[field];
    if (item === undefined) continue;
    if (typeof item !== "string") return null;
    body[field] = item;
  }
  if (raw.agent_args !== undefined) {
    if (!Array.isArray(raw.agent_args) || !raw.agent_args.every((item) => typeof item === "string")) return null;
    // A launch profile owns its whole launch command, so the browser may not append
    // to it — the same reason agent_bin, provider_config_dir and readiness_args are
    // dropped above. Without this the profile's own argv is only the prefix of
    // whatever a caller supplies.
    if (body.agent_profile === undefined) {
      body.agent_args = raw.agent_args;
    }
  }
  if (raw.title_state !== undefined) {
    const titleState = normalizeSessionTitleState(raw.title_state);
    if (!titleState) return null;
    body.title_state = titleState;
  }
  // `<provider>_account` binds the new session to that broker account; it is
  // valid only for a session of that provider.
  for (const provider of ACCOUNT_PROVIDERS) {
    const field = `${provider}_account` as const;
    if (raw[field] === undefined) continue;
    const account = normalizeAccountNickname(raw[field]);
    if (raw.agent !== provider || account === null) return null;
    body[field] = account;
  }
  return body;
}

function sessionCookie(id: string, maxAge: number, secure: boolean): string {
  return serializeSetCookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "Strict",
    secure,
    path: "/",
    maxAge,
  });
}

interface ReachableSendResult {
  readonly status?: number;
  readonly ok?: boolean;
  readonly data: Record<string, unknown>;
  readonly error?: { readonly message: string };
}

async function sendReachableData(
  res: ServerResponse,
  reader: HostReader | null,
  empty: Record<string, unknown>,
  fetchData: (reader: HostReader) => Promise<ReachableSendResult> | ReachableSendResult,
): Promise<void> {
  if (!reader) {
    sendJson(res, 200, { ok: true, data: { ...empty, reachable: false } });
    return;
  }
  try {
    const result = await fetchData(reader);
    sendJson(res, result.status ?? 200, {
      ok: result.ok ?? true,
      ...(result.error ? { error: result.error } : {}),
      data: { ...result.data, reachable: true },
    });
  } catch (err) {
    sendJson(res, 200, { ok: true, data: { ...empty, reachable: false, error: (err as Error).message } });
  }
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { ok: false, error: { message: "method not allowed" } });
}
