import { CloseIcon } from "./icons.tsx";
import { IconButton } from "./IconButton.tsx";
import { usePromptDeliveryFailure } from "./promptDelivery.ts";
import {CardStatusIcon} from "./CardStatusIcon.tsx";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
} from "react";
import type { TerminalConnectionStatus } from "./TerminalPane.tsx";
import {
  buildSessionActivityDetails,
  completionAcknowledgementKey,
  formatActivityHeaderText,
  cardActivityPresentation,
  selectSessionActivity,
} from "./sessionActivity.ts";
import { sessionKey } from "./layout.ts";
import { localStorageGetItem, localStorageSetItem } from "./storage.ts";
import type { DashboardSession } from "./types.ts";
import { useSharedClock } from "./useSharedClock.ts";
import type { ActivityDeliveryState } from "./activityStream.ts";
import { writeTerminalClipboardText } from "./terminalClipboard.ts";

const PREVIEW_DELAY_MS = 260;
const PREVIEW_CLOSE_MS = 120;
const COMPLETION_ACK_STORAGE = "agent-console.activity-acknowledgements.v1";
const MAX_COMPLETION_ACKNOWLEDGEMENTS = 256;
let completionAcknowledgementCache: Record<string, string> | null = null;

function loadCompletionAcknowledgements(): Record<string, string> {
  if (completionAcknowledgementCache) return completionAcknowledgementCache;
  const raw = localStorageGetItem(COMPLETION_ACK_STORAGE);
  if (!raw || raw.length > 256 * 1024) {
    completionAcknowledgementCache = {};
    return completionAcknowledgementCache;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      completionAcknowledgementCache = {};
      return completionAcknowledgementCache;
    }
    completionAcknowledgementCache = Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] =>
          entry[0].length <= 1024 && typeof entry[1] === "string" && entry[1].length <= 2048)
        .slice(-MAX_COMPLETION_ACKNOWLEDGEMENTS),
    );
  } catch {
    completionAcknowledgementCache = {};
  }
  return completionAcknowledgementCache;
}

function readCompletionAcknowledgement(key: string): string | null {
  return loadCompletionAcknowledgements()[key] ?? null;
}

function writeCompletionAcknowledgement(key: string, value: string): boolean {
  const entries = Object.entries(loadCompletionAcknowledgements())
    .filter(([entryKey]) => entryKey !== key)
    .slice(-(MAX_COMPLETION_ACKNOWLEDGEMENTS - 1));
  entries.push([key, value]);
  const next = Object.fromEntries(entries);
  if (!localStorageSetItem(COMPLETION_ACK_STORAGE, JSON.stringify(next))) return false;
  completionAcknowledgementCache = next;
  return true;
}

export interface SessionActivityPopoverProps {
  readonly session: DashboardSession;
  readonly machineReachable: boolean;
  readonly focused: boolean;
  readonly terminalStatus?: TerminalConnectionStatus;
  readonly clockActive?: boolean;
  readonly nowMs?: number;
  readonly monotonicNowMs?: number;
  readonly activityDeliveryState?: ActivityDeliveryState;
  readonly onOpenChange?: (open: boolean) => void;
}

