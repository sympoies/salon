import type { ReactNode } from "react";
import type { MailboxEvent } from "@agent-console/shared";
import { MessageMarkdown } from "./MessageMarkdown.tsx";
import { loadMailboxRowsExpanded } from "./mailboxRowPreference.ts";

/** A boxless row for the agent reading or acknowledging a mailbox message; the body is peer text, shown as Markdown only. */
export function MailboxEventRow({ event, body, time }: { readonly event: MailboxEvent; readonly body: string; readonly time: ReactNode }) {
  const state = event.state === "acknowledged" ? "Acknowledged" : "Read";
  return <div className="session-notice mailbox-event">
    <details className="mailbox-event-disclosure" open={loadMailboxRowsExpanded()}>
      <summary>
        <span className="session-notice-label">Mailbox</span>
        <span className="mailbox-event-from">{event.sender.id} · {event.sender.machine}</span>
        <span className="mailbox-event-category">{event.category}</span>
        <span className="mailbox-event-state">{state}</span>
        {time}
      </summary>
      <div className="mailbox-event-body">
        {body.trim() ? <MessageMarkdown text={body} /> : <p>Message body unavailable</p>}
      </div>
    </details>
  </div>;
}
