import {
  classifyDebugEvent,
  isLayoutRevisionConflict,
  normalizeDebugErrorEnvelope,
  normalizeDebugLifecycleMetadata,
  type DebugEvent,
  type DebugEventSource,
} from "@agent-console/shared/api";
import { resolveLocalStorage, safeGetItem, safeRemoveItem, safeSetItem } from "./storage.ts";

export type DebugEventInput = Partial<Omit<DebugEvent, "seq" | "at">> & {
  readonly source: DebugEventSource;
  readonly route: string;
  /** The raw `{ok:false,error}` envelope. Only its bounded decision fields are
   * projected into the ring; the body itself is never retained. */
  readonly errorEnvelope?: unknown;
};

// Traffic is routine successful polling: it is worth a short, wide window so
// "what was the console doing just now" stays answerable. Signal is a failure
// or a lifecycle outcome: it is worth a long window, because a failure is
// usually reported well after it happened. Two rings rather than one, so the
// first population can never evict the second.
const MAX_DEBUG_TRAFFIC_EVENTS = 1000;
const MAX_DEBUG_SIGNAL_EVENTS = 500;
export const DEBUG_TRAFFIC_TTL_MS = 30 * 60 * 1000;
export const DEBUG_SIGNAL_TTL_MS = 12 * 60 * 60 * 1000;

export const DEBUG_EVENTS_STORAGE_KEY = "agent-console:debug-events:v1";

// Every write replaces the whole payload, and a storage engine may keep each
// replacement in a log it does not reclaim while the page runs. Writes are
// therefore bounded in bytes, not only in rows: traffic is saved only when the
// page hides or goes away, and signal at most once per interval. A signal row
// recorded inside the interval is deferred until the next debug event or page
// hide; no timer flushes it. An abrupt crash can lose traffic and deferred signal.
const DEBUG_SIGNAL_PERSIST_INTERVAL_MS = 2 * 60 * 1000;

let seq = 0;
let traffic: DebugEvent[] = [];
let signal: DebugEvent[] = [];
let pendingFlush: ReturnType<typeof setTimeout> | null = null;
let unsavedTraffic = false;
let unsavedSignal = false;
let lastSignalPersistAt = Number.NEGATIVE_INFINITY;
const subscribers = new Set<(events: readonly DebugEvent[]) => void>();

export function createDebugRequestId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `acreq_${Date.now().toString(36)}_${random}`;
}

export function redactDebugPath(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  let pathname = text;
  try {
    pathname = new URL(text, "http://agent-console.local").pathname;
  } catch {
    pathname = text.split("?")[0] ?? text;
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "/";

  if (parts[0] === "api" && parts[1] === "sessions") {
    if (parts.length === 2) return "/api/sessions";
    if (parts.length === 3) return "/api/sessions/:machine";
    return `/api/sessions/:machine/:id${parts.length > 4 ? `/${parts.slice(4).join("/")}` : ""}`;
  }
  if (parts[0] === "api" && parts[1] === "machines" && parts.length >= 3) {
    return `/api/machines/:machine${parts.length > 3 ? `/${parts.slice(3).join("/")}` : ""}`;
  }
  if (parts[0] === "sessions" && parts.length >= 2) {
    return `/sessions/:id${parts.length > 2 ? `/${parts.slice(2).join("/")}` : ""}`;
  }
  return `/${parts.join("/")}`;
}

function metadataFromPath(raw: string): Pick<DebugEvent, "machine" | "session_id"> {
  let pathname = raw;
  try {
    pathname = new URL(raw, "http://agent-console.local").pathname;
  } catch {
    pathname = raw.split("?")[0] ?? raw;
  }
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "sessions") {
    return {
      machine: parts[2] ?? null,
      session_id: parts[3] ?? null,
    };
  }
  if (parts[0] === "api" && parts[1] === "machines") {
    return { machine: parts[2] ?? null, session_id: null };
  }
  if (parts[0] === "sessions") {
    return { machine: null, session_id: parts[1] ?? null };
  }
  return { machine: null, session_id: null };
}

export function sanitizeDebugText(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "[redacted-auth]")
    .replace(/\b(authorization|token|password|secret|api[_-]?key)=\S+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-key]")
    .slice(0, 240);
}

