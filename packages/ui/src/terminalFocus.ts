const KEYBOARD_ACTIVATION_FRACTION = 1 / 3;

export interface TerminalFocusRect {
  readonly top: number;
  readonly height: number;
}

// Touch-first devices should not have the terminal grab focus (and summon the
// on-screen keyboard) on load or on an incidental tap. We detect them by the
// primary pointer being coarse; a fine-pointer (mouse/trackpad) device is never
// gated. Per-event pointerType gating is intentionally not used here: the
// focus-suppression path relies on `mousedown` preventDefault, whose event
// carries no pointerType, so `coarsePointer` is the only load-bearing signal.
export function shouldGateTerminalFocus(coarsePointer: boolean): boolean {
  return coarsePointer;
}

export interface TerminalInteractionState {
  readonly focused: boolean;
  readonly mobile: boolean;
}

export function shouldTerminalPaneAcceptInteraction(state: TerminalInteractionState): boolean {
  return state.focused || !state.mobile;
}

// Restore the summon band to the terminal's keyboard-independent height. When
// the on-screen keyboard is up, `--keyboard-inset` padding on `.terminal-pane`
// shrinks the flexed host content box, which slides the bottom-third band up
// into the middle of the screen and lets a mid-screen tap re-summon the
// keyboard. Folding the inset back into the host height keeps the band anchored
// where it sits with no keyboard. Non-finite/negative insets are ignored so a
// bad measurement never shifts the band.
export function keyboardActivationRect(
  rect: TerminalFocusRect,
  keyboardInset: number,
): TerminalFocusRect {
  const inset = Number.isFinite(keyboardInset) ? Math.max(0, keyboardInset) : 0;
  return { top: rect.top, height: rect.height + inset };
}

export function isKeyboardActivationArea(clientY: number, rect: TerminalFocusRect): boolean {
  if (
    !Number.isFinite(clientY) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.height) ||
    rect.height <= 0
  ) {
    // Unmeasurable geometry must not open the whole screen to a keyboard-
    // summoning tap; suppress until a real measurement is available.
    return false;
  }

  const activationTop = rect.top + rect.height - rect.height * KEYBOARD_ACTIVATION_FRACTION;
  return clientY >= activationTop;
}
