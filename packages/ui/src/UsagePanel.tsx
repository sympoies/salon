import { useUiExtensions } from "./extensions.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  resetClaudeLimit,
  resetCodexRateLimit,
  usage,
  type ClaudeGrantedResets,
  type ClaudeLimitResetMutationResult,
  type ClaudeLimitResetProgram,
  type ClaudeLimitResets,
  type ClaudeSessionReset,
  type CodexRateLimitResetMutationResult,
  type ProviderUsage,
  type UsageResult,
  type UsageWindow,
} from "./api.ts";
import { formatResetCountdown } from "./format.ts";
import { AgentBadge } from "./AgentBadge.tsx";
import { AsyncButton } from "./AsyncButton.tsx";
import {
  orderUsageProviders,
  projectProviderUsageForDisplay,
  providerUsagePresentation,
  remainingUsagePercent,
  usageAccountAlias,
  usageCardSelection,
  usageMeterLevel,
} from "./headerUsageModel.ts";
import { isMacTauri } from "./runtime.ts";
import { HostReaderUnavailable, useReachablePoll } from "./reachable.ts";
import { useSharedClock } from "./useSharedClock.ts";
import { useAccountDefaults } from "./accountDefaults.tsx";
import {
  ACCOUNT_PROVIDER_LABELS,
  ACCOUNT_PROVIDERS,
  isAccountProvider,
} from "@agent-console/shared/api";
import { Modal } from "./Modal.tsx";

// Usage data changes slowly (codex updates its rollout every turn; claude only
// when a session runs), so poll unhurriedly. The shared 1s clock keeps reset
// countdowns and retained-snapshot display eligibility live between polls
// without re-hitting the reader.
const POLL_MS = 15000;

// Remembers the last successful snapshot across mount/unmount so re-opening the
// panel (e.g. via the Cmd+L toggle) paints the previous cards immediately and
// refreshes in the background — the skeleton then only shows on the first open of
// a page session, not on every toggle. Success-only, so a failed refresh never
// replaces good cached cards. Module-scoped: cleared on a full page reload.
interface UsageSnapshot {
  readonly providers: ProviderUsage[];
  readonly reachable: boolean;
  readonly error: string | null;
}
let usageCache: UsageSnapshot | null = null;

export interface UsagePanelProps {
  readonly onExit: () => void;
  // The owner's reset permission covers Codex earned resets and Claude limit resets.
  readonly canResetRateLimits?: boolean;
}

function WindowRow({ window: w, now }: { readonly window: UsageWindow; readonly now: number }) {
  // Convert once so the label text, bar width, accessible meaning, and threshold
  // color all report battery-style remaining capacity.
  const remaining = remainingUsagePercent(w.used_percent);
  const remainingText = remaining === null ? "—" : `${remaining}%`;
  const accessibleValue = remaining === null ? "remaining unknown" : `${remaining}% left`;
  return (
    <div className="usage-window">
      <div className="usage-window-head">
        <span className="usage-window-label">{w.label}</span>
        <span className="usage-window-pct">{remainingText}</span>
      </div>
      <div className="usage-meter" role="img" aria-label={`${w.label} ${accessibleValue}`}>
        <span
          className={`usage-meter-fill ${usageMeterLevel(remaining)}`}
          style={{ width: `${remaining ?? 0}%` }}
        />
      </div>
      <div className="usage-window-foot">
        <span>resets in {formatResetCountdown(w.resets_at, now)}</span>
      </div>
    </div>
  );
}

export interface ProviderCardProps {
  readonly provider: ProviderUsage;
  readonly now: number;
  readonly isDefault?: boolean;
  readonly switchable?: boolean;
  readonly pending?: boolean;
  readonly onSwitch?: (account: string) => Promise<void>;
  readonly onReset?: (account: string, idempotencyKey: string) => Promise<CodexRateLimitResetMutationResult>;
  readonly onClaudeReset?: ClaudeResetHandler;
}

