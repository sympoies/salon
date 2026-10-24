import { useLayoutEffect, useRef } from "react";
import { useSharedOutbox, usesSharedOutbox } from "./sharedOutboxClient.ts";
import type { Session } from "./types.ts";

/** Local echoes are immutable once sent. Provider receipts stay internal. */
export function SharedOutgoingReplies({ session }: { readonly session: Session }) {
  const client = useSharedOutbox(session);
  const rows = client.targets(session);
  const retainedEdits = client.retainedEdits(session);
  const section = useRef<HTMLElement>(null);
  const following = useRef(true);
  const count = rows.reduce((total, row) => total + row.admissions.length + row.snapshot.items.filter(item =>
    item.state !== "submitted" && item.state !== "cancelled").length, 0);
  useLayoutEffect(() => {
    const viewport = section.current?.closest<HTMLElement>(".history-messages");
    if (!viewport) return;
    if (following.current) viewport.scrollTop = viewport.scrollHeight;
    const onScroll = () => { following.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48; };
    viewport.addEventListener("scroll", onScroll);
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [count]);
  if (!usesSharedOutbox(session) || (count === 0 && retainedEdits.length === 0 && rows.every(row => !client.error(row.target)))) return null;
  return <section ref={section} className="history-outgoing history-shared-outgoing" aria-label="Shared replies">
    {retainedEdits.map(draft => <div key={draft.id} className="history-outgoing-body">
      <p role="alert" className="history-outgoing-note">An earlier edit was not confirmed. Its text is preserved below.</p>
      <div className="history-bubble history-outgoing-bubble"><span className="history-outgoing-text">{draft.text}</span></div>
    </div>)}
    {rows.map(row => <div key={row.key}>
      {client.error(row.target) ? <p role="alert" className="history-outgoing-note">{client.error(row.target)}</p> : null}
      {row.admissions.map(item => <article key={item.id} className="history-message is-user history-outgoing-reply">
        <div className="history-outgoing-body"><div className="history-bubble history-outgoing-bubble">
          <span className="history-outgoing-text">{item.text}</span>
        </div></div>
      </article>)}
      {row.snapshot.items.filter(item => item.state !== "submitted" && item.state !== "cancelled").map(item =>
        <article key={item.id} className="history-message is-user history-outgoing-reply" data-status={item.state}>
          <div className="history-outgoing-body"><div className="history-bubble history-outgoing-bubble">
            <span className="history-outgoing-text">{item.text}</span>
          </div>
            {item.state === "refused" ? <>
              <p role="alert" className="history-outgoing-note">This message was not sent.</p>
              <div className="history-outgoing-actions">
                <button type="button" className="btn ghost" onClick={() => void client.actOnRefused(session, row.target, item, "discard_refused")}>Discard</button>
                {row.target.incarnation === session.session_incarnation
                  ? <button type="button" className="btn ghost" onClick={() => void client.actOnRefused(session, row.target, item, "retry_refused")}>Retry</button> : null}
              </div>
            </> : null}
            {item.edit_hold ? <p role="alert" className="history-outgoing-note">This older message was paused before the update and has not been sent.</p> : null}
            {row.target.incarnation !== session.session_incarnation ? <p role="alert" className="history-outgoing-note">This message belongs to the previous session.</p> : null}
          </div>
        </article>)}
    </div>)}
  </section>;
}
