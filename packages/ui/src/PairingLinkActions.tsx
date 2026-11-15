import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AsyncButton } from "./AsyncButton.tsx";
import { importPairingLink, isTauri, nativeConnectionConfigGeneration, parsePairingLink, pendingPairingLink } from "./runtime.ts";

export interface PairingLinkOptions {
  /** Native scanner adapter. Return null for cancellation; never log the result. */
  readonly scanPairingLink?: () => Promise<string | null>;
  /** Browser adapter for an explicit handoff, before browser delivery is claimed. */
  readonly openPairingLinkInApp?: (url: string) => void | Promise<void>;
}
export const PairingLinkContext = createContext<PairingLinkOptions>({});

export function ScanPairingLinkButton() {
  const { scanPairingLink } = useContext(PairingLinkContext);
  const [error, setError] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (!isTauri() || !scanPairingLink) return null;
  const scan = async () => {
    const generation = nativeConnectionConfigGeneration();
    const pending = pendingPairingLink();
    setError(false);
    try {
      const link = await scanPairingLink();
      if (active.current && generation === nativeConnectionConfigGeneration() && pending === pendingPairingLink() && link !== null)
        importPairingLink(link);
    } catch { if (active.current) setError(true); }
  };
  return <><AsyncButton className="btn ghost" type="button" onClick={scan}>Scan QR</AsyncButton>
    {error ? <p className="err" role="alert">QR scan unavailable. Please try again.</p> : null}</>;
}

export function OpenPairingLinkInAppButton({ code, disabled }: { readonly code: string | undefined; readonly disabled: boolean }) {
  const { openPairingLinkInApp } = useContext(PairingLinkContext);
  const [error, setError] = useState(false);
  if (isTauri() || !openPairingLinkInApp || !code) return null;
  let link: string;
  try { link = `${window.location.origin}/#pair=${code}`; parsePairingLink(link); }
  catch { return null; }
  const open = () => {
    setError(false);
    try { void Promise.resolve(openPairingLinkInApp(link)).catch(() => setError(true)); }
    catch { setError(true); }
  };
  return <><button className="btn ghost" type="button" disabled={disabled} onClick={open}>Open in app</button>
    {error ? <p className="err" role="alert">App handoff unavailable. Please try again.</p> : null}</>;
}
