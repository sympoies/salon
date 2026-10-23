import {
  classifyDebugEvent,
  normalizeDebugErrorEnvelope,
  normalizeDebugLifecycleMetadata,
  type DebugEvent,
  type DebugEventSource,
} from "@agent-console/shared/api";

export interface DebugEventInput {
  readonly source: DebugEventSource;
  readonly request_id?: string | null;
  readonly method?: string | null;
  readonly route: string;
  readonly status?: number | null;
  readonly ok?: boolean | null;
  readonly duration_ms?: number | null;
  readonly machine?: string | null;
  readonly session_id?: string | null;
  readonly error?: string | null;
  readonly operation?: string | null;
  readonly phase?: string | null;
  readonly outcome?: string | null;
  readonly provenance?: string | null;
  readonly attempt_id?: string | null;
  readonly attempt?: number | null;
  readonly failure_class?: string | null;
  readonly failure_stage?: string | null;
  readonly provider_kind?: string | null;
  readonly duration_bucket?: string | null;
  /** The `{ok:false,error}` envelope this response sent. Only its bounded
   * decision fields are projected; the body is never retained. */
  readonly errorEnvelope?: unknown;
}

// The edge ring is shared across every principal and every machine, so a
// single population makes the look-back for a failure a few minutes under
// routine polling. Failures and lifecycle outcomes get their own ring with
// their own capacity, so successful polls cannot evict them.
export class DebugEventBuffer {
  readonly maxEvents: number;
  readonly maxSignalEvents: number;
  #seq = 0;
  #events: DebugEvent[] = [];
  #signal: DebugEvent[] = [];

  constructor(maxEvents = 1000, maxSignalEvents = 500) {
    this.maxEvents = maxEvents;
    this.maxSignalEvents = maxSignalEvents;
  }

  record = (input: DebugEventInput): DebugEvent => {
    const metadata = metadataFromPath(input.route);
    const event: DebugEvent = {
      seq: ++this.#seq,
      at: new Date().toISOString(),
      source: input.source,
      request_id: sanitizeDebugText(input.request_id) ?? null,
      method: input.method?.toUpperCase() ?? null,
      route: redactDebugPath(input.route),
      status: input.status ?? null,
      ok: input.ok ?? null,
      duration_ms: input.duration_ms === undefined || input.duration_ms === null
        ? null
        : Math.max(0, Math.round(input.duration_ms)),
      machine: input.machine ?? metadata.machine,
      session_id: input.session_id ?? metadata.session_id,
      error: sanitizeDebugText(input.error),
      ...normalizeDebugLifecycleMetadata(input),
      ...normalizeDebugErrorEnvelope(input.errorEnvelope),
    };
    if (classifyDebugEvent(event) === "signal") {
      this.#signal = [...this.#signal, event].slice(-this.maxSignalEvents);
    } else {
      this.#events = [...this.#events, event].slice(-this.maxEvents);
    }
    return event;
  };

  snapshot(): readonly DebugEvent[] {
    return [...this.#events, ...this.#signal].sort((a, b) => a.seq - b.seq);
  }
}

export function createDebugRequestId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `acreq_${Date.now().toString(36)}_${random}`;
}

export function requestIdFromHeader(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && /^acreq_[A-Za-z0-9_-]{6,80}$/.test(value)) {
    return value;
  }
  return createDebugRequestId();
}

export function isDebugRoute(path: string): boolean {
  return path === "/api/debug/events" || path === "/api/debug/bundle";
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
