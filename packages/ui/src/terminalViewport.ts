export interface ViewportGeometry {
  readonly layoutHeight: number;
  readonly visualHeight: number;
  readonly visualOffsetTop: number;
}

export interface KeyboardInsetStyleTarget {
  readonly style: {
    setProperty(name: string, value: string): void;
  };
}

export interface PreventableFocusEvent {
  preventDefault(): void;
}

export function keyboardInsetFromViewport({
  layoutHeight,
  visualHeight,
  visualOffsetTop,
}: ViewportGeometry): number {
  const hiddenBottom = layoutHeight - visualOffsetTop - visualHeight;
  return Number.isFinite(hiddenBottom) ? Math.max(0, hiddenBottom) : 0;
}

// True when the keyboard inset falls from "raised" back to "hidden" between two
// samples. xterm keeps its hidden textarea focused after the on-screen keyboard
// is dismissed, so Android re-raises the keyboard on the next touch of that
// element — including a scroll/swipe, which never passes through the tap
// focus-gate. Detecting the dismissal lets the caller blur the terminal so the
// keyboard stays down until an explicit re-summon. The threshold ignores small
// viewport nudges (e.g. the browser URL bar) that are not the keyboard.
export function keyboardWasDismissed(
  previousInset: number,
  currentInset: number,
  thresholdPx: number,
): boolean {
  return previousInset > thresholdPx && currentInset <= thresholdPx;
}

export function setKeyboardInsetStyle(
  target: KeyboardInsetStyleTarget,
  geometry: ViewportGeometry | null,
): void {
  const value = geometry ? `${keyboardInsetFromViewport(geometry)}px` : "0px";
  target.style.setProperty("--keyboard-inset", value);
}

export function preventKeyBarMouseFocus(event: PreventableFocusEvent): void {
  event.preventDefault();
}
