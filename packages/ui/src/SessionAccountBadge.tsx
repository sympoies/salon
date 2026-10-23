import type { AccountSummary } from "@agent-console/shared/api";
import { AsyncButton } from "./AsyncButton.tsx";
import { useAccountDefaults } from "./accountDefaults.tsx";
import { formatResetCountdown } from "./format.ts";
import {
  compactUsageWindows,
  projectProviderUsageForDisplay,
  providerUsageAccessibleSummary,
  providerUsagePresentation,
  remainingUsagePercent,
  usageMeterLevel,
} from "./headerUsage.ts";
import { UsageWindowChip, useDashboardUsage } from "./HeaderUsage.tsx";
import { usePreviewPinnedPopover } from "./SessionActivityPopover.tsx";
import { findAccountUsage, sessionAccountView, type SessionAccountView } from "./sessionAccounts.ts";
import type { Session } from "./types.ts";
import { useSharedClock } from "./useSharedClock.ts";

/**
 * The account badge of a Codex or Claude session. Its popover previews the
 * usage of the current, next and provider-default accounts; pinned, it offers
 * the machine's other accounts.
 */
export function SessionAccountBadge({
  session,
  accounts,
  pending,
  onAccount,
  clockActive = false,
  now,
}: {
  readonly session: Session;
  readonly accounts: readonly AccountSummary[];
  readonly pending: boolean;
  readonly onAccount: (session: Session, account: string) => Promise<void>;
  readonly clockActive?: boolean;
  readonly now?: number;
}) {
  const view = sessionAccountView(session, accounts);
  if (!view) return null;
  return (
    <SessionAccountPopover
      view={view}
      accounts={accounts}
      pending={pending}
      onAccount={(account) => onAccount(session, account)}
      clockActive={clockActive}
      now={now}
    />
  );
}

/**
 * The quota of the account a session is running on, in the top-bar chip's
 * form: each compact window's meter, remaining percentage and time to reset.
 * It reads the same usage snapshot as the chip, so both show the same values.
 */
export function SessionAccountQuota({
  session,
  clockActive = false,
  now,
}: {
  readonly session: Session;
  readonly clockActive?: boolean;
  readonly now?: number;
}) {
  const usage = useDashboardUsage();
  const sharedNow = useSharedClock(clockActive && now === undefined);
  const effectiveNow = now ?? sharedNow;
  const view = sessionAccountView(session, []);
  const entry = view?.account ? findAccountUsage(usage.providers, view.provider, view.account) : undefined;
  if (!entry) return null;
  const display = projectProviderUsageForDisplay(entry, effectiveNow);
  const presentation = providerUsagePresentation(display, effectiveNow);
  const label = providerUsageAccessibleSummary(display, effectiveNow);
  return (
    <span className="session-quota" role="img" aria-label={label} title={label}>
      {presentation.kind === "windows" ? (
        compactUsageWindows(display).map((window) => <UsageWindowChip window={window} now={effectiveNow} key={window.key} />)
      ) : (
        <span className={`hu-state ${presentation.warn ? "warn" : ""}`}>{presentation.compactStatus}</span>
      )}
    </span>
  );
}

/** A read-only account badge for rows that are themselves a control. */
export function SessionAccountChip({ session }: { readonly session: Session }) {
  const view = sessionAccountView(session, []);
  if (!view) return null;
  return (
    <span className={`control-counter account-status account-status-${view.provider} account-${view.visualState}`} title={view.statusLabel}>
      {view.badgeLabel}
    </span>
  );
}

