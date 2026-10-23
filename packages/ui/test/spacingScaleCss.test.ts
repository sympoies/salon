import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCssRuleLookup, uiStyles } from "./support/source.ts";

const css = uiStyles();
const root = makeCssRuleLookup(css)(":root");

/* Spacing was the last of the ad-hoc scales: 0.35/0.4/0.45/0.55/0.6/0.65/0.7rem
   all appearing side by side. Gaps that close don't read as "tighter", they read
   as unaligned, which is what makes a dense tool UI feel noisy. */

test("root declares the spacing scale on a 4px grid", () => {
  assert.match(root, /--space-3xs: 0\.125rem;/); // 2px
  assert.match(root, /--space-2xs: 0\.25rem;/); // 4px
  assert.match(root, /--space-xs: 0\.375rem;/); // 6px
  assert.match(root, /--space-sm: 0\.5rem;/); // 8px
  assert.match(root, /--space-md: 0\.75rem;/); // 12px
  assert.match(root, /--space-lg: 1rem;/); // 16px
  assert.match(root, /--space-xl: 1\.5rem;/); // 24px
  assert.match(root, /--space-2xl: 3rem;/); // 48px
});

test("every padding, gap, and margin uses the scale", () => {
  // px, %, ch, auto, and 0 are not spacing-scale decisions — a 1px hairline or a
  // 100% fill answers to layout, not rhythm. Only rem literals must be tokens.
  const offenders: string[] = [];
  for (const [, property, value] of css.matchAll(
    /\n\s*(padding|gap|margin|row-gap|column-gap|padding-(?:top|right|bottom|left|inline|block)|margin-(?:top|right|bottom|left|inline|block))(?:-\w+)?:\s*([^;]+);/g,
  )) {
    for (const component of value.split(/[\s()+]+/)) {
      if (/^\d*\.?\d+rem$/.test(component)) offenders.push(`${property}: ${value.trim()}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], [], "raw rem spacing values remain");
});
