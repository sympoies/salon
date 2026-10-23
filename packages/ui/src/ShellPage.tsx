import { useEffect, useRef, useState } from "react";
import { useAndroidBackEntry } from "./useAndroidBackEntry.ts";
import type { EmergencyShell } from "@agent-console/shared/shell";
import { readEmergencyShell } from "./api.ts";
import { TerminalPane, type TerminalConnectionStatus } from "./TerminalPane.tsx";
import { StatusNotice } from "./StatusNotice.tsx";
import { useStatusNotice } from "./useStatusNotice.ts";

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
    if (method === "DELETE" && (!shell?.incarnation || !window.confirm(`End your shell on ${selectedMachine}? This stops the terminal and its foreground command.`))) return;
    operation.current = true; setBusy(true); setError(null);
    const current = epoch.current;
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

  return <section className="shell-page" aria-label="Shell">
    <header className="shell-page-header">
      <button type="button" className="btn ghost" onClick={onExit}>Back</button>
      <h1>Shell</h1>
      <label>Machine <select aria-label="Shell machine" value={selectedMachine} disabled={busy} onChange={(event) => setMachine(event.target.value)}>
        {machines.map((name) => <option key={name} value={name}>{name}</option>)}
      </select></label>
      {shell?.status === "running" ? <>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void act("GET")}>Reconnect</button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => void act("DELETE")}>End Shell</button>
      </> : <button type="button" className="btn" disabled={busy || !selectedMachine || !shell} onClick={() => void act("POST")}>{busy ? "Opening…" : "Open Shell"}</button>}
    </header>
    <div className="shell-page-status" aria-live="polite">
      {shell ? `${shell.owner} · ${selectedMachine} · ${shell.status === "running" ? connection : "Stopped"}` : selectedMachine ? "Checking shell…" : "No machines available"}
      <span>Closing this page keeps your shell running. ⌘⇧S / Ctrl⇧S opens Shell.</span>
      {notice ? <StatusNotice notice={notice} onDismiss={dismiss} surface="shell" /> : null}
    </div>
    {shell?.status === "running" && shell.incarnation
      ? <TerminalPane key={`${selectedMachine}/${shell.incarnation}`} machine={selectedMachine} id={shell.incarnation}
          agent="shell" autoFocus showKeyBar reconnectToken={reconnect} onStatusChange={setConnection} />
      : <div className="shell-page-empty">{shell ? "Open your fixed zsh shell when you need it." : ""}</div>}
  </section>;
}
