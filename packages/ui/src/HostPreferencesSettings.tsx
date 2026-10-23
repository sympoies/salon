import { useCallback, useEffect, useRef, useState } from "react";
import type { MachinePreference } from "@agent-console/shared/api";
import { listMachinePreferences, listSessions, updateMachinePreference } from "./api.ts";
import { completeLegacyHostPreferenceMigration, legacyHostPreferenceSeed } from "./enabledMachines.ts";
import { getPrincipalStorageNamespace } from "./storage.ts";

export function HostPreferencesSettings({ machines, onMigrationDone }: {
  readonly machines: readonly string[];
  readonly onMigrationDone?: () => void;
}) {
  const [preferences, setPreferences] = useState<MachinePreference[] | null>(null);
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<MachinePreference | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [migrationDone, setMigrationDone] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const refreshing = useRef(false);
  const reload = useCallback(async () => {
    if (refreshing.current || !mounted.current) return;
    refreshing.current = true;
    const current = ++generation.current;
    const principal = getPrincipalStorageNamespace();
    const isCurrent = () => mounted.current && current === generation.current
      && principal === getPrincipalStorageNamespace();
    try {
      const prefs = await listMachinePreferences().catch(() => null);
      if (!isCurrent()) return;
      if (prefs?.ok) {
        // This authenticated response owns the granted inventory; independent
        // machine discovery may still be loading or unavailable.
        setPreferences(prefs.machines);
        setError(previous => previous === "Account host preferences are unavailable." ? null : previous);
      } else setError("Account host preferences are unavailable.");
      const inventory = prefs?.ok ? prefs.machines.map(row => row.name) : machines;
      const sessions = await listSessions(inventory).catch(() => null);
      if (!isCurrent()) return;
      setOnline(new Set(sessions?.machines.filter(row => row.ok).map(row => row.name) ?? []));
    } finally { refreshing.current = false; }
  }, [machines]);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    const refresh = async () => { if (alive) await reload(); };
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => { alive = false; mounted.current = false; generation.current++; clearInterval(timer); };
  }, [reload]);
  const legacy = migrationDone ? null : legacyHostPreferenceSeed(preferences?.map(row => row.name) ?? []);
  const finishMigration = () => {
    if (!completeLegacyHostPreferenceMigration()) {
      setError("Could not remove the old device preference. Try again."); return;
    }
    setMigrationDone(true); onMigrationDone?.();
  };
  const migrate = async () => {
    if (!legacy || !preferences) return;
    const principal = getPrincipalStorageNamespace();
    const isCurrent = () => mounted.current && principal === getPrincipalStorageNamespace();
    setSaving(true); setError(null);
    try {
      for (const host of preferences.filter(row => row.last_change === null)) {
        if (!isCurrent()) return;
        const result = await updateMachinePreference(host.name, legacy.has(host.name), "Imported this device's previous host preference", true);
        if (!isCurrent()) return;
        if (!result.ok) { setError("Could not import all host preferences. Account changes were preserved; refresh and try again."); await reload(); return; }
      }
      if (!isCurrent()) return;
      finishMigration(); await reload();
    } catch { if (isCurrent()) setError("Could not import host preferences. Try again."); }
    finally { if (mounted.current) setSaving(false); }
  };
  return <section className="settings-section" aria-label="Account host preferences">
    <h2 className="settings-section-title">Account hosts</h2>
    <p className="settings-hint">Changes apply to this account on every device. Disabling hides a host from the session list and counts. Existing terminals remain connected.</p>
    {error ? <p className="err" role="alert">{error}</p> : null}
    {preferences === null && !error ? <p className="settings-hint">Loading host preferences…</p> : null}
    {preferences?.map(host => <div className="settings-preference-row" key={host.name}>
      <div className="settings-preference-copy">
        <span className="settings-preference-label">{host.name}</span>
        <p className="settings-hint">{!host.enabled ? "Disabled" : !host.active ? "Inactive in server configuration" : online.has(host.name) ? "Online" : "Offline"}</p>
        {host.last_change ? <p className="settings-hint">{host.last_change.reason} · {host.last_change.actor} · {host.last_change.at}</p> : null}
      </div>
      <button type="button" className={`settings-switch${host.enabled ? " is-on" : " is-off"}`}
        aria-label={`${host.enabled ? "Disable" : "Enable"} ${host.name}`} disabled={saving}
        onClick={() => { setSelected(host); setReason(""); setError(null); }}>
        {host.enabled ? "on" : "off"}
      </button>
    </div>)}
    {selected ? <form onSubmit={async event => {
      event.preventDefault(); if (!reason.trim() || saving) return;
      setSaving(true); setError(null);
      try {
        const result = await updateMachinePreference(selected.name, !selected.enabled, reason.trim());
        // Name the cause, so a refusal is not mistaken for a passing glitch (#1003).
        if (!result.ok) { setError(`Could not change the host preference${result.error ? ` (${result.error})` : ""}. Try again.`); return; }
        setSelected(null); setReason(""); await reload();
      } catch { setError("Could not change the host preference. Try again."); }
      finally { setSaving(false); }
    }}>
      <label className="settings-field">Reason to {selected.enabled ? "disable" : "enable"} {selected.name}
        <input aria-label="Host preference reason" required maxLength={512} value={reason}
          onInput={event => setReason(event.currentTarget.value)} disabled={saving} />
      </label>
      <div className="settings-actions">
        <button className="btn" type="submit" disabled={saving || !reason.trim()}>{saving ? "Saving…" : "Apply to all devices"}</button>
        <button className="btn ghost" type="button" disabled={saving} onClick={() => setSelected(null)}>Cancel</button>
      </div>
    </form> : null}
    {legacy && preferences ? <div>
      <p className="settings-hint">This device has an old host preference. Import it once for hosts without an account preference, or keep the account values. Either choice removes the old device preference.</p>
      <p className="settings-hint">Previously enabled: {legacy.size ? [...legacy].join(", ") : "none"}. Existing account changes stay unchanged.</p>
      <div className="settings-actions">
        <button className="btn" type="button" disabled={saving} onClick={() => void migrate()}>Import device preference</button>
        <button className="btn ghost" type="button" disabled={saving} onClick={finishMigration}>Keep account preferences</button>
      </div>
    </div> : null}
  </section>;
}
