import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type AnimationEvent as ReactAnimationEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useAndroidBackEntry } from "./useAndroidBackEntry.ts";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** False for a docked complementary panel: no backdrop capture or Tab trap. */
  readonly modal?: boolean;
  /** Called for an explicit dismissal: a Cancel/close button or the Escape key. */
  readonly onClose: () => void;
  /**
   * While busy, the dialog cannot be dismissed at all (no Escape, no outside
   * attention pulse). Callers set this during an in-flight submit.
   */
  readonly busy?: boolean;
  readonly className?: string;
  readonly backdropClassName?: string;
  readonly androidBackEntry?: string;
  readonly ariaLabel?: string;
  readonly ariaLabelledby?: string;
  readonly lightDismiss?: boolean;
  readonly style?: CSSProperties;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  /** Opener captured before asynchronous work can remove its browser focus. */
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
  readonly onDialogKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
}

/**
 * Shared dialog shell for the app's real modals (New session, Delete session).
 *
 * A click on the backdrop does NOT dismiss the dialog, because these dialogs
 * carry unsaved input and an accidental outside click used to discard it.
 * Instead an outside click replays a short attention pulse and pulls focus back
 * inside. The only ways to close are an explicit button or the Escape key (the
 * standard accessible dismissal). Tab focus is trapped within the dialog.
 *
 * Transient popovers and dropdown menus intentionally do NOT use this shell —
 * they stay light-dismissible via `useDismissOnOutside`.
 */
export function Modal({
  modal: isModal = true,
  onClose,
  busy = false,
  className,
  backdropClassName,
  androidBackEntry = "modal",
  ariaLabel,
  ariaLabelledby,
  lightDismiss = false,
  style,
  initialFocusRef,
  restoreFocusRef,
  onDialogKeyDown,
  children,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const initiallyFocused = useRef(false);
  useAndroidBackEntry(androidBackEntry, isModal, () => {
    if (busy) return false;
    onClose();
  });

  // Restore the opener only on final unmount, not on responsive mode changes.
  useEffect(() => {
    const opener = restoreFocusRef?.current ?? document.activeElement;
    const dialog = modalRef.current;
    return () => {
      const active = document.activeElement;
      if (opener instanceof HTMLElement && opener.isConnected
        && (active === document.body || dialog?.contains(active))) {
        opener.focus();
      }
    };
  }, []);

  // Keep an active conversation control focused when switching to/from a dock.
  useEffect(() => {
    if ((isModal || !initiallyFocused.current) && !modalRef.current?.contains(document.activeElement)) {
      (initialFocusRef?.current ?? modalRef.current)?.focus();
    }
    initiallyFocused.current = true;
  }, [initialFocusRef, isModal]);

  const focusInside = useCallback(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = modal.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (focusable ?? modal).focus();
  }, []);

  const onBackdropClick = useCallback(() => {
    if (busy || !isModal) return;
    if (lightDismiss) {
      onClose();
      return;
    }
    const modal = modalRef.current;
    if (!modal) return;
    // Restart the CSS animation even on repeated clicks: drop the class, force a
    // reflow, then re-add it. The className prop is stable, so React never
    // rewrites the attribute and clobbers this.
    modal.classList.remove("modal--attention");
    void modal.offsetWidth;
    modal.classList.add("modal--attention");
    focusInside();
  }, [busy, focusInside, isModal, lightDismiss, onClose]);

  const onAnimationEnd = useCallback((event: ReactAnimationEvent<HTMLDivElement>) => {
    // Ignore animations bubbling up from children (e.g. a button spinner).
    if (event.target !== event.currentTarget) return;
    modalRef.current?.classList.remove("modal--attention");
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      onDialogKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!busy) onClose();
        return;
      }
      if (!isModal || event.key !== "Tab" || !modalRef.current) return;
      // Collapsed sections stay mounted but hidden; Tab must wrap past them.
      const focusable = [...modalRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        .filter((element) => !element.closest("[hidden]"));
      if (focusable.length === 0) {
        event.preventDefault();
        modalRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement;
      if (
        event.shiftKey
        && (activeElement === modalRef.current || activeElement === first || !modalRef.current.contains(activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey
        && (activeElement === modalRef.current || activeElement === last || !modalRef.current.contains(activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    },
    [busy, isModal, onClose, onDialogKeyDown],
  );

  return (
    <div
      className={backdropClassName ? `modal-backdrop ${backdropClassName}` : "modal-backdrop"}
      onClick={onBackdropClick}
    >
      <div
        ref={modalRef}
        className={className ? `modal ${className}` : "modal"}
        role={isModal ? "dialog" : "complementary"}
        aria-modal={isModal ? true : undefined}
        aria-busy={busy}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        tabIndex={-1}
        style={style}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
        onAnimationEnd={onAnimationEnd}
      >
        {children}
      </div>
    </div>
  );
}
