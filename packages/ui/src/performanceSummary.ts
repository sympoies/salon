import type { DebugClientInfo, DebugEvent } from "@agent-console/shared/api";
import { DEBUG_TRAFFIC_TTL_MS } from "./debugLog.ts";
import { resolveLocalStorage, safeGetItem, safeRemoveItem, safeSetItem, type StorageLike } from "./storage.ts";

export const PERFORMANCE_CAPTURE_STORAGE_KEY = "agent-console:performance-capture:v1";
export type PerformanceScenario = "normal" | "slow-network" | "offline-recovery";

export interface PerformanceCapture {
  readonly scenario: PerformanceScenario;
  readonly started_at: string;
}

interface HttpSummary {
  readonly requests: number;
  readonly attempts: number;
  readonly outstanding_attempts: number;
  readonly caller_deadline_timeouts: number;
  readonly caller_capacity_rejections: number;
  readonly failures: number;
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
  readonly requests_per_minute: number;
}

interface ListSummary extends HttpSummary {
  readonly automatic_requests: number;
  readonly fresh_requests: number;
  readonly unclassified_requests: number;
  readonly automatic_attempts: number;
  readonly fresh_attempts: number;
  readonly unclassified_attempts: number;
  readonly first_success_ms: number | null;
  readonly usable_list_ms: number | null;
  readonly max_overlapping_requests: number;
}

export interface PerformanceSummary {
  readonly kind: "agent-console.performance-summary.v1";
  readonly generated_at: string;
  readonly app: Pick<DebugClientInfo, "version" | "build_sha" | "surface">;
  readonly scenario: PerformanceScenario;
  readonly window: {
    readonly started_at: string;
    readonly ended_at: string;
    readonly duration_ms: number;
    readonly traffic_retention_ms: number;
  };
  readonly http: {
    readonly session_list: ListSummary;
    readonly attach_ticket: HttpSummary;
    readonly other_api: HttpSummary;
  };
  readonly websocket: {
    readonly connection_attempts: number;
    readonly reconnect_attempts: number;
    readonly disconnects: number;
    readonly failure_events: number;
    readonly recovered_panes: number;
    readonly unresolved_disconnects: number;
    readonly recovery_p50_ms: number | null;
    readonly recovery_p95_ms: number | null;
  };
  readonly limitations: readonly string[];
}

function isScenario(value: unknown): value is PerformanceScenario {
  return value === "normal" || value === "slow-network" || value === "offline-recovery";
}

export function startPerformanceCapture(
  scenario: PerformanceScenario,
  storage: StorageLike | null = resolveLocalStorage(),
  now = new Date().toISOString(),
): PerformanceCapture | null {
  const capture = { scenario, started_at: now };
  return safeSetItem(storage, PERFORMANCE_CAPTURE_STORAGE_KEY, JSON.stringify(capture)) ? capture : null;
}

export function loadPerformanceCapture(
  storage: StorageLike | null = resolveLocalStorage(),
  now = new Date().toISOString(),
): PerformanceCapture | null {
  const raw = safeGetItem(storage, PERFORMANCE_CAPTURE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PerformanceCapture>;
    const started = Date.parse(value.started_at ?? "");
    const elapsed = Date.parse(now) - started;
    if (isScenario(value.scenario) && Number.isFinite(elapsed) &&
      elapsed >= 0 && elapsed <= DEBUG_TRAFFIC_TTL_MS) {
      return { scenario: value.scenario, started_at: value.started_at! };
    }
  } catch {
    // Invalid local state has no authority to extend capture retention.
  }
  safeRemoveItem(storage, PERFORMANCE_CAPTURE_STORAGE_KEY);
  return null;
}

export function stopPerformanceCapture(storage: StorageLike | null = resolveLocalStorage()): void {
  safeRemoveItem(storage, PERFORMANCE_CAPTURE_STORAGE_KEY);
}

function percentile(values: readonly number[], percent: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * percent) - 1] ?? null;
}

