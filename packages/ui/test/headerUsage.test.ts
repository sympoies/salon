import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { Window } from "happy-dom";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  providerUsagePresentation,
  projectProviderUsageForDisplay,
  orderUsageProviders,
  usageCardSelection,
  headerUsageName,
  usageAccountAlias,
  pickHeaderUsage,
  providerUsageStatus,
  remainingUsagePercent,
  usageMeterLevel,
  shortWindowLabel,
  windowTitle,
} from "../src/headerUsageModel.ts";
import type { ProviderUsage, UsageWindow } from "../src/api.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";
import { uiSource, uiStyles } from "./support/source.ts";

function usageWindow(over: Partial<UsageWindow>): UsageWindow {
  return { key: "5h", label: "5h", used_percent: null, window_minutes: null, resets_at: null, ...over };
}

const componentSource = uiSource("HeaderUsage.tsx");
const dashboardSource = uiSource("Dashboard.tsx");
const css = uiStyles();
const ssr = createUiSsrHarness();

after(async () => {
  await ssr.close();
});

// Like the edge normalizer, a fixture names its switch key: the Codex nickname,
// or the Claude token-authority profile.
function provider(over: Partial<ProviderUsage>): ProviderUsage {
  const entry: ProviderUsage = {
    provider: "codex",
    account: null,
    label: "Codex",
    ok: true,
    stale: false,
    plan: null,
    windows: [],
    updated_at: null,
    note: null,
    error: null,
    reason_code: null,
    ...over,
  };
  const switchKey = entry.switch_key ?? (entry.provider === "codex" ? entry.account ?? undefined : entry.profile);
  return switchKey === undefined ? entry : { ...entry, switch_key: switchKey };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

test("pickHeaderUsage shows Claude and only the most-recently-updated codex account", () => {
  const claude = provider({ provider: "claude", label: "Claude", updated_at: 100 });
  const a1 = provider({ account: "acct-a", updated_at: 100 });
  const a2 = provider({ account: "acct-b", updated_at: 300 }); // most recent -> active
  const a3 = provider({ account: "acct-c", updated_at: 200 });
  const picked = pickHeaderUsage([a1, claude, a2, a3]);
  // Claude first, then the single active codex account.
  assert.deepEqual(
    picked.map((p) => `${p.provider}:${p.account ?? ""}`),
    ["claude:", "codex:acct-b"],
  );
});

test("pickHeaderUsage prefers the authoritative provider default over the recency heuristic", () => {
  const olderDefault = provider({ account: "acct-a", updated_at: 100 });
  const newerOther = provider({ account: "acct-b", updated_at: 300 });
  assert.deepEqual(
    pickHeaderUsage([newerOther, olderDefault], { codex: "acct-a" }).map((p) => p.account),
    ["acct-a"],
  );
});

test("orderUsageProviders sorts Claude ahead of Codex, then other providers", () => {
  const claude = provider({ provider: "claude", label: "Claude" });
  const c1 = provider({ account: "acct-a" });
  const c2 = provider({ account: "acct-b" });
  const other = provider({ provider: "gemini", label: "Gemini" });
  // Reader delivers Codex-first; the page must present Claude first.
  const ordered = orderUsageProviders([c1, other, claude, c2]);
  assert.deepEqual(
    ordered.map((p) => `${p.provider}:${p.account ?? ""}`),
    ["claude:", "codex:acct-a", "codex:acct-b", "gemini:"],
  );
});

test("orderUsageProviders is a stable, non-mutating sort", () => {
  // Rank-differing, pre-unsorted input with the equal-rank Codex pair split
  // around Claude, so both properties are load-bearing: a correct stable sort
  // moves Claude ahead while keeping acct-a before acct-b, and leaves the
  // caller's array untouched.
  const input = [
    provider({ account: "acct-a" }),
    provider({ provider: "claude", label: "Claude" }),
    provider({ account: "acct-b" }),
  ];
  const ordered = orderUsageProviders(input);
  assert.deepEqual(
    ordered.map((p) => `${p.provider}:${p.account ?? ""}`),
    ["claude:", "codex:acct-a", "codex:acct-b"],
  );
  // New array; the input keeps its original order.
  assert.notEqual(ordered, input);
  assert.deepEqual(
    input.map((p) => `${p.provider}:${p.account ?? ""}`),
    ["codex:acct-a", "claude:", "codex:acct-b"],
  );
});

test("orderUsageProviders tolerates reserved-word provider names without poisoning the sort", () => {
  // A malformed reader payload could name a provider "toString"/"constructor";
  // the Map-backed lookup must yield the default rank, not an inherited function,
  // so the comparator stays numeric and the entry sorts after known providers.
  const claude = provider({ provider: "claude", label: "Claude" });
  const weird = provider({ provider: "toString", label: "toString" });
  const codex = provider({ account: "acct-a" });
  const ordered = orderUsageProviders([weird, codex, claude]);
  assert.deepEqual(
    ordered.map((p) => p.provider),
    ["claude", "codex", "toString"],
  );
});

test("pickHeaderUsage tolerates missing providers and null timestamps", () => {
  assert.deepEqual(pickHeaderUsage([]), []);
  assert.equal(pickHeaderUsage([provider({ provider: "claude", account: null })]).length, 1);
  assert.equal(pickHeaderUsage([provider({ account: "x", updated_at: null })]).length, 1);
});

test("providerUsageStatus exposes safe error and stale-note context", () => {
  assert.equal(
    providerUsageStatus(provider({ ok: false, error: "token expired" })),
    "token expired",
  );
  assert.equal(
    providerUsageStatus(provider({ stale: true, note: "Claude refresh timed out" })),
    "Claude refresh timed out",
  );
  assert.equal(
    providerUsageStatus(provider({ windows: [usageWindow({ used_percent: 10 })] })),
    null,
  );
  assert.equal(
    providerUsageStatus(provider({
      provider: "codex",
      label: "Codex",
      ok: false,
      error: null,
      reason_code: "auth_expired",
    })),
    "Your Codex sign-in has expired. Sign in again.",
  );
});

test("expired empty-window usage exposes current state and last-success context without a percentage", () => {
  const expired = provider({
    provider: "claude",
    label: "Claude",
    stale: true,
    windows: [],
    updated_at: 1_784_000_000,
    reason_code: "rate_limited",
  });
  const now = 1_784_025_200_000;

  assert.deepEqual(providerUsagePresentation(expired, now), {
    kind: "expired",
    compactStatus: "Rate limited",
    status: "Claude usage is temporarily rate limited. Try again later.",
    freshness: "last success 7h ago",
    warn: true,
  });
});

test("fresh and bounded-stale windows keep the existing updated freshness wording", () => {
  const withWindows = provider({
    stale: true,
    windows: [usageWindow({ used_percent: 42 })],
    updated_at: 1_784_025_080,
  });
  assert.equal(providerUsagePresentation(withWindows, 1_784_025_200_000).freshness, "updated 2m ago");
});

test("fresh successful empty usage stays current and neutral", () => {
  const freshEmpty = provider({
    provider: "claude",
    label: "Claude",
    stale: false,
    windows: [],
    updated_at: 1_784_025_080,
  });
  const presentation = providerUsagePresentation(freshEmpty, 1_784_025_200_000);
  assert.deepEqual(presentation, {
    kind: "current-empty",
    compactStatus: "No windows",
    status: "No usage windows reported",
    freshness: "checked 2m ago",
    warn: false,
  });
  assert.doesNotMatch(`${presentation.compactStatus} ${presentation.freshness}`, /Expired|last success|No current data/i);
});

test("usage display projection expires windows at 600 seconds and fails closed on unsafe timestamps", () => {
  const now = 1_784_025_200_000;
  const retained = provider({
    provider: "claude",
    label: "Claude",
    windows: [usageWindow({ used_percent: 42 })],
    updated_at: now / 1000 - 599,
    note: "Last successful check retained during reader outage",
    error: "Usage reader is unreachable",
    reason_code: "service_unavailable",
  });

  assert.equal(projectProviderUsageForDisplay(retained, now).windows.length, 1);

  const expired = projectProviderUsageForDisplay({ ...retained, updated_at: now / 1000 - 600 }, now);
  assert.equal(expired.windows.length, 0);
  assert.equal(expired.stale, true);
  assert.equal(expired.note, retained.note);
  assert.equal(expired.error, retained.error);
  assert.equal(expired.reason_code, retained.reason_code);

  assert.equal(projectProviderUsageForDisplay({ ...retained, updated_at: now / 1000 + 5 }, now).windows.length, 1);
  assert.equal(projectProviderUsageForDisplay({ ...retained, updated_at: now / 1000 + 6 }, now).windows.length, 0);
  assert.equal(projectProviderUsageForDisplay({ ...retained, updated_at: null }, now).windows.length, 0);
  assert.equal(projectProviderUsageForDisplay({ ...retained, updated_at: Number.NaN }, now).windows.length, 0);
});

test("remainingUsagePercent converts consumed usage into a rounded, bounded capacity", () => {
  assert.equal(remainingUsagePercent(null), null);
  assert.equal(remainingUsagePercent(Number.NaN), null);
  assert.equal(remainingUsagePercent(0), 100);
  assert.equal(remainingUsagePercent(42.4), 58);
  assert.equal(remainingUsagePercent(100), 0);
  assert.equal(remainingUsagePercent(-5), 100);
  assert.equal(remainingUsagePercent(150), 0);
});

test("usageMeterLevel maps remaining capacity to codex-cli diag color bands", () => {
  assert.equal(usageMeterLevel(null), "");
  assert.equal(usageMeterLevel(0), "empty");
  assert.equal(usageMeterLevel(1), "critical");
  assert.equal(usageMeterLevel(19), "critical");
  assert.equal(usageMeterLevel(20), "low");
  assert.equal(usageMeterLevel(39), "low");
  assert.equal(usageMeterLevel(40), "fair");
  assert.equal(usageMeterLevel(59), "fair");
  assert.equal(usageMeterLevel(60), "good");
  assert.equal(usageMeterLevel(79), "good");
  assert.equal(usageMeterLevel(80), "plenty");
  assert.equal(usageMeterLevel(100), "plenty");

  for (const selector of ["hu-meter-fill", "usage-meter-fill"]) {
    assert.match(css, new RegExp(`\\.${selector}\\.empty \\{\\s*background: var\\(--meter-empty\\);`));
    assert.match(css, new RegExp(`\\.${selector}\\.plenty \\{\\s*background: var\\(--meter-plenty\\);`));
    assert.match(css, new RegExp(`\\.${selector}\\.good \\{\\s*background: var\\(--meter-good\\);`));
    assert.match(css, new RegExp(`\\.${selector}\\.fair \\{\\s*background: var\\(--meter-fair\\);`));
    assert.match(css, new RegExp(`\\.${selector}\\.low \\{\\s*background: var\\(--meter-low\\);`));
    assert.match(css, new RegExp(`\\.${selector}\\.critical \\{\\s*background: var\\(--meter-critical\\);`));
  }
});

test("shortWindowLabel abbreviates the weekly window and keeps others", () => {
  assert.equal(shortWindowLabel(usageWindow({ key: "weekly", label: "Weekly" })), "1w");
  assert.equal(shortWindowLabel(usageWindow({ key: "5h", label: "5h" })), "5h");
});

test("windowTitle names the window for the glyph tooltip", () => {
  assert.equal(windowTitle(usageWindow({ key: "weekly", label: "Weekly" })), "Weekly window");
  assert.equal(windowTitle(usageWindow({ key: "5h", label: "5h" })), "5h window");
  assert.equal(windowTitle(usageWindow({ key: "x", label: "Daily" })), "Daily window");
});

test("HeaderUsage renders 5h/weekly as gray clock/calendar glyphs", () => {
  assert.match(componentSource, /import \{ CalendarIcon, ClockIcon \} from "\.\/icons\.tsx";/);
  assert.match(componentSource, /w\.key === "5h" \? \(\s*<ClockIcon \/>/);
  assert.match(componentSource, /w\.key === "weekly" \? \(\s*<CalendarIcon \/>/);
  // Full name stays in the tooltip; short text remains the fallback for other keys.
  assert.match(componentSource, /title=\{windowTitle\(w\)\}/);
  assert.match(componentSource, /shortWindowLabel\(w\)/);
  assert.match(css, /\.hu-win-label \{\s*color: var\(--muted\);/);
  assert.match(css, /\.hu-win-label \.win-icon \{/);
});

test("HeaderUsage renders a compact, clickable usage readout", () => {
  assert.match(componentSource, /import \{ usage, type ProviderUsage, type UsageResult, type UsageWindow \} from "\.\/api\.ts";/);
  assert.match(componentSource, /useReachablePoll/);
  assert.match(componentSource, /pickHeaderUsage/);
  assert.match(componentSource, /usageMeterLevel/);
  assert.match(componentSource, /<AgentBadge agent=\{p\.provider\}/);
  assert.match(componentSource, /className="header-usage"/);
  assert.match(componentSource, /onClick=\{\(event\) => onOpen\(event\.currentTarget\)\}/);
  assert.match(componentSource, /providerUsagePresentation\(p, now\)/);
  assert.match(componentSource, /projectProviderUsageForDisplay\(provider, now\)/);
  assert.match(componentSource, /headerUsageAccessibleLabel\(shown, now\)/);
  assert.match(componentSource, /retainDataWhenUnreachable: true/);
  // Renders nothing when there is no usage to show, so the header stays clean.
  assert.match(componentSource, /if \(shown\.length === 0\)/);
  assert.match(css, /\.header-usage \{/);
});

test("rendered expired header exposes status and last success without a percent at narrow widths", async () => {
  const module = await ssr.loadModule<{
    HeaderUsageReadout: ComponentType<{
      readonly providers: readonly ProviderUsage[];
      readonly now: number;
      readonly onOpen: () => void;
    }>;
  }>("/src/HeaderUsage.tsx");
  const html = renderComponent(module.HeaderUsageReadout, {
    providers: [provider({
      provider: "claude",
      label: "Claude",
      stale: true,
      windows: [],
      updated_at: 1_784_000_000,
      reason_code: "rate_limited",
    })],
    now: 1_784_025_200_000,
    onOpen: () => {},
  });

  assert.match(html, /class="hu-state warn">Rate limited/);
  assert.match(html, /aria-label="[^"]*Claude[^"]*Rate limited[^"]*Last success 7h ago[^"]*Open Usage details/);
  assert.doesNotMatch(html, /\d+%/);
  assert.match(css, /\.hu-state \{[\s\S]*?max-width: 7\.5rem;[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;/);
});

test("retained header snapshot stops rendering percentages on the shared-clock 599-to-600 transition", async () => {
  const module = await ssr.loadModule<{
    HeaderUsageReadout: ComponentType<{
      readonly providers: readonly ProviderUsage[];
      readonly now: number;
      readonly onOpen: () => void;
    }>;
  }>("/src/HeaderUsage.tsx");
  const now = 1_784_025_200_000;
  const retained = provider({
    provider: "claude",
    label: "Claude",
    windows: [usageWindow({ used_percent: 42 })],
    updated_at: now / 1000 - 599,
    reason_code: "service_unavailable",
  });

  const bounded = renderComponent(module.HeaderUsageReadout, { providers: [retained], now, onOpen: () => {} });
  const expired = renderComponent(module.HeaderUsageReadout, {
    providers: [{ ...retained, updated_at: now / 1000 - 600 }],
    now,
    onOpen: () => {},
  });

  assert.match(bounded, />58%</);
  assert.doesNotMatch(expired, />58%</);
  assert.match(expired, /class="hu-state warn">Unavailable/);
  assert.match(expired, /Last success 10m ago/);
});

test("retained header renders safely when updated_at is non-finite or outside the Date range", async () => {
  const module = await ssr.loadModule<{
    HeaderUsageReadout: ComponentType<{
      readonly providers: readonly ProviderUsage[];
      readonly now: number;
      readonly onOpen: () => void;
    }>;
  }>("/src/HeaderUsage.tsx");
  const invalidTimestamps = [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE];

  for (const updatedAt of invalidTimestamps) {
    const html = renderComponent(module.HeaderUsageReadout, {
      providers: [provider({
        provider: "claude",
        label: "Claude",
        windows: [usageWindow({ used_percent: 42 })],
        updated_at: updatedAt,
        note: "Last safe reader context",
        error: "Usage reader is unreachable",
        reason_code: "service_unavailable",
      })],
      now: 1_784_025_200_000,
      onOpen: () => {},
    });

    assert.doesNotMatch(html, />58%</);
    assert.match(html, /class="hu-state warn">Unavailable/);
    assert.doesNotMatch(html, /Last success|Invalid Date|NaN|Infinity/);
  }
});

test("rendered header bounds visual and accessible windows to the same compact subset", async () => {
  const module = await ssr.loadModule<{
    HeaderUsageReadout: ComponentType<{
      readonly providers: readonly ProviderUsage[];
      readonly now: number;
      readonly onOpen: () => void;
    }>;
  }>("/src/HeaderUsage.tsx");
  const html = renderComponent(module.HeaderUsageReadout, {
    providers: [provider({
      provider: "claude",
      label: "Claude",
      windows: [
        usageWindow({ key: "5h", label: "5h", used_percent: 10 }),
        usageWindow({ key: "weekly", label: "Weekly", used_percent: 20 }),
        usageWindow({ key: "daily", label: "Daily", used_percent: 99 }),
      ],
      updated_at: 1_784_025_080,
    })],
    now: 1_784_025_200_000,
    onOpen: () => {},
  });

  assert.match(html, /aria-label="[^"]*5h 90% left[^"]*Weekly 80% left[^"]*Open Usage details/);
  assert.match(html, />90%<[^]*>80%</);
  assert.doesNotMatch(html, /Daily|99%/);
});

test("header and Usage page render the same remaining value, fill width, color, and accessible meaning", async () => {
  const headerModule = await ssr.loadModule<{
    HeaderUsageReadout: ComponentType<{
      readonly providers: readonly ProviderUsage[];
      readonly now: number;
      readonly onOpen: () => void;
    }>;
  }>("/src/HeaderUsage.tsx");
  const usageModule = await ssr.loadModule<{
    ProviderCard: ComponentType<{ readonly provider: ProviderUsage; readonly now: number }>;
  }>("/src/UsagePanel.tsx");
  const now = 1_784_025_200_000;
  const current = provider({
    windows: [usageWindow({ used_percent: 86 })],
    updated_at: now / 1000 - 120,
  });

  const headerHtml = renderComponent(headerModule.HeaderUsageReadout, {
    providers: [current],
    now,
    onOpen: () => {},
  });
  const pageHtml = renderComponent(usageModule.ProviderCard, { provider: current, now });

  assert.match(headerHtml, /aria-label="[^"]*5h 14% left/);
  assert.match(headerHtml, /class="hu-meter-fill critical" style="width:14%"/);
  assert.match(headerHtml, /class="hu-pct">14%/);
  assert.match(pageHtml, /class="usage-window-pct">14%/);
  assert.match(pageHtml, /aria-label="5h 14% left"/);
  assert.match(pageHtml, /class="usage-meter-fill critical" style="width:14%"/);
  assert.doesNotMatch(`${headerHtml}${pageHtml}`, /86%|used 14%/);
});

test("rendered compact header bounds and normalizes adversarial accessible text", async () => {
  const module = await ssr.loadModule<{
    HeaderUsageReadout: ComponentType<{
      readonly providers: readonly ProviderUsage[];
      readonly now: number;
      readonly onOpen: () => void;
    }>;
  }>("/src/HeaderUsage.tsx");
  const controls = "\u0000\t\n\u001f\u007f\u0085\u061c\u200e\u202e\u2066";
  const markup = 'ACCOUNT_\"<script>alert(1)</script>';
  const hugeAccount = `${markup}${controls}${"A".repeat(20_000)}`;
  const hugeWindow = (marker: string): string => `${marker}_${controls}${"W".repeat(20_000)}`;
  const privateError = `FREE_FORM_ERROR secret.person@example.com ${controls}${"E".repeat(20_000)}`;
  const privateNote = `PRIVATE_NOTE another.person@example.com ${controls}${"N".repeat(20_000)}`;
  const html = renderComponent(module.HeaderUsageReadout, {
    providers: [
      provider({
        provider: "claude",
        account: hugeAccount,
        label: `CLAUDE_LABEL_PRIVATE ${privateNote}`,
        ok: false,
        stale: true,
        error: privateError,
        note: privateNote,
        updated_at: 1_784_000_000,
      }),
      provider({
        provider: "codex",
        account: hugeAccount,
        label: `CODEX_LABEL_PRIVATE ${privateNote}`,
        windows: [
          usageWindow({ key: "first", label: hugeWindow("FIRST_WINDOW"), used_percent: 10 }),
          usageWindow({ key: "second", label: hugeWindow("SECOND_WINDOW"), used_percent: 20 }),
          usageWindow({ key: "third", label: hugeWindow("THIRD_WINDOW"), used_percent: 99 }),
        ],
        updated_at: 1_784_025_080,
        note: privateNote,
      }),
      provider({
        provider: "codex",
        account: "OLD_ACCOUNT_PRIVATE",
        windows: [usageWindow({ label: "OLD_WINDOW_PRIVATE", used_percent: 88 })],
        updated_at: 1,
      }),
    ],
    now: 1_784_025_200_000,
    onOpen: () => {},
  });

  const encodedLabel = html.match(/aria-label="([^"]*)"/)?.[1];
  assert.ok(encodedLabel, "rendered header must have an aria-label");
  const accessibleLabel = decodeHtmlAttribute(encodedLabel);

  assert.ok(accessibleLabel.length <= 512, `aria-label must be <= 512 characters, got ${accessibleLabel.length}`);
  assert.doesNotMatch(accessibleLabel, /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  assert.doesNotMatch(
    accessibleLabel,
    /FREE_FORM_ERROR|PRIVATE_NOTE|secret\.person@example\.com|another\.person@example\.com|CLAUDE_LABEL_PRIVATE|CODEX_LABEL_PRIVATE/,
  );
  assert.match(accessibleLabel, /^Usage\. Claude account /);
  assert.match(accessibleLabel, /Codex account /);
  assert.match(accessibleLabel, /FIRST_WINDOW[^.]*90% left/);
  assert.match(accessibleLabel, /SECOND_WINDOW[^.]*80% left/);
  assert.doesNotMatch(accessibleLabel, /THIRD_WINDOW|99%|OLD_ACCOUNT_PRIVATE|OLD_WINDOW_PRIVATE/);
  assert.match(accessibleLabel, /Open Usage details\.$/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("UsagePanel retains last-good providers across reader outages", () => {
  const usagePanelSource = uiSource("UsagePanel.tsx");
  assert.match(usagePanelSource, /if \(!result\.reachable\) \{\s*return;/);
  assert.match(usagePanelSource, /retainDataWhenUnreachable: true/);
});

test("HeaderUsage shows a live reset countdown per window", () => {
  assert.match(componentSource, /formatResetCountdown/);
  assert.match(componentSource, /className="hu-reset"/);
  // The shared 1s clock keeps countdowns live without a duplicate interval.
  assert.match(componentSource, /const now = useSharedClock\(true\)/);
  assert.doesNotMatch(componentSource, /setInterval/);
  assert.match(componentSource, /formatResetCountdown\(w\.resets_at, now\)/);
  // The countdown is plain text (no leading glyph); the flex gap spaces it.
  assert.doesNotMatch(componentSource, /↻/);
  assert.match(css, /\.hu-reset \{/);
});


test("Dashboard mounts the header usage widget wired to anchored Usage details", () => {
  assert.match(
    dashboardSource,
    /import \{ DashboardUsageProvider, HeaderUsage \} from "\.\/HeaderUsage\.tsx";/,
  );
  assert.match(dashboardSource, /<HeaderUsage onOpen=\{onUsage\} \/>/);
  // A principal without the usage permission gets 403 from /api/usage, so the
  // shared poll is gated on the same capability that mounts the widget.
  assert.match(
    dashboardSource,
    /<DashboardUsageProvider[^>]*?\s+enabled=\{operatorCapabilities\.usage\}/,
  );
  assert.match(componentSource, /export function DashboardUsageProvider/);
  assert.match(componentSource, /const usageState = useDashboardUsage\(\);/);
});

test("account inventories keep a machine's last good result through a failed refresh", async () => {
  const { reconcileAccountInventories } = await ssr.loadModule<typeof import("../src/sessionAccounts.ts")>(
    "/src/sessionAccounts.ts",
  );
  const sym = { accounts: [{ account: "sym", label: "Sym" }] };
  const retained = reconcileAccountInventories(
    { summit: sym, mesa: sym },
    [["summit", sym], ["mesa", null]],
  );
  assert.equal(retained.mesa?.accounts[0]?.account, "sym");
  // A machine no longer polled is dropped.
  assert.deepEqual(Object.keys(reconcileAccountInventories({ summit: sym, mesa: sym }, [["summit", null]])), ["summit"]);
});

test("prototype-key machine names reconcile as own inventory keys", async () => {
  const { reconcileAccountInventories } = await ssr.loadModule<typeof import("../src/sessionAccounts.ts")>(
    "/src/sessionAccounts.ts",
  );
  const prototypeNames = ["constructor", "__proto__", "toString"];
  const inventories = Object.fromEntries(prototypeNames.map((machine) => [
    machine,
    { accounts: [{ account: `account-${machine}`, label: machine }] },
  ]));
  const refreshed = reconcileAccountInventories({}, Object.entries(inventories));
  const retained = reconcileAccountInventories(inventories, prototypeNames.map((machine) => [machine, null]));
  const missing = reconcileAccountInventories({}, prototypeNames.map((machine) => [machine, null]));

  assert.deepEqual(Object.keys(missing), []);
  for (const machine of prototypeNames) {
    assert.equal(Object.hasOwn(refreshed, machine), true);
    assert.equal(Object.hasOwn(retained, machine), true);
  }
});

test("DashboardUsageProvider shares one retained poll across consumers", async () => {
  const module = await ssr.loadModule<{
    DashboardUsageProvider: ComponentType<{
      readonly children: ReactNode;
      readonly fetcher: () => Promise<{
        readonly providers: ProviderUsage[];
        readonly reachable: boolean;
        readonly error?: string;
      }>;
      readonly pollDelayMs: number;
    }>;
    useDashboardUsage: () => {
      readonly providers: readonly ProviderUsage[];
      readonly reachable: boolean;
      readonly loaded: boolean;
    };
  }>("/src/HeaderUsage.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const retained = provider({ account: "sym", windows: [usageWindow({ used_percent: 42 })] });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls === 1
      ? { providers: [retained], reachable: true }
      : { providers: [], reachable: false, error: "reader unavailable" };
  };
  const Consumer = ({ id }: { readonly id: string }) => {
    const snapshot = module.useDashboardUsage();
    return createElement("output", { "data-consumer": id }, JSON.stringify({
      loaded: snapshot.loaded,
      providers: snapshot.providers.map((item) => item.account),
      reachable: snapshot.reachable,
    }));
  };
  try {
    await act(async () => {
      root.render(createElement(
        module.DashboardUsageProvider,
        { fetcher, pollDelayMs: 50 },
        createElement(Consumer, { id: "one" }),
        createElement(Consumer, { id: "two" }),
      ));
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    assert.equal(calls, 1);
    const first = container.querySelector('[data-consumer="one"]')?.textContent ?? "";
    const second = container.querySelector('[data-consumer="two"]')?.textContent ?? "";
    assert.equal(first, second);
    assert.match(first, /"providers":\["sym"\]/);
    assert.match(first, /"reachable":true/);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 70));
    });
    assert.ok(calls >= 2);
    const retainedAfterOutage = container.querySelector('[data-consumer="one"]')?.textContent ?? "";
    assert.match(retainedAfterOutage, /"providers":\["sym"\]/);
    assert.match(retainedAfterOutage, /"reachable":false/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    window.close();
  }
});

test("DashboardUsageProvider never polls usage when the principal lacks it", async () => {
  const module = await ssr.loadModule<{
    DashboardUsageProvider: ComponentType<{
      readonly children: ReactNode;
      readonly enabled: boolean;
      readonly fetcher: () => Promise<{
        readonly providers: ProviderUsage[];
        readonly reachable: boolean;
      }>;
      readonly pollDelayMs: number;
    }>;
    useDashboardUsage: () => {
      readonly providers: readonly ProviderUsage[];
      readonly reachable: boolean;
    };
  }>("/src/HeaderUsage.tsx");
  const window = new Window({ url: "http://localhost" });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { providers: [], reachable: false };
  };
  const Consumer = () => {
    const snapshot = module.useDashboardUsage();
    return createElement("output", null, JSON.stringify({
      providers: snapshot.providers.length,
      reachable: snapshot.reachable,
    }));
  };
  try {
    await act(async () => {
      root.render(createElement(
        module.DashboardUsageProvider,
        { enabled: false, fetcher, pollDelayMs: 20 },
        createElement(Consumer),
      ));
      await new Promise((resolve) => window.setTimeout(resolve, 70));
    });
    assert.equal(calls, 0);
    assert.equal(container.querySelector("output")?.textContent, '{"providers":0,"reachable":true}');
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
    window.close();
  }
});

test("pickHeaderUsage shows the provider default Claude account and falls back to the first", () => {
  const max = provider({ provider: "claude", label: "Claude", account: "max@example.com", switch_key: "account-primary" });
  const team = provider({ provider: "claude", label: "Claude", account: "team@example.com", switch_key: "account-secondary" });
  const codex = provider({ account: "acct-a" });
  const claudeShown = (defaultProfile: string | null) =>
    pickHeaderUsage([max, team, codex], { codex: "acct-a", claude: defaultProfile }).find((p) => p.provider === "claude")?.account;
  assert.equal(claudeShown("account-secondary"), "team@example.com");
  assert.equal(claudeShown(null), "max@example.com");
  assert.equal(claudeShown("gone"), "max@example.com");
});

test("usageCardSelection marks a provider default and gates the switch by its switch key", () => {
  const legacy = provider({ provider: "claude", label: "Claude", account: "old@example.com", hosts: ["summit"] });
  const max = provider({ provider: "claude", label: "Claude", account: "max@example.com", switch_key: "account-primary", hosts: ["cedar", "mesa"] });
  const team = provider({ provider: "claude", label: "Claude", account: "team@example.com", switch_key: "account-secondary" });
  const codex = provider({ account: "acct-a" });
  const all = [max, team, legacy, codex];
  const defaults = { activeAccount: "account-primary", accounts: ["account-secondary", "account-primary"], reachable: true, pendingAccount: null };
  const select = usageCardSelection("claude", defaults);
  assert.equal(pickHeaderUsage(all, { codex: "acct-a", claude: "account-primary" })[0]?.account, "max@example.com");
  assert.deepEqual([max, team, legacy].map((p) => select(p)), [
    { switchable: true, isDefault: true, pending: false },
    { switchable: true, isDefault: false, pending: false },
    { switchable: false, isDefault: false, pending: false },
  ]);
  assert.equal(usageCardSelection("claude", { ...defaults, pendingAccount: "account-secondary" })(team).pending, true);
  assert.equal(select(codex).switchable, false);
  // The same rule selects Codex cards by nickname.
  const codexSelect = usageCardSelection("codex", { activeAccount: "acct-a", accounts: ["acct-a", "acct-b"], reachable: true, pendingAccount: "acct-b" });
  assert.deepEqual(codexSelect(codex), { switchable: true, isDefault: true, pending: false });
  assert.deepEqual(codexSelect(provider({ account: "acct-b" })), { switchable: true, isDefault: false, pending: true });
  assert.equal(codexSelect(max).switchable, false);
  // Unreachable controller or an unlisted switch_key: the default stays marked, nothing switches.
  const offline = usageCardSelection("claude", { ...defaults, reachable: false });
  assert.deepEqual(offline(max), { switchable: false, isDefault: true, pending: false });
  assert.equal(usageCardSelection("claude", { ...defaults, accounts: ["account-primary"] })(team).switchable, false);
});

test("the header names a Claude account by its alias, like a Codex nickname", () => {
  // The token-authority profile is the Claude alias; the first host and then the
  // email remain fallbacks for an entry that has no profile.
  assert.equal(headerUsageName(provider({ provider: "claude", label: "Claude", account: "max@example.com", switch_key: "20X", hosts: ["summit", "mesa"] })), "20X");
  assert.equal(headerUsageName(provider({ provider: "claude", label: "Claude", account: "team@example.com", hosts: ["cedar", "mesa"] })), "cedar");
  assert.equal(headerUsageName(provider({ provider: "claude", label: "Claude", account: "team@example.com" })), "team@example.com");
  assert.equal(headerUsageName(provider({ account: "account-secondary" })), "account-secondary");
});

test("Usage cards and the header label a Claude account with the same alias", () => {
  assert.equal(usageAccountAlias(provider({ provider: "claude", account: "max@example.com", switch_key: "20X" })), "20X");
  assert.equal(usageAccountAlias(provider({ provider: "claude", account: "team@example.com" })), "team@example.com");
  assert.equal(usageAccountAlias(provider({ provider: "codex", account: "account-tertiary" })), "account-tertiary");
  assert.equal(usageAccountAlias(provider({ provider: "claude", account: null })), null);
});

test("rendered header shows the provider default Claude account by alias", async () => {
  const module = await ssr.loadModule<{
    HeaderUsageReadout: ComponentType<{
      readonly providers: readonly ProviderUsage[];
      readonly now: number;
      readonly defaults?: { readonly claude?: string | null; readonly codex?: string | null };
      readonly onOpen: () => void;
    }>;
  }>("/src/HeaderUsage.tsx");
  const now = 1_784_000_000_000;
  const windows = [usageWindow({ key: "5h", label: "5h", used_percent: 10, resets_at: now / 1000 + 3600 })];
  const html = renderComponent(module.HeaderUsageReadout, {
    providers: [
      provider({ provider: "claude", label: "Claude", account: "max@example.com", switch_key: "account-primary", windows, updated_at: now / 1000 }),
      provider({ provider: "claude", label: "Claude", account: "team@example.com", switch_key: "account-secondary", hosts: ["cedar", "mesa"], windows, updated_at: now / 1000 }),
    ],
    now,
    defaults: { claude: "account-secondary" },
    onOpen: () => {},
  });
  assert.match(html, /class="hu-name">account-secondary</);
  assert.doesNotMatch(html, /team@example\.com|summit|>cedar</);
  assert.match(html, /aria-label="Usage\. Claude account account-secondary:/);
});

test("the Usage page and header read every provider default from the shared providers", () => {
  const panel = uiSource("UsagePanel.tsx");
  assert.match(panel, /const defaults = useAccountDefaults\(\);/);
  assert.match(panel, /onSwitch=\{isAccountProvider\(p\.provider\) \? defaults\[p\.provider\]\.switchAccount : undefined\}/);
  assert.match(componentSource, /defaults=\{\{ codex: defaults\.codex\.activeAccount, claude: defaults\.claude\.activeAccount \}\}/);
  assert.match(uiSource("App.tsx"), /<ExtensionAppProviders permissions=\{permissions\}>\{shell\}<\/ExtensionAppProviders>/);
  assert.doesNotMatch(uiSource("App.tsx"), /ClaudeDisplayAccount/);
});
