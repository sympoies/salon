import { CloseIcon } from "./icons.tsx";
import { IconButton } from "./IconButton.tsx";
import { useEffect, useMemo, useState } from "react";
import type { MaintenanceAction } from "@agent-console/shared/maintenance";
import { AsyncButton } from "./AsyncButton.tsx";
import { Modal } from "./Modal.tsx";
import { sessionLabel } from "./format.ts";
import {
  maintenanceActionCaveat,
  maintenanceActionConfirmLabel,
  maintenanceActionLabel,
  maintenanceIncidentPresentation,
  maintenanceOperationLabel,
  type SessionMaintenanceIncident,
} from "./sessionMaintenance.ts";

export interface SessionMaintenanceDrawerProps {
  readonly incidents: readonly SessionMaintenanceIncident[];
  readonly selectedKey: string;
  readonly busy: boolean;
  readonly pendingActionId: string | null;
  readonly onSelectedKeyChange: (key: string) => void;
  readonly onClose: () => void;
  readonly onRefresh: (incident: SessionMaintenanceIncident) => void | Promise<void>;
  readonly onAction: (
    incident: SessionMaintenanceIncident,
    action: MaintenanceAction,
    confirmed: boolean,
  ) => void | Promise<void>;
  readonly onCopyDiagnostics: (incident: SessionMaintenanceIncident) => void | Promise<void>;
  readonly onCopyNextPrompt: (incident: SessionMaintenanceIncident) => void | Promise<void>;
  readonly onDismissIncident: (incident: SessionMaintenanceIncident) => void;
}

export function SessionMaintenanceDrawer({
  incidents,
  selectedKey,
  busy,
  pendingActionId,
  onSelectedKeyChange,
  onClose,
  onRefresh,
  onAction,
  onCopyDiagnostics,
  onCopyNextPrompt,
  onDismissIncident,
}: SessionMaintenanceDrawerProps) {
  const [confirmedAction, setConfirmedAction] = useState<string | null>(null);
  const incident = useMemo(
    () => incidents.find((candidate) => candidate.key === selectedKey) ?? incidents[0],
    [incidents, selectedKey],
  );
  useEffect(() => {
    setConfirmedAction(null);
  }, [incident?.key, incident?.preview?.preview_digest]);
  if (!incident) return null;

  const preview = incident.preview;
  const presentation = maintenanceIncidentPresentation(incident);
  return (
    <Modal
      onClose={onClose}
      busy={busy}
      className="maintenance-drawer"
      backdropClassName="maintenance-drawer-backdrop"
      ariaLabelledby="maintenance-drawer-title"
    >
      <div className="maintenance-drawer-head">
        <div>
          <p className="maintenance-eyebrow">Session maintenance</p>
          <h2 id="maintenance-drawer-title">
            {incident.cleanupPending ? "Cleanup" : "Recover"} {sessionLabel(incident.session)}
          </h2>
        </div>
        <IconButton className="btn icon-btn" type="button" aria-label="Close maintenance" onClick={onClose} disabled={busy}>
          <CloseIcon />
        </IconButton>
      </div>

      {incidents.length > 1 ? (
        <nav className="maintenance-incident-list" aria-label="Failed sessions">
          {incidents.map((candidate) => (
            <button
              className={`btn ghost ${candidate.key === incident.key ? "is-active" : ""}`}
              type="button"
              key={candidate.key}
              disabled={busy}
              onClick={() => onSelectedKeyChange(candidate.key)}
            >
              {sessionLabel(candidate.session)} · {maintenanceOperationLabel(candidate.operation)}
            </button>
          ))}
        </nav>
      ) : null}

      <section className="maintenance-summary">
        <dl>
          <div><dt>Session</dt><dd>{incident.session.id}</dd></div>
          <div><dt>Machine</dt><dd>{incident.session.machine}</dd></div>
          <div><dt>Provider</dt><dd className="maintenance-provider">{incident.session.agent}</dd></div>
          <div><dt>Operation</dt><dd>{maintenanceOperationLabel(incident.operation)}</dd></div>
          <div><dt>State</dt><dd>{incident.cleanupPending ? "cleanup pending" : preview?.state ?? (incident.unsupported ? "unsupported" : "unavailable")}</dd></div>
          {preview?.issue ? <div><dt>Issue</dt><dd>{preview.issue.message}</dd></div> : null}
          {preview ? <div><dt>Boundary</dt><dd>{preview.boundary.kind} · {preview.boundary.safe_process_count} processes</dd></div> : null}
        </dl>
        <p className={presentation.tone === "ready" ? "maintenance-ready" : "maintenance-error"}>
          {presentation.text}
        </p>
        <p className="maintenance-preservation">
          {incident.cleanupPending
            ? "Logical deletion is complete. Only producer-owned physical cleanup remains; this item cannot restore the ordinary session card."
            : preview?.preservation.session_metadata_retained_until_success
            ? "Session metadata and the provider conversation are retained until an action succeeds."
            : "Inspect the session before retrying. No destructive action runs automatically."}
        </p>
      </section>

      <div className="maintenance-actions-list">
        {preview?.actions.map((action) => {
          const actionKey = `${incident.key}:${action.id}`;
          const confirmed = confirmedAction === actionKey;
          const actionLabel = maintenanceActionLabel(action);
          return (
            <div
              className={`maintenance-action-row ${action.destructive ? "is-destructive" : ""}`}
              key={action.id}
              data-terminates-runtime={action.terminates_runtime === false ? "false" : undefined}
            >
              <div>
                <strong>{actionLabel}</strong>
                <span>{maintenanceActionCaveat(action, preview)}</span>
              </div>
              {action.requires_confirmation ? (
                <label className="maintenance-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(event) => setConfirmedAction(event.currentTarget.checked ? actionKey : null)}
                  />
                  {maintenanceActionConfirmLabel(action)}
                </label>
              ) : null}
              <AsyncButton
                className={`btn ${action.destructive ? "danger" : "primary"}`}
                type="button"
                pending={pendingActionId === action.id}
                disabled={busy || (action.requires_confirmation && !confirmed)}
                onClick={() => void onAction(incident, action, confirmed)}
              >
                {actionLabel}
              </AsyncButton>
            </div>
          );
        })}
      </div>

      <div className="maintenance-drawer-footer">
        {!incident.cleanupPending ? (
          <button className="btn ghost" type="button" disabled={busy} onClick={() => void onRefresh(incident)}>
            Inspect again
          </button>
        ) : null}
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void onCopyDiagnostics(incident)}>
          Copy diagnostics
        </button>
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void onCopyNextPrompt(incident)}>
          Copy next prompt
        </button>
        <button className="btn ghost" type="button" disabled={busy} onClick={() => onDismissIncident(incident)}>
          Dismiss incident
        </button>
      </div>
    </Modal>
  );
}
