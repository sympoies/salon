import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCssRuleLookup, uiStyles } from "./support/source.ts";

const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);

/* What a session card is about should be the loudest thing on it. The surface
   ladder work left three places where something else outshouted the title. */

test("the prompt preview stays a clear step below the title", () => {
  // Both size and color had drifted toward the title at once: the prompt moved
  // 0.82rem -> --text-md when the type scale landed, and --fg-2 lifted it from
  // 3.15:1 to 7.73:1. Two steps of separation, not one, keeps the rank legible.
  const title = cssRuleFor(".mobile-session-card-title");
  const prompt = cssRuleFor(".mobile-session-card-prompt");

  assert.match(title, /font-size: var\(--text-lg\);/);
  assert.match(title, /color: var\(--fg\);/);
  assert.match(prompt, /font-size: var\(--text-sm\);/);
  assert.match(prompt, /color: var\(--fg-2\);/);
});
