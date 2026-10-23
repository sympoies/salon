import type { ServerResponse } from "node:http";
import { sendJson } from "./http.ts";
import type { DaemonResult } from "./upstream.ts";
import { normalizeSessionTitleState } from "@agent-console/shared/title";
import {
  ACCOUNT_PROVIDER_LABELS,
  ACCOUNT_PROVIDERS,
  confirmsAccountSwitch,
  confirmsCreatedAccountBinding,
  normalizeAccountStatus,
  normalizeAccountSummaries,
  normalizeAgentLaunchProfileId,
  normalizeAutoResumeStatus,
  normalizeCodexAccountReadiness,
  normalizeSelectionStrategies,
  normalizeStartupStatus,
  normalizePublicSessionDeleteResult,
  normalizeSessionWorkspace,
  normalizeSessionOrigin,
  projectPublicAgentSession,
  type AccountProvider,
} from "@agent-console/shared/api";
import {
  MAINTENANCE_SCHEMA_VERSION,
  normalizeSessionMaintenanceActionResult,
  normalizeSessionMaintenanceError,
  normalizeSessionMaintenancePreview,
  type SessionMaintenanceActionRequest,
  type SessionMaintenancePreview,
  type SessionMaintenancePreviewExpectation,
} from "@agent-console/shared/maintenance";
import {
  normalizeSessionRetitleError,
  normalizeSessionRetitleReadiness,
  normalizeSessionRetitleV3Receipts,
  normalizeSessionRetitleResult,
  normalizeSessionRetitleV3Readiness,
  normalizeSessionRetitleV3Result,
  type SessionRetitleErrorCode,
  type SessionRetitleRequest,
  type SessionRetitleV3Request,
} from "@agent-console/shared/session-retitle";

// Uniform edge envelope: unwrap the daemon `{schema_version, ok, data}` into
// `{ok, data, error}` so every API route returns one shape. An empty 2xx daemon
// body is a success; never invent `{ok:false}` for a 200.
export function forwardDaemon(res: ServerResponse, r: DaemonResult): void {
  const ok2xx = r.status >= 200 && r.status < 300;
  const b = r.body as { ok?: boolean; data?: unknown; error?: unknown } | undefined;
  if (b === undefined) {
    sendJson(res, r.status, ok2xx ? { ok: true } : { ok: false, error: { message: `daemon status ${r.status}` } });
    return;
  }
  sendJson(res, r.status, { ok: b.ok ?? ok2xx, data: b.data, error: b.error });
}

export function forwardDisplayMetadataDaemon(res: ServerResponse, machine: string, sessionId: string, r: DaemonResult): void {
  const body = r.body as {ok?: boolean; data?: {session?: unknown}; error?: {code?: unknown}} | undefined;
  const ok2xx = r.status >= 200 && r.status < 300;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {ok:false,error:safeDaemonError(body?.error?.code, "Title mode update failed.")});
    return;
  }
  const session = projectPublicAgentSession(body?.data?.session);
  if (session.id !== sessionId || typeof session.agent !== "string") {
    sendJson(res, 502, {ok:false,error:{message:"Invalid title mode daemon response."}});
    return;
  }
  sendJson(res, r.status, {ok:true,data:{machine,session}});
}

const RETITLE_ERROR_MESSAGES: Readonly<Record<SessionRetitleErrorCode, string>> = {
  "invalid-retitle-request": "The retitle request is invalid.",
  "retitle-provider-not-configured": "The retitle provider is not configured.",
  "retitle-config-invalid": "The retitle provider configuration is invalid.",
  "retitle-context-unavailable": "Retitle context is not ready yet.",
  "retitle-api-key-missing": "The retitle provider API key is missing.",
  "retitle-provider-timeout": "The retitle provider timed out.",
  "retitle-provider-unavailable": "The retitle provider is unavailable.",
  "retitle-provider-malformed-response": "The retitle provider returned an invalid response.",
  "retitle-provider-rate-limited": "The retitle provider is rate limited.",
  "retitle-provider-quota-exceeded": "The retitle provider quota is exhausted.",
  "retitle-account-missing": "The configured retitle account is unavailable.",
  "retitle-queue-saturated": "The retitle queue is busy.",
  "idempotency-key-reused": "The retitle idempotency key was reused for another request.",
  "retitle-turn-conflict": "The session turn changed; refresh and retry.",
  "retitle-state-conflict": "The session retitle state changed; refresh and retry.",
  "retitle-worker-failed": "The retitle worker failed.",
  "title-revision-conflict": "The session title changed; refresh and retry.",
  "session-incarnation-conflict": "The session runtime changed; refresh and retry.",
  "retitle-v3-history-conflict": "The session history changed; refresh and retry.",
  "retitle-v3-history-degraded": "Session history is degraded; the cached title remains available.",
  "retitle-v3-history-stale": "Session history advanced; refresh and retry.",
  "retitle-v3-history-unavailable": "Session history is unavailable.",
  "retitle-v3-idempotency-conflict": "The retitle request conflicts with an earlier request.",
  "retitle-v3-memory-invalid": "Retitle memory is invalid.",
  "retitle-v3-memory-not-ready": "Retitle memory is not ready yet.",
  "retitle-v3-objective-unavailable": "No user prompt or active Goal is available to title this session.",
  "retitle-v3-memory-too-large": "Retitle memory exceeded its safe bound.",
  "retitle-v3-memory-version-unsupported": "Retitle memory requires a runtime upgrade.",
  "retitle-v3-operation-capacity": "Retitle operations are busy; wait and retry.",
  "retitle-v3-operation-not-found": "The retitle operation is no longer available.",
  "retitle-v3-operation-queued": "The retitle operation is queued.",
  "retitle-v3-state-conflict": "Retitle memory changed; refresh and retry.",
  "retitle-v3-turn-conflict": "The session turn changed; refresh and retry.",
  "title-revision-overflow": "The session title revision cannot advance.",
};

