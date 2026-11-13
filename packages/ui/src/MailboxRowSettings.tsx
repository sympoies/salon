import { saveShowToolCalls, useShowToolCalls } from "./toolCallPreference.ts";
import { useState } from "react";
import { loadMailboxRowsExpanded, saveMailboxRowsExpanded } from "./mailboxRowPreference.ts";

/** Per-client conversation display preferences. */
export function MailboxRowSettings() {
  const showToolCalls = useShowToolCalls();
  const [expanded, setExpanded] = useState(loadMailboxRowsExpanded);
  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Conversation</h2>
      <div className="settings-preference-row">
        <div className="settings-preference-copy">
          <span className="settings-preference-label">Show tool calls</span>
          <p className="settings-hint">Show tool calls and results in live and saved conversations. Used on this device.</p>
        </div>
        <button type="button" className={`settings-switch${showToolCalls ? " is-on" : " is-off"}`}
          role="switch" aria-label="Show tool calls" aria-checked={showToolCalls}
          onClick={() => saveShowToolCalls(!showToolCalls)}>
          {showToolCalls ? "on" : "off"}
        </button>
      </div>
      <div className="settings-preference-row">
        <div className="settings-preference-copy">
          <span className="settings-preference-label">Mailbox rows start expanded</span>
          <p className="settings-hint">Show the full message body when the agent reads its mailbox. Used on this device.</p>
        </div>
        <button type="button" className={`settings-switch${expanded ? " is-on" : " is-off"}`} role="switch" aria-label="Mailbox rows start expanded" aria-checked={expanded}
          onClick={() => { const next = !expanded; setExpanded(next); saveMailboxRowsExpanded(next); }}>
          {expanded ? "on" : "off"}
        </button>
      </div>
    </section>
  );
}
