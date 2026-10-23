import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCssRuleLookup, uiStyles } from "./support/source.ts";

const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);
const root = cssRuleFor(":root");

function baseRuleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`\\n${escaped} \\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing base CSS rule for ${selector}`);
  return match[1];
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

function surface(index: number): number {
  const match = root.match(new RegExp(`--surface-${index}: *([^;]+);`));
  assert.ok(match, `missing --surface-${index}`);
  return luminance(match[1].trim());
}

/* The ladder is only a ladder if you can see the rungs. --surface-2 originally
   reused the legacy --panel-2 value and came out just 1.06x brighter than
   --surface-1 — a 1.02:1 contrast, invisible in practice. Every in-card header
   that was supposed to "separate by stepping up a surface" was in fact separated
   by nothing, which is how a card with no orchestration strip lost its
   header/body split entirely. */

test("each surface rung is visibly brighter than the one below it", () => {
  for (const lower of [0, 1, 2]) {
    const step = surface(lower + 1) / surface(lower);
    assert.ok(
      step >= 1.15,
      `--surface-${lower + 1} is only ${step.toFixed(2)}x --surface-${lower}; a rung under ~1.15x cannot be seen`,
    );
  }
});

test("in-card headers draw their edge as well as stepping up a surface", () => {
  // A header/body boundary is a strong semantic split, and it is the one edge
  // in this stylesheet that earns both treatments: the surface step alone reads
  // as a tint, not as a division.
  for (const selector of [".slot-head", ".mobile-session-card-toolbar"]) {
    const rule = baseRuleFor(selector);
    assert.match(rule, /background: var\(--surface-toolbar\);/, `${selector} should use the toolbar role`);
    assert.match(rule, /border-bottom: 1px solid var\(--border-default\);/, `${selector} should draw its edge`);
  }
});