function retitleErrorEnvelope(value: unknown): (Record<string, unknown> & { code: string }) | null {
  const error = normalizeSessionRetitleError(value);
  if (!error) return null;
  const { code, retryable, next_action, recovery } = error;
  return {
    code,
    message: RETITLE_ERROR_MESSAGES[code],
    ...(
      retryable !== undefined || next_action !== undefined || recovery !== undefined
        ? {
            details: {
              ...(retryable !== undefined ? { retryable } : {}),
              ...(next_action !== undefined ? { next_action } : {}),
              ...(recovery !== undefined ? { recovery } : {}),
            },
          }
        : {}
    ),
  };
}

export function forwardSessionRetitleReadinessDaemon(
  res: ServerResponse,
  r: DaemonResult,
  expectedMachine: string,
): void {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as {
    ok?: unknown;
    data?: { machine?: unknown; retitle?: unknown };
  } | undefined;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error: { code: "retitle-readiness-unavailable", message: "Session retitle readiness is unavailable." },
    });
    return;
  }
  const readiness = normalizeSessionRetitleReadiness(body?.data?.retitle);
  if (body?.data?.machine !== expectedMachine || !readiness) {
    sendJson(res, 502, {
      ok: false,
      error: { code: "invalid-retitle-readiness", message: "Invalid session retitle readiness response." },
    });
    return;
  }
  sendJson(res, r.status, { ok: true, data: { machine: expectedMachine, retitle: readiness } });
}

// The daemon's receipt list, projected the same way the other v3 routes are.
// A host that predates the daemon route answers 404, which is not a failure of
// this console: it is reported as an unsupported host so the panel can say so
// instead of showing an error.
export function forwardSessionRetitleV3ReceiptsDaemon(
  res: ServerResponse,
  r: DaemonResult,
  expectedMachine: string,
): void {
  if (r.status === 404 || r.status === 405) {
    sendJson(res, 200, {
      ok: true,
      data: { machine: expectedMachine, supported: false, retitle: null },
    });
    return;
  }
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as {
    ok?: unknown;
    data?: { machine?: unknown; retitle?: unknown };
  } | undefined;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error: {
        code: "retitle-receipts-unavailable",
        message: "Session retitle receipts are unavailable.",
      },
    });
    return;
  }
  const receipts = normalizeSessionRetitleV3Receipts(body?.data?.retitle);
  if (body?.data?.machine !== expectedMachine || !receipts) {
    sendJson(res, 502, {
      ok: false,
      error: {
        code: "invalid-retitle-receipts",
        message: "Invalid session retitle receipts response.",
      },
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    data: { machine: expectedMachine, supported: true, retitle: receipts },
  });
}

// A content-free summary of what the daemon decided, so the edge can retain a
// lifecycle record for the daemon paths. Every field is a bounded stable token
// that already crosses this boundary in the projected response.
export interface SessionRetitleForwardSummary {
  readonly path: "daemon_v2" | "daemon_v3";
  readonly outcome: string;
  readonly trigger?: string;
  readonly failureClass?: string;
  readonly failureStage?: string;
  readonly providerKind?: string;
  readonly durationBucket?: string;
}

export function forwardSessionRetitleDaemon(
  res: ServerResponse,
  r: DaemonResult,
  expectedMachine: string,
  request: SessionRetitleRequest,
): SessionRetitleForwardSummary {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as {
    ok?: unknown;
    data?: { machine?: unknown; retitle?: unknown };
    error?: unknown;
  } | undefined;
  if (!ok2xx || body?.ok === false) {
    const error = retitleErrorEnvelope(body?.error) ?? {
      code: "session-retitle-failed",
      message: "Session retitle could not safely complete.",
    };
    sendJson(res, ok2xx ? 502 : r.status, { ok: false, error });
    return { path: "daemon_v2", outcome: error.code, trigger: request.trigger };
  }
  const retitle = normalizeSessionRetitleResult(body?.data?.retitle);
  if (
    body?.data?.machine !== expectedMachine
    || !retitle
    || retitle.trigger !== request.trigger
    || retitle.session.session_incarnation !== request.expected_session_incarnation
    || retitle.session.title_revision < request.expected_title_revision
  ) {
    sendJson(res, 502, {
      ok: false,
      error: { code: "invalid-session-retitle-response", message: "Invalid session retitle response." },
    });
    return { path: "daemon_v2", outcome: "invalid-session-retitle-response", trigger: request.trigger };
  }
  sendJson(res, r.status, { ok: true, data: { machine: expectedMachine, retitle } });
  return {
    path: "daemon_v2",
    outcome: retitle.outcome,
    trigger: retitle.trigger,
    providerKind: retitle.provider_kind,
  };
}

