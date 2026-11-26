import { useEffect, useId, useState } from "react";
import qrcode from "qrcode-generator";
import { AsyncButton } from "./AsyncButton.tsx";
import { deviceRequest, DeviceSignInError, pairingOrigin, type DeviceList, type DeviceMetadata, type PairingCreated, type PairingStatus } from "./deviceSignIn.ts";
import { useAsyncAction } from "./useAsyncAction.ts";
import { writeTerminalClipboardText } from "./terminalClipboard.ts";

function PairingQr({ value }: { readonly value: string }) {
  const qr = qrcode(0, "M"); qr.addData(value); qr.make();
  const size = qr.getModuleCount();
  const cells: string[] = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++)
    if (qr.isDark(row, col)) cells.push(`M${col + 4},${row + 4}h1v1h-1z`);
  return <svg className="pairing-qr" viewBox={`0 0 ${size + 8} ${size + 8}`} role="img" aria-label="One-time pairing QR">
    <rect width="100%" height="100%" fill="white" /><path d={cells.join("")} fill="black" />
  </svg>;
}

function DeviceRenameForm({ device, onSaved, onCancel }: {
  readonly device: DeviceMetadata;
  readonly onSaved: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const { pending, run } = useAsyncAction(async (name: string) => {
    setError(null);
    try {
      const saved = await deviceRequest<{ name: string }>(`devices/${device.id}/rename`, { name });
      onSaved(saved.name);
    } catch (error) {
      setError(error instanceof DeviceSignInError && error.status === 400
        ? "Enter a device name with 1–64 characters and no control characters."
        : "Could not rename the device. Try again.");
    }
  }, { showDelayMs: 0, minVisibleMs: 0 });

  return <form className="device-rename" onSubmit={event => {
    event.preventDefault();
    void run(String(new FormData(event.currentTarget).get("name")));
  }}>
    <label>Device name
      <input name="name" defaultValue={device.name} autoFocus disabled={pending}
        aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} />
    </label>
    {error ? <p id={errorId} className="err" role="alert">{error}</p> : null}
    <AsyncButton type="submit" className="btn primary" pending={pending}>Save name</AsyncButton>
    <button type="button" className="btn ghost" disabled={pending} onClick={onCancel}>Cancel</button>
  </form>;
}

export function DeviceSettings({ onSignedOut }: { readonly onSignedOut: () => void }) {
  const [list, setList] = useState<DeviceList | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pair, setPair] = useState<PairingCreated | null>(null);
  const [status, setStatus] = useState<PairingStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => { setList(await deviceRequest<DeviceList>("devices")); };
  useEffect(() => { let active = true; void deviceRequest<DeviceList>("devices").then(value => { if (active) setList(value); }).catch(() => {});
    return () => { active = false; }; }, []);
  useEffect(() => {
    if (!pair) return;
    let active = true;
    const poll = async () => {
      try {
        const next = await deviceRequest<PairingStatus>(`pairings/${pair.id}`);
        if (!active) return;
        setStatus(next);
        if (next.unavailable || Date.now() >= pair.expires_at) {
          setPair(null); setStatus(null); setNotice("Pairing ended. Check the device list or create a new code."); await load();
        }
      } catch { if (active) setError("Could not check the pairing. Try again."); }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [pair]);
  const action = async (work: () => Promise<void>) => {
    setError(null); setNotice(null);
    try { await work(); } catch { setError("Device action unavailable. Sign in with your main access token to manage devices."); }
  };
  const link = pair ? `${pairingOrigin()}/#pair=${encodeURIComponent(pair.code.replaceAll("-", ""))}` : "";
  if (!list) return null;
  return <section className="settings-section device-pairing" aria-label="Signed-in devices">
    <h2 className="settings-section-title">Devices</h2>
    <p>Device sign-ins expire after 30 days. Renew explicitly before expiry, or revoke a device you no longer use.</p>
    {!list.can_manage ? <p>Sign in with your main access token to pair, rename or renew devices.</p> : null}
    {list.can_manage && !pair ? <AsyncButton className="btn primary" onClick={() => action(async () => {
      setPair(await deviceRequest<PairingCreated>("pairings", {})); setStatus(null);
    })}>Sign in another device</AsyncButton> : null}
    {pair ? <div className="pairing-sender" aria-label="Sign in another device">
      <h3>Sign in another device</h3><PairingQr value={link} />
      <p>Scan on your new device, copy the link, or enter this one-time code:</p>
      <output className="pairing-code">{pair.code}</output>
      <AsyncButton className="btn" onClick={() => action(async () => { await writeTerminalClipboardText(link); setNotice("One-time link copied."); })}>Copy sign-in link</AsyncButton>
      <p>Expires {new Date(pair.expires_at).toLocaleTimeString()}. Opening the link does not approve a device.</p>
      {status?.challenge ? <>
        <p>Device <strong>{status.name}</strong></p><p>Compare both screens:</p>
        <output className="pairing-verification">{status.verification}</output>
        <p>Approve only the device you have with you.</p>
        {status.approved ? <p role="status">Approved. Waiting for the new device to finish…</p>
          : <AsyncButton className="btn primary" onClick={() => action(async () => {
            await deviceRequest(`pairings/${pair.id}/approve`, { code: pair.code, challenge: status.challenge });
            setStatus({ ...status, approved: true });
          })}>Approve device</AsyncButton>}
      </> : <p role="status">Waiting for the new device to open the code…</p>}
      <AsyncButton className="btn ghost" onClick={() => action(async () => {
        await deviceRequest(`pairings/${pair.id}`, undefined, "DELETE"); setPair(null); setStatus(null);
      })}>Cancel pairing</AsyncButton>
    </div> : null}
    <ul className="device-list">{list.devices.map(device => <li key={device.id}>
      <div><strong>{device.name}</strong>{device.current ? " · This device" : ""}<span>{device.principal}</span>
        <span>Created {new Date(device.created).toLocaleString()}</span>
        <span>Last used {new Date(device.last_used).toLocaleString()}</span>
        <span>{device.revoked !== null ? "Revoked" : `${device.expires_at <= Date.now() ? "Expired" : "Expires"} ${new Date(device.expires_at).toLocaleString()}`}</span>
      </div>
      {list.can_manage && renaming === device.id ? <DeviceRenameForm
        device={device}
        onCancel={() => setRenaming(null)}
        onSaved={name => {
          setList(current => current && { ...current, devices: current.devices.map(entry =>
            entry.id === device.id ? { ...entry, name } : entry) });
          setRenaming(current => current === device.id ? null : current);
          setNotice("Device renamed.");
        }}
      /> : list.can_manage || device.revoked === null ? <div className="device-actions">
        {list.can_manage ? <button type="button" className="btn" onClick={() => {
          setNotice(null); setError(null); setRenaming(device.id);
        }}>Rename</button> : null}
        {list.can_manage && device.revoked === null && device.expires_at > Date.now() ? <AsyncButton className="btn" onClick={() => action(async () => {
          await deviceRequest(`devices/${device.id}/renew`, {}); await load(); setNotice("Device renewed for 30 days.");
        })}>Renew</AsyncButton> : null}
        {device.revoked === null ? <AsyncButton className="btn ghost" onClick={() => action(async () => {
          await deviceRequest(`devices/${device.id}`, undefined, "DELETE");
          if (device.current) onSignedOut(); else await load();
        })}>Revoke</AsyncButton> : null}
      </div> : null}
    </li>)}</ul>
    {list.devices.length === 0 ? <p>No paired devices.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}{error ? <p className="err" role="alert">{error}</p> : null}
  </section>;
}
