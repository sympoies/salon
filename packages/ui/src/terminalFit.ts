export const BASE_TERMINAL_FONT_SIZE = 14;
const MIN_TERMINAL_FONT_SIZE = 10;
const TERMINAL_FONT_SIZE_STEP = 0.25;
// Codex's current startup model row is 56 cells wide; narrower mobile fits wrap
// its trailing command hint onto a second line and split the surrounding box.
export const MIN_READABLE_TERMINAL_COLS = 56;

// A soft-keyboard open/close changes the terminal host HEIGHT only, yet a re-fit
// can still nudge the measured column count by one (sub-pixel width jitter, or
// xterm re-measuring the font atlas). Reflowing a full-width TUI status block
// (codex/claude) on such a change is the "one line becomes two rows" mobile bug.
// So columns are recomputed only when the host WIDTH actually changes past this
// floor. An orientation change moves width by hundreds of px, far above it,
// while keyboard-induced width artifacts stay well under it.
export const COLUMN_REFIT_WIDTH_THRESHOLD_PX = 20;

// Decide whether a fit should re-derive the terminal column count. Forced syncs
// (session open, font-size / readable-fit toggle) and the first fit always
// recompute; otherwise columns stay pinned unless the host width moved past the
// threshold, so a height-only (keyboard) re-fit never reflows full-width lines.
export function shouldRecomputeTerminalColumns(
  lastWidth: number | null,
  currentWidth: number,
  forced: boolean,
  thresholdPx = COLUMN_REFIT_WIDTH_THRESHOLD_PX,
): boolean {
  if (forced || lastWidth === null) {
    return true;
  }
  return Math.abs(currentWidth - lastWidth) > thresholdPx;
}

export interface FittableTerminal {
  cols: number;
  options: {
    fontSize?: number;
  };
}

export interface TerminalFitter {
  fit(): void;
}

export interface TerminalHostSize {
  readonly width: number;
  readonly height: number;
}

// A terminal host with no resolved layout box (0 in either axis) makes xterm's
// FitAddon compute degenerate cols/rows and cache them; the DOM renderer then
// has nothing to paint even though the PTY buffer fills — the exact "typed but
// nothing shows in the grid" symptom. Callers must skip fitting until the host
// is actually measured; the ResizeObserver re-fits once it gains a real box.
export function isFittableTerminalHost(size: TerminalHostSize): boolean {
  return size.width > 0 && size.height > 0;
}

function fontSizeCandidates(): number[] {
  const candidates: number[] = [];
  for (
    let fontSize = BASE_TERMINAL_FONT_SIZE;
    fontSize >= MIN_TERMINAL_FONT_SIZE;
    fontSize -= TERMINAL_FONT_SIZE_STEP
  ) {
    candidates.push(Number(fontSize.toFixed(2)));
  }
  return candidates;
}

export function fitReadableTerminal(term: FittableTerminal, fit: TerminalFitter): void {
  for (const fontSize of fontSizeCandidates()) {
    term.options.fontSize = fontSize;
    fit.fit();
    if (term.cols >= MIN_READABLE_TERMINAL_COLS) {
      return;
    }
  }
}
