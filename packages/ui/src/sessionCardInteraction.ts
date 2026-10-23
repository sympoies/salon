/** Explicit controls and their popup content keep their own action. */
export function isSessionCardControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    "a, button, input, textarea, select, summary, [contenteditable='true'], [role='button'], [role='link'], [role='menuitem'], [role='menu'], [role='dialog'], [role='tooltip']",
  ));
}
