import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { makeCssRuleLookup, uiSource, uiStyles } from "./support/source.ts";

const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);

/* A disclosure arrow drawn as a text character renders at the mercy of whatever
   font the platform falls back to. U+2304 in particular is designed to sit high
   in its em box, so it never optically centers in a control — and the Android
   WebView, macOS, and desktop browsers each pick a different face for it. This
   stylesheet already carries an SVG for exactly that reason. */

test("the shared select chevron can be positioned by its caller", () => {
  const icons = uiSource("icons.tsx");
  // Previously the class was baked in, which is why the second call site could
  // not reuse it: machine-filter-chevron is absolutely positioned.
  assert.match(icons, /export function SelectChevronIcon\(\{\s*className[^}]*\}/);
  assert.match(icons, /className = "machine-filter-chevron"/, "the original caller keeps its class by default");
});

test("the shared Filters entry uses a labeled text control", () => {
  const navigator = uiSource("SessionListNavigator.tsx");
  assert.match(navigator, /SessionFiltersBar/);
  assert.match(uiSource("SessionFiltersBar.tsx"), /className="session-filter-searchbar"/);
  assert.match(uiSource("SessionFiltersBar.tsx"), /className="session-filter-search-icon"/);
  assert.doesNotMatch(uiSource("SessionFiltersBar.tsx"), /session-list-group-trigger-chevron/);
});

test("the machine chevron keeps its shared icon size", () => {
  // .machine-filter-chevron is declared across two rules (positioning, then
  // offset and size), so assert against everything the class resolves to.
  const machineChevron = [...css.matchAll(/\n\.machine-filter-chevron \{([\s\S]*?)\}/g)]
    .map((match) => match[1])
    .join("");
  assert.match(machineChevron, /width: 14px;/);
  assert.match(machineChevron, /height: 14px;/);
});

test("no component draws an icon with a technical arrow symbol", () => {
  // Scoped to the symbols that actually misrender: technical (U+2303-2304) and
  // geometric-shape arrowheads are drawn to float in their em box and have thin
  // font coverage, so each platform centers and weights them differently.
  // Guillemets (‹ ›) are ordinary baseline punctuation with broad coverage, and
  // this UI uses them inline with label text ("‹ Back"), which is typography
  // rather than an icon — they are deliberately not covered here.
  const TEXT_ARROWS = /[⌃⌄▲▴▼▾◀◂▶▸]/;
  const sourceDir = new URL("../src/", import.meta.url);
  const offenders = readdirSync(sourceDir)
    .filter((name) => name.endsWith(".tsx"))
    .filter((name) => TEXT_ARROWS.test(readFileSync(new URL(name, sourceDir), "utf8")));
  assert.deepEqual(offenders, [], "components should use an SVG icon instead of an arrow character");
});
