import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { uiSource, uiStyles } from "./support/source.ts";

interface UsagePanelProps {
  readonly onExit: () => void;
}

// Minimal structural stand-in for the api ProviderUsage/UsageWindow shapes.
interface Win {
  key: string;
  label: string;
  used_percent: number | null;
  window_minutes: number | null;
  resets_at: number | null;
}
interface Provider {
  provider: string;
  account: string | null;
  label: string;
  ok: boolean;
  stale: boolean;
  plan: string | null;
  windows: Win[];
  updated_at: number | null;
  note: string | null;
  error: string | null;
  reason_code: string | null;
  reset_credits: { available_count: number } | null;
  hosts?: string[];
  profile?: string;
  switch_key?: string;
  limit_resets?: unknown;
}
interface ProviderCardProps {
  readonly provider: Provider;
  readonly now: number;
  readonly isDefault?: boolean;
  readonly switchable?: boolean;
  readonly pending?: boolean;
  readonly onSwitch?: (account: string) => Promise<void>;
  readonly onReset?: (account: string, idempotencyKey: string) => Promise<unknown>;
  readonly onClaudeReset?: (account: string, program: string, idempotencyKey: string) => Promise<unknown>;
}

const ssr = createUiSsrHarness();
const cleanupStack: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupStack.length > 0) await cleanupStack.pop()?.();
});

