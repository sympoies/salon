import { useEffect, useLayoutEffect, useRef } from "react";
import type { SharedOutboxItem, SharedOutboxState } from "@agent-console/shared/shared-outbox";
import { AUTH_QUARANTINED_CODE } from "./authQuarantine.ts";
import { OutgoingBubble } from "./OutgoingBubble.tsx";
import { useSharedOutbox, usesSharedOutbox } from "./sharedOutboxClient.ts";
import type { HistoryMessage, Session } from "./types.ts";

const deliveryLabel = {
  queued: "Sending",
  sending: "Sending",
  submitted: "Handed to the agent",
  refused: "Refused",
  unknown: "Unknown outcome",
  command_dispatched: null,
  cancelled: null,
} satisfies Record<SharedOutboxState, string | null>;

function refusalReason(item: SharedOutboxItem): string {
  switch (item.error_code ?? item.receipt?.code) {
    case "composer-not-empty":
      return "Terminal has a draft. Clear it in the terminal, then Retry.";
    case "composer-unobservable":
      return item.receipt?.observation === "region-not-single-row"
        ? "Terminal has a multi-line draft. Send or clear it in the terminal, then Retry."
        : "Can't read the agent's input box. Check the terminal.";
    case "agent-blocked":
      return "The agent is waiting for permission or an answer.";
    case "busy":
      return "Slash commands need an idle session. Retry when the agent is idle.";
    case AUTH_QUARANTINED_CODE:
      return "Session is under authentication quarantine. Re-verify the account, then Retry.";
    case "outbox-authorization-changed":
      return "Your access to send this reply changed.";
    case "outbox-provider-changed":
      return "The session's current provider does not support replies.";
    case "keyed-prompt-unsupported":
    case "structured-prompt-unsupported":
      return "This session does not support reply delivery.";
    case "request-id-conflict":
      return "This delivery attempt conflicts with another reply.";
    default:
      return "The reply could not be sent.";
  }
}

/** Local echoes are immutable once sent. Provider receipts stay internal. */
export function SharedOutgoingReplies({ session, messages = [] }: {
  readonly session: Session;
  readonly messages?: readonly HistoryMessage[];
}) {
  const client = useSharedOutbox(session);
  const rows = client.targets(session);
  const retainedEdits = client.retainedEdits(session);
  const section = useRef<HTMLElement>(null);
  const following = useRef(true);
  // A provider receipt can precede the first history page. Keep the local
  // echo until this view actually has the matching user turn (#1094).
  const visibleRows = rows.map(row => {
    const current = row.target.incarnation === session.session_incarnation;
    const proven = current ? client.submittedProof(row, messages) : {};
    return { ...row, current, admissions: row.admissions.filter(item => !Object.hasOwn(proven, item.id)), items: client.outgoingItems(row).filter(item => item.state !== "cancelled" && item.state !== "command_dispatched" && !client.isDismissed(row, item)
      && (item.state !== "submitted" || current)
      // Transcript proof outranks an unsent or uncertain row, so no Retry can duplicate it (#181).
      && !Object.hasOwn(proven, item.id)) };
  });
  useEffect(() => {
    for (const row of rows) if (row.target.incarnation === session.session_incarnation && messages.length) {
      void client.confirmSubmitted(row.target, messages).catch(() => {});
    }
  }, [client, rows, messages, session.session_incarnation]);
  let count = 0;
  let newestRefused = false;
  for (const { admissions, items } of visibleRows) {
    count += admissions.length + items.length;
    if (admissions.length || items.length) newestRefused = items.at(-1)?.state === "refused";
  }
  useLayoutEffect(() => {
    const viewport = section.current?.closest<HTMLElement>(".history-messages");
    if (!viewport) return;
    const followBottom = () => { if (following.current) viewport.scrollTop = viewport.scrollHeight; };
    followBottom();
    // A refusal expands the existing row. Keep its actions visible when the
    // composer grows and gives the message viewport less room.
    const observer = newestRefused && typeof ResizeObserver !== "undefined" ? new ResizeObserver(followBottom) : undefined;
    observer?.observe(viewport);
    const onScroll = () => { following.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48; };
    viewport.addEventListener("scroll", onScroll);
    return () => {
      observer?.disconnect();
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [count, newestRefused]);
  if (!usesSharedOutbox(session) || (count === 0 && retainedEdits.length === 0 && rows.every(row => !client.error(row.target)))) return null;
  return <section ref={section} className="history-outgoing history-shared-outgoing" aria-label="Shared replies">
    {retainedEdits.map(draft => <div key={draft.id} className="history-outgoing-body">
      <p role="alert" className="history-outgoing-note">An earlier edit was not confirmed. Its text is preserved below.</p>
      <OutgoingBubble text={draft.text} uploadSessionId={session.id} />
    </div>)}
    {visibleRows.map(row => <div key={row.key}>
      {client.error(row.target) ? <p role="alert" className="history-outgoing-note">{client.error(row.target)}</p> : null}
      {row.admissions.map(item => <article key={item.id} className="history-message is-user history-outgoing-reply" data-status="uploading">
        <div className="history-outgoing-body">
          <OutgoingBubble text={item.text} uploadSessionId={session.id} attachments={row.attachments?.[item.id]} />
          {row.current ? <p role="status" className="history-outgoing-status">Uploading</p> : null}
        </div>
      </article>)}
      {row.items.map(item => {
        // Earlier held replies need their existing pause note instead of an in-flight label.
        const label = item.state === "queued" && (item.edit_hold || !row.current) ? null : deliveryLabel[item.state];
        return <article key={item.id} className="history-message is-user history-outgoing-reply" data-status={item.state}>
          <div className="history-outgoing-body">
            <OutgoingBubble uploadSessionId={session.id} text={item.text} attachments={row.attachments?.[item.id]} onDismiss={client.canDismiss(row, item) ? () => { void client.dismiss(row.target, item.id).catch(() => {}); } : undefined} />
            {label ? <p role="status" className="history-outgoing-status">{label}</p> : null}
            {item.state === "refused" ? <>
              <p role="alert" className="history-outgoing-note">{refusalReason(item)}</p>
              <div className="history-outgoing-actions">
                <button type="button" className="btn ghost" onClick={() => void client.actOnRefused(session, row.target, item, "discard_refused")}>Discard</button>
                {row.current
                  ? <button type="button" className="btn ghost" onClick={() => void client.actOnRefused(session, row.target, item, "retry_refused")}>Retry</button> : null}
              </div>
            </> : null}
            {item.edit_hold ? <p role="alert" className="history-outgoing-note">This older message was paused before the update and has not been sent.</p> : null}
            {!row.current ? <p role="alert" className="history-outgoing-note">This message belongs to the previous session.</p> : null}
          </div>
        </article>;
      })}
    </div>)}
  </section>;
}