function requestEvents(events: readonly DebugEvent[]): {
  completed: DebugEvent[]; starts: DebugEvent[]; outstanding: DebugEvent[]; attempts: DebugEvent[];
} {
  const starts = events.filter((event) => event.phase === "request_start");
  const completed = events.filter((event) => event.phase !== "request_start");
  const completedIds = new Set(completed.map((event) => event.request_id).filter(Boolean));
  const startedIds = new Set(starts.map((event) => event.request_id).filter(Boolean));
  return {
    completed, starts,
    outstanding: starts.filter((event) => !event.request_id || !completedIds.has(event.request_id)),
    attempts: [...starts, ...completed.filter((event) => !event.request_id || !startedIds.has(event.request_id))],
  };
}

function httpSummary(events: readonly DebugEvent[], durationMs: number, deadlineTimeouts = 0,
  capacityRejections = 0): HttpSummary {
  const requests = requestEvents(events);
  const durations = requests.completed.flatMap((event) => event.duration_ms === null ? [] : [event.duration_ms]);
  return {
    requests: requests.completed.length,
    attempts: requests.attempts.length,
    outstanding_attempts: requests.outstanding.length,
    caller_deadline_timeouts: deadlineTimeouts,
    caller_capacity_rejections: capacityRejections,
    failures: requests.completed.filter((event) => event.ok === false).length,
    p50_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    requests_per_minute: durationMs > 0 ? Math.round(requests.attempts.length * 6_000_000 / durationMs) / 100 : 0,
  };
}

function maxOverlap(events: readonly DebugEvent[], windowStart: number, windowEnd: number): number {
  const requests = requestEvents(events);
  const completedById = new Map(requests.completed.filter((event) => event.request_id)
    .map((event) => [event.request_id, event]));
  const intervals = requests.starts.map((event) => ({
    start: Date.parse(event.at),
    end: completedById.get(event.request_id)?.at
      ? Date.parse(completedById.get(event.request_id)!.at) : windowEnd,
  }));
  const inferred = requests.completed.filter((event) => !event.request_id ||
    !requests.starts.some((start) => start.request_id === event.request_id)).flatMap((event) => {
    const end = Date.parse(event.at);
    if (event.duration_ms === null || !Number.isFinite(end)) return [];
    return [{ start: Math.max(windowStart, end - event.duration_ms), end }];
  });
  intervals.push(...inferred);
  intervals.sort((a, b) => a.start - b.start);
  const endings: number[] = [];
  let maximum = 0;
  for (const interval of intervals) {
    for (let i = endings.length - 1; i >= 0; i -= 1) {
      if (endings[i]! <= interval.start) endings.splice(i, 1);
    }
    endings.push(interval.end);
    maximum = Math.max(maximum, endings.length);
  }
  return maximum;
}

