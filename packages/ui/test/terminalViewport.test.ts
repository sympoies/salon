import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  keyboardInsetFromViewport,
  keyboardWasDismissed,
  preventKeyBarMouseFocus,
  setKeyboardInsetStyle,
} from "../src/terminalViewport.ts";

test("keyboardInsetFromViewport returns the visual viewport bottom occlusion", () => {
  assert.equal(
    keyboardInsetFromViewport({
      layoutHeight: 800,
      visualHeight: 500,
      visualOffsetTop: 0,
    }),
    300,
  );
});

test("keyboardInsetFromViewport includes visual viewport offset", () => {
  assert.equal(
    keyboardInsetFromViewport({
      layoutHeight: 800,
      visualHeight: 500,
      visualOffsetTop: 40,
    }),
    260,
  );
});

test("keyboardInsetFromViewport clamps non-keyboard geometry to zero", () => {
  assert.equal(
    keyboardInsetFromViewport({
      layoutHeight: 800,
      visualHeight: 820,
      visualOffsetTop: 0,
    }),
    0,
  );
});

test("keyboardWasDismissed fires only on the raised-to-hidden transition", () => {
  // Keyboard dismissed: inset falls from raised (333) back to hidden (0).
  assert.equal(keyboardWasDismissed(333, 0, 80), true);
  // Keyboard being raised: no dismissal.
  assert.equal(keyboardWasDismissed(0, 333, 80), false);
  // Still raised (e.g. a scroll while typing): no dismissal.
  assert.equal(keyboardWasDismissed(333, 333, 80), false);
  // Still hidden: no dismissal.
  assert.equal(keyboardWasDismissed(0, 0, 80), false);
  // Small non-keyboard nudge (URL bar) below the threshold: not a dismissal.
  assert.equal(keyboardWasDismissed(40, 0, 80), false);
});

test("setKeyboardInsetStyle writes the CSS variable TerminalPane uses for the key bar", () => {
  const writes = new Map<string, string>();
  const target = {
    style: {
      setProperty(name: string, value: string) {
        writes.set(name, value);
      },
    },
  };

  setKeyboardInsetStyle(target, {
    layoutHeight: 800,
    visualHeight: 500,
    visualOffsetTop: 40,
  });

  assert.equal(writes.get("--keyboard-inset"), "260px");
});

test("setKeyboardInsetStyle resets the key bar inset when visualViewport is unavailable", () => {
  const writes = new Map<string, string>();
  const target = {
    style: {
      setProperty(name: string, value: string) {
        writes.set(name, value);
      },
    },
  };

  setKeyboardInsetStyle(target, null);

  assert.equal(writes.get("--keyboard-inset"), "0px");
});

test("preventKeyBarMouseFocus prevents key bar taps from stealing terminal focus", () => {
  let prevented = false;

  preventKeyBarMouseFocus({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
});
