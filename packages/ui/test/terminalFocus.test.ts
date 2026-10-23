import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isKeyboardActivationArea,
  keyboardActivationRect,
  shouldGateTerminalFocus,
  shouldTerminalPaneAcceptInteraction,
} from "../src/terminalFocus.ts";

test("isKeyboardActivationArea only accepts taps in the bottom third", () => {
  const rect = { top: 100, height: 900 };

  assert.equal(isKeyboardActivationArea(699, rect), false);
  assert.equal(isKeyboardActivationArea(700, rect), true);
  assert.equal(isKeyboardActivationArea(999, rect), true);
});

test("isKeyboardActivationArea stays closed when geometry is unavailable", () => {
  // An unmeasurable (zero/degenerate) rect must not open the whole screen to a
  // keyboard-summoning tap; suppress instead of falling back open.
  assert.equal(isKeyboardActivationArea(100, { top: 0, height: 0 }), false);
  assert.equal(isKeyboardActivationArea(Number.NaN, { top: 0, height: 900 }), false);
});

test("keyboardActivationRect folds the keyboard inset back into the host height", () => {
  // With the keyboard up, `--keyboard-inset` padding shrinks the host content
  // box (900 -> 500 here). Folding the inset (400) back keeps the summon band
  // anchored to the keyboard-independent height so a mid-screen tap does not
  // re-summon the keyboard.
  const shrunk = { top: 0, height: 500 };
  const stable = keyboardActivationRect(shrunk, 400);

  assert.deepEqual(stable, { top: 0, height: 900 });
  // Mid-screen (400) is below the restored band top (600) -> suppressed.
  assert.equal(isKeyboardActivationArea(400, stable), false);
  assert.equal(isKeyboardActivationArea(700, stable), true);
  // Contrast: against the raw shrunk rect, mid-screen wrongly triggers (the bug).
  assert.equal(isKeyboardActivationArea(400, shrunk), true);
});

test("keyboardActivationRect ignores non-finite or negative insets", () => {
  const rect = { top: 10, height: 500 };
  assert.deepEqual(keyboardActivationRect(rect, Number.NaN), rect);
  assert.deepEqual(keyboardActivationRect(rect, -50), rect);
  assert.deepEqual(keyboardActivationRect(rect, 0), rect);
});

test("shouldGateTerminalFocus gates only coarse-pointer (touch-first) devices", () => {
  assert.equal(shouldGateTerminalFocus(false), false);
  assert.equal(shouldGateTerminalFocus(true), true);
});

test("shouldTerminalPaneAcceptInteraction keeps mobile previews inert until focused", () => {
  assert.equal(shouldTerminalPaneAcceptInteraction({ focused: false, mobile: true }), false);
  assert.equal(shouldTerminalPaneAcceptInteraction({ focused: true, mobile: true }), true);
  assert.equal(shouldTerminalPaneAcceptInteraction({ focused: false, mobile: false }), true);
});
