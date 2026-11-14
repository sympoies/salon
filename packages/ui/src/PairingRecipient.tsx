import { useEffect, useRef, useState } from "react";
import { BrandTitle } from "./BrandTitle.tsx";
import { AsyncButton } from "./AsyncButton.tsx";
import { deviceRequest, pairingConnection, pairingConnectionCurrent, installNativePairing, recipientVerifier,
  type PairingConnection, type DeviceExchange, type PairingStatus } from "./deviceSignIn.ts";
import { isTauri, loadServerUrl } from "./runtime.ts";
import { clearLandingPairingCode, landingPairingCode } from "./pairingLanding.ts";

export function PairingRecipient({ onSignedIn, onCancel }: { readonly onSignedIn: () => void; readonly onCancel: () => void }) {
  const codeInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const serverInput = useRef<HTMLInputElement>(null);
  const connection = useRef<PairingConnection | null>(null);
  const native = isTauri();
  const [claim, setClaim] = useState<PairingStatus | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secrets = useRef<{ code: string; verifier: string; challenge: string } | null>(null);
  const alive = useRef(true);
  const signedIn = useRef(onSignedIn); signedIn.current = onSignedIn;
  useEffect(() => { alive.current = true; return () => { alive.current = false; secrets.current = null; }; }, []);

  const start = async () => {
    setBusy(true); setError(null); setConsented(false);
    try {
      const code = codeInput.current?.value.trim() ?? "";
      const target = pairingConnection(serverInput.current?.value.trim());
      connection.current = target;
      const proof = await recipientVerifier();
      const status = await deviceRequest<PairingStatus>("pairings/claim", {
        code, challenge: proof.challenge, name: nameInput.current?.value.trim() || "New device", delivery: native ? "native" : "browser",
      }, "POST", undefined, target);
      if (!alive.current) return;
      if (!pairingConnectionCurrent(target) || status.challenge !== proof.challenge || status.origin !== target.origin
        || !status.principal || status.delivery !== (native ? "native" : "browser"))
        throw new Error("Unexpected claim");
      secrets.current = { code, ...proof }; setClaim(status);
    } catch { if (alive.current) setError("Pairing unavailable. Check the code or create a new pairing."); }
    finally { if (alive.current) setBusy(false); }
  };

  useEffect(() => {
    if (!consented || !claim || !secrets.current || !connection.current) return;
    const target = connection.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = { ...secrets.current, principal: claim.principal, origin: claim.origin, delivery: claim.delivery, confirmed: true };
    const exchange = async () => {
      try {
        const issued = await deviceRequest<DeviceExchange>("pairings/exchange", bound, "POST", controller.signal, target);
        if (controller.signal.aborted) return;
        if (issued.principal !== claim.principal) throw new Error("Unexpected account");
        if (native) installNativePairing(issued, target);
        secrets.current = null; clearLandingPairingCode(); setConsented(false); setClaim(null); signedIn.current();
      } catch {
        if (controller.signal.aborted) return;
        if (!pairingConnectionCurrent(target)) {
          secrets.current = null; clearLandingPairingCode(); setConsented(false); setClaim(null);
          setError("Connection changed. Start with a new pairing code."); return;
        }
        if (Date.now() >= claim.expires_at) { setConsented(false); setError("Pairing ended. Ask for a new code."); return; }
        timer = setTimeout(() => { void exchange(); }, 5000);
      }
    };
    void exchange();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [consented, claim]);

  return <div className="login"><section className="login-card device-pairing" aria-label="New device sign-in">
    <BrandTitle /><h1>Sign in this device</h1>
    {!claim ? <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <p>Enter the one-time code shown on your signed-in device.</p>
      {native ? <label>Server URL<input aria-label="Server URL" ref={serverInput} type="url"
        defaultValue={loadServerUrl()} placeholder="https://console.example.test" required autoComplete="off" /></label> : null}
      <label>Pairing code<input aria-label="Pairing code" ref={codeInput} defaultValue={landingPairingCode() ?? ""}
        autoComplete="off" spellCheck={false} autoCapitalize="characters" required maxLength={80} /></label>
      <label>Device name<input aria-label="Device name" ref={nameInput} defaultValue={native ? "New device" : "New browser"} required maxLength={80} /></label>
      <AsyncButton className="btn primary" type="submit" pending={busy}>Continue</AsyncButton>
    </form> : <>
      <p>Server <strong className="device-origin">{claim.origin}</strong></p>
      <p>Account <strong>{claim.principal}</strong></p>
      <p>Compare this with your signed-in device:</p><output className="pairing-verification">{claim.verification}</output>
      <p>Approve only a device you have with you. Continue only if this is the account you intend to use.</p>
      {consented ? <p role="status">Waiting for approval on your signed-in device…</p>
        : <button className="btn primary" type="button" onClick={() => setConsented(true)}>Sign in as {claim.principal}</button>}
    </>}
    {error ? <p className="err" role="alert">{error}</p> : null}
    <button className="btn ghost" type="button" onClick={() => { clearLandingPairingCode(); secrets.current = null; onCancel(); }}>Cancel</button>
  </section></div>;
}
