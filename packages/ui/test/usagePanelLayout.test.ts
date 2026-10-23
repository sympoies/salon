import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCssRuleLookup, uiStyles } from "./support/source.ts";

const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);

// The Usage page lays cards out in an auto-fill grid. Claude carries two windows
// (5h + Weekly) while a single-account Codex card carries one, so a shared row is
// as tall as the Claude card. The grid must not stretch the shorter cards to that
// height (the default `align-items: stretch`), or a single-window Codex card
// balloons with a large empty lower half. `align-items: start` keeps every card at
// its own content height; the leftover row space stays empty grid area, not a
// half-blank bordered card.
test("usage cards size to their own content instead of stretching to the tallest in a row", () => {
  assert.match(cssRuleFor(".usage-providers"), /align-items: start;/);
});
