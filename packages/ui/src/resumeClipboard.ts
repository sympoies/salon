import { copyTextToClipboard, type ClipboardWriter } from "./clipboard.ts";
import { sessionCopyAction, type SessionLike } from "./format.ts";

export type SessionCommandClipboardResult =
  | { readonly ok: true; readonly command: string; readonly kind?: "provider-session-id" }
  | {
    readonly ok: false;
    readonly reason: "no-command" | "clipboard-unavailable" | "write-failed";
    readonly command?: string;
    readonly kind?: "provider-session-id";
  };

export async function copySessionCommandToClipboard(
  session: SessionLike,
  clipboard?: ClipboardWriter,
): Promise<SessionCommandClipboardResult> {
  const action = sessionCopyAction(session);
  if (!action) {
    return { ok: false, reason: "no-command" };
  }
  const command = action.value;
  const kind = action.kind === "provider-session-id" ? { kind: action.kind } as const : {};
  const outcome = await copyTextToClipboard(command, clipboard);
  return outcome === "copied"
    ? { ok: true, command, ...kind }
    : { ok: false, reason: outcome, command, ...kind };
}