type ClaudeResetHandler = (
  account: string,
  program: ClaudeLimitResetProgram,
  idempotencyKey: string,
) => Promise<ClaudeLimitResetMutationResult>;

function resetOutcomeMessage(result: CodexRateLimitResetMutationResult): string {
  if (!result.ok) return result.error ?? "The reset request could not be completed. You can safely retry.";
  switch (result.outcome) {
    case "reset":
      return result.windowsReset === undefined
        ? "Rate limits reset successfully."
        : `Rate limits reset successfully across ${result.windowsReset} window${result.windowsReset === 1 ? "" : "s"}.`;
    case "already_redeemed":
      return "This reset request was already completed safely.";
    case "no_credit":
      return "The earned reset is no longer available.";
    case "nothing_to_reset":
      return "Current usage is not eligible for a reset yet.";
    default:
      return "The reset controller returned an unexpected result.";
  }
}

function CodexResetAction({
  account,
  count,
  onReset,
}: {
  readonly account: string;
  readonly count: number;
  readonly onReset: (account: string, idempotencyKey: string) => Promise<CodexRateLimitResetMutationResult>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CodexRateLimitResetMutationResult | null>(null);
  const keyRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const terminal = result?.ok === true && result.outcome !== undefined;
  const submit = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPending(true);
    keyRef.current ??= crypto.randomUUID();
    try {
      setResult(await onReset(account, keyRef.current));
    } catch {
      setResult({ ok: false, error: "The reset request could not be completed. You can safely retry." });
    } finally {
      inFlightRef.current = false;
      setPending(false);
    }
  };
  return (
    <div className="usage-reset" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    }}>
      <span className="usage-reset-count">{count} reset{count === 1 ? "" : "s"} available</span>
      {count > 0 ? (
        <button
          className="btn ghost usage-reset-trigger"
          type="button"
          aria-label={`Use a reset for ${account}`}
          onClick={() => {
            keyRef.current = null;
            setResult(null);
            setOpen(true);
          }}
        >
          Use reset
        </button>
      ) : null}
      {open ? (
        <Modal
          onClose={() => setOpen(false)}
          busy={pending}
          className="usage-reset-modal"
          ariaLabelledby={`usage-reset-title-${account}`}
          initialFocusRef={cancelRef}
        >
          <h2 id={`usage-reset-title-${account}`}>Use an earned reset for {account}?</h2>
          <p>This consumes one earned reset credit for this Codex account. Each credit can be used only once.</p>
          {result ? <p className={result.ok ? "banner" : "banner warn"} role="status">{resetOutcomeMessage(result)}</p> : null}
          <div className="modal-actions">
            <button ref={cancelRef} className="btn ghost" type="button" onClick={() => setOpen(false)} disabled={pending}>
              {terminal ? "Close" : "Cancel"}
            </button>
            {!terminal ? (
              <AsyncButton className="btn primary" type="button" pending={pending} onClick={submit}>
                {result?.ok === false ? "Retry reset" : "Use reset"}
              </AsyncButton>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// Upstream reasons a Claude reset program is not offered, in plain words; an
// unlisted token falls back to its spaced form.
const CLAUDE_RESET_REASONS: Readonly<Record<string, string>> = {
  not_at_wall: "not at the 5-hour limit",
  tenure: "account too new",
  surface: "not offered to this client",
  tier: "not offered on this plan",
  seat: "not offered for this seat",
  mobile: "not offered on mobile",
  cli_version: "needs a newer Claude Code",
  weekly_limit: "weekly limit reached",
  no_weekly_limit: "no weekly limit on this plan",
  extra_usage: "extra usage is on",
  no_grant: "no granted resets",
  paused: "paused",
  cooldown: "cooling down",
  config_off: "not offered right now",
  other_experiment: "not offered right now",
  unavailable: "not offered right now",
  unknown: "not offered right now",
};

function claudeResetReason(reason: string | null): string | null {
  return reason === null ? null : CLAUDE_RESET_REASONS[reason] ?? reason.replace(/_/g, " ");
}

// Grants that have not expired; an expired grant can no longer be redeemed.
function liveGrants(status: ClaudeGrantedResets, now: number) {
  return status.grants.filter((grant) => grant.expires_at === null || grant.expires_at * 1000 > now);
}

function grantedCount(status: ClaudeGrantedResets, now: number): number {
  return liveGrants(status, now).reduce((total, grant) => total + grant.resets_left, 0);
}

// Soonest-first expiry countdowns of the live grants that still hold a reset.
function grantExpiries(status: ClaudeGrantedResets, now: number): string[] {
  return liveGrants(status, now)
    .filter((grant) => grant.resets_left > 0 && grant.expires_at !== null)
    .map((grant) => grant.expires_at as number)
    .sort((a, b) => a - b)
    .map((expiresAt) => formatResetCountdown(expiresAt, now));
}

function sessionResetStatus(status: ClaudeSessionReset | null, now: number): string {
  if (!status) return "Unknown";
  if (status.available) return "1 available this week";
  const reason = claudeResetReason(status.ineligible_reason);
  const next = status.next_available_at !== null && status.next_available_at * 1000 > now
    ? ` · next in ${formatResetCountdown(status.next_available_at, now)}`
    : "";
  return `Not available${reason ? ` · ${reason}` : ""}${next}`;
}

function grantedResetStatus(status: ClaudeGrantedResets | null, now: number): string {
  if (!status) return "Unknown";
  const count = grantedCount(status, now);
  const expiries = grantExpiries(status, now);
  const expiry = expiries.length > 0 ? ` · expire in ${expiries.join(", ")}` : "";
  if (status.available) return `${count} available${expiry}`;
  const cooldown = status.cooldown_until !== null && status.cooldown_until * 1000 > now
    ? ` · cooling down for ${formatResetCountdown(status.cooldown_until, now)}`
    : "";
  const reason = claudeResetReason(status.ineligible_reason);
  return count > 0
    ? `${count} granted · not usable now${reason ? ` · ${reason}` : ""}${cooldown}`
    : `None${reason ? ` · ${reason}` : ""}${cooldown}`;
}

function claudeResetOutcomeMessage(program: ClaudeLimitResetProgram, result: ClaudeLimitResetMutationResult, now: number): string {
  if (!result.ok) return result.error ?? "The reset request could not be completed. You can safely retry.";
  switch (result.outcome) {
    case "reset":
      if (program === "juniper_tide") return "Session limit reset. Usage still counts toward the weekly limit.";
      return result.resetsLeft === undefined
        ? "Granted reset used."
        : `Granted reset used. ${result.resetsLeft} left.`;
    case "already_used":
      return "That reset was already used, so nothing changed.";
    case "not_limited":
      return "This account is not at a usage limit, so nothing was used.";
    case "cooldown":
      return result.cooldownUntil === undefined
        ? "Resets are cooling down, so nothing was used. Try again later."
        : `Resets are cooling down for ${formatResetCountdown(result.cooldownUntil, now)}, so nothing was used.`;
    case "ineligible":
      return "This account is not eligible for this reset, so nothing was used.";
    case "unavailable":
      return "This reset is no longer available, so nothing was used.";
    default:
      return "The reset controller returned an unexpected result.";
  }
}

// Stays mounted while its program is unavailable so an open dialog keeps its
// outcome after the refresh that follows a redemption reports the program spent;
// only the trigger requires availability.
function ClaudeResetAction({
  account,
  alias,
  program,
  available,
  status,
  now,
  onReset,
}: {
  readonly account: string;
  readonly alias: string;
  readonly program: ClaudeLimitResetProgram;
  readonly available: boolean;
  readonly status: ClaudeLimitResets | null;
  readonly now: number;
  readonly onReset: ClaudeResetHandler;
}) {
  const [open, setOpen] = useState(false);
  // The confirmation copy is fixed when the dialog opens, not re-derived from
  // the status a later refresh delivers.
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ClaudeLimitResetMutationResult | null>(null);
  const keyRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const terminal = result?.ok === true && result.outcome !== undefined;
  const session = program === "juniper_tide";
  const describe = () => {
    if (session) {
      return "This clears the 5-hour session limit now. It cannot be undone, and usage still counts toward the weekly limit.";
    }
    const granted = status?.cedar_ember ?? null;
    const nextExpiry = granted ? grantExpiries(granted, now)[0] : undefined;
    return `This uses one of ${granted ? grantedCount(granted, now) : 0} granted resets${nextExpiry ? ` (next expires in ${nextExpiry})` : ""}. It cannot be undone.`;
  };
  const titleId = `usage-claude-reset-title-${program}-${account}`;
  const submit = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPending(true);
    keyRef.current ??= crypto.randomUUID();
    try {
      setResult(await onReset(account, program, keyRef.current));
    } catch {
      setResult({ ok: false, error: "The reset request could not be completed. You can safely retry." });
    } finally {
      inFlightRef.current = false;
      setPending(false);
    }
  };
  return (
    <>
      {available ? <button
        className="btn ghost usage-reset-trigger usage-claude-reset-trigger"
        type="button"
        aria-label={session ? `Use the session reset for ${alias}` : `Use a granted reset for ${alias}`}
        onClick={() => {
          keyRef.current = null;
          setResult(null);
          setDescription(describe());
          setOpen(true);
        }}
      >
        Use reset
      </button> : null}
      {open ? (
        <Modal
          onClose={() => setOpen(false)}
          busy={pending}
          className="usage-reset-modal"
          ariaLabelledby={titleId}
          initialFocusRef={cancelRef}
        >
          <h2 id={titleId}>{session ? `Use the weekly session reset for ${alias}?` : `Use a granted reset for ${alias}?`}</h2>
          <p>{description}</p>
          {result ? (
            <p className={result.ok ? "banner" : "banner warn"} role="status">{claudeResetOutcomeMessage(program, result, now)}</p>
          ) : null}
          <div className="modal-actions">
            <button ref={cancelRef} className="btn ghost" type="button" onClick={() => setOpen(false)} disabled={pending}>
              {terminal ? "Close" : "Cancel"}
            </button>
            {!terminal ? (
              <AsyncButton className="btn primary" type="button" pending={pending} onClick={submit}>
                {result?.ok === false ? "Retry reset" : "Use reset"}
              </AsyncButton>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

// Claude's weekly session reset and granted resets for one account. Unknown
// status (an older reader, or a missing/malformed upstream block) says so and
// never hides the usage windows above it.
function ClaudeLimitResetSection({
  status,
  account,
  alias,
  now,
  onReset,
}: {
  readonly status: ClaudeLimitResets | null | undefined;
  readonly account: string | null;
  readonly alias: string;
  readonly now: number;
  readonly onReset?: ClaudeResetHandler;
}) {
  const stop = {
    onClick: (event: { stopPropagation(): void }) => event.stopPropagation(),
    onKeyDown: (event: { key: string; stopPropagation(): void }) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    },
  };
  const known = status && (status.juniper_tide || status.cedar_ember) ? status : null;
  const canRedeem = account !== null && onReset !== undefined;
  const rows: ReadonlyArray<{
    readonly program: ClaudeLimitResetProgram;
    readonly label: string;
    readonly text: string;
    readonly available: boolean;
  }> = [
    { program: "juniper_tide", label: "Session reset", text: sessionResetStatus(known?.juniper_tide ?? null, now), available: known?.juniper_tide?.available === true },
    { program: "cedar_ember", label: "Granted resets", text: grantedResetStatus(known?.cedar_ember ?? null, now), available: known?.cedar_ember?.available === true },
  ];
  // Each program's action stays mounted at the same position whatever the
  // status, so a refresh that turns the status unknown cannot unmount an open
  // dialog (and its outcome and idempotency key) mid-redemption.
  const action = (row: (typeof rows)[number]) => canRedeem ? (
    <ClaudeResetAction
      key={row.program}
      account={account}
      alias={alias}
      program={row.program}
      available={row.available}
      status={known}
      now={now}
      onReset={onReset}
    />
  ) : null;
  return (
    <div className="usage-reset usage-claude-resets" {...stop}>
      {known ? <span className="usage-claude-resets-title">Limit resets</span> : (
        <span className="usage-reset-count">Limit resets · Reset status unknown</span>
      )}
      <ul className={known ? "usage-claude-reset-list" : "usage-claude-reset-list is-unknown"}>
        {rows.map((row) => (
          <li className="usage-claude-reset-row" key={row.program}>
            <span className="usage-claude-reset-text" hidden={!known}>
              <span className="usage-claude-reset-label">{row.label}</span><span className="usage-claude-reset-status">{row.text}</span>
            </span>
            {action(row)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProviderCard({
  provider,
  now,
  isDefault = false,
  switchable = false,
  pending = false,
  onSwitch,
  onReset,
  onClaudeReset,
}: ProviderCardProps) {
  const p = projectProviderUsageForDisplay(provider, now);
  const presentation = providerUsagePresentation(p, now);
  const account = p.account;
  const alias = usageAccountAlias(p);
  // Hosts are shown only as a fault: a per-host read with no account could not
  // name its login. Which hosts run a named account is not shown on the card;
  // the entry still carries them.
  const hosts = p.hosts ?? [];
  const hostAlert = hosts.length > 0 && account === null ? "Login unreadable on" : null;
  // Account controllers use the entry's token-free switch key.
  const switchKey = p.switch_key ?? null;
  const activate = () => {
    if (!switchKey || !onSwitch || isDefault || pending) return;
    void onSwitch(switchKey);
  };
  const defaults = useAccountDefaults();
  const switchCopy = isAccountProvider(p.provider) ? defaults[p.provider].switchLabels ?? {
    current: (name: string) => `Current default ${p.provider} account ${name}`,
    switching: (name: string) => `Switching default ${p.provider} account to ${name}`,
    set: (name: string) => `Set ${name} as the default ${p.provider} account`,
  } : null;
  const actionLabel = !account || !switchCopy
    ? undefined
    : isDefault
      ? switchCopy.current(account)
      : pending
        ? switchCopy.switching(account)
        : switchCopy.set(account);
  return (
    <li
      className={[
        "usage-provider",
        isDefault ? "usage-provider-default" : "",
        switchable ? "usage-provider-switchable" : "",
        pending ? "is-pending" : "",
      ].filter(Boolean).join(" ")}
    >
      {switchable ? (
        <button
          className="usage-provider-switch-control"
          type="button"
          aria-pressed={isDefault}
          aria-disabled={isDefault || pending ? true : undefined}
          aria-label={actionLabel}
          onClick={activate}
        />
      ) : null}
      <div className="usage-provider-head">
        <div className="usage-provider-id">
          <AgentBadge agent={p.provider} />
          <h2 className="usage-provider-title">{p.label}</h2>
          {/* codex reports one entry per account (all provider:"codex"); the badge
              stays the provider glyph and the account alias labels the card. A
              Claude alias keeps the signed-in email as its tooltip. */}
          {alias ? (
            <span className="usage-provider-account" title={alias !== p.account ? p.account ?? undefined : undefined}>
              {alias}
            </span>
          ) : null}
        </div>
        <div className="usage-provider-badges">
          {isDefault ? <span className="badge usage-default-badge">Default</span> : null}
          {p.plan ? <span className="badge">{p.plan}</span>
            : <span className="badge usage-plan-unknown" title="The provider did not report a plan">unknown</span>}
        </div>
      </div>
      {hostAlert ? (
        <div className="usage-provider-hosts warn" role="note">
          <span className="usage-provider-hosts-label">{hostAlert}</span>
          <ul aria-label="Hosts">
            {hosts.map((host) => <li className="usage-provider-host" key={host}>{host}</li>)}
          </ul>
        </div>
      ) : null}

      {presentation.kind !== "windows" ? (
        <div className="usage-current-state">
          <span className="usage-current-state-label">{!p.ok ? "Unavailable" : "Current check"}</span>
          <p className={`usage-note ${presentation.warn ? "warn" : ""}`}>
            {presentation.status ?? "No current usage data."}
          </p>
        </div>
      ) : (
        <div className="usage-windows">
          {p.windows.map((w) => (
            <WindowRow key={w.key} window={w} now={now} />
          ))}
        </div>
      )}

      {presentation.kind === "windows" && (p.stale || p.note || p.reason_code) ? (
        <p className={`usage-note ${presentation.warn ? "warn" : ""}`}>
          {presentation.status ?? "Usage may be stale."}
        </p>
      ) : null}

      {presentation.freshness ? <p className="usage-provider-updated">{presentation.freshness}</p> : null}
      {p.provider === "codex" && account && p.reset_credits && onReset ? (
        <CodexResetAction account={account} count={p.reset_credits.available_count} onReset={onReset} />
      ) : null}
      {p.provider === "claude" ? (
        <ClaudeLimitResetSection
          status={p.limit_resets}
          account={p.switch_key ?? null}
          alias={alias ?? p.label}
          now={now}
          onReset={onClaudeReset}
        />
      ) : null}
    </li>
  );
}

// How many placeholder cards to show while the first fetch is in flight. Matches
// the usual provider count closely enough to avoid a big layout jump on load.
const SKELETON_COUNT = 3;

// Layout-matched loading placeholder: reuses the real card classes so its size
// matches a loaded card, with shimmering `.sk` blocks where the badge / title /
// meters will land. Purely decorative — hidden from assistive tech (the list's
// aria-busy + the SR-only status announce loading instead).
function SkeletonCard() {
  return (
    <li className="usage-provider usage-skeleton" aria-hidden="true">
      <div className="usage-provider-head">
        <div className="usage-provider-id">
          <span className="sk sk-badge" />
          <span className="sk sk-title" />
        </div>
        <span className="sk sk-plan" />
      </div>
      <div className="usage-windows">
        {[62, 38].map((width, i) => (
          <div className="usage-window" key={i}>
            <div className="usage-window-head">
              <span className="sk sk-line sk-wlabel" />
              <span className="sk sk-line sk-wpct" />
            </div>
            <div className="usage-meter">
              <span className="sk sk-meter" style={{ width: `${width}%` }} />
            </div>
            <div className="usage-window-foot">
              <span className="sk sk-line sk-wfoot" />
            </div>
          </div>
        ))}
      </div>
    </li>
  );
}

export function UsagePanel({ onExit, canResetRateLimits = false }: UsagePanelProps) {
  const now = useSharedClock(true);
  const defaults = useAccountDefaults();

  const { usageProviders } = useUiExtensions();
  const selectProviders = useCallback((result: UsageResult) => usageProviders?.(result.providers) ?? result.providers, [usageProviders]);
  const rememberUsageSnapshot = useCallback((result: UsageResult) => {
    // Cache the successful snapshot for the next open (see usageCache above).
    if (!result.reachable) {
      return;
    }
    usageCache = { providers: result.providers, reachable: result.reachable, error: result.error ?? null };
  }, []);
  const usageState = useReachablePoll({
    fetcher: usage,
    selectData: selectProviders,
    delayMs: POLL_MS,
    initialData: usageCache?.providers ?? [],
    initialLoaded: usageCache !== null,
    initialReachable: usageCache?.reachable ?? true,
    initialError: usageCache?.error ?? null,
    retainDataWhenUnreachable: true,
    onSuccess: rememberUsageSnapshot,
  });
  // Present Claude before Codex (see orderUsageProviders); the reader payload's
  // order isn't guaranteed, so the page imposes its own.
  const providers = orderUsageProviders(usageState.data);
  const selections = {
    codex: usageCardSelection("codex", defaults.codex),
    claude: usageCardSelection("claude", defaults.claude),
  };
  const cardSelection = (p: ProviderUsage) =>
    isAccountProvider(p.provider) ? selections[p.provider](p) : { isDefault: false, switchable: false, pending: false };
  const claudeSelectable = providers.some((p) => p.provider === "claude" && cardSelection(p).switchable);
  // A default controller problem is reported for each provider the page shows.
  const shownAccountProviders = ACCOUNT_PROVIDERS.filter((provider) =>
    providers.some((p) => p.provider === provider));
  const redeemReset = useCallback(async (account: string, idempotencyKey: string) => {
    const result = await resetCodexRateLimit(account, idempotencyKey);
    if (result.ok && result.outcome) {
      await usageState.refresh(undefined, true);
    }
    return result;
  }, [usageState.refresh]);
  const redeemClaudeReset = useCallback(async (
    account: string,
    program: ClaudeLimitResetProgram,
    idempotencyKey: string,
  ) => {
    const result = await resetClaudeLimit(account, program, idempotencyKey);
    if (result.ok && result.outcome) {
      await usageState.refresh(undefined, true);
    }
    return result;
  }, [usageState.refresh]);

  // Cmd+; closes the panel too. The dashboard opens Usage with the same chord
  // (see dashboardShortcuts), but that handler is inactive while this overlay is
  // up — so handle the close here to make the shortcut a round-trip toggle.
  // macOS-app only, matching the dashboard shortcut layer; the browser keeps its
  // native shortcuts.
  useEffect(() => {
    if (!isMacTauri()) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === ";"
      ) {
        event.preventDefault();
        onExit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit]);

  return (
    <div className="dash usage-panel">
      <header className="dash-head">
        <button className="btn ghost" onClick={onExit} aria-label="Back to dashboard">
          ‹ Back
        </button>
        <h1>Usage</h1>
        <AsyncButton
          className="btn"
          onClick={async () => {
            await Promise.all([
              usageState.refresh(undefined, true),
              ...ACCOUNT_PROVIDERS.map((provider) => defaults[provider].refresh()),
            ]);
          }}
        >
          Refresh
        </AsyncButton>
      </header>

      <p className="usage-default-help">
        {claudeSelectable
          ? "Select a Claude or Codex card to make it that provider's default account for newly started sessions. Running sessions are unchanged."
          : "Select a Codex card to make it the default Codex account for newly started sessions. Running sessions are unchanged."}
      </p>
      {shownAccountProviders.map((provider) => {
        const control = defaults[provider];
        return control.loaded && !control.reachable ? (
          <HostReaderUnavailable
            key={provider}
            label={`${ACCOUNT_PROVIDER_LABELS[provider]} default account control`}
            error={control.error}
          />
        ) : control.error ? (
          <p className="banner warn" key={provider}>{control.error}</p>
        ) : null;
      })}

      {usageState.loaded && !usageState.reachable ? (
        <HostReaderUnavailable label="Usage" error={usageState.error} />
      ) : usageState.loaded && providers.length === 0 ? (
        <p className="banner">No usage data available.</p>
      ) : null}

      {/* SR-only status: the skeleton cards are aria-hidden, so announce loading here. */}
      {!usageState.loaded ? (
        <span className="sr-only" role="status">
          Loading usage…
        </span>
      ) : null}

      <ul className="usage-providers" aria-busy={!usageState.loaded}>
        {!usageState.loaded
          ? Array.from({ length: SKELETON_COUNT }, (_, i) => <SkeletonCard key={`sk-${i}`} />)
          : providers.map((p) => (
              <ProviderCard
                key={`${p.provider}:${p.switch_key ?? ""}:${p.account ?? ""}:${p.hosts?.join(",") ?? ""}`}
                provider={p}
                now={now}
                {...cardSelection(p)}
                onSwitch={isAccountProvider(p.provider) ? defaults[p.provider].switchAccount : undefined}
                onReset={canResetRateLimits ? redeemReset : undefined}
                onClaudeReset={canResetRateLimits ? redeemClaudeReset : undefined}
              />
            ))}
      </ul>
    </div>
  );
}
