import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCssRuleLookup, uiStyles } from "./support/source.ts";

const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);

/* makeCssRuleLookup matches its selector anywhere, so ".slot-head" would resolve
   to the earlier ".terminal-slot.is-slot-drop-target .slot-head" rule. Anchor to
   the start of a line when the base rule is what matters. */
function baseRuleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing base CSS rule for ${selector}`);
  return match[1];
}

/* Depth in this console comes from surface luminance plus a top-edge highlight,
   not from giving every box the same 1px border. These tests pin that contract
   so a later edit cannot quietly flatten the app back to a wireframe. */

test("root declares the surface/elevation ladder and keeps the legacy panel aliases", () => {
  const root = cssRuleFor(":root");

  assert.match(root, /--surface-0: #011627;/);
  assert.match(root, /--surface-1: #061e31;/);
  assert.match(root, /--surface-2: #0b2942;/);
  assert.match(root, /--surface-3: #123650;/);

  // The top-edge inset highlight is what reads as "lit from above" on a dark
  // UI; without it a raised surface only looks like a lighter rectangle.
  assert.match(root, /--elev-1: inset 0 1px 0 rgba\(255, 255, 255, 0\.035\), 0 1px 2px rgba\(var\(--shadow-rgb\), calc\(0\.24 \* var\(--shadow-strength\)\)\);/);
  assert.match(root, /--elev-2: inset 0 1px 0 rgba\(255, 255, 255, 0\.05\), 0 4px 12px rgba\(var\(--shadow-rgb\), calc\(0\.28 \* var\(--shadow-strength\)\)\);/);
  assert.match(root, /--elev-3: 0 16px 40px rgba\(var\(--shadow-rgb\), calc\(0\.42 \* var\(--shadow-strength\)\)\);/);

  // Three edge strengths separate resting containers, controls, and structural boundaries.
  assert.match(root, /--border-subtle: rgba\(var\(--edge-rgb\), 0\.2\);/);
  assert.match(root, /--border-default: rgba\(var\(--edge-rgb\), 0\.4\);/);
  assert.match(root, /--border-strong: rgba\(var\(--edge-rgb\), 0\.62\);/);

  // ~100 existing rules read --panel / --panel-2; they alias the ladder rather
  // than duplicating hex values.
  assert.match(root, /--bg: var\(--surface-canvas\);/);
  assert.match(root, /--panel: var\(--surface-card\);/);
  assert.match(root, /--panel-2: var\(--surface-toolbar\);/);
});

test("root declares the radius and type scales", () => {
  const root = cssRuleFor(":root");

  assert.match(root, /--r-xs: 4px;/);
  assert.match(root, /--r-sm: 6px;/);
  assert.match(root, /--r-md: 8px;/);
  assert.match(root, /--r-lg: 12px;/);
  assert.match(root, /--r-xl: 16px;/);
  assert.match(root, /--r-full: 999px;/);
  assert.match(root, /--control-radius: var\(--r-md\);/);

  assert.match(root, /--text-2xs: 0\.68rem;/);
  assert.match(root, /--text-xs: 0\.72rem;/);
  assert.match(root, /--text-sm: 0\.78rem;/);
  assert.match(root, /--text-md: 0\.85rem;/);
  assert.match(root, /--text-base: 0\.9rem;/);
  assert.match(root, /--text-lg: 1rem;/);
  assert.match(root, /--text-xl: 1\.1rem;/);
  assert.match(root, /--text-2xl: 1\.25rem;/);
  // >=16px keeps mobile browsers from zooming when a text field takes focus.
  assert.match(root, /--text-control: 1rem;/);
});

test("resting cards are raised by luminance and elevation instead of a hard border", () => {
  for (const selector of [".tile", ".terminal-slot", ".mobile-session-card", ".settings-section", ".usage-provider"]) {
    const rule = baseRuleFor(selector);
    assert.match(rule, /background: var\(--surface-card\);/, `${selector} should use the card role`);
    assert.match(rule, /border: 1px solid var\(--border-subtle\);/, `${selector} should use the soft hairline`);
    assert.match(rule, /box-shadow: var\(--elev-1\);/, `${selector} should carry elevation 1`);
  }
});

/* In-card headers used to be asserted here as "surface step, no border". That
   was wrong on both halves — the step was invisible and the border was needed —
   so headerEdgeCss owns the corrected contract, rung sizes included. */

test("floating layers sit on the top surface with the deepest shadow", () => {
  for (const selector of [".header-menu-dropdown", ".slot-title-dropdown", ".select-menu-options", ".modal", ".terminal-touch-menu"]) {
    const rule = baseRuleFor(selector);
    assert.match(rule, /background: var\(--surface-floating\);/, `${selector} should use the floating role`);
    assert.match(rule, /box-shadow: var\(--elev-3\);/, `${selector} should carry elevation 3`);
  }
});

test("the fullscreen focused slot drops its elevation", () => {
  // Edge-to-edge: a shadow has nothing to cast onto and only costs paint.
  const rule = cssRuleFor(".session-workspace.is-focused .terminal-slot.is-focused");
  assert.match(rule, /box-shadow: none;/);
});

/* Sweep guards ------------------------------------------------------------
   The scales are only worth having if the stylesheet actually uses them, so
   scan every declaration and allow just the documented exceptions. */

const RAW_RADIUS_ALLOWED = new Set([
  "0", // edge-to-edge: fullscreen slot, mobile scrim, drawer at <=640px
  "2px", // activity glyph shapes (stopped / unavailable) and the copy icon
  "50%", // circular dots, spinners, ripples
  "50% 50% 50% 0", // terminal selection handle teardrop
  "999px", // xterm vendor scrollbar overrides, pinned by terminalPane tests
  "inherit",
]);

const RAW_FONT_SIZE_ALLOWED = new Set([
  "0", // <=340px: icon-only header buttons hide their label
  "9px", // activity glyph overlay marks, smaller than the smallest text step
]);

test("every border-radius uses the scale or a documented exception", () => {
  const offenders = [...css.matchAll(/border-radius:\s*([^;]+);/g)]
    .map((match) => match[1].trim())
    .filter((value) => !value.includes("var(--r-") && !value.includes("var(--control-radius)"))
    .filter((value) => !RAW_RADIUS_ALLOWED.has(value));
  assert.deepEqual([...new Set(offenders)], [], "unscaled border-radius values remain");
});

test("every font-size uses the scale or a documented exception", () => {
  const offenders = [...css.matchAll(/font-size:\s*([^;]+);/g)]
    .map((match) => match[1].trim())
    .filter((value) => !value.includes("var(--text-") && !["var(--form-value-font-size)", "var(--icon-glyph)", "var(--control-menu-font-size)", "var(--control-chip-font-size)"].includes(value))
    .filter((value) => !RAW_FONT_SIZE_ALLOWED.has(value));
  assert.deepEqual([...new Set(offenders)], [], "unscaled font-size values remain");
});
