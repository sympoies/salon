import {
  ACCOUNT_PROVIDER_LABELS,
  isAccountProvider,
  type AccountInventory,
  type AccountProvider,
  type AccountSummary,
  type ClaudeAccountStatus,
  type CodexAccountStatus,
  type CodexNextAccountStatus,
  type ProviderUsage,
} from "@agent-console/shared/api";
import type { Session } from "./types.ts";
import { isActivityTurnWaitingPhase } from "@agent-console/shared/activity";

// Codex and Claude sessions share one account badge, popover, inventory poll
// and switch handler. The adapters below hold what differs: a Codex switch
// applies live or queues for the next prompt, and the daemon can fail over to a
// next account; Claude Code has no live credential swap, so a Claude switch
// restarts the session and resumes it on the new account.

export type AccountInventories = Readonly<Record<string, AccountInventory>>;
export type AccountInventoriesByProvider = Readonly<Record<AccountProvider, AccountInventories>>;

export const NO_ACCOUNT_INVENTORIES: AccountInventoriesByProvider = { codex: {}, claude: {} };

export function sessionAccountProvider(agent: string | undefined): AccountProvider | null {
  return isAccountProvider(agent) ? agent : null;
}

/** The accounts a machine offers; a Codex too old for account selection offers none. */
export function accountChoices(inventory: AccountInventory | undefined): readonly AccountSummary[] {
  return inventory?.readiness?.supported === false ? [] : inventory?.accounts ?? [];
}

/** The account choices for a session on its own machine and provider. */
export function sessionAccountChoices(
  session: Pick<Session, "agent" | "machine"> | null | undefined,
  inventories: AccountInventoriesByProvider,
): readonly AccountSummary[] {
  const provider = sessionAccountProvider(session?.agent);
  return session && provider ? accountChoices(inventories[provider][session.machine]) : [];
}

/**
 * Keeps a machine's last-good inventory through a failed refresh and drops
 * machines that are no longer polled.
 */
export function reconcileAccountInventories(
  current: AccountInventories,
  entries: readonly (readonly [string, AccountInventory | null])[],
): AccountInventories {
  const next = new Map<string, AccountInventory>();
  for (const [machine, inventory] of entries) {
    const retained = inventory ?? (Object.hasOwn(current, machine) ? current[machine] : undefined);
    if (retained) next.set(machine, retained);
  }
  return Object.fromEntries(next);
}

const ACCOUNT_POLICY: Readonly<Record<AccountProvider, {
  // The daemon can recover a limited turn by failing over to a next account.
  readonly nextAccountFailover: boolean;
  // A launch profile owns the provider configuration root, so a create cannot
  // also bind an account (the daemon answers `claude-account-profile-conflict`).
  readonly launchProfileOwnsAccount: boolean;
}>> = {
  codex: { nextAccountFailover: true, launchProfileOwnsAccount: false },
  claude: { nextAccountFailover: false, launchProfileOwnsAccount: true },
};

export function launchProfileOwnsAccount(provider: AccountProvider): boolean {
  return ACCOUNT_POLICY[provider].launchProfileOwnsAccount;
}

/** The auto-resume recovery policy for a session bound to an account. */
export function accountRecoveryPolicy(
  session: Pick<Session, "agent" | "codex_account" | "claude_account"> | null | undefined,
): "next_account_then_resume" | undefined {
  const provider = sessionAccountProvider(session?.agent);
  if (!session || !provider || !ACCOUNT_POLICY[provider].nextAccountFailover) return undefined;
  return session[`${provider}_account`]?.state === "bound" ? "next_account_then_resume" : undefined;
}

/**
 * The usage entry for an account. Account nicknames are shared: one
 * registry on the token authority names every broker account (a Claude broker
 * nickname is its authority profile), so an entry is matched by provider and
 * the switch key the edge sets, not by which machines list the nickname.
 */
export function findAccountUsage(
  providers: readonly ProviderUsage[],
  provider: AccountProvider,
  account: string,
): ProviderUsage | undefined {
  return providers.find((entry) => entry.provider === provider && entry.switch_key === account);
}

export type AccountVisualState = "unbound" | "pending" | "bound" | "failed";

