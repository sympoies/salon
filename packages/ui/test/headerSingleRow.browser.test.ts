import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

// Phones keep the two-row header (#930, headerPhoneTwoRows.browser.test.ts).
for (const width of [761, 1500]) test(`the actual Dashboard header occupies one row at ${width}px`, async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const harness = createUiSsrHarness([{ name: "header-terminal-boundary", enforce: "pre",
    resolveId(source) { if (source.endsWith("TerminalPane.tsx")) return "\0header-terminal"; },
    load(id) { if (id === "\0header-terminal") return "export const TerminalPane = () => null;"; },
  }]);
  try {
    const { Dashboard } = await harness.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
    const { updateHeaderCompaction } = await harness.loadModule<typeof import("../src/headerResponsive.ts")>("/src/headerResponsive.ts");
    const { chooseHeaderCompactStage, HEADER_COMPACT_STAGES } = await harness.loadModule<typeof import("../src/headerResponsive.ts")>("/src/headerResponsive.ts");
    const markup = renderComponent(Dashboard, { active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {},
      defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
      onDebug() {}, onUsage() {}, onSettings() {} });
    const m = measureUiMarkup<{ rows: number; counts: number; newTitle: string | null; overflow: number; plusWidth: number }>(markup, width, `
      const header=document.querySelector('.workspace-head');
      const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
      const HEADER_COMPACT_STAGES=${JSON.stringify(HEADER_COMPACT_STAGES)};
      const chooseHeaderCompactStage=${chooseHeaderCompactStage.toString()};
      (${updateHeaderCompaction.toString()})(header);
      const controls=[...header.querySelectorAll('.session-status-count,.session-filter-search-open,.session-list-page-label,.dashboard-new-session,.header-menu-trigger')].filter(visible);
      const centers=controls.map(e=>{const r=e.getBoundingClientRect();return r.top+r.height/2});
      const result={plusWidth:header.querySelector(".dashboard-new-session svg").getBoundingClientRect().width,rows:Math.max(...centers)-Math.min(...centers),counts:[...header.querySelectorAll('.session-status-count')].filter(visible).length,newTitle:header.querySelector('.dashboard-new-session').title,overflow:document.documentElement.scrollWidth-innerWidth};
    `);
    assert.equal(m.counts, 4);
    assert.ok(m.rows <= 1, `counts, paging, filters and New share one row: ${JSON.stringify(m)}`);
    assert.equal(m.newTitle, "New session");
    assert.ok(m.plusWidth >= 16, "the New glyph must have real width inside its compact button");
    assert.ok(m.overflow <= 1);
  } finally { await harness.close(); }
});
