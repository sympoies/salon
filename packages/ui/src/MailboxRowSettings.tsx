import { useState } from "react";
import { loadMailboxRowsExpanded, saveMailboxRowsExpanded } from "./mailboxRowPreference.ts";

/** Per-device choice of whether mailbox read rows in a conversation start expanded. */
export function MailboxRowSettings() {
  const [expanded, setExpanded] = useState(loadMailboxRowsExpanded);
  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Conversation</h2>
      <div className="settings-preference-row">
        <div className="settings-preference-copy">
          <span className="settings-preference-label">Mailbox rows start expanded</span>
          <p className="settings-hint">Show the full message body when the agent reads its mailbox. Used on this device.</p>
        </div>
        <button type="button" className={`settings-switch${expanded ? " is-on" : " is-off"}`} role="switch" aria-checked={expanded}
          onClick={() => { const next = !expanded; setExpanded(next); saveMailboxRowsExpanded(next); }}>
          {expanded ? "on" : "off"}
        </button>
      </div>
    </section>
  );
}
