import { normalizeConversationImages } from "@agent-console/shared/conversation-images";
import { parseSessionNotice } from "@agent-console/shared";
import { getPrincipalStorageNamespace } from "./storage.ts";
import { validOutboxText, SHARED_OUTBOX_MAX_ITEMS, SHARED_OUTBOX_MAX_HOLDS, type RefusedOutboxAction, type SharedOutboxItem, type SharedOutboxSnapshot } from "@agent-console/shared/shared-outbox";
import { isPromptRequestId, normalizePromptReceipt, type PromptReceipt } from "@agent-console/shared/prompt-receipt";
import { notePromptDelivery } from "./promptDelivery.ts";
import { normalizeSessionModelSettings } from "@agent-console/shared/session-model";
import { normalizeEmergencyShell, type EmergencyShell } from "@agent-console/shared/shell";
import { readReachableWithRecovery } from "./reachableRequest.ts";
import type { AsyncPollTick } from "./useAsyncPoll.ts";
import type { SpecialKey } from "./frames.ts";
import type {
  DebugDiagnosticProbe,
  DebugDiagnosticResult,
  DebugEventsResult,
  LayoutDocument,
  TitleSummaryResult as SharedTitleSummaryResult,
  TitleSummaryRequest,
  UsageResult,
  StartupStatus,
  AgentLaunchProfileSummary,
  MachineStatus,
  MachinePreference,
  CodexRateLimitResetOutcome,
  ClaudeLimitResetOutcome,
  ClaudeLimitResetProgram,
  AccountInventory,
  AccountProvider,
  AccountStatusByProvider,
  AgentConsolePrincipal,
} from "@agent-console/shared/api";
import {
  ACCOUNT_PROVIDER_LABELS,
  ACCOUNT_SWITCH_TIMEOUT_MS,
  CLAUDE_LIMIT_RESET_OUTCOMES,
  CODEX_ACCOUNT_READINESS_SCHEMA_VERSION,
  TITLE_SUMMARY_DIAGNOSTIC_REASONS,
  confirmsAccountSwitch,
  normalizeAccountStatus,
  normalizeAccountSummaries,
  normalizeAgentLaunchProfiles,
  normalizeAgentLaunchProfileId,
  normalizeAgentSessionCapabilities,
  normalizeCodexAccountReadiness,
  normalizeSelectionStrategies,
  machineServesAccountSwitch,
  usageSwitchKey,
  normalizeLastPromptContinuity,
  normalizeStartupStatus,
  normalizeOrder as normalizeLayoutOrder,
  normalizeAgentConsolePrincipal,
  normalizeRevision as layoutRevision,
  normalizePublicSessionDeleteResult,
  normalizeSessionRefresh,
  projectPublicAgentSession,
  normalizeSessionCoordinatorTree,
  normalizeSessionDispatchedBy,
} from "@agent-console/shared/api";
import {
  MAINTENANCE_SCHEMA_VERSION,
  MAINTENANCE_SCHEMA_VERSION_V2,
  normalizeSessionMaintenanceActionResult,
  normalizeSessionMaintenanceError,
  normalizeSessionMaintenancePreview,
  type MaintenanceOperation,
  type SessionMaintenanceActionRequest,
  type SessionMaintenanceActionResult,
  type SessionMaintenanceError,
  type SessionMaintenancePreview,
} from "@agent-console/shared/maintenance";
import {
  normalizeSessionTitleState,
  sessionTitleStatesEqual,
  type SessionTitleState,
} from "@agent-console/shared/title";
import type {
  CreateBody,
  Glance,
  HistoryMessage,
  HistoryMessagesResponse,
  HistorySession,
  HistorySessionsResponse,
  Session,
  SessionsResponse,
} from "./types.ts";
import { appBootElapsedMs, appFetch, isAndroidTauri, isTauri, nativeConnectionConfigGeneration, recordNativeAuthentication, wsProtocols, wsUrl } from "./runtime.ts";
import { createBoundedSingleFlight } from "./singleFlightRequest.ts";
import { createBoundedRequestGate } from "./boundedRequestGate.ts";
import { RequestCapacityError, withRequestDeadline } from "./requestDeadline.ts";
import { createDebugRequestId, recordDebugEvent } from "./debugLog.ts";
import { ANDROID_STARTUP_RECOVERY_DEADLINE_MS } from "./startupDeadline.ts";
import { loadPerformanceCapture } from "./performanceSummary.ts";
import {
  normalizeSessionRetitleError,
  normalizeSessionRetitleReadiness,
  normalizeSessionRetitleRequest,
  normalizeSessionRetitleResult,
  normalizeSessionRetitleV3Readiness,
  normalizeSessionRetitleV3Request,
  normalizeSessionRetitleV3Receipts,
  normalizeSessionRetitleV3Result,
  type SessionRetitleReadiness,
  type SessionRetitleRequest,
  type SessionRetitleResult,
  type SessionRetitleErrorCode,
  type SessionRetitleV3Readiness,
  type SessionRetitleV3Request,
  type SessionRetitleV3Receipt,
  type SessionRetitleV3Receipts,
  type SessionRetitleV3Result,
} from "@agent-console/shared/session-retitle";
import { sessionRetitlePath } from "./sessionRetitle.ts";

import type { SpeechProviderSummary, SpeechTranscription } from "@agent-console/shared/speech";

// Classify a rejected or aborted switch only after the edge had time to return
// its authoritative outcome.
const ACCOUNT_SWITCH_REQUEST_TIMEOUT_MS = ACCOUNT_SWITCH_TIMEOUT_MS + 5_000;
const SESSION_LIST_REQUEST_TIMEOUT_MS = 8_000;
const AUTH_STATUS_REQUEST_TIMEOUT_MS = 8_000;
const ATTACH_TICKET_REQUEST_TIMEOUT_MS = 8_000;
let sessionPollEpoch = 0;
const readSessionList = createBoundedSingleFlight((key: string, signal) =>
  req(key.slice(key.indexOf("\0") + 1), { signal }, "poll"));
const readAttachTicket = createBoundedRequestGate((key: string, signal) =>
  postJson(key.slice(key.indexOf("\0") + 1), {}, signal));
export function resetSessionPollRequests(): void {
  sessionPollEpoch += 1;
  readSessionList.reset();
}
export type { SessionRetitleV3Receipt, SessionRetitleV3Receipts };
export type {
  DebugAgentBundle,
  DebugClientInfo,
  DebugClientSurface,
  DebugDiagnosticProbe,
  DebugDiagnosticResult,
  DebugEvent,
  DebugEventsResult,
  ClaudeGrantedResets,
  ClaudeLimitResetOutcome,
  ClaudeLimitResetProgram,
  ClaudeLimitResets,
  ClaudeSessionReset,
  ProviderUsage,
  ProviderUsageReason,
  Reachable,
  TitleSummaryRequest,
  UsageResult,
  UsageWindow,
} from "@agent-console/shared/api";

export async function getSpeechProviders(): Promise<readonly SpeechProviderSummary[]> {
  const response = await req("/api/speech/providers");
  if (!resultOf(response).ok) throw new Error("Speech providers are unavailable");
  const data = (response.body as { data?: { providers?: unknown } } | undefined)?.data?.providers;
  if (!Array.isArray(data)) throw new Error("Speech providers returned an invalid response");
  return data.filter((item): item is SpeechProviderSummary =>
    item !== null && typeof item === "object"
      && typeof item.id === "string" && typeof item.label === "string"
      && typeof item.max_duration_seconds === "number" && typeof item.max_bytes === "number");
}

export async function transcribeSpeechAudio(provider: string, audio: Blob, signal?: AbortSignal): Promise<SpeechTranscription> {
  const route = `/api/speech/${encodeURIComponent(provider)}/transcriptions`;
  const requestId = createDebugRequestId();
  const started = performance.now();
  let status: number | null = null;
  try {
    const response = await appFetch(route, {
      method: "POST",
      headers: { "content-type": audio.type || "application/octet-stream", "x-agent-console-request-id": requestId },
      body: audio,
      signal,
    });
    status = response.status;
    const body = await response.json() as { ok?: unknown; data?: unknown; error?: { message?: unknown } };
    if (!response.ok || body.ok !== true) {
      throw new Error(typeof body.error?.message === "string" ? body.error.message : "Transcription failed");
    }
    const data = body.data as Partial<SpeechTranscription> | undefined;
    if (typeof data?.text !== "string" || typeof data.provider !== "string") {
      throw new Error("Speech service returned an invalid response");
    }
    return { text: data.text, language: typeof data.language === "string" ? data.language : null, provider: data.provider };
  } finally {
    // Speech and transcript contents never enter the persisted debug event ring.
    recordDebugEvent({
      source: "client", request_id: requestId, method: "POST", route,
      status, ok: status === 200, duration_ms: performance.now() - started,
    });
  }
}

export interface CodexRateLimitResetMutationResult extends ApiResult {
  readonly outcome?: CodexRateLimitResetOutcome;
  readonly windowsReset?: number;
}

export interface ClaudeLimitResetMutationResult extends ApiResult {
  readonly outcome?: ClaudeLimitResetOutcome;
  readonly reason?: string;
  readonly resetsLeft?: number;
  readonly nextAvailableAt?: number;
  readonly cooldownUntil?: number;
}

// Requests route through the runtime shim (appFetch/wsUrl): in the browser they
// are same-origin and carry the httpOnly session cookie (token never held in JS
// after login); in native apps they target the configured server with the client
// token over the native auth path. The edge injects the per-machine bearer token
// upstream in both cases.
interface Json {
  readonly status: number;
  readonly body: unknown;
  readonly malformed?: boolean;
}

async function req(path: string, init?: RequestInit, provenance?: "poll" | "fresh"): Promise<Json> {
  const requestId = createDebugRequestId();
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  headers.set("x-agent-console-request-id", requestId);
  const started = performance.now();
  if ((path.split("?")[0] === "/api/sessions" || path.endsWith("/attach-ticket")) &&
    loadPerformanceCapture()) {
    recordDebugEvent({ source: "client", request_id: requestId, method, route: path,
      phase: "request_start", provenance });
  }
  try {
    const res = await appFetch(path, { ...init, headers });
    let body: unknown = undefined;
    let malformed = false;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        malformed = true;
        body = { ok: false, error: { message: "bad response" } };
      }
    }
    const envelope = body as { ok?: boolean; error?: { message?: string } } | undefined;
    recordDebugEvent({
      source: "client",
      request_id: requestId,
      method,
      route: path,
      status: res.status,
      ok: res.status >= 200 && res.status < 300 && envelope?.ok !== false,
      duration_ms: performance.now() - started,
      provenance,
      error: envelope?.ok === false ? envelope.error?.message : undefined,
      errorEnvelope: body,
    });
    return { status: res.status, body, ...(malformed ? { malformed: true } : {}) };
  } catch (err) {
    recordDebugEvent({
      source: "client",
      request_id: requestId,
      method,
      route: path,
      status: null,
      ok: false,
      duration_ms: performance.now() - started,
      provenance,
      error: (err as Error).message,
    });
    throw err;
  }
}

