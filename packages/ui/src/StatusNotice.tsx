import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { usePreviewPinnedPopover } from "./SessionActivityPopover.tsx";
import { CloseIcon, SelectChevronIcon } from "./icons.tsx";
import { IconButton } from "./IconButton.tsx";
import type { StatusNotice as StatusNoticeState } from "./statusNoticeModel.ts";

export function StatusNotice({ notice, onDismiss, surface = "dashboard", inline = false }: {
  readonly notice: StatusNoticeState;
  readonly onDismiss: () => void;
  readonly inline?: boolean;
  readonly surface?: "dashboard" | "shell";
}) {
  const { open, popoverId, rootRef, triggerRef, popoverRef, onClick, close } = usePreviewPinnedPopover();
  const showDetails = (event: MouseEvent<HTMLButtonElement>) => {
    triggerRef.current = event.currentTarget;
    onClick(event);
  };
  const detailControl = {
    "aria-label": "Show status notice details",
    "aria-haspopup": "dialog",
    "aria-expanded": open,
    "aria-controls": open ? popoverId : undefined,
    onClick: showDetails,
  } as const;
  const restored = notice.kind === "restored";
  const ok = restored || notice.tone === "ok";
  const polite = restored || notice.kind === "info" || notice.kind === "transient";
  const compactLabel = notice.kind === "host-offline" ? `! ${notice.message.split(":")[0]}`
    : restored ? "Restored" : notice.kind === "attention" ? "Attention" : notice.kind === "info" ? "Opened terminal" : notice.kind === "transient" ? notice.message : "Offline";
  const expandable = notice.kind === "host-offline" || inline;
  const unreachable = notice.kind === "unreachable";
  const messageRef = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  const wasClipped = useRef(false);
  useEffect(() => {
    if (wasClipped.current && !clipped) close();
    wasClipped.current = clipped;
  }, [clipped, close]);
  useLayoutEffect(() => {
    const message = messageRef.current;
    if (!expandable) { setClipped(false); return; }
    if (!message) return;
    const measure = () => {
      const full = message.querySelector<HTMLElement>(".connection-notice-message-full");
      if (!full) return;
      setClipped(full.scrollWidth > message.clientWidth + 1);
    };
    const observer = new window.ResizeObserver(measure);
    observer.observe(message);
    if (message.parentElement) observer.observe(message.parentElement);
    measure();
    return () => observer.disconnect();
  }, [expandable, notice.message]);
  return (
    <span ref={rootRef} className={`connection-notice-layer is-${surface}${inline ? " is-inline" : ""}${clipped ? " is-clipped" : ""}`}>
      <span className={`connection-notice is-${notice.kind}${notice.tone ? ` is-tone-${notice.tone}` : ""}`} role={polite ? "status" : "alert"} aria-live={polite ? "polite" : "assertive"} aria-atomic="true">
        <span className="connection-notice-icon" aria-hidden="true">{ok ? "✓" : notice.kind === "transient" ? "·" : "!"}</span>
        {expandable ? (
          <span ref={messageRef} className="connection-notice-message" title={notice.message}>
            {clipped ? <button className="connection-notice-trigger" type="button" {...detailControl}>
              <span className="connection-notice-message-full" aria-hidden="true">{notice.message}</span>
              <span className="connection-notice-message-compact" aria-hidden="true">{compactLabel}</span>
              <SelectChevronIcon className="connection-notice-cue" />
            </button> : <>
              <span className="connection-notice-message-full">{notice.message}</span>
              <span className="connection-notice-message-compact" aria-hidden="true">{compactLabel}</span>
            </>}
          </span>
        ) : <span className="connection-notice-message">{notice.message}</span>}
        {unreachable ? <><span className="connection-notice-retrying">Reconnecting</span><span className="connection-notice-spinner" aria-hidden="true" /></> : null}
        <IconButton preset="compact" className="connection-notice-dismiss" type="button" aria-label="Dismiss status notice" onClick={onDismiss}><CloseIcon /></IconButton>
        {expandable ? <span className="sr-only">{notice.message}</span> : null}
      </span>
      {notice.kind === "host-offline" ? <button type="button" className="connection-notice-dot" {...detailControl}>
        <span className="sr-only">{detailControl["aria-label"]}</span>
      </button> : null}
      {expandable && open ? (
        <span className="session-activity-popover connection-notice-detail" ref={popoverRef} id={popoverId}
          role="dialog" aria-label="Status notice details" tabIndex={-1}>
          {notice.message}
        </span>
      ) : null}
    </span>
  );
}
