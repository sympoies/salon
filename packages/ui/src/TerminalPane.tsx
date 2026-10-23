import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { sendSessionInput } from "./api.ts";
import { type SpecialKey } from "./frames.ts";
import { defaultScheduler } from "./scheduler.ts";
import { type TerminalCompositionGuard } from "./terminalComposition.ts";
import {
  isKeyboardActivationArea,
  keyboardActivationRect,
  shouldGateTerminalFocus,
} from "./terminalFocus.ts";
import {
  BASE_TERMINAL_FONT_SIZE,
  createTerminalInstance,
  type TerminalConnectionStatus,
  type TerminalTouchMenu,
} from "./terminalInstance.ts";
import { confirmTerminalLinkOpen, openExternalTerminalUrl } from "./terminalLinks.ts";
import type { TerminalLinkEntry } from "./terminalLinkRegistry.ts";
import { hasCoarsePrimaryPointer } from "./terminalPointer.ts";
import {
  keyboardInsetFromViewport,
  keyboardWasDismissed,
  preventKeyBarMouseFocus,
  setKeyboardInsetStyle,
} from "./terminalViewport.ts";
import type { TerminalRenderMode } from "./terminalRenderMode.ts";
import {
  createProviderPromptTitleSource,
  createTerminalPromptCapture,
} from "./terminalTurnTitle.ts";
import {
  selectionRangeFromWordDrag,
  terminalCellFromPoint,
  type SelectionEndpoints,
  type TerminalSessionSwipeDirection,
} from "./terminalTouch.ts";
import {
  createTerminalStatusController,
  type TerminalStatusController,
  type TerminalUploadStatus,
} from "./terminalUploadStatus.ts";
import { terminalKeyBarLayout } from "./terminalKeyBar.ts";
import { backgroundReconnectOffsetMs, type TerminalTransportController } from "./terminalTransport.ts";
import { useTerminalClipboard } from "./useTerminalClipboard.ts";
import { SpeechComposer } from "./SpeechComposer.tsx";
import { createTerminalContextCommandGuard, isBracketedTerminalPaste } from "./terminalContextCommandGuard.ts";

export type { TerminalConnectionStatus };
type UploadStatus = TerminalUploadStatus;

function isTerminalFunctionKey(key: string): boolean {
  return /^F(?:[1-9]|1\d|2[0-4])$/.test(key);
}

export interface TerminalPaneProps {
  readonly machine: string;
  readonly id: string;
  readonly sessionIncarnation?: string;
  readonly agent?: string;
  readonly className?: string;
  readonly autoFocus?: boolean;
  readonly fontSize?: number;
  readonly interactive?: boolean;
  readonly readableFit?: boolean;
  readonly realtimeOutput?: boolean;
  readonly renderMode?: TerminalRenderMode;
  readonly scrollback?: number;
  readonly showKeyBar?: boolean;
  readonly layoutSyncKey?: string;
  readonly reconnectToken?: number;
  readonly focusRequestToken?: number;
  // Whether the session list currently reaches this pane's machine.
  readonly machineReachable?: boolean;
  readonly onStatusChange?: (status: TerminalConnectionStatus) => void;
  readonly onPromptFocus?: () => void;
  readonly onTurnPromptSubmit?: (prompt: string, eventId?: string, submittedAt?: string) => void;
  readonly onTurnOutput?: () => void;
  readonly onSessionSwipe?: (direction: TerminalSessionSwipeDirection) => void;
  // Ask the app to regenerate this session's title via the LLM (terminal menu).
  readonly onRetitle?: () => void;
}