export function forwardSessionRetitleV3ReadinessDaemon(
  res: ServerResponse,
  r: DaemonResult,
  expectedMachine: string,
): void {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as { ok?: unknown; data?: { machine?: unknown; retitle?: unknown } } | undefined;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error: { code: "retitle-readiness-unavailable", message: "Session retitle readiness is unavailable." },
    });
    return;
  }
  const readiness = normalizeSessionRetitleV3Readiness(body?.data?.retitle);
  if (body?.data?.machine !== expectedMachine || !readiness) {
    sendJson(res, 502, {
      ok: false,
      error: { code: "invalid-retitle-readiness", message: "Invalid session retitle readiness response." },
    });
    return;
  }
  sendJson(res, r.status, { ok: true, data: { machine: expectedMachine, retitle: readiness } });
}

export function forwardSessionRetitleV3Daemon(
  res: ServerResponse,
  r: DaemonResult,
  expectedMachine: string,
  request?: SessionRetitleV3Request,
  expectedOperationHash?: string,
): SessionRetitleForwardSummary {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as { ok?: unknown; data?: { machine?: unknown; retitle?: unknown }; error?: unknown } | undefined;
  if (!ok2xx || body?.ok === false) {
    const error = retitleErrorEnvelope(body?.error) ?? {
      code: "session-retitle-failed",
      message: "Session retitle could not safely complete.",
    };
    sendJson(res, ok2xx ? 502 : r.status, { ok: false, error });
    return { path: "daemon_v3", outcome: error.code, trigger: request?.trigger };
  }
  const retitle = normalizeSessionRetitleV3Result(body?.data?.retitle);
  const requestFenceMatches = !request || Boolean(
    retitle
    && retitle.admission_fence.session_incarnation === request.expected.session_incarnation
    && retitle.admission_fence.title_revision === request.expected.title_revision
    && retitle.admission_fence.memory_revision === request.expected.memory_revision
  );
  if (
    body?.data?.machine !== expectedMachine
    || !retitle
    || !requestFenceMatches
    || expectedOperationHash !== undefined && retitle.operation_hash !== expectedOperationHash
  ) {
    sendJson(res, 502, {
      ok: false,
      error: { code: "invalid-session-retitle-response", message: "Invalid session retitle response." },
    });
    return { path: "daemon_v3", outcome: "invalid-session-retitle-response", trigger: request?.trigger };
  }
  sendJson(res, r.status, { ok: true, data: { machine: expectedMachine, retitle } });
  return {
    path: "daemon_v3",
    outcome: retitle.status === "accepted" ? "accepted" : retitle.outcome ?? "terminal_failure",
    trigger: request?.trigger,
    failureClass: retitle.failure_class,
    failureStage: retitle.failure_stage,
    providerKind: retitle.provider_attempts.at(-1)?.provider_kind,
    durationBucket: retitle.duration_bucket,
  };
}

function boundedHistoryString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function projectHistorySession(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = boundedHistoryString(raw.id, 80);
  const providerSessionId = boundedHistoryString(raw.provider_session_id, 256);
  const provider = raw.provider === "codex" || raw.provider === "claude" || raw.provider === "dsh"
    ? raw.provider
    : undefined;
  const cwd = boundedHistoryString(raw.cwd, 4096);
  const createdAt = boundedHistoryString(raw.created_at, 64);
  const updatedAt = boundedHistoryString(raw.updated_at, 64);
  if (!id || !providerSessionId || !provider || !cwd || !createdAt || !updatedAt) return null;
  const projected: Record<string, unknown> = {
    id,
    provider,
    provider_session_id: providerSessionId,
    cwd,
    created_at: createdAt,
    updated_at: updatedAt,
    resumable: raw.resumable === true,
  };
  const agentProfile = normalizeAgentLaunchProfileId(raw.agent_profile);
  if (agentProfile) projected.agent_profile = agentProfile;
  if (raw.title === null) projected.title = null;
  else {
    const title = boundedHistoryString(raw.title, 512);
    if (title) projected.title = title;
  }
  for (const [field, max] of [
    ["prompt_preview", 1024],
    ["first_user_prompt_preview", 1024],
    ["last_user_prompt_preview", 1024],
    ["repo_name", 512],
    ["archived_at", 64],
    ["starred_at", 64],
  ] as const) {
    const normalized = boundedHistoryString(raw[field], max);
    if (normalized) projected[field] = normalized;
    else if (field === "repo_name" && raw[field] === null) projected[field] = null;
  }
  return projected;
}

function projectHistoryMessage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = boundedHistoryString(raw.id, 160);
  const role = raw.role === "user" || raw.role === "assistant" || raw.role === "goal" ? raw.role : undefined;
  const text = boundedHistoryString(raw.text, 64 * 1024);
  if (!id || !role || !text) return null;
  const projected: Record<string, unknown> = { id, role, text };
  const timestamp = boundedHistoryString(raw.timestamp, 64);
  if (timestamp) projected.timestamp = timestamp;
  return projected;
}

export function projectHistorySessionsDaemonData(
  value: unknown,
  include: (session: Readonly<Record<string, unknown>>) => boolean = () => true,
  annotate?: (session: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.sessions)) return null;
  const sessions = raw.sessions.slice(0, 100).flatMap((session) => {
    const projected = projectHistorySession(session);
    if (!projected || !include(projected)) return [];
    const extra = annotate?.(projected);
    return [extra ? { ...projected, ...extra } : projected];
  });
  const projected: Record<string, unknown> = { sessions, truncated: raw.truncated === true };
  const nextCursor = boundedHistoryString(raw.next_cursor, 256);
  if (nextCursor) projected.next_cursor = nextCursor;
  if (raw.capabilities && typeof raw.capabilities === "object" && !Array.isArray(raw.capabilities)) {
    const capabilities = raw.capabilities as Record<string, unknown>;
    const projectedCapabilities: Record<string, boolean> = {
      ...(capabilities.latest_message_paging === true ? { latest_message_paging: true } : {}),
      ...(capabilities.star === true ? { star: true } : {}),
      ...(capabilities.resume === true ? { resume: true } : {}),
    };
    if (Object.keys(projectedCapabilities).length > 0) projected.capabilities = projectedCapabilities;
  }
  return projected;
}

