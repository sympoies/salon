import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { AttachmentChip } from "./MessageMarkdown.tsx";
import { linkUploadedFiles } from "./attachmentPaths.ts";
import { useDismissOnOutside } from "./useDismissOnOutside.ts";
import { useMenuFocus } from "./useMenuFocus.ts";

/** How long a touch must hold a reply before its menu opens (#110). */
const LONG_PRESS_MS = 500;
const MENU_WIDTH = 160;
const MENU_HEIGHT = 48;

/**
 * A reply bubble. When `onDismiss` is given, a right-click, the menu key (or
 * Shift+F10, Enter, Space) on the focused bubble, or a touch long press opens a
 * menu with one action that removes this local echo and nothing else (#110).
 */
export function OutgoingBubble({ text, onDismiss, uploadSessionId }: {
  readonly text: string;
  readonly uploadSessionId: string;
  readonly onDismiss?: () => void;
}) {
  const bubble = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [at, setAt] = useState<{ readonly x: number; readonly y: number }>();
  const close = useCallback(() => setAt(undefined), []);
  useDismissOnOutside(Boolean(at), ".history-outgoing-menu", close);
  const menuFocus = useMenuFocus({ open: Boolean(at), menuRef: menu, triggerRef: bubble, onClose: close });
  const cancelPress = () => { clearTimeout(press.current); press.current = undefined; };
  useEffect(() => cancelPress, []);
  const linked = linkUploadedFiles(text, uploadSessionId);
  const parts = linked.text.split(/(\[file\]\(#salon-attachment-\d+\))/g);
  const content = <div className="history-outgoing-text message-markdown">{parts.map((part, index) => {
    const number = /^\[file\]\(#salon-attachment-(\d+)\)$/.exec(part)?.[1];
    const file = number === undefined ? undefined : linked.files[Number(number)];
    return file ? <AttachmentChip key={index} file={{ ...file, label: file.label.startsWith("[Image ") ? "[Image]" : "[Attachment]" }} /> : part;
  })}</div>;
  if (!onDismiss) return <div className="history-bubble history-outgoing-bubble">{content}</div>;
  const openAt = (x: number, y: number) => setAt({
    x: Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT - 8)),
  });
  const openFromKey = (event: KeyboardEvent) => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey) && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const rect = bubble.current?.getBoundingClientRect();
    openAt(rect?.left ?? 0, rect?.bottom ?? 0);
  };
  return <>
    <div ref={bubble} className="history-bubble history-outgoing-bubble is-dismissable" tabIndex={0} aria-haspopup="menu"
      title="Reply actions: right-click, long-press or press Enter"
      onContextMenu={(event: MouseEvent) => { event.preventDefault(); cancelPress(); openAt(event.clientX, event.clientY); }}
      onKeyDown={openFromKey}
      onPointerDown={(event: PointerEvent) => {
        if (event.pointerType === "mouse") return;
        const { clientX, clientY } = event;
        cancelPress();
        press.current = setTimeout(() => { press.current = undefined; openAt(clientX, clientY); }, LONG_PRESS_MS);
      }}
      onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress}>
      {content}
    </div>
    {at ? createPortal(
      <div ref={menu} className="history-outgoing-menu" role="menu" aria-label="Reply actions" style={{ left: at.x, top: at.y }}
        onKeyDown={menuFocus.onKeyDown}>
        <button type="button" role="menuitem" tabIndex={-1} className="control-menu"
          onClick={() => { close(); bubble.current?.focus(); onDismiss(); }}>Dismiss reply</button>
      </div>, document.body) : null}
  </>;
}
