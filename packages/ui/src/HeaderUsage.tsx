import { useUiExtensions } from "./extensions.tsx";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { AccountProvider } from "@agent-console/shared/api";
import { usage, type ProviderUsage, type UsageResult, type UsageWindow } from "./api.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { formatResetCountdown } from "./format.ts";
import { useReachablePoll } from "./reachable.ts";
import {
  compactUsageWindows,
  headerUsageAccessibleLabel,
  headerUsageName,
  pickHeaderUsage,
  projectProviderUsageForDisplay,
  providerUsagePresentation,
  remainingUsagePercent,
  shortWindowLabel,
  usageMeterLevel,
  windowTitle,
} from "./headerUsageModel.ts";
import { CalendarIcon, ClockIcon } from "./icons.tsx";
import { useSharedClock } from "./useSharedClock.ts";
import { useAccountDefaults } from "./accountDefaults.tsx";

// Usage changes slowly (codex updates per turn, claude only after a run), so poll
// unhurriedly — this mirrors the full Usage panel's cadence.
const POLL_MS = 15000;
// A 1s tick keeps the reset countdowns live between usage polls.

export interface DashboardUsageSnapshot {
  readonly providers: readonly ProviderUsage[];
  readonly reachable: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
}

const EMPTY_DASHBOARD_USAGE: DashboardUsageSnapshot = {
  providers: [],
  reachable: true,
  loaded: false,
  error: null,
};

export const DashboardUsageContext = createContext<DashboardUsageSnapshot>(EMPTY_DASHBOARD_USAGE);

export interface DashboardUsageProviderProps {
  readonly children: ReactNode;
  // False for a principal without the usage permission: /api/usage would only
  // answer 403, so no request is made and no outage is reported.
  readonly enabled?: boolean;
  readonly fetcher?: typeof usage;
  readonly pollDelayMs?: number;
}

const noUsage = async (): Promise<UsageResult> => ({ providers: [], reachable: true });

export function DashboardUsageProvider({
  children,
  enabled = true,
  fetcher = usage,
  pollDelayMs = POLL_MS,
}: DashboardUsageProviderProps) {
  const { usageProviders } = useUiExtensions();
  const selectProviders = useCallback((result: UsageResult): ProviderUsage[] => usageProviders?.(result.providers) ?? result.providers, [usageProviders]);
  const usageState = useReachablePoll({
    fetcher: enabled ? fetcher : noUsage,
    selectData: selectProviders,
    delayMs: pollDelayMs,
    initialData: [],
    retainDataWhenUnreachable: true,
  });
  const value = useMemo<DashboardUsageSnapshot>(() => ({
    providers: usageState.data,
    reachable: usageState.reachable,
    loaded: usageState.loaded,
    error: usageState.error,
  }), [usageState.data, usageState.error, usageState.loaded, usageState.reachable]);

  return <DashboardUsageContext.Provider value={value}>{children}</DashboardUsageContext.Provider>;
}

export function useDashboardUsage(): DashboardUsageSnapshot {
  return useContext(DashboardUsageContext);
}

export interface HeaderUsageProps {
  // Opens Usage anchored to the header widget.
  readonly onOpen: (anchor: HTMLElement) => void;
}

export interface HeaderUsageReadoutProps extends HeaderUsageProps {
  readonly providers: readonly ProviderUsage[];
  readonly now: number;
  /** Each provider's default account supplied by the installed distribution. */
  readonly defaults?: Partial<Readonly<Record<AccountProvider, string | null>>>;
}

// Compact usage readout for the dashboard header: Claude + the active Codex
// account, each with a couple of mini meters. Clicking opens the full Usage page.
// Renders nothing until there is data, so the header stays clean when usage is
// unavailable.
export function HeaderUsage({ onOpen }: HeaderUsageProps) {
  const now = useSharedClock(true);
  const usageState = useDashboardUsage();
  const defaults = useAccountDefaults();

  return (
    <HeaderUsageReadout
      providers={usageState.providers}
      now={now}
      defaults={{ codex: defaults.codex.activeAccount, claude: defaults.claude.activeAccount }}
      onOpen={onOpen}
    />
  );
}

/**
 * One compact usage window: its glyph, remaining-capacity meter, remaining
 * percentage and time to reset. The top-bar chip and the focused session
 * header's account quota share it so both read the same.
 */
export function UsageWindowChip({ window: w, now }: { readonly window: UsageWindow; readonly now: number }) {
  const remaining = remainingUsagePercent(w.used_percent);
  return (
    <span className="hu-win" data-window-key={w.key}>
      <span className="hu-win-label" title={windowTitle(w)}>
        {w.key === "5h" ? (
          <ClockIcon />
        ) : w.key === "weekly" ? (
          <CalendarIcon />
        ) : (
          shortWindowLabel(w)
        )}
      </span>
      <span className="hu-meter">
        <span
          className={`hu-meter-fill ${usageMeterLevel(remaining)}`}
          style={{ width: `${remaining ?? 0}%` }}
        />
      </span>
      <span className="hu-pct">{remaining === null ? "—" : `${remaining}%`}</span>
      <span className="hu-reset" title={`${w.label} resets in ${formatResetCountdown(w.resets_at, now)}`}>
        {formatResetCountdown(w.resets_at, now)}
      </span>
    </span>
  );
}

export function HeaderUsageReadout({
  providers,
  now,
  defaults = {},
  onOpen,
}: HeaderUsageReadoutProps) {
  const shown = pickHeaderUsage(providers, defaults)
    .map((provider) => projectProviderUsageForDisplay(provider, now));
  if (shown.length === 0) {
    return null;
  }
  const accessibleLabel = headerUsageAccessibleLabel(shown, now);

  return (
    <button type="button" className="header-usage" onClick={(event) => onOpen(event.currentTarget)} title={accessibleLabel} aria-label={accessibleLabel}>
      <span className="hu-compact" aria-hidden="true">Usage</span>
      {shown.map((p) => {
        const presentation = providerUsagePresentation(p, now);
        const compactWindows = compactUsageWindows(p);
        return (
          <span className="hu-provider" data-provider={p.provider} key={`${p.provider}:${p.account ?? ""}`}>
            <AgentBadge agent={p.provider} />
            <span className="hu-name">{headerUsageName(p)}</span>
            {presentation.kind === "windows" ? (
              compactWindows.map((w) => <UsageWindowChip window={w} now={now} key={w.key} />)
            ) : (
              <span className={`hu-state ${presentation.warn ? "warn" : ""}`}>{presentation.compactStatus}</span>
            )}
          </span>
        );
      })}
    </button>
  );
}