export interface SessionAccountNext {
  readonly account: string | undefined;
  readonly copy: string;
  /** The daemon accepted this next account; choosing it again changes nothing. */
  readonly confirmed: boolean;
  readonly retry: boolean;
}

/** Everything the shared badge and popover render for one session. */
export interface SessionAccountView {
  readonly provider: AccountProvider;
  readonly label: string;
  readonly account: string | undefined;
  readonly badgeLabel: string;
  readonly statusLabel: string;
  readonly visualState: AccountVisualState;
  /** The session runs on the provider default it was launched with. */
  readonly usesDefault: boolean;
  readonly defaultName: string;
  // The popover row naming the provider default when it differs from the session's.
  readonly defaultNowLabel: string;
  /** Shown for a default-launched session that has no account name to look up. */
  readonly loadedDefaultCopy?: string;
  readonly popoverLabel: string;
  readonly next?: SessionAccountNext;
  readonly mutationAvailable: boolean;
  readonly readOnlyCopy: string;
  readonly actionsTitle: string;
  readonly actionsNote?: string;
  readonly choiceLabel: (account: string, retry: boolean) => string;
  /** An unbound waiting session may take its first account from the title menu. */
  readonly pickFirstFromMenu: boolean;
}

function codexNextCopy(next: CodexNextAccountStatus): string {
  if (next.failure_reason === "next_invalid") {
    return "Next account state is invalid. Account changes are unavailable.";
  }
  if (next.failure_reason === "unknown") {
    return "Next account failure reason is from a newer or malformed contract. Account changes are unavailable.";
  }
  switch (next.state) {
    case "queued":
      return "Queued for the next prompt.";
    case "applying":
      return "Applying before the next prompt.";
    case "failed":
      return "Could not apply the next account. Choose an account to retry or keep the current account.";
    case "unknown":
      return "Next account state is from a newer or malformed contract. Account changes are unavailable.";
  }
}

function readOnlyCopy(nextUnreadable: boolean, accounts: readonly AccountSummary[]): string {
  if (nextUnreadable) return "Account choices are disabled until the next-account state is repaired or understood.";
  return accounts.length === 0
    ? "Account choices are unavailable on this machine."
    : "Account choices are disabled until the current binding is authoritative.";
}

// A switch is fenced to the runtime the binding was applied to: a bound
// session must report that runtime as current; any other state only needs one.
function bindingIsCurrent(
  status: { readonly state: string; readonly applied_runtime_id?: string },
  session: Pick<Session, "session_incarnation">,
): boolean {
  return status.state === "bound"
    ? Boolean(session.session_incarnation) && status.applied_runtime_id === session.session_incarnation
    : Boolean(session.session_incarnation);
}

function codexAccountView(
  session: Session,
  status: CodexAccountStatus,
  accounts: readonly AccountSummary[],
): SessionAccountView | null {
  const account = status.effective_account ?? status.selected_account;
  const badgeLabel = status.state === "unbound"
    ? "default"
    : status.selection_source === "default_at_launch" && account
      ? `default · ${account}`
      : status.selection_source === "auto_failover" && account
        ? `auto · ${account}`
        : account;
  if (!badgeLabel) return null;
  let statusLabel: string;
  let visualState: AccountVisualState;
  switch (status.state) {
    case "unsupported":
    case "unknown":
      return null;
    case "unbound":
      statusLabel = "Codex default account";
      visualState = "unbound";
      break;
    case "pending":
      statusLabel = `Codex account switching to ${account}`;
      visualState = "pending";
      break;
    case "bound":
      statusLabel = status.selection_source === "default_at_launch"
        ? `Codex default account ${account}`
        : status.selection_source === "auto_failover"
          ? `Codex auto-failover account ${account}`
          : `Codex account ${account}`;
      visualState = "bound";
      break;
    case "failed":
      statusLabel = `Codex account switch failed for ${account}`;
      visualState = "failed";
      break;
  }
  const next = status.next;
  const nextUnreadable = next?.state === "unknown"
    || next?.failure_reason === "next_invalid"
    || next?.failure_reason === "unknown";
  const usesDefault = status.state === "unbound" || status.selection_source === "default_at_launch";
  return {
    provider: "codex",
    label: ACCOUNT_PROVIDER_LABELS.codex,
    account,
    badgeLabel,
    statusLabel,
    visualState,
    usesDefault,
    defaultName: "default",
    defaultNowLabel: "Default now",
    loadedDefaultCopy: "This running process keeps the credentials loaded from the default when it started.",
    popoverLabel: usesDefault ? "Codex default account usage" : `Codex account ${badgeLabel} usage`,
    ...(next
      ? {
        next: {
          account: next.account,
          copy: codexNextCopy(next),
          confirmed: next.state === "queued" || next.state === "applying",
          retry: next.state === "failed",
        },
      }
      : {}),
    mutationAvailable: (status.state === "bound" || status.state === "unbound")
      && bindingIsCurrent(status, session)
      && accounts.length > 0
      && !nextUnreadable,
    readOnlyCopy: readOnlyCopy(nextUnreadable, accounts),
    actionsTitle: "Choose the next account",
    choiceLabel: (choice, retry) => `${retry ? "Retry" : "Queue"} Codex account ${choice} for the next prompt`,
    pickFirstFromMenu: status.state === "unbound"
      && Boolean(session.session_incarnation)
      && isActivityTurnWaitingPhase(session.turn_state?.phase)
      && accounts.length > 0,
  };
}