function SessionAccountPopover({
  view,
  accounts,
  pending,
  onAccount,
  clockActive,
  now,
}: {
  readonly view: SessionAccountView;
  readonly accounts: readonly AccountSummary[];
  readonly pending: boolean;
  readonly onAccount: (account: string) => Promise<void>;
  readonly clockActive: boolean;
  readonly now?: number;
}) {
  const usage = useDashboardUsage();
  const defaults = useAccountDefaults();
  const {
    open,
    pinned,
    popoverId,
    rootRef,
    triggerRef,
    popoverRef,
    preview,
    scheduleClose,
    onClick,
    onBlur,
  } = usePreviewPinnedPopover();
  const sharedNow = useSharedClock(clockActive && open && now === undefined);
  const effectiveNow = now ?? sharedNow;
  const { provider, account, next } = view;
  const defaultAccount = defaults[provider].activeAccount ?? undefined;
  const defaultLabel = defaults[provider].label ?? view.defaultNowLabel;
  const accessibleLabel = `${view.statusLabel}.${next?.account ? ` Next account ${next.account}.` : ""} View usage details`;
  const renderUsageSection = (label: string, targetAccount: string | undefined, stateCopy?: string) => {
    const entry = targetAccount ? findAccountUsage(usage.providers, provider, targetAccount) : undefined;
    const displayEntry = entry ? projectProviderUsageForDisplay(entry, effectiveNow) : undefined;
    const presentation = displayEntry ? providerUsagePresentation(displayEntry, effectiveNow) : undefined;
    return (
      <span className="account-usage-section">
        <span className="account-usage-section-label">{label}</span>
        <span className="account-usage-head">
          <span className="account-usage-name">{targetAccount ?? "Unknown account"}</span>
          {displayEntry?.plan ? <span className="account-usage-plan">{displayEntry.plan}</span> : null}
        </span>
        {stateCopy ? <span className="account-next-state">{stateCopy}</span> : null}
        {!targetAccount ? (
          <span className="account-usage-note warn">No safe account nickname is available.</span>
        ) : !usage.loaded && !displayEntry ? (
          <span className="account-usage-note">Loading usage…</span>
        ) : displayEntry && presentation?.kind === "windows" ? (
          <span className="account-usage-windows">
            {displayEntry.windows.map((window) => {
              const remaining = remainingUsagePercent(window.used_percent);
              return (
                <span className="account-usage-window" key={window.key}>
                  <span className="account-usage-window-head">
                    <span>{window.label}</span>
                    <span className="account-usage-percent">
                      {remaining === null ? "—" : `${remaining}% left`}
                    </span>
                  </span>
                  <span className="account-usage-meter" aria-hidden="true">
                    <span
                      className={`account-usage-meter-fill ${usageMeterLevel(remaining)}`}
                      style={{ width: `${remaining ?? 0}%` }}
                    />
                  </span>
                  <span className="account-usage-reset">
                    resets in {formatResetCountdown(window.resets_at, effectiveNow)}
                  </span>
                </span>
              );
            })}
          </span>
        ) : (
          <span className={`account-usage-note ${presentation?.warn ? "warn" : ""}`}>
            {presentation?.status ?? "No usage data available for this account."}
          </span>
        )}
        {presentation?.freshness ? (
          <span className="account-usage-freshness">{presentation.freshness}</span>
        ) : null}
        {targetAccount && usage.loaded && !usage.reachable ? (
          <span className="account-usage-note warn">
            {displayEntry ? "Usage refresh unavailable; showing the last result." : "Usage refresh unavailable."}
          </span>
        ) : null}
      </span>
    );
  };
  const renderLoadedDefaultSection = () => (
    <span className="account-usage-section">
      <span className="account-usage-section-label">Current</span>
      <span className="account-usage-head">
        <span className="account-usage-name">default</span>
      </span>
      {view.loadedDefaultCopy ? <span className="account-next-state">{defaults[provider].loadedDefaultCopy ?? view.loadedDefaultCopy}</span> : null}
    </span>
  );
  const otherAccounts = accounts.filter((item) => item.account !== account);

  return (
    <span
      className="account-usage-root"
      ref={rootRef}
      onMouseEnter={preview}
      onMouseLeave={scheduleClose}
      onFocus={preview}
      onBlur={onBlur}
    >
      <button
        type="button"
        ref={triggerRef}
        className={`control-counter account-status account-status-${provider} account-${view.visualState}`}
        aria-label={accessibleLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-describedby={open && !pinned ? popoverId : undefined}
        onClick={onClick}
      >
        {view.badgeLabel}
      </button>
      {view.visualState === "bound" && !next ? null : (
        <span className="sr-only" role="status" aria-live="polite">
          {next ? `${view.statusLabel}. ${next.copy}` : view.statusLabel}
        </span>
      )}
      {open ? (
        <span
          className={`account-usage-popover ${pinned ? "is-pinned" : "is-preview"}`}
          ref={popoverRef}
          id={popoverId}
          role={pinned ? "dialog" : "tooltip"}
          tabIndex={pinned ? -1 : undefined}
          aria-label={view.usesDefault ? defaults[provider].defaultUsageLabel ?? view.popoverLabel : view.popoverLabel}
        >
          {view.usesDefault ? (
            <>
              {account
                ? renderUsageSection("Current", account, `Selected from the ${defaults[provider].defaultName ?? view.defaultName} when this session launched.`)
                : renderLoadedDefaultSection()}
              {defaultAccount && defaultAccount !== account
                ? renderUsageSection(defaultLabel, defaultAccount)
                : null}
            </>
          ) : renderUsageSection("Current", account)}
          {next ? renderUsageSection("Next", next.account, next.copy) : null}
          {pinned ? (
            <span className="account-actions" aria-busy={pending || undefined}>
              <span className="account-actions-title">{view.actionsTitle}</span>
              {view.actionsNote ? <span className="account-usage-note">{view.actionsNote}</span> : null}
              {view.mutationAvailable ? (
                <>
                  {next && account ? (
                    <AsyncButton
                      className="control-menu account-choice keep-current"
                      type="button"
                      disabled={pending}
                      aria-label={`Keep current ${view.label} account ${account} and cancel the next account`}
                      onClick={async (event) => {
                        event.stopPropagation();
                        await onAccount(account);
                      }}
                    >
                      <span>Keep current</span>
                      <span className="account-choice-meta">Cancel next account</span>
                    </AsyncButton>
                  ) : null}
                  {otherAccounts.map((item) => {
                    const confirmedNext = next?.account === item.account && next.confirmed;
                    const retry = next?.account === item.account && next.retry;
                    return (
                      <AsyncButton
                        className="control-menu account-choice"
                        type="button"
                        key={item.account}
                        disabled={pending || confirmedNext}
                        aria-label={view.choiceLabel(item.account, retry)}
                        aria-current={confirmedNext ? "true" : undefined}
                        onClick={async (event) => {
                          event.stopPropagation();
                          await onAccount(item.account);
                        }}
                      >
                        <span>{item.label ?? item.account}</span>
                        <span className="account-choice-meta">
                          {confirmedNext ? "Next" : retry ? "Retry" : item.plan ?? item.account}
                        </span>
                      </AsyncButton>
                    );
                  })}
                </>
              ) : (
                <span className="account-usage-note warn">{view.readOnlyCopy}</span>
              )}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
