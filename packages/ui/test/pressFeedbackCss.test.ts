import { strict as assert } from "node:assert";
import { test } from "node:test";
import { uiStyles } from "./support/source.ts";

const styles = uiStyles();

// This is a mobile-first console where :hover never fires on touch, so a
// pressed state is the only reliable tap-registered signal. These guards keep
// that press affordance from being silently dropped (regression protection for
// the raw CSS rules, mirroring mobileActionsCss.test.ts — happy-dom does not
// resolve :active/:hover pseudo-class state, so the rendered effect itself is
// verified on-device, not here).

test("every interactive control gets a layout-neutral press", () => {
  assert.match(
    styles,
    /button:not\(:disabled\):active,\s*summary:active,\s*\[role="link"\]:active\s*\{[^}]*transform:\s*scale\(0\.96\);/s,
  );
});

test("filled buttons darken on press", () => {
  assert.match(
    styles,
    /\.btn:not\(:disabled\):active\s*\{[^}]*filter:\s*brightness\(0\.9\);/s,
  );
});

test("the centered reconnect button composes the press scale with its offset", () => {
  // transform is not additive: without re-stating the centering translate, the
  // global press scale would drop the -50%/-50% offset and the button would
  // jump to the origin exactly while it is being pressed.
  assert.match(
    styles,
    /\.terminal-reconnect:not\(:disabled\):active\s*\{[^}]*transform:\s*translate\(-50%, -50%\) scale\(0\.96\);/s,
  );
});

test("the in-flow quota button scales without adding a centering offset", () => {
  assert.match(
    styles,
    /\.workspace-head\s*>\s*\.header-usage:not\(:disabled\):active\s*\{[^}]*transform:\s*scale\(0\.96\);/s,
  );
});

test("reduced-motion quota press feedback preserves its in-flow position", () => {
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.workspace-head\s*>\s*\.header-usage:not\(:disabled\):active\s*\{[^}]*transform:\s*none;/s,
  );
});

test("reduced motion swaps the press movement for a non-motion flash", () => {
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*button:not\(:disabled\):active,[^@]*transform:\s*none;[^@]*filter:\s*brightness\(1\.2\);/s,
  );
});

test("the default WebView tap-highlight box is replaced by the deliberate press", () => {
  assert.match(
    styles,
    /button,\s*summary,\s*\[role="link"\]\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent;/s,
  );
});

test("base and ghost buttons gain a hover/focus affordance without touching .danger", () => {
  assert.match(
    styles,
    /\.btn:not\(\.danger\):not\(:disabled\):hover,\s*\.btn:not\(\.danger\):not\(:disabled\):focus-visible\s*\{[^}]*border-color:\s*var\(--accent\);/s,
  );
  // The pre-existing louder .danger hover must survive the new scoped hover.
  assert.match(
    styles,
    /\.btn\.danger:hover,\s*\.btn\.danger:focus-visible\s*\{[^}]*border-color:\s*rgba\(248, 113, 113, 0\.82\);/s,
  );
});

test("primary buttons brighten on hover and darken on press", () => {
  assert.match(
    styles,
    /\.btn\.primary:not\(:disabled\):hover,\s*\.btn\.primary:not\(:disabled\):focus-visible\s*\{[^}]*filter:\s*brightness\(1\.08\);/s,
  );
  assert.match(
    styles,
    /\.btn\.primary:not\(:disabled\):active\s*\{[^}]*filter:\s*brightness\(0\.9\);/s,
  );
});
