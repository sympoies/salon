import { once } from "node:events";
import { request as requestHttp, type IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import type { MachineConfig } from "./config.ts";
import type { DebugEventInput } from "./debugEvents.ts";
import { authedFetch, type LimitedRequestBody } from "./http.ts";
import type { MachineHealth } from "./machineHealth.ts";
import {
  normalizeAgentLaunchProfiles,
  normalizeAgentSessionCapabilities,
  normalizeResumeBlockedReason,
  projectPublicAgentSession,
  type MachineStatus,
} from "@agent-console/shared/api";

// Thin client for a machine's `agent-session serve` daemon. The edge injects the
// per-machine bearer token here; the browser never sees it.
export interface DaemonResult {
  readonly status: number;
  readonly body: unknown;
}

const DEFAULT_DAEMON_TIMEOUT_MS = 10_000;
// The session-list poll runs on a short interval and fans out to every machine
// at once, so it uses a tighter deadline than one-shot control calls: a sleeping
// spoke should trip its breaker fast, not hold the whole poll for 10s.
const LIST_PROBE_TIMEOUT_MS = 3_000;

export interface DaemonDebugContext {
  readonly requestId: string;
  readonly record: (event: DebugEventInput) => void;
}

interface DaemonFetchOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly bodyStream?: LimitedRequestBody;
  readonly contentType?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly debug?: DaemonDebugContext;
}

function durationMs(started: number): number {
  return performance.now() - started;
}

function parseDaemonText(status: number, text: string): DaemonResult {
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { ok: false, error: { message: "non-JSON response from daemon" } };
    }
  }
  return { status, body: parsed };
}

async function parseDaemonResponse(res: Response): Promise<DaemonResult> {
  return parseDaemonText(res.status, await res.text());
}

async function parseStreamingDaemonResponse(res: IncomingMessage): Promise<DaemonResult> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return parseDaemonText(res.statusCode ?? 502, Buffer.concat(chunks).toString("utf8"));
}

async function streamDaemonRequest(
  url: string,
  token: string,
  method: string,
  contentType: string | undefined,
  upload: LimitedRequestBody,
  timeoutMs: number,
): Promise<DaemonResult> {
  return await new Promise<DaemonResult>((resolve, reject) => {
    const target = new URL(url);
    const request = target.protocol === "https:" ? requestHttps : requestHttp;
    let responseStarted = false;
    let settled = false;
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (contentType) headers["content-type"] = contentType;
    const outgoing = request(target, { method, headers }, (response) => {
      responseStarted = true;
      upload.cancel();
      if (!outgoing.writableEnded) outgoing.end();
      void parseStreamingDaemonResponse(response).then(resolveOnce, rejectOnce);
    });
    const cleanup = (): void => {
      clearTimeout(timer);
      upload.signal.removeEventListener("abort", onUploadAbort);
    };
    const resolveOnce = (result: DaemonResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      upload.cancel();
      cleanup();
      reject(error);
    };
    const onUploadAbort = (): void => {
      const reason = upload.signal.reason;
      outgoing.destroy(reason instanceof Error ? reason : new Error("attachment upload aborted"));
    };
    const timer = setTimeout(() => outgoing.destroy(new Error("daemon request timed out")), timeoutMs);
    timer.unref();
    outgoing.once("error", (error) => {
      if (!responseStarted) rejectOnce(error);
    });
    if (upload.signal.aborted) onUploadAbort();
    else upload.signal.addEventListener("abort", onUploadAbort, { once: true });

    void (async () => {
      try {
        for await (const chunk of upload.body) {
          if (responseStarted) break;
          if (!outgoing.write(chunk)) await once(outgoing, "drain");
        }
        if (!responseStarted && !outgoing.writableEnded) outgoing.end();
      } catch (error) {
        if (!responseStarted) outgoing.destroy(error as Error);
      }
    })();
  });
}

export async function daemonFetch(
  machine: MachineConfig,
  path: string,
  init?: DaemonFetchOptions,
): Promise<DaemonResult> {
  let body: string | Buffer | undefined;
  let contentType = init?.contentType;
  if (init?.body !== undefined) {
    if (Buffer.isBuffer(init.body)) {
      body = init.body;
    } else {
      contentType = "application/json";
      body = JSON.stringify(init.body);
    }
  }
  const started = performance.now();
  const method = init?.method ?? "GET";
  try {
    const result = init?.bodyStream
      ? await streamDaemonRequest(
          `${machine.url}${path}`,
          machine.token,
          method,
          contentType,
          init.bodyStream,
          init.timeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS,
        )
      : await authedFetch(
          `${machine.url}${path}`,
          parseDaemonResponse,
          {
            token: machine.token,
            timeoutMs: init?.timeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS,
            signal: init?.signal,
            contentType,
            body,
            method,
          },
        );
    init?.debug?.record({
      source: "daemon",
      request_id: init.debug.requestId,
      method,
      route: path,
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      duration_ms: durationMs(started),
      machine: machine.name,
    });
    return result;
  } catch (err) {
    init?.debug?.record({
      source: "daemon",
      request_id: init.debug.requestId,
      method,
      route: path,
      status: null,
      ok: false,
      duration_ms: durationMs(started),
      machine: machine.name,
      error: (err as Error).message,
    });
    throw err;
  }
}

