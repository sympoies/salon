import { isAndroidTauri } from "./runtime.ts";

/** The single phone-tier rule: the Android app at any width, else narrow widths or a coarse pointer up to 1024px. */
export function isPhoneWidth(width: number, coarse: boolean, android: boolean): boolean {
  return android || width <= 760 || (coarse && width <= 1024);
}

export function isCoarsePointer(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

// The Android app shows its session tiles on the wide (non-phone) layout while
// a layout is chosen and no session is open; Dashboard sets this (#219).
let androidTileGrid = false;

export function setAndroidTileGrid(on: boolean): void {
  androidTileGrid = on;
  syncPhoneTier();
}

export function isPhoneTier(): boolean {
  return typeof window !== "undefined" && isPhoneWidth(window.innerWidth, isCoarsePointer(), isAndroidTauri() && !androidTileGrid);
}

/**
 * Publish the tier on the root element so styles.css follows the same decision
 * as the JS layout; the phone rules there are keyed on `data-phone-tier`.
 */
export function syncPhoneTier(): void {
  document.documentElement.dataset.phoneTier = String(isPhoneTier());
  document.documentElement.dataset.androidApp = String(isAndroidTauri());
}

export function watchPhoneTier(): () => void {
  syncPhoneTier();
  const pointer = window.matchMedia?.("(pointer: coarse)");
  window.addEventListener("resize", syncPhoneTier);
  window.addEventListener("orientationchange", syncPhoneTier);
  pointer?.addEventListener("change", syncPhoneTier);
  return () => {
    window.removeEventListener("resize", syncPhoneTier);
    window.removeEventListener("orientationchange", syncPhoneTier);
    pointer?.removeEventListener("change", syncPhoneTier);
  };
}