export function projectHistoryMessagesDaemonData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.messages)) return null;
  const messages = raw.messages.slice(0, 100).flatMap((message) => {
    const projected = projectHistoryMessage(message);
    return projected ? [projected] : [];
  });
  const projected: Record<string, unknown> = { messages };
  const nextCursor = boundedHistoryString(raw.next_cursor, 256);
  if (nextCursor) projected.next_cursor = nextCursor;
  const olderCursor = boundedHistoryString(raw.older_cursor, 256);
  if (olderCursor) projected.older_cursor = olderCursor;
  return projected;
}

function forwardProjectedHistoryDaemon(
  res: ServerResponse,
  r: DaemonResult,
  projector: (value: unknown) => Record<string, unknown> | null,
  fallback: string,
): void {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as { ok?: unknown; data?: unknown; error?: { code?: unknown; details?: { reason?: unknown } } } | undefined;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error: safeDaemonError(body?.error?.code, fallback, body?.error?.details?.reason),
    });
    return;
  }
  const data = projector(body?.data);
  if (!data) {
    sendJson(res, 502, { ok: false, error: { message: `invalid ${fallback} response` } });
    return;
  }
  sendJson(res, r.status, { ok: true, data });
}

export function forwardHistorySessionsDaemon(
  res: ServerResponse,
  r: DaemonResult,
  include?: (session: Readonly<Record<string, unknown>>) => boolean,
  annotate?: (session: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> | undefined,
): void {
  forwardProjectedHistoryDaemon(
    res,
    r,
    (value) => projectHistorySessionsDaemonData(value, include, annotate),
    "session history",
  );
}

export function forwardHistoryMessagesDaemon(res: ServerResponse, r: DaemonResult): void {
  forwardProjectedHistoryDaemon(res, r, projectHistoryMessagesDaemonData, "history conversation");
}

export function projectHistoryStarDaemonData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const historyId = boundedHistoryString(raw.id ?? raw.history_id, 80);
  if (!historyId) return null;
  const starredAt = boundedHistoryString(raw.starred_at, 64);
  return { history_id: historyId, starred_at: starredAt ?? null };
}

export function forwardHistoryStarDaemon(res: ServerResponse, r: DaemonResult): void {
  forwardProjectedHistoryDaemon(res, r, projectHistoryStarDaemonData, "history star");
}

// A managed session id as agent-session validates it, bounded for the wire.
const LIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function forwardHistoryResumeDaemon(res: ServerResponse, r: DaemonResult): void {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as {
    ok?: unknown;
    data?: { session?: unknown };
    error?: { code?: unknown; details?: { reason?: unknown; id?: unknown } };
  } | undefined;
  if (!ok2xx || body?.ok === false) {
    const error: { code?: string; message: string; live_session_id?: string } =
      safeDaemonError(body?.error?.code, "session history resume failed", body?.error?.details?.reason);
    // The conversation is already live: name that session so the client opens
    // it instead of leaving one conversation under two ids.
    const liveId = body?.error?.details?.id;
    if (error.code === "history-session-live" && typeof liveId === "string" && LIVE_SESSION_ID.test(liveId)) {
      error.live_session_id = liveId;
    }
    sendJson(res, ok2xx ? 502 : r.status, { ok: false, error });
    return;
  }
  const rawSession = body?.data?.session;
  const session = rawSession && typeof rawSession === "object" && !Array.isArray(rawSession)
    ? projectCreatedSession(rawSession as Record<string, unknown>)
    : null;
  if (!session) {
    sendJson(res, 502, { ok: false, error: { message: "invalid history resume daemon response" } });
    return;
  }
  sendJson(res, r.status, { ok: true, data: { session } });
}

export function projectArchiveDaemonData(
  value: unknown,
  expectedId: string,
): { archived: Record<string, unknown>; deleted: ReturnType<typeof normalizePublicSessionDeleteResult> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as { archived?: unknown; deleted?: unknown };
  const archived = projectHistorySession({
    ...(data.archived && typeof data.archived === "object" ? data.archived : {}),
    id: (data.archived as { history_id?: unknown } | undefined)?.history_id,
    resumable: false,
  });
  const deleted = normalizePublicSessionDeleteResult(data.deleted, expectedId);
  return archived && deleted ? { archived, deleted } : null;
}

export function forwardArchiveDaemon(res: ServerResponse, r: DaemonResult, expectedId: string): void {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as {
    ok?: unknown;
    data?: unknown;
    error?: { code?: unknown; details?: { reason?: unknown } };
  } | undefined;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error: safeDaemonError(body?.error?.code, "session archive failed", body?.error?.details?.reason),
    });
    return;
  }
  const data = projectArchiveDaemonData(body?.data, expectedId);
  if (!data) {
    sendJson(res, 502, { ok: false, error: { message: "invalid session archive acknowledgement" } });
    return;
  }
  sendJson(res, r.status, { ok: true, data });
}

