export function hasCoarsePrimaryPointer(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

export function hasAnyCoarsePointer(): boolean {
  return window.matchMedia?.("(any-pointer: coarse)").matches ?? false;
}
