import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { transcriptProof, useConversationOutbox } from "./conversationOutbox.ts";
import { OutgoingBubble } from "./OutgoingBubble.tsx";
import type { HistoryMessage, Session } from "./types.ts";

function timeLabel(at: number | undefined): string | undefined {
  if (at === undefined) return undefined;
  const date = new Date(at);
  return [date.getHours(), date.getMinutes()].map(part => String(part).padStart(2, "0")).join(":");
}

/** Immutable local echoes retained for replies from older clients. */
export function OutgoingReplies({ session, messages }: {
  readonly session: Session;
  readonly messages: readonly HistoryMessage[];
}) {
  const outbox = useConversationOutbox();
  const version = outbox.snapshot();
  useEffect(() => {
    if (messages.length || outbox.items(session).some(item => item.state !== "refused" && item.queuedAt === undefined && item.attemptedAt === undefined)) {
      void outbox.confirmFromTranscript(session, messages).catch(() => {});
    }
  }, [outbox, version, session, messages]);
  const proven = transcriptProof(outbox.items(session), messages, outbox.provenTurnIds(session));
  const items = outbox.items(session).filter(item => !proven.has(item.id));
  const section = useRef<HTMLElement>(null);
  const [error, setError] = useState<string>();
  const shown = useRef(items.length);
  useLayoutEffect(() => {
    const viewport = section.current?.closest<HTMLElement>(".history-messages");
    if (viewport && items.length > shown.current) viewport.scrollTop = viewport.scrollHeight;
    shown.current = items.length;
  }, [items.length]);
  if (items.length === 0) return null;
  return <section ref={section} className="history-outgoing" aria-label="Your replies">
    {error ? <p className="history-error" role="alert">{error}</p> : null}
    {items.map((item, index) => <article key={`${item.id}:${item.incarnation}:${index}`} aria-label="You" data-status={item.state === "dispatching" || item.state === "unknown" ? "sent" : item.state}
      className="history-message is-user history-outgoing-reply">
      {item.queuedAt === undefined ? null : <time>{timeLabel(item.queuedAt)}</time>}
      <div className="history-outgoing-body">
        <OutgoingBubble text={item.text} onDismiss={outbox.canDismiss(item) ? () => {
          void outbox.dismiss(session, item.id, item.incarnation, messages).then(dismissed => {
            if (!dismissed) setError("This reply changed or has an active attempt and was kept.");
          }).catch(cause => setError(String(cause)));
        } : undefined} />
        {item.state === "refused" ? <p className="history-outgoing-note" role="alert">{item.error ?? "This message was not sent."}{" "}
          {item.incarnation === session.session_incarnation ? <button type="button" className="btn ghost" aria-label="Retry reply"
            onClick={() => { void outbox.retry(session, item.id).catch(cause => setError(String(cause))); }}>Retry</button> : null}
          {item.unconfirmed !== true ? <button type="button" className="btn ghost" aria-label="Discard refused reply"
            onClick={() => { void outbox.discardRefused(session, item.id, item.incarnation).then(discarded => {
              if (!discarded) setError("This reply changed in another window and was kept.");
            }).catch(cause => setError(String(cause))); }}>Discard</button> : null}
        </p> : null}
        {item.incarnation !== session.session_incarnation ? <p className="history-outgoing-note" role="alert">This session restarted. This reply will not be sent to the new session.</p> : null}
      </div>
    </article>)}
  </section>;
}