export function createPerformanceSummary(input: {
  readonly capture: PerformanceCapture;
  readonly endedAt?: string;
  readonly app: DebugClientInfo;
  readonly events: readonly DebugEvent[];
}): PerformanceSummary {
  const endedAt = input.endedAt ?? new Date().toISOString();
  const startMs = Date.parse(input.capture.started_at);
  const endMs = Date.parse(endedAt);
  const durationMs = Math.max(0, endMs - startMs);
  const events = input.events.filter((event) => {
    const at = Date.parse(event.at);
    return Number.isFinite(at) && at >= startMs && at <= endMs;
  }).sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
  const client = events.filter((event) => event.source === "client" && event.route.startsWith("/api/"));
  const list = client.filter((event) => event.method === "GET" && event.route === "/api/sessions");
  const tickets = client.filter((event) => event.method === "POST" &&
    event.route.startsWith("/api/sessions/") && event.route.endsWith("/attach-ticket"));
  const others = client.filter((event) => !list.includes(event) && !tickets.includes(event));
  const completedList = requestEvents(list).completed;
  const attemptedList = requestEvents(list).attempts;
  const firstListSuccess = completedList.find((event) => event.ok === true);
  const usableList = events.find((event) => event.source === "client" &&
    event.route === "/performance/session-list" && event.phase === "usable");
  const deadlineCount = (route: string) => events.filter((event) => event.source === "client" &&
    event.route === route && event.phase === "deadline_timeout").length;
  const capacityCount = (route: string) => events.filter((event) => event.source === "client" &&
    event.route === route && event.phase === "capacity_rejected").length;
  const listSummary: ListSummary = {
    ...httpSummary(list, durationMs, deadlineCount("/performance/session-list"),
      capacityCount("/performance/session-list")),
    automatic_requests: completedList.filter((event) => event.provenance === "poll").length,
    fresh_requests: completedList.filter((event) => event.provenance === "fresh").length,
    unclassified_requests: completedList.filter((event) => event.provenance !== "poll" && event.provenance !== "fresh").length,
    automatic_attempts: attemptedList.filter((event) => event.provenance === "poll").length,
    fresh_attempts: attemptedList.filter((event) => event.provenance === "fresh").length,
    unclassified_attempts: attemptedList.filter((event) => event.provenance !== "poll" && event.provenance !== "fresh").length,
    first_success_ms: firstListSuccess ? Math.max(0, Date.parse(firstListSuccess.at) - startMs) : null,
    usable_list_ms: usableList ? Math.max(0, Date.parse(usableList.at) - startMs) : null,
    max_overlapping_requests: maxOverlap(list, startMs, endMs),
  };

  // Pane identifiers are used only in memory to correlate transitions. They
  // never enter the exported summary.
  const downSince = new Map<string, number>();
  const recoveredPanes = new Set<string>();
  const recoveryTimes: number[] = [];
  let connectionAttempts = 0;
  let reconnectAttempts = 0;
  let disconnects = 0;
  let failureEvents = 0;
  for (const event of events) {
    if (event.source !== "ws" || event.route !== "/api/sessions/:machine/:id/attach") continue;
    const key = event.machine && event.session_id ? `${event.machine}/${event.session_id}` : null;
    const at = Date.parse(event.at);
    if (event.ok === null) {
      connectionAttempts += 1;
      if (key && downSince.has(key)) reconnectAttempts += 1;
    } else if (event.ok === true) {
      if (key && downSince.has(key)) {
        recoveryTimes.push(Math.max(0, at - downSince.get(key)!));
        recoveredPanes.add(key);
        downSince.delete(key);
      }
    } else if (event.error === "closed") {
      disconnects += 1;
      if (key && !downSince.has(key)) downSince.set(key, at);
    } else if (event.ok === false) {
      failureEvents += 1;
    }
  }
  const version = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(input.app.version)
    ? input.app.version : "unknown";
  const buildSha = input.app.build_sha && /^[0-9a-f]{6,40}$/.test(input.app.build_sha)
    ? input.app.build_sha : null;
  return {
    kind: "agent-console.performance-summary.v1",
    generated_at: endedAt,
    app: { version, build_sha: buildSha, surface: input.app.surface },
    scenario: input.capture.scenario,
    window: {
      started_at: input.capture.started_at, ended_at: endedAt,
      duration_ms: durationMs, traffic_retention_ms: DEBUG_TRAFFIC_TTL_MS,
    },
    http: { session_list: listSummary,
      attach_ticket: httpSummary(tickets, durationMs, deadlineCount("/performance/attach-ticket"),
        capacityCount("/performance/attach-ticket")),
      other_api: httpSummary(others, durationMs) },
    websocket: {
      connection_attempts: connectionAttempts, reconnect_attempts: reconnectAttempts,
      disconnects, failure_events: failureEvents,
      recovered_panes: recoveredPanes.size, unresolved_disconnects: downSince.size,
      recovery_p50_ms: percentile(recoveryTimes, 0.5), recovery_p95_ms: percentile(recoveryTimes, 0.95),
    },
    limitations: [
      "HTTP requests and latency use completed rows; attempts and request rate include capture-time starts, including requests still outstanding. Caller deadlines and capacity rejections are separate; neither proves the native transport stopped.",
      "Usable list is the first successful list committed while the dashboard is visible after capture start; it does not prove every pane connected or became interactive.",
      "Fresh list reads include startup and reconciliation; they are not necessarily direct user actions.",
      "WebSocket recovery covers only transitions observed inside this capture window.",
      "WebSocket failure_events counts error events, including errors on already-open sockets; it is not a failed-connection count.",
      "An unresolved disconnect may belong to a pane that was later unmounted; this summary cannot prove mounted-pane state.",
      "The 1000-row traffic ring can evict events before its 30-minute TTL under heavy activity.",
    ],
  };
}