export function forwardSessionDeleteDaemon(res: ServerResponse, r: DaemonResult, expectedId: string): void {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as {
    ok?: unknown;
    data?: { deleted?: unknown };
    error?: { code?: unknown; details?: { reason?: unknown } };
  } | undefined;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error: safeDaemonError(body?.error?.code, "session delete failed", body?.error?.details?.reason),
    });
    return;
  }
  const deleted = normalizePublicSessionDeleteResult(body?.data?.deleted, expectedId);
  if (!deleted) {
    sendJson(res, 502, { ok: false, error: { message: "invalid session delete acknowledgement" } });
    return;
  }
  sendJson(res, r.status, { ok: true, data: { deleted } });
}

export function forwardFencedStructuredPromptDaemon(
  res: ServerResponse,
  r: DaemonResult,
  expectedSessionIncarnation: string,
): void {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as {
    ok?: unknown;
    data?: { submitted?: unknown; queued?: unknown; session_incarnation?: unknown };
  } | undefined;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error: { message: "provider prompt submission failed" },
    });
    return;
  }
  if (
    body?.ok !== true
    || body.data?.submitted !== true
    || body.data.session_incarnation !== expectedSessionIncarnation
  ) {
    sendJson(res, 502, {
      ok: false,
      error: { message: "invalid provider prompt acknowledgement" },
    });
    return;
  }
  // `queued`: the provider accepted the prompt behind its running turn (a
  // busy Claude session); it is delivered, not pending.
  sendJson(res, r.status, {
    ok: true,
    data: {
      submitted: true,
      ...(body.data.queued === true ? { queued: true } : {}),
      session_incarnation: expectedSessionIncarnation,
    },
  });
}

// Auto-resume is a metadata-only boundary. Do not reuse the generic forwarder:
// it intentionally preserves arbitrary daemon data for older routes.
export function forwardAutoResumeDaemon(res: ServerResponse, r: DaemonResult): void {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as { ok?: boolean; data?: { auto_resume?: unknown } } | undefined;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error: { message: "auto-resume daemon request failed" },
    });
    return;
  }
  const autoResume = normalizeAutoResumeStatus(body?.data?.auto_resume);
  if (!autoResume) {
    sendJson(res, 502, { ok: false, error: { message: "invalid auto-resume daemon response" } });
    return;
  }
  sendJson(res, r.status, { ok: true, data: { auto_resume: autoResume } });
}

function maintenanceUnsupported(r: DaemonResult): boolean {
  if (r.status === 405 || r.status === 501) return true;
  if (r.status !== 404) return false;
  const body = r.body as { error?: unknown } | undefined;
  return normalizeSessionMaintenanceError(body?.error) === null;
}

export function maintenancePreviewFromDaemon(
  r: DaemonResult,
  expected?: SessionMaintenancePreviewExpectation,
): SessionMaintenancePreview | null {
  if (r.status < 200 || r.status >= 300) return null;
  const body = r.body as { ok?: boolean; data?: { maintenance?: unknown } } | undefined;
  if (body?.ok === false) return null;
  return normalizeSessionMaintenancePreview(body?.data?.maintenance, expected);
}

export function forwardMaintenancePreviewDaemon(
  res: ServerResponse,
  r: DaemonResult,
  expected: SessionMaintenancePreviewExpectation,
): void {
  if (maintenanceUnsupported(r)) {
    sendJson(res, 501, {
      ok: false,
      error: {
        code: "maintenance-unsupported",
        message: "Session maintenance is unavailable on this machine.",
      },
    });
    return;
  }
  const body = r.body as { ok?: boolean; data?: { maintenance?: unknown }; error?: unknown } | undefined;
  if (r.status < 200 || r.status >= 300 || body?.ok === false) {
    const error = normalizeSessionMaintenanceError(body?.error, expected) ?? {
      code: "session-maintenance-failed",
      message: "Session maintenance could not safely complete.",
    };
    sendJson(res, r.status >= 200 && r.status < 300 ? 502 : r.status, { ok: false, error });
    return;
  }
  const maintenance = maintenancePreviewFromDaemon(r, expected);
  if (!maintenance) {
    sendJson(res, 502, {
      ok: false,
      error: { code: "invalid-maintenance-response", message: "Invalid session maintenance response." },
    });
    return;
  }
  sendJson(res, r.status, { ok: true, data: { maintenance } });
}

export function forwardMaintenanceActionDaemon(
  res: ServerResponse,
  r: DaemonResult,
  expected: { readonly sessionId: string; readonly request: SessionMaintenanceActionRequest },
): void {
  if (maintenanceUnsupported(r)) {
    sendJson(res, 501, {
      ok: false,
      error: {
        code: "maintenance-unsupported",
        message: "Session maintenance is unavailable on this machine.",
      },
    });
    return;
  }
  const body = r.body as {
    ok?: boolean;
    data?: { maintenance_result?: unknown };
    error?: unknown;
  } | undefined;
  if (r.status < 200 || r.status >= 300 || body?.ok === false) {
    const error = normalizeSessionMaintenanceError(body?.error, {
      sessionId: expected.sessionId,
      operation: expected.request.operation,
    }) ?? {
      code: "session-maintenance-failed",
      message: "Session maintenance could not safely complete.",
    };
    sendJson(res, r.status >= 200 && r.status < 300 ? 502 : r.status, { ok: false, error });
    return;
  }
  const result = normalizeSessionMaintenanceActionResult(body?.data?.maintenance_result, {
    sessionId: expected.sessionId,
    operation: expected.request.operation,
    action: expected.request.action,
    // The daemon must answer under the contract this request was sent on.
    schemaVersion: expected.request.schema_version ?? MAINTENANCE_SCHEMA_VERSION,
  });
  if (!result) {
    sendJson(res, 502, {
      ok: false,
      error: { code: "invalid-maintenance-response", message: "Invalid session maintenance response." },
    });
    return;
  }
  sendJson(res, r.status, { ok: true, data: { maintenance_result: result } });
}

