import type { AutoResumeStatus } from "@agent-console/shared/api";
import type { HistoryMessage, TurnState } from "./types.ts";

export interface StuckTurn {
  readonly text: string;
  /** The prompt one tap sends, when resending is safe and useful. */
  readonly action?: { readonly label: string; readonly text: string };
}

// States in which auto-resume still owns a retry or continuation; a manual
// prompt cancels it in the daemon, under the same lock as the send.
const AUTO_RESUME_PENDING = new Set<AutoResumeStatus["state"]>(["armed", "scheduled", "checking", "switching_account", "transient_failure"]);
const IMAGE_PLACEHOLDER = /\[Image #\d+\]/;

function autoResumeTime(status: AutoResumeStatus): string {
  const at = status.scheduled_at ? new Date(status.scheduled_at) : null;
  return at && !Number.isNaN(at.getTime()) ? ` at ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
}

/**
 * Why the last turn is stuck, for a session that is otherwise idle (#921):
 * the conversation names the failure and offers one tap to try again.
 */
export function stuckTurn(state: TurnState | null, autoResume: AutoResumeStatus | null | undefined,
  messages: readonly HistoryMessage[]): StuckTurn | null {
  const last = state?.last_turn;
  if (last?.outcome !== "failed") return null;
  const lastMessage = [...messages].reverse().find(message => message.role !== "goal" && message.role !== "notice");
  // A message sent after the failure is already the next try, even before the
  // turn state catches up.
  if (lastMessage?.role === "user" && Date.parse(lastMessage.timestamp ?? "") > Date.parse(last.completed_at)) return null;
  if (last.provider_failure_kind === "authentication") {
    return { text: "The last turn failed: the provider needs sign-in. Sign in from the terminal, then send again." };
  }
  const pending = autoResume?.enabled && AUTO_RESUME_PENDING.has(autoResume.state) ? autoResume : null;
  const capacity = last.provider_failure_kind === "provider_capacity";
  // Without a named cause, a pending auto-resume is waiting for usage to reset:
  // a resend now would fail the same way.
  if (pending && !capacity) return { text: `The last turn failed. Auto-resume will continue it${autoResumeTime(pending)}.` };
  const text = capacity
    ? `The model was at capacity and the last turn failed.${pending ? ` Auto-resume will retry${autoResumeTime(pending)}.` : ""}`
    : "The last turn failed.";
  // An answer already started: ask to continue rather than repeat the request.
  if (lastMessage?.role === "assistant") return { text, action: { label: "Continue", text: "Continue" } };
  // An image is only its placeholder in the transcript, so it cannot be resent.
  if (lastMessage?.role !== "user" || !lastMessage.text.trim() || IMAGE_PLACEHOLDER.test(lastMessage.text)) return { text };
  return { text, action: { label: pending ? "Resend now" : "Resend", text: lastMessage.text.trim() } };
}

/** How long a working turn may go without activity before it may be stuck (#921). */
export const SILENT_TURN_MS = 15 * 60_000;

/**
 * A turn that keeps working with no activity since `lastActivityAt` may be
 * stuck (#921). Nothing is interrupted or resent; the card only says so.
 */
export function silentTurnMinutes(phase: string | undefined, lastActivityAt: number, now: number): number | null {
  if (phase !== "working" || !Number.isFinite(lastActivityAt)) return null;
  const quiet = now - lastActivityAt;
  return quiet >= SILENT_TURN_MS ? Math.floor(quiet / 60_000) : null;
}