export function recordDebugEvent(input: DebugEventInput): DebugEvent {
  const metadata = metadataFromPath(input.route);
  const event: DebugEvent = {
    seq: ++seq,
    at: new Date().toISOString(),
    source: input.source,
    request_id: sanitizeDebugText(input.request_id) ?? null,
    method: input.method?.toUpperCase() ?? null,
    route: redactDebugPath(input.route),
    status: input.status ?? null,
    ok: isLayoutRevisionConflict(input) ? true : input.ok ?? null,
    duration_ms: input.duration_ms === undefined || input.duration_ms === null
      ? null
      : Math.max(0, Math.round(input.duration_ms)),
    machine: input.machine ?? metadata.machine,
    session_id: input.session_id ?? metadata.session_id,
    error: sanitizeDebugText(input.error),
    ...normalizeDebugLifecycleMetadata(input),
    ...normalizeDebugErrorEnvelope(input.errorEnvelope),
  };
  appendEvent(event);
  if (classifyDebugEvent(event) === "signal") {
    unsavedSignal = true;
  } else {
    unsavedTraffic = true;
  }
  scheduleDebugEventFlush();
  return event;
}

function appendEvent(event: DebugEvent): void {
  if (classifyDebugEvent(event) === "signal") {
    signal = pruneExpiredEvents([...signal, event], DEBUG_SIGNAL_TTL_MS).slice(-MAX_DEBUG_SIGNAL_EVENTS);
    return;
  }
  traffic = pruneExpiredEvents([...traffic, event], DEBUG_TRAFFIC_TTL_MS).slice(-MAX_DEBUG_TRAFFIC_EVENTS);
}

export function debugEvents(): readonly DebugEvent[] {
  const prunedTraffic = pruneExpiredEvents(traffic, DEBUG_TRAFFIC_TTL_MS);
  const prunedSignal = pruneExpiredEvents(signal, DEBUG_SIGNAL_TTL_MS);
  traffic = prunedTraffic;
  signal = prunedSignal;
  return [...traffic, ...signal].sort((a, b) => a.seq - b.seq);
}

export const DEBUG_SIGNAL_CAPACITY = MAX_DEBUG_SIGNAL_EVENTS;
export const DEBUG_TRAFFIC_CAPACITY = MAX_DEBUG_TRAFFIC_EVENTS;

export function clearDebugEvents(): void {
  if (pendingFlush !== null) {
    clearTimeout(pendingFlush);
    pendingFlush = null;
  }
  traffic = [];
  signal = [];
  unsavedTraffic = false;
  unsavedSignal = false;
  lastSignalPersistAt = Number.NEGATIVE_INFINITY;
  removePersistedDebugEvents();
  notifySubscribers();
}

export function subscribeDebugEvents(callback: (events: readonly DebugEvent[]) => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function debugEventsMarkdown(snapshot: readonly DebugEvent[] = debugEvents()): string {
  const lines = ["# Agent Console Debug Events", ""];
  for (const event of snapshot) {
    const status = event.status === null ? "-" : String(event.status);
    const ok = event.ok === null ? "-" : event.ok ? "ok" : "fail";
    const duration = event.duration_ms === null ? "-" : `${event.duration_ms}ms`;
    const request = event.request_id ? ` request=${event.request_id}` : "";
    const machine = event.machine ? ` machine=${event.machine}` : "";
    const session = event.session_id ? ` session=${event.session_id}` : "";
    const error = event.error ? ` error=${event.error}` : "";
    const lifecycle = debugLifecycleSuffix(event);
    lines.push(
      `- ${event.at} ${event.source} ${event.method ?? "-"} ${event.route} status=${status} ${ok} duration=${duration}${request}${machine}${session}${lifecycle}${error}`,
    );
  }
  return lines.join("\n");
}

export function hydrateDebugEventsFromStorage(): void {
  traffic = [];
  signal = [];
  for (const event of loadPersistedDebugEvents()) {
    appendEvent(event);
  }
  seq = [...traffic, ...signal].reduce((max, event) => Math.max(max, event.seq), 0);
  persistDebugEvents();
  notifySubscribers();
}

function scheduleDebugEventFlush(): void {
  if (pendingFlush !== null) return;
  pendingFlush = setTimeout(() => {
    pendingFlush = null;
    if (unsavedSignal && Date.now() - lastSignalPersistAt >= DEBUG_SIGNAL_PERSIST_INTERVAL_MS) {
      persistSignalEvents();
    }
    notifySubscribers();
  }, 0);
}

export function flushDebugEvents(): void {
  if (unsavedTraffic || unsavedSignal) persistDebugEvents();
  if (pendingFlush === null) return;
  clearTimeout(pendingFlush);
  pendingFlush = null;
  notifySubscribers();
}

function notifySubscribers(): void {
  const snapshot = debugEvents();
  for (const callback of subscribers) {
    callback(snapshot);
  }
}

function loadPersistedDebugEvents(): DebugEvent[] {
  const raw = safeGetItem(resolveLocalStorage(), DEBUG_EVENTS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => normalizePersistedEvent(entry));
  } catch {
    return [];
  }
}