/**
 * A machine's broker accounts for one provider. Codex adds its app-server
 * readiness, which must parse when present.
 */
export function forwardAccountsDaemon(res: ServerResponse, r: DaemonResult, provider: AccountProvider): void {
  const label = ACCOUNT_PROVIDER_LABELS[provider];
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as {
    ok?: boolean;
    data?: { accounts?: unknown; readiness?: unknown; selection_strategies?: unknown };
  } | undefined;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error: { message: `${label} accounts are unavailable` },
    });
    return;
  }
  const rawReadiness = provider === "codex" ? body?.data?.readiness : undefined;
  const readiness = rawReadiness === undefined ? undefined : normalizeCodexAccountReadiness(rawReadiness);
  if (rawReadiness !== undefined && !readiness) {
    sendJson(res, 502, {
      ok: false,
      error: { code: "invalid-codex-account-readiness", message: "invalid Codex account readiness daemon response" },
    });
    return;
  }
  const rawStrategies = body?.data?.selection_strategies;
  sendJson(res, r.status, {
    ok: true,
    data: {
      accounts: normalizeAccountSummaries(body?.data?.accounts),
      ...(readiness ? { readiness } : {}),
      ...(rawStrategies === undefined ? {} : { selection_strategies: normalizeSelectionStrategies(rawStrategies) }),
    },
  });
}

// The daemon routes `PUT /sessions/{id}/account` by the session's provider and
// answers with that provider's view: `claude_account` for a Claude session,
// `codex_account` otherwise.
function switchedAccountProvider(data: Record<string, unknown> | undefined): AccountProvider {
  return data && Object.hasOwn(data, "claude_account") && !Object.hasOwn(data, "codex_account")
    ? "claude"
    : "codex";
}

/**
 * Forwards the provider-routed `PUT /sessions/{id}/account` answer once it
 * confirms the requested account: a Codex switch applied or queued behind the
 * running turn, or a Claude switch queued for the next resume or applied by a
 * restart, in which case `session_incarnation` names the new runtime.
 */
export function forwardSessionAccountDaemon(
  res: ServerResponse,
  r: DaemonResult,
  requestedAccount: string,
  expectedSessionIncarnation: string,
): void {
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as {
    ok?: boolean;
    data?: Record<string, unknown>;
    error?: { code?: unknown; details?: { reason?: unknown } };
  } | undefined;
  if (!ok2xx || body?.ok === false) {
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error: safeDaemonError(body?.error?.code, "account switch failed"),
    });
    return;
  }
  const provider = switchedAccountProvider(body?.data);
  const field = `${provider}_account` as const;
  const account = normalizeAccountStatus(provider, body?.data?.[field]);
  const responseSessionIncarnation = body?.data?.session_incarnation;
  if (
    !account
    || !confirmsAccountSwitch(
      provider,
      account,
      requestedAccount,
      expectedSessionIncarnation,
      responseSessionIncarnation,
    )
  ) {
    sendJson(res, 502, {
      ok: false,
      error: { message: `invalid ${ACCOUNT_PROVIDER_LABELS[provider]} account daemon response` },
    });
    return;
  }
  sendJson(res, r.status, {
    ok: true,
    data: {
      ...(typeof responseSessionIncarnation === "string" ? { session_incarnation: responseSessionIncarnation } : {}),
      [field]: account,
    },
  });
}

export function forwardCreateDaemon(res: ServerResponse, requestBody: unknown, r: DaemonResult): void {
  const providerResumeId = providerResumeIdOf(requestBody);
  if (providerResumeId !== undefined && r.status >= 200 && r.status < 300 && !confirmsProviderResume(r.body, providerResumeId)) {
    sendJson(res, 502, {
      ok: false,
      error: {
        code: "provider-resume-unsupported-daemon",
        message: "machine daemon did not confirm provider resume import",
      },
    });
    return;
  }
  const requestedAgentProfile = agentProfileOf(requestBody);
  const requestedAgent = agentOf(requestBody);
  const ok2xx = r.status >= 200 && r.status < 300;
  const body = r.body as { ok?: boolean; data?: { session?: unknown }; error?: { code?: unknown; details?: { reason?: unknown } } } | undefined;
  if (!ok2xx || body?.ok === false || !body?.data?.session || typeof body.data.session !== "object" || Array.isArray(body.data.session)) {
    const error = safeDaemonError(body?.error?.code, "session creation failed", body?.error?.details?.reason);
    sendJson(res, ok2xx ? 502 : r.status, {
      ok: false,
      error,
    });
    return;
  }
  const session = body.data.session as Record<string, unknown>;
  const sanitizedSession = projectCreatedSession(session);
  if (!sanitizedSession) {
    sendJson(res, 502, { ok: false, error: { message: "invalid create-session daemon response" } });
    return;
  }
  const requestedId = typeof (requestBody as { id?: unknown }).id === "string"
    ? (requestBody as { id: string }).id
    : undefined;
  if (requestedId !== undefined && sanitizedSession.id !== requestedId) {
    sendJson(res, 502, { ok: false, error: { message: "daemon did not confirm the requested session id" } });
    return;
  }
  if (
    requestedAgentProfile !== undefined
    && (
      sanitizedSession.agent_profile !== requestedAgentProfile
      || sanitizedSession.agent !== requestedAgent
    )
  ) {
    sendJson(res, 502, {
      ok: false,
      error: {
        code: "agent-profile-unsupported-daemon",
        message: "machine daemon did not confirm the requested agent launch profile",
      },
    });
    return;
  }
  const sessionIncarnation = typeof sanitizedSession.session_incarnation === "string"
    ? sanitizedSession.session_incarnation
    : undefined;
  for (const provider of ACCOUNT_PROVIDERS) {
    const field = `${provider}_account` as const;
    const account = normalizeAccountStatus(provider, session[field]);
    const requestedAccount = requestAccountOf(requestBody, provider);
    if (
      requestedAccount !== undefined
      && (
        !account
        || !sessionIncarnation
        || !confirmsCreatedAccountBinding(account, requestedAccount, sessionIncarnation)
      )
    ) {
      sendJson(res, 502, {
        ok: false,
        error: {
          code: `${provider}-account-unsupported-daemon`,
          message: `machine daemon did not confirm the requested ${ACCOUNT_PROVIDER_LABELS[provider]} account`,
        },
      });
      return;
    }
    if (account) sanitizedSession[field] = account;
  }
  sendJson(res, r.status, {
    ok: true,
    data: { session: sanitizedSession },
  });
}

function agentProfileOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return normalizeAgentLaunchProfileId((value as { agent_profile?: unknown }).agent_profile);
}

function agentOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const agent = (value as { agent?: unknown }).agent;
  return typeof agent === "string" ? agent : undefined;
}

function requestAccountOf(value: unknown, provider: AccountProvider): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const account = (value as Record<string, unknown>)[`${provider}_account`];
  return typeof account === "string" ? account : undefined;
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9._-]{1,64}$/.test(value) ? value : undefined;
}

// Account errors both providers report, as `<provider>-account-<suffix>` (and
// `invalid-<provider>-account`). Provider-only conditions are listed below.
function sharedAccountErrorMessages(): Record<string, string> {
  const messages: Record<string, string> = {};
  for (const provider of ACCOUNT_PROVIDERS) {
    const label = ACCOUNT_PROVIDER_LABELS[provider];
    messages[`invalid-${provider}-account`] = `${label} account nickname is invalid`;
    messages[`${provider}-account-unknown`] = `${label} account is not configured on this machine`;
    messages[`${provider}-account-unsupported`] = `${label} account selection is unavailable on this machine`;
    messages[`${provider}-account-agent-conflict`] = `${label} account selection requires a ${label} session`;
    messages[`${provider}-account-provider-resume-conflict`] =
      `${label} account selection cannot be combined with provider resume`;
    messages[`${provider}-account-session-incarnation-conflict`] = "session changed; refresh before switching accounts";
  }
  return messages;
}

const SAFE_DAEMON_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "display-revision-conflict": "Session display metadata changed; refresh and retry.",
  "title-mode-pinned": "Automatic retitle is disabled for this session.",
  "invalid-json-body": "The request body is invalid.",
  ...sharedAccountErrorMessages(),
  "invalid-agent": "agent is invalid",
  "missing-cwd": "working directory is required",
  "cwd-unavailable": "working directory is unavailable",
  "cwd-not-directory": "working directory is not a directory",
  "invalid-session-id": "session id is invalid",
  "session-exists": "session already exists",
  "invalid-provider-resume-id": "provider resume id is invalid",
  "provider-resume-not-found": "provider resume session was not found",
  "provider-resume-ambiguous": "provider resume session is ambiguous",
  "provider-resume-agent-args-conflict": "provider resume cannot be combined with agent arguments",
  "provider-resume-cwd-conflict": "provider resume cannot be combined with a working directory",
  "provider-resume-prompt-conflict": "provider resume cannot be combined with an initial prompt",
  "provider-session-unavailable": "this session has no provider history identity to archive",
  "session-has-live-children": "this session still has child sessions; close them before archiving or deleting it",
  "session-incarnation-conflict": "session changed; refresh before archiving",
  "history-archive-write-failed": "session history metadata could not be stored",
  "history-session-not-found": "session history was not found; refresh History and try again",
  "history-resume-not-supported": "this history session cannot be resumed",
  "history-resume-identity-mismatch": "session history identity changed; refresh History and try again",
  "history-resume-profile-unavailable": "history resume profile is unavailable; refresh History and try again",
  "dsh-history-unavailable": "DSH history is unavailable; refresh History and try again",
  "provider-session-already-running": "this provider session is already running",
  "history-session-live": "this conversation is already open; switching to its live session",
  "history-read-failed": "session history could not be read; refresh History and try again",
  "reserved-agent-arg": "agent arguments contain a reserved option",
  "unsupported-run-agent": "agent is not supported",
  "unknown-agent-profile": "agent launch profile is unknown",
  "agent-profile-agent-conflict": "agent launch profile does not match the requested agent",
  "agent-profile-unavailable": "agent launch profile is unavailable",
  "agent-profile-metadata-unavailable": "agent launch profile resume metadata is unavailable",
  "agent-profile-context-mismatch": "agent launch profile resume context changed",
  // A Codex switch applies live, between turns, to the running app-server.
  "codex-account-session-busy": "wait for the current Codex turn to finish before switching accounts",
  "codex-account-binding-superseded": "a newer Codex account switch replaced this request",
  "codex-account-not-bound": "the selected Codex account is not ready",
  "codex-account-runtime-changed": "session runtime changed; refresh before switching accounts",
  // A Claude launch profile owns its configuration directory, and a Claude
  // switch prepares that directory before it restarts the session.
  "claude-account-profile-conflict": "Claude account selection cannot be combined with a launch profile",
  "claude-account-switch-refused": "the new Claude account could not be prepared; the running session was left unchanged",
  "claude-account-dir-unsafe": "the Claude account directory failed its safety check",
  "codex-app-server-capability-unavailable": "Installed Codex does not support account selection; update Codex or use the default account",
  "session-termination-failed": "the recorded session runtime could not be stopped safely; inspect Maintenance before retrying",
};

