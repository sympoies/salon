import { strict as assert } from "node:assert";
import { test } from "node:test";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness, renderComponent } from "./support/ssr.ts";

interface HeaderGeometry {
  readonly pickerVisible: boolean;
  readonly firstRowSpread: number;
  readonly filterBelowBy: number;
  readonly brandVisible: boolean;
  readonly compactStage: string | null;
  readonly overflow: number;
  readonly headerHeight: number;
}

async function measureHeader(width: number, macTitleBar = false): Promise<HeaderGeometry> {
  const harness = createUiSsrHarness([{ name: "header-terminal-boundary", enforce: "pre",
    resolveId(source) { if (source.endsWith("TerminalPane.tsx")) return "\0header-terminal"; },
    load(id) { if (id === "\0header-terminal") return "export const TerminalPane = () => null;"; },
  }]);
  try {
    const { Dashboard } = await harness.loadModule<typeof import("../src/Dashboard.tsx")>("/src/Dashboard.tsx");
    const { updateHeaderCompaction, chooseHeaderCompactStage, HEADER_COMPACT_STAGES } =
      await harness.loadModule<typeof import("../src/headerResponsive.ts")>("/src/headerResponsive.ts");
    const markup = renderComponent(Dashboard, { active: true, machines: ["fixture"], enabledMachines: ["fixture"], machineColors: {},
      defaultAutoResume: false, terminalRenderMode: "realtime", terminalSelectedPaneRealtime: true,
      onDebug() {}, onUsage() {}, onSettings() {} });
    return measureUiMarkup<HeaderGeometry>(markup, width, `
      const header=document.querySelector('.workspace-head');
      ${macTitleBar ? "document.documentElement.dataset.macTitlebar='true';header.classList.add('has-native-counts');const bar=document.createElement('div');bar.className='mac-titlebar';bar.append(header.querySelector('.session-status-counts'));document.body.append(bar);" : ""}
      const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
      const HEADER_COMPACT_STAGES=${JSON.stringify(HEADER_COMPACT_STAGES)};
      const chooseHeaderCompactStage=${chooseHeaderCompactStage.toString()};
      (${updateHeaderCompaction.toString()})(header);
      const center=e=>{const r=e.getBoundingClientRect();return r.top+r.height/2};
      const firstRow=[...header.querySelectorAll('.brand-title-mark,.session-status-count,.header-menu-trigger,.dashboard-new-session')].filter(visible).map(center);
      const filter=header.querySelector('.session-filter-searchbar');
      const result={
        pickerVisible:[...header.querySelectorAll('.layout-picker,.layout-picker *')].some(visible),
        firstRowSpread:Math.max(...firstRow)-Math.min(...firstRow),
        filterBelowBy:center(filter)-Math.max(...firstRow),
        brandVisible:visible(header.querySelector('.brand-title-mark')),
        compactStage:header.getAttribute('data-header-compact'),
        overflow:document.documentElement.scrollWidth-innerWidth,
        headerHeight:Math.round(header.getBoundingClientRect().height),
      };
    `);
  } finally { await harness.close(); }
}

// #930: phones keep the pre-#915 header: brand, counts and actions on the
// first row, the filter on its own row below, and no layout picker.
for (const width of [370, 390, 760]) test(`the phone Dashboard header has two rows and no layout picker at ${width}px`, async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const m = await measureHeader(width);
  assert.equal(m.pickerVisible, false, `no layout picker on a phone: ${JSON.stringify(m)}`);
  assert.ok(m.firstRowSpread <= 2, `brand, counts, More and New share the first row: ${JSON.stringify(m)}`);
  assert.ok(m.filterBelowBy >= 20, `the filter sits on its own row below: ${JSON.stringify(m)}`);
  assert.equal(m.brandVisible, true, `the brand mark stays visible: ${JSON.stringify(m)}`);
  assert.equal(m.compactStage, null, `phones do not use desktop compaction stages: ${JSON.stringify(m)}`);
  assert.ok(m.overflow <= 1, `no horizontal overflow: ${JSON.stringify(m)}`);
});

// Desktop keeps #915: one measured row with the layout picker.
for (const width of [761, 1500]) test(`the desktop Dashboard header keeps one row with the layout picker at ${width}px`, async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const m = await measureHeader(width);
  assert.equal(m.pickerVisible, true, `desktop keeps the layout picker: ${JSON.stringify(m)}`);
  assert.ok(Math.abs(m.filterBelowBy) <= 2, `the filter shares the row: ${JSON.stringify(m)}`);
  assert.notEqual(m.compactStage, null, `desktop uses measured compaction: ${JSON.stringify(m)}`);
  assert.ok(m.overflow <= 1, `no horizontal overflow: ${JSON.stringify(m)}`);
});

// A narrow macOS window (minWidth 390) keeps the #915 desktop row: its counts
// live in the title bar, so the phone tier does not apply (#933 review F1).
for (const width of [390, 600, 760]) test(`a narrow macOS window keeps the single measured row at ${width}px`, async t => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const m = await measureHeader(width, true);
  assert.notEqual(m.compactStage, null, `macOS uses desktop compaction: ${JSON.stringify(m)}`);
  assert.ok(Math.abs(m.filterBelowBy) <= 2, `the filter shares the row: ${JSON.stringify(m)}`);
  assert.ok(m.headerHeight <= 48, `one row high: ${JSON.stringify(m)}`);
  assert.ok(m.overflow <= 1, `no horizontal overflow: ${JSON.stringify(m)}`);
});
