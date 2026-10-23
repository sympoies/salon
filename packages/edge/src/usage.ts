// Client for a host-local usage endpoint. Provider-specific collection belongs
// to agent-session (or a compatible host reader); the edge only normalizes and
// proxies the endpoint's non-secret response.
import { withHostReaderJson, type HostReader } from "./hostReader.ts";
import { arrayProp, asFiniteNumber, asPercent, asString, objectProp } from "./normalize.ts";
import { normalizeClaudeLimitResets } from "./claudeReset.ts";
import {
  usageSwitchKey,
  type ProviderUsage,
  type ProviderUsageReason,
  type UsageWindow,
} from "@agent-console/shared/api";

export type { ProviderUsage, UsageWindow } from "@agent-console/shared/api";

// The usage snapshot is a tiny numbers-only JSON payload. Cap the body read so a
// buggy/compromised loopback reader can't OOM the shared edge process with an
// unbounded body (the abort timeout above bounds time; this bounds memory).
const MAX_RESPONSE_BYTES = 512 * 1024;
// The host helper's route; `agent-session serve` uses `/usage/v1` (configured
// through AGENT_CONSOLE_USAGE_PATH).
const DEFAULT_USAGE_PATH = "/usage";

const PROVIDER_USAGE_REASONS = new Set<ProviderUsageReason>([
  "auth_required",
  "auth_expired",
  "billing_past_due",
  "subscription_inactive",
  "organization_disabled",
  "permission_denied",
  "rate_limited",
  "service_unavailable",
  "timeout",
  "unknown",
]);

function providerReasonCode(value: unknown): ProviderUsageReason | null {
  const reason = asString(value);
  return reason && PROVIDER_USAGE_REASONS.has(reason as ProviderUsageReason)
    ? reason as ProviderUsageReason
    : null;
}

function providerError(value: unknown): string | null {
  return asString(value) ?? asString(objectProp(value)?.message);
}

function resetCredits(value: unknown): { readonly available_count: number } | null {
  const count = objectProp(value)?.available_count;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? { available_count: count }
    : null;
}

// Machine names the reader reports for a per-host Claude account entry. Bounded
// so a bad reader cannot amplify one entry into an unbounded chip row.
const MAX_HOSTS = 32;
const MAX_HOST_NAME_LENGTH = 64;

function hostList(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const hosts: string[] = [];
  if (!Array.isArray(value)) {
    return hosts; // present but malformed: treated as naming no host
  }
  for (const raw of value) {
    const host = asString(raw);
    if (host && host.length <= MAX_HOST_NAME_LENGTH && !hosts.includes(host)) {
      hosts.push(host);
    }
    if (hosts.length === MAX_HOSTS) break;
  }
  return hosts;
}

function normalizeWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const w = raw as Record<string, unknown>;
  const key = windowKey(w);
  if (!key) {
    return null; // a window with no stable key can't be rendered/keyed
  }
  const label = asString(w.label) ?? key;
  return {
    key,
    label,
    used_percent: asPercent(w.used_percent),
    window_minutes: asFiniteNumber(w.window_minutes) ?? asFiniteNumber(w.windowMinutes) ?? inferWindowMinutes(key, label),
    resets_at: resetEpochSeconds(w),
  };
}

function windowKey(window: Record<string, unknown>): string | null {
  const raw = asString(window.key) ?? asString(window.window) ?? asString(window.name) ?? asString(window.label);
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "weekly" || normalized === "week" || normalized === "1w") {
    return "weekly";
  }
  if (normalized === "5h" || normalized === "fivehour") {
    return "5h";
  }
  return raw;
}

function inferWindowMinutes(key: string, label: string): number | null {
  const normalized = `${key} ${label}`.toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized.includes("5h") || normalized.includes("fivehour")) {
    return 300;
  }
  if (normalized.includes("weekly") || normalized.includes("1w") || normalized.includes("week")) {
    return 10080;
  }
  return null;
}

function resetEpochSeconds(window: Record<string, unknown>): number | null {
  for (const key of [
    "resets_at",
    "resetsAt",
    "reset_at",
    "resetAt",
    "reset_at_epoch",
    "resetAtEpoch",
    "reset",
  ]) {
    const epoch = epochSecondsOrNull(window[key]);
    if (epoch !== null) {
      return epoch;
    }
  }
  return null;
}

