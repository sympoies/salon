import { sessionCopyAction, type SessionLike } from "./format.ts";

export interface ClipboardWriter {
  readonly writeText?: (text: string) => Promise<void> | void;
}

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
  clipboard: ClipboardWriter | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard,
): Promise<SessionCommandClipboardResult> {
  const action = sessionCopyAction(session);
  if (!action) {
    return { ok: false, reason: "no-command" };
  }
  const command = action.value;
  const kind = action.kind === "provider-session-id" ? { kind: action.kind } as const : {};
  if (typeof clipboard?.writeText !== "function") {
    return { ok: false, reason: "clipboard-unavailable", command, ...kind };
  }
  try {
    await clipboard.writeText(command);
    return { ok: true, command, ...kind };
  } catch {
    return { ok: false, reason: "write-failed", command, ...kind };
  }
}
