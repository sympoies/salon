import { strict as assert } from "node:assert";
import { test } from "node:test";
import { uiStyles } from "./support/source.ts";

const styles = uiStyles();

test("mobile session list keeps close action visible", () => {
  assert.match(
    styles,
    /\.session-workspace\.mobile\s+\.terminal-slot\s+\.slot-action\.danger\s*\{[^}]*display:\s*inline-grid;/s,
  );
});

test("mobile focused header uses exactly two full-width rows", () => {
  assert.match(
    styles,
    /\.session-workspace\.mobile\.is-focused\s+\.terminal-slot\.is-focused\s+\.slot-head\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/s,
  );
  assert.match(
    styles,
    /\.session-workspace\.mobile\.is-focused\s+\.terminal-slot\.is-focused\s+\.slot-focus-toolbar,\s*:where\(:root\[data-phone-tier="true"\]\) \.session-workspace\.mobile\.is-focused\s+\.terminal-slot\.is-focused\s+\.slot-session-details\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s,
  );
  assert.doesNotMatch(
    styles,
    /\.session-workspace\.mobile\.is-focused\s+\.terminal-slot\.is-focused\s+\.slot-focus-statusbar\s*\{/s,
  );
});

test("mobile overview keeps create actions right-aligned in the shared control row", () => {
  assert.match(
    styles,
    /\.workspace-head\s*>\s*\.dash-actions\s*\{[^}]*grid-area:\s*actions;[^}]*justify-self:\s*end;/s,
  );
  assert.match(
    styles,
    /\.workspace-head\s+\.dash-create-actions\s*\{[^}]*margin-left:\s*auto;/s,
  );
});

test("coarse-pointer overview controls share the same 44px toolbar geometry", () => {
  assert.match(
    styles,
    /@media \(pointer: coarse\) \{[\s\S]*?--control-height:\s*44px;[\s\S]*?--control-toolbar-height:\s*44px;/s,
  );
  assert.match(
    styles,
    /\.dash-actions\s+\.btn\s*\{[^}]*min-height:\s*var\(--control-toolbar-height\);/s,
  );
  assert.match(
    styles,
    /\.control-icon\s*\{[^}]*width:\s*var\(--icon-size\);/s,
  );
});

test("narrow overview controls share the same 44px toolbar geometry regardless of pointer type", () => {
  assert.match(
    styles,
    /:where\(:root\[data-phone-tier="true"\]\) [\s\S]*?\.workspace-head:has\(\.session-list-navigator\) \.session-list-group-trigger,\s*:where\(:root\[data-phone-tier="true"\]\) \.workspace-head:has\(\.session-list-navigator\) \.dash-create-actions \.header-menu-trigger,\s*:where\(:root\[data-phone-tier="true"\]\) \.workspace-head:has\(\.session-list-navigator\) \.dash-create-actions > \.btn \{[^}]*height:\s*44px;[^}]*min-height:\s*44px;/s,
  );
  assert.match(
    styles,
    /:where\(:root\[data-phone-tier="true"\]\) [\s\S]*?\.workspace-head:has\(\.session-list-navigator\) \.dash-create-actions \.header-menu-trigger \{[^}]*width:\s*44px;/s,
  );
});

test("coarse-pointer picker and filter controls keep mobile touch targets through 1024px", () => {
  const mobilePanel = styles.indexOf(".session-filter-panel.is-mobile {");
  const start = styles.indexOf(':where(:root[data-phone-tier="true"]) .session-filter-panel.is-mobile .session-filter-panel-fields {', mobilePanel);
  const end = styles.indexOf("/* One workspace row on desktop", start);
  assert.ok(mobilePanel >= 0 && start > mobilePanel && end > start, "popover touch overrides use the app mobile breakpoint");
  const rules = styles.slice(start, end);
  assert.match(styles, /--control-menu-height:\s*48px;/);
  assert.match(rules, /\.session-filter-panel\.is-mobile \.session-filter-panel-fields select,[\s\S]*?min-height:\s*var\(--form-field-height\);/s);
  assert.match(rules, /\.session-filter-panel\.is-mobile \.session-filter-multi-select > summary,[\s\S]*?min-height:\s*44px;/s);
  assert.match(rules, /\.session-filter-panel\.is-mobile \{[^}]*--control-action-height:\s*var\(--control-form-action-height\);/s);
});

test("very narrow overview collapses New to its icon without changing its accessible name", () => {
  assert.match(
    styles,
    /@media \(max-width: 340px\) \{[\s\S]*?\.workspace-head:has\(\.session-list-navigator\)\s+\.dash-create-actions\s*>\s*\.btn\s*\{[^}]*width:\s*var\(--control-toolbar-height\);[^}]*padding-inline:\s*0;[^}]*font-size:\s*0;/s,
  );
});

