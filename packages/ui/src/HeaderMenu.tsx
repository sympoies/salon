import { IconButton } from "./IconButton.tsx";
import { useCallback, useEffect, useId, useRef } from "react";
import { GearIcon, MoreIcon } from "./icons.tsx";
import { useDismissOnOutside } from "./useDismissOnOutside.ts";
import { useMenuFocus } from "./useMenuFocus.ts";

export interface HeaderMenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly historyAvailable: boolean;
  readonly onHistory: () => void;
  readonly usageAvailable?: boolean;
  readonly debugAvailable?: boolean;
  readonly onUsage: () => void;
  readonly onDebug: () => void;
  readonly onSettings: () => void;
  readonly onShell?: () => void;
  readonly onRepair?: () => void;
  readonly repairDisabled?: boolean;
  readonly autoLayoutEnabled?: boolean;
  readonly onAutoLayout?: () => void;
  readonly onNewSession?: () => void;
  readonly newSessionDisabled?: boolean;
}

// The header overflow menu. It collapses the secondary pages — Usage, History,
// Debug and Settings — behind one "more" trigger so the
// header fits a single row. It renders as a right-anchored dropdown on desktop and a bottom sheet on
// mobile (styles.css); open/close is controlled by the Dashboard.
export function HeaderMenu({
  open,
  onOpenChange,
  historyAvailable,
  onHistory,
  usageAvailable = true,
  debugAvailable = true,
  onUsage,
  onDebug,
  onSettings,
  onShell,
  onRepair,
  repairDisabled = false,
  autoLayoutEnabled = false,
  onAutoLayout,
  onNewSession,
  newSessionDisabled = false,
}: HeaderMenuProps) {
  const menuId = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      // Scrim and Android Back dismissal can leave focus in hidden details or
      // on the page. Preserve focus already moved to another control/dialog.
      if (active === document.body || menuRef.current?.closest(".header-menu")?.contains(active)) {
        triggerRef.current?.focus();
      }
    }
    wasOpen.current = open;
  }, [open]);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDismissOnOutside(open, ".header-menu", close);
  const menuFocus = useMenuFocus({ open, menuRef, triggerRef, onClose: close });
  const select = (action: () => void) => {
    triggerRef.current?.focus();
    close();
    action();
  };
  return (
    <details className="header-menu" open={open}>
      <IconButton as="summary"
        ref={triggerRef}
        className="btn icon-btn header-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="More"
        title="More"
        onClick={(e) => {
          // Take over the native <details> toggle so the Dashboard owns the
          // open state while the menu hooks handle dismissal and focus.
          e.preventDefault();
          onOpenChange(!open);
        }}
      >
        <MoreIcon />
      </IconButton>
      {/* Mobile backdrop behind the bottom sheet; a tap dismisses the menu.
          Hidden on desktop via CSS. */}
      <button
        type="button"
        className="header-menu-scrim"
        aria-hidden="true"
        tabIndex={-1}
        onClick={close}
      />
      <div id={menuId} ref={menuRef} className="header-menu-dropdown" role="menu" onKeyDown={menuFocus.onKeyDown}>
        {usageAvailable ? (
          <button className="control-menu header-menu-item" type="button" role="menuitem" tabIndex={-1} onClick={() => select(onUsage)}>
            Usage
          </button>
        ) : null}
        {historyAvailable ? (
          <button className="control-menu header-menu-item" type="button" role="menuitem" tabIndex={-1} onClick={() => select(onHistory)}>
            History
          </button>
        ) : null}
        {onShell ? <button className="control-menu header-menu-item" type="button" role="menuitem" tabIndex={-1} onClick={() => select(onShell)}>Shell</button> : null}
        {debugAvailable ? (
          <button className="control-menu header-menu-item" type="button" role="menuitem" tabIndex={-1} onClick={() => select(onDebug)}>
            Debug
          </button>
        ) : null}
        {onRepair ? (
          <button className="control-menu header-menu-item" type="button" role="menuitem" tabIndex={-1} disabled={repairDisabled} onClick={() => select(onRepair)}>
            Repair
          </button>
        ) : null}
        {onAutoLayout ? (
          <button className="control-menu header-menu-item header-menu-compact-action" type="button" role="menuitemcheckbox" tabIndex={-1} aria-checked={autoLayoutEnabled} onClick={() => select(onAutoLayout)}>
            Auto layout
          </button>
        ) : null}
        {onNewSession ? (
          <button className="control-menu header-menu-item header-menu-compact-action" type="button" role="menuitem" tabIndex={-1} disabled={newSessionDisabled} onClick={() => select(onNewSession)}>
            New session
          </button>
        ) : null}
        <div className="header-menu-divider" role="separator" />
        <button className="control-menu header-menu-item" type="button" role="menuitem" tabIndex={-1} onClick={() => select(onSettings)}>
          <GearIcon />
          <span>Settings</span>
        </button>
      </div>
    </details>
  );
}
