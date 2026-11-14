let code: string | undefined;

/** This module runs before App/API/debug imports in the core mounting entry. */
export function capturePairingLanding(target: Pick<Window, "location" | "history">): void {
  if (!target.location.hash.startsWith("#pair=")) return;
  const raw = new URLSearchParams(target.location.hash.slice(1)).get("pair") ?? "";
  target.history.replaceState(null, "", target.location.pathname + target.location.search);
  code = raw.length <= 80 ? raw : undefined;
}
if (typeof window !== "undefined") capturePairingLanding(window);
export const landingPairingCode = (): string | undefined => code;
export function clearLandingPairingCode(): void { code = undefined; }
