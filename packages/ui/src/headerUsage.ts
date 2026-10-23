import type { AccountProvider } from "@agent-console/shared/api";
import type { ProviderUsage, ProviderUsageReason, UsageWindow } from "./api.ts";
import { relativeEpochSeconds } from "./format.ts";

// Short window label for the compact header: the weekly window shows as "1w"
// (the reader labels it "Weekly"); other windows keep their label (e.g. "5h").
// Used as the text fallback when a window has no dedicated glyph.
export function shortWindowLabel(window: UsageWindow): string {
  return window.key === "weekly" ? "1w" : window.label;
}

// Full window name for the glyph's tooltip, since the compact widget shows an
// icon (clock = 5h, calendar = weekly) rather than text.
export function windowTitle(window: UsageWindow): string {
  if (window.key === "weekly") {
    return "Weekly window";
  }
  if (window.key === "5h") {
    return "5h window";
  }
  return `${window.label} window`;
}

const COMPACT_USAGE_WINDOW_LIMIT = 2;
const COMPACT_USAGE_PROVIDER_LIMIT = 2;
const COMPACT_ACCOUNT_LIMIT = 48;
const COMPACT_PROVIDER_LIMIT = 32;
const COMPACT_WINDOW_LABEL_LIMIT = 24;
const COMPACT_PROVIDER_SUMMARY_LIMIT = 200;
export const HEADER_USAGE_ACCESSIBLE_LABEL_LIMIT = 512;

const COMPACT_ACCESSIBLE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu;