function normalizePersistedEvent(entry: unknown): DebugEvent[] {
  if (!entry || typeof entry !== "object") return [];
  const value = entry as Partial<DebugEvent>;
  const eventSeq = value.seq;
  const eventAt = value.at;
  const eventSource = value.source;
  const eventRoute = value.route;
  if (
    typeof eventSeq !== "number" ||
    !Number.isSafeInteger(eventSeq) ||
    typeof eventAt !== "string" ||
    !isDebugSource(eventSource) ||
    typeof eventRoute !== "string"
  ) {
    return [];
  }
  return [
    {
      seq: eventSeq,
      at: eventAt,
      source: eventSource,
      request_id: typeof value.request_id === "string" ? sanitizeDebugText(value.request_id) : null,
      method: typeof value.method === "string" ? value.method.toUpperCase() : null,
      route: redactDebugPath(eventRoute),
      status: typeof value.status === "number" ? value.status : null,
      ok: typeof value.ok === "boolean" ? value.ok : null,
      duration_ms: typeof value.duration_ms === "number" ? Math.max(0, Math.round(value.duration_ms)) : null,
      machine: typeof value.machine === "string" ? sanitizeDebugText(value.machine) : null,
      session_id: typeof value.session_id === "string" ? sanitizeDebugText(value.session_id) : null,
      error: sanitizeDebugText(value.error),
      ...normalizeDebugLifecycleMetadata(value),
      ...persistedFailureEnvelope(value),
    },
  ];
}

function persistedFailureEnvelope(value: Partial<DebugEvent>): Partial<DebugEvent> {
  return normalizeDebugErrorEnvelope({
    ok: false,
    error: {
      code: value.code,
      details: {
        ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
        next_action: value.next_action,
        recovery: {
          strategy: value.recovery_strategy,
          ...(typeof value.recovery_safe_to_retry === "boolean"
            ? { safe_to_retry: value.recovery_safe_to_retry }
            : {}),
        },
      },
    },
  });
}

function isDebugSource(value: unknown): value is DebugEventSource {
  return value === "client" || value === "edge" || value === "daemon" || value === "ws";
}

// Every token here comes from a bounded producer-owned vocabulary, so the
// exported line stays safe to paste into an agent conversation.
const DEBUG_DETAIL_FIELDS = [
  "operation",
  "phase",
  "outcome",
  "provenance",
  "attempt_id",
  "attempt",
  "code",
  "retryable",
  "next_action",
  "recovery_strategy",
  "recovery_safe_to_retry",
  "failure_class",
  "failure_stage",
  "provider_kind",
  "duration_bucket",
] as const satisfies readonly (keyof DebugEvent)[];

export function debugLifecycleSuffix(event: DebugEvent): string {
  return DEBUG_DETAIL_FIELDS.map((field) => {
    const value = event[field];
    return value === undefined || value === null || value === "" ? "" : ` ${field}=${value}`;
  }).join("");
}

function pruneExpiredEvents(snapshot: readonly DebugEvent[], ttlMs: number): DebugEvent[] {
  const cutoff = Date.now() - ttlMs;
  return snapshot.filter((event) => {
    const at = Date.parse(event.at);
    return Number.isFinite(at) && at >= cutoff;
  });
}

function persistDebugEvents(): void {
  unsavedTraffic = false;
  unsavedSignal = false;
  safeSetItem(resolveLocalStorage(), DEBUG_EVENTS_STORAGE_KEY, JSON.stringify(debugEventsSnapshot()));
}

function persistSignalEvents(): void {
  unsavedTraffic = traffic.length > 0;
  unsavedSignal = false;
  lastSignalPersistAt = Date.now();
  safeSetItem(resolveLocalStorage(), DEBUG_EVENTS_STORAGE_KEY, JSON.stringify(signal));
}

function debugEventsSnapshot(): readonly DebugEvent[] {
  return [...traffic, ...signal].sort((a, b) => a.seq - b.seq);
}

function removePersistedDebugEvents(): void {
  safeRemoveItem(resolveLocalStorage(), DEBUG_EVENTS_STORAGE_KEY);
}

hydrateDebugEventsFromStorage();
globalThis.addEventListener?.("pagehide", flushDebugEvents);
globalThis.addEventListener?.("visibilitychange", flushDebugEvents);