function ActivityIdentityRow({ label, value, copyLabel, onCopyStart }: {
  readonly label: string;
  readonly value?: string;
  readonly copyLabel: string;
  readonly onCopyStart: () => void;
}) {
  const [copyState, setCopyState] = useState<"copying" | "copied" | "failed" | null>(null);
  const copy = async () => {
    if (!value || copyState === "copying") return;
    onCopyStart();
    setCopyState("copying");
    try {
      await writeTerminalClipboardText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return <span className="session-activity-row">
    <span className="session-activity-label">{label}</span>
    <span className="session-activity-value">
      {value ? <button type="button" className="control-reference session-activity-id-copy" aria-label={copyLabel}
        title={copyLabel} aria-disabled={copyState === "copying"}
        onClick={event => { event.stopPropagation(); void copy(); }}>{value}</button> : "Unavailable"}
      {copyState ? <span className="session-activity-copy-feedback" role="status">
        {copyState === "copying" ? "Copying…" : copyState === "copied" ? "Copied" : "Copy failed. Select and copy manually."}
      </span> : null}
    </span>
  </span>;
}

export function usePreviewPinnedPopover(onOpenChange?: (open: boolean) => void) {
  const [open, setOpenState] = useState(false);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  }, [onOpenChange]);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const popoverId = useId();

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);
  const close = useCallback(() => {
    clearTimers();
    setOpen(false);
    setPinned(false);
  }, [clearTimers, setOpen]);
  const pin = useCallback(() => {
    clearTimers();
    setOpen(true);
    setPinned(true);
  }, [clearTimers, setOpen]);
  const preview = useCallback(() => {
    if (pinned) return;
    clearTimers();
    openTimerRef.current = window.setTimeout(() => setOpen(true), PREVIEW_DELAY_MS);
  }, [clearTimers, pinned, setOpen]);
  const scheduleClose = useCallback(() => {
    if (pinned) return;
    clearTimers();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), PREVIEW_CLOSE_MS);
  }, [clearTimers, pinned, setOpen]);
  const onClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    clearTimers();
    const next = !pinned;
    setPinned(next);
    setOpen(next);
  }, [clearTimers, pinned, setOpen]);
  const onBlur = useCallback((event: FocusEvent<HTMLSpanElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose();
  }, [scheduleClose]);

  // Absolute desktop panels can extend left of the viewport when their
  // trigger is in the first slot. Mobile panels already use safe-area insets.
  useLayoutEffect(() => {
    if (!open) return;
    const popover = popoverRef.current;
    const root = rootRef.current;
    if (!popover || !root) return;
    const reposition = () => {
      popover.style.transform = "";
      if (window.getComputedStyle(popover).position !== "absolute") return;
      const rect = popover.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const left = Math.max(8, Math.min(rect.left, viewportWidth - rect.width - 8));
      const offset = left - rect.left;
      if (offset !== 0) popover.style.transform = `translateX(${offset}px)`;
    };
    reposition();
    const observer = typeof window.ResizeObserver === "function"
      ? new window.ResizeObserver(reposition)
      : null;
    observer?.observe(root);
    observer?.observe(popover);
    window.addEventListener("resize", reposition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  useEffect(() => clearTimers, [clearTimers]);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  useEffect(() => {
    if (open && pinned) {
      clearTimers();
      const popover = popoverRef.current;
      if (!popover?.contains(document.activeElement)) popover?.focus();
    }
  }, [open, pinned, clearTimers]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  return {
    open,
    pinned,
    popoverId,
    rootRef,
    triggerRef,
    popoverRef,
    preview,
    scheduleClose,
    onClick,
    onBlur,
    pin,
  };
}

export function SessionActivityPopover({
  session,
  machineReachable,
  focused,
  terminalStatus,
  clockActive = true,
  nowMs,
  monotonicNowMs,
  activityDeliveryState,
  onOpenChange,
}: SessionActivityPopoverProps) {
  const [dismissedAttentionKey, setDismissedAttentionKey] = useState<string | null>(null);
  const acknowledgementSessionKey = sessionKey(session);
  const completionKey = completionAcknowledgementKey(session);
  const [acknowledgedCompletionKey, setAcknowledgedCompletionKey] = useState<string | null>(
    () => readCompletionAcknowledgement(acknowledgementSessionKey),
  );
  const {
    open,
    pinned,
    popoverId,
    rootRef,
    triggerRef,
    popoverRef,
    preview,
    scheduleClose,
    onClick,
    onBlur,
    pin,
  } = usePreviewPinnedPopover(onOpenChange);
  const sharedNowMs = useSharedClock(clockActive && nowMs === undefined);
  const effectiveNowMs = nowMs ?? sharedNowMs;
  useEffect(() => {
    setAcknowledgedCompletionKey(readCompletionAcknowledgement(acknowledgementSessionKey));
  }, [acknowledgementSessionKey]);
  useEffect(() => {
    const synchronizeAcknowledgements = (event: StorageEvent) => {
      if (event.key !== COMPLETION_ACK_STORAGE) return;
      completionAcknowledgementCache = null;
      setAcknowledgedCompletionKey(readCompletionAcknowledgement(acknowledgementSessionKey));
    };
    window.addEventListener("storage", synchronizeAcknowledgements);
    return () => window.removeEventListener("storage", synchronizeAcknowledgements);
  }, [acknowledgementSessionKey]);
  useEffect(() => {
    if (!focused || !completionKey) return;
    if (writeCompletionAcknowledgement(acknowledgementSessionKey, completionKey)) {
      setAcknowledgedCompletionKey(completionKey);
    }
  }, [acknowledgementSessionKey, completionKey, focused]);
  const effective = selectSessionActivity({
    session,
    machineReachable,
    focused,
    terminalStatus,
    nowMs: effectiveNowMs,
    monotonicNowMs,
    activityDeliveryState,
    dismissedAttentionKey,
    acknowledgedCompletionKey,
  });

  const promptFailure = usePromptDeliveryFailure(session);
  const provider = session.provider_resume?.provider || session.agent;
  const providerName = provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider;
  const presentation = cardActivityPresentation(effective, session, machineReachable, promptFailure);
  const statusClass = (presentation.state === "working" || presentation.state === "waiting")
    && (presentation.group === "working" || presentation.group === "waiting")
    ? presentation.group : presentation.state;
  const iconState = statusClass === "working" ? "working" : statusClass === "waiting" ? "waiting"
    : statusClass === "unknown" ? "unknown" : statusClass === "completed" ? "completed"
      : statusClass === "stopped" ? "stopped" : "blocked";
  const statusDescription = presentation.description;
  const details = open
    ? buildSessionActivityDetails({
        session,
        effective,
        machineReachable,
        focused,
        terminalStatus,
        nowMs: effectiveNowMs,
        monotonicNowMs,
        activityDeliveryState,
      })
    : [];


  return (
    <span
      className="slot-meta session-activity-root"
      ref={rootRef}
      onMouseEnter={preview}
      onMouseLeave={scheduleClose}
      onFocus={preview}
      onBlur={onBlur}
    >
      <button
        type="button"
        ref={triggerRef}
        className={`control-counter session-activity-trigger activity-${effective.kind} card-state-${statusClass} ${effective.ripple ? "has-ripple" : ""}`}
        aria-label={`Session activity: ${statusDescription}`}
        title={statusDescription}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-describedby={open && !pinned ? popoverId : undefined}
        onClick={onClick}
      >
        <span className="session-activity-marker" aria-hidden="true">
          <CardStatusIcon state={iconState} />
        </span>
        <span className="session-activity-text">
          {formatActivityHeaderText({...effective,timerStartedAt:presentation.timerStartedAt}, effectiveNowMs)}
        </span>
      </button>
      {open ? (
        <span
          className={`session-activity-popover ${pinned ? "is-pinned" : "is-preview"}`}
          ref={popoverRef}
          id={popoverId}
          role={pinned ? "dialog" : "tooltip"}
          tabIndex={pinned ? -1 : undefined}
          aria-label="Session activity details"
        >
          <span className="session-activity-group">
            <span className="session-activity-group-title">Identifiers</span>
            <ActivityIdentityRow key={`managed:${session.id}`} label="Agent-session ID" value={session.id}
              copyLabel="Copy Agent-session ID" onCopyStart={pin} />
            <ActivityIdentityRow key={`provider:${session.provider_resume?.session_id ?? ""}`}
              label={`Provider session ID (${providerName})`} value={session.provider_resume?.session_id}
              copyLabel={`Copy ${providerName} provider session ID`} onCopyStart={pin} />
          </span>
          {effective.attentionText ? <span className="session-activity-attention">
            <span>{effective.attentionText}</span>
            <IconButton preset="compact" type="button" className="session-activity-attention-dismiss" aria-label="Dismiss the input-requested notice" onClick={event=>{event.stopPropagation();setDismissedAttentionKey(effective.attentionDismissKey ?? null)}}><CloseIcon /></IconButton>
          </span> : null}
          {details.map((group) => (
            <span className="session-activity-group" key={group.title}>
              <span className="session-activity-group-title">{group.title}</span>
              {group.rows.map((row) => (
                <span className="session-activity-row" key={`${group.title}:${row.label}`}>
                  <span className="session-activity-label">{row.label}</span>
                  <span className="session-activity-value">{row.value}</span>
                </span>
              ))}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
