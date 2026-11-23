import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "vite";
import type { ProviderUsage } from "../src/api.ts";
import { hasHeadlessChrome } from "./support/browserLayout.ts";
import { launchPage } from "./support/browserPage.ts";

const now = 1_800_000_000_000;
const providers: ProviderUsage[] = [{
  provider: "claude", account: "sample", switch_key: "sample", label: "Claude", plan: "pro",
  ok: false, stale: false, retained: true, reason_code: "rate_limited",
  updated_at: now / 1000 - 20 * 60, backoff_until: now / 1000 + 15 * 60,
  note: null, error: null, reset_credits: null,
  windows: [
    { key: "5h", label: "Five-hour", used_percent: 44, window_minutes: 300, resets_at: now / 1000 - 60 },
    { key: "weekly", label: "Weekly", used_percent: 62, window_minutes: 10080, resets_at: now / 1000 + 86400 },
  ],
}, {
  provider: "codex", account: "sample", switch_key: "sample", label: "Codex", plan: "pro",
  ok: true, stale: false, reason_code: null, updated_at: now / 1000,
  note: null, error: null, reset_credits: null,
  windows: [{ key: "5h", label: "Five-hour", used_percent: 25, window_minutes: 300, resets_at: now / 1000 + 7200 }],
}];

const fixture = `
import { createElement as h, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrandTitle } from "/src/BrandTitle.tsx";
import { DashboardUsageContext, HeaderUsageReadout } from "/src/HeaderUsage.tsx";
import { HeaderMenu } from "/src/HeaderMenu.tsx";
import { IconButton } from "/src/IconButton.tsx";
import { PlusIcon } from "/src/icons.tsx";
import { updateHeaderCompaction } from "/src/headerResponsive.ts";
import { syncPhoneTier } from "/src/phoneTier.ts";
import { installTheme } from "/src/theme.ts";
import { SessionAccountBadge, SessionAccountQuota } from "/src/SessionAccountBadge.tsx";
import { SessionListNavigator } from "/src/SessionListNavigator.tsx";
import { CLEAR_SESSION_FILTERS } from "/src/sessionFilters.ts";
import { UsagePanel } from "/src/UsagePanel.tsx";
import { makeSession } from "/test/support/fixtures.ts";
const session = makeSession({ agent: "claude", claude_account: {
  schema_version: "agent-session.claude-account.v1", supported: true, state: "bound",
  selection_source: "explicit", selected_account: "sample", revision: 1, applied_runtime_id: "launch-hs-1",
} });
const noop = () => {};
function Fixture() {
  const [usageOpen, setUsageOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useLayoutEffect(() => {
    const header = document.querySelector(".workspace-head");
    if (header) updateHeaderCompaction(header);
  }, [usageOpen]);
  if (usageOpen) return h(UsagePanel, { onExit: () => setUsageOpen(false) });
  return h(DashboardUsageContext.Provider, { value: { providers: window.providers, reachable: true, loaded: true, error: null } },
    h("main", { className: "dash workspace-shell" },
      h("header", { className: "dash-head workspace-head" },
        h("div", { className: "workspace-head-start" }, h(BrandTitle, { onMarkClick: noop }),
          h(SessionListNavigator, { filters: CLEAR_SESSION_FILTERS, machines: [], harnesses: [], resultCount: 120,
            statusCounts: { working: 40, waiting: 50, attention: 10, unknown: 0, stopped: 20 }, countsAvailable: true,
            mobile: innerWidth <= 760, page: 1, pageCount: 5, open: false, onPageChange: noop, onChange: noop, onOpenChange: noop })),
        h(HeaderUsageReadout, { providers: window.providers, now: Date.now(), onOpen: () => setUsageOpen(true) }),
        h("div", { className: "dash-actions" }, h("div", { className: "dash-group dash-create-actions" },
          h(HeaderMenu, { open: menuOpen, onOpenChange: setMenuOpen, onUsage: () => setUsageOpen(true) }),
          h(IconButton, { preset: "standard", className: "btn dashboard-new-session", "aria-label": "New session" }, h(PlusIcon))))),
      h("div", { className: "dash-group", style: { alignSelf: "flex-start", marginTop: "1rem" } },
        h(SessionAccountBadge, { session, accounts: [], pending: false, onAccount: async () => {}, now: Date.now() }),
        h(SessionAccountQuota, { session, now: Date.now() }))));
}
installTheme().setMode(window.fixtureTheme);
syncPhoneTier();
createRoot(document.querySelector("#root")).render(h(Fixture));
`;

