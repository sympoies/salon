import { useState } from "react";
import { isAuthQuarantined, reverifyTarget } from "./authQuarantine.ts";
import type { Session } from "./types.ts";

/**
 * Names the cause when a session is under authentication quarantine and, for a
 * bound Claude session, offers one Re-verify. Re-verify's own answer is not
 * trusted: the refreshed session's incident decides whether it was released.
 */
export function AuthQuarantineNotice({ session, onReverify }: {
  readonly session: Session;
  /** Resolves to a safe error text, or null once the session has been refreshed. */
  readonly onReverify: (session: Session) => Promise<string | null>;
}) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ readonly error: string | null } | null>(null);
  if (!isAuthQuarantined(session)) return null;
  const target = reverifyTarget(session);
  const reverify = async () => {
    setPending(true);
    try {
      setOutcome({ error: await onReverify(session) });
    } catch {
      setOutcome({ error: "Re-verify failed. Try again." });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="auth-quarantine-notice" role="alert" data-testid="auth-quarantine"
      style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", padding: "0.5rem", flexShrink: 0 }}>
      <span>
        This session is under authentication quarantine: the provider rejected its credentials, so replies and terminal input are refused.
        {target ? "" : " Restore its credentials outside Console."}
        {outcome?.error ? ` ${outcome.error}` : outcome ? " The quarantine was not released." : ""}
      </span>
      {target ? <button type="button" className="btn ghost" disabled={pending} onClick={() => void reverify()}>Re-verify</button> : null}
    </div>
  );
}
