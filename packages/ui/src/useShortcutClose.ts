import { useEffect } from "react";
import { resolveDashboardShortcutAction, type DashboardShortcutAction } from "./dashboardShortcuts.ts";
import { isMacTauri } from "./runtime.ts";

// A screen opened by a macOS shortcut closes on the same shortcut from any
// focus inside it. The dashboard layer ignores keys from dialogs and inputs, so
// the open screen answers its own opening chord through its existing close path.
export function useShortcutClose(action: DashboardShortcutAction, onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled || !isMacTauri()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (resolveDashboardShortcutAction({
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isMacTauri: true,
        editableTarget: false,
      }) !== action) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [action, enabled, onClose]);
}
