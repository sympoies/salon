import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCssRuleLookup, uiStyles } from "./support/source.ts";

const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);
const root = cssRuleFor(":root");

/* Hierarchy is carried by three text levels and a small weight scale, so a rule
   can rank its content without wrapping it in another box. The contrast checks
   below are computed rather than pinned to hex values: the contract is "stays
   readable on every surface it can land on", which must survive a palette
   tweak. */

function tokenValue(name: string): string {
  const match = root.match(new RegExp(`--${name}: *([^;]+);`));
  assert.ok(match, `missing --${name} in :root`);
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

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

// Every surface body text can land on. surface-3 is the brightest, so it is the
// worst case for a dim foreground.
const TEXT_SURFACES = ["surface-1", "surface-2", "surface-3"];

test("root declares three text levels and the weight scale", () => {
  assert.match(root, /--fg: #d6deeb;/);
  assert.match(root, /--fg-2: #a8bdd4;/);
  assert.match(root, /--muted: #8ba1b8;/);

  assert.match(root, /--weight-normal: 400;/);
  assert.match(root, /--weight-medium: 600;/);
  assert.match(root, /--weight-bold: 700;/);
  assert.match(root, /--weight-heavy: 800;/);
});

test("every text level clears WCAG AA on every surface it can land on", () => {
  for (const surface of TEXT_SURFACES) {
    const background = tokenValue(surface);

    // Primary text is held well above the floor; it carries long-form reading.
    assert.ok(
      contrast(tokenValue("fg"), background) >= 7,
      `--fg on --${surface} is ${contrast(tokenValue("fg"), background).toFixed(2)}:1, want >= 7`,
    );
    for (const level of ["fg-2", "muted"]) {
      const ratio = contrast(tokenValue(level), background);
      assert.ok(ratio >= 4.5, `--${level} on --${surface} is ${ratio.toFixed(2)}:1, want >= 4.5 (AA body text)`);
    }
  }
});

test("the three levels are far enough apart to read as a hierarchy", () => {
  // Adjacent levels that differ only slightly register as inconsistency, not
  // rank — the same failure the old 0.74/0.75/0.76rem type sizes had.
  const levels = ["fg", "fg-2", "muted"].map((name) => luminance(tokenValue(name)));
  for (let index = 0; index + 1 < levels.length; index += 1) {
    const gap = levels[index] - levels[index + 1];
    assert.ok(gap >= 0.1, `text levels ${index} and ${index + 1} differ by only ${gap.toFixed(3)} relative luminance`);
  }
});

test("secondary content reads at the middle level instead of the chrome level", () => {
  // Content the user actually reads to understand a session, previously dimmed
  // to the same level as ordinals and icons.
  for (const selector of [
    ".mobile-session-card-prompt",
    ".slot-menu-meta",
    ".account-usage-note",
    ".startup-failure-meta",
    ".debug-diagnostic",
    ".settings-row-note",
    ".select-menu-option-meta",
  ]) {
    assert.match(cssRuleFor(selector), /color: var\(--fg-2\);/, `${selector} should use the middle text level`);
  }

  // Chrome stays at --muted: labels, ordinals, and icons are scanned past.
  for (const selector of [".slot-menu-section-label", ".slot-ordinal", ".ago", ".session-activity-label"]) {
    assert.match(cssRuleFor(selector), /color: var\(--muted\);/, `${selector} should stay at the chrome level`);
  }
});

/* Item 2: one separator per edge -------------------------------------------
   A surface that is already lighter than its parent and carries a shadow does
   not also need a hard border. Controls keep theirs — the border is what makes
   them read as pressable. */

test("floating layers and resting containers use the soft hairline", () => {
  for (const selector of [
    ".header-menu-dropdown",
    ".slot-title-dropdown",
    ".slot-session-nav-dropdown",
    ".select-menu-options",
    ".workdir-options",
    ".modal",
    ".terminal-touch-menu",
    ".login-card",
    ".settings-row",
    ".debug-event",
    ".log-view",
    ".upload-status",
  ]) {
    const rule = cssRuleFor(selector);
    assert.match(rule, /border: 1px solid var\(--border-subtle\);/, `${selector} should use the soft hairline`);
  }
});

test("interactive controls keep a visible border as their affordance", () => {
  for (const selector of [".btn", ".segmented-control", ".key", ".slot-action"]) {
    const rule = cssRuleFor(selector);
    assert.match(rule, /border: (1px|var\(--control-border-width\)) solid var\(--border-default\);/, `${selector} must stay bordered`);
  }
});

test("no rule stacks a hard border on top of the deepest elevation", () => {
  const offenders = [...css.matchAll(/\n([^\n@{]+) \{([^}]*)\}/g)]
    .filter(([, , body]) => body.includes("var(--elev-3)") && /border: 1px solid var\(--border-default\);/.test(body))
    .map(([, selector]) => selector.trim());
  assert.deepEqual(offenders, [], "floating layers still carry a hard border");
});

test("every font-weight uses the scale", () => {
  // @font-face descriptors declare the weight a file *provides*; they are not
  // a hierarchy choice and stay numeric.
  const withoutFontFace = css.replace(/@font-face \{[^}]*\}/g, "");
  const offenders = [...withoutFontFace.matchAll(/font-weight:\s*([^;]+);/g)]
    .map((match) => match[1].trim())
    .filter((value) => !value.includes("var(--weight-"));
  assert.deepEqual([...new Set(offenders)], [], "unscaled font-weight values remain");
});
