import { IconButton } from "./IconButton.tsx";
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { computeAnchoredStyle } from "./useAnchoredFloating.ts";
import { useAndroidBackEntry } from "./useAndroidBackEntry.ts";
import { useDismissOnOutside } from "./useDismissOnOutside.ts";
import { useMenuFocus } from "./useMenuFocus.ts";
import type { SessionCardCopyAction } from "./sessionCardCopy.ts";
import "./sessionCopyMenu.css";

const PREFERENCE_KEY = "agent-console.session-copy-action";

function lastCopyAction(): string | null {
  try { return window.localStorage.getItem(PREFERENCE_KEY); } catch { return null; }
}

export function SessionCopyMenu({ actions, ariaLabel, title, mobile, open, copied, onOpenChange, onCopy }: {
  readonly actions: readonly SessionCardCopyAction[];
  readonly ariaLabel: string;
  readonly title: string;
  readonly mobile: boolean;
  readonly open: boolean;
  readonly copied: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCopy: (action: SessionCardCopyAction) => Promise<boolean>;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [copiedLabel, setCopiedLabel] = useState(() => actions[0]?.label.replace(/^Copy /, "Copied ") ?? "Copied session text");
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" });
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDismissOnOutside(open, ".session-copy-root, .session-copy-menu", close);
  useAndroidBackEntry("session-copy-menu", open, close);
  const menuFocus = useMenuFocus({ open, menuRef, triggerRef, onClose: close });
  useLayoutEffect(() => {
    if (!open || mobile) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 16);
      setPosition(computeAnchoredStyle({ top: rect.top, bottom: rect.bottom, left: rect.right - width, width },
        { width: window.innerWidth, height: window.innerHeight }, { maxHeight: 320 }));
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [mobile, open]);

  function show() {
    setPreferred(lastCopyAction());
    onOpenChange(true);
  }

  async function copy(action: SessionCardCopyAction) {
    if (busy) return;
    close();
    triggerRef.current?.focus();
    setBusy(true);
    try {
      if (await onCopy(action)) {
        setCopiedLabel(action.label.replace(/^Copy /, "Copied "));
        setPreferred(action.id);
        try { window.localStorage.setItem(PREFERENCE_KEY, action.id); } catch { /* Keep the current menu usable. */ }
      }
    } finally { setBusy(false); }
  }
  const ordered = [...actions].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  const feedback = copied ? <span className="session-copy-feedback" role="status">{copiedLabel}</span> : null;
  return (
    <span className="session-copy-root">
      <IconButton preset="compact" ref={triggerRef} className={`session-command-copy-button ${copied ? "copied" : ""}`}
        type="button" aria-label={ariaLabel} title={title} aria-haspopup="menu" aria-expanded={open}
        disabled={busy}
        onClick={(event) => { event.stopPropagation(); if (open) close(); else show(); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault(); event.stopPropagation(); if (open) close(); else show();
          }
        }}>
        <span className="copy-icon" aria-hidden="true" />
      </IconButton>
      {open && createPortal(<>
        {mobile ? <div className="session-copy-backdrop" onClick={(event) => { event.stopPropagation(); close(); }} /> : null}
        <div ref={menuRef} className={`session-copy-menu ${mobile ? "session-copy-sheet" : ""}`}
          style={mobile ? undefined : position} role="menu" aria-label="Copy session actions"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              const target = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>('[role="menuitem"]') : null;
              if (target) { event.preventDefault(); event.stopPropagation(); target.click(); }
            } else menuFocus.onKeyDown(event);
          }}>
          {ordered.map((action) => <button className="control-menu" key={action.id} type="button" role="menuitem" tabIndex={-1} disabled={busy}
            onClick={() => void copy(action)}>
            <span>{action.label}</span><code>{action.value}</code>
          </button>)}
        </div>
      </>, document.body)}
      {feedback && (typeof document === "undefined" ? feedback : createPortal(feedback, document.body))}
    </span>
  );
}
