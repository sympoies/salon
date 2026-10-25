import type { CardPreview } from "./cardPreview.ts";
import type { Session } from "./types.ts";

const WORKER_BOOTSTRAP_PROMPT =
  /^(?:Main Agent Mode is explicitly active for this managed worker assignment\b|You are a managed worker for assignment\b|Run exactly `[^`]*main-agent'?\s+bootstrap\s+--idempotency-key\s)/;

function isWorkerBootstrapPrompt(text: string): boolean {
  return WORKER_BOOTSTRAP_PROMPT.test(text);
}

/** Hide stored generated launch plumbing; ordinary user prompts are unchanged. */
export function sessionLastPromptPreview(session: Session): string | null {
  const text = session.last_prompt?.text || null;
  return text !== null && !isWorkerBootstrapPrompt(text) ? text : null;
}

/** Latest-message mode remains useful before the daemon advertises the field. */
export function sessionCardPreview(session: Session, mode: CardPreview): string | null {
  const message = mode === "latest-message" ? session.last_message : undefined;
  if (message && !isWorkerBootstrapPrompt(message.text)) {
    return message.role === "assistant" ? `Agent: ${message.text}` : message.text;
  }
  return sessionLastPromptPreview(session);
}