function epochSecondsOrNull(value: unknown): number | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of [
      "resets_at",
      "resetsAt",
      "reset_at",
      "resetAt",
      "reset_at_epoch",
      "resetAtEpoch",
      "epoch",
      "epoch_seconds",
      "epochSeconds",
      "epoch_ms",
      "epochMs",
      "at",
      "time",
      "timestamp",
    ]) {
      const nested = epochSecondsOrNull((value as Record<string, unknown>)[key]);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  const finite = asFiniteNumber(value);
  if (finite !== null) {
    return normalizeEpochSeconds(finite);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return normalizeEpochSeconds(numeric);
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function normalizeEpochSeconds(epoch: number): number {
  return epoch > 1_000_000_000_000 ? Math.floor(epoch / 1000) : epoch;
}

function usagePayload(body: unknown): unknown {
  const root = objectProp(body);
  const dataUsage = objectProp(objectProp(root?.data)?.usage);
  if (dataUsage) {
    return dataUsage;
  }
  return objectProp(root?.usage) ?? body;
}

// Defensively normalize the reader's `{ providers: [...] }` payload into a stable,
// well-typed list. A malformed/partial reader response degrades to fewer fields
// (never throws), so the panel can't be crashed by a bad host response.
export function normalizeProviders(body: unknown): ProviderUsage[] {
  const list = arrayProp(usagePayload(body), "providers");
  const out: ProviderUsage[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const p = raw as Record<string, unknown>;
    const provider = asString(p.provider) ?? asString(p.id);
    if (!provider) {
      continue;
    }
    // Dedupe on the (provider, account, hosts) triple, not provider alone: codex
    // reports several entries all with provider:"codex", distinguished only by
    // account, and per-host Claude entries without a readable account differ
    // only by host. The NUL separator can't collide with a real string.
    const account = asString(p.account);
    const hosts = hostList(p.hosts);
    const key = usageSwitchKey({ provider, account });
    if (hosts?.length === 0) {
      continue; // claims to be per host but names none: it cannot be scoped, so fail closed
    }
    const dedupeKey = `${provider}\u0000${account ?? ""}\u0000${hosts?.join("\u0000") ?? ""}`;
    if (seen.has(dedupeKey)) {
      continue; // stable, unique React keys downstream: keep the first of any dupe
    }
    seen.add(dedupeKey);
    // Dedupe windows by key too — codex has many rollout files, so a reader bug
    // could emit the same window key twice; keep the first.
    const windows: UsageWindow[] = [];
    const seenKeys = new Set<string>();
    if (Array.isArray(p.windows)) {
      for (const rawWindow of p.windows) {
        const w = normalizeWindow(rawWindow);
        if (w && !seenKeys.has(w.key)) {
          seenKeys.add(w.key);
          windows.push(w);
        }
      }
    }
    out.push({
      provider,
      account,
      label: asString(p.label) ?? provider,
      ok: p.ok !== false, // absent -> ok:true; only an explicit false is "not ok"
      stale: p.stale === true,
      plan: asString(p.plan),
      windows,
      updated_at: asFiniteNumber(p.updated_at),
      note: asString(p.note),
      error: providerError(p.error),
      reason_code: providerReasonCode(p.reason_code),
      reset_credits: resetCredits(p.reset_credits),
      // Only an entry whose reader reports the block carries it, so older
      // readers keep the exact entry shape.
      ...(provider === "claude" && p.limit_resets !== undefined
        ? { limit_resets: normalizeClaudeLimitResets(p.limit_resets) }
        : {}),
      ...(hosts ? { hosts } : {}),
      ...(key ? { switch_key: key } : {}),
    });
  }
  return out;
}

// Fetch the live usage snapshot from the host reader. Throws on any
// transport/status/parse/size failure so the caller can report the panel as
// unreachable (never a 500). The abort timeout deliberately spans the body read
// too — a reader that sends headers then stalls the body must not hang the edge
// — the body is size-capped, and redirects are refused so a misbehaving loopback
// reader cannot pivot the edge's bearer-authenticated request to another host.
export async function fetchUsage(reader: HostReader, forceRefresh = false): Promise<ProviderUsage[]> {
  const path = reader.path ?? DEFAULT_USAGE_PATH;
  return withHostReaderJson(
    reader,
    forceRefresh ? `${path}?refresh=1` : path,
    (body) => normalizeProviders(body),
    {
      maxBytes: MAX_RESPONSE_BYTES,
      statusLabel: "usage reader status",
      sizeErrorMessage: "usage reader response too large",
      redirect: "error",
    },
  );
}

// Multi-user scoping for per-host entries: a principal sees only the hosts it
// may access, and a per-host entry whose every host is out of scope is dropped.
// A Codex account entry is account-wide usage (its `hosts` only name who is
// signed in), so it keeps its card and loses just the out-of-scope hosts; a
// failed-host Codex entry (no account) is per host and is dropped. Entries
// without a host list (a reader-host-only entry) are unchanged.
export function scopeProviderHosts(
  providers: readonly ProviderUsage[],
  allowedMachines: readonly string[],
): ProviderUsage[] {
  const out: ProviderUsage[] = [];
  for (const provider of providers) {
    if (!provider.hosts) {
      out.push(provider);
      continue;
    }
    const hosts = provider.hosts.filter((host) => allowedMachines.includes(host));
    if (hosts.length > 0) {
      out.push({ ...provider, hosts });
    } else if (provider.provider === "codex" && provider.account !== null) {
      const { hosts: _outOfScope, ...accountWide } = provider;
      out.push(accountWide);
    }
  }
  return out;
}