function claudeAccountView(
  session: Session,
  status: ClaudeAccountStatus,
  accounts: readonly AccountSummary[],
): SessionAccountView | null {
  if (status.state === "unsupported" || status.state === "unknown") return null;
  const account = status.state === "bound" ? status.selected_account : undefined;
  const defaultAtLaunch = status.selection_source === "default_at_launch";
  let badgeLabel: string;
  let statusLabel: string;
  let visualState: AccountVisualState;
  if (status.state === "failed") {
    badgeLabel = "account?";
    statusLabel = "Claude account binding is invalid";
    visualState = "failed";
  } else if (!account) {
    badgeLabel = "default";
    statusLabel = "Claude default account";
    visualState = "unbound";
  } else {
    badgeLabel = defaultAtLaunch ? `default · ${account}` : account;
    statusLabel = defaultAtLaunch ? `Claude default account ${account}` : `Claude account ${account}`;
    visualState = "bound";
  }
  const next = status.next;
  const nextUnreadable = next?.state === "unknown";
  return {
    provider: "claude",
    label: ACCOUNT_PROVIDER_LABELS.claude,
    account,
    badgeLabel,
    statusLabel,
    visualState,
    usesDefault: visualState === "unbound" || defaultAtLaunch,
    defaultName: "default",
    defaultNowLabel: "Default now",
    popoverLabel: `${statusLabel} usage`,
    ...(next
      ? {
        next: {
          account: next.account,
          copy: next.state === "queued"
            ? "Queued. It applies when this session next restarts and resumes."
            : next.state === "failed"
              ? "Next account state is invalid. Choose an account to replace it."
              : "Next account state is from a newer or malformed contract. Account changes are unavailable.",
          confirmed: next.state === "queued",
          retry: false,
        },
      }
      : {}),
    mutationAvailable: bindingIsCurrent(status, session) && accounts.length > 0 && !nextUnreadable,
    readOnlyCopy: readOnlyCopy(nextUnreadable, accounts),
    actionsTitle: "Switch account",
    actionsNote: "Switching restarts this session and resumes the conversation on the new account."
      + " While a turn is running, the switch waits for the next resume.",
    choiceLabel: (choice) => `Switch Claude account to ${choice}`,
    pickFirstFromMenu: false,
  };
}

/** The badge view for a session's own provider, or null when it shows no badge. */
export function sessionAccountView(
  session: Session,
  accounts: readonly AccountSummary[],
): SessionAccountView | null {
  if (session.agent === "codex") {
    return session.codex_account?.supported ? codexAccountView(session, session.codex_account, accounts) : null;
  }
  if (session.agent === "claude") {
    return session.claude_account?.supported ? claudeAccountView(session, session.claude_account, accounts) : null;
  }
  return null;
}