test("marked last-good usage stays visibly stale in quota views at desktop and phone widths", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const bundle = await build({
    configFile: false,
    root: new URL("..", import.meta.url).pathname,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: { conditions: ["source"] },
    plugins: [{
      name: "retained-usage-fixture",
      resolveId(id) { if (id.endsWith("retained-usage-fixture")) return "\0retained-usage-fixture"; },
      load(id) { if (id === "\0retained-usage-fixture") return fixture; },
    }],
    build: { write: false, lib: { entry: "retained-usage-fixture", name: "UsageFixture", formats: ["iife"] } },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  assert.ok(output && "output" in output);
  const code = output.output.find(chunk => chunk.type === "chunk")?.code;
  assert.ok(code);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const evidence = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;
  const page = await launchPage();
  try {
    for (const theme of ["dark", "paper"]) {
      for (const [width, height] of [[360, 800], [390, 844], [640, 900], [641, 900], [760, 900], [761, 900], [1280, 900]] as const) {
        await t.test(theme + " " + width + "×" + height, async () => {
          await page.setViewport(width, height, 1, width === 360 || width === 390);
          await page.navigate("data:text/html,<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><div id=root></div>");
          await page.evaluate(`
            window.fixtureTheme = ${JSON.stringify(theme)};
            document.head.insertAdjacentHTML("beforeend", ${JSON.stringify("<style>" + css + "</style>")});
            Date.now = () => ${now};
            window.providers = ${JSON.stringify(providers)};
            window.fetch = async path => {
              if (path !== "/api/usage") throw new Error("Unexpected fixture request: " + path);
              return Response.json({ ok: true, data: { providers: window.providers, reachable: true } });
            };
          `);
          await page.evaluate(code);
          const measurements = await page.evaluate<{
            width: number;
            theme: string;
            headerVisible: boolean;
            headerLabel: string;
            views: { label: string; text: string; values: string[]; bounded: boolean }[];
          }>(String.raw`
            (async () => {
              const waitFor = async selector => {
                for (let attempt = 0; attempt < 100; attempt++) {
                  const element = document.querySelector(selector);
                  if (element) return element;
                  await new Promise(resolve => setTimeout(resolve, 10));
                }
                throw new Error("Fixture did not render " + selector);
              };
              const measure = (label, element, valueSelector, noScroll = false) => {
                const box = element.getBoundingClientRect();
                const values = [...element.querySelectorAll(valueSelector)].filter(value => value.getBoundingClientRect().width);
                return {
                  label, text: element.innerText, values: values.map(value => value.innerText),
                  bounded: box.width > 0 && box.left >= -1 && box.right <= innerWidth + 1
                    && (!noScroll || (element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1))
                    && values.every(value => {
                      const rect = value.getBoundingClientRect();
                      return rect.left >= box.left - 1 && rect.right <= box.right + 1;
                    }),
                };
              };
              const header = await waitFor(".header-usage");
              const headerVisible = header.getBoundingClientRect().width > 0;
              const account = await waitFor(".account-usage-root > button");
              account.click();
              const popover = await waitFor(".account-usage-popover");
              return {
                width: innerWidth, theme: document.documentElement.dataset.theme, headerVisible,
                headerLabel: header.getAttribute("aria-label"),
                views: [
                  ...(headerVisible ? [measure("header", header.querySelector('[data-provider="claude"]'), ".hu-pct", true)] : []),
                  measure("focused session quota", document.querySelector(".session-quota"), ".hu-pct"),
                  measure("account popover", popover, ".account-usage-percent"),
                ],
              };
            })()
          `);
          if (evidence && (width === 390 || width === 1280)) {
            writeFileSync(join(evidence, "header-" + theme + "-" + width + ".png"), await page.screenshot());
          }
          const usage = await page.evaluate<{ label: string; text: string; values: string[]; bounded: boolean }>(String.raw`
            (async () => {
              const header = document.querySelector(".header-usage");
              if (header.getBoundingClientRect().width) {
                header.click();
              } else {
                document.querySelector(".header-menu-trigger").click();
                await new Promise(resolve => requestAnimationFrame(resolve));
                [...document.querySelectorAll(".header-menu-item")].find(item => item.textContent.trim() === "Usage").click();
              }
              for (let attempt = 0; attempt < 100; attempt++) {
                const card = document.querySelector('.usage-providers[aria-busy="false"] .usage-provider');
                if (card) return {
                  label: "Usage page", text: card.innerText,
                  values: [...card.querySelectorAll(".usage-window-pct")].map(value => value.innerText),
                  bounded: card.getBoundingClientRect().right <= innerWidth + 1 && card.scrollWidth <= card.clientWidth + 1,
                };
                await new Promise(resolve => setTimeout(resolve, 10));
              }
              throw new Error("Usage page did not load");
            })()
          `);
          if (evidence && (width === 390 || width === 1280)) {
            writeFileSync(join(evidence, "usage-" + theme + "-" + width + ".png"), await page.screenshot());
          }
          assert.equal(measurements.width, width);
          assert.equal(measurements.theme, theme);
          if (width !== 761) assert.equal(measurements.headerVisible, true, "the header still fits");
          assert.match(measurements.headerLabel, /Stale, 20m ago.*Refresh in 15m.*38% left/);
          for (const result of [...measurements.views, usage]) {
            assert.deepEqual(result.values, [result.label === "account popover" ? "38% left" : "38%"], result.label);
            assert.match(result.text, /stale[^\n]*20m ago/i, result.label);
            assert.match(result.text, /refresh in 15m/i, result.label);
            assert.equal(result.bounded, true, result.label + " fits the viewport: " + JSON.stringify(result));
          }
        });
      }
    }
  } finally {
    await page.close();
  }
});
