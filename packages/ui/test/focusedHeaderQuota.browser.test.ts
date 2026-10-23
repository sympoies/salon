import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type * as Fixture from "./support/focusedHeaderFixture.ts";
import type * as Compact from "../src/harnessCompact.ts";
import { hasHeadlessChrome, measureUiMarkup } from "./support/browserLayout.ts";
import { createUiSsrHarness } from "./support/ssr.ts";

const ssr = createUiSsrHarness([{
  name: "terminal-fixture", enforce: "pre",
  resolveId(source) { return source.endsWith("TerminalPane.tsx") ? "\0terminal-fixture" : null; },
  load(id) { return id === "\0terminal-fixture" ? "export function TerminalPane() { return null; }" : null; },
}]);
after(() => ssr.close());
const screenshotDirectory = process.env.AGENT_CONSOLE_UI_SCREENSHOT_DIR;

// The documented drop order (harnessCompact.ts), first dropped first.
const DROP_ORDER = ["quota meters", "quota", "context tokens", "effort", "model"] as const;
type Measured = {
  stage: number;
  hidden: string[];
  kept: Record<string, boolean>;
  quotaText: string;
  usageText: string;
  overflow: boolean;
  wrapped: string[];
  titleWidth: number;
  rows: { stage: number; hidden: string[]; kept: Record<string, boolean>; badgeWidth: number; badgeCentered: boolean;
    badgeLines: number; titleLeft: number; overflow: boolean; text: string; move: boolean; moveVisible: boolean }[];
};

async function measure(width: number, options: { menu?: boolean; moveHere?: boolean } = {}): Promise<Measured> {
  const fixture = await ssr.loadModule<typeof Fixture>("/test/support/focusedHeaderFixture.ts");
  const compact = await ssr.loadModule<typeof Compact>("/src/harnessCompact.ts");
  const markup = `<style>html,body{margin:0}</style>${fixture.renderFocusedHeaderFixture(options)}`;
  return measureUiMarkup<Measured>(markup, width, `
    const fit = ${compact.fitHarnessCompact.toString()};
    const visible = (element) => Boolean(element) && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const head = document.querySelector(".terminal-slot.is-focused .slot-head");
    const details = head.querySelector(":scope > .slot-session-details");
    const title = details.querySelector(":scope > .slot-title-row");
    const stage = fit({ target: details, row: head, title: title.querySelector(":scope > .slot-title-menu"), minTitlePx: 160 });
    const items = (root) => ({
      "quota meters": [...root.querySelectorAll(":scope > .session-quota .hu-meter")],
      quota: [...root.querySelectorAll(":scope > .session-quota .hu-pct, :scope > .session-quota .hu-reset")],
      "context tokens": [...root.querySelectorAll(":scope > .session-model-badge [data-context-tokens]")],
      effort: [...root.querySelectorAll(":scope > .session-model-badge > .session-model-effort")],
      model: [...root.querySelectorAll(":scope > .session-model-badge > .session-model-name")],
    });
    const hiddenOf = (root) => Object.entries(items(root)).filter(([, list]) => list.length > 0 && list.every(el => !visible(el))).map(([name]) => name);
    const headTop = head.getBoundingClientRect().top;
    const kept = {
      harness: visible(details.querySelector(":scope > .agent-retitle-button")),
      account: visible(details.querySelector(":scope > .account-usage-root")),
      title: visible(title),
      contextPercent: visible(details.querySelector(":scope > .session-model-badge [data-context-usage]")),
    };
    const singleRow = [...details.children].filter(visible);
    const firstTop = singleRow[0].getBoundingClientRect().top, rowHeight = singleRow[0].getBoundingClientRect().height;
    const wrapped = singleRow.filter(el => Math.abs((el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2) - (firstTop + rowHeight / 2)) > rowHeight / 2).map(el => el.className);
    const rows = [...head.querySelectorAll(".slot-menu-session")].map(row => {
      const target = row.querySelector(".session-harness");
      const rowStage = fit({ target, row, title: row.querySelector(".slot-menu-label"), minTitlePx: 120 });
      const badge = row.querySelector(".repo-badge"), line = badge.querySelector(".repo-badge-line");
      const b = badge.getBoundingClientRect(), l = line.getBoundingClientRect();
      const move = row.parentElement.querySelector(".slot-menu-move");
      return {
        stage: rowStage,
        hidden: hiddenOf(target),
        kept: { harness: visible(target.querySelector(".agent-badge")), account: visible(target.querySelector(".account-status")) || !target.querySelector(".account-status"), title: visible(row.querySelector(".slot-menu-label")) },
        badgeWidth: b.width,
        badgeCentered: Math.abs((l.left + l.right) / 2 - (b.left + b.right) / 2) <= 1,
        badgeLines: badge.querySelectorAll(".repo-badge-line").length,
        titleLeft: row.querySelector(".slot-menu-label").getBoundingClientRect().left,
        overflow: row.scrollWidth > row.clientWidth + 1,
        text: row.textContent,
        move: Boolean(move),
        moveVisible: Boolean(move) && visible(move) && move.getBoundingClientRect().right <= row.parentElement.getBoundingClientRect().right + 0.5,
      };
    });
    const result = {
      stage, hidden: hiddenOf(details), kept,
      quotaText: details.querySelector(":scope > .session-quota")?.textContent ?? "",
      usageText: details.querySelector(":scope > .session-model-badge [data-context-usage]")?.textContent ?? "",
      overflow: head.scrollWidth > head.clientWidth + 1, wrapped, titleWidth: title.getBoundingClientRect().width, rows,
    };
  `, false, 700, screenshotDirectory ? (mkdirSync(screenshotDirectory, { recursive: true }), [
    `--window-size=${width + 16},700`,
    `--screenshot=${join(screenshotDirectory, `focused-header-${width}${options.menu ? `-menu${options.moveHere ? "-move" : ""}` : ""}.png`)}`,
  ]) : []);
}

