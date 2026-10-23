import { IconButton } from "./IconButton.tsx";
import { useRef } from "react";
import { computeAnchoredStyle } from "./useAnchoredFloating.ts";
import type { OfflineCountMachine } from "./headerCountAvailability.ts";

export function HeaderCountsNotice({ machines }: { readonly machines: readonly OfflineCountMachine[] }) {
  const triggerRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  if (machines.length === 0) return null;
  return <details className="header-counts-notice" onToggle={event => {
    if (!event.currentTarget.open || !triggerRef.current || !panelRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 16);
    const style = computeAnchoredStyle({ top: rect.top, bottom: rect.bottom, left: rect.right - width, width },
      { width: window.innerWidth, height: window.innerHeight });
    panelRef.current.style.cssText = "";
    for (const [key, value] of Object.entries(style)) panelRef.current.style.setProperty(
      key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), typeof value === "number" ? `${value}px` : String(value));
  }} onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; triggerRef.current?.focus(); } }}>
    <IconButton ref={triggerRef} as="summary" preset="standard" aria-label="Partial session counts" title="Partial counts: tap for offline hosts">!</IconButton>
    <div ref={panelRef} className="header-counts-detail" role="status">
      <strong>Partial counts</strong>
      <p>Offline hosts are excluded after 60 seconds. Recently disconnected hosts retain their last-known counts.</p>
      <ul>{machines.map(machine => <li key={machine.name}>
        <strong>{machine.name}</strong>: offline since <time dateTime={new Date(machine.since).toISOString()}>{new Date(machine.since).toLocaleString()}</time>
        {machine.held ? " (last-known counts included)" : " (excluded)"}
      </li>)}</ul>
    </div>
  </details>;
}
