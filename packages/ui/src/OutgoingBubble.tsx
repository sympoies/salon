import { AttachmentFileCard } from "./AttachmentFileCard.tsx";
import { sanitizeAttachmentName, CONVERSATION_IMAGE_TYPES } from "@agent-console/shared/conversation-images";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { copyTextToClipboard } from "./clipboard.ts";
import { AttachmentChip } from "./MessageMarkdown.tsx";
import { linkUploadedFiles, outgoingReplyCopyText, separateFileUploads, type OutgoingAttachment } from "./attachmentPaths.ts";
import { useDismissOnOutside } from "./useDismissOnOutside.ts";
import { useMenuFocus } from "./useMenuFocus.ts";

/** How long a touch must hold a reply before its menu opens (#110). */
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVEMENT_PX = 10;
const MENU_INSET = 8;
const COPY_CONFIRMATION_MS = 1500;
const copyFeedback = {
  copied: "Reply text copied.",
  "clipboard-unavailable": "Could not copy. The clipboard is unavailable.",
  "write-failed": "Could not copy. Clipboard access was refused.",
} as const;

function LocalImagePreview({ blob, name }: { readonly blob: Blob; readonly name: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!CONVERSATION_IMAGE_TYPES.some(type => type === blob.type)) return;
    const owned = URL.createObjectURL(blob);
    setUrl(owned);
    return () => { URL.revokeObjectURL(owned); };
  }, [blob]);
  return url ? <img className="outgoing-attachment-preview" src={url} alt={name} onError={() => setUrl(undefined)} /> : null;
}

/** A reply bubble with copy and optional dismissal actions. */
export function OutgoingBubble({ text, onDismiss, uploadSessionId, attachments = [] }: {
  readonly text: string;
  readonly attachments?: readonly OutgoingAttachment[];
  readonly uploadSessionId: string;
  readonly onDismiss?: () => void;
}) {
  const bubble = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | undefined>(undefined);
  const canDismiss = Boolean(onDismiss);
  const [at, setAt] = useState<{ readonly x: number; readonly y: number }>();
  const [feedback, setFeedback] = useState<{ readonly outcome: keyof typeof copyFeedback }>();
  const close = useCallback(() => setAt(undefined), []);
  useDismissOnOutside(Boolean(at), ".history-outgoing-menu", close);
  const menuFocus = useMenuFocus({ open: Boolean(at), menuRef: menu, triggerRef: bubble, onClose: close });
  const cancelPress = () => {
    clearTimeout(press.current?.timer);
    press.current = undefined;
  };
  useEffect(() => cancelPress, []);
  useEffect(() => {
    if (feedback?.outcome !== "copied") return;
    const timer = setTimeout(() => setFeedback(undefined), COPY_CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [feedback]);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!at || !element) return;
    element.style.left = `${Math.max(MENU_INSET, Math.min(at.x, window.innerWidth - element.offsetWidth - MENU_INSET))}px`;
    element.style.top = `${Math.max(MENU_INSET, Math.min(at.y, window.innerHeight - element.offsetHeight - MENU_INSET))}px`;
  }, [at, canDismiss]);
  const linked = linkUploadedFiles(text, uploadSessionId);
  const cards = separateFileUploads(linked);
  const parts = cards.text.split(/(\[file\]\(#salon-attachment-\d+\))/g);
  const content = <div className="history-outgoing-text message-markdown">{parts.map((part, index) => {
    const number = /^\[file\]\(#salon-attachment-(\d+)\)$/.exec(part)?.[1];
    const file = number === undefined ? undefined : linked.files[Number(number)];
    if (!file) return part;
    const attachment = attachments.find(value => value.path === file.path);
    const name = sanitizeAttachmentName(attachment?.original_name);
    const label = name ?? "[Image]";
    return <span className="outgoing-attachment" key={index}>
      {attachment?.preview ? <LocalImagePreview blob={attachment.preview} name={name ?? "Image"} /> : null}
      <AttachmentChip file={{ ...file, label }} />
    </span>;
  })}{cards.files.length ? <div className="attachment-file-list">{cards.files.map((file, index) =>
    <AttachmentFileCard key={index} file={file} attachment={attachments.find(value => value.path === file.path)} />)}</div> : null}</div>;
  const openFromKey = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey) && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const rect = bubble.current?.getBoundingClientRect();
    setAt({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
  };
  const closeAndFocus = () => {
    close();
    bubble.current?.focus({ preventScroll: true });
  };
  const copy = async () => {
    closeAndFocus();
    const outcome = await copyTextToClipboard(outgoingReplyCopyText(text, uploadSessionId, attachments));
    setFeedback({ outcome });
  };
  return <>
    <div ref={bubble} className="history-bubble history-outgoing-bubble" tabIndex={0} aria-haspopup="menu" aria-expanded={Boolean(at)}
      title="Reply actions: right-click, long-press or press Enter"
      onContextMenu={(event: MouseEvent) => { event.preventDefault(); cancelPress(); setAt({ x: event.clientX, y: event.clientY }); }}
      onKeyDown={openFromKey}
      onPointerDown={(event: PointerEvent) => {
        if (event.pointerType === "mouse") return;
        const { clientX: x, clientY: y } = event;
        cancelPress();
        const timer = setTimeout(() => { press.current = undefined; setAt({ x, y }); }, LONG_PRESS_MS);
        press.current = { timer, x, y };
      }}
      onPointerMove={event => {
        const start = press.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_MOVEMENT_PX) cancelPress();
      }}
      onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress}>
      {content}
    </div>
    {feedback ? <p role={feedback.outcome === "copied" ? "status" : "alert"}
      className={feedback.outcome === "copied" ? "history-outgoing-copy-status" : "history-outgoing-note"}>
      {copyFeedback[feedback.outcome]}
    </p> : null}
    {at ? createPortal(
      <div ref={menu} className="history-outgoing-menu" role="menu" aria-label="Reply actions" onKeyDown={menuFocus.onKeyDown}
        onBlur={event => {
          // WebKit can clear focus before a pointer click on a menu button.
          const next = event.relatedTarget;
          if (next && !event.currentTarget.contains(next)) close();
        }}>
        <button type="button" role="menuitem" tabIndex={-1} className="control-menu"
          onClick={() => void copy()}>Copy text</button>
        {onDismiss ? <button type="button" role="menuitem" tabIndex={-1} className="control-menu"
          onClick={() => { closeAndFocus(); onDismiss(); }}>Dismiss reply</button> : null}
      </div>, document.body) : null}
  </>;
}
