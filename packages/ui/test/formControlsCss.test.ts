import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCssRuleLookup, sourceBlock, uiStyles } from "./support/source.ts";

const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);
const textInputSelector =
  'input:where(:not([type]), [type="text"], [type="password"], [type="url"], [type="email"], [type="search"], [type="tel"])';
const sharedControlSelector = `${textInputSelector},\nselect,\ntextarea,\n.select-menu-trigger`;
const sharedFocusSelector = `${textInputSelector}:focus-visible,\nselect:focus-visible,\ntextarea:focus-visible,\n.select-menu-trigger:focus-visible`;

test("form controls share one border, radius, height, and focus contract", () => {
  const root = cssRuleFor(":root");
  assert.match(root, /--control-height: 34px;/);
  assert.match(root, /--form-field-height: var\(--control-height\);/);
  assert.match(root, /--control-compact-height: 34px;/);
  assert.match(root, /--control-toolbar-height: 34px;/);
  assert.match(root, /--control-border-width: 1px;/);
  assert.match(root, /--r-md: 8px;/);
  assert.match(root, /--control-radius: var\(--r-md\);/);
  assert.match(root, /--control-focus-ring-width: 2px;/);
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?--control-height: 44px;/);

  assert.match(css, /--icon-standard-size: 34px;/, "toolbar and menu icon buttons restore their 34px family size");
  assert.match(css, /--icon-compact-size: 30px;/, "pane and card icon buttons restore their 30px family size");
  assert.match(css, /--icon-identity-size: 34px;/, "identity marks retain the former toolbar family size");
  assert.match(css, /--control-menu-height: 34px;/, "menu rows restore their 34px minimum");

  const controls = sourceBlock(css, "/* Shared form controls", "/* login */");
  const controlRuleFor = makeCssRuleLookup(controls);
  const baseRule = controlRuleFor(sharedControlSelector);
  assert.match(baseRule, /appearance: none;/);
  assert.match(baseRule, /min-height: var\(--form-field-height\);/);
  assert.match(baseRule, /background: var\(--surface-inset\);/);
  assert.match(baseRule, /border: var\(--control-border-width\) solid var\(--border-default\);/);
  assert.match(baseRule, /border-radius: var\(--control-radius\);/);

  const focusRule = controlRuleFor(sharedFocusSelector);
  assert.match(focusRule, /border-color: var\(--accent\);/);
  assert.match(focusRule, /box-shadow: 0 0 0 var\(--control-focus-ring-width\) var\(--control-focus-ring\);/);

  const forcedColorsStart = controls.indexOf("@media (forced-colors: active)");
  assert.notEqual(forcedColorsStart, -1, "missing forced-colors form-control fallback");
  const forcedColors = controls.slice(forcedColorsStart).replace(/^  /gm, "");
  const forcedFocusRule = makeCssRuleLookup(forcedColors)(sharedFocusSelector);
  assert.match(forcedFocusRule, /outline: 2px solid Highlight;/);
  assert.match(forcedFocusRule, /box-shadow: none;/);
});

test("native and app-rendered select decoration preserves the shared geometry", () => {
  const controls = sourceBlock(css, "/* Shared form controls", "/* login */");
  const controlRuleFor = makeCssRuleLookup(controls);
  const selectorDecoration = controlRuleFor("select,\n.select-menu-trigger");
  assert.match(selectorDecoration, /background-image:/);
  assert.match(selectorDecoration, /background-position: right 0\.7rem center;/);
  assert.match(controls, /textarea \{[\s\S]*?min-height: 4\.5rem;/);

  assert.match(cssRuleFor(".slot-title-input"), /min-height: var\(--control-compact-height\);/);
  assert.match(cssRuleFor(".term-title-input"), /min-height: var\(--control-compact-height\);/);
  assert.match(cssRuleFor(".debug-toolbar select"), /min-height: var\(--control-height\);/);
  assert.match(cssRuleFor(".machine-filter"), /min-height: var\(--control-toolbar-height\);/);
  assert.match(cssRuleFor(".machine-filter"), /border: var\(--control-border-width\) solid var\(--line\);/);
  assert.match(cssRuleFor(".machine-filter"), /border-radius: var\(--control-radius\);/);
  assert.match(cssRuleFor(".settings-color-input"), /border: var\(--control-border-width\) solid var\(--line\);/);
});
