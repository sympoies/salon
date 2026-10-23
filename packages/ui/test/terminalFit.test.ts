import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BASE_TERMINAL_FONT_SIZE,
  COLUMN_REFIT_WIDTH_THRESHOLD_PX,
  fitReadableTerminal,
  isFittableTerminalHost,
  MIN_READABLE_TERMINAL_COLS,
  shouldRecomputeTerminalColumns,
  type FittableTerminal,
  type TerminalFitter,
} from "../src/terminalFit.ts";

function fakeTerminal(colsByFontSize: ReadonlyMap<number, number>) {
  const term: FittableTerminal = {
    cols: 0,
    options: {
      fontSize: BASE_TERMINAL_FONT_SIZE,
    },
  };
  const fitter: TerminalFitter = {
    fit() {
      term.cols = colsByFontSize.get(term.options.fontSize) ?? 0;
    },
  };
  return { term, fitter };
}

test("fitReadableTerminal keeps the base font when it already reaches the target columns", () => {
  const { term, fitter } = fakeTerminal(new Map([[BASE_TERMINAL_FONT_SIZE, 57]]));

  fitReadableTerminal(term, fitter);

  assert.equal(term.options.fontSize, BASE_TERMINAL_FONT_SIZE);
  assert.equal(term.cols, 57);
});

test("fitReadableTerminal steps below the former floor until the current Codex frame fits", () => {
  const { term, fitter } = fakeTerminal(
    new Map([
      [14, 49],
      [13.75, 49],
      [13.5, 49],
      [13.25, 49],
      [13, 49],
      [12.75, 49],
      [12.5, 49],
      [12.25, 49],
      [12, 49],
      [11.75, 50],
      [11.5, 51],
      [11.25, 52],
      [11, 53],
      [10.75, 54],
      [10.5, 56],
    ]),
  );

  fitReadableTerminal(term, fitter);

  assert.equal(MIN_READABLE_TERMINAL_COLS, 56);
  assert.equal(term.options.fontSize, 10.5);
  assert.equal(term.cols, 56);
});

test("fitReadableTerminal stops at the minimum font size when the screen is too narrow", () => {
  const { term, fitter } = fakeTerminal(
    new Map([
      [14, 44],
      [13.75, 45],
      [13.5, 46],
      [13.25, 47],
      [13, 48],
      [12.75, 48],
      [12.5, 48],
      [12.25, 48],
      [12, 48],
      [11.75, 49],
      [11.5, 50],
      [11.25, 51],
      [11, 52],
      [10.75, 53],
      [10.5, 54],
      [10.25, 55],
      [10, 55],
    ]),
  );

  fitReadableTerminal(term, fitter);

  assert.equal(term.options.fontSize, 10);
  assert.equal(term.cols, 55);
});

test("shouldRecomputeTerminalColumns always recomputes on a forced sync or the first fit", () => {
  // Forced syncs (session open, font-size / readable-fit toggle) must re-derive
  // columns regardless of width, and the first fit has no prior width to compare.
  assert.equal(shouldRecomputeTerminalColumns(null, 320, false), true);
  assert.equal(shouldRecomputeTerminalColumns(320, 320, true), true);
});

test("shouldRecomputeTerminalColumns pins columns across a keyboard-sized (height-only) change", () => {
  // The soft keyboard changes host HEIGHT only; the measured width stays put (or
  // jitters under the threshold), so columns must NOT be recomputed — otherwise a
  // full-width TUI status block reflows into two rows when the keyboard opens.
  assert.equal(shouldRecomputeTerminalColumns(320, 320, false), false);
  assert.equal(
    shouldRecomputeTerminalColumns(320, 320 - COLUMN_REFIT_WIDTH_THRESHOLD_PX, false),
    false,
  );
  assert.equal(shouldRecomputeTerminalColumns(320, 310, false), false);
});

test("shouldRecomputeTerminalColumns recomputes when the width really changes (rotation)", () => {
  // An orientation change moves width by hundreds of px, far past the threshold,
  // so columns should be re-derived for the new geometry.
  assert.equal(
    shouldRecomputeTerminalColumns(320, 320 + COLUMN_REFIT_WIDTH_THRESHOLD_PX + 1, false),
    true,
  );
  assert.equal(shouldRecomputeTerminalColumns(390, 844, false), true);
});

test("isFittableTerminalHost rejects an unmeasured host so fit never caches 0x0 dimensions", () => {
  // A grid slot whose flex box has not resolved yet measures 0 in one or both
  // axes; fitting then computes degenerate cols/rows and the DOM renderer paints
  // nothing even though the PTY buffer fills. Only a host with a real box fits.
  assert.equal(isFittableTerminalHost({ width: 0, height: 0 }), false);
  assert.equal(isFittableTerminalHost({ width: 320, height: 0 }), false);
  assert.equal(isFittableTerminalHost({ width: 0, height: 200 }), false);
  assert.equal(isFittableTerminalHost({ width: 320, height: 200 }), true);
});