function dataOf(body: unknown): Record<string, unknown> | undefined {
  if (body && typeof body === "object" && "data" in body) {
    const d = (body as { data: unknown }).data;
    if (d && typeof d === "object") {
      return d as Record<string, unknown>;
    }
  }
  return undefined;
}

export interface AggregatedSessions {
  readonly sessions: Array<Record<string, unknown>>;
  readonly machines: MachineStatus[];
}

function observedAt(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 || day < 1 || day > (daysInMonth[month - 1] ?? 0) ||
    Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
    Number(offsetHourText ?? 0) > 23 || Number(offsetMinuteText ?? 0) > 59
  ) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

export async function machineAdvertisesAgentLaunchProfile(
  machine: MachineConfig,
  id: string,
  agent: string,
  requireProviderResumeImport = false,
  debug?: DaemonDebugContext,
): Promise<boolean> {
  const res = await daemonFetch(machine, "/sessions", {
    timeoutMs: LIST_PROBE_TIMEOUT_MS,
    debug,
  });
  if (res.status !== 200) return false;
  const data = dataOf(res.body);
  const profiles = normalizeAgentLaunchProfiles(data?.agent_profiles);
  const capabilities = normalizeAgentSessionCapabilities(data?.capabilities);
  return profiles.some((profile) => (
    profile.id === id
    && profile.agent === agent
    && (
      !requireProviderResumeImport
      || (
        capabilities.profile_resume_import === true
        && profile.provider_resume_import_supported === true
      )
    )
  ));
}

// Fan list out to every configured machine, tag each session with its machine,
// and never let one machine being down fail the whole view (Task 3.1: keep the
// multi-machine shape from the start).
//
// When a `health` breaker is supplied, a machine that recently failed to answer
// is skipped without a network round-trip until its cooldown elapses, so a
// sleeping/moved laptop spoke never stalls the shared poll. Only a failure that
// stalled the probe trips the breaker; a fast one (a restarting daemon refusing
// the connection) leaves the machine probed, and a reachable response (including
// a fast non-200) clears it so the machine surfaces its real status.
export async function aggregateSessions(
  machines: readonly MachineConfig[],
  health?: MachineHealth,
  debug?: DaemonDebugContext,
  signal?: AbortSignal,
): Promise<AggregatedSessions> {
  const results = await Promise.all(
    machines.map(async (m): Promise<{ status: MachineStatus; sessions: Array<Record<string, unknown>> }> => {
      if (m.active === false) return { status: { name: m.name, ok: false, active: false }, sessions: [] };
      if (health && !health.shouldProbe(m.name)) {
        return {
          status: { name: m.name, ok: false, error: "offline (cooling down after a failed probe)" },
          sessions: [],
        };
      }
      const probeStartedAt = health?.now() ?? 0;
      try {
        const res = await daemonFetch(m, "/sessions", { timeoutMs: LIST_PROBE_TIMEOUT_MS, debug, signal });
        const data = dataOf(res.body);
        const list = Array.isArray(data?.sessions) ? (data.sessions as Array<Record<string, unknown>>) : [];
        const observation = observedAt(data?.observed_at);
        const agentProfiles = normalizeAgentLaunchProfiles(data?.agent_profiles);
        const capabilities = normalizeAgentSessionCapabilities(data?.capabilities);
        // Reachable (the daemon answered), so the breaker resets even on a
        // non-200 — that error is fast and informative, not a stall.
        health?.recordSuccess(m.name);
        if (res.status !== 200) {
          return { status: { name: m.name, ok: false, error: `daemon status ${res.status}` }, sessions: [] };
        }
        return {
          status: {
            name: m.name,
            ok: true,
            ...(observation ? { observed_at: observation } : {}),
            ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
            ...(agentProfiles.length > 0 ? { agent_profiles: agentProfiles } : {}),
          },
          sessions: list.map((s) => {
            const session = projectPublicAgentSession(s);
            if (session.title_state_supported !== true) {
              delete session.title_state_supported;
            }
            const resumeBlockedReason = capabilities.resume_blocked_reason === true
              ? normalizeResumeBlockedReason(session.resume_blocked_reason)
              : undefined;
            delete session.resume_blocked_reason;
            return {
              ...session,
              ...(resumeBlockedReason ? { resume_blocked_reason: resumeBlockedReason } : {}),
              machine: m.name,
              ...(observation ? { activity_observed_at: observation } : {}),
            };
          }),
        };
      } catch (err) {
        // Connection/timeout failure: a stalled probe opens the breaker so the
        // next polls fast-fail this machine instead of each waiting out the
        // deadline. A fast failure does not, so the machine is not locked out
        // for the cooldown after it is already back.
        if (health && !signal?.aborted) health.recordFailure(m.name, health.now() - probeStartedAt);
        return { status: { name: m.name, ok: false, error: (err as Error).message }, sessions: [] };
      }
    }),
  );
  return {
    sessions: results.flatMap((r) => r.sessions),
    machines: results.map((r) => r.status),
  };
}
