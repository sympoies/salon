import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import type * as Fixture from "./support/phoneHeaderFixture.ts";
import type * as Compact from "../src/harnessCompact.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness([{
  name: "terminal-fixture", enforce: "pre",
  resolveId(source) { return source.endsWith("TerminalPane.tsx") ? "\0terminal-fixture" : null; },
  load(id) { return id === "\0terminal-fixture" ? "export function TerminalPane() { return null; }" : null; },
}]);
after(() => ssr.close());

type Measured = { rows: number[]; pagerRow: number; rowTwoTops: number[]; overflow: boolean; stage: number; usageClipped: boolean;
  percentVisible: boolean };

// The phone focused header is two rows for every provider: row 2 keeps the
// account, model/effort/context (truncating), status and the page switcher on
// one line (exampleOrg/agent-console#882; the Codex switcher wrapped to row 3).
async function measure(agent: "claude" | "codex", width: number): Promise<Measured> {
  const fixture = await ssr.loadModule<typeof Fixture>("/test/support/phoneHeaderFixture.ts");
  const compact = await ssr.loadModule<typeof Compact>("/src/harnessCompact.ts");
  const markup = `<style>html,body{margin:0}</style>${fixture.renderPhoneFocusedHeader(agent)}`;
  return measureUiMarkup<Measured>(markup, width, `
    const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const head = document.querySelector(".terminal-slot.is-focused .slot-head");
    // The live header's fit (useHarnessCompact in SessionSlot.tsx).
    const fit = ${compact.fitHarnessCompact.toString()};
    const target = head.querySelector(":scope > .slot-focus-row-two");
    const model = target.querySelector(":scope > .session-model-badge");
    const stage = fit({ target, row: model, title: model.querySelector(":scope > .session-model-name"), minTitlePx: 40 });
    const items = [...head.querySelectorAll(":scope > .slot-focus-row-one > *, :scope > .slot-focus-row-two > *")].filter(visible);
    const tops = [];
    for (const item of items) {
      const top = Math.round(item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2);
      if (!tops.some((seen) => Math.abs(seen - top) <= 6)) tops.push(top);
    }
    const rowOf = (element) => {
      const mid = element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2;
      return tops.findIndex((top) => Math.abs(top - mid) <= 6);
    };
    const rowTwo = [...head.querySelectorAll(":scope > .slot-focus-row-two > *")].filter(visible);
    const result = {
      rows: tops,
      pagerRow: rowOf(head.querySelector(".slot-focus-row-two .slot-session-nav-menu, .slot-focus-row-two .slot-session-nav")),
      rowTwoTops: rowTwo.map(rowOf),
      overflow: document.documentElement.scrollWidth > innerWidth || head.scrollWidth > head.clientWidth + 1,
      stage,
      usageClipped: model.scrollWidth > model.clientWidth + 1,
      percentVisible: model.querySelector("[data-context-usage]").getBoundingClientRect().width > 0,
    };
  `);
}

for (const width of [412, 384]) {
  for (const agent of ["claude", "codex"] as const) {
    test(`phone focused header is two rows for a ${agent} session at ${width} px`, async (t) => {
      if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
      const measured = await measure(agent, width);
      assert.equal(measured.rows.length, 2, `two header rows: ${JSON.stringify(measured)}`);
      assert.equal(measured.pagerRow, 1, "the page switcher stays on row 2");
      assert.ok(measured.rowTwoTops.every((row) => row === 1), "every harness item shares row 2");
      assert.equal(measured.overflow, false, "no horizontal overflow");
      assert.equal(measured.usageClipped, false, `effort and usage are never cut mid-text: ${JSON.stringify(measured)}`);
      // Items drop in the harnessCompact.ts order (context tokens, effort, model);
      // the context percentage always stays.
      assert.ok(measured.percentVisible, `the context percentage stays at stage ${measured.stage}`);
    });
  }
}
