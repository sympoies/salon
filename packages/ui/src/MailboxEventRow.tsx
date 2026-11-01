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
        <span className="mailbox-event-from">{event.sender.kind === "service" ? event.sender.service_id : event.sender.session_id} · {event.sender.machine}</span>
        <span className="mailbox-event-category">{event.category}</span>
        <span className="mailbox-event-state">{state}</span>
        {time}
      </summary>
      <div className="mailbox-event-body">
        {/* A body that began with a notice marker arrives behind one LF; it is shown as plain text, never as a nested notice. */}
        {event.body_prefix === "lf" ? <pre className="mailbox-event-plain">{body.startsWith("\n") ? body.slice(1) : body}</pre>
          : body.trim() ? <MessageMarkdown text={body} /> : <p>Message body unavailable</p>}
      </div>
    </details>
  </div>;
}