// Reader text is untrusted even though React safely escapes it. Keep the
// compact accessible name single-line and strictly bounded so account/window
// metadata cannot amplify into an oversized or direction-changing attribute.
function compactAccessibleFragment(value: string, limit: number): string {
  const normalized = value
    .slice(0, limit * 4)
    .replace(COMPACT_ACCESSIBLE_CONTROL_RE, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  const prefix = normalized.slice(0, limit - 1).replace(/[\ud800-\udbff]$/u, "");
  return `${prefix}…`;
}

// Header visuals and accessibility text must share this bounded selector. The
// reader can add future windows, but the one-second header render stays concise
// and cannot serialize more state than the user sees.
export function compactUsageWindows(provider: Pick<ProviderUsage, "windows">): readonly UsageWindow[] {
  return provider.windows.slice(0, COMPACT_USAGE_WINDOW_LIMIT);
}

// The account label the Usage cards and the header share: the name the account
// is switched by (a Codex nickname, or the token-authority profile a Claude
// account is saved under), else the entry's own account label (a Claude email).
export function usageAccountAlias(provider: Pick<ProviderUsage, "account" | "switch_key">): string | null {
  return provider.switch_key ?? provider.account;
}

// The header names an account by its alias. A per-host Claude entry without a
// profile is named by the first of its hosts in roster order (the edge host,
// then managed spokes).
export function headerUsageName(
  provider: Pick<ProviderUsage, "provider" | "account" | "label" | "hosts" | "switch_key">,
): string {
  if (provider.switch_key) {
    return provider.switch_key;
  }
  if (provider.provider === "claude" && provider.hosts && provider.hosts.length > 0) {
    return provider.hosts[0] as string;
  }
  return provider.account ?? provider.label;
}

export interface UsageCardSelection {
  readonly isDefault: boolean;
  readonly switchable: boolean;
  readonly pending: boolean;
}

// Usage page cards of one provider: the card whose switch key is that
// provider's default is marked, and any other listed account can become the
// default while its controller is reachable. Entries without a switch key never
// switch.
export function usageCardSelection(
  provider: AccountProvider,
  defaults: {
    readonly activeAccount: string | null;
    readonly accounts: readonly string[];
    readonly reachable: boolean;
    readonly pendingAccount: string | null;
  },
): (entry: ProviderUsage) => UsageCardSelection {
  return (entry) => {
    const key = entry.provider === provider ? entry.switch_key ?? null : null;
    return {
      switchable: defaults.reachable && key !== null && defaults.accounts.includes(key),
      isDefault: key !== null && key === defaults.activeAccount,
      pending: key !== null && key === defaults.pendingAccount,
    };
  };
}

type HeaderFallback = (entries: readonly ProviderUsage[], defaultKey: string | null) => ProviderUsage | null;

// When no entry carries the provider default, the header falls back per
// provider. The Codex default is unknown only while its controller is
// unavailable, so the most recently updated account stands in; a reported
// default without usage shows nothing. The Claude reader lists the configured
// default first, so the first labelled entry stands in.
const HEADER_FALLBACK: Readonly<Record<AccountProvider, HeaderFallback>> = {
  codex: (entries, defaultKey) => defaultKey
    ? null
    : entries.reduce<ProviderUsage | null>(
      (latest, entry) => latest === null || (entry.updated_at ?? -Infinity) > (latest.updated_at ?? -Infinity)
        ? entry
        : latest,
      null,
    ),
  claude: (entries) => entries.find((entry) => entry.account !== null) ?? entries[0] ?? null,
};

export function headerProviderEntry(
  providers: readonly ProviderUsage[],
  provider: AccountProvider,
  defaultKey: string | null = null,
): ProviderUsage | null {
  const entries = providers.filter((entry) => entry.provider === provider);
  return (defaultKey ? entries.find((entry) => entry.switch_key === defaultKey) : undefined)
    ?? HEADER_FALLBACK[provider](entries, defaultKey);
}

// Which providers the compact header widget shows: each provider's default
// account (Claude first, then Codex), or its fallback; absent providers are
// simply omitted.
export function pickHeaderUsage(
  providers: readonly ProviderUsage[],
  defaults: Partial<Readonly<Record<AccountProvider, string | null>>> = {},
): ProviderUsage[] {
  return (["claude", "codex"] as const).flatMap((provider) => {
    const entry = headerProviderEntry(providers, provider, defaults[provider] ?? null);
    return entry ? [entry] : [];
  });
}

// Safe one-line context for the compact header. The reader contract limits
// error/note to non-secret human-readable strings; prefer the explicit provider
// error, then a stale/no-window note. Healthy providers need no extra tooltip.
export function providerReasonMessage(
  provider: Pick<ProviderUsage, "label" | "provider" | "reason_code">,
): string | null {
  const label = provider.label || (provider.provider === "claude" ? "Claude" : "Codex");
  const messages: Record<ProviderUsageReason, string> = {
    auth_required: `Sign in to ${label} to view usage.`,
    auth_expired: `Your ${label} sign-in has expired. Sign in again.`,
    billing_past_due: `Your ${label} subscription payment is past due. Pay the overdue invoice to restore access, or contact your company admin.`,
    subscription_inactive: `Your ${label} subscription is inactive. Renew it or contact your company admin to restore access.`,
    organization_disabled: provider.provider === "claude"
      ? "Your organization has disabled Claude access. Use an Anthropic API key instead, or contact your company admin to restore access."
      : `Your organization has disabled ${label} access. Contact your company admin to restore access.`,
    permission_denied: `Your account does not have access to ${label}. Contact your company admin.`,
    rate_limited: `${label} usage is temporarily rate limited. Try again later.`,
    service_unavailable: `${label} usage is unavailable right now.`,
    timeout: `${label} usage refresh timed out.`,
    unknown: `Unknown error. ${label} usage is unavailable right now.`,
  };
  return provider.reason_code ? messages[provider.reason_code] ?? null : null;
}

export function providerUsageStatus(provider: ProviderUsage): string | null {
  const reasonMessage = providerReasonMessage(provider);
  if (!provider.ok) {
    return reasonMessage ?? provider.error ?? "Unknown error. Usage unavailable for this provider";
  }
  if (provider.windows.length === 0) {
    return reasonMessage ?? provider.note ?? "No usage windows reported";
  }
  if (provider.stale) {
    return reasonMessage ?? provider.note ?? "Usage may be stale";
  }
  return null;
}

export type ProviderUsagePresentationKind = "windows" | "expired" | "unavailable" | "current-empty";

export interface ProviderUsagePresentation {
  readonly kind: ProviderUsagePresentationKind;
  readonly compactStatus: string | null;
  readonly status: string | null;
  readonly freshness: string | null;
  readonly warn: boolean;
}

const USAGE_MAX_DISPLAY_AGE_SECONDS = 600;
const USAGE_FUTURE_TOLERANCE_SECONDS = 5;
const MAX_DATE_EPOCH_SECONDS = 8_640_000_000_000;

// Reader responses and retained last-good snapshots can outlive the poll that
// produced them. Re-project display eligibility from updated_at on every shared
// clock tick so both UI surfaces enforce the same exact boundary independently
// of reader reachability or poll completion. Keep all safe diagnostic context;
// only quota windows become ineligible. Missing/non-finite timestamps and clock
// skew beyond the reader/CLI five-second tolerance fail closed.
export function projectProviderUsageForDisplay(provider: ProviderUsage, nowMs: number): ProviderUsage {
  const updatedAt = provider.updated_at;
  const updatedAtSafe = updatedAt !== null
    && Number.isFinite(updatedAt)
    && Math.abs(updatedAt) <= MAX_DATE_EPOCH_SECONDS;
  const ageSeconds = Number.isFinite(nowMs) && updatedAtSafe
    ? nowMs / 1000 - updatedAt
    : null;
  const displayable = ageSeconds !== null
    && ageSeconds >= -USAGE_FUTURE_TOLERANCE_SECONDS
    && ageSeconds < USAGE_MAX_DISPLAY_AGE_SECONDS;
  if (displayable) {
    return provider;
  }
  return {
    ...provider,
    stale: true,
    windows: [],
    // Reset status read with those windows is just as old: show it as unknown.
    ...(provider.limit_resets !== undefined ? { limit_resets: null } : {}),
    updated_at: updatedAtSafe ? updatedAt : null,
  };
}

const COMPACT_REASON_STATUS: Record<ProviderUsageReason, string> = {
  auth_required: "Sign in",
  auth_expired: "Sign in",
  billing_past_due: "Billing issue",
  subscription_inactive: "Inactive",
  organization_disabled: "Disabled",
  permission_denied: "No access",
  rate_limited: "Rate limited",
  service_unavailable: "Unavailable",
  timeout: "Timed out",
  unknown: "Unavailable",
};

function providerUsageKind(provider: ProviderUsage): ProviderUsagePresentationKind {
  if (!provider.ok) {
    return provider.stale ? "expired" : "unavailable";
  }
  if (provider.windows.length > 0) {
    return "windows";
  }
  return provider.stale ? "expired" : "current-empty";
}

// One classification owns the compact label, full-card status, timestamp
// wording, and warning treatment. Empty windows are authoritative, but only a
// reader-marked stale result proves expiry; a fresh successful empty response
// is a valid current check and must stay neutral.
export function providerUsagePresentation(provider: ProviderUsage, now: number): ProviderUsagePresentation {
  const kind = providerUsageKind(provider);
  let compactStatus: string | null = null;
  if (kind !== "windows") {
    compactStatus = provider.reason_code
      ? COMPACT_REASON_STATUS[provider.reason_code]
      : kind === "expired"
        ? "Expired"
        : kind === "unavailable"
          ? "Unavailable"
          : "No windows";
  }

  let freshness: string | null = null;
  if (provider.updated_at !== null) {
    const prefix = kind === "expired" ? "last success" : kind === "windows" ? "updated" : "checked";
    freshness = `${prefix} ${relativeEpochSeconds(provider.updated_at, now)}`;
  }

  return {
    kind,
    compactStatus,
    status: providerUsageStatus(provider),
    freshness,
    warn: kind === "expired" || kind === "unavailable" || provider.stale || provider.reason_code !== null,
  };
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function compactProviderName(provider: Pick<ProviderUsage, "label" | "provider">): string {
  if (provider.provider === "claude") {
    return "Claude";
  }
  if (provider.provider === "codex") {
    return "Codex";
  }
  return compactAccessibleFragment(provider.label || provider.provider || "Provider", COMPACT_PROVIDER_LIMIT);
}

function compactReasonStatus(provider: Pick<ProviderUsage, "reason_code">): string | null {
  return provider.reason_code ? COMPACT_REASON_STATUS[provider.reason_code] ?? "Unavailable" : null;
}

// The outer header button owns focus, so its accessible name must carry the
// provider/account identity and state that a descendant title cannot expose.
export function providerUsageAccessibleSummary(provider: ProviderUsage, now: number): string {
  const presentation = providerUsagePresentation(provider, now);
  const providerName = compactProviderName(provider);
  const alias = provider.switch_key ?? null;
  const host = provider.provider === "claude" && !alias ? provider.hosts?.[0] : undefined;
  const account = alias ?? provider.account;
  const identity = host
    ? `${providerName} on ${compactAccessibleFragment(host, COMPACT_ACCOUNT_LIMIT) || "host"}`
    : account
      ? `${providerName} account ${compactAccessibleFragment(account, COMPACT_ACCOUNT_LIMIT) || "Account"}`
      : providerName;
  const parts: string[] = [];

  if (presentation.kind === "windows") {
    parts.push(...compactUsageWindows(provider).map((window) => {
      const remaining = remainingUsagePercent(window.used_percent);
      const value = remaining === null ? "unknown" : `${remaining}% left`;
      const label = compactAccessibleFragment(window.label, COMPACT_WINDOW_LABEL_LIMIT) || "Window";
      return `${label} ${value}`;
    }));
    const state = compactReasonStatus(provider) ?? (provider.stale ? "Stale" : null);
    if (state) {
      parts.push(state);
    }
  } else if (presentation.compactStatus) {
    parts.push(presentation.compactStatus);
  }
  if (presentation.freshness) {
    parts.push(`${presentation.freshness[0]?.toUpperCase() ?? ""}${presentation.freshness.slice(1)}`);
  }
  return compactAccessibleFragment(
    `${identity}: ${parts.map(sentence).join(" ")}`,
    COMPACT_PROVIDER_SUMMARY_LIMIT,
  );
}

// Retain the fixed action at the end while bounding the dynamic body. The
// caller normally passes pickHeaderUsage(), but this seam also defends its own
// provider count for tests and future call sites.
export function headerUsageAccessibleLabel(providers: readonly ProviderUsage[], now: number): string {
  const prefix = "Usage. ";
  const suffix = " Open Usage details.";
  const bodyLimit = HEADER_USAGE_ACCESSIBLE_LABEL_LIMIT - prefix.length - suffix.length;
  const body = compactAccessibleFragment(
    providers
      .slice(0, COMPACT_USAGE_PROVIDER_LIMIT)
      .map((provider) => providerUsageAccessibleSummary(provider, now))
      .join(" "),
    bodyLimit,
  );
  return `${prefix}${body}${suffix}`;
}

// Presentation order for the full Usage page: Claude first, then Codex, then
// any other provider — matching the header widget's Claude-first order (see
// pickHeaderUsage). The reader payload's order is not guaranteed, so the page
// imposes its own. A stable sort keeps multiple Codex accounts in the reader's
// relative order within the Codex group. A Map (not a plain object) is used for
// the lookup so a reader-supplied provider name like "toString" can't resolve to
// an inherited member and poison the comparator with a non-number.
const PROVIDER_ORDER = new Map<string, number>([
  ["claude", 0],
  ["codex", 1],
]);

export function orderUsageProviders(providers: readonly ProviderUsage[]): ProviderUsage[] {
  const rank = (p: ProviderUsage): number => PROVIDER_ORDER.get(p.provider) ?? 2;
  return [...providers].sort((a, b) => rank(a) - rank(b));
}

// Convert the reader's consumed percentage into the battery-style capacity the
// UI presents. codex-cli diag rounds the remaining value, so the text, bar
// width, accessible name, and threshold color all share the same integer.
export function remainingUsagePercent(usedPercent: number | null): number | null {
  if (usedPercent === null || !Number.isFinite(usedPercent)) {
    return null;
  }
  return Math.round(100 - Math.max(0, Math.min(100, usedPercent)));
}

// codex-cli diag remaining-capacity bands: cyan-green at 80%+, green at 60%+,
// sand at 40%+, orange at 20%+, red below 20%, and gray when fully depleted.
// Unknown values stay neutral and render with an empty bar.
export function usageMeterLevel(
  remainingPercent: number | null,
): "" | "empty" | "plenty" | "good" | "fair" | "low" | "critical" {
  if (remainingPercent === null) {
    return "";
  }
  if (remainingPercent <= 0) {
    return "empty";
  }
  if (remainingPercent >= 80) {
    return "plenty";
  }
  if (remainingPercent >= 60) {
    return "good";
  }
  if (remainingPercent >= 40) {
    return "fair";
  }
  if (remainingPercent >= 20) {
    return "low";
  }
  return "critical";
}
