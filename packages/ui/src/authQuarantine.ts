import { isAuthQuarantined } from "@agent-console/shared/api";
import type { Session } from "./types.ts";

/** The refusal code the daemon answers with while a session is auth quarantined. */
export const AUTH_QUARANTINED_CODE = "auth-quarantined";

export const AUTH_QUARANTINE_REPLY_TEXT =
  "This session is under authentication quarantine, so this reply was not sent. Re-verify the account, then Retry.";
export const AUTH_QUARANTINE_TERMINAL_TEXT =
  "This session is under authentication quarantine, so terminal input is not accepted. Re-verify the account to release it.";

export { isAuthQuarantined };

/** The bound Claude account a Re-verify checks; other sessions show the cause only. */
export function reverifyTarget(session: Session): { readonly account: string; readonly incarnation: string } | null {
  const status = session.claude_account;
  if (session.agent !== "claude" || !isAuthQuarantined(session) || !session.session_incarnation) return null;
  return status?.supported && status.state === "bound" && status.selected_account
    ? { account: status.selected_account, incarnation: session.session_incarnation }
    : null;
}