function postJson(path: string, payload: unknown, signal?: AbortSignal): Promise<Json> {
  return req(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

function patchJson(path: string, payload: unknown, signal?: AbortSignal): Promise<Json> {
  return req(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

export interface AuthStatus {
  readonly authenticated: boolean;
  // Open-access deploy (no login gate): the UI hides the "Sign out" control.
  readonly openAccess: boolean;
  readonly principal: AgentConsolePrincipal | null;
  readonly startupFailure?: "timeout" | "transport";
}

export async function getAuthStatus(options?: { initialStartup?: boolean }): Promise<AuthStatus> {
  const started = performance.now();
  const generation = nativeConnectionConfigGeneration();
  let r: Json;
  try {
    r = await withRequestDeadline(
      (signal) => req("/api/auth/status", { signal }),
      options?.initialStartup
        ? Math.max(0, (isAndroidTauri() ? ANDROID_STARTUP_RECOVERY_DEADLINE_MS : AUTH_STATUS_REQUEST_TIMEOUT_MS) - appBootElapsedMs())
        : AUTH_STATUS_REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    recordNativeAuthentication(generation, false, null);
    const startupFailure = error instanceof DOMException && error.name === "TimeoutError"
      ? "timeout" : "transport";
    if (startupFailure === "timeout") {
      recordDebugEvent({
        source: "client", method: "GET", route: "/api/auth/status", ok: false,
        duration_ms: performance.now() - started, error: "Authentication startup timed out",
      });
    }
    // Startup must leave the boot screen even if native HTTP rejects or stays
    // pending after abort. Connection settings/login provide the retry path.
    return { authenticated: false, openAccess: false, principal: null, startupFailure };
  }
  const b = r.body as { authenticated?: boolean; openAccess?: boolean; principal?: unknown } | undefined;
  if (isTauri() && generation !== nativeConnectionConfigGeneration()) {
    return { authenticated: false, openAccess: false, principal: null, startupFailure: "transport" };
  }
  const authenticated = r.status >= 200 && r.status < 300 && b?.authenticated === true;
  const principal = normalizeAgentConsolePrincipal(b?.principal);
  recordNativeAuthentication(generation, authenticated, principal?.id ?? null);
  return {
    authenticated,
    openAccess: Boolean(b?.openAccess),
    principal,
  };
}

export async function login(token: string): Promise<boolean> {
  const r = await postJson("/api/auth/login", { token });
  return r.status === 200;
}

export async function logout(): Promise<void> {
  await postJson("/api/auth/logout", {});
}

function normalizeMachineStatuses(value: unknown, profileResumeImport: boolean): MachineStatus[] {
  if (!Array.isArray(value)) return [];
  const machines: MachineStatus[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.name !== "string" || !raw.name || typeof raw.ok !== "boolean") continue;
    const capabilities = normalizeAgentSessionCapabilities(raw.capabilities);
    const profiles: AgentLaunchProfileSummary[] = normalizeAgentLaunchProfiles(raw.agent_profiles)
      .map((profile) => ({
        ...profile,
        provider_resume_import_supported: Boolean(
          profileResumeImport
          && capabilities.profile_resume_import === true
          && profile.provider_resume_import_supported === true
        ),
      }));
    machines.push({
      name: raw.name,
      ok: raw.ok,
      ...(typeof raw.active === "boolean" ? { active: raw.active } : {}),
      ...(typeof raw.error === "string" && raw.error.length <= 512 ? { error: raw.error } : {}),
      ...(typeof raw.observed_at === "string" && raw.observed_at.length <= 64
        ? { observed_at: raw.observed_at }
        : {}),
      ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
      ...(profiles.length > 0 ? { agent_profiles: profiles } : {}),
    });
  }
  return machines;
}

export async function listSessions(
  machines?: readonly string[],
  signal?: AbortSignal,
  requestMode: "fresh" | "poll" | "recovery" = "fresh",
): Promise<SessionsResponse> {
  // A machines allowlist scopes the edge's fan-out to selected hosts. Omit the
  // param entirely (undefined) to aggregate all configured machines.
  const qs = machines ? `?machines=${machines.map(encodeURIComponent).join(",")}` : "";
  const path = `/api/sessions${qs}`;
  const configGeneration = nativeConnectionConfigGeneration();
  const pollEpoch = sessionPollEpoch;
  let r: Json;
  try {
    r = requestMode === "fresh"
      ? await withRequestDeadline((requestSignal) => req(path, { signal: requestSignal }, "fresh"),
        SESSION_LIST_REQUEST_TIMEOUT_MS, signal)
      : await (requestMode === "recovery" ? readSessionList.recover : readSessionList)(
        `${configGeneration}\0${path}`, SESSION_LIST_REQUEST_TIMEOUT_MS, signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError" && loadPerformanceCapture()) {
      recordDebugEvent({ source: "client", method: "GET", route: "/performance/session-list",
        phase: err instanceof RequestCapacityError ? "capacity_rejected" : "deadline_timeout",
        ok: false, duration_ms: err instanceof RequestCapacityError ? null : SESSION_LIST_REQUEST_TIMEOUT_MS });
    }
    throw err;
  }
  if (configGeneration !== nativeConnectionConfigGeneration() ||
    (requestMode !== "fresh" && pollEpoch !== sessionPollEpoch)) {
    throw new DOMException("Connection settings changed", "AbortError");
  }
  const b = r.body as { ok?: boolean; data?: Partial<SessionsResponse> } | undefined;
  const autoResumeControl = b?.data?.capabilities?.auto_resume_control === true;
  const profileResumeImport = b?.data?.capabilities?.profile_resume_import === true;
  const managedResumeCommand = b?.data?.capabilities?.managed_resume_command === true;
  const resumeBlockedReason = b?.data?.capabilities?.resume_blocked_reason === true;
  const lastPrompt = b?.data?.capabilities?.last_prompt === true;
  const lastMessage = b?.data?.capabilities?.last_message === true;
  const history = b?.data?.capabilities?.history === true;
  const archive = b?.data?.capabilities?.archive === true;
  const sessionRetitleV2 = b?.data?.capabilities?.session_retitle_v2 === true;
  const sessionRetitleV3 = b?.data?.capabilities?.session_retitle_v3 === true;
  const normalizedMachines = normalizeMachineStatuses(b?.data?.machines, profileResumeImport);
  const machineCapabilities = new Map(normalizedMachines.map((machine) => [machine.name, machine.capabilities]));
  const ext = b?.data?.ext && typeof b.data.ext === "object" && !Array.isArray(b.data.ext) ? b.data.ext : undefined;
  const sessions = (b?.data?.sessions ?? []).map((rawSession): Session => {
    const rawMachine = typeof rawSession.machine === "string" && rawSession.machine.length <= 512
      ? rawSession.machine
      : undefined;
    const rawActivityObservedAt = typeof rawSession.activity_observed_at === "string"
      && rawSession.activity_observed_at.length <= 64
      ? rawSession.activity_observed_at
      : undefined;
    const dispatchedBy = normalizeSessionDispatchedBy(rawSession.dispatched_by);
    const coordinatorTree = normalizeSessionCoordinatorTree(rawSession.coordinator_tree);
    const session = {
      ...projectPublicAgentSession(rawSession),
      ...(dispatchedBy ? { dispatched_by: dispatchedBy } : {}),
      ...(coordinatorTree ? { coordinator_tree: coordinatorTree } : {}),
      ...(rawMachine ? { machine: rawMachine } : {}),
      ...(rawActivityObservedAt ? { activity_observed_at: rawActivityObservedAt } : {}),
    } as Session & Record<string, unknown>;
    const titleRevision = nonNegativeInteger(session.title_revision);
    const agentProfile = normalizeAgentLaunchProfileId(session.agent_profile);
    const sessionIncarnation = typeof session.session_incarnation === "string"
      && session.session_incarnation.trim()
      ? session.session_incarnation
      : undefined;
    const {
      title_revision: _titleRevision,
      title_state: _titleState,
      title_state_supported: _titleStateSupported,
      session_incarnation: _sessionIncarnation,
      agent_profile: _agentProfile,
      resume_blocked_reason: _resumeBlockedReason,
      managed_resume_command_available: _managedResumeCommandAvailable,
      last_prompt: _lastPrompt,
      last_message: _lastMessage,
      last_prompt_state: _lastPromptState,
      last_prompt_continuity: _lastPromptContinuity,
      startup: _startup,
      claude_account: _claudeAccount,
      ...safeSession
    } = session;
    const titleState = session.title_state;
    const daemonCapabilities = machineCapabilities.get(session.machine);
    const retitlePath = sessionRetitlePath({
      ...(sessionRetitleV2 ? { session_retitle_v2: true } : {}),
      ...(sessionRetitleV3 ? { session_retitle_v3: true } : {}),
    }, daemonCapabilities);
    const normalizedResumeBlockedReason = resumeBlockedReason
      && daemonCapabilities?.resume_blocked_reason === true
      ? session.resume_blocked_reason
      : undefined;
    const lastPromptContractSupported = lastPrompt
      && daemonCapabilities?.last_prompt === true;
    const hasLastPromptState = Object.hasOwn(session, "last_prompt_state");
    const rawLastPromptState = lastPromptContractSupported
      ? session.last_prompt_state
      : undefined;
    const normalizedLastPromptState = rawLastPromptState === "current"
      || rawLastPromptState === "pending"
      || rawLastPromptState === "unavailable"
      ? rawLastPromptState
      : undefined;
    const normalizedLastPromptContinuity = lastPromptContractSupported
      && normalizedLastPromptState !== undefined
      ? normalizeLastPromptContinuity(session.last_prompt_continuity)
      : undefined;
    const normalizedLastPrompt = !lastPromptContractSupported
      || !hasLastPromptState
      || normalizedLastPromptState === "current"
      ? session.last_prompt
      : undefined;
    return {
      ...safeSession,
      ...(titleState ? { title_state: titleState } : {}),
      ...(session.title_state_supported === true ? { title_state_supported: true } : {}),
      ...(agentProfile === undefined ? {} : { agent_profile: agentProfile }),
      ...(titleRevision === undefined ? {} : { title_revision: titleRevision }),
      ...(sessionIncarnation === undefined ? {} : { session_incarnation: sessionIncarnation }),
      ...(managedResumeCommand
        && daemonCapabilities?.managed_resume_command === true
        && normalizedResumeBlockedReason === undefined
        ? { managed_resume_command_available: true }
        : {}),
      ...(normalizedResumeBlockedReason ? { resume_blocked_reason: normalizedResumeBlockedReason } : {}),
      ...(normalizedLastPrompt ? { last_prompt: normalizedLastPrompt } : {}),
      ...(lastMessage && daemonCapabilities?.last_message === true && session.last_message
        ? { last_message: session.last_message } : {}),
      ...(normalizedLastPromptState ? { last_prompt_state: normalizedLastPromptState } : {}),
      ...(normalizedLastPromptContinuity
        ? { last_prompt_continuity: normalizedLastPromptContinuity }
        : {}),
      ...(Object.hasOwn(session, "turn_state")
        ? { turn_state: session.turn_state }
        : {}),
      ...(Object.hasOwn(session, "auto_resume")
        ? {
          auto_resume: session.auto_resume,
          auto_resume_control_available: autoResumeControl,
        }
        : {}),
      // A binding shows only where the machine serves that provider's switch.
      ...(Object.hasOwn(session, "codex_account") && machineServesAccountSwitch("codex", daemonCapabilities)
        ? { codex_account: session.codex_account }
        : {}),
      ...(Object.hasOwn(session, "claude_account") && machineServesAccountSwitch("claude", daemonCapabilities)
        ? { claude_account: session.claude_account }
        : {}),
      ...(Object.hasOwn(session, "startup")
        ? { startup: session.startup }
        : {}),
      retitle_path: retitlePath,
    };
  });
  return {
    ok: Boolean(b?.ok),
    sessions,
    machines: normalizedMachines,
    ...(ext ? { ext } : {}),
    capabilities: {
      ...b?.data?.capabilities,
      auto_resume_control: autoResumeControl,
      profile_resume_import: profileResumeImport,
      managed_resume_command: managedResumeCommand,
      resume_blocked_reason: resumeBlockedReason,
      last_prompt: lastPrompt,
      last_message: lastMessage,
      history,
      archive,
      session_retitle_v2: sessionRetitleV2,
      session_retitle_v3: sessionRetitleV3,
    },
  };
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function normalizeHistorySession(value: unknown, machine: string): HistorySession | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = boundedString(raw.id, 80);
  const providerSessionId = boundedString(raw.provider_session_id, 256);
  const provider = raw.provider === "codex" || raw.provider === "claude"
    ? raw.provider
    : undefined;
  const cwd = boundedString(raw.cwd, 4096);
  const createdAt = boundedString(raw.created_at, 64);
  const updatedAt = boundedString(raw.updated_at, 64);
  if (!id || !providerSessionId || !provider || !cwd || !createdAt || !updatedAt) return undefined;
  const agentProfile = normalizeAgentLaunchProfileId(raw.agent_profile);
  const title = raw.title === null ? null : boundedString(raw.title, 512);
  const dispatchedBy = normalizeSessionDispatchedBy(raw.dispatched_by);
  const coordinatorTree = normalizeSessionCoordinatorTree(raw.coordinator_tree);
  return {
    id,
    machine,
    provider,
    provider_session_id: providerSessionId,
    ...(agentProfile ? { agent_profile: agentProfile } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(boundedString(raw.prompt_preview, 1024) ? { prompt_preview: raw.prompt_preview as string } : {}),
    ...(boundedString(raw.first_user_prompt_preview, 1024)
      ? { first_user_prompt_preview: raw.first_user_prompt_preview as string }
      : {}),
    ...(boundedString(raw.last_user_prompt_preview, 1024)
      ? { last_user_prompt_preview: raw.last_user_prompt_preview as string }
      : {}),
    cwd,
    ...(raw.repo_name === null
      ? { repo_name: null }
      : boundedString(raw.repo_name, 512)
        ? { repo_name: raw.repo_name as string }
        : {}),
    created_at: createdAt,
    updated_at: updatedAt,
    ...(boundedString(raw.archived_at, 64) ? { archived_at: raw.archived_at as string } : {}),
    ...(boundedString(raw.starred_at, 64) ? { starred_at: raw.starred_at as string } : {}),
    resumable: raw.resumable === true,
    ...(dispatchedBy ? { dispatched_by: dispatchedBy } : {}),
    ...(coordinatorTree ? { coordinator_tree: coordinatorTree } : {}),
  };
}

export async function listHistorySessions(
  machine: string,
  options: { readonly q?: string; readonly provider?: HistorySession["provider"]; readonly cursor?: string; readonly limit?: number } = {},
  signal?: AbortSignal,
): Promise<HistorySessionsResponse> {
  const params = new URLSearchParams({ machine });
  if (options.q?.trim()) params.set("q", options.q.trim());
  if (options.provider) params.set("provider", options.provider);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  const response = await req(`/api/history/sessions?${params.toString()}`, { signal });
  const result = resultOf(response);
  if (!result.ok) return { ...result, sessions: [], truncated: false };
  const data = (response.body as { data?: Record<string, unknown> } | undefined)?.data;
  const sessions = Array.isArray(data?.sessions)
    ? data.sessions.flatMap((value) => {
      const session = normalizeHistorySession(value, machine);
      return session ? [session] : [];
    })
    : [];
  return {
    ok: true,
    sessions,
    ...(boundedString(data?.next_cursor, 256) ? { nextCursor: data?.next_cursor as string } : {}),
    truncated: data?.truncated === true,
    ...(
      data?.capabilities
      && typeof data.capabilities === "object"
      && !Array.isArray(data.capabilities)
      && (data.capabilities as Record<string, unknown>).latest_message_paging === true
        ? { latestMessagePaging: true }
        : {}
    ),
    ...(
      data?.capabilities
      && typeof data.capabilities === "object"
      && !Array.isArray(data.capabilities)
      && (data.capabilities as Record<string, unknown>).star === true
        ? { starAvailable: true }
        : {}
    ),
    ...(
      data?.capabilities
      && typeof data.capabilities === "object"
      && !Array.isArray(data.capabilities)
      && (data.capabilities as Record<string, unknown>).resume === true
        ? { resumeAvailable: true }
        : {}
    ),
  };
}

/** The star a call left in place: absent once the star is cleared. */
export interface StarredResult extends ApiResult {
  readonly starredAt?: string;
}

export type HistoryStarResult = StarredResult;
export interface ArchiveSessionResult extends StarredResult {
  readonly errorCode?: string;
}

const DETERMINATE_HISTORY_RESUME_FAILURE_CODES = new Set([
  "history-session-not-found",
  "history-resume-not-supported",
  "history-resume-identity-mismatch",
  "agent-profile-unavailable",
  "history-resume-profile-unavailable",
  "provider-session-already-running",
  "history-read-failed",
]);

export async function setHistoryStar(
  machine: string,
  historyId: string,
  starred: boolean,
): Promise<HistoryStarResult> {
  const response = await postJson(
    `/api/history/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(historyId)}/star`,
    { starred },
  );
  const base = resultOf(response);
  if (!base.ok) return base;
  const data = (response.body as { data?: Record<string, unknown> } | undefined)?.data;
  const starredAt = boundedString(data?.starred_at, 64);
  return { ok: true, ...(starredAt ? { starredAt } : {}) };
}

export async function resumeHistorySession(
  machine: string,
  historyId: string,
): Promise<CreateSessionResult> {
  const response = await req(
    `/api/history/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(historyId)}/resume`,
    { method: "POST" },
  );
  const result = resultOf(response);
  if (!result.ok) {
    if (response.status >= 200 && response.status < 300) {
      return {
        ok: false,
        error: "History resume response could not be confirmed.",
        outcomeUnknown: true,
      };
    }
    const error = (response.body as { error?: { code?: unknown; live_session_id?: unknown } } | undefined)?.error;
    const code = error?.code;
    const errorCode = typeof code === "string" ? code : undefined;
    // The daemon refused a duplicate because a live session already owns the
    // conversation: open that session, as a resume would have.
    if (errorCode === "history-session-live" && typeof error?.live_session_id === "string" && error.live_session_id) {
      return { ok: true, id: error.live_session_id, alreadyLive: true };
    }
    return {
      ...result,
      ...(errorCode ? { errorCode } : {}),
      ...(response.status >= 500 && !DETERMINATE_HISTORY_RESUME_FAILURE_CODES.has(errorCode ?? "")
        ? { outcomeUnknown: true }
        : {}),
    };
  }
  const rawSession = (
    response.body as { data?: { session?: Record<string, unknown> } } | undefined
  )?.data?.session;
  const session = normalizeCreatedSession(rawSession, machine);
  if (!session) {
    return {
      ok: false,
      error: "History resume returned no created session.",
      outcomeUnknown: true,
    };
  }
  return {
    ok: true,
    id: session.id,
    session,
  };
}

/** Look up an ambiguous History resume in the caller's owner-scoped live inventory. */
export async function lookupLiveHistorySession(
  machine: string,
  provider: HistorySession["provider"],
  providerSessionId: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const inventory = await listSessions([machine], signal, "fresh");
  if (!inventory.ok || inventory.machines.find((candidate) => candidate.name === machine)?.ok !== true) {
    throw new Error("Live sessions could not be checked.");
  }
  const matches = inventory.sessions.filter((candidate) =>
    candidate.machine === machine
    && candidate.status === "running"
    && candidate.provider_resume?.provider === provider
    && candidate.provider_resume.session_id === providerSessionId);
  return matches.length === 1 ? matches[0]?.id : undefined;
}


function normalizeHistoryMessage(value: unknown): HistoryMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = boundedString(raw.id, 160);
  const role = raw.role === "user" || raw.role === "assistant" || raw.role === "goal" || raw.role === "notice" ? raw.role : undefined;
  const text = typeof raw.text === "string" && raw.text.length <= 64 * 1024 ? raw.text : undefined;
  const images = normalizeConversationImages(raw.images);
  if (!id || !role || text === undefined || (!text && !images.length)) return undefined;
  // A notice is display-only machine text: it must parse as an envelope and carry no images.
  if (role === "notice" && (images.length || !parseSessionNotice(text))) return undefined;
  return {
    id,
    role,
    text,
    ...(images.length ? { images } : {}),
    ...(boundedString(raw.timestamp, 64) ? { timestamp: raw.timestamp as string } : {}),
  };
}

export async function listHistoryMessages(
  machine: string,
  historyId: string,
  options: { readonly cursor?: string; readonly direction?: "latest" | "older" } = {},
  signal?: AbortSignal,
): Promise<HistoryMessagesResponse> {
  const params = new URLSearchParams({ limit: "50" });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.direction) params.set("direction", options.direction);
  const response = await req(
    `/api/history/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(historyId)}/messages?${params.toString()}`,
    { signal },
  );
  const result = resultOf(response);
  if (!result.ok) return { ...result, messages: [] };
  const data = (response.body as { data?: Record<string, unknown> } | undefined)?.data;
  const messages = Array.isArray(data?.messages)
    ? data.messages.flatMap((value) => {
      const message = normalizeHistoryMessage(value);
      return message ? [message] : [];
    })
    : [];
  return {
    ok: true,
    messages,
    ...(boundedString(data?.next_cursor, 256) ? { nextCursor: data?.next_cursor as string } : {}),
    ...(boundedString(data?.older_cursor, 256) ? { olderCursor: data?.older_cursor as string } : {}),
  };
}

export async function listMachineNames(): Promise<string[]> {
  const r = await req("/api/machines");
  const b = r.body as { data?: { machines?: Array<{ name: string }> } } | undefined;
  return (b?.data?.machines ?? []).map((m) => m.name);
}

export interface MachinePreferencesResult extends ApiResult {
  readonly machines: MachinePreference[];
}

function preferenceObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function machinePreference(value: unknown): MachinePreference | null {
  const row = preferenceObject(value);
  if (!row || typeof row.name !== "string" || !row.name || typeof row.enabled !== "boolean" || typeof row.active !== "boolean") return null;
  const change = preferenceObject(row.last_change);
  if (row.last_change !== null && (!change || typeof change.actor !== "string" || typeof change.reason !== "string"
    || typeof change.at !== "string" || !Number.isFinite(Date.parse(change.at))
    || !Number.isSafeInteger(change.revision) || (change.revision as number) < 1)) return null;
  return { name: row.name, enabled: row.enabled, active: row.active,
    last_change: change ? { actor: change.actor as string, reason: change.reason as string, at: change.at as string, revision: change.revision as number } : null };
}

export async function listMachinePreferences(): Promise<MachinePreferencesResult> {
  const response = await req("/api/machine-preferences");
  const result = resultOf(response);
  const rows = preferenceObject(preferenceObject(response.body)?.data)?.machines;
  const machines = Array.isArray(rows) ? rows.map(machinePreference) : [];
  if (!result.ok || !Array.isArray(rows) || machines.some(row => row === null)) return { ok: false, machines: [] };
  return { ok: true, machines: machines as MachinePreference[] };
}

export async function updateMachinePreference(name: string, enabled: boolean, reason: string, initializeOnly = false): Promise<ApiResult> {
  return resultOf(await req(`/api/machine-preferences/${encodeURIComponent(name)}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled, reason, ...(initializeOnly ? { initialize_only: true } : {}) }),
  }));
}

export async function glance(machine: string, id: string, tail = 12): Promise<Glance | null> {
  const r = await req(`/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/glance?tail=${tail}`);
  const data = (r.body as { data?: { glance?: Glance } } | undefined)?.data?.glance;
  if (!data) {
    return null;
  }
  const titleState = normalizeSessionTitleState(data.title_state);
  const { title_state: _titleState, title_state_supported: _titleStateSupported, ...safeData } = data;
  return {
    ...safeData,
    ...(titleState ? { title_state: titleState } : {}),
    ...(data.title_state_supported === true ? { title_state_supported: true } : {}),
  };
}

// Read the session's tmux paste buffer (what a mouse-selection-copying TUI like
// Claude Code put there). Returns "" when there is no buffer / the read failed,
// so callers can treat "nothing selected" and "unavailable" the same way.
export async function fetchSessionBuffer(machine: string, id: string): Promise<string> {
  try {
    const r = await req(`/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/buffer`);
    if (r.status < 200 || r.status >= 300) {
      return "";
    }
    const text = (r.body as { data?: { text?: string } } | undefined)?.data?.text;
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

export async function fetchRepoRemoteUrl(machine: string, cwd?: string | null): Promise<string> {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const params = new URLSearchParams();
    params.set("cwd", trimmed);
    const r = await req(`/api/machines/${encodeURIComponent(machine)}/repo-url?${params.toString()}`);
    if (r.status < 200 || r.status >= 300) {
      return "";
    }
    const url = (r.body as { data?: { url?: unknown } } | undefined)?.data?.url;
    if (typeof url !== "string") {
      return "";
    }
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

export interface ApiResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface DeleteSessionResult extends ApiResult {
  readonly cleanupPending?: boolean;
}

export interface IndeterminateApiResult extends ApiResult {
  readonly outcomeUnknown?: boolean;
}

export type AutoResumeMutationResult = IndeterminateApiResult;

export interface AccountMutationResult<P extends AccountProvider> extends IndeterminateApiResult {
  readonly account?: AccountStatusByProvider[P];
}

export interface UpdateSessionTitleResult extends ApiResult {
  readonly titleRevision?: number;
  readonly conflict?: boolean;
  readonly incarnationConflict?: boolean;
  readonly actualTitle?: string | null;
  readonly titleState?: SessionTitleState;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function resultOf(r: Json): ApiResult {
  const b = r.body as { ok?: boolean; error?: { message?: string } } | undefined;
  if (r.status >= 200 && r.status < 300 && b?.ok !== false) {
    return { ok: true };
  }
  return { ok: false, error: b?.error?.message ?? `request failed (${r.status})` };
}

export interface CreatedSessionSnapshot {
  readonly id: string;
  readonly agent: string;
  readonly machine: string;
  readonly title?: string | null;
  readonly title_state?: SessionTitleState;
  readonly title_state_supported?: boolean;
  readonly title_revision?: number;
  readonly title_mode?: "auto" | "pinned";
  readonly display_revision?: number;
  readonly session_incarnation?: string;
  readonly created_at?: string;
  readonly retitle_path?: import("@agent-console/shared/session-retitle").SessionRetitlePath;
  readonly codex_account?: AccountStatusByProvider["codex"] | null;
  readonly claude_account?: AccountStatusByProvider["claude"] | null;
}

export interface CreateSessionResult extends IndeterminateApiResult {
  readonly id?: string;
  /** History resume found the conversation already live under `id`. */
  readonly alreadyLive?: true;
  readonly session?: CreatedSessionSnapshot;
  readonly errorCode?: string;
  /** Undefined means an old daemon omitted the projection; null means a supplied projection was invalid. */
  readonly startup?: StartupStatus | null;
}

function normalizeCreatedSession(value: unknown, machine: string): CreatedSessionSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const session = value as Record<string, unknown>;
  if (
    typeof session.id !== "string" || !session.id.trim()
    || typeof session.agent !== "string" || !session.agent.trim()
    || (
      Object.hasOwn(session, "title")
      && session.title !== null
      && typeof session.title !== "string"
    )
    || (
      Object.hasOwn(session, "created_at")
      && (typeof session.created_at !== "string" || !session.created_at.trim())
    )
  ) {
    return undefined;
  }
  const displayRevision = nonNegativeInteger(session.display_revision);
  const titleMode = session.title_mode === "auto" || session.title_mode === "pinned" ? session.title_mode : undefined;
  if ((Object.hasOwn(session, "title_mode") && titleMode === undefined)
      || (Object.hasOwn(session, "display_revision") && displayRevision === undefined)) return undefined;
  const titleRevision = nonNegativeInteger(session.title_revision);
  if (Object.hasOwn(session, "title_revision") && titleRevision === undefined) {
    return undefined;
  }
  const sessionIncarnation = typeof session.session_incarnation === "string"
    && session.session_incarnation.trim()
    ? session.session_incarnation
    : undefined;
  if (Object.hasOwn(session, "session_incarnation") && sessionIncarnation === undefined) {
    return undefined;
  }
  const titleState = normalizeSessionTitleState(session.title_state);
  if (Object.hasOwn(session, "title_state") && !titleState) {
    return undefined;
  }
  if (
    Object.hasOwn(session, "title_state_supported")
    && typeof session.title_state_supported !== "boolean"
  ) {
    return undefined;
  }
  const codexAccount = normalizeAccountStatus("codex", session.codex_account);
  const claudeAccount = normalizeAccountStatus("claude", session.claude_account);
  return {
    id: session.id,
    agent: session.agent,
    ...(Object.hasOwn(session, "model") || Object.hasOwn(session, "reasoning_effort")
      ? normalizeSessionModelSettings(session)
      : {}),
    machine,
    ...(Object.hasOwn(session, "title")
      ? { title: session.title as string | null }
      : {}),
    ...(titleState ? { title_state: titleState } : {}),
    ...(session.title_state_supported === true ? { title_state_supported: true } : {}),
    ...(titleMode === undefined ? {} : {title_mode: titleMode}),
    ...(displayRevision === undefined ? {} : {display_revision: displayRevision}),
    ...(titleRevision === undefined ? {} : { title_revision: titleRevision }),
    ...(sessionIncarnation === undefined ? {} : { session_incarnation: sessionIncarnation }),
    ...(typeof session.created_at === "string" ? { created_at: session.created_at } : {}),
    ...(codexAccount ? { codex_account: codexAccount } : {}),
    ...(claudeAccount ? { claude_account: claudeAccount } : {}),
  };
}

const DETERMINATE_CREATE_FAILURE_CODES = new Set([
  // agent-session resolves provider history before it creates the session
  // record, so this failure cannot have produced a hidden session.
  "provider-resume-scan-truncated",
  "codex-account-unsupported-daemon",
  "claude-account-unsupported-daemon",
  "unknown-agent-profile",
  "agent-profile-agent-conflict",
  "agent-profile-unavailable",
  "agent-profile-metadata-unavailable",
  "agent-profile-context-mismatch",
]);

export async function createSession(
  machine: string,
  body: CreateBody,
  signal?: AbortSignal,
): Promise<CreateSessionResult> {
  const r = await postJson(`/api/sessions/${encodeURIComponent(machine)}`, body, signal);
  const result = resultOf(r);
  if (!result.ok) {
    const code = (r.body as { error?: { code?: unknown } } | undefined)?.error?.code;
    const errorCode = typeof code === "string" ? code : undefined;
    const failure = errorCode ? { ...result, errorCode } : result;
    return r.status >= 500 && !DETERMINATE_CREATE_FAILURE_CODES.has(errorCode ?? "")
      ? { ...failure, outcomeUnknown: true }
      : failure;
  }
  const rawSession = (
    r.body as { data?: { session?: Record<string, unknown> } } | undefined
  )?.data?.session;
  const id = typeof rawSession?.id === "string" ? rawSession.id : undefined;
  const session = normalizeCreatedSession(rawSession, machine);
  const startup = rawSession && Object.hasOwn(rawSession, "startup")
    ? normalizeStartupStatus(rawSession.startup)
    : undefined;
  return {
    ok: true,
    ...(id ? { id } : {}),
    ...(session ? { session } : {}),
    ...(startup === undefined ? {} : { startup }),
  };
}

export async function updateSessionTitle(
  machine: string,
  id: string,
  title: string | null,
  signal?: AbortSignal,
  expectedTitleRevision?: number,
  expectedSessionIncarnation?: string,
  expectedSessionTitle?: string | null,
  titleState?: SessionTitleState | null,
): Promise<UpdateSessionTitleResult> {
  const requestedTitleState = titleState === undefined || titleState === null
    ? titleState
    : normalizeSessionTitleState(titleState);
  if (titleState !== undefined && titleState !== null && !requestedTitleState) {
    return { ok: false, error: "structured title update is invalid" };
  }
  const response = await patchJson(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}`,
    {
      title,
      ...(requestedTitleState === undefined ? {} : { title_state: requestedTitleState }),
      ...(expectedTitleRevision === undefined
        ? {}
        : { expected_title_revision: expectedTitleRevision }),
      ...(expectedSessionIncarnation === undefined
        ? {}
        : { expected_session_incarnation: expectedSessionIncarnation }),
      ...(expectedSessionTitle === undefined
        ? {}
        : { expected_session_title: expectedSessionTitle }),
    },
    signal,
  );
  const envelope = response.body as {
    error?: {
      code?: unknown;
      message?: unknown;
      details?: {
        actual_title_revision?: unknown;
        actual_title?: unknown;
        actual_session_title?: unknown;
      };
    };
  } | undefined;
  if (
    response.status === 409
    && (envelope?.error?.code === "title-revision-conflict" || envelope?.error?.code === "title-state-conflict")
  ) {
    const titleRevision = nonNegativeInteger(envelope.error.details?.actual_title_revision);
    const actualTitleValue = envelope.error.details?.actual_title
      ?? envelope.error.details?.actual_session_title;
    const actualTitle = typeof actualTitleValue === "string" || actualTitleValue === null
      ? actualTitleValue
      : undefined;
    return {
      ok: false,
      error: typeof envelope.error.message === "string"
        ? envelope.error.message
        : "session title changed since it was read",
      conflict: true,
      ...(titleRevision === undefined ? {} : { titleRevision }),
      ...(actualTitle === undefined ? {} : { actualTitle }),
    };
  }
  if (response.status === 409 && envelope?.error?.code === "session-incarnation-conflict") {
    return {
      ok: false,
      error: typeof envelope.error.message === "string"
        ? envelope.error.message
        : "session was replaced since it was read",
      incarnationConflict: true,
    };
  }
  const result = resultOf(response);
  if (!result.ok) {
    return result;
  }
  const confirmedSession = (
    response.body as {
      data?: { session?: { title?: unknown; title_state?: unknown; title_revision?: unknown } };
    } | undefined
  )?.data?.session;
  const confirmedTitle = confirmedSession?.title;
  if (confirmedTitle !== title) {
    return { ok: false, error: "title update was not confirmed" };
  }
  const hasConfirmedTitleState = Boolean(
    confirmedSession && Object.hasOwn(confirmedSession, "title_state"),
  );
  const rawConfirmedTitleState = confirmedSession?.title_state;
  const confirmedTitleState = normalizeSessionTitleState(rawConfirmedTitleState);
  if (
    requestedTitleState !== undefined
    && (
      requestedTitleState === null
        ? hasConfirmedTitleState && rawConfirmedTitleState !== null
        : !confirmedTitleState || !sessionTitleStatesEqual(confirmedTitleState, requestedTitleState)
    )
  ) {
    return { ok: false, error: "structured title update was not confirmed" };
  }
  const titleRevision = nonNegativeInteger(confirmedSession?.title_revision);
  if (expectedTitleRevision !== undefined && (titleRevision === undefined || titleRevision <= expectedTitleRevision)) {
    return { ok: false, error: "title update revision was not confirmed" };
  }
  return {
    ok: true,
    ...(titleRevision === undefined ? {} : { titleRevision }),
    ...(confirmedTitleState ? { titleState: confirmedTitleState } : {}),
  };
}

export type TitleSummaryResult = ApiResult & Partial<SharedTitleSummaryResult>;

function titleSummarySource(value: unknown): SharedTitleSummaryResult["source"] | undefined {
  return value === "summarizer" || value === "fallback" ? value : undefined;
}

function titleSummaryDiagnosticReason(
  value: unknown,
): SharedTitleSummaryResult["diagnosticReason"] | undefined {
  return typeof value === "string"
    && TITLE_SUMMARY_DIAGNOSTIC_REASONS.includes(
      value as (typeof TITLE_SUMMARY_DIAGNOSTIC_REASONS)[number],
    )
    ? value as (typeof TITLE_SUMMARY_DIAGNOSTIC_REASONS)[number]
    : undefined;
}

export async function summarizeSessionTitle(body: TitleSummaryRequest): Promise<TitleSummaryResult> {
  const r = await postJson("/api/title-summary", body);
  const result = resultOf(r);
  if (!result.ok) {
    return result;
  }
  const data = (
    r.body as {
      data?: { title?: unknown; titleState?: unknown; source?: unknown; diagnosticReason?: unknown };
    } | undefined
  )?.data;
  const title = typeof data?.title === "string" || data?.title === null ? data.title : undefined;
  const titleState = normalizeSessionTitleState(data?.titleState);
  const diagnosticReason = titleSummaryDiagnosticReason(data?.diagnosticReason);
  return {
    ok: true,
    title,
    ...(titleState ? { titleState } : {}),
    source: titleSummarySource(data?.source),
    ...(diagnosticReason ? { diagnosticReason } : {}),
  };
}

export interface SessionRetitleReadinessResult extends ApiResult {
  readonly readiness?: SessionRetitleReadiness;
}

export interface SessionRetitleApiResult extends ApiResult {
  readonly retitle?: SessionRetitleResult;
  readonly errorCode?: SessionRetitleErrorCode;
  readonly retryable?: boolean;
  readonly nextAction?: import("@agent-console/shared/session-retitle").SessionRetitleErrorAction;
}

export async function fetchSessionRetitleReadiness(machine: string): Promise<SessionRetitleReadinessResult> {
  const response = await req(`/api/machines/${encodeURIComponent(machine)}/retitle/readiness`);
  const result = resultOf(response);
  if (!result.ok) return result;
  const data = (response.body as { data?: { machine?: unknown; retitle?: unknown } } | undefined)?.data;
  const readiness = normalizeSessionRetitleReadiness(data?.retitle);
  if (data?.machine !== machine || !readiness) {
    return { ok: false, error: "invalid retitle readiness response" };
  }
  return { ok: true, readiness };
}

export async function requestSessionRetitle(
  machine: string,
  id: string,
  request: SessionRetitleRequest,
): Promise<SessionRetitleApiResult> {
  const normalizedRequest = normalizeSessionRetitleRequest(request);
  if (!normalizedRequest) return { ok: false, error: "invalid retitle request" };
  const response = await postJson(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/retitle`,
    normalizedRequest,
  );
  const body = response.body as {
    data?: { machine?: unknown; retitle?: unknown };
    error?: {
      code?: unknown;
      message?: unknown;
      details?: { retryable?: unknown; next_action?: unknown };
    };
  } | undefined;
  const result = resultOf(response);
  if (!result.ok) {
    const normalizedError = normalizeSessionRetitleError(body?.error);
    return {
      ...result,
      ...(normalizedError ? { errorCode: normalizedError.code } : {}),
      ...(normalizedError?.retryable === undefined ? {} : { retryable: normalizedError.retryable }),
      ...(normalizedError?.next_action ? { nextAction: normalizedError.next_action } : {}),
    };
  }
  const retitle = normalizeSessionRetitleResult(body?.data?.retitle);
  if (body?.data?.machine !== machine || !retitle) {
    return { ok: false, error: "invalid retitle response" };
  }
  if (
    retitle.trigger !== normalizedRequest.trigger
    || retitle.session.session_incarnation !== normalizedRequest.expected_session_incarnation
    || retitle.session.title_revision < normalizedRequest.expected_title_revision
  ) {
    return { ok: false, error: "stale retitle response" };
  }
  return { ok: true, retitle };
}

export interface SessionRetitleV3ReadinessResult extends ApiResult {
  readonly readiness?: SessionRetitleV3Readiness;
}

export interface SessionRetitleV3ApiResult extends ApiResult {
  readonly retitle?: SessionRetitleV3Result;
  readonly errorCode?: SessionRetitleErrorCode | "retitle-outcome-unknown";
  readonly retryable?: boolean;
}

function retitleV3ApiResult(
  response: Json,
  machine: string,
  expectedOperationHash?: string,
): SessionRetitleV3ApiResult {
  const body = response.body as {
    data?: { machine?: unknown; retitle?: unknown };
    error?: unknown;
  } | undefined;
  const result = resultOf(response);
  if (!result.ok) {
    const normalizedError = normalizeSessionRetitleError(body?.error);
    const rawCode = (body?.error as { code?: unknown } | undefined)?.code;
    return {
      ...result,
      ...(normalizedError ? { errorCode: normalizedError.code } : {}),
      ...(!normalizedError && rawCode === "retitle-outcome-unknown" ? { errorCode: rawCode } : {}),
      ...(normalizedError?.retryable === undefined ? {} : { retryable: normalizedError.retryable }),
    };
  }
  const retitle = normalizeSessionRetitleV3Result(body?.data?.retitle);
  if (
    body?.data?.machine !== machine
    || !retitle
    || expectedOperationHash !== undefined && retitle.operation_hash !== expectedOperationHash
  ) return { ok: false, error: "invalid retitle v3 response" };
  return { ok: true, retitle };
}

export async function fetchSessionRetitleV3Readiness(
  machine: string,
  id: string,
): Promise<SessionRetitleV3ReadinessResult> {
  const response = await req(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/retitle-v3/readiness`,
  );
  const result = resultOf(response);
  if (!result.ok) return result;
  const data = (response.body as { data?: { machine?: unknown; retitle?: unknown } } | undefined)?.data;
  const readiness = normalizeSessionRetitleV3Readiness(data?.retitle);
  if (data?.machine !== machine || !readiness) return { ok: false, error: "invalid retitle v3 readiness response" };
  return { ok: true, readiness };
}

export async function requestSessionRetitleV3(
  machine: string,
  id: string,
  request: SessionRetitleV3Request,
): Promise<SessionRetitleV3ApiResult> {
  const normalized = normalizeSessionRetitleV3Request(request);
  if (!normalized) return { ok: false, error: "invalid retitle v3 request" };
  const response = await postJson(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/retitle-v3`,
    normalized,
  );
  const result = retitleV3ApiResult(response, machine);
  if (!result.ok || !result.retitle) return result;
  const fence = result.retitle.admission_fence;
  if (
    fence.session_incarnation !== normalized.expected.session_incarnation
    || fence.title_revision !== normalized.expected.title_revision
    || fence.memory_revision !== normalized.expected.memory_revision
  ) return { ok: false, error: "stale retitle v3 response" };
  return result;
}

export async function fetchSessionRetitleV3Operation(
  machine: string,
  id: string,
  operationHash: string,
): Promise<SessionRetitleV3ApiResult> {
  if (!/^sha256:[a-f0-9]{64}$/.test(operationHash)) {
    return { ok: false, error: "invalid retitle v3 operation" };
  }
  const response = await req(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/retitle-v3/operations/${encodeURIComponent(operationHash)}`,
  );
  return retitleV3ApiResult(response, machine, operationHash);
}

export async function resumeSession(machine: string, id: string): Promise<ApiResult> {
  return resultOf(await postJson(`/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/resume`, {}));
}

export interface MaintenancePreviewResult extends ApiResult {
  readonly maintenance?: SessionMaintenancePreview;
  readonly maintenanceError?: SessionMaintenanceError;
  readonly unsupported?: boolean;
}

export interface MaintenanceActionApiResult extends ApiResult {
  readonly result?: SessionMaintenanceActionResult;
  readonly maintenance?: SessionMaintenancePreview;
  readonly maintenanceError?: SessionMaintenanceError;
  readonly outcomeUnknown?: boolean;
}

export async function inspectSessionMaintenance(
  machine: string,
  id: string,
  operation: MaintenanceOperation,
  signal?: AbortSignal,
): Promise<MaintenancePreviewResult> {
  const response = await req(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/maintenance`
      + `?operation=${operation}`
      // Ask for the successor contract. The edge degrades to v1 for an older
      // daemon and echoes what it got, so the drawer renders only what the
      // producer actually advertised.
      + `&schema_version=${encodeURIComponent(MAINTENANCE_SCHEMA_VERSION_V2)}`,
    { signal },
  );
  const envelope = response.body as {
    data?: { maintenance?: unknown };
    error?: unknown;
  } | undefined;
  if (response.status >= 200 && response.status < 300) {
    const maintenance = normalizeSessionMaintenancePreview(envelope?.data?.maintenance, {
      sessionId: id,
      operation,
    });
    return maintenance
      ? { ok: true, maintenance }
      : { ok: false, error: "invalid session maintenance response" };
  }
  const maintenanceError = normalizeSessionMaintenanceError(envelope?.error, {
    sessionId: id,
    operation,
  });
  return {
    ok: false,
    error: maintenanceError?.message ?? "session maintenance is unavailable",
    ...(maintenanceError ? { maintenanceError } : {}),
    ...(maintenanceError?.code === "maintenance-unsupported" ? { unsupported: true } : {}),
  };
}

export async function executeSessionMaintenanceAction(
  machine: string,
  id: string,
  request: SessionMaintenanceActionRequest,
): Promise<MaintenanceActionApiResult> {
  const response = await postJson(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/maintenance/actions`,
    request,
  );
  const envelope = response.body as {
    data?: { maintenance_result?: unknown; maintenance?: unknown };
    error?: unknown;
  } | undefined;
  if (response.status >= 200 && response.status < 300) {
    const result = normalizeSessionMaintenanceActionResult(envelope?.data?.maintenance_result, {
      sessionId: id,
      operation: request.operation,
      action: request.action,
      // The answer must come back on the contract this action was sent on.
      schemaVersion: request.schema_version ?? MAINTENANCE_SCHEMA_VERSION,
    });
    return result ? { ok: true, result } : { ok: false, error: "invalid maintenance result" };
  }
  const maintenanceError = normalizeSessionMaintenanceError(envelope?.error, {
    sessionId: id,
    operation: request.operation,
  });
  const maintenance = normalizeSessionMaintenancePreview(envelope?.data?.maintenance, {
    sessionId: id,
    operation: request.operation,
  });
  return {
    ok: false,
    error: maintenanceError?.message ?? "session maintenance failed",
    ...(maintenanceError ? { maintenanceError } : {}),
    ...(maintenance ? { maintenance } : {}),
    ...(maintenanceError?.code === "maintenance-outcome-unknown" || response.status >= 500
      ? { outcomeUnknown: true }
      : {}),
  };
}

export async function setSessionAutoResume(
  machine: string,
  id: string,
  enabled: boolean,
  signal?: AbortSignal,
  recoveryPolicy?: "wait_for_reset" | "next_account_then_resume",
): Promise<AutoResumeMutationResult> {
  const response = await req(`/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/auto-resume`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled,
      ...(recoveryPolicy ? { recovery_policy: recoveryPolicy } : {}),
    }),
    signal,
  });
  const result = resultOf(response);
  if (result.ok) {
    return result;
  }
  const code = (response.body as { error?: { code?: unknown } } | undefined)?.error?.code;
  // Previous edge versions surfaced daemon transport failures as a generic
  // 500. Treat every server failure conservatively so mixed-version clients
  // never submit Enter while the mutation may still complete upstream.
  const outcomeUnknown = code === "auto-resume-outcome-unknown" || response.status >= 500;
  return outcomeUnknown ? { ...result, outcomeUnknown: true } : result;
}

export async function cancelSessionAutoResume(machine: string, id: string): Promise<ApiResult> {
  return resultOf(await req(`/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/auto-resume`, {
    method: "DELETE",
  }));
}

export async function listAccounts(
  provider: AccountProvider,
  machine: string,
  signal?: AbortSignal,
): Promise<AccountInventory> {
  const response = await req(`/api/machines/${encodeURIComponent(machine)}/${provider}/accounts`, { signal });
  if (response.status < 200 || response.status >= 300) {
    const result = resultOf(response);
    throw new Error(result.error ?? `request failed (${response.status})`);
  }
  const data = (response.body as {
    data?: { accounts?: unknown; readiness?: unknown; selection_strategies?: unknown };
  } | undefined)?.data;
  const rawReadiness = provider === "codex" ? data?.readiness : undefined;
  const readiness = rawReadiness === undefined ? undefined : normalizeCodexAccountReadiness(rawReadiness);
  if (rawReadiness !== undefined && !readiness) {
    return {
      accounts: [],
      readiness: {
        schema_version: CODEX_ACCOUNT_READINESS_SCHEMA_VERSION,
        supported: false,
        reason_code: "unknown",
      },
    };
  }
  return {
    accounts: normalizeAccountSummaries(data?.accounts),
    ...(readiness ? { readiness } : {}),
    ...(data?.selection_strategies === undefined
      ? {}
      : { selection_strategies: normalizeSelectionStrategies(data.selection_strategies) }),
  };
}

/**
 * Switches a running session's account. A Codex session switches live or
 * between turns; Claude Code has no live credential swap, so the daemon queues
 * the account and, when the session is idle, restarts it and resumes the
 * conversation on it.
 */
export async function switchSessionAccount<P extends AccountProvider>(
  provider: P,
  machine: string,
  id: string,
  account: string,
  expectedSessionIncarnation: string,
): Promise<AccountMutationResult<P>> {
  const label = ACCOUNT_PROVIDER_LABELS[provider];
  let response: Json;
  try {
    response = await req(
      `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/account`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account, expected_session_incarnation: expectedSessionIncarnation }),
        signal: AbortSignal.timeout(ACCOUNT_SWITCH_REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    return { ok: false, error: `${label} account switch outcome is unknown`, outcomeUnknown: true };
  }
  const result = resultOf(response);
  if (!result.ok) {
    const code = (response.body as { error?: { code?: unknown } } | undefined)?.error?.code;
    return code === "account-switch-outcome-unknown" || response.status >= 500
      ? { ...result, outcomeUnknown: true }
      : result;
  }
  const data = (response.body as { data?: Record<string, unknown> } | undefined)?.data;
  const status = normalizeAccountStatus(provider, data?.[`${provider}_account`]);
  // An edge that predates the echo checked the Codex unbound-queue fence itself
  // and answered without `session_incarnation`.
  const responseSessionIncarnation = provider === "codex" && data?.session_incarnation === undefined
    ? expectedSessionIncarnation
    : data?.session_incarnation;
  return status
    && confirmsAccountSwitch(provider, status, account, expectedSessionIncarnation, responseSessionIncarnation)
    ? { ok: true, account: status }
    : { ok: false, error: `${label} account switch was not confirmed` };
}

export interface SendSessionInputBody {
  readonly text?: string;
  readonly keys?: readonly SpecialKey[];
}

export type SendSessionInputResult = IndeterminateApiResult;

export async function sendSessionInput(
  machine: string,
  id: string,
  body: SendSessionInputBody,
  signal?: AbortSignal,
): Promise<SendSessionInputResult> {
  const response = await postJson(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/send`,
    // This route only ever carries keystrokes a person just typed: the attach
    // transport falls back to it when the socket is not open, and TerminalPane
    // sends through it before a transport exists. The daemon refuses literal
    // text while a session is `needs_input` so automation cannot type into an
    // approval dialog by accident, but a human answering that dialog is the
    // deliberate case it is meant to leave alone — so declare the intent rather
    // than let a reconnecting socket turn typing into `agent-blocked`.
    { ...body, allow_blocked: true },
    signal,
  );
  const result = resultOf(response);
  return !result.ok && response.status >= 500 ? { ...result, outcomeUnknown: true } : result;
}

export type SubmitSessionPromptBody = {readonly text: string} & (
  | {readonly expected_session_incarnation?: undefined; readonly request_id?: never; readonly require_idle?: never}
  | {readonly expected_session_incarnation: string; readonly request_id?: string; readonly require_idle?: boolean}
);

export interface SubmitSessionPromptResult extends IndeterminateApiResult {
  readonly receipt?: PromptReceipt;
  /** This key belongs to another payload; never look up its receipt for this text. */
  readonly refusalCode?: "request-id-conflict" | "keyed-prompt-unsupported";
  /** Delivered behind the session's running turn; it runs when that turn ends. */
  readonly queued?: boolean;
}

/** Submit provider input without passing multiline text through terminal keys. */
async function submitSessionPromptRequest(
  machine: string,
  id: string,
  body: SubmitSessionPromptBody,
  signal?: AbortSignal,
): Promise<SubmitSessionPromptResult> {
  const expectedSessionIncarnation = body.expected_session_incarnation;
  if ((body.request_id !== undefined || body.require_idle !== undefined) && !expectedSessionIncarnation) {
    return {ok:false,error:"Keyed or idle-guarded prompts require a session incarnation."};
  }
  const routeSuffix = expectedSessionIncarnation === undefined ? "" : "/v2";
  const response = await postJson(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/prompt${routeSuffix}`,
    body,
    signal,
  );
  const result = resultOf(response);
  if (body.request_id !== undefined) {
    const envelope = response.body as {data?: {submitted?: unknown; command_dispatched?: unknown; session_incarnation?: unknown; queued?: unknown; receipt?: unknown}; error?: {code?: unknown; details?: {receipt?: unknown}}} | undefined;
    const receipt = normalizePromptReceipt(envelope?.data?.receipt ?? envelope?.error?.details?.receipt, {
      request_id: body.request_id, session_id: id, session_incarnation: expectedSessionIncarnation ?? "",
    });
    if (response.status === 409 && envelope?.error?.code === "request-id-conflict") return {ok:false,refusalCode:"request-id-conflict",error:"This request identifier belongs to another prompt. Retry this reply with a new identifier."};
    // An agent-session runtime without keyed prompts rejected the request before dispatch.
    if (response.status === 400 && envelope?.error?.code === "keyed-prompt-unsupported") return {ok:false,refusalCode:"keyed-prompt-unsupported",error:"This host's agent-session runtime does not support queued replies. The reply was not sent; send it when the session is idle."};
    if (!receipt) return {ok:false, outcomeUnknown:true, error:"Queued reply delivery was not confirmed. Check its receipt before retrying."};
    if (receipt.outcome === "submitted" && response.status >= 200 && response.status < 300 && result.ok
      && envelope?.data?.submitted === true && envelope.data.session_incarnation === expectedSessionIncarnation) {
      return {ok:true, receipt, ...(envelope.data.queued === true ? {queued:true} : {})};
    }
    if (receipt.outcome === "command_dispatched" && response.status >= 200 && response.status < 300 && result.ok
      && envelope?.data?.command_dispatched === true && envelope.data.submitted === false && envelope.data.session_incarnation === expectedSessionIncarnation) {
      return {ok:true, receipt};
    }
    if (receipt.outcome === "refused" && !result.ok) return {ok:false, receipt, error:receipt.code === "busy" ? "The session is busy. This reply remains queued." : `The queued reply was refused (${receipt.code}).`};
    return {ok:false, outcomeUnknown:true, ...(receipt.outcome === "unknown" ? {receipt} : {}), error:"Queued reply delivery is unknown. Check its receipt before retrying."};
  }
  if (response.status < 200 || response.status >= 300) {
    return response.status >= 500 && response.status !== 501
      ? { ...result, outcomeUnknown: true }
      : result;
  }
  if (!result.ok && !response.malformed) {
    return result;
  }
  const data = (
    response.body as {
      data?: { submitted?: unknown; queued?: unknown; session_incarnation?: unknown };
    } | undefined
  )?.data;
  const acknowledged = data?.submitted === true
    && (
      expectedSessionIncarnation === undefined
      || data.session_incarnation === expectedSessionIncarnation
    );
  return result.ok && acknowledged
    ? (data.queued === true ? { ...result, queued: true } : result)
    : {
        ok: false,
        error: "provider prompt submission was not acknowledged",
        outcomeUnknown: true,
      };
}

export async function submitSessionPrompt(
  machine: string, id: string, body: SubmitSessionPromptBody, signal?: AbortSignal,
): Promise<SubmitSessionPromptResult> {
  try {
    const result = await submitSessionPromptRequest(machine, id, body, signal);
    notePromptDelivery(machine, id, body.expected_session_incarnation, result);
    return result;
  } catch (error) {
    notePromptDelivery(machine, id, body.expected_session_incarnation, {ok: false, outcomeUnknown: true});
    throw error;
  }
}

export async function lookupSessionPromptReceipt(machine: string, id: string, requestId: string, incarnation: string): Promise<ApiResult & {readonly receipt?: PromptReceipt; readonly notFound?: boolean}> {
  try {
    const response = await req(`/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/prompt/v2/receipts/${encodeURIComponent(requestId)}?expected_session_incarnation=${encodeURIComponent(incarnation)}`);
    const body = response.body as {data?: {receipt?: unknown}; error?: {code?: unknown}} | undefined;
    const receipt = normalizePromptReceipt(body?.data?.receipt, {request_id:requestId,session_id:id,session_incarnation:incarnation});
    if (response.status >= 200 && response.status < 300 && resultOf(response).ok && receipt) return {ok:true,receipt};
    return {ok:false, ...(response.status === 404 && body?.error?.code === "prompt-receipt-not-found" ? {notFound:true} : {}), error:"Could not confirm queued reply delivery. The item has been kept; do not resend it."};
  } catch { return {ok:false,error:"Could not check queued reply delivery. The item has been kept."}; }
}

async function queuedReplyRemovalError(machine: string, id: string): Promise<string | undefined> {
  try {
    const {conversationOutbox} = await import("./conversationOutbox.ts");
    if (await conversationOutbox().verifyQueuedReplies(machine,id)) {
      return "Deliver, cancel, or resolve queued replies before removing this session.";
    }
  } catch {
    return "Queued reply state could not be verified. Restore browser storage before removing this session.";
  }
}

export async function killSession(machine: string, id: string): Promise<DeleteSessionResult> {
  const queuedReplyError = await queuedReplyRemovalError(machine,id);
  if (queuedReplyError) return {ok:false,error:queuedReplyError};
  const response = await req(`/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}`, { method: "DELETE" });
  const base = resultOf(response);
  if (!base.ok) return base;
  const body = response.body as { data?: { deleted?: unknown } } | undefined;
  const deleted = normalizePublicSessionDeleteResult(body?.data?.deleted, id);
  if (!deleted) return { ok: false, error: "invalid session delete acknowledgement" };
  return { ok: true, cleanupPending: deleted.cleanup_pending };
}

export async function archiveSession(
  machine: string,
  id: string,
  expectedSessionIncarnation: string,
  options: { readonly starred?: boolean } = {},
): Promise<ArchiveSessionResult> {
  const queuedReplyError = await queuedReplyRemovalError(machine,id);
  if (queuedReplyError) return {ok:false,error:queuedReplyError};
  const response = await postJson(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/archive`,
    {
      expected_session_incarnation: expectedSessionIncarnation,
      ...(options.starred ? { starred: true } : {}),
    },
  );
  const base = resultOf(response);
  if (!base.ok) {
    const code = (response.body as { error?: { code?: unknown } } | undefined)?.error?.code;
    return typeof code === "string" ? { ...base, errorCode: code } : base;
  }
  const data = (response.body as { data?: { archived?: unknown; deleted?: unknown } } | undefined)?.data;
  const archived = normalizeHistorySession(data?.archived, machine);
  const deleted = normalizePublicSessionDeleteResult(data?.deleted, id);
  if (!archived || !deleted) return { ok: false, error: "invalid session archive acknowledgement" };
  return { ok: true, ...(archived.starred_at ? { starredAt: archived.starred_at } : {}) };
}

export interface WorkdirSuggestion {
  readonly path: string;
  readonly name?: string;
  readonly root?: string;
  readonly is_git_repo?: boolean;
  readonly last_used?: string | null;
}

export async function searchWorkdirs(machine: string, q: string, limit = 20): Promise<WorkdirSuggestion[]> {
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("limit", String(limit));
  params.set("git_only", "true");
  params.set("exclude_worktrees", "true");
  const r = await req(`/api/machines/${encodeURIComponent(machine)}/workdirs?${params.toString()}`);
  const b = r.body as { data?: { workdirs?: WorkdirSuggestion[] } } | undefined;
  return b?.data?.workdirs ?? [];
}

export interface UploadAttachmentResult extends ApiResult {
  readonly path?: string;
  readonly bytes?: number;
}

export async function uploadAttachment(machine: string, id: string, file: File): Promise<UploadAttachmentResult> {
  const filename = file.name.trim() || fallbackAttachmentName(file.type);
  const r = await req(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/attachments?filename=${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    },
  );
  const result = resultOf(r);
  if (!result.ok) {
    return result;
  }
  const attachment = (r.body as { data?: { attachment?: { path?: string; bytes?: number } } } | undefined)?.data
    ?.attachment;
  return { ok: true, path: attachment?.path, bytes: attachment?.bytes };
}

function fallbackAttachmentName(contentType: string): string {
  if (contentType === "image/png") return "pasted.png";
  if (contentType === "image/jpeg") return "pasted.jpg";
  if (contentType === "image/webp") return "pasted.webp";
  return "attachment.bin";
}

export async function usage(tick?: AsyncPollTick): Promise<UsageResult> {
  const path = tick?.fresh ? "/api/usage?refresh=1" : "/api/usage";
  const r = await readReachableWithRecovery((signal) => req(path, { signal }), { signal: tick?.signal });
  const b = r.body as { data?: Partial<UsageResult> } | undefined;
  return {
    // An app build can meet an edge that predates `switch_key`; derive it with
    // the edge's own rule so aliases and switching still work there.
    providers: (b?.data?.providers ?? []).map((provider) => {
      if (provider.switch_key !== undefined) return provider;
      const key = usageSwitchKey(provider);
      return key ? { ...provider, switch_key: key } : provider;
    }),
    reachable: b?.data?.reachable ?? false,
    error: b?.data?.error,
  };
}

export async function resetCodexRateLimit(
  account: string,
  idempotencyKey: string,
): Promise<CodexRateLimitResetMutationResult> {
  const r = await postJson("/api/codex/rate-limit-reset", {
    account,
    idempotency_key: idempotencyKey,
  });
  const result = resultOf(r);
  const data = (r.body as {
    data?: { outcome?: unknown; windows_reset?: unknown };
  } | undefined)?.data;
  const outcome = typeof data?.outcome === "string" && [
    "reset",
    "nothing_to_reset",
    "no_credit",
    "already_redeemed",
  ].includes(data.outcome)
    ? data.outcome as CodexRateLimitResetOutcome
    : undefined;
  const windowsReset = nonNegativeInteger(data?.windows_reset);
  if (result.ok && !outcome) {
    return { ok: false, error: "bad response" };
  }
  return {
    ...result,
    ...(outcome ? { outcome } : {}),
    ...(windowsReset === undefined ? {} : { windowsReset }),
  };
}

const CLAUDE_RESET_OUTCOMES: ReadonlySet<string> = new Set<string>(CLAUDE_LIMIT_RESET_OUTCOMES);

// Redeem one Claude limit reset for a token-authority profile. The caller owns
// the idempotency key so a retry after a transport failure replays, not repeats.
export async function resetClaudeLimit(
  account: string,
  program: ClaudeLimitResetProgram,
  idempotencyKey: string,
): Promise<ClaudeLimitResetMutationResult> {
  const r = await postJson("/api/claude/limit-reset", {
    account,
    program,
    idempotency_key: idempotencyKey,
  });
  const result = resultOf(r);
  const data = (r.body as {
    data?: { outcome?: unknown; reason?: unknown; resets_left?: unknown; next_available_at?: unknown; cooldown_until?: unknown };
  } | undefined)?.data;
  const outcome = typeof data?.outcome === "string" && CLAUDE_RESET_OUTCOMES.has(data.outcome)
    ? data.outcome as ClaudeLimitResetOutcome
    : undefined;
  if (result.ok && !outcome) {
    return { ok: false, error: "bad response" };
  }
  const resetsLeft = nonNegativeInteger(data?.resets_left);
  const nextAvailableAt = nonNegativeInteger(data?.next_available_at);
  const cooldownUntil = nonNegativeInteger(data?.cooldown_until);
  return {
    ...result,
    ...(outcome ? { outcome } : {}),
    ...(typeof data?.reason === "string" ? { reason: data.reason } : {}),
    ...(resetsLeft === undefined ? {} : { resetsLeft }),
    ...(nextAvailableAt === undefined ? {} : { nextAvailableAt }),
    ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
  };
}

export async function fetchEdgeDebugEvents(): Promise<DebugEventsResult> {
  const r = await req("/api/debug/events");
  const b = r.body as { data?: Partial<DebugEventsResult> } | undefined;
  return {
    events: b?.data?.events ?? [],
    generated_at: b?.data?.generated_at ?? new Date().toISOString(),
    max_events: b?.data?.max_events ?? 0,
    ...(typeof b?.data?.max_signal_events === "number"
      ? { max_signal_events: b.data.max_signal_events }
      : {}),
  };
}

export interface SessionRetitleReceiptsResult {
  readonly supported: boolean;
  readonly receipts: SessionRetitleV3Receipts | null;
}

/** Reads the daemon's own retitle receipts for one session. A host whose
 * runtime predates the daemon route reports `supported: false` rather than an
 * error, so a mixed-version deployment stays legible. */
export async function fetchSessionRetitleReceipts(
  machine: string,
  sessionId: string,
): Promise<SessionRetitleReceiptsResult> {
  const r = await req(
    `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(sessionId)}/retitle-v3/operations`,
  );
  const b = r.body as {
    ok?: boolean;
    data?: { supported?: unknown; retitle?: unknown };
    error?: { message?: string };
  } | undefined;
  if (r.status < 200 || r.status >= 300 || b?.ok === false) {
    throw new Error(b?.error?.message ?? `retitle receipts failed (${r.status})`);
  }
  if (b?.data?.supported === false) return { supported: false, receipts: null };
  const receipts = normalizeSessionRetitleV3Receipts(b?.data?.retitle);
  if (!receipts) throw new Error("retitle receipts response was invalid");
  return { supported: true, receipts };
}

const DEBUG_DIAGNOSTIC_PROBES = [
  { name: "edge health", route: "/healthz" },
  { name: "auth status", route: "/api/auth/status" },
  { name: "machines", route: "/api/machines" },
  { name: "sessions", route: "/api/sessions" },
  { name: "usage", route: "/api/usage" },
  { name: "layout", route: "/api/layout" },
  { name: "debug events", route: "/api/debug/events" },
] as const;

export async function runDebugDiagnostics(extraProbes: readonly { readonly name: string; readonly route: string }[] = []): Promise<DebugDiagnosticResult> {
  const probes: DebugDiagnosticProbe[] = [];
  for (const probe of [...DEBUG_DIAGNOSTIC_PROBES, ...extraProbes]) {
    probes.push(await runDebugDiagnosticProbe(probe.name, probe.route));
  }
  // A healthy session list does not prove that a daemon can launch a new
  // session: an upgraded helper can leave its still-running executable stale.
  let machines: string[] = [];
  try {
    machines = await listMachineNames();
  } catch {
    // The machines probe above already records this failure. Keep the rest of
    // the diagnostic result available if the second read also fails.
  }
  for (const machine of machines) {
    probes.push(await runRuntimeHealthProbe(machine));
  }
  return {
    generated_at: new Date().toISOString(),
    ok: probes.every((probe) => probe.ok),
    probes,
  };
}

async function runRuntimeHealthProbe(machine: string): Promise<DebugDiagnosticProbe> {
  const route = `/api/machines/${encodeURIComponent(machine)}/runtime/health`;
  const requestId = createDebugRequestId();
  const started = performance.now();
  let status: number | null = null;
  let version: string | undefined;
  let error: string | null = null;
  try {
    const response = await appFetch(route, { headers: { "x-agent-console-request-id": requestId } });
    status = response.status;
    const body = await response.json() as {
      ok?: boolean;
      data?: { runtime?: { state?: string; binary_version?: string; executable_state?: string; reasons?: string[] } };
    };
    const runtime = body.data?.runtime;
    if (response.ok && body.ok === true && runtime
      && typeof runtime.binary_version === "string"
      && typeof runtime.executable_state === "string"
      && Array.isArray(runtime.reasons)) {
      version = runtime.binary_version;
      if (runtime.state !== "available" || runtime.executable_state === "replaced" || runtime.reasons.length > 0) {
        error = runtime.reasons.join(", ") || (runtime.executable_state === "replaced"
          ? "runtime-executable-replaced"
          : `runtime ${runtime.state ?? "unknown"}`);
      }
    } else {
      error = "machine runtime health unavailable";
    }
  } catch {
    error = "machine runtime health unavailable";
  }
  const duration = Math.max(0, Math.round(performance.now() - started));
  recordDebugEvent({ source: "client", request_id: requestId, method: "GET", route, status,
    ok: error === null, duration_ms: duration, error });
  return { name: `${machine} runtime`, route, request_id: requestId, status, ok: error === null,
    duration_ms: duration, error, ...(version ? { version } : {}) };
}

async function runDebugDiagnosticProbe(name: string, route: string): Promise<DebugDiagnosticProbe> {
  const requestId = createDebugRequestId();
  const headers = new Headers();
  headers.set("x-agent-console-request-id", requestId);
  const started = performance.now();
  try {
    const res = await appFetch(route, { headers });
    const text = await res.text();
    const envelope = parseEnvelope(text);
    const requestOk = res.status >= 200 && res.status < 400 && envelope.ok !== false;
    const ok = requestOk && envelope.reachable !== false;
    const error = ok
      ? null
      : envelope.error ?? (envelope.reachable === false ? "reported unreachable" : `request failed (${res.status})`);
    const duration = performance.now() - started;
    recordDebugEvent({
      source: "client",
      request_id: requestId,
      method: "GET",
      route,
      status: res.status,
      ok,
      duration_ms: duration,
      error,
    });
    return {
      name,
      route,
      request_id: requestId,
      status: res.status,
      ok,
      duration_ms: Math.max(0, Math.round(duration)),
      error,
    };
  } catch (err) {
    const duration = performance.now() - started;
    const error = (err as Error).message;
    recordDebugEvent({
      source: "client",
      request_id: requestId,
      method: "GET",
      route,
      status: null,
      ok: false,
      duration_ms: duration,
      error,
    });
    return {
      name,
      route,
      request_id: requestId,
      status: null,
      ok: false,
      duration_ms: Math.max(0, Math.round(duration)),
      error,
    };
  }
}

function parseEnvelope(text: string): { ok?: boolean; reachable?: boolean; error?: string } {
  if (text.trim() === "") return {};
  try {
    const body = JSON.parse(text) as {
      ok?: boolean;
      data?: { reachable?: boolean; error?: string };
      error?: { message?: string } | string;
    };
    const error = typeof body.error === "string" ? body.error : body.error?.message ?? body.data?.error;
    return { ok: body.ok, reachable: body.data?.reachable, error };
  } catch {
    return { ok: false, error: "bad response" };
  }
}

// The cross-device session-pane order: one relative ranking of `machine/id`
// keys, stored per principal by a multi-user edge or proxied by a single-user
// edge to an optional host layout store. `reachable` is false when that host
// store is unset or down — the UI then keeps its per-device localStorage
// arrangement (see layoutOrder.ts / Dashboard).
export interface LayoutOrderResult extends LayoutDocument {
  readonly reachable: boolean;
  readonly conflict?: boolean;
  readonly error?: string;
}

export interface PutLayoutOrderOptions {
  readonly baseRevision?: number | null;
  readonly reason?: string;
  readonly keepalive?: boolean;
}

export async function fetchLayoutOrder(): Promise<LayoutOrderResult> {
  const r = await req("/api/layout");
  const b = r.body as { data?: { order?: unknown; revision?: unknown; reachable?: boolean; error?: string } } | undefined;
  const order = normalizeLayoutOrder(b?.data?.order);
  return { order, revision: layoutRevision(b?.data?.revision), reachable: b?.data?.reachable ?? false, error: b?.data?.error };
}

export async function putLayoutOrder(
  order: readonly string[],
  options: PutLayoutOrderOptions = {},
): Promise<LayoutOrderResult> {
  const normalizedOrder = normalizeLayoutOrder(order);
  if (order.length > 0 && normalizedOrder.length === 0) {
    return {
      order: [],
      revision: null,
      reachable: false,
      conflict: false,
      error: "layout order has no valid session keys",
    };
  }
  const body: { order: readonly string[]; base_revision?: number; reason?: string } = { order: normalizedOrder };
  if (options.baseRevision !== null && options.baseRevision !== undefined) {
    body.base_revision = options.baseRevision;
  }
  if (options.reason) {
    body.reason = options.reason;
  }
  const r = await req("/api/layout", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: options.keepalive === true,
  });
  const b = r.body as
    | { data?: { order?: unknown; revision?: unknown; reachable?: boolean; conflict?: boolean; error?: string } }
    | undefined;
  const rawOrder = b?.data?.order;
  return {
    order: Array.isArray(rawOrder) ? normalizeLayoutOrder(rawOrder) : normalizedOrder,
    revision: layoutRevision(b?.data?.revision),
    reachable: b?.data?.reachable ?? false,
    conflict: r.status === 409 || b?.data?.conflict === true,
    error: b?.data?.error,
  };
}

export interface AttachTarget {
  readonly url: string;
  readonly protocols?: string[];
}

// Browser attach stays same-origin/cookie-auth. Device attach first trades the
// bearer token for a one-time URL ticket over HTTP, because some front proxies do
// not preserve Sec-WebSocket-Protocol on cross-origin WebSocket upgrades.
export async function attachTarget(machine: string, id: string, recovery = false): Promise<AttachTarget> {
  const attachPath = `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/attach`;
  if (isTauri()) {
    const configGeneration = nativeConnectionConfigGeneration();
    const ticketPath = `/api/sessions/${encodeURIComponent(machine)}/${encodeURIComponent(id)}/attach-ticket`;
    let r: Json;
    try {
      r = await readAttachTicket(`${configGeneration}\0${ticketPath}`,
        ATTACH_TICKET_REQUEST_TIMEOUT_MS, recovery);
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError" && loadPerformanceCapture()) {
        recordDebugEvent({ source: "client", method: "POST", route: "/performance/attach-ticket",
          phase: err instanceof RequestCapacityError ? "capacity_rejected" : "deadline_timeout",
          ok: false, duration_ms: err instanceof RequestCapacityError ? null : ATTACH_TICKET_REQUEST_TIMEOUT_MS });
      }
      throw err;
    }
    if (configGeneration !== nativeConnectionConfigGeneration()) {
      throw new DOMException("Connection settings changed", "AbortError");
    }
    const ticket = (r.body as { data?: { ticket?: string } } | undefined)?.data?.ticket;
    if (r.status >= 200 && r.status < 300 && ticket) {
      return { url: `${wsUrl(attachPath)}?ticket=${encodeURIComponent(ticket)}` };
    }
  }
  return { url: wsUrl(attachPath), protocols: wsProtocols() };
}


export async function readEmergencyShell(machine: string, method: "GET" | "POST" | "DELETE" = "GET", incarnation?: string): Promise<EmergencyShell> {
  const path = `/api/shells/${encodeURIComponent(machine)}`;
  const response = await req(path, method === "GET" ? undefined : {
    method, headers: { "content-type": "application/json" },
    body: JSON.stringify(method === "DELETE" ? { incarnation } : {}),
  });
  const result = resultOf(response);
  if (!result.ok) throw new Error(response.status === 404 ? "Shell is unavailable on this machine." : result.error ?? "Shell request failed.");
  const shell = normalizeEmergencyShell((response.body as { data?: { shell?: unknown } })?.data?.shell);
  if (!shell) throw new Error("Invalid shell response.");
  return shell;
}

export async function shellAttachTarget(machine: string, incarnation: string, recovery = false): Promise<AttachTarget> {
  const path = `/api/shells/${encodeURIComponent(machine)}/${encodeURIComponent(incarnation)}`;
  if (isTauri()) {
    const generation = nativeConnectionConfigGeneration();
    const ticketPath = `${path}/attach-ticket`;
    const response = await readAttachTicket(`${generation}\0${ticketPath}`, ATTACH_TICKET_REQUEST_TIMEOUT_MS, recovery);
    if (generation !== nativeConnectionConfigGeneration()) throw new DOMException("Connection settings changed", "AbortError");
    const ticket = (response.body as { data?: { ticket?: string } })?.data?.ticket;
    if (!resultOf(response).ok || !ticket) throw new Error("Shell attach ticket unavailable.");
    return { url: `${wsUrl(`${path}/attach`)}?ticket=${encodeURIComponent(ticket)}` };
  }
  return { url: wsUrl(`${path}/attach`), protocols: wsProtocols() };
}

/** Mode updates use the session creation identity and metadata revision, never a title guess. */
export async function updateSessionTitleMode(session: Session, mode: "auto" | "pinned"): Promise<{ok:boolean;revision?:number;error?:string}> {
  if (!session.created_at || session.display_revision === undefined) return {ok:false,error:"Title mode is unavailable on this daemon."};
  const response = await postJson(`/api/sessions/${encodeURIComponent(session.machine)}/${encodeURIComponent(session.id)}/display-metadata`,{
    title_mode:mode,expected_revision:session.display_revision,expected_session_created_at:session.created_at,
  });
  const body = response.body as {ok?:boolean;data?:{session?:Record<string,unknown>};error?:{message?:string}}|undefined;
  const updated=body?.data?.session;
  if(response.status>=200 && response.status<300 && body?.ok===true && updated?.id===session.id && updated.created_at===session.created_at && updated.title_mode===mode && Number.isSafeInteger(updated.display_revision) && Number(updated.display_revision)>session.display_revision){
    return {ok:true,revision:Number(updated.display_revision)};
  }
  return {ok:false,error:body?.error?.message??"Title mode was not confirmed. Refresh before retrying."};
}

export type SessionRefreshResult =
  | { readonly ok: true; readonly session: Record<string, unknown>; readonly changed: readonly string[]; readonly unavailable: readonly string[] }
  | { readonly ok: false; readonly code?: string; readonly error: string };

/** Re-reads one session's model, reasoning effort, title and context usage on its host. */
export async function refreshSessionInfo(target: { readonly machine: string; readonly id: string }): Promise<SessionRefreshResult> {
  let response: Json;
  try {
    response = await req(`/api/sessions/${encodeURIComponent(target.machine)}/${encodeURIComponent(target.id)}/refresh`, { method: "POST" });
  } catch {
    return { ok: false, error: "Could not reach the console server." };
  }
  const body = response.body as { ok?: boolean; data?: { machine?: unknown; refresh?: unknown }; error?: { code?: unknown; message?: unknown } } | undefined;
  if (response.status >= 200 && response.status < 300 && body?.ok === true && body.data?.machine === target.machine) {
    const refresh = normalizeSessionRefresh(body.data.refresh, target.id);
    if (refresh) return { ok: true, session: refresh.session, changed: refresh.changed, unavailable: refresh.unavailable };
    return { ok: false, error: "Session refresh returned an unexpected response." };
  }
  const code = typeof body?.error?.code === "string" ? body.error.code : undefined;
  return {
    ok: false,
    ...(code ? { code } : {}),
    error: typeof body?.error?.message === "string" && body.error.message ? body.error.message : `Session refresh failed (${response.status}).`,
  };
}

export interface SharedOutboxTarget {
  readonly machine: string;
  readonly id: string;
  readonly incarnation: string;
}
export class SharedOutboxRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code); this.status = status; this.code = code;
  }
}
function sharedOutboxPath(target: SharedOutboxTarget, intent?: string): string {
  return `/api/sessions/${encodeURIComponent(target.machine)}/${encodeURIComponent(target.id)}/outbox${intent ? `/${encodeURIComponent(intent)}` : ""}`;
}
function sharedObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function sharedRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function sharedItem(value: unknown, target: SharedOutboxTarget, intent?: string): SharedOutboxItem | null {
  const raw = sharedObject(value);
  if (!raw || !isPromptRequestId(raw.id) || (intent && raw.id !== intent) || !validOutboxText(raw.text)
    || raw.session_incarnation !== target.incarnation || !sharedRevision(raw.revision)
    || !sharedRevision(raw.created_at) || !sharedRevision(raw.updated_at)
    || !["queued", "sending", "submitted", "command_dispatched", "refused", "unknown", "cancelled"].includes(String(raw.state))
    || (raw.request_id !== null && !isPromptRequestId(raw.request_id))
    || (raw.edit_hold !== null && !isPromptRequestId(raw.edit_hold))
    || (raw.error_code !== null && (typeof raw.error_code !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(raw.error_code)))) return null;
  const receiptRaw = sharedObject(raw.receipt);
  const receipt = receiptRaw ? normalizePromptReceipt(receiptRaw, { request_id: String(raw.request_id ?? receiptRaw.request_id),
    session_id: target.id, session_incarnation: target.incarnation }) : null;
  if (raw.receipt !== null && !receipt) return null;
  if ((raw.state === "submitted" || raw.state === "command_dispatched" || raw.state === "unknown") && (receipt?.outcome !== raw.state || !raw.request_id)) return null;
  if (raw.state === "sending" && !raw.request_id) return null;
  return { id: raw.id, text: raw.text, session_incarnation: target.incarnation,
    state: raw.state as SharedOutboxItem["state"], revision: raw.revision, created_at: raw.created_at, updated_at: raw.updated_at,
    request_id: raw.request_id as string | null, receipt, edit_hold: raw.edit_hold as string | null, error_code: raw.error_code as string | null };
}
async function sharedOutboxRequest(target: SharedOutboxTarget, method: "GET" | "PUT" | "PATCH", intent?: string, body?: unknown): Promise<Record<string, unknown>> {
  const generation = nativeConnectionConfigGeneration();
  // Capture before native transport loading or any other await. A shared cookie
  // can change in another tab without changing this tab's storage namespace.
  const principal = getPrincipalStorageNamespace();
  if (!principal) throw new SharedOutboxRequestError(409, "outbox-principal-changed");
  const path = sharedOutboxPath(target, intent) + (method === "GET" ? `?expected_session_incarnation=${encodeURIComponent(target.incarnation)}` : "");
  const result = await withRequestDeadline(signal => req(path, { method, signal,
    headers: { "x-console-expected-principal": principal, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), 10_000);
  if (generation !== nativeConnectionConfigGeneration()) throw new SharedOutboxRequestError(0, "outbox-connection-changed");
  if (principal !== getPrincipalStorageNamespace()) throw new SharedOutboxRequestError(409, "outbox-principal-changed");
  const envelope = sharedObject(result.body);
  if (result.status < 200 || result.status >= 300 || envelope?.ok !== true) {
    const code = sharedObject(envelope?.error)?.code;
    throw new SharedOutboxRequestError(result.status, typeof code === "string" && /^outbox-[a-z-]+$/.test(code) ? code : "outbox-request-failed");
  }
  const data = sharedObject(envelope.data);
  if (!data) throw new SharedOutboxRequestError(0, "outbox-response-unconfirmed");
  return data;
}
export async function readSharedOutbox(target: SharedOutboxTarget): Promise<SharedOutboxSnapshot> {
  const raw = await sharedOutboxRequest(target, "GET");
  if (!sharedRevision(raw.revision) || !Array.isArray(raw.items) || raw.items.length > SHARED_OUTBOX_MAX_ITEMS
    || !Array.isArray(raw.compose_holds) || raw.compose_holds.length > SHARED_OUTBOX_MAX_HOLDS || !raw.compose_holds.every(isPromptRequestId)) {
    throw new SharedOutboxRequestError(0, "outbox-response-unconfirmed");
  }
  const items = raw.items.map(value => sharedItem(value, target));
  if (items.some(item => !item) || new Set(items.map(item => item?.id)).size !== items.length) throw new SharedOutboxRequestError(0, "outbox-response-unconfirmed");
  return { revision: raw.revision, items: items as SharedOutboxItem[], compose_holds: raw.compose_holds };
}
export async function admitSharedOutbox(target: SharedOutboxTarget, id: string, text: string): Promise<SharedOutboxItem> {
  const raw = await sharedOutboxRequest(target, "PUT", id, { text, expected_session_incarnation: target.incarnation });
  const item = sharedItem(raw.item, target, id);
  if (!item) throw new SharedOutboxRequestError(0, "outbox-response-unconfirmed");
  return item;
}

export async function actOnRefusedSharedOutbox(target: SharedOutboxTarget, item: SharedOutboxItem,
  operation: RefusedOutboxAction["operation"]): Promise<SharedOutboxItem> {
  const raw = await sharedOutboxRequest(target, "PATCH", item.id, {
    operation, base_revision: item.revision, expected_session_incarnation: target.incarnation,
  });
  const result = sharedItem(raw.item, target, item.id);
  if (!result) throw new SharedOutboxRequestError(0, "outbox-response-unconfirmed");
  return result;
}

/** Authenticated transport for statically registered distribution extensions. */
export { req as extensionRequest, readReachableWithRecovery };
