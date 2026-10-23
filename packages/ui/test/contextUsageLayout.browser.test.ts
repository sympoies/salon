import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import type { ComponentType } from "react";
import type { MobileSessionListProps } from "../src/MobileSessionList.tsx";
import type { SessionSlotProps } from "../src/SessionSlot.tsx";
import { makeSession, makeSessionSlotProps } from "./support/fixtures.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

const ssr = createUiSsrHarness([{
  name: "context-usage-terminal-mock",
  enforce: "pre",
  resolveId(source, importer) {
    return source.endsWith("TerminalPane.tsx") && importer?.includes("/src/") ? "\0context-usage-terminal-mock" : null;
  },
  load(id) {
    return id === "\0context-usage-terminal-mock" ? 'import React from "react"; export function TerminalPane(){return React.createElement("div");}' : null;
  },
}]);
after(async () => ssr.close());

test("context usage stays visible inside phone and desktop session card rows", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const usage = {
    used_tokens: 244000,
    window_tokens: 1000000,
    source: "codex-rollout" as const,
    observed_at: new Date().toISOString(),
    model: "claude-sonnet-5-5",
  };
  const [mobileModule, desktopModule] = await Promise.all([
    ssr.loadModule<{ MobileSessionList: ComponentType<MobileSessionListProps> }>("/src/MobileSessionList.tsx"),
    ssr.loadModule<{ SessionSlot: ComponentType<SessionSlotProps> }>("/src/SessionSlot.tsx"),
  ]);
  const renderMobile = (session: ReturnType<typeof makeSession>) => renderComponent(mobileModule.MobileSessionList, {
    sessions: [session], options: [session], editingTitleKey: null,
    beginTitleEdit() {}, saveTitleEdit: async () => {}, cancelTitleEdit() {}, onRetitle() {},
    onNewSession() {}, onSelectSession() {}, machineColors: {}, reachableMachineNames: new Set(["summit"]),
    activityDeliveryByMachine: new Map(), clockActive: false, resumingKey: null, autoResumePendingKey: null,
    accountPendingKey: null, accountsByProvider: { codex: {}, claude: {} }, initialScrollTop: 0,
    onScrollTopChange() {}, onOpen() {}, onResume() {}, onAutoResume: async () => true, onAccount: async () => {},
  });
  const rowCss = readFileSync(new URL("../src/sessionCardRows.css", import.meta.url), "utf8");

  for (const [width, mobileCard, model] of [[360, true, "claude-sonnet-5-5"], [360, true, "m".repeat(126)], [1200, false, "claude-sonnet-5-5"]] as const) {
    const session = makeSession({ id: `context-usage-${model.length}`, model, reasoning_effort: "high", context_usage: { ...usage, model } });
    const markup = mobileCard
      ? renderMobile(session)
      : `<div class="session-workspace desktop"><ol>${renderComponent(desktopModule.SessionSlot, makeSessionSlotProps({ session, options: [session], viewport: { mobile: false } }))}</ol></div>`;
    const measurement = measureUiMarkup<{
      text: string;
      title: string | null;
      rowWidth: number;
      rowScrollWidth: number;
      cardRight: number;
      badgeRight: number;
      badgeWidth: number;
      usageRight: number;
    }>(`<style>${rowCss}</style><main style="width:${width}px">${markup}</main>`, width, `
      const card = document.querySelector(${JSON.stringify(mobileCard ? ".mobile-session-card" : ".terminal-slot")});
      const row = card.querySelector(${JSON.stringify(mobileCard ? ".mobile-session-card-row-two" : ".slot-session-card-row-two")});
      const badge = row.querySelector('.session-model-badge');
      const usage = badge.querySelector('[data-context-usage]');
      const rowRect = row.getBoundingClientRect(), badgeRect = badge.getBoundingClientRect(), cardRect = card.getBoundingClientRect(), usageRect = usage.getBoundingClientRect();
      const result = {text:badge.textContent,title:badge.getAttribute('title'),rowWidth:rowRect.width,rowScrollWidth:row.scrollWidth,cardRight:cardRect.right,badgeRight:badgeRect.right,badgeWidth:badgeRect.width,usageRight:usageRect.right};
    `);
    assert.ok(measurement.text.includes(`${model} · high · 24% 244k/1M`), `${width}px card renders the usage text after model/effort`);
    assert.match(measurement.title ?? "", /Context usage: 244,000 \/ 1,000,000 tokens · codex-rollout/);
    assert.ok(measurement.badgeWidth > 0, `${width}px usage row stays visible`);
    assert.ok(measurement.badgeRight <= measurement.cardRight + 1, `${width}px usage text remains inside its card`);
    assert.ok(measurement.usageRight <= measurement.badgeRight + 2, `${width}px compact usage text is not clipped by model/effort: ${JSON.stringify(measurement)}`);
    assert.ok(measurement.rowScrollWidth <= measurement.rowWidth + 1, `${width}px card row has no horizontal overflow`);
  }
});