export function TerminalPane({
  machine,
  id,
  sessionIncarnation,
  agent,
  className,
  autoFocus = false,
  fontSize = BASE_TERMINAL_FONT_SIZE,
  interactive = true,
  readableFit = false,
  realtimeOutput,
  renderMode = "realtime",
  scrollback = 2500,
  showKeyBar = false,
  layoutSyncKey,
  reconnectToken = 0,
  focusRequestToken = 0,
  machineReachable = true,
  onStatusChange,
  onPromptFocus,
  onTurnPromptSubmit,
  onTurnOutput,
  onSessionSwipe,
  onRetitle,
}: TerminalPaneProps) {
  const resolvedRealtimeOutput = realtimeOutput ?? autoFocus;
  const paneRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const transportRef = useRef<TerminalTransportController | null>(null);
  const mountedRef = useRef(true);
  const terminalPasteInputRef = useRef(false);
  const compositionGuardRef = useRef<TerminalCompositionGuard | null>(null);
  const statusControllerRef = useRef<TerminalStatusController | null>(null);
  const requestTerminalLayoutSyncRef = useRef<(() => void) | null>(null);
  const syncSelectionHandlesRef = useRef<(() => void) | null>(null);
  // Snapshot of the most recent non-empty terminal selection (text + capture
  // time). Copy falls back to this when the live selection was cleared by a TUI
  // redraw before the user reached the menu. See resolveTerminalCopyText.
  const capturedSelectionRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  // Latest tmux paste buffer for this session — what a mouse-selection-copying TUI
  // (e.g. Claude Code: "copied N chars to tmux buffer") put there. A live TUI never
  // exposes its on-screen selection to the DOM, so Copy falls back to this. Fetched
  // after a real drag ends; see the buffer warmer in createTerminalInstance.
  const terminalBufferRef = useRef<string>("");
  const consumeTerminalBufferRef = useRef<(() => void) | null>(null);
  // Set inside the terminal-creation effect; lets the component-scope selection
  // handle-drag handlers re-open the copy toolbar at the adjusted endpoint.
  const showTouchMenuAtRef = useRef<((clientX: number, clientY: number) => void) | null>(null);
  const flushTerminalOutputRef = useRef<(() => void) | null>(null);
  const handleDragLastPointRef = useRef<{ x: number; y: number } | null>(null);
  // fontSize / readableFit / autoFocus are read live through refs so the
  // terminal-creation effect below does not depend on them. Opening a session
  // toggles these props; keeping them out of the effect (and the instance key)
  // re-fits / re-focuses the SAME terminal instead of tearing it down and
  // reconnecting the WebSocket (which dropped scrollback and caused Reconnect churn).
  const fontSizeRef = useRef(fontSize);
  const readableFitRef = useRef(readableFit);
  const autoFocusRef = useRef(autoFocus);
  const focusRequestTokenRef = useRef(focusRequestToken);
  const handledFocusRequestTokenRef = useRef(0);
  const realtimeOutputRef = useRef(resolvedRealtimeOutput);
  const renderModeRef = useRef(renderMode);
  const onStatusChangeRef = useRef(onStatusChange);
  const onPromptFocusRef = useRef(onPromptFocus);
  const onTurnPromptSubmitRef = useRef(onTurnPromptSubmit);
  const onTurnOutputRef = useRef(onTurnOutput);
  const onSessionSwipeRef = useRef(onSessionSwipe);
  const promptCaptureRef = useRef(createTerminalPromptCapture());
  const [contextCommandRefusal, setContextCommandRefusal] = useState<string | null>(null);
  const contextCommandGuardRef = useRef(createTerminalContextCommandGuard(agent));
  useEffect(() => {
    contextCommandGuardRef.current = createTerminalContextCommandGuard(agent);
    setContextCommandRefusal(null);
  }, [agent, id, machine, sessionIncarnation]);
  const promptTitleSourceRef = useRef<ReturnType<typeof createProviderPromptTitleSource> | null>(null);
  if (promptTitleSourceRef.current === null) {
    promptTitleSourceRef.current = createProviderPromptTitleSource({
      onPrompt: (prompt, eventId, submittedAt) => onTurnPromptSubmitRef.current?.(prompt, eventId, submittedAt),
    });
  }
  fontSizeRef.current = fontSize;
  readableFitRef.current = readableFit;
  autoFocusRef.current = autoFocus;
  focusRequestTokenRef.current = focusRequestToken;
  realtimeOutputRef.current = resolvedRealtimeOutput;
  onStatusChangeRef.current = onStatusChange;
  onPromptFocusRef.current = onPromptFocus;
  onTurnPromptSubmitRef.current = onTurnPromptSubmit;
  onTurnOutputRef.current = onTurnOutput;
  onSessionSwipeRef.current = onSessionSwipe;
  // Draggable selection endpoints (pane-relative pixels); null when there is no
  // selection. The creation effect keeps this in sync via term.onSelectionChange.
  const [selectionHandles, setSelectionHandles] = useState<SelectionEndpoints | null>(null);
  // Which handle is being dragged, and the fixed (anchor) endpoint's cell offset.
  const draggingHandleRef = useRef<"start" | "end" | null>(null);
  const handleDragAnchorRef = useRef(0);
  const [status, setStatus] = useState<TerminalConnectionStatus>("connecting");
  const [localReconnect, setLocalReconnect] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>(null);
  const keyBarLayout = terminalKeyBarLayout(agent);
  const keyBarOverflowId = useId();
  const [keyBarOverflowOpen, setKeyBarOverflowOpen] = useState(false);
  useEffect(() => {
    // Focusing a DSH pane after a claude one empties the row; leaving it open
    // would hang an empty second bar over the terminal.
    if (keyBarLayout.overflow.length === 0) {
      setKeyBarOverflowOpen(false);
    }
  }, [keyBarLayout.overflow.length]);
  // Single owner of the upload/clipboard status lifecycle: every busy/ok/error
  // transition (and its auto-dismiss) goes through this so errors clear like
  // success and a stale result can't overwrite a newer state.
  if (statusControllerRef.current === null) {
    statusControllerRef.current = createTerminalStatusController({
      setStatus: setUploadStatus,
      setTimeout: defaultScheduler.setTimeout,
      clearTimeout: defaultScheduler.clearTimeout,
    });
  }
  const statusController = statusControllerRef.current;
  const showInputRejection = (rejection: {
    readonly code?: string;
    readonly message?: string;
    readonly outcomeUnknown?: boolean;
  }) => {
    const uncertainty = contextCommandGuardRef.current.markInputUncertain();
    if (uncertainty) setContextCommandRefusal(uncertainty);
    const message = rejection.outcomeUnknown
      ? "Terminal input may have been sent. Check the session before retrying."
      : rejection.code === "codex-account-next-pending"
      ? "Applying the selected Codex account. Your prompt was not sent; retry shortly."
      : rejection.message ?? "Terminal input was rejected. Retry shortly.";
    statusController.failStandalone(message);
  };
  const [terminalTouchMenu, setTerminalTouchMenu] = useState<TerminalTouchMenu>(null);
  // Open link picker, holding the snapshot taken when the toolbar opened so the
  // list cannot shift under a finger while it is being read.
  const [terminalLinkPicker, setTerminalLinkPicker] = useState<readonly TerminalLinkEntry[] | null>(null);
  // Identity intentionally omits fontSize/readableFit/autoFocus/realtimeOutput/renderMode: those change on
  // open and must re-fit/re-focus the same terminal, not recreate it. Only a
  // session incarnation, reconnect, or scrollback rebuild swaps it.
  const terminalInstanceKey = `${machine}\u0000${id}\u0000${sessionIncarnation ?? ""}\u0000${localReconnect}\u0000${reconnectToken}\u0000${scrollback}`;

  // Every path that drops terminal focus goes through here. xterm never resets
  // CompositionHelper._isComposing on blur, and Chrome on Android reports
  // keyCode 229 for every soft-keyboard character, so a composition blurred
  // before its compositionend leaves the terminal swallowing all later typing
  // until the page reloads. Finalizing first costs at most an uncommitted IME
  // preedit — the same thing Chrome drops when a field loses focus
  // mid-composition. See terminalComposition.ts.
  const blurTerminal = () => {
    compositionGuardRef.current?.finalize();
    termRef.current?.blur();
  };

  useEffect(() => {
    onStatusChangeRef.current?.(status);
  }, [status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The machine is reachable again after an outage: reconnect a disconnected
  // pane now instead of leaving it to wait out its backoff. Like the online
  // wake, unfocused panes keep their stable offset so they do not all attach
  // at once. A wake never replaces an open or in-progress attach.
  const machineWasReachableRef = useRef(machineReachable);
  useEffect(() => {
    const wasReachable = machineWasReachableRef.current;
    machineWasReachableRef.current = machineReachable;
    if (wasReachable || !machineReachable) return;
    const timer = defaultScheduler.setTimeout(
      () => transportRef.current?.wake(),
      autoFocusRef.current ? 0 : backgroundReconnectOffsetMs(machine, id),
    );
    return () => defaultScheduler.clearTimeout(timer);
  }, [id, machine, machineReachable]);

  const sendTransportInput = (body: Parameters<TerminalTransportController["sendInput"]>[0]) => {
    const transport = transportRef.current;
    if (transport) {
      void transport.sendInput(body);
      return;
    }
    if (agent === "shell") { showInputRejection({ message: "Shell is disconnected. Reconnect before typing." }); return; }
    const inputGuard = contextCommandGuardRef.current;
    void sendSessionInput(machine, id, body)
      .then((result) => {
        if (!result.ok && mountedRef.current && inputGuard === contextCommandGuardRef.current) {
          showInputRejection({
            message: result.error,
            outcomeUnknown: result.outcomeUnknown,
          });
        }
      })
      .catch(() => {
        if (mountedRef.current && inputGuard === contextCommandGuardRef.current) {
          showInputRejection({ message: "Terminal input failed. Retry shortly." });
        }
      });
  };

  const sendTextFrame = (text: string) => {
    const refusal = contextCommandGuardRef.current.acceptText(text);
    if (refusal) { setContextCommandRefusal(refusal); return; }
    if (!isBracketedTerminalPaste(text) && /[\r\n]/.test(text)) {
      setContextCommandRefusal(null);
    }
    submitCapturedTurnPrompts(promptCaptureRef.current.acceptText(text));
    sendTransportInput({ text });
  };

  // The refusal's clear action (#983): one edit-only frame, never the
  // provider's quit key. A proven clear restarts prompt capture (#991).
  const clearContextDraft = () => {
    const clear = contextCommandGuardRef.current.clearDraft();
    if (!clear) return;
    if (clear.cleared) promptCaptureRef.current.reset();
    else promptCaptureRef.current.invalidate();
    sendTransportInput({ text: clear.text });
    setContextCommandRefusal(clear.message ?? contextCommandGuardRef.current.uncertaintyMessage());
  };

  const sendKeyFrame = (key: SpecialKey) => {
    const refusal = contextCommandGuardRef.current.acceptKey(key);
    if (refusal) { setContextCommandRefusal(refusal); return; }
    if (key === "c-c" || key === "enter") {
      setContextCommandRefusal(contextCommandGuardRef.current.uncertaintyMessage());
    }
    submitCapturedTurnPrompts(promptCaptureRef.current.acceptKey(key));
    sendTransportInput({ keys: [key] });
  };

  useEffect(() => {
    return () => {
      statusControllerRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    requestTerminalLayoutSyncRef.current?.();
  }, [layoutSyncKey]);

  useEffect(() => {
    requestTerminalLayoutSyncRef.current?.();
  }, [fontSize, readableFit]);

  useEffect(() => {
    // Re-pin the newly active focused session to the latest output. A session-to-
    // session switch keeps the parent's focus-mode-global readableFit prop true, so
    // the [fontSize, readableFit] effect above never re-runs for the incoming pane;
    // force a layout sync here (re-fit + bottom-pin) so it scrolls to the latest
    // output like a fresh open, then raise the keyboard unless touch-gated.
    if (autoFocus) {
      flushTerminalOutputRef.current?.();
      requestTerminalLayoutSyncRef.current?.();
      if (!shouldGateTerminalFocus(hasCoarsePrimaryPointer())) {
        termRef.current?.focus();
      }
    }
  }, [autoFocus]);

  useEffect(() => {
    if (resolvedRealtimeOutput) {
      flushTerminalOutputRef.current?.();
    }
  }, [resolvedRealtimeOutput]);

  useEffect(() => {
    if (renderModeRef.current !== renderMode) {
      // Finish the old profile's batch before publishing the new mode. This
      // keeps telemetry attribution intact and makes the next frame use the
      // newly selected 100/250/500 ms window immediately.
      flushTerminalOutputRef.current?.();
      renderModeRef.current = renderMode;
    }
  }, [renderMode]);

  useEffect(() => {
    if (!interactive) {
      blurTerminal();
      setTerminalTouchMenu(null);
    }
  }, [interactive]);

  useEffect(() => {
    setTerminalTouchMenu(null);
    // The picker holds a snapshot from the registry that this instance owns; a
    // reconnect or scrollback rebuild disposes that registry, so the list would
    // otherwise stay open describing a terminal that no longer exists.
    setTerminalLinkPicker(null);
    promptCaptureRef.current.reset();
    promptTitleSourceRef.current?.resetConnection();
    return () => {
      promptTitleSourceRef.current?.resetConnection();
    };
  }, [terminalInstanceKey]);

  // Desktop: dismiss the clipboard toolbar on an outside click or Escape. (Touch
  // dismisses it on the next touchstart via the touch bridge, so this only needs
  // to cover the mouse right-click flow.)
  useEffect(() => {
    const menuOpen = terminalTouchMenu !== null && terminalTouchMenu.key === terminalInstanceKey;
    const pickerOpen = terminalLinkPicker !== null;
    if (!menuOpen && !pickerOpen) {
      return;
    }
    const dismiss = () => {
      setTerminalTouchMenu(null);
      setTerminalLinkPicker(null);
    };
    const closeOnOutsideMouseDown = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(".terminal-touch-menu") || target.closest(".terminal-link-picker"))
      ) {
        return;
      }
      dismiss();
    };
    const closeOnEscape = (event: Event) => {
      if ((event as unknown as { key?: string }).key === "Escape") {
        dismiss();
      }
    };
    document.addEventListener("mousedown", closeOnOutsideMouseDown, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideMouseDown, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [terminalTouchMenu, terminalLinkPicker, terminalInstanceKey]);

  const submitCapturedTurnPrompts = (prompts: readonly string[]) => {
    promptTitleSourceRef.current?.acceptLocal(prompts);
  };

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || !showKeyBar) {
      return;
    }

    const visualViewport = window.visualViewport;
    // Inset below which the on-screen keyboard is considered down (0 when hidden,
    // a few hundred px when raised); the threshold ignores small viewport nudges
    // like the browser URL bar.
    const KEYBOARD_DISMISS_INSET_PX = 80;
    // Track the last inset so a fall back toward 0 can be recognized as the
    // keyboard being dismissed.
    let previousInset = 0;
    const applyKeyboardInset = () => {
      if (!visualViewport) {
        setKeyboardInsetStyle(pane, null);
        return;
      }

      const layoutHeight = Math.max(
        window.innerHeight,
        document.documentElement.clientHeight,
      );
      const geometry = {
        layoutHeight,
        visualHeight: visualViewport.height,
        visualOffsetTop: visualViewport.offsetTop,
      };
      setKeyboardInsetStyle(pane, geometry);

      // When the keyboard is dismissed, xterm keeps its hidden textarea focused,
      // so Android re-raises the keyboard on the next touch of that element —
      // including a scroll/swipe, which never passes through the tap focus-gate
      // that would blur it. That makes a dismissed keyboard pop back on the first
      // swipe. Drop terminal focus on dismissal (coarse pointer only) so it stays
      // down until an explicit bottom-third tap re-summons it.
      const inset = keyboardInsetFromViewport(geometry);
      if (
        hasCoarsePrimaryPointer() &&
        keyboardWasDismissed(previousInset, inset, KEYBOARD_DISMISS_INSET_PX)
      ) {
        blurTerminal();
      }
      previousInset = inset;
    };

    applyKeyboardInset();
    window.addEventListener("resize", applyKeyboardInset);
    visualViewport?.addEventListener("resize", applyKeyboardInset);
    visualViewport?.addEventListener("scroll", applyKeyboardInset);

    return () => {
      window.removeEventListener("resize", applyKeyboardInset);
      visualViewport?.removeEventListener("resize", applyKeyboardInset);
      visualViewport?.removeEventListener("scroll", applyKeyboardInset);
      pane.style.removeProperty("--keyboard-inset");
    };
  }, [showKeyBar]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) {
      return;
    }
    const inputGuard = contextCommandGuardRef.current;
    return createTerminalInstance(el, {
      machine,
      id,
      agent,
      scrollback,
      terminalInstanceKey,
      paneRef,
      hostRef,
      termRef,
      transportRef,
      mountedRef,
      terminalPasteInputRef,
      compositionGuardRef,
      capturedSelectionRef,
      terminalBufferRef,
      consumeTerminalBufferRef,
      showTouchMenuAtRef,
      flushTerminalOutputRef,
      requestTerminalLayoutSyncRef,
      syncSelectionHandlesRef,
      fontSizeRef,
      readableFitRef,
      autoFocusRef,
      focusRequestTokenRef,
      handledFocusRequestTokenRef,
      realtimeOutputRef,
      renderModeRef,
      onTurnOutputRef,
      onSessionSwipeRef,
      onPromptFocusRef,
      onProviderPromptCapability: (capability) => promptTitleSourceRef.current?.setCapability(capability),
      onProviderPromptEvent: (event) => promptTitleSourceRef.current?.acceptProvider({
        eventId: event.eventId,
        text: event.text,
        submittedAt: event.submittedAt,
      }),
      onInputRejected: (rejection) => {
        if (inputGuard === contextCommandGuardRef.current) showInputRejection(rejection);
      },
      sendTextFrame,
      sendKeyFrame,
      setStatus,
      setTerminalTouchMenu,
      setSelectionHandles,
    });
  }, [agent, id, localReconnect, machine, reconnectToken, scrollback, terminalInstanceKey]);

  useEffect(() => {
    if (
      focusRequestToken === 0 ||
      handledFocusRequestTokenRef.current === focusRequestToken
    ) {
      return;
    }
    const terminal = termRef.current;
    if (!terminal) {
      return;
    }
    handledFocusRequestTokenRef.current = focusRequestToken;
    terminal.focus();
  }, [focusRequestToken]);

  const sendKey = (key: SpecialKey) => {
    sendKeyFrame(key);
    // Do not refocus xterm here: mobile browsers treat that tap as permission
    // to focus xterm's hidden textarea and raise the software keyboard.
  };

  const sendTerminalText = (text: string) => {
    sendTextFrame(text);
  };

  const sendTerminalSequence = (sequence: string) => {
    // This is a terminal key sequence, not prompt text. The daemon's literal
    // input path passes these bytes to tmux without a bracketed-paste wrapper.
    promptCaptureRef.current.invalidate();
    contextCommandGuardRef.current.noteNavigation();
    sendTransportInput({ text: sequence });
  };

  const {
    visibleTouchMenu,
    canCopyTerminalSelection,
    canPasteTerminalClipboard,
    handleTouchMenuCopy,
    handleTouchMenuCopyOneLine,
    handleTouchMenuCopyLink,
    handleTouchMenuPaste,
    handleTerminalKeyDownCapture,
    handlePaste,
    handleDragOver,
    handleDrop,
    handleFiles,
  } = useTerminalClipboard({
    allowFiles: agent !== "shell",
    machine,
    id,
    terminalInstanceKey,
    termRef,
    terminalPasteInputRef,
    capturedSelectionRef,
    terminalBufferRef,
    consumeTerminalBufferRef,
    terminalTouchMenu,
    setTerminalTouchMenu,
    statusController,
    sendTerminalText,
  });

  const handleTerminalPromptKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Some modified function keys share their encoded bytes with a terminal
    // cursor-position report (for example Shift-F3 and CSI 1;2R). The DOM key
    // event supplies the source context that the xterm onData bytes lack.
    if (isTerminalFunctionKey(event.key)) {
      promptCaptureRef.current.invalidate();
      contextCommandGuardRef.current.noteNavigation();
    }
    handleTerminalKeyDownCapture(event);
  };

  const beginSelectionHandleDrag = (which: "start" | "end") => (event: ReactTouchEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const term = termRef.current;
    const pos = term?.getSelectionPosition();
    if (!term || !pos) {
      return;
    }
    // Anchor the endpoint NOT being dragged, as a buffer-linear cell offset.
    const startOffset = pos.start.y * term.cols + pos.start.x;
    const endOffset = pos.end.y * term.cols + Math.max(pos.end.x - 1, 0);
    handleDragAnchorRef.current = which === "start" ? endOffset : startOffset;
    draggingHandleRef.current = which;
    handleDragLastPointRef.current = null;
    // Hide the toolbar while refining; it re-opens at the new endpoint on release.
    setTerminalTouchMenu(null);
  };

  const onSelectionHandleMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (!draggingHandleRef.current) {
      return;
    }
    event.stopPropagation();
    const touch = event.touches[0];
    const term = termRef.current;
    if (!touch || !term) {
      return;
    }
    handleDragLastPointRef.current = { x: touch.clientX, y: touch.clientY };
    const cell = terminalCellFromPoint(term, touch.clientX, touch.clientY);
    if (!cell) {
      return;
    }
    const current = cell.row * term.cols + cell.col;
    const anchor = handleDragAnchorRef.current;
    const range = selectionRangeFromWordDrag(anchor, anchor, current);
    term.select(range.start % term.cols, Math.floor(range.start / term.cols), range.length);
  };

  const endSelectionHandleDrag = () => {
    draggingHandleRef.current = null;
    // Re-open the copy toolbar near the adjusted endpoint so Copy acts on the
    // refined range without hunting for where the long-press first placed it.
    const point = handleDragLastPointRef.current;
    handleDragLastPointRef.current = null;
    if (point && termRef.current?.hasSelection()) {
      showTouchMenuAtRef.current?.(point.x, point.y);
    }
  };

  const shouldPreventTerminalFocus = (clientY: number) => {
    const host = hostRef.current;
    if (!host || !shouldGateTerminalFocus(hasCoarsePrimaryPointer())) {
      return false;
    }
    // A non-focused (grid) pane never grabs focus or the keyboard on touch; the
    // Open button promotes it to the focused session instead.
    if (!autoFocusRef.current) {
      return true;
    }
    // The keyboard inset padding shrinks the host while the keyboard is up; fold
    // it back so the summon band stays anchored to the keyboard-independent
    // height instead of creeping up into the middle of the screen.
    const pane = paneRef.current;
    const keyboardInset = pane ? Number.parseFloat(getComputedStyle(pane).paddingBottom) : 0;
    const rect = keyboardActivationRect(host.getBoundingClientRect(), keyboardInset);
    return !isKeyboardActivationArea(clientY, rect);
  };

  const preventTerminalFocus = (event: {
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    event.preventDefault();
    event.stopPropagation();
    blurTerminal();
  };

  const handleTerminalMouseDownCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (shouldPreventTerminalFocus(event.clientY)) {
      preventTerminalFocus(event);
    }
  };

  return (
    <div
      ref={paneRef}
      className={`terminal-pane ${showKeyBar ? "with-key-bar" : ""} ${!interactive ? "is-preview-inert" : ""} ${
        className ?? ""
      }`}
      onPasteCapture={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onKeyDownCapture={handleTerminalPromptKeyDownCapture}
    >
      <div
        ref={hostRef}
        className="term-host"
        onMouseDownCapture={handleTerminalMouseDownCapture}
      />
      <input
        ref={fileInputRef}
        className="terminal-file-input"
        type="file"
        multiple
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void handleFiles(files);
        }}
      />
      {contextCommandRefusal ? (
        <div className="upload-status error context-command-refusal" role="alert">
          <span>{contextCommandRefusal}</span>
          <button type="button" className="btn ghost" onMouseDown={preventKeyBarMouseFocus}
            onClick={clearContextDraft}>Clear draft</button>
        </div>
      ) : uploadStatus ? <div className={`upload-status ${uploadStatus.kind}`}>{uploadStatus.message}</div> : null}
      {status === "closed" ? (
        <button className="terminal-reconnect" onClick={() => setLocalReconnect((e) => e + 1)}>
          Reconnect
        </button>
      ) : null}
      {selectionHandles?.start.visible ? (
        <div
          className="term-sel-handle start"
          aria-hidden="true"
          style={{ left: `${selectionHandles.start.x}px`, top: `${selectionHandles.start.y}px` }}
          onTouchStart={beginSelectionHandleDrag("start")}
          onTouchMove={onSelectionHandleMove}
          onTouchEnd={endSelectionHandleDrag}
          onTouchCancel={endSelectionHandleDrag}
        />
      ) : null}
      {selectionHandles?.end.visible ? (
        <div
          className="term-sel-handle end"
          aria-hidden="true"
          style={{ left: `${selectionHandles.end.x}px`, top: `${selectionHandles.end.y}px` }}
          onTouchStart={beginSelectionHandleDrag("end")}
          onTouchMove={onSelectionHandleMove}
          onTouchEnd={endSelectionHandleDrag}
          onTouchCancel={endSelectionHandleDrag}
        />
      ) : null}
      {visibleTouchMenu ? (
        <div
          className="terminal-touch-menu"
          role="toolbar"
          aria-label="Terminal clipboard actions"
          style={{
            left: `${visibleTouchMenu.x}px`,
            top: `${visibleTouchMenu.y}px`,
            width: `${visibleTouchMenu.width}px`,
          }}
          onMouseDown={preventKeyBarMouseFocus}
        >
          <button className="control-menu"
            type="button"
            title={canCopyTerminalSelection ? "Copy selection" : "Copy the last terminal selection"}
            onClick={handleTouchMenuCopy}
          >
            Copy
          </button>
          <button className="control-menu" type="button" style={{ flex: "2 1 0", whiteSpace: "normal", lineHeight: 1.1 }} title="Copy the selected command or URL as one line" onClick={handleTouchMenuCopyOneLine}>
            Copy as one line
          </button>
          {visibleTouchMenu.linkUrl ? (
            <button className="control-menu" type="button" title={`Copy ${visibleTouchMenu.linkUrl}`} onClick={handleTouchMenuCopyLink}>
              Copy link
            </button>
          ) : null}
          {visibleTouchMenu.links.length > 0 ? (
            <button className="control-menu"
              type="button"
              title="Open a link printed since this terminal attached"
              onClick={() => {
                setTerminalLinkPicker(visibleTouchMenu.links);
                setTerminalTouchMenu(null);
              }}
            >
              Links
            </button>
          ) : null}
          <button className="control-menu" type="button" disabled={!canPasteTerminalClipboard} onClick={handleTouchMenuPaste}>
            Paste
          </button>
          {onRetitle ? (
            <button className="control-menu"
              type="button"
              title="Regenerate this session's title with the LLM"
              onClick={() => {
                onRetitle();
                setTerminalTouchMenu(null);
              }}
            >
              Retitle
            </button>
          ) : null}
          <button className="control-menu"
            type="button"
            onClick={() => {
              termRef.current?.clearSelection();
              setTerminalTouchMenu(null);
            }}
          >
            Done
          </button>
        </div>
      ) : null}
      {terminalLinkPicker ? (
        <div
          className="terminal-link-picker"
          role="dialog"
          aria-label="Links printed since this terminal attached"
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="terminal-link-picker-head">
            <span>Links</span>
            <button className="control-menu" type="button" onClick={() => setTerminalLinkPicker(null)}>
              Close
            </button>
          </div>
          <ul>
            {terminalLinkPicker.map((entry) => (
              <li key={entry.url}>
                {/* The row shows the target, but showing is not enough: the
                    output chooses both the target and the label beside it, and
                    can register targets it never painted. Confirm through the
                    same helper every other coarse-pointer path uses. */}
                <button className="control-menu"
                  type="button"
                  title={entry.url}
                  onClick={() => {
                    setTerminalLinkPicker(null);
                    if (confirmTerminalLinkOpen(entry.url)) {
                      void openExternalTerminalUrl(entry.url);
                    }
                  }}
                >
                  {entry.label ? <span className="terminal-link-picker-label">{entry.label}</span> : null}
                  <span className="terminal-link-picker-url">{entry.url}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {showKeyBar ? (
        <>
          {/* Fine-pointer (desktop) devices auto-hide the key bar and reveal it
              on hover of this bottom-edge hotzone; see the `(hover: hover) and
              (pointer: fine)` block in styles.css. On coarse-pointer devices the
              hotzone is display:none and the bar stays pinned as before. */}
          <div className="key-bar-hotzone" aria-hidden="true" onMouseDown={preventKeyBarMouseFocus} />
          {/* Both rows share one group so the desktop hover reveal moves them
              together; revealing only the primary row would strand an open
              overflow row off-screen. */}
          <div className="key-bar-group" onMouseLeave={() => setKeyBarOverflowOpen(false)}>
            {keyBarLayout.overflow.length > 0 ? (
              <nav
                className="key-bar key-bar-overflow"
                id={keyBarOverflowId}
                aria-label="Agent actions"
                hidden={!keyBarOverflowOpen}
              >
                {keyBarLayout.overflow.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="control-key key command-key"
                    aria-label={entry.kind === "sequence" ? entry.ariaLabel : undefined}
                    onMouseDown={preventKeyBarMouseFocus}
                    onClick={() => {
                      if (entry.kind === "text") {
                        sendTerminalText(entry.text);
                      } else if (entry.kind === "sequence") {
                        sendTerminalSequence(entry.sequence);
                      }
                      setKeyBarOverflowOpen(false);
                    }}
                  >
                    {entry.label}
                  </button>
                ))}
              </nav>
            ) : null}
            <nav className="key-bar" aria-label="Special keys">
              {sessionIncarnation ? <SpeechComposer machine={machine} id={id} sessionIncarnation={sessionIncarnation} onBeforeOpen={blurTerminal} /> : null}
              {agent !== "shell" ? <button
                type="button"
                className="control-key key upload-key"
                onMouseDown={preventKeyBarMouseFocus}
                onClick={() => {
                  // The upload toast is positioned for a single-row bar, so the
                  // overflow row must be gone before an upload can raise one.
                  setKeyBarOverflowOpen(false);
                  // The Android file chooser is a separate Activity that tears
                  // down the IME input connection. Close any composition and drop
                  // focus deterministically here instead of leaving it to the
                  // visual-viewport dismissal heuristic, which can fire mid-
                  // composition (or not at all) while the WebView is backgrounded.
                  blurTerminal();
                  fileInputRef.current?.click();
                }}
              >
                Upload
              </button> : null}
              {keyBarLayout.primary.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="control-key key"
                  onMouseDown={preventKeyBarMouseFocus}
                  onClick={() => {
                    if (entry.kind !== "key") return;
                    sendKey(entry.key);
                  }}
                >
                  {entry.label}
                </button>
              ))}
              {keyBarLayout.overflow.length > 0 ? (
                <button
                  type="button"
                  className="control-key key key-bar-more"
                  aria-expanded={keyBarOverflowOpen}
                  aria-controls={keyBarOverflowId}
                  aria-label={keyBarOverflowOpen ? "Hide agent actions" : "Show agent actions"}
                  onMouseDown={preventKeyBarMouseFocus}
                  onClick={() => setKeyBarOverflowOpen((open) => !open)}
                >
                  …
                </button>
              ) : null}
            </nav>
          </div>
        </>
      ) : null}
    </div>
  );
}
