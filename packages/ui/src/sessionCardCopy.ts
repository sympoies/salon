import type { CopyFormat } from "./extensions.tsx";
import { sessionCopyAction, type SessionLike } from "./format.ts";
import { writeTerminalClipboardText } from "./terminalClipboard.ts";

export interface SessionCardCopyAction {
  /** Core action id or a registered copy format id. */
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

// Core actions first, then each registered copy format with a value (#918).
export function sessionCardCopyActions(session: SessionLike, formats: readonly CopyFormat[] = []): readonly SessionCardCopyAction[] {
  const actions: SessionCardCopyAction[] = [];
  const attach = session.ssh_attach_command || session.attach_command;
  if (attach) actions.push({ id: "attach", label: "Copy attach command", value: attach });
  const existing = sessionCopyAction(session);
  if (existing) {
    actions.push({
      id: existing.kind === "command" ? "resume" : "provider-session-id",
      label: existing.kind === "command" ? (session.status === "running" ? "Copy resume command (new copy)" : "Copy resume command") : "Copy provider session ID",
      value: existing.value,
    });
  }
  for (const format of formats) {
    const value = format.value({ id: session.id, machine: session.machine, agent: session.agent });
    if (typeof value === "string" && value) actions.push({ id: format.id, label: format.label, value });
  }
  return actions;
}

export async function copySessionCardActionToClipboard(
  action: SessionCardCopyAction,
  writeText: (text: string) => Promise<void> = writeTerminalClipboardText,
): Promise<{ readonly ok: boolean }> {
  try {
    await writeText(action.value);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
