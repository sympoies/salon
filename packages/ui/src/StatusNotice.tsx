import { CloseIcon } from "./icons.tsx";
import { IconButton } from "./IconButton.tsx";
import type { StatusNotice as StatusNoticeState } from "./statusNoticeModel.ts";

export function StatusNotice({ notice, onDismiss, surface = "dashboard", inline = false }: {
  readonly notice: StatusNoticeState;
  readonly onDismiss: () => void;
  readonly inline?: boolean;
  readonly surface?: "dashboard" | "shell";
}) {
  const restored = notice.kind === "restored";
  const ok = restored || notice.tone === "ok";
  const polite = restored || notice.kind === "info" || notice.kind === "transient";
  const compactLabel = notice.kind === "host-offline" ? `! ${notice.message.split(":")[0]}`
    : restored ? "Restored" : notice.kind === "attention" ? "Attention" : notice.kind === "info" ? "Opened terminal" : notice.kind === "transient" ? notice.message : "Offline";
  const unreachable = notice.kind === "unreachable";
  return (
    <div className={`connection-notice-layer is-${surface}${inline ? " is-inline" : ""}`}>
      <div className={`connection-notice is-${notice.kind}${notice.tone ? ` is-tone-${notice.tone}` : ""}`} role={polite ? "status" : "alert"} aria-live={polite ? "polite" : "assertive"} aria-atomic="true">
        <span className="connection-notice-icon" aria-hidden="true">{ok ? "✓" : notice.kind === "transient" ? "·" : "!"}</span>
        {notice.kind === "host-offline" || inline ? (
          <span className="connection-notice-message" title={notice.message}>
            <span className="connection-notice-message-full">{notice.message}</span>
            <span className="connection-notice-message-compact" aria-hidden="true">{compactLabel}</span>
          </span>
        ) : <span className="connection-notice-message">{notice.message}</span>}
        {unreachable ? <><span className="connection-notice-retrying">Reconnecting</span><span className="connection-notice-spinner" aria-hidden="true" /></> : null}
        <IconButton preset="compact" className="connection-notice-dismiss" type="button" aria-label="Dismiss status notice" onClick={onDismiss}><CloseIcon /></IconButton>
      </div>
      {/* Narrow widths with no room for the toast show only this dot; the toast stays announced. */}
      {notice.kind === "host-offline" ? <span className="connection-notice-dot" aria-hidden="true" /> : null}
    </div>
  );
}