test("mobile focused toolbar controls share one height", () => {
  assert.match(
    styles,
    /\.session-workspace\.mobile\.is-focused[^{]*\.slot-back,[^{]*\.slot-session-nav\s*\{[^}]*min-height:\s*var\(--icon-compact-size\);/s,
  );
});

test("mobile focused header keeps first-row status compact and second-row title shrinkable", () => {
  assert.match(
    styles,
    /\.session-workspace\.mobile\.is-focused\s+\.terminal-slot\.is-focused\s+\.slot-focus-status\s*\{[^}]*flex:\s*1\s+1\s+auto;[^}]*min-width:\s*0;[^}]*display:\s*inline-flex;[^}]*justify-content:\s*flex-end;/s,
  );
  assert.match(
    styles,
    /\.slot-focus-status\s+\.auto-resume-status-text\s*\{[^}]*display:\s*none;/s,
  );
  assert.match(
    styles,
    /\.slot-title-row,[^{]*\.slot-title-edit\s*\{[^}]*flex:\s*1\s+1\s+0;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s,
  );
});

test("mobile focused navigation row keeps copy and close actions fixed", () => {
  assert.match(
    styles,
    /\.session-workspace\.mobile\.is-focused\s+\.terminal-slot\.is-focused\s+\.slot-focus-toolbar\s+\.slot-focus-actions\s*\{[^}]*flex:\s*none;/s,
  );
  assert.match(
    styles,
    /\.session-workspace\.mobile\.is-focused\s+\.terminal-slot\.is-focused\s+\.slot-focus-status\s*\{[^}]*margin-left:\s*auto;/s,
  );
  assert.match(
    styles,
    /\.control-icon\s*\{[^}]*flex:\s*none;[^}]*width:\s*var\(--icon-size\);[^}]*height:\s*var\(--icon-size\);/s,
  );
});

test("mobile focused header shows session status metadata", () => {
  assert.match(
    styles,
    /\.session-workspace\.mobile\.is-focused\s+\.terminal-slot\.is-focused\s+\.slot-focus-status\s*\{[^}]*display:\s*inline-flex;/s,
  );
});

test("focused status keeps its badges whole and shrinks the elapsed text instead", () => {
  const cluster = /\.session-workspace\.mobile\.is-focused\s+\.terminal-slot\.is-focused\s+\.slot-focus-status\s*\{([^}]*)\}/s
    .exec(styles)?.[1];

  assert.ok(cluster, "expected the mobile focused status cluster rule");
  // A fixed cap plus right-aligned overflow clipped the left edge of the
  // cluster, cutting the auto-resume badge and the status dot off screen.
  assert.doesNotMatch(cluster, /max-width:\s*7rem/);
  assert.match(styles, /\.slot-focus-status\s+\.session-activity-root\s*\{[^}]*min-width:\s*0;/s);
  assert.match(
    styles,
    /\.slot-focus-status\s+\.session-activity-text\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s,
  );
  assert.match(styles, /\.slot-focus-status\s+\.session-activity-attention\s*\{[^}]*flex:\s*none;/s);
});

test("mobile activity is icon-only in overview and shows elapsed time when focused", () => {
  assert.match(
    styles,
    /\.session-workspace\.mobile\s+\.session-activity-text\s*\{[^}]*display:\s*none;[^}]*\}/s,
  );
  assert.match(
    styles,
    /\.session-workspace\.mobile\.is-focused\s+\.terminal-slot\.is-focused\s+\.slot-focus-row-two\s+\.session-activity-text\s*\{[^}]*display:\s*inline;/s,
  );
  assert.match(
    styles,
    /\.session-workspace\.mobile\s+\.session-activity-attention-copy\s*\{[^}]*display:\s*none;/s,
  );
  assert.doesNotMatch(styles, /\.terminal-slot\.is-focused\s+\.session-activity-attention-copy\s*\{[^}]*display:\s*inline;/s);
});

test("very narrow focused headers compact navigation before clipping live status", () => {
  assert.match(
    styles,
    /@media \(max-width: 340px\) \{[\s\S]*?\.slot-back-label\s*\{[^}]*display:\s*none;/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 340px\) \{[\s\S]*?\.slot-session-nav\s*\{[^}]*grid-template-columns:\s*var\(--icon-pager-width\)\s+2\.1rem\s+var\(--icon-pager-width\);/s,
  );
  assert.match(
    styles,
    /@media \(max-width: 340px\) \{[\s\S]*?\.slot-focus-status\s+\.session-activity-trigger\s*\{[^}]*gap:\s*var\(--space-2xs\);[^}]*padding:\s*var\(--space-2xs\);/s,
  );
});