function safeDaemonError(codeValue: unknown, fallback: string, reasonValue?: unknown): { code?: string; message: string } {
  const code = safeErrorCode(codeValue);
  const reason = safeErrorCode(reasonValue);
  const terminationMessage = reason === "session-still-running" || reason === "process-still-running"
    ? "the recorded session runtime is still live; retry, or resolve the runtime from Maintenance"
    : reason === "verification-failed"
      ? "the recorded session runtime could not be verified; inspect Maintenance before retrying"
      : reason === "runtime-identity-mismatch" || reason === "runtime-identity-changed"
        ? "the recorded session runtime identity changed; refresh Maintenance before retrying"
        : undefined;
  const message = code === "session-termination-failed" && terminationMessage
    ? terminationMessage
    : code === undefined ? undefined : SAFE_DAEMON_ERROR_MESSAGES[code];
  if (message !== undefined) return { code, message };
  if (code === undefined) return { message: fallback };
  // A well-formed code without a safe message still names the cause; the
  // daemon's message and details stay private. Log the slugs so the edge
  // operator can diagnose it (#712).
  console.warn(`edge: daemon error without a safe message (${fallback}): code=${code} reason=${reason ?? "none"}`);
  return { code, message: fallback };
}

function projectCreatedSession(session: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof session.id !== "string" || typeof session.agent !== "string") return null;
  const projected: Record<string, unknown> = { id: session.id, agent: session.agent };
  if (Object.hasOwn(session, "workspace")) projected.workspace = normalizeSessionWorkspace(session.workspace);
  const origin = normalizeSessionOrigin(session.origin);
  if (origin) projected.origin = origin;
  const agentProfile = normalizeAgentLaunchProfileId(session.agent_profile);
  if (agentProfile) projected.agent_profile = agentProfile;
  for (const field of [
    "mode", "cwd", "status", "session_incarnation", "created_at", "updated_at",
    "last_terminal_activity_at", "runtime_started_at", "attach_command", "ssh_attach_command",
  ] as const) {
    if (typeof session[field] === "string") projected[field] = session[field];
  }
  for (const field of ["title", "repo_name"] as const) {
    if (typeof session[field] === "string" || session[field] === null) projected[field] = session[field];
  }
  if (typeof session.title_revision === "number" && Number.isSafeInteger(session.title_revision)) {
    projected.title_revision = session.title_revision;
  }
  if (session.title_mode === "auto" || session.title_mode === "pinned") projected.title_mode = session.title_mode;
  if (Number.isSafeInteger(session.display_revision) && Number(session.display_revision) >= 0) {
    projected.display_revision = session.display_revision;
  }
  const titleState = normalizeSessionTitleState(session.title_state);
  if (titleState) projected.title_state = titleState;
  if (session.title_state_supported === true) projected.title_state_supported = true;
  if (typeof session.resumable === "boolean") projected.resumable = session.resumable;
  const providerResume = projectProviderResume(session.provider_resume);
  if (providerResume) projected.provider_resume = providerResume;
  const autoResume = normalizeAutoResumeStatus(session.auto_resume);
  if (autoResume) projected.auto_resume = autoResume;
  if (Object.hasOwn(session, "startup")) {
    projected.startup = normalizeStartupStatus(session.startup);
  }
  return projected;
}

function projectProviderResume(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of ["provider", "session_id", "captured_at", "capture_method"] as const) {
    if (typeof raw[field] === "string") projected[field] = raw[field];
  }
  if (Array.isArray(raw.resume_args) && raw.resume_args.every((item) => typeof item === "string")) {
    projected.resume_args = raw.resume_args;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

export function forwardGlanceDaemon(res: ServerResponse, r: DaemonResult): void {
  forwardDaemon(res, { ...r, body: normalizeStartupProjection(r.body, "glance") });
}

function normalizeStartupProjection(body: unknown, projectionKey: "session" | "glance"): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const envelope = body as Record<string, unknown>;
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return body;
  const projection = (data as Record<string, unknown>)[projectionKey];
  if (!projection || typeof projection !== "object" || Array.isArray(projection) || !Object.hasOwn(projection, "startup")) {
    return body;
  }
  return {
    ...envelope,
    data: {
      ...data,
      [projectionKey]: {
        ...projection,
        startup: normalizeStartupStatus((projection as Record<string, unknown>).startup),
      },
    },
  };
}

function providerResumeIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const body = value as { provider_resume_id?: unknown; resume_id?: unknown };
  const id = body.provider_resume_id ?? body.resume_id;
  return typeof id === "string" ? id.trim() : undefined;
}

function confirmsProviderResume(body: unknown, providerResumeId: string): boolean {
  const response = body as { ok?: boolean; data?: { session?: { provider_resume?: { session_id?: unknown } } } } | undefined;
  if (response?.ok === false) {
    return true;
  }
  return response?.data?.session?.provider_resume?.session_id === providerResumeId;
}