function installDom(): { readonly window: Window; readonly root: Root; readonly container: HTMLElement; cleanup(): Promise<void> } {
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  return {
    window,
    root,
    container,
    async cleanup() {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous);
    },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function loadModule() {
  return ssr.loadModule<{
    UsagePanel: ComponentType<UsagePanelProps>;
    ProviderCard: ComponentType<ProviderCardProps>;
  }>("/src/UsagePanel.tsx");
}

async function loadUsagePanel(): Promise<ComponentType<UsagePanelProps>> {
  return (await loadModule()).UsagePanel as ComponentType<UsagePanelProps>;
}

async function loadProviderCard(): Promise<ComponentType<ProviderCardProps>> {
  return (await loadModule()).ProviderCard as ComponentType<ProviderCardProps>;
}

const NOW = Date.parse("2026-07-05T00:00:00Z");

// Like the edge normalizer, a fixture names its switch key: the Codex nickname,
// or the Claude token-authority profile.
function provider(over: Partial<Provider> = {}): Provider {
  const entry: Provider = {
    provider: "codex",
    account: null,
    label: "Codex",
    ok: true,
    stale: false,
    plan: null,
    windows: [],
    updated_at: NOW / 1000,
    note: null,
    error: null,
    reason_code: null,
    reset_credits: null,
    ...over,
  };
  const switchKey = entry.switch_key ?? (entry.provider === "codex" ? entry.account ?? undefined : entry.profile);
  return switchKey === undefined ? entry : { ...entry, switch_key: switchKey };
}

function win(over: Partial<Win> = {}): Win {
  return { key: "5h", label: "5h", used_percent: 50, window_minutes: 300, resets_at: NOW / 1000 + 3600, ...over };
}

after(async () => {
  await ssr.close();
});

test("UsagePanel manual refresh requests a completed fresh snapshot", () => {
  const source = uiSource("UsagePanel.tsx");
  assert.match(
    source,
    /usageState\.refresh\(undefined, true\),\s*\.\.\.ACCOUNT_PROVIDERS\.map\(\(provider\) => defaults\[provider\]\.refresh\(\)\)/,
  );
});

// The initial (pre-fetch) render must read as LOADING, not empty: effects don't
// run under renderToStaticMarkup, so the first fetch has not resolved yet. It
// shows shimmering skeleton cards (layout-matched placeholders) + an aria-busy
// list + an SR-only status — never the "No usage data available." empty banner
// (only correct once a fetch completes with zero providers). Also uses its
// dedicated layout containers, not the dashboard's dense .tiles grid.
test("UsagePanel shows skeleton placeholders on first paint, not the empty banner", async () => {
  const UsagePanel = await loadUsagePanel();
  const html = renderComponent(UsagePanel, { onExit: () => {} });
  assert.match(html, /<h1>Usage<\/h1>/);
  assert.match(html, /class="usage-providers"/);
  // First paint = skeleton cards, an aria-busy list, and an SR-only status.
  assert.match(html, /usage-skeleton/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Loading usage/);
  // Never the empty / unreachable banners while still loading, and not a blank page.
  assert.doesNotMatch(html, /No usage data available\./);
  assert.doesNotMatch(html, /Usage is unavailable/);
  // The dense dashboard grid must not be reused for the provider cards.
  assert.doesNotMatch(html, /class="tiles"/);
});

// The SSR smoke test only reaches the loading skeleton (effects don't run, so
// the fetch never resolves and the data path never renders). Assert the
// Claude-first wiring at the source level — mirroring the Dashboard/HeaderUsage
// grep tests — so a silent revert to rendering usageState.data directly fails.
test("UsagePanel presents providers through the Claude-first ordering helper", () => {
  const source = uiSource("UsagePanel.tsx");
  assert.match(source, /orderUsageProviders,/);
  assert.match(source, /projectProviderUsageForDisplay,/);
  assert.match(source, /providerUsagePresentation,/);
  assert.match(source, /orderUsageProviders\(usageState\.data\)/);
  assert.match(source, /const p = projectProviderUsageForDisplay\(provider, now\)/);
  assert.match(source, /const now = useSharedClock\(true\)/);
  assert.doesNotMatch(source, /setInterval/);
});

// ProviderCard holds the numeric presentation logic (remaining-capacity
// threshold, clamp, and text) that the SSR panel smoke test can't reach.
async function cardHtml(over: Partial<Provider>): Promise<string> {
  return cardHtmlAt(over, NOW);
}

async function cardHtmlAt(over: Partial<Provider>, now: number): Promise<string> {
  const ProviderCard = await loadProviderCard();
  return renderComponent(ProviderCard, { provider: provider(over), now });
}

test("Codex ProviderCard marks the authoritative default and exposes accessible switch actions", async () => {
  const ProviderCard = await loadProviderCard();
  const current = renderComponent(ProviderCard, {
    provider: provider({ account: "sym" }),
    now: NOW,
    isDefault: true,
    switchable: true,
    onSwitch: async () => {},
  });
  assert.match(current, /usage-provider-default/);
  assert.match(current, /Default/);
  assert.match(current, /aria-pressed="true"/);
  assert.match(current, /Current default codex account sym/);

  const choice = renderComponent(ProviderCard, {
    provider: provider({ account: "account-tertiary" }),
    now: NOW,
    isDefault: false,
    switchable: true,
    onSwitch: async () => {},
  });
  assert.match(choice, /aria-pressed="false"/);
  assert.match(choice, /Set account-tertiary as the default codex account/);
});

test("Codex ProviderCard shows earned resets as a separate explicit action", async () => {
  const ProviderCard = await loadProviderCard();
  const html = renderComponent(ProviderCard, {
    provider: provider({ account: "sym", reset_credits: { available_count: 2 } }),
    now: NOW,
    onReset: async () => ({}),
  });
  assert.match(html, /2 resets available/);
  assert.match(html, /Use a reset for sym/);
});

test("Usage reset controls retain the surrounding modal Escape and boundary Tab behavior", async () => {
  const ProviderCard = await loadProviderCard();
  const { Modal } = await ssr.loadModule<{ Modal: ComponentType<Record<string, unknown>> }>("/src/Modal.tsx");
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  let closes = 0;
  await act(async () => mounted.root.render(createElement(Modal,
    { onClose: () => { closes += 1; } },
    createElement("button", { type: "button", "data-testid": "back" }, "Back"),
    createElement("ul", null, createElement(ProviderCard, {
      provider: provider({ account: "fixture", reset_credits: { available_count: 1 } }),
      now: NOW, onReset: async () => ({ ok: true }),
    })),
  )));
  const reset = mounted.container.querySelector<HTMLElement>(".usage-reset-trigger");
  const back = mounted.container.querySelector<HTMLElement>('[data-testid="back"]');
  assert.ok(reset);
  assert.ok(back);
  reset.focus();
  await act(async () => reset.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  assert.equal(mounted.window.document.activeElement === back, true, "Tab from the last reset trigger wraps to Back");
  await act(async () => back.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(mounted.window.document.activeElement === reset, true, "reverse Tab returns to the last reset trigger");
  await act(async () => reset.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(closes, 1, "Escape from reset controls dismisses the page");
});

test("Codex ProviderCard keeps account switching and reset redemption as sibling controls", async () => {
  const ProviderCard = await loadProviderCard();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const switches: string[] = [];
  await act(async () => {
    mounted.root.render(createElement(ProviderCard, {
      provider: provider({ account: "sym", reset_credits: { available_count: 1 } }),
      now: NOW,
      switchable: true,
      onSwitch: async (account: string) => { switches.push(account); },
      onReset: async () => ({ ok: true, outcome: "reset" }),
    }));
  });
  const switchControl = mounted.container.querySelector<HTMLButtonElement>(".usage-provider-switch-control");
  const resetControl = mounted.container.querySelector<HTMLButtonElement>(".usage-reset-trigger");
  assert.ok(switchControl);
  assert.ok(resetControl);
  assert.equal(switchControl.contains(resetControl), false);
  assert.equal(resetControl.contains(switchControl), false);

  await act(async () => switchControl.click());
  assert.deepEqual(switches, ["sym"]);
  await act(async () => resetControl.click());
  assert.deepEqual(switches, ["sym"], "opening reset must not switch the account");
  assert.ok(mounted.container.querySelector(".usage-reset-modal"));
});

test("Codex ProviderCard distinguishes zero from unknown without offering redemption", async () => {
  const ProviderCard = await loadProviderCard();
  const zero = renderComponent(ProviderCard, {
    provider: provider({ account: "sym", reset_credits: { available_count: 0 } }),
    now: NOW,
    onReset: async () => ({}),
  });
  assert.match(zero, /0 resets available/);
  assert.doesNotMatch(zero, /Use a reset for sym/);
  const unknown = renderComponent(ProviderCard, {
    provider: provider({ account: "sym", reset_credits: null }),
    now: NOW,
    onReset: async () => ({}),
  });
  assert.doesNotMatch(unknown, /resets available/);
});

test("Codex reset confirmation defaults to cancel, dedupes clicks, and reuses its UUID on retry", async () => {
  const ProviderCard = await loadProviderCard();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const first = deferred<unknown>();
  const keys: string[] = [];
  await act(async () => {
    mounted.root.render(createElement(ProviderCard, {
      provider: provider({ account: "sym", reset_credits: { available_count: 2 } }),
      now: NOW,
      onReset: async (_account: string, key: string) => {
        keys.push(key);
        if (keys.length === 1) return first.promise;
        return { ok: true, outcome: "already_redeemed" };
      },
    }));
  });
  const click = async (button: Element | null) => {
    await act(async () => button?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true })));
  };
  await click(mounted.container.querySelector(".usage-reset-trigger"));
  const buttons = () => [...mounted.container.querySelectorAll(".usage-reset-modal button")];
  const named = (label: string) => buttons().find((button) => button.textContent?.trim() === label) ?? null;
  assert.ok(mounted.window.document.activeElement === named("Cancel"), "Cancel receives initial focus");

  await act(async () => {
    const confirm = named("Use reset");
    confirm?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    confirm?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.equal(keys.length, 1, "duplicate confirmation sends one request");
  await act(async () => {
    first.resolve({ ok: false, error: "temporary failure" });
    await Promise.resolve();
  });
  await click(named("Retry reset"));
  assert.equal(keys.length, 2);
  assert.equal(keys[1], keys[0], "transport retry reuses the same logical-attempt UUID");
  assert.match(mounted.container.textContent ?? "", /already completed safely/);
});

test("UsagePanel wires provider default state without implying running-session mutation", () => {
  const source = uiSource("UsagePanel.tsx");
  assert.match(source, /useAccountDefaults/);
  assert.match(source, /Running sessions are unchanged/);
  assert.match(source, /usageCardSelection\("codex", defaults\.codex\)/);
  assert.match(source, /switchAccount/);
});

test("UsagePanel refreshes authoritative usage after each terminal reset outcome", () => {
  const source = uiSource("UsagePanel.tsx");
  assert.match(source, /const result = await resetCodexRateLimit\(account, idempotencyKey\)/);
  assert.match(source, /if \(result\.ok && result\.outcome\) \{\s*await usageState\.refresh\(undefined, true\)/s);
});

test("ProviderCard meter level matches the shared remaining-capacity thresholds", async () => {
  const at = async (usedPercent: number) => cardHtml({ windows: [win({ used_percent: usedPercent })] });
  assert.match(await at(0), /usage-meter-fill plenty/);
  assert.match(await at(20), /usage-meter-fill plenty/);
  assert.match(await at(21), /usage-meter-fill good/);
  assert.match(await at(40), /usage-meter-fill good/);
  assert.match(await at(41), /usage-meter-fill fair/);
  assert.match(await at(60), /usage-meter-fill fair/);
  assert.match(await at(61), /usage-meter-fill low/);
  assert.match(await at(80), /usage-meter-fill low/);
  assert.match(await at(81), /usage-meter-fill critical/);
  assert.match(await at(99), /usage-meter-fill critical/);
  assert.match(await at(100), /usage-meter-fill empty/);
});

test("ProviderCard clamps the remaining meter width to 0-100% and renders capacity text", async () => {
  assert.match(await cardHtml({ windows: [win({ used_percent: null })] }), /width:\s*0%/);
  assert.match(await cardHtml({ windows: [win({ used_percent: -5 })] }), /width:\s*100%/);
  assert.match(await cardHtml({ windows: [win({ used_percent: 105 })] }), /width:\s*0%/);
  // Unknown capacity renders "—"; a fractional consumed percentage converts
  // to the same rounded remaining value in text and accessibility output.
  assert.match(await cardHtml({ windows: [win({ used_percent: null })] }), /—/);
  assert.match(await cardHtml({ windows: [win({ used_percent: null })] }), /aria-label="5h remaining unknown"/);
  assert.match(await cardHtml({ windows: [win({ used_percent: 86.4 })] }), /14%/);
  assert.match(await cardHtml({ windows: [win({ used_percent: 86.4 })] }), /aria-label="5h 14% left"/);
});

test("ProviderCard renders the reset countdown for a window", async () => {
  const html = await cardHtml({ windows: [win({ resets_at: NOW / 1000 + (2 * 60 + 14) * 60 })] });
  assert.match(html, /resets in 2h 14m/);
});

test("ProviderCard shows the error for an ok:false provider", async () => {
  const html = await cardHtml({ ok: false, error: "no rollout files found" });
  assert.match(html, /no rollout files found/);
});

test("ProviderCard turns a normalized reason into an actionable fallback message", async () => {
  const html = await cardHtml({
    provider: "claude",
    label: "Claude",
    ok: false,
    reason_code: "organization_disabled",
    error: null,
  });
  assert.match(html, /Your organization has disabled Claude access/);
  assert.match(html, /company admin/);
});

test("ProviderCard labels expired empty-window state and last success without rendering a percentage", async () => {
  const html = await cardHtml({
    provider: "claude",
    label: "Claude",
    stale: true,
    windows: [],
    updated_at: NOW / 1000 - 7 * 60 * 60,
    reason_code: "rate_limited",
  });
  assert.match(html, /usage-note warn/);
  assert.match(html, /Current check/);
  assert.match(html, /temporarily rate limited/);
  assert.match(html, /last success 7h ago/);
  assert.doesNotMatch(html, /\d+%/);
});

test("ProviderCard removes retained windows at 600 seconds during a reachable poll gap", async () => {
  const retained = {
    provider: "codex",
    label: "Codex",
    windows: [win({ used_percent: 81 })],
    updated_at: NOW / 1000 - 599,
    note: "Last successful quota check",
  } satisfies Partial<Provider>;

  const bounded = await cardHtmlAt(retained, NOW);
  const expired = await cardHtmlAt({ ...retained, updated_at: NOW / 1000 - 600 }, NOW);

  assert.match(bounded, /19%/);
  assert.doesNotMatch(expired, /19%/);
  assert.match(expired, /Current check/);
  assert.match(expired, /Last successful quota check/);
  assert.match(expired, /last success 10m ago/);
});

test("ProviderCard renders safely when updated_at is non-finite or outside the Date range", async () => {
  const invalidTimestamps = [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE];

  for (const updatedAt of invalidTimestamps) {
    const html = await cardHtmlAt({
      provider: "codex",
      label: "Codex",
      windows: [win({ used_percent: 81 })],
      updated_at: updatedAt,
      note: "Last safe quota context",
      error: "Usage reader is unreachable",
      reason_code: "service_unavailable",
    }, NOW);

    assert.doesNotMatch(html, /19%/);
    assert.match(html, /Current check/);
    assert.match(html, /Codex usage is unavailable right now/);
    assert.doesNotMatch(html, /last success|Invalid Date|NaN|Infinity/i);
  }
});

test("ProviderCard keeps fresh successful empty usage neutral and current", async () => {
  const html = await cardHtml({
    provider: "claude",
    label: "Claude",
    stale: false,
    windows: [],
    updated_at: NOW / 1000 - 120,
  });
  assert.match(html, /Current check/);
  assert.match(html, /No usage windows reported/);
  assert.match(html, /checked 2m ago/);
  assert.doesNotMatch(html, /Expired|last success|No current data/i);
  assert.doesNotMatch(html, /\d+%/);
});

test("ProviderCard shows the account nickname next to the title when present, omits it otherwise", async () => {
  const withAccount = await cardHtml({ account: "account-secondary", plan: "pro", windows: [win()] });
  assert.match(withAccount, /class="usage-provider-account">account-secondary</);
  const noAccount = await cardHtml({ account: null, windows: [win()] });
  assert.doesNotMatch(noAccount, /usage-provider-account/);
});

// #937: a new Codex account's card showed no plan at all; show the reported plan, else say it is unknown.
test("ProviderCard shows the reported plan, and an unknown plan badge when none is reported", async () => {
  const reported = await cardHtml({ account: "account-b", plan: "plus", windows: [win()] });
  assert.match(reported, /<span class="badge">plus<\/span>/);
  assert.doesNotMatch(reported, /usage-plan-unknown/);
  const missing = await cardHtml({ account: "account-b", plan: null, windows: [win()] });
  assert.match(missing, /<span class="badge usage-plan-unknown" title="The provider did not report a plan">unknown<\/span>/);
});

test("ProviderCard labels a Claude account by its alias and keeps the email as the tooltip", async () => {
  const html = await cardHtml({ provider: "claude", label: "Claude", account: "max@example.com", switch_key: "20X", windows: [win()] });
  assert.match(html, /class="usage-provider-account" title="max@example\.com">20X</);
  const noProfile = await cardHtml({ provider: "claude", label: "Claude", account: "team@example.com", windows: [win()] });
  assert.match(noProfile, /class="usage-provider-account">team@example\.com</);
});

test("ProviderCard surfaces updated_at freshness when present, omits it when null", async () => {
  const shown = await cardHtml({ updated_at: NOW / 1000 - 120, windows: [win()] });
  assert.match(shown, /class="usage-provider-updated">updated 2m ago/);
  const hidden = await cardHtml({ updated_at: null, windows: [win()] });
  assert.doesNotMatch(hidden, /usage-provider-updated/);
});

for (const [kind, label] of [["claude", "Claude"], ["codex", "Codex"]] as const) {
  test(`${label} ProviderCard shows no host row while hosts run the default`, async () => {
    const ProviderCard = await loadProviderCard();
    const onDefault = renderComponent(ProviderCard, {
      provider: provider({ provider: kind, label, account: "account-secondary", switch_key: "account-secondary", hosts: ["summit", "cedar", "mesa"], windows: [win()] }),
      now: NOW,
      isDefault: true,
    });
    assert.doesNotMatch(onDefault, /usage-provider-hosts/);
    const unused = renderComponent(ProviderCard, {
      provider: provider({ provider: kind, label, account: "spare", switch_key: "spare", windows: [win()] }),
      now: NOW,
    });
    assert.doesNotMatch(unused, /usage-provider-hosts|Not in use|Signed in on/);
  });

  test(`${label} ProviderCard does not name hosts that run a non-default account`, async () => {
    const ProviderCard = await loadProviderCard();
    const drifted = renderComponent(ProviderCard, {
      provider: provider({ provider: kind, label, account: "spare", switch_key: "spare", hosts: ["cedar", "mesa"], windows: [win()] }),
      now: NOW,
    });
    assert.doesNotMatch(drifted, /usage-provider-hosts|Active instead of the default on/);
  });

  test(`${label} ProviderCard warns when a host login cannot be read`, async () => {
    const html = await cardHtml({ provider: kind, label, account: null, ok: false, reason_code: "unknown", hosts: ["mesa"] });
    assert.match(html, /<div class="usage-provider-hosts warn" role="note">/);
    assert.match(html, /<span class="usage-provider-hosts-label">Login unreadable on<\/span>/);
    assert.match(html, /<li class="usage-provider-host">mesa<\/li>/);
  });

  test(`${label} ProviderCard shows no host alert for a named account whose usage read failed`, async () => {
    const ProviderCard = await loadProviderCard();
    const failed = { ok: false, reason_code: "auth_expired", windows: [] };
    const onDefault = renderComponent(ProviderCard, {
      provider: provider({ provider: kind, label, account: "account-secondary", switch_key: "account-secondary", hosts: ["cedar"], ...failed }),
      now: NOW,
      isDefault: true,
    });
    assert.doesNotMatch(onDefault, /usage-provider-hosts/);
    const drifted = renderComponent(ProviderCard, {
      provider: provider({ provider: kind, label, account: "spare", switch_key: "spare", hosts: ["cedar"], ...failed }),
      now: NOW,
    });
    assert.doesNotMatch(drifted, /usage-provider-hosts/);
  });

  test(`${label} ProviderCard shows the unreadable alert and needs hosts for it`, async () => {
    const ProviderCard = await loadProviderCard();
    const unreadable = renderComponent(ProviderCard, {
      provider: provider({ provider: kind, label, account: null, ok: false, reason_code: "unknown", hosts: ["mesa"] }),
      now: NOW,
    });
    assert.match(unreadable, /Login unreadable on/);
    assert.doesNotMatch(unreadable, /Active instead of the default on/);
    const hostless = renderComponent(ProviderCard, {
      provider: provider({ provider: kind, label, account: null, windows: [win()] }),
      now: NOW,
    });
    assert.doesNotMatch(hostless, /usage-provider-hosts/);
  });
}

test("Usage cards name hosts only when a login is unreadable", () => {
  const source = uiSource("UsagePanel.tsx");
  assert.match(source, /Login unreadable on/);
  // A host on a non-default account is no longer called out on the card; the
  // per-entry hosts still arrive from the edge for later use.
  assert.doesNotMatch(source, /Active instead of the default on/);
  assert.doesNotMatch(source, /defaultKnown/);
});

test("UsagePanel keys cards by switch key, account and host list", () => {
  // Two Claude profiles signed in with the same email differ only by switch key.
  assert.match(
    uiSource("UsagePanel.tsx"),
    /key=\{`\$\{p\.provider\}:\$\{p\.switch_key \?\? ""\}:\$\{p\.account \?\? ""\}:\$\{p\.hosts\?\.join\(","\) \?\? ""\}`\}/,
  );
});

test("Claude ProviderCard marks the provider default and offers to switch by profile", async () => {
  const ProviderCard = await loadProviderCard();
  const shown = renderComponent(ProviderCard, {
    provider: provider({ provider: "claude", label: "Claude", account: "team@example.com", switch_key: "account-secondary", hosts: ["cedar"] }),
    now: NOW,
    isDefault: true,
    switchable: true,
    onSwitch: async () => {},
  });
  assert.match(shown, /<span class="badge usage-default-badge">Default<\/span>/);
  assert.match(shown, /aria-label="Current default claude account team@example.com"/);
  const other = renderComponent(ProviderCard, {
    provider: provider({ provider: "claude", label: "Claude", account: "max@example.com", switch_key: "account-primary" }),
    now: NOW,
    switchable: true,
    onSwitch: async () => {},
  });
  assert.match(other, /aria-label="Set max@example.com as the default claude account"/);
  assert.doesNotMatch(other, /usage-default-badge/);
});

test("Claude ProviderCard switches by profile and a card without one does nothing", async () => {
  const ProviderCard = await loadProviderCard();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const switches: string[] = [];
  const onSwitch = async (key: string) => { switches.push(key); };
  await act(async () => {
    mounted.root.render(createElement("ul", null,
      createElement(ProviderCard, {
        provider: provider({ provider: "claude", label: "Claude", account: "team@example.com", switch_key: "account-secondary" }),
        now: NOW,
        switchable: true,
        onSwitch,
      }),
      createElement(ProviderCard, {
        provider: provider({ provider: "claude", label: "Claude", account: "old@example.com", hosts: ["maple"] }),
        now: NOW,
        switchable: true,
        onSwitch,
      }),
    ));
  });
  const controls = mounted.container.querySelectorAll<HTMLButtonElement>(".usage-provider-switch-control");
  assert.equal(controls.length, 2);
  await act(async () => controls[0]?.click());
  await act(async () => controls[1]?.click());
  assert.deepEqual(switches, ["account-secondary"]);
});

test("Usage card badges stay on one line and the account chip truncates before the title", () => {
  const css = uiStyles();
  assert.match(css, /\.usage-provider-badges \{[^}]*flex-shrink: 0;/);
  assert.match(css, /\.usage-provider-badges \.badge \{[^}]*white-space: nowrap;/);
  assert.match(css, /\.usage-provider-title \{[^}]*flex-shrink: 0;/);
});

test("UsagePanel tells users a default reaches only newly started sessions, for either provider", () => {
  const source = uiSource("UsagePanel.tsx");
  assert.match(source, /Select a Claude or Codex card to make it that provider's default account for newly started sessions\. Running sessions are unchanged\./);
  assert.doesNotMatch(source, /next sign-in pull/);
});

// Claude limit resets (agent-console#651). Fixture states mirror the reader's
// normalized `limit_resets`: none available, the weekly session reset, and two
// granted resets.
const DAY = 86400;
const NONE_AVAILABLE = {
  juniper_tide: { available: false, ineligible_reason: "not_at_wall", resets_per_week: 1, next_available_at: null, weekly_resets_at: null },
  cedar_ember: { available: false, ineligible_reason: "tenure", grants: [], cooldown_until: null, weekly_resets_at: NOW / 1000 + 6 * DAY },
};
const SESSION_AVAILABLE = {
  juniper_tide: { available: true, ineligible_reason: null, resets_per_week: 1, next_available_at: null, weekly_resets_at: NOW / 1000 + 6 * DAY },
  cedar_ember: NONE_AVAILABLE.cedar_ember,
};
const TWO_GRANTS = {
  juniper_tide: NONE_AVAILABLE.juniper_tide,
  cedar_ember: {
    available: true,
    ineligible_reason: null,
    grants: [
      { label: "Launch week", resets_left: 1, resets_total: 1, starts_at: null, expires_at: NOW / 1000 + 11 * DAY, clears: ["five_hour"], usable_now: true },
      { label: null, resets_left: 1, resets_total: 1, starts_at: null, expires_at: NOW / 1000 + 29 * DAY, clears: ["five_hour", "seven_day"], usable_now: true },
    ],
    cooldown_until: null,
    weekly_resets_at: NOW / 1000 + 6 * DAY,
  },
};

function claude(over: Partial<Provider> = {}): Provider {
  return provider({ provider: "claude", label: "Claude", account: "max@example.com", switch_key: "20X", windows: [win()], ...over });
}

test("Claude ProviderCard explains why no limit reset is available", async () => {
  const ProviderCard = await loadProviderCard();
  const html = renderComponent(ProviderCard, { provider: claude({ limit_resets: NONE_AVAILABLE }), now: NOW, onClaudeReset: async () => ({}) });
  assert.match(html, /Limit resets/);
  assert.match(html, /Session reset/);
  assert.match(html, /Not available · not at the 5-hour limit/);
  assert.match(html, /Granted resets/);
  assert.match(html, /None · account too new/);
  assert.doesNotMatch(html, /usage-claude-reset-trigger/);
  assert.match(html, /usage-window/, "windows still render");
});

test("Claude ProviderCard offers the weekly session reset when it is available", async () => {
  const ProviderCard = await loadProviderCard();
  const html = renderComponent(ProviderCard, { provider: claude({ limit_resets: SESSION_AVAILABLE }), now: NOW, onClaudeReset: async () => ({}) });
  assert.match(html, /1 available this week/);
  assert.match(html, /aria-label="Use the session reset for 20X"/);
  assert.doesNotMatch(html, /Use a granted reset for 20X/);
});

test("Claude ProviderCard counts granted resets with their expiry", async () => {
  const ProviderCard = await loadProviderCard();
  const html = renderComponent(ProviderCard, { provider: claude({ limit_resets: TWO_GRANTS }), now: NOW, onClaudeReset: async () => ({}) });
  assert.match(html, /2 available · expire in 11d, 29d/);
  assert.match(html, /aria-label="Use a granted reset for 20X"/);
  assert.doesNotMatch(html, /Use the session reset for 20X/);
});

test("Claude ProviderCard reports unknown reset status without hiding usage", async () => {
  const ProviderCard = await loadProviderCard();
  for (const limitResets of [null, undefined, { juniper_tide: null, cedar_ember: null }]) {
    const html = renderComponent(ProviderCard, { provider: claude({ limit_resets: limitResets }), now: NOW, onClaudeReset: async () => ({}) });
    assert.match(html, /Reset status unknown/);
    assert.match(html, /usage-window/);
    assert.doesNotMatch(html, /usage-claude-reset-trigger/);
  }
  const partial = renderComponent(ProviderCard, {
    provider: claude({ limit_resets: { juniper_tide: SESSION_AVAILABLE.juniper_tide, cedar_ember: null } }),
    now: NOW,
    onClaudeReset: async () => ({}),
  });
  assert.match(partial, /1 available this week/);
  assert.match(partial, /Granted resets<\/span><span class="usage-claude-reset-status">Unknown/);
});

test("Claude reset actions need the reset permission and a token-authority profile", async () => {
  const ProviderCard = await loadProviderCard();
  const noPermission = renderComponent(ProviderCard, { provider: claude({ limit_resets: TWO_GRANTS }), now: NOW });
  assert.match(noPermission, /2 available/);
  assert.doesNotMatch(noPermission, /usage-claude-reset-trigger/);
  const noProfile = renderComponent(ProviderCard, {
    provider: claude({ switch_key: undefined, limit_resets: TWO_GRANTS }),
    now: NOW,
    onClaudeReset: async () => ({}),
  });
  assert.doesNotMatch(noProfile, /usage-claude-reset-trigger/);
  const codex = renderComponent(ProviderCard, { provider: provider({ account: "sym", limit_resets: TWO_GRANTS }), now: NOW, onClaudeReset: async () => ({}) });
  assert.doesNotMatch(codex, /Limit resets/);
});

test("Claude session reset confirmation warns it is irreversible and still counts weekly", async () => {
  const ProviderCard = await loadProviderCard();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const calls: Array<[string, string, string]> = [];
  const first = deferred<unknown>();
  await act(async () => {
    mounted.root.render(createElement(ProviderCard, {
      provider: claude({ limit_resets: SESSION_AVAILABLE }),
      now: NOW,
      switchable: true,
      onSwitch: async () => { throw new Error("must not switch"); },
      onClaudeReset: async (account: string, program: string, key: string) => {
        calls.push([account, program, key]);
        if (calls.length === 1) return first.promise;
        return { ok: true, program, outcome: "reset" };
      },
    }));
  });
  const click = async (button: Element | null | undefined) => {
    await act(async () => button?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true })));
  };
  await click(mounted.container.querySelector(".usage-claude-reset-trigger"));
  const modal = () => mounted.container.querySelector(".usage-reset-modal");
  assert.match(modal()?.textContent ?? "", /Use the weekly session reset for 20X\?/);
  assert.match(modal()?.textContent ?? "", /cannot be undone/);
  assert.match(modal()?.textContent ?? "", /still counts toward the weekly limit/);
  const named = (label: string) => [...(modal()?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === label);
  assert.ok(mounted.window.document.activeElement === named("Cancel"), "Cancel receives initial focus");
  await act(async () => {
    const confirm = named("Use reset");
    confirm?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    confirm?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.equal(calls.length, 1, "duplicate confirmation sends one request");
  assert.deepEqual(calls[0].slice(0, 2), ["20X", "juniper_tide"]);
  assert.match(calls[0][2], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await act(async () => {
    first.resolve({ ok: false, error: "temporary failure" });
    await Promise.resolve();
  });
  await click(named("Retry reset"));
  assert.equal(calls[1][2], calls[0][2], "retry reuses the same idempotency key");
  assert.match(modal()?.textContent ?? "", /Session limit reset/);
  assert.equal(named("Use reset") === undefined, true, "a terminal outcome offers only Close");
});

test("Claude granted reset confirmation names the count and next expiry", async () => {
  const ProviderCard = await loadProviderCard();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  await act(async () => {
    mounted.root.render(createElement(ProviderCard, {
      provider: claude({ limit_resets: TWO_GRANTS }),
      now: NOW,
      onClaudeReset: async (_account: string, program: string) => ({ ok: true, program, outcome: "not_limited" }),
    }));
  });
  await act(async () => mounted.container.querySelector(".usage-claude-reset-trigger")
    ?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true })));
  const text = mounted.container.querySelector(".usage-reset-modal")?.textContent ?? "";
  assert.match(text, /Use a granted reset for 20X\?/);
  assert.match(text, /uses one of 2 granted resets/);
  assert.match(text, /next expires in 11d/);
  assert.match(text, /cannot be undone/);
  assert.doesNotMatch(text, /weekly limit/);
  await act(async () => {
    [...mounted.container.querySelectorAll(".usage-reset-modal button")].find((b) => b.textContent?.trim() === "Use reset")
      ?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.match(mounted.container.textContent ?? "", /not at a usage limit, so nothing was used/);
});

test("UsagePanel refreshes authoritative usage after a terminal Claude reset outcome", () => {
  const source = uiSource("UsagePanel.tsx");
  assert.match(source, /const result = await resetClaudeLimit\(account, program, idempotencyKey\);\s*if \(result\.ok && result\.outcome\) \{\s*await usageState\.refresh\(undefined, true\);/s);
  assert.match(source, /onClaudeReset=\{canResetRateLimits \? redeemClaudeReset : undefined\}/);
});

for (const [name, refreshed, visible] of [
  ["reports the program spent", NONE_AVAILABLE, /Not available · not at the 5-hour limit/],
  ["leaves reset status unknown", { juniper_tide: null, cedar_ember: null }, /Reset status unknown/],
  ["drops reset status", null, /Reset status unknown/],
] as const) {
  test(`Claude reset outcome stays visible after the refresh ${name}`, async () => {
    const ProviderCard = await loadProviderCard();
    const mounted = installDom();
    cleanupStack.push(mounted.cleanup);
    const render = (limitResets: unknown) => mounted.root.render(createElement(ProviderCard, {
      provider: claude({ limit_resets: limitResets }),
      now: NOW,
      onClaudeReset: async (_account: string, program: string) => {
        // The panel awaits an authoritative refresh before resolving.
        await act(async () => render(refreshed));
        return { ok: true, program, outcome: "reset" };
      },
    }));
    await act(async () => render(SESSION_AVAILABLE));
    await act(async () => mounted.container.querySelector(".usage-claude-reset-trigger")
      ?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true })));
    await act(async () => {
      [...mounted.container.querySelectorAll(".usage-reset-modal button")].find((b) => b.textContent?.trim() === "Use reset")
        ?.dispatchEvent(new mounted.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    const modal = mounted.container.querySelector(".usage-reset-modal");
    assert.match(modal?.textContent ?? "", /Session limit reset/);
    assert.equal(modal?.closest("[hidden]") === null, true, "the open dialog has no hidden ancestor");
    assert.match(mounted.container.textContent ?? "", visible);
    assert.equal(mounted.container.querySelector(".usage-claude-reset-trigger") === null, true, "a spent program offers no new trigger");
  });
}

test("Claude granted resets ignore expired grants in the count and expiry", async () => {
  const ProviderCard = await loadProviderCard();
  const expired = { ...TWO_GRANTS.cedar_ember.grants[0], expires_at: NOW / 1000 - 60 };
  const html = renderComponent(ProviderCard, {
    provider: claude({ limit_resets: { ...TWO_GRANTS, cedar_ember: { ...TWO_GRANTS.cedar_ember, grants: [expired, TWO_GRANTS.cedar_ember.grants[1]] } } }),
    now: NOW,
    onClaudeReset: async () => ({}),
  });
  assert.match(html, /1 available · expire in 29d/);
  assert.doesNotMatch(html, /expire in now/);
});

test("ProviderCard drops retained Claude reset status with its expired windows", async () => {
  const ProviderCard = await loadProviderCard();
  const html = renderComponent(ProviderCard, {
    provider: claude({ updated_at: NOW / 1000 - 601, limit_resets: SESSION_AVAILABLE }),
    now: NOW,
    onClaudeReset: async () => ({}),
  });
  assert.match(html, /Reset status unknown/);
  assert.doesNotMatch(html, /usage-claude-reset-trigger/);
});


test("failed Codex accounts show unavailable with reasons beside selectable healthy accounts and Claude", async () => {
  const ProviderCard = await loadProviderCard();
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  const switches: string[] = [];
  const accounts = [
    provider({ account: "unpaid", ok: false, windows: [], reason_code: "billing_past_due" }),
    provider({ account: "disabled", ok: false, windows: [], reason_code: "organization_disabled" }),
    provider({ account: "expired", ok: false, windows: [], reason_code: "auth_expired" }),
    provider({ account: "unknown", ok: false, windows: [], reason_code: null, error: null }),
    provider({ account: "paid", switch_key: "paid", windows: [win(), win({ key: "weekly", label: "Weekly", resets_at: NOW / 1000 + 3600 })] }),
    claude(),
  ];
  await act(async () => mounted.root.render(createElement("ul", null, ...accounts.map((p) =>
    createElement(ProviderCard, { key: p.account, provider: p, now: NOW, switchable: p.account === "paid", onSwitch: async (key) => { switches.push(key); } }),
  ))));
  const cards = [...mounted.container.querySelectorAll(".usage-provider")];
  for (const card of cards.slice(0, 4)) assert.match(card.textContent ?? "", /Unavailable/);
  assert.match(cards[0].textContent ?? "", /payment is past due/);
  assert.match(cards[1].textContent ?? "", /disabled Codex access/);
  assert.match(cards[2].textContent ?? "", /sign-in has expired/);
  assert.match(cards[3].textContent ?? "", /Unknown error/i);
  assert.equal(cards[4].querySelectorAll(".usage-window").length, 2);
  assert.match(cards[4].textContent ?? "", /resets in/);
  assert.match(cards[5].textContent ?? "", /Claude/);
  assert.equal(cards[5].querySelectorAll(".usage-window").length, 1);
  await act(async () => cards[4].querySelector<HTMLButtonElement>("button")?.click());
  assert.deepEqual(switches, ["paid"]);
});


test("Command semicolon closes Usage while Command L does not", async () => {
  const mounted = installDom();
  cleanupStack.push(mounted.cleanup);
  Object.defineProperty(mounted.window, "__TAURI__", { value: {}, configurable: true });
  const UsagePanel = await loadUsagePanel();
  let exits = 0;
  await act(async () => { mounted.root.render(createElement(UsagePanel, { onExit: () => { exits += 1; } })); });
  await act(async () => { mounted.window.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: "l", metaKey: true })); });
  assert.equal(exits, 0);
  await act(async () => { mounted.window.dispatchEvent(new mounted.window.KeyboardEvent("keydown", { key: ";", metaKey: true })); });
  assert.equal(exits, 1);
});
