import { useEffect, useRef, useState } from "react";
import { BrandTitle } from "./BrandTitle.tsx";
import { AsyncButton } from "./AsyncButton.tsx";
import { deviceRequest, pairingConnection, pairingConnectionCurrent, installNativePairing, recipientVerifier,
  type PairingConnection, type DeviceExchange, type PairingStatus } from "./deviceSignIn.ts";
import { clearPairingLink, isTauri, loadServerUrl, NativeConnectionStorageError, pendingPairingLink, type ImportedPairingLink } from "./runtime.ts";
import { clearLandingPairingCode, landingPairingCode } from "./pairingLanding.ts";
import { OpenPairingLinkInAppButton } from "./PairingLinkActions.tsx";

export function PairingRecipient({ onSignedIn, onCancel, imported }: {
  readonly onSignedIn: () => void; readonly onCancel: () => void; readonly imported?: ImportedPairingLink;
}) {
  const codeInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const serverInput = useRef<HTMLInputElement>(null);
  const connection = useRef<PairingConnection | null>(null);
  const native = isTauri();
  const [claim, setClaim] = useState<PairingStatus | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savePending, setSavePending] = useState(false);
  const issuedCredential = useRef<{ issued: DeviceExchange; target: PairingConnection } | null>(null);
  const secrets = useRef<{ code: string; verifier: string; challenge: string } | null>(null);
  const alive = useRef(true);
  const signedIn = useRef(onSignedIn); signedIn.current = onSignedIn;
  useEffect(() => { alive.current = true; return () => { alive.current = false; secrets.current = null; }; }, []);
  const current = () => alive.current && pendingPairingLink() === imported;

  const start = async (active = () => true) => {
    setBusy(true); setError(null); setConsented(false);
    try {
      const code = imported?.code ?? codeInput.current?.value.trim() ?? "";
      const target = imported ?? pairingConnection(serverInput.current?.value.trim());
      connection.current = target;
      const proof = await recipientVerifier();
      if (!active() || !current() || !pairingConnectionCurrent(target)) return;
      const status = await deviceRequest<PairingStatus>("pairings/claim", {
        code, challenge: proof.challenge, name: nameInput.current?.value.trim() || "New device", delivery: native ? "native" : "browser",
      }, "POST", undefined, target);
      if (!active() || !current()) return;
      if (!pairingConnectionCurrent(target) || status.challenge !== proof.challenge || status.origin !== target.origin
        || !status.principal || status.delivery !== (native ? "native" : "browser"))
        throw new Error("Unexpected claim");
      secrets.current = { code, ...proof }; setClaim(status);
    } catch { if (active() && current()) setError("Pairing unavailable. Check the code or create a new pairing."); }
    finally { if (active() && current()) setBusy(false); }
  };

  useEffect(() => {
    let active = true;
    if (imported) void start(() => active);
    return () => { active = false; };
  }, [imported]);

  const saveIssued = async (issued: DeviceExchange, target: PairingConnection) => {
    try {
      await installNativePairing(issued, target);
      issuedCredential.current = null; setSavePending(false);
      secrets.current = null; clearLandingPairingCode(); clearPairingLink(imported); setConsented(false); setClaim(null); signedIn.current();
    } catch (error) {
      if (!(error instanceof NativeConnectionStorageError)) throw error;
      issuedCredential.current = { issued, target }; setConsented(false); setSavePending(true);
      setError("The device was added but not stored. Retry saving the connection.");
    }
  };

  useEffect(() => {
    if (!consented || !claim || !secrets.current || !connection.current || !current()) return;
    const target = connection.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = { ...secrets.current, principal: claim.principal, origin: claim.origin, delivery: claim.delivery, confirmed: true };
    const exchange = async () => {
      try {
        const issued = await deviceRequest<DeviceExchange>("pairings/exchange", bound, "POST", controller.signal, target);
        if (controller.signal.aborted || !current()) return;
        if (issued.principal !== claim.principal) throw new Error("Unexpected account");
        if (native) { await saveIssued(issued, target); return; }
        secrets.current = null; clearLandingPairingCode(); clearPairingLink(imported); setConsented(false); setClaim(null); signedIn.current();
      } catch (error) {
        if (error instanceof NativeConnectionStorageError) { setError("Could not save native connection storage. Try again."); return; }
        if (controller.signal.aborted || !current()) return;
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
    {!claim && imported ? <p role="status">Preparing sign-in for <strong className="device-origin">{imported.origin}</strong>…</p>
      : !claim ? <form onSubmit={event => { event.preventDefault(); void start(); }}>
      <p>Enter the one-time code shown on your signed-in device.</p>
      {native ? <label>Server URL<input aria-label="Server URL" ref={serverInput} type="url"
        defaultValue={loadServerUrl()} placeholder="https://console.example.test" required autoComplete="off" /></label> : null}
      <label>Pairing code<input aria-label="Pairing code" ref={codeInput} defaultValue={landingPairingCode() ?? ""}
        autoComplete="off" spellCheck={false} autoCapitalize="characters" required maxLength={80} /></label>
      <label>Device name<input aria-label="Device name" ref={nameInput} defaultValue={native ? "New device" : "New browser"} required maxLength={80} /></label>
      <AsyncButton className="btn primary" type="submit" pending={busy}>Continue</AsyncButton>
      <OpenPairingLinkInAppButton code={landingPairingCode()} disabled={busy} />
    </form> : <>
      <p>Server <strong className="device-origin">{claim.origin}</strong></p>
      <p>Account <strong>{claim.principal}</strong></p>
      <p>Compare this with your signed-in device:</p><output className="pairing-verification">{claim.verification}</output>
      <p>Approve only a device you have with you. Continue only if this is the account you intend to use.</p>
      {savePending ? <AsyncButton className="btn primary" onClick={async () => {
        const pending = issuedCredential.current;
        if (!pending) return;
        setError(null);
        try { await saveIssued(pending.issued, pending.target); }
        catch { setError("Connection changed. Start with a new pairing code."); }
      }}>Retry saving</AsyncButton> : consented ? <p role="status">Waiting for approval on your signed-in device…</p>
        : <button className="btn primary" type="button" onClick={() => setConsented(true)}>Sign in as {claim.principal}</button>}
    </>}
    {error ? <p className="err" role="alert">{error}</p> : null}
    <button className="btn ghost" type="button" onClick={() => { alive.current = false; clearLandingPairingCode(); clearPairingLink(imported); secrets.current = null; issuedCredential.current = null; onCancel(); }}>Cancel</button>
  </section></div>;
}
