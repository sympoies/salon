import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAndroidBackEntry } from "./useAndroidBackEntry.ts";
import type { EmergencyShell } from "@agent-console/shared/shell";
import { readEmergencyShell } from "./api.ts";
import { TerminalPane, type TerminalConnectionStatus } from "./TerminalPane.tsx";
import { StatusNotice } from "./StatusNotice.tsx";
import { useStatusNotice } from "./useStatusNotice.ts";
import { AppSelect } from "./AppSelect.tsx";
import { useConfirmation } from "./useConfirmation.tsx";

export function ShellPage({ machines, onExit }: {
  readonly machines: readonly string[];
  readonly onExit: () => void;
}) {
  // Terminal Escape and Tab stay with zsh; native Back leaves this page.
  useAndroidBackEntry("secondary-panel", true, onExit);
  const [machine, setMachine] = useState(machines[0] ?? "");
  const [shell, setShell] = useState<EmergencyShell | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { notice, dismiss } = useStatusNotice(error);
  const [busy, setBusy] = useState(false);
  const { confirmation, requestConfirmation, dismissConfirmation } = useConfirmation();
  const [connection, setConnection] = useState<TerminalConnectionStatus>("connecting");
  const [reconnect, setReconnect] = useState(0);
  const epoch = useRef(0);
  const operation = useRef(false);
  const closedCheck = useRef<string | null>(null);
  const selectedMachine = machines.includes(machine) ? machine : machines[0] ?? "";

  useEffect(() => {
    const current = ++epoch.current;
    setShell(null); setError(null); setConnection("connecting"); closedCheck.current = null;
    if (!selectedMachine) return;
    void readEmergencyShell(selectedMachine).then((result) => {
      if (epoch.current === current) setShell(result);
    }).catch((failure: unknown) => {
      if (epoch.current === current) setError(failure instanceof Error ? failure.message : "Shell is unavailable.");
    });
    return () => { epoch.current += 1; };
  }, [selectedMachine]);
  useLayoutEffect(dismissConfirmation, [dismissConfirmation, selectedMachine, shell?.incarnation]);

  useEffect(() => {
    if (connection === "open") { closedCheck.current = null; return; }
    if (connection !== "closed" || shell?.status !== "running" || !shell.incarnation
      || operation.current || busy || closedCheck.current === shell.incarnation) return;
    closedCheck.current = shell.incarnation;
    operation.current = true; setBusy(true);
    const current = epoch.current;
    // A terminal exit reconciles status once; it never creates a replacement.
    void readEmergencyShell(selectedMachine).then((state) => {
      if (current === epoch.current) setShell(state);
    }).catch(() => { /* transport may recover when the host returns */ })
      .finally(() => { operation.current = false; setBusy(false); });
  }, [connection, shell?.status, shell?.incarnation, selectedMachine, busy]);

  const act = async (method: "GET" | "POST" | "DELETE") => {
    if (operation.current || !selectedMachine) return;
    const current = epoch.current;
    if (method === "DELETE") {
      if (!shell?.incarnation) return;
      const confirmed = await requestConfirmation({
        title: "End shell",
        message: `End your shell on ${selectedMachine}? This stops the terminal and its foreground command.`,
        confirmLabel: "End Shell",
        destructive: true,
      });
      if (!confirmed || current !== epoch.current || operation.current) return;
    }
    operation.current = true; setBusy(true); setError(null);
    try {
      const result = await readEmergencyShell(selectedMachine, method, shell?.incarnation ?? undefined);
      if (current === epoch.current) { setShell(result); if (method === "GET") setReconnect((v) => v + 1); }
    } catch (failure) {
      if (current === epoch.current) {
        setError(failure instanceof Error ? failure.message : "Shell request failed.");
        // Ensure is idempotent, but never retry a lifecycle mutation automatically.
        try { const state = await readEmergencyShell(selectedMachine); if (current === epoch.current) setShell(state); } catch { /* retain the error */ }
      }
    } finally { operation.current = false; setBusy(false); }
  };

  const stateLabel = shell ? shell.status === "running" ? connection : "Stopped" : null;
  return <section className="shell-page" aria-label="Shell">
    {confirmation}
    <header className="shell-page-header">
      <div className="shell-page-title-row">
        <button type="button" className="btn ghost" onClick={onExit}>Back</button>
        <h1>Shell</h1>
      </div>
      <div className="shell-page-controls">
        <label className="shell-page-machine"><span>Machine</span><AppSelect aria-label="Shell machine" value={selectedMachine} disabled={busy} onChange={(event) => setMachine(event.target.value)}>
          {machines.map((name) => <option key={name} value={name}>{name}</option>)}
        </AppSelect></label>
        <div className="shell-page-actions">
          {shell?.status === "running" ? <>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void act("GET")}>Reconnect</button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void act("DELETE")}>End Shell</button>
          </> : <button type="button" className="btn" disabled={busy || !selectedMachine || !shell} onClick={() => void act("POST")}>{busy ? "Opening…" : "Open Shell"}</button>}
        </div>
      </div>
    </header>
    <div className="shell-page-status" aria-live="polite">
      <span className="shell-page-chip" data-state={stateLabel ?? "pending"}>
        {shell ? `${shell.owner} · ${selectedMachine} · ${stateLabel}` : selectedMachine ? "Checking shell…" : "No machines available"}
      </span>
      <span className="shell-page-hint">Closing this page keeps your shell running. ⌘⇧S / Ctrl⇧S opens Shell.</span>
      {notice ? <StatusNotice notice={notice} onDismiss={dismiss} surface="shell" /> : null}
    </div>
    {shell?.status === "running" && shell.incarnation
      ? <TerminalPane key={`${selectedMachine}/${shell.incarnation}`} machine={selectedMachine} id={shell.incarnation}
          agent="shell" autoFocus showKeyBar reconnectToken={reconnect} onStatusChange={setConnection} />
      : <div className="shell-page-empty">{shell ? "Open your fixed zsh shell when you need it." : ""}</div>}
  </section>;
}