function assertDropOrder(hidden: readonly string[], context: string) {
  const deepest = Math.max(-1, ...hidden.map(name => DROP_ORDER.indexOf(name as typeof DROP_ORDER[number])));
  assert.deepEqual([...hidden].sort(), DROP_ORDER.slice(0, deepest + 1).sort(), `${context}: items drop strictly in the documented order`);
}

test("focused header shows the account quota and drops items in the documented order", async (t) => {
  if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
  const stages: number[] = [];
  for (const width of [1600, 1280, 1024, 900, 800]) {
    const m = await measure(width);
    assert.deepEqual(m.kept, { harness: true, account: true, title: true, contextPercent: true }, `${width}px keeps the harness icon, account, title and context %`);
    assert.equal(m.overflow, false, `${width}px header does not overflow`);
    assert.deepEqual(m.wrapped, [], `${width}px header stays on one row`);
    assertDropOrder(m.hidden, `${width}px`);
    assert.equal(m.hidden.length, m.stage, `${width}px hides exactly the items of stage ${m.stage}`);
    if (m.stage < 2) {
      assert.match(m.quotaText, /91%3h 20m/, `${width}px shows the 5h remaining % and reset like the top-bar chip`);
      assert.match(m.quotaText, /80%5d 21h/, `${width}px shows the weekly remaining % and reset like the top-bar chip`);
    }
    if (m.stage < 3) assert.equal(m.usageText.trim(), "· 30% 299k/1M");
    stages.push(m.stage);
  }
  assert.equal(stages[0], 0, "a wide header shows everything");
  assert.deepEqual([...stages].sort((a, b) => a - b), stages, `narrower headers never show more: ${stages.join(",")}`);
  assert.ok(stages.at(-1)! >= 3, `the narrow header reaches the context-token stage: ${stages.join(",")}`);
});

for (const moveHere of [false, true]) {
  test(`dropdown rows: uniform badges, aligned titles, harness segment, no host${moveHere ? ", Move here" : ""}`, async (t) => {
    if (!hasHeadlessChrome()) { t.skip("headless Chrome unavailable"); return; }
    for (const width of [1600, 1024, 800]) {
      const m = await measure(width, { menu: true, moveHere });
      assert.ok(m.rows.length >= 6, `${width}px renders every session row`);
      const widths = new Set(m.rows.map(row => Math.round(row.badgeWidth)));
      assert.equal(widths.size, 1, `${width}px badges share one width: ${[...widths].join(",")}`);
      assert.ok(m.rows.every(row => row.badgeCentered && row.badgeLines === 1), `${width}px badges are single-line and centred`);
      const lefts = new Set(m.rows.map(row => Math.round(row.titleLeft)));
      assert.equal(lefts.size, 1, `${width}px titles start in one column: ${[...lefts].join(",")}`);
      for (const [index, row] of m.rows.entries()) {
        assert.equal(row.overflow, false, `${width}px row ${index} does not overflow`);
        assert.deepEqual(row.kept, { harness: true, account: true, title: true }, `${width}px row ${index} keeps harness, account and title`);
        assert.ok(!row.hidden.includes("quota") && !row.hidden.includes("quota meters"), "rows carry no quota");
        assertDropOrder(row.hidden, `${width}px row ${index}`);
        assert.doesNotMatch(row.text, /summit|cedar/, `${width}px row ${index} carries no host text`);
        // The current session has no Move here; every other row has one while ordering is manual.
        if (index > 0) assert.equal(row.move && row.moveVisible, moveHere, `${width}px row ${index} Move here ${moveHere ? "visible at the far right" : "absent"}`);
      }
      if (width === 1600) assert.match(m.rows[1]!.text, /claude-opus-5-5 · medium · 30% 299k\/1M/, "a wide row shows the full status-line harness segment");
    }
  });
}
