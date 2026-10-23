import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCssRuleLookup, uiSource, uiStyles } from "./support/source.ts";

const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);
const root = cssRuleFor(":root");
const sessionSlotSource = uiSource("SessionSlot.tsx");
const mobileSessionListSource = uiSource("MobileSessionList.tsx");

function baseRuleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing base CSS rule for ${selector}`);
  return match[1];
}

function roleRuleFor(selector: string, declaration: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\}`, "g"))];
  const match = matches.find((candidate) => candidate[1].includes(declaration));
  assert.ok(match, `missing ${declaration} rule for ${selector}`);
  return match[1];
}

function token(name: string): string {
  const match = root.match(new RegExp(`--${name}: *([^;]+);`));
  assert.ok(match, `missing --${name}`);
  return match[1].trim();
}

function channel(part: number): number {
  const srgb = part / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  assert.ok(match, `expected a 6-digit hex color, got ${hex}`);
  const [r, g, b] = match.slice(1).map((pair) => channel(Number.parseInt(pair, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test("semantic surface and border roles are declared independently of legacy aliases", () => {
  for (const name of [
    "surface-canvas",
    "surface-inset",
    "surface-card",
    "surface-toolbar",
    "surface-overlay",
    "surface-floating",
    "surface-control",
    "border-subtle",
    "border-default",
    "border-strong",
    "state-hover",
    "state-selected",
  ]) {
    assert.notEqual(token(name), "", `--${name} should have a value`);
  }

  assert.equal(token("bg"), "var(--surface-canvas)");
  assert.equal(token("panel"), "var(--surface-card)");
  assert.equal(token("panel-2"), "var(--surface-toolbar)");
  assert.equal(token("line"), "var(--border-default)");
  assert.equal(token("line-soft"), "var(--border-subtle)");
});

test("surface hierarchy stays dark and recognisably Night Owl", () => {
  const ladder = ["surface-0", "surface-1", "surface-2", "surface-3"].map(token);
  assert.equal(ladder[0], "#011627", "the canvas must retain the canonical Night Owl background");
  assert.ok(
    ladder.every((color) => luminance(color) <= 0.035),
    `the complete surface ladder should remain dark, got ${ladder.join(", ")}`,
  );
  assert.ok(contrast(ladder[0], ladder[3]) >= 1.4, "the dark ladder still needs a meaningful end-to-end step");
  for (let index = 0; index + 1 < ladder.length; index += 1) {
    const ratio = contrast(ladder[index], ladder[index + 1]);
    assert.ok(ratio >= 1.07, `surface step ${index} is only ${ratio.toFixed(2)}:1, want >= 1.07:1`);
  }
  assert.equal(token("fg-2"), "#a8bdd4");
  assert.equal(token("muted"), "#8ba1b8");
});

test("resting containers, headers, and inset content use role-based surfaces", () => {
  for (const selector of [
    ".tile",
    ".terminal-slot",
    ".mobile-session-card",
    ".settings-section",
    ".usage-provider",
  ]) {
    assert.match(baseRuleFor(selector), /background: var\(--surface-card\);/);
  }

  for (const selector of [".slot-head", ".mobile-session-card-toolbar"]) {
    assert.match(baseRuleFor(selector), /background: var\(--surface-toolbar\);/);
    assert.match(baseRuleFor(selector), /border-bottom: 1px solid var\(--border-default\);/);
  }

  for (const selector of [".history-viewer", ".tile-preview"]) {
    assert.match(roleRuleFor(selector, "background: var(--surface-inset)"), /background: var\(--surface-inset\);/);
  }
});

test("large overlays and small floating layers use different treatments", () => {
  const historyModal = baseRuleFor(".modal.history-modal");
  assert.match(historyModal, /background: var\(--surface-overlay\);/);
  assert.match(historyModal, /border: 1px solid var\(--border-strong\);/);

  for (const selector of [
    ".header-menu-dropdown",
    ".slot-title-dropdown",
    ".select-menu-options",
    ".modal",
    ".terminal-touch-menu",
  ]) {
    assert.match(baseRuleFor(selector), /background: var\(--surface-floating\);/);
    assert.match(baseRuleFor(selector), /border: 1px solid var\(--border-subtle\);/);
  }
});

test("history exposes structural boundaries and a persistent selected-row marker", () => {
  const body = baseRuleFor(".history-body");
  assert.match(body, /background: var\(--surface-inset\);/);
  assert.match(body, /border: 1px solid var\(--border-strong\);/);

  assert.match(baseRuleFor(".history-list"), /background: var\(--surface-card\);/);
  assert.match(roleRuleFor(".history-viewer-head", "background: var(--surface-toolbar)"), /background: var\(--surface-toolbar\);/);

  const selected = cssRuleFor(".history-row.is-selected");
  assert.match(selected, /background: var\(--state-selected\);/);
  assert.match(selected, /box-shadow: inset 3px 0 0 var\(--accent\);/);
});

test("shared controls keep a distinct control surface and default edge", () => {
  const button = baseRuleFor(".btn");
  assert.match(button, /background: var\(--surface-control\);/);
  assert.match(button, /border: 1px solid var\(--border-default\);/);

  const inputs = cssRuleFor("input:where(:not([type]), [type=\"text\"], [type=\"password\"], [type=\"url\"], [type=\"email\"], [type=\"search\"], [type=\"tel\"]),\nselect,\ntextarea,\n.select-menu-trigger");
  assert.match(inputs, /background: var\(--surface-inset\);/);
  assert.match(inputs, /border: var\(--control-border-width\) solid var\(--border-default\);/);
});

test("machine colour stays local to identity badges instead of resembling selection", () => {
  assert.equal(
    [...sessionSlotSource.matchAll(/style=\{machineAccentStyle\(/g)].length,
    1,
    "only the desktop repo badge should receive the machine accent",
  );
  assert.doesNotMatch(
    mobileSessionListSource,
    /style=\{machineAccentStyle\(/,
    "the mobile card should not receive a full-card machine accent",
  );
  assert.doesNotMatch(baseRuleFor(".terminal-slot"), /--machine-accent|border-top/);
  assert.doesNotMatch(baseRuleFor(".mobile-session-card"), /--machine-accent|border-left/);
  for (const selector of [".slot-head", ".mobile-session-card-toolbar"]) {
    assert.doesNotMatch(baseRuleFor(selector), /background-image|--machine-accent/);
  }
  assert.match(baseRuleFor(".repo-badge"), /color: var\(--machine-accent, var\(--accent\)\);/);

  const selectedCard = cssRuleFor(".session-workspace.desktop .terminal-slot.is-cmd-focus-target::after,\n.session-workspace.desktop .terminal-slot.is-grid-focus::after");
  assert.match(selectedCard, /inset: 0;/, "selection should cover the complete desktop card");
  assert.match(selectedCard, /pointer-events: none;/, "selection must not block terminal interaction");
  assert.match(selectedCard, /background: transparent;/, "selection must not recolor the terminal contents");
  assert.match(selectedCard, /border: 1px solid var\(--accent\);/, "selection owns the full-card accent outline");
});
