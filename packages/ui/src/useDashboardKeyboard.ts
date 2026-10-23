import {
  type Dispatch,
  type SetStateAction,
  useEffect,
} from "react";
import {
  resolveDashboardShortcutAction,
} from "./dashboardShortcuts.ts";
import { stepLayoutMode, type LayoutMode } from "./layout.ts";
import { isMacTauri } from "./runtime.ts";

interface UseDashboardKeyboardOptions {
  readonly active: boolean;
  readonly autoLayout: boolean;
  readonly autoDesktopMode: LayoutMode;
  readonly closeFocusedSession: () => Promise<void>;
  readonly closeOpenSlotMenus: () => void;
  readonly focusAdjacentSession: (direction: -1 | 1) => void;
  readonly isEditableShortcutTarget: (target: EventTarget | null) => boolean;
  readonly isTerminalShortcutTarget: (target: EventTarget | null) => boolean;
  readonly onUsage: () => void;
  readonly onVoice: () => void;
  readonly onConversation: () => void;
  readonly onShortcutHelp: () => void;
  readonly openSessionByShortcutIndex: (index: number) => void;
  readonly reconnectFocusedSession: () => void;
  readonly renameFocusedSession: () => void;
  readonly repairSessions: () => Promise<void>;
  readonly retitleFocusedSession: () => Promise<void>;
  readonly setAutoLayout: Dispatch<SetStateAction<boolean>>;
  readonly setFocusedKey: Dispatch<SetStateAction<string | null>>;
  readonly setLayoutMode: Dispatch<SetStateAction<LayoutMode>>;
  readonly setPendingSlot: Dispatch<SetStateAction<number | null>>;
  readonly setShowCreate: Dispatch<SetStateAction<boolean>>;
  readonly toggleFocusList: () => void;
}

export function useDashboardKeyboard({
  active,
  autoLayout,
  autoDesktopMode,
  closeFocusedSession,
  closeOpenSlotMenus,
  focusAdjacentSession,
  isEditableShortcutTarget,
  isTerminalShortcutTarget,
  onUsage,
  onVoice,
  onConversation,
  onShortcutHelp,
  openSessionByShortcutIndex,
  reconnectFocusedSession,
  renameFocusedSession,
  repairSessions,
  retitleFocusedSession,
  setAutoLayout,
  setFocusedKey,
  setLayoutMode,
  setPendingSlot,
  setShowCreate,
  toggleFocusList,
}: UseDashboardKeyboardOptions): void {
  useEffect(() => {
    if (!active) {
      closeOpenSlotMenus();
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const targetIsTerminal = isTerminalShortcutTarget(event.target);
      const macTauri = isMacTauri();
      const targetIsEditable = macTauri && !targetIsTerminal ? isEditableShortcutTarget(event.target) : false;
      const shortcutAction = resolveDashboardShortcutAction({
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isMacTauri: macTauri,
        editableTarget: targetIsEditable,
      });
      if (!shortcutAction) {
        return;
      }
      event.preventDefault();
      closeOpenSlotMenus();
      if (shortcutAction.startsWith("open-")) {
        openSessionByShortcutIndex(Number(shortcutAction.slice("open-".length)) - 1);
        return;
      }
      switch (shortcutAction) {
        case "create":
          setShowCreate(true);
          setPendingSlot(null);
          break;
        case "reconnect":
          reconnectFocusedSession();
          break;
        case "repair-sessions":
          void repairSessions();
          break;
        case "rename":
          renameFocusedSession();
          break;
        case "layout-decrease":
          setLayoutMode((current) => stepLayoutMode(autoLayout ? autoDesktopMode : current, -1));
          setAutoLayout(false);
          break;
        case "layout-increase":
          setLayoutMode((current) => stepLayoutMode(autoLayout ? autoDesktopMode : current, 1));
          setAutoLayout(false);
          break;
        case "usage":
          onUsage();
          break;
        case "voice":
          onVoice();
          break;
        case "conversation":
          onConversation();
          break;
        case "shortcut-help":
          onShortcutHelp();
          break;
        case "close":
          void closeFocusedSession();
          break;
        case "back":
          setFocusedKey(null);
          break;
        case "toggle-focus":
          toggleFocusList();
          break;
        case "retitle":
          void retitleFocusedSession();
          break;
        case "session-prev":
          focusAdjacentSession(-1);
          break;
        case "session-next":
          focusAdjacentSession(1);
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    active,
    autoDesktopMode,
    autoLayout,
    closeFocusedSession,
    closeOpenSlotMenus,
    focusAdjacentSession,
    isEditableShortcutTarget,
    isTerminalShortcutTarget,
    onUsage,
    onVoice,
    onConversation,
    onShortcutHelp,
    openSessionByShortcutIndex,
    reconnectFocusedSession,
    renameFocusedSession,
    repairSessions,
    retitleFocusedSession,
    setAutoLayout,
    setFocusedKey,
    setLayoutMode,
    setPendingSlot,
    setShowCreate,
    toggleFocusList,
  ]);
}
