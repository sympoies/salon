import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type IBufferRange } from "@xterm/xterm";
import { attachTarget, shellAttachTarget, fetchSessionBuffer, sendSessionInput } from "./api.ts";
import { recordDebugEvent } from "./debugLog.ts";
import { createWindowScheduler } from "./scheduler.ts";
import { installTheme } from "./theme.ts";
import { terminalAppearanceFor } from "./terminalTheme.ts";
import { createTerminalOutputBatcher } from "./terminalOutputBatcher.ts";
import {
  recordTerminalPerformanceFrame,
  recordTerminalPerformanceWrite,
  registerTerminalPerformancePane,
} from "./terminalPerformance.ts";
import { createTerminalProtocolGuard } from "./terminalProtocol.ts";
import { terminalRenderBatchDelayMs, type TerminalRenderMode } from "./terminalRenderMode.ts";
import {
  BASE_TERMINAL_FONT_SIZE,
  fitReadableTerminal,
  isFittableTerminalHost,
  shouldRecomputeTerminalColumns,
} from "./terminalFit.ts";
import {
  createTerminalBottomPin,
  createTerminalBottomPinTarget,
  nextBottomPinIntent,
  shouldAutoPinBottom,
} from "./terminalBottomPin.ts";
import {
  createTerminalCompositionGuard,
  type TerminalCompositionGuard,
} from "./terminalComposition.ts";
import { shouldGateTerminalFocus } from "./terminalFocus.ts";
import { createTerminalLayoutSync, shouldRequestFirstPayloadSync } from "./terminalLayoutSync.ts";
import {
  confirmTerminalLinkOpen,
  createOsc8LinkHandler,
  createTerminalLinkActivationGuard,
  createTerminalLinkHoverTarget,
  createTerminalLinkProvider,
  openExternalTerminalUrl,
  resolveTerminalUrlAtBufferCell,
  validateTerminalUrl,
} from "./terminalLinks.ts";
import {
  createTerminalBufferWarmOnMouseDrag,
  createTerminalSyntheticMouseSuppressor,
  isTouchOriginContextMenu,
  markSyntheticLinkMouseEvent,
  touchContextMenuCandidateUntil,
} from "./terminalMouse.ts";
import { hasAnyCoarsePointer, hasCoarsePrimaryPointer } from "./terminalPointer.ts";
import {
  LONG_PRESS_MS,
  TERMINAL_TOUCH_MENU_LINK_WIDTH_PX,
  TERMINAL_TOUCH_MENU_LINKS_BUTTON_PX,
  TERMINAL_TOUCH_MENU_WIDTH_PX,
  TERMINAL_TOUCH_MENU_ONE_LINE_BUTTON_PX,
  TOUCH_WHEEL_STEP_PX,
  createTerminalTouchBridge,
  mouseWheelForwardedNotchLines,
  selectionHandlePoints,
  selectionRangeFromWordDrag,
  terminalCellFromPoint,
  terminalTouchMenuPosition,
  terminalTouchMenuHeight,
  wordCellRange,
  type SelectionEndpoints,
  type TerminalCell,
  type TerminalSessionSwipeDirection,
  type TerminalTouchWheel,
} from "./terminalTouch.ts";
import {
  backgroundReconnectOffsetMs,
  createTerminalTransportController,
  type ProviderPromptCapabilityMode,
  type TerminalInputRejection,
  type TerminalTransportController,
  type TerminalTransportStatus,
} from "./terminalTransport.ts";
import type { ProviderPromptSubmittedFrame, SpecialKey } from "./frames.ts";
import { classifyTerminalData } from "./terminalInput.ts";
import { createTerminalLinkRegistry, type TerminalLinkEntry } from "./terminalLinkRegistry.ts";
import { readTerminalSelection, resolveTerminalCopyText } from "./terminalClipboard.ts";

export type TerminalConnectionStatus = TerminalTransportStatus;

export type TerminalTouchMenu = {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  // Rendered toolbar width. Computed once where the menu state is created so
  // the clamp math and the rendered CSS width can never drift apart.
  readonly width: number;
  readonly hasSelection: boolean;
  // Implicit URL under the long-press/right-click point, if any. Resolving is
  // read-only, so it works even while the attached TUI owns mouse tracking and
  // click-to-open is disabled — copying a link never reaches the app.
  readonly linkUrl: string | null;
  // OSC 8 targets harvested from the output stream since this terminal
  // attached, newest first. The picker exists because a link's target is
  // reachable even when its label is not: a few cells wide, hard-wrapped by the
  // inner TUI, or not a URL at all. Snapshotted when the menu opens so the list
  // cannot shift under a tap.
  readonly links: readonly TerminalLinkEntry[];
  readonly revision: number;
} | null;

type MutableRef<T> = { current: T };
type StateSetter<T> = (value: T | ((current: T) => T)) => void;

interface CapturedTerminalSelection {
  readonly text: string;
  readonly at: number;
}

interface TerminalInstanceDeps {
  readonly machine: string;
  readonly id: string;
  readonly agent?: string;
  readonly scrollback: number;
  readonly terminalInstanceKey: string;
  readonly paneRef: MutableRef<HTMLDivElement | null>;
  readonly hostRef: MutableRef<HTMLDivElement | null>;
  readonly termRef: MutableRef<Terminal | null>;
  readonly transportRef: MutableRef<TerminalTransportController | null>;
  readonly mountedRef: MutableRef<boolean>;
  readonly terminalPasteInputRef: MutableRef<boolean>;
  readonly compositionGuardRef: MutableRef<TerminalCompositionGuard | null>;
  readonly capturedSelectionRef: MutableRef<CapturedTerminalSelection>;
  readonly terminalBufferRef: MutableRef<string>;
  readonly consumeTerminalBufferRef: MutableRef<(() => void) | null>;
  readonly showTouchMenuAtRef: MutableRef<((clientX: number, clientY: number) => void) | null>;
  readonly flushTerminalOutputRef: MutableRef<(() => void) | null>;
  readonly requestTerminalLayoutSyncRef: MutableRef<(() => void) | null>;
  readonly syncSelectionHandlesRef: MutableRef<(() => void) | null>;
  readonly fontSizeRef: MutableRef<number>;
  readonly readableFitRef: MutableRef<boolean>;
  readonly autoFocusRef: MutableRef<boolean>;
  readonly focusRequestTokenRef: MutableRef<number>;
  readonly handledFocusRequestTokenRef: MutableRef<number>;
  readonly realtimeOutputRef: MutableRef<boolean>;
  readonly renderModeRef: MutableRef<TerminalRenderMode>;
  readonly onTurnOutputRef: MutableRef<(() => void) | undefined>;
  readonly onSessionSwipeRef: MutableRef<((direction: TerminalSessionSwipeDirection) => void) | undefined>;
  readonly onPromptFocusRef: MutableRef<(() => void) | undefined>;
  readonly onProviderPromptCapability: (capability: ProviderPromptCapabilityMode) => void;
  readonly onProviderPromptEvent: (event: ProviderPromptSubmittedFrame) => void;
  readonly onInputRejected: (rejection: TerminalInputRejection) => void;
  readonly sendTextFrame: (text: string) => void;
  readonly sendKeyFrame: (key: SpecialKey) => void;
  readonly setStatus: (status: TerminalConnectionStatus) => void;
  readonly setTerminalTouchMenu: StateSetter<TerminalTouchMenu>;
  readonly setSelectionHandles: StateSetter<SelectionEndpoints | null>;
}

const MONO_FONT =
  '"BlexMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

const SCROLLBAR_VISIBLE_MS = 3000;

// Normal-buffer touch scrollback and mouse-tracking TUIs both render whole rows.
// Move the rendered layer by finger pixels between row changes, then absorb each
// row in the new render so touch motion remains continuous.
const TOUCH_SCROLL_GAIN = 1.8;
const SMOOTH_SCROLL_DURATION_MS = 120;
const TUI_TOUCH_SETTLE_DELAY_MS = 120;
const TUI_TOUCH_SETTLE_TRANSITION_MS = 90;
const TUI_TOUCH_MAX_VISUAL_ROWS = 2;
const TUI_TOUCH_ROW_MATCH_SAMPLE_LIMIT = 8;

function renderedRowsMatchWheelShift(
  before: readonly string[],
  readAfter: (row: number) => string,
  afterRowCount: number,
  deltaRows: number,
  dirtyStart: number,
  dirtyEnd: number,
): boolean {
  const shift = Math.abs(Math.trunc(deltaRows));
  const rowCount = Math.min(before.length, afterRowCount);
  if (shift === 0 || shift >= rowCount) {
    return false;
  }
  // A TUI can scroll only its transcript while keeping a prompt/footer fixed.
  // Compare cells inside the rendered region; fixed rows outside it are not
  // evidence for or against the shift.
  const afterStart = Math.max(0, dirtyStart + (deltaRows < 0 ? shift : 0));
  const afterEnd = Math.min(rowCount - 1, dirtyEnd - (deltaRows > 0 ? shift : 0));
  const overlap = afterEnd - afterStart + 1;
  if (overlap < 2) {
    return false;
  }
  const sampleCount = Math.min(TUI_TOUCH_ROW_MATCH_SAMPLE_LIMIT, overlap);
  let shiftedComparable = 0;
  let shiftedMatches = 0;
  let unchangedComparable = 0;
  let unchangedMatches = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const overlapIndex = sampleCount === 1 ? 0 : Math.round((index * (overlap - 1)) / (sampleCount - 1));
    const afterIndex = afterStart + overlapIndex;
    const beforeRow = before[afterIndex + (deltaRows > 0 ? shift : -shift)] ?? "";
    const afterRow = readAfter(afterIndex);
    if (beforeRow.length === 0 && afterRow.length === 0) {
      // Blank rows carry no evidence that a semantic shift was applied.
    } else {
      shiftedComparable += 1;
      if (beforeRow === afterRow) {
        shiftedMatches += 1;
      }
    }
    const unchangedRow = before[afterIndex] ?? "";
    if (unchangedRow.length !== 0 || afterRow.length !== 0) {
      unchangedComparable += 1;
      if (unchangedRow === afterRow) {
        unchangedMatches += 1;
      }
    }
  }
  const shiftedRatio = shiftedComparable === 0 ? 0 : shiftedMatches / shiftedComparable;
  const unchangedRatio = unchangedComparable === 0 ? 0 : unchangedMatches / unchangedComparable;
  return shiftedComparable >= 2 && shiftedRatio >= 0.7 && shiftedRatio > unchangedRatio;
}

export function createTerminalInstance(hostEl: HTMLDivElement, deps: TerminalInstanceDeps): () => void {
  let disposed = false;
  let teardown: (() => void) | undefined;

  const start = () => {
    if (disposed || deps.hostRef.current !== hostEl) {
      return;
    }
    const themeController = installTheme();
    const initialAppearance = terminalAppearanceFor(themeController.getState().resolved);
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "underline",
      cursorInactiveStyle: "underline",
      fontFamily: MONO_FONT,
      fontSize: deps.fontSizeRef.current,
      scrollback: deps.scrollback,
      smoothScrollDuration: SMOOTH_SCROLL_DURATION_MS,
      theme: initialAppearance.theme,
      minimumContrastRatio: initialAppearance.minimumContrastRatio,
      // Let Option-drag force a text selection even when the attached TUI has
      // mouse reporting on. Plain drag still reaches the app for its own UI.
      macOptionClickForcesSelection: true,
    });
    term.parser.registerCsiHandler({ intermediates: " ", final: "q" }, () => true);
    // The open terminal repaints in the new palette when the theme changes.
    const themeSub = themeController.subscribe(() => {
      const appearance = terminalAppearanceFor(themeController.getState().resolved);
      term.options.theme = appearance.theme;
      term.options.minimumContrastRatio = appearance.minimumContrastRatio;
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostEl);
    const linkHoverTarget = createTerminalLinkHoverTarget(hostEl);
    // xterm's own link resolution (OSC 8 and the implicit provider) discloses
    // the exact resolved URL through the hover target. Cache it with its link
    // range so the toolbar can copy the full target of a hyperlink whose
    // visible label is hard-wrapped — text scanning alone can only ever see
    // the label fragment. The range scopes the disclosure to the hovered link:
    // a resting mouse hover must never donate its URL to a long-press at an
    // unrelated point.
    let disclosedLink: { readonly url: string; readonly range: IBufferRange } | null = null;
    const disclosingLinkHoverTarget: typeof linkHoverTarget = {
      hover(event, text, range) {
        const url = validateTerminalUrl(text);
        disclosedLink = url && range ? { url, range } : null;
        linkHoverTarget.hover(event, text);
      },
      leave() {
        disclosedLink = null;
        linkHoverTarget.leave();
      },
      dispose() {
        disclosedLink = null;
        linkHoverTarget.dispose();
      },
    };
    const linkActivationGuard = createTerminalLinkActivationGuard();
    const canResolveTerminalLink = () => term.modes.mouseTrackingMode === "none";

    const canActivateTerminalLink = (event: MouseEvent) =>
      canResolveTerminalLink() && linkActivationGuard.canActivate(event);
    let touchLinkActivationInProgress = false;
    let touchLinkActivationHandled = false;
    const markTouchLinkActivationHandled = () => {
      if (touchLinkActivationInProgress) {
        touchLinkActivationHandled = true;
      }
    };
    const openXtermTerminalUrl = (url: string) => {
      markTouchLinkActivationHandled();
      return openExternalTerminalUrl(url);
    };
    // Both link kinds share one disclosure rule. An implicit link needs it just
    // as much as an OSC 8 one: the provider joins a URL across wrapped rows, so
    // a tap can open a target whose tail was never on screen.
    const linkOpenNeedsDisclosure = (event: MouseEvent) =>
      Boolean((event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) ||
      hasAnyCoarsePointer();
    const linkProvider = createTerminalLinkProvider(term, {
      canActivate: canActivateTerminalLink,
      hoverTarget: disclosingLinkHoverTarget,
      openUrl: openXtermTerminalUrl,
      onActivationAttempt: markTouchLinkActivationHandled,
      requiresConfirmation: linkOpenNeedsDisclosure,
      confirmUrl: (url) => confirmTerminalLinkOpen(url),
    });
    const linkProviderSub = term.registerLinkProvider(linkProvider);
    term.options.linkHandler = createOsc8LinkHandler({
      canActivate: canActivateTerminalLink,
      hoverTarget: disclosingLinkHoverTarget,
      openUrl: openXtermTerminalUrl,
      onActivationAttempt: markTouchLinkActivationHandled,
      requiresConfirmation: linkOpenNeedsDisclosure,
      confirmUrl: (url) => confirmTerminalLinkOpen(url),
    });
    deps.termRef.current = term;
    const helperTextarea = term.element?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    const compositionGuard = createTerminalCompositionGuard(helperTextarea);
    deps.compositionGuardRef.current = compositionGuard;
    const onPromptFocus = () => {
      // An Android Activity switch (the upload file chooser) can tear down the
      // IME input connection without delivering the matching compositionend,
      // which would leave xterm's CompositionHelper swallowing every later
      // keyCode-229 character. Regaining focus is our chance to clear it.
      compositionGuard.finalize();
      deps.onPromptFocusRef.current?.();
    };
    helperTextarea?.addEventListener("focus", onPromptFocus);
    helperTextarea?.setAttribute("autocomplete", "off");
    helperTextarea?.setAttribute("autocorrect", "off");
    helperTextarea?.setAttribute("autocapitalize", "none");
    helperTextarea?.setAttribute("spellcheck", "false");
    const viewport = term.element?.querySelector<HTMLElement>(".xterm-viewport");
    const wheelTarget = term.element?.querySelector<HTMLElement>(".xterm-screen") ?? term.element ?? hostEl;
    let scrollbarTimer: number | undefined;
    // DSH sessions pin the last content row rather than xterm's baseY; see
    // TerminalBottomPinTarget.
    const bottomPinTarget = createTerminalBottomPinTarget(term, deps.agent);
    let keepBottomPinned = true;
    let forceNextBottomPin = true;
    let lastCols: number | null = null;
    let lastColsWidth = 0;
    let forceNextColumnRefit = true;
    const firstPayloadSync = { pending: true };
    const hideTerminalScrollbar = () => {
      deps.paneRef.current?.classList.remove("is-scrolling");
      scrollbarTimer = undefined;
    };
    const showTerminalScrollbar = () => {
      deps.paneRef.current?.classList.add("is-scrolling");
      if (scrollbarTimer !== undefined) {
        window.clearTimeout(scrollbarTimer);
      }
      scrollbarTimer = window.setTimeout(hideTerminalScrollbar, SCROLLBAR_VISIBLE_MS);
    };
    // The single owner of the bottom-tracking intent. Every viewport observation
    // — xterm's own onScroll and the .xterm-viewport scrollbar — routes here.
    const updateBottomPinIntentFromBuffer = () => {
      keepBottomPinned = nextBottomPinIntent({
        hasSelection: term.hasSelection(),
        isAtBottom: bottomPinTarget.isAtBottom(),
        keepPinned: keepBottomPinned,
      });
    };
    const fitTerminal = (forceColumns: boolean): boolean => {
      const host = deps.hostRef.current;
      let hostWidth = 0;
      if (host) {
        const rect = host.getBoundingClientRect();
        if (!isFittableTerminalHost({ width: rect.width, height: rect.height })) {
          return false;
        }
        hostWidth = rect.width;
      }
      const recomputeColumns = shouldRecomputeTerminalColumns(
        lastCols === null ? null : lastColsWidth,
        hostWidth,
        forceColumns,
      );
      if (recomputeColumns && deps.readableFitRef.current) {
        fitReadableTerminal(term, fit);
      } else {
        if (!deps.readableFitRef.current) {
          term.options.fontSize = deps.fontSizeRef.current;
        }
        fit.fit();
      }
      if (recomputeColumns) {
        lastCols = term.cols;
        lastColsWidth = hostWidth;
      } else if (lastCols !== null && term.cols !== lastCols) {
        term.resize(lastCols, term.rows);
      }
      term.refresh(0, Math.max(0, term.rows - 1));
      return true;
    };
    const scheduler = createWindowScheduler(window);
    const touchScrollScreen = term.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
    let tuiTouchLayers: HTMLElement[] = [];
    let tuiTouchCellHeightPx = TOUCH_WHEEL_STEP_PX;
    const refreshTuiTouchGeometry = () => {
      tuiTouchLayers = touchScrollScreen
        ? Array.from(touchScrollScreen.querySelectorAll<HTMLElement>(".xterm-rows, .xterm-selection"))
        : [];
      if (!touchScrollScreen || term.rows <= 0) {
        tuiTouchCellHeightPx = TOUCH_WHEEL_STEP_PX;
        return;
      }
      const height = touchScrollScreen.getBoundingClientRect().height / term.rows;
      tuiTouchCellHeightPx = height > 0 ? height : TOUCH_WHEEL_STEP_PX;
    };
    const currentTuiTouchLayers = (): readonly HTMLElement[] => {
      if (tuiTouchLayers.length === 0 || tuiTouchLayers.some((layer) => !layer.isConnected)) {
        refreshTuiTouchGeometry();
      }
      return tuiTouchLayers;
    };
    const terminalCellHeightPx = (): number => tuiTouchCellHeightPx;
    const captureTuiVisibleRows = (): string[] => {
      const buffer = term.buffer.active;
      const rows: string[] = [];
      for (let index = 0; index < term.rows; index += 1) {
        rows.push(buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "");
      }
      return rows;
    };
    let tuiTouchVisualActive = false;
    let tuiTouchGestureActive = false;
    let tuiTouchVisualOffsetPx = 0;
    let tuiTouchPendingRows = 0;
    let tuiTouchRowsBeforeWheel: string[] | null = null;
    let tuiTouchBlockedDirection = 0;
    let tuiTouchRowsAtBoundary: string[] | null = null;
    let tuiTouchBlockedWheelRows = 0;
    let tuiTouchWheelAckTimer: number | undefined;
    let tuiTouchSettleTimer: number | undefined;
    let tuiTouchCleanupTimer: number | undefined;
    let scrollbackTouchVisualActive = false;
    let scrollbackTouchVisualOffsetPx = 0;
    let scrollbackTouchPendingRows = 0;
    let scrollAccumLines = 0;
    let scrollbackTouchSmoothDuration: number | undefined;
    let scrollbackTouchSettleTimer: number | undefined;
    let scrollbackTouchSettling = false;
    const clearTuiTouchTimers = () => {
      if (tuiTouchWheelAckTimer !== undefined) {
        scheduler.clearTimeout(tuiTouchWheelAckTimer);
        tuiTouchWheelAckTimer = undefined;
      }
      if (tuiTouchSettleTimer !== undefined) {
        scheduler.clearTimeout(tuiTouchSettleTimer);
        tuiTouchSettleTimer = undefined;
      }
      if (tuiTouchCleanupTimer !== undefined) {
        scheduler.clearTimeout(tuiTouchCleanupTimer);
        tuiTouchCleanupTimer = undefined;
      }
    };
    const clearTuiTouchLayerStyles = () => {
      for (const layer of currentTuiTouchLayers()) {
        layer.style.removeProperty("transform");
        layer.style.removeProperty("transition");
        layer.style.removeProperty("will-change");
      }
    };
    const applyTuiTouchVisualOffset = (): boolean => {
      const layers = currentTuiTouchLayers();
      if (layers.length === 0) {
        return false;
      }
      const maxOffsetPx = terminalCellHeightPx() * TUI_TOUCH_MAX_VISUAL_ROWS;
      const renderedOffsetPx = Math.max(-maxOffsetPx, Math.min(maxOffsetPx, tuiTouchVisualOffsetPx));
      for (const layer of layers) {
        layer.style.transform = `translate3d(0, ${renderedOffsetPx}px, 0)`;
      }
      return true;
    };
    const blockUnacknowledgedTuiWheel = () => {
      if (tuiTouchPendingRows !== 0 && tuiTouchRowsBeforeWheel) {
        tuiTouchBlockedDirection = Math.sign(tuiTouchPendingRows);
        tuiTouchRowsAtBoundary = tuiTouchRowsBeforeWheel;
        tuiTouchBlockedWheelRows = tuiTouchPendingRows;
      }
    };
    const settleTuiTouchVisual = (immediate = false) => {
      clearTuiTouchTimers();
      // An unacknowledged wheel at a TUI's edge would otherwise preview the
      // same empty space on every subsequent drag or momentum tick.
      if (!immediate) {
        blockUnacknowledgedTuiWheel();
      }
      tuiTouchVisualActive = false;
      tuiTouchVisualOffsetPx = 0;
      tuiTouchPendingRows = 0;
      tuiTouchRowsBeforeWheel = null;
      if (immediate) {
        clearTuiTouchLayerStyles();
        return;
      }
      const layers = currentTuiTouchLayers();
      for (const layer of layers) {
        layer.style.transition = `transform ${TUI_TOUCH_SETTLE_TRANSITION_MS}ms ease-out`;
        layer.style.transform = "translate3d(0, 0px, 0)";
      }
      tuiTouchCleanupTimer = scheduler.setTimeout(() => {
        tuiTouchCleanupTimer = undefined;
        clearTuiTouchLayerStyles();
      }, TUI_TOUCH_SETTLE_TRANSITION_MS);
    };
    const scheduleTuiTouchSettle = () => {
      if (tuiTouchSettleTimer !== undefined) {
        scheduler.clearTimeout(tuiTouchSettleTimer);
      }
      tuiTouchSettleTimer = scheduler.setTimeout(() => {
        tuiTouchSettleTimer = undefined;
        settleTuiTouchVisual();
      }, TUI_TOUCH_SETTLE_DELAY_MS);
    };
    const previewTuiTouchPixels = (dyPixels: number): boolean => {
      if (term.modes.mouseTrackingMode === "none" && term.buffer.active.type === "normal") {
        if (tuiTouchVisualActive) {
          settleTuiTouchVisual(true);
        }
        return false;
      }
      const direction = Math.sign(-dyPixels);
      if (direction !== 0 && tuiTouchBlockedDirection !== 0) {
        if (direction === tuiTouchBlockedDirection) {
          return false;
        }
        tuiTouchBlockedDirection = 0;
        tuiTouchRowsAtBoundary = null;
        tuiTouchBlockedWheelRows = 0;
      }
      if (tuiTouchCleanupTimer !== undefined) {
        scheduler.clearTimeout(tuiTouchCleanupTimer);
        tuiTouchCleanupTimer = undefined;
      }
      const activating = !tuiTouchVisualActive;
      tuiTouchVisualActive = true;
      if (activating) {
        const layers = currentTuiTouchLayers();
        if (layers.length === 0) {
          settleTuiTouchVisual(true);
          return false;
        }
        for (const layer of layers) {
          layer.style.transition = "none";
          layer.style.willChange = "transform";
        }
      }
      tuiTouchVisualOffsetPx += dyPixels;
      if (!applyTuiTouchVisualOffset()) {
        settleTuiTouchVisual(true);
        return false;
      }
      if (!tuiTouchGestureActive) {
        scheduleTuiTouchSettle();
      }
      return true;
    };
    const recordTuiTouchWheel = (deltaY: number) => {
      if (!tuiTouchVisualActive && tuiTouchBlockedDirection === Math.sign(deltaY)) {
        tuiTouchBlockedWheelRows += deltaY;
      }
      if (tuiTouchVisualActive) {
        if (tuiTouchPendingRows === 0) {
          tuiTouchRowsBeforeWheel = captureTuiVisibleRows();
          // Momentum keeps producing pixels, so an inactivity settle alone
          // cannot detect a TUI that has stopped moving at its boundary.
          tuiTouchWheelAckTimer = scheduler.setTimeout(() => {
            tuiTouchWheelAckTimer = undefined;
            if (tuiTouchVisualActive && tuiTouchPendingRows !== 0) {
              settleTuiTouchVisual();
            }
          }, TUI_TOUCH_SETTLE_DELAY_MS);
        }
        tuiTouchPendingRows += deltaY;
        if (tuiTouchPendingRows === 0) {
          tuiTouchRowsBeforeWheel = null;
          if (tuiTouchWheelAckTimer !== undefined) {
            scheduler.clearTimeout(tuiTouchWheelAckTimer);
            tuiTouchWheelAckTimer = undefined;
          }
        }
      }
    };
    const reconcileTuiTouchVisual = (dirtyStart: number, dirtyEnd: number) => {
      if (
        tuiTouchBlockedDirection !== 0 &&
        tuiTouchRowsAtBoundary &&
        dirtyEnd - dirtyStart + 1 >= Math.max(6, Math.ceil(term.rows / 3))
      ) {
        const buffer = term.buffer.active;
        const boundaryRows = tuiTouchRowsAtBoundary;
        const renderedRows = new Map<number, string>();
        const readRenderedRow = (row: number) => {
          let value = renderedRows.get(row);
          if (value === undefined) {
            value = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "";
            renderedRows.set(row, value);
          }
          return value;
        };
        const maxShift = Math.min(Math.abs(tuiTouchBlockedWheelRows), term.rows - 1);
        for (let shift = maxShift; shift > 0; shift -= 1) {
          if (renderedRowsMatchWheelShift(
            boundaryRows,
            readRenderedRow,
            term.rows,
            tuiTouchBlockedDirection * shift,
            dirtyStart,
            dirtyEnd,
          )) {
            tuiTouchBlockedDirection = 0;
            tuiTouchRowsAtBoundary = null;
            tuiTouchBlockedWheelRows = 0;
            break;
          }
        }
        if (tuiTouchBlockedDirection !== 0) {
          const sampleCount = Math.min(TUI_TOUCH_ROW_MATCH_SAMPLE_LIMIT, dirtyEnd - dirtyStart + 1);
          let changedSamples = 0;
          for (let index = 0; index < sampleCount; index += 1) {
            const row = dirtyStart + Math.round((index * (dirtyEnd - dirtyStart)) / (sampleCount - 1));
            if (boundaryRows[row] !== readRenderedRow(row)) {
              changedSamples += 1;
            }
          }
          if (changedSamples >= Math.ceil(sampleCount * 0.75)) {
            // A TUI can replace its transcript without leaving mouse mode.
            // Keep the edge lock but compare future wheels with the new screen.
            tuiTouchRowsAtBoundary = Array.from({ length: term.rows }, (_, row) => readRenderedRow(row));
            tuiTouchBlockedWheelRows = 0;
          }
        }
      }
      if (!tuiTouchVisualActive || tuiTouchPendingRows === 0 || !tuiTouchRowsBeforeWheel) {
        return;
      }
      if (dirtyEnd - dirtyStart + 1 < Math.max(6, Math.ceil(term.rows / 3))) {
        return;
      }
      const buffer = term.buffer.active;
      if (
        !renderedRowsMatchWheelShift(
          tuiTouchRowsBeforeWheel,
          (row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
          term.rows,
          tuiTouchPendingRows,
          dirtyStart,
          dirtyEnd,
        )
      ) {
        return;
      }
      tuiTouchVisualOffsetPx += tuiTouchPendingRows * terminalCellHeightPx();
      tuiTouchPendingRows = 0;
      tuiTouchRowsBeforeWheel = null;
      if (tuiTouchWheelAckTimer !== undefined) {
        scheduler.clearTimeout(tuiTouchWheelAckTimer);
        tuiTouchWheelAckTimer = undefined;
      }
      applyTuiTouchVisualOffset();
    };
    const applyScrollbackTouchVisualOffset = () => {
      const maxOffsetPx = terminalCellHeightPx() * TUI_TOUCH_MAX_VISUAL_ROWS;
      const renderedOffsetPx = Math.max(-maxOffsetPx, Math.min(maxOffsetPx, scrollbackTouchVisualOffsetPx));
      for (const layer of currentTuiTouchLayers()) {
        layer.style.transform = `translate3d(0, ${renderedOffsetPx}px, 0)`;
      }
    };
    const settleScrollbackTouchVisual = (immediate = false) => {
      if (scrollbackTouchSettleTimer !== undefined) {
        scheduler.clearTimeout(scrollbackTouchSettleTimer);
        scrollbackTouchSettleTimer = undefined;
      }
      // Attach output may change scroll ownership after the last touchmove.
      if (!immediate && term.modes.mouseTrackingMode === "none" && term.buffer.active.type === "normal") {
        if (scrollbackTouchSettling) {
          return;
        }
        // Discarding the fractional row would move the rendered layer back
        // against the swipe. Finish that row in the scroll direction instead.
        // Keep the old layer compensation until xterm paints all pending rows.
        scrollbackTouchSettling = true;
        const finalRows = Math.sign(scrollAccumLines);
        scrollAccumLines = 0;
        if (finalRows !== 0) {
          const previousViewportY = term.buffer.active.viewportY;
          term.scrollLines(finalRows);
          scrollbackTouchPendingRows += term.buffer.active.viewportY - previousViewportY;
        }
        if (scrollbackTouchPendingRows !== 0) {
          term.refresh(0, term.rows - 1);
          return;
        }
      }
      scrollbackTouchSettling = false;
      scrollbackTouchVisualActive = false;
      scrollbackTouchVisualOffsetPx = 0;
      scrollbackTouchPendingRows = 0;
      scrollAccumLines = 0;
      if (scrollbackTouchSmoothDuration !== undefined) {
        if (term.options.smoothScrollDuration !== scrollbackTouchSmoothDuration) {
          term.options.smoothScrollDuration = scrollbackTouchSmoothDuration;
        }
        scrollbackTouchSmoothDuration = undefined;
      }
      clearTuiTouchLayerStyles();
    };
    const scheduleScrollbackTouchSettle = () => {
      if (scrollbackTouchSettleTimer !== undefined) {
        scheduler.clearTimeout(scrollbackTouchSettleTimer);
      }
      scrollbackTouchSettleTimer = scheduler.setTimeout(() => {
        scrollbackTouchSettleTimer = undefined;
        settleScrollbackTouchVisual();
      }, TUI_TOUCH_SETTLE_DELAY_MS);
    };
    const reconcileScrollbackTouchVisual = (dirtyStart: number, dirtyEnd: number) => {
      if (
        !scrollbackTouchVisualActive ||
        scrollbackTouchPendingRows === 0 ||
        dirtyStart > 0 ||
        dirtyEnd < term.rows - 1
      ) {
        return;
      }
      if (scrollbackTouchSettling) {
        // The row paint and compensation removal happen in the same render.
        // The remaining displacement is forward and smaller than one cell.
        settleScrollbackTouchVisual(true);
        return;
      }
      scrollbackTouchVisualOffsetPx += scrollbackTouchPendingRows * terminalCellHeightPx();
      scrollbackTouchPendingRows = 0;
      applyScrollbackTouchVisualOffset();
    };
    const bottomPin = createTerminalBottomPin(bottomPinTarget, scheduler);
    try {
      fitTerminal(true);
    } catch {
      /* container not measured yet */
    }
    if (deps.autoFocusRef.current && !shouldGateTerminalFocus(hasCoarsePrimaryPointer())) {
      term.focus();
    }
    if (
      deps.focusRequestTokenRef.current !== 0 &&
      deps.handledFocusRequestTokenRef.current !== deps.focusRequestTokenRef.current
    ) {
      deps.handledFocusRequestTokenRef.current = deps.focusRequestTokenRef.current;
      term.focus();
    }

    deps.setStatus("connecting");
    let transport: TerminalTransportController | null = null;

    const syncTerminalLayout = () => {
      const forceExactBottom = forceNextBottomPin;
      const shouldPinAfterFit = shouldAutoPinBottom({
        forced: forceExactBottom,
        keepPinned: keepBottomPinned,
        atBottom: bottomPinTarget.isAtBottom(),
        hasSelection: term.hasSelection(),
      });
      const forceColumns = forceNextColumnRefit;
      try {
        fitTerminal(forceColumns);
      } catch {
        return;
      }
      forceNextBottomPin = false;
      forceNextColumnRefit = false;
      if (shouldPinAfterFit) {
        bottomPin.request({ forceExact: forceExactBottom });
      }
      transport?.sendResize(term.cols, term.rows);
      deps.syncSelectionHandlesRef.current?.();
    };
    const layoutSync = createTerminalLayoutSync(scheduler, syncTerminalLayout);
    const requestTerminalLayoutSync = layoutSync.request;
    const forceTerminalLayoutSync = () => {
      forceNextBottomPin = true;
      forceNextColumnRefit = true;
      requestTerminalLayoutSync();
    };
    deps.requestTerminalLayoutSyncRef.current = forceTerminalLayoutSync;

    // OSC 8 targets are harvested from the stream, not the buffer: xterm's
    // public API exposes no hyperlink accessor on a cell, and the stream is the
    // only place the URI appears whole regardless of how its label wrapped.
    const linkRegistry = createTerminalLinkRegistry();
    const linkStreamDecoder = new TextDecoder();
    const writeTerminalData = (data: string | Uint8Array) => {
      // `stream: true` so a multi-byte character split across writes cannot
      // corrupt the scan (or the URI inside a sequence).
      linkRegistry.ingest(
        typeof data === "string" ? data : linkStreamDecoder.decode(data, { stream: true }),
      );
      const forceAfterWrite = shouldRequestFirstPayloadSync(firstPayloadSync, true);
      const forceExactBottom = forceAfterWrite || forceNextBottomPin;
      const shouldPinAfterWrite = shouldAutoPinBottom({
        forced: forceExactBottom,
        keepPinned: keepBottomPinned,
        atBottom: bottomPinTarget.isAtBottom(),
        hasSelection: term.hasSelection(),
      });
      term.write(data, () => {
        if (disposed) {
          return;
        }
        if (forceAfterWrite) {
          forceTerminalLayoutSync();
        }
        if (shouldPinAfterWrite) {
          bottomPin.request({ forceExact: forceExactBottom });
        }
      });
    };

    const unregisterPerformancePane = registerTerminalPerformancePane();
    const protocolGuard = createTerminalProtocolGuard();
    const shouldBatchTerminalOutput = () => (
      terminalRenderBatchDelayMs(deps.renderModeRef.current) !== null && !deps.realtimeOutputRef.current
    );
    const outputBatcher = createTerminalOutputBatcher({
      shouldBatch: shouldBatchTerminalOutput,
      write: (data, delivery) => {
        recordTerminalPerformanceWrite({
          mode: deps.renderModeRef.current,
          focused: deps.autoFocusRef.current,
          ...delivery,
        });
        writeTerminalData(data);
      },
      delayMs: () => terminalRenderBatchDelayMs(deps.renderModeRef.current) ?? 250,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    const flushTerminalOutput = () => outputBatcher.flush("focus");
    deps.flushTerminalOutputRef.current = flushTerminalOutput;
    const receiveTerminalData = (data: string | Uint8Array) => {
      recordTerminalPerformanceFrame({
        mode: deps.renderModeRef.current,
        focused: deps.autoFocusRef.current,
        unitCount: typeof data === "string" ? data.length : data.byteLength,
      });
      if (shouldBatchTerminalOutput() && protocolGuard.requiresImmediateWrite(data)) {
        outputBatcher.pushImmediate(data);
      } else {
        outputBatcher.push(data);
      }
    };

    transport = createTerminalTransportController({
      machine: deps.machine,
      id: deps.id,
      attachTarget: deps.agent === "shell" ? shellAttachTarget : attachTarget,
      createWebSocket: (url, protocols) => new WebSocket(url, protocols ? [...protocols] : undefined),
      sendFallback: deps.agent === "shell"
        ? async () => ({ ok: false, error: "Shell is disconnected. Reconnect before typing." })
        : sendSessionInput,
      setStatus: deps.setStatus,
      shouldReconnect: () => deps.mountedRef.current && navigator.onLine !== false,
      reconnectDelayOffsetMs: () => deps.autoFocusRef.current
        ? 0
        : backgroundReconnectOffsetMs(deps.machine, deps.id),
      isMounted: () => deps.mountedRef.current,
      onOpen: forceTerminalLayoutSync,
      onOutputActivity: () => deps.onTurnOutputRef.current?.(),
      onMessageData: receiveTerminalData,
      onProviderPromptCapability: deps.onProviderPromptCapability,
      onProviderPromptEvent: deps.onProviderPromptEvent,
      onInputRejected: deps.onInputRejected,
      onDebugEvent: recordDebugEvent,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    deps.transportRef.current = transport;
    let onlineWakeTimer: ReturnType<typeof setTimeout> | null = null;
    let offlineObserved = navigator.onLine === false;
    const noteOffline = () => { offlineObserved = true; };
    const wakeDisconnectedTransport = () => {
      if (!offlineObserved || !deps.mountedRef.current || navigator.onLine === false) return;
      offlineObserved = false;
      if (onlineWakeTimer !== null) clearTimeout(onlineWakeTimer);
      onlineWakeTimer = setTimeout(() => {
        onlineWakeTimer = null;
        if (deps.mountedRef.current && navigator.onLine !== false) transport?.wake();
      }, deps.autoFocusRef.current ? 0 : backgroundReconnectOffsetMs(deps.machine, deps.id));
    };
    window.addEventListener("offline", noteOffline);
    window.addEventListener("online", wakeDisconnectedTransport);

    const dataSub = term.onData((data) => {
      if (deps.terminalPasteInputRef.current) {
        deps.sendTextFrame(data);
        return;
      }
      const input = classifyTerminalData(data);
      if ("key" in input) {
        deps.sendKeyFrame(input.key);
      } else {
        deps.sendTextFrame(input.text);
      }
    });
    const syncSelectionHandles = () => {
      const pane = deps.paneRef.current;
      const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
      const pos = term.getSelectionPosition();
      if (!pane || !screen || !pos) {
        deps.setSelectionHandles(null);
        return;
      }
      const screenRect = screen.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      deps.setSelectionHandles(
        selectionHandlePoints(pos.start.x, pos.start.y, pos.end.x, pos.end.y, {
          screenLeft: screenRect.left - paneRect.left,
          screenTop: screenRect.top - paneRect.top,
          cellWidth: screenRect.width / term.cols,
          cellHeight: screenRect.height / term.rows,
          rows: term.rows,
          viewportY: term.buffer.active.viewportY,
        }),
      );
    };
    deps.syncSelectionHandlesRef.current = syncSelectionHandles;
    const selectionSub = term.onSelectionChange(() => {
      const selected = readTerminalSelection(term);
      if (selected) {
        deps.capturedSelectionRef.current = { text: selected, at: Date.now() };
      } else if (keepBottomPinned) {
        // The pause is over and output piled up behind it. Catch up now instead
        // of waiting for the next write, which may never come if the turn ended
        // while the selection was held.
        bottomPin.request();
      }
      syncSelectionHandles();
    });
    const scrollSub = term.onScroll(() => {
      // Scrollback trims remap absolute buffer rows under a live disclosure
      // (the viewport stays visually pinned while every row index shifts), so
      // a kept range could hit unrelated content. Drop it; while following
      // output, xterm's own viewport-change re-hover restores it immediately.
      disclosedLink = null;
      updateBottomPinIntentFromBuffer();
      if (!keepBottomPinned && bottomPinTarget.programmaticScrollIsSynchronous) {
        // A real scroll-away wins over settle retries that were armed by an
        // earlier write. Only content-aware pins land synchronously; plain
        // xterm pins emit off-target onScroll events during their animation.
        bottomPin.cancel();
      }
      syncSelectionHandles();
    });
    const writeParsedSub = term.onWriteParsed(() => {
      if (
        shouldAutoPinBottom({
          forced: forceNextBottomPin,
          keepPinned: keepBottomPinned,
          atBottom: bottomPinTarget.isAtBottom(),
          hasSelection: term.hasSelection(),
        })
      ) {
        bottomPin.request({ forceExact: forceNextBottomPin });
      }
    });
    const renderSub = term.onRender(({ start, end }) => {
      bottomPin.flush();
      reconcileTuiTouchVisual(start, end);
      reconcileScrollbackTouchVisual(start, end);
    });

    let recentTouchContextMenuUntil = 0;
    let dispatchingSyntheticWheel = false;

    const emitWheel = ({ deltaY, clientX, clientY }: TerminalTouchWheel) => {
      // Discrete wheel notch for a mouse-tracking TUI (forwarded as a CSI M
      // escape) or the alt buffer (converted to cursor up/down via alternateScroll
      // when there is no scrollback). Normal-buffer scrollback is handled directly
      // by scrollViewportPixels below, so this stays a pure synthetic-wheel
      // dispatch. In xterm 6.0 these two paths consume the wheel before it can
      // reach the pixel-based scrollable element.
      recordTuiTouchWheel(deltaY);
      dispatchingSyntheticWheel = true;
      try {
        wheelTarget.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY,
            clientX,
            clientY,
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            bubbles: true,
            cancelable: true,
          }),
        );
      } finally {
        dispatchingSyntheticWheel = false;
      }
    };

    const synthMouse = createTerminalSyntheticMouseSuppressor();
    const isCurrentTouchOriginContextMenu = (event: Event) =>
      isTouchOriginContextMenu(event, {
        hasAnyCoarsePointer,
        recentTouchContextMenuUntil,
      });
    const rememberTouchContextMenuCandidate = (event: TouchEvent) => {
      recentTouchContextMenuUntil =
        touchContextMenuCandidateUntil(event, { longPressMs: LONG_PRESS_MS }) ?? recentTouchContextMenuUntil;
    };

    let wordSelStart = 0;
    let wordSelEnd = 0;
    const terminalUrlAtPoint = (clientX: number, clientY: number): string | null => {
      const cell = terminalCellFromPoint(term, clientX, clientY);
      if (!cell) {
        return null;
      }
      return resolveTerminalUrlAtBufferCell(term.buffer.active, cell.row, cell.col);
    };
    const dispatchXtermMouse = (
      type: "mousemove" | "mousedown" | "mouseup",
      x: number,
      y: number,
      // Whether the event may leave `.xterm-screen`. Defaults to the safe
      // value: xterm's any-motion mouse reporter is a bubble-phase listener on
      // `term.element`, so a bubbling event is forwarded to the attached TUI.
      // Only the activation sequence, which is gated to non-tracking panes,
      // opts in.
      bubbles = false,
    ): boolean => {
      const element = term.element;
      if (!element) {
        return false;
      }
      // xterm 6 wires its Linkifier to `.xterm-screen`, a DESCENDANT of
      // `term.element` — an event dispatched at the ancestor never reaches it.
      // Target the screen and mark the event so the synthetic-mouse suppressor
      // lets it through even while armed by a touch long-press.
      const screen = element.querySelector<HTMLElement>(".xterm-screen");
      if (!screen && !bubbles) {
        // Retargeting to `term.element` would put the event AT the node the
        // mouse reporter listens on, where the target phase fires it whatever
        // `bubbles` says. Fail closed instead: the caller falls back to text
        // scanning rather than forwarding a report the pane never asked for.
        return false;
      }
      const target = screen ?? element;
      const event = new window.MouseEvent(type, {
        bubbles,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY: y,
      });
      markSyntheticLinkMouseEvent(event);
      target.dispatchEvent(event);
      return true;
    };
    // Move xterm's pointer state to the point so its linkifier resolves the
    // link there (OSC 8 metadata wins over visible text). xterm 5.5 keeps
    // `_lastBufferCell` across mouseleave, so move to an opposite in-terminal
    // cell first to force a fresh provider/OSC 8 lookup for a same-cell touch.
    // The probe moves do not bubble: xterm's Linkifier listens on
    // `.xterm-screen`, the dispatch target, so it still sees them, while the
    // any-motion mouse reporter listens on `term.element`, which a
    // non-bubbling event never reaches. The probe stays local in every pane.
    const moveXtermPointerTo = (clientX: number, clientY: number): void => {
      const element = term.element;
      if (!element) {
        return;
      }
      const screen = element.querySelector<HTMLElement>(".xterm-screen");
      const rect = screen?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        const probeX = clientX <= rect.left + rect.width / 2 ? rect.right - 1 : rect.left + 1;
        const probeY = clientY <= rect.top + rect.height / 2 ? rect.bottom - 1 : rect.top + 1;
        dispatchXtermMouse("mousemove", probeX, probeY);
      } else {
        dispatchXtermMouse("mousemove", clientX + 1, clientY + 1);
      }
      dispatchXtermMouse("mousemove", clientX, clientY);
    };
    // The disclosure counts only when the pressed point falls inside the
    // disclosed link's own cells; touch never fires xterm's leave, so an
    // unscoped cache could belong to an earlier gesture elsewhere.
    const disclosedLinkAt = (clientX: number, clientY: number): string | null => {
      if (!disclosedLink) {
        return null;
      }
      const cell = terminalCellFromPoint(term, clientX, clientY);
      if (!cell) {
        return null;
      }
      const { start, end } = disclosedLink.range;
      const row = cell.row + 1;
      const column = cell.col + 1;
      if (row < start.y || row > end.y) {
        return null;
      }
      if ((row === start.y && column < start.x) || (row === end.y && column > end.x)) {
        return null;
      }
      return disclosedLink.url;
    };
    // Resolved link under the point, favoring the disclosure xterm's own
    // resolution produced, falling back to implicit text-scan resolution. The
    // disclosure is always invalidated and re-probed at the pressed point: a
    // kept hit could have drifted under a scrollback trim, and the probe is two
    // synchronous mousemoves that reach only xterm's linkifier.
    const linkUrlAtPoint = (clientX: number, clientY: number, fromTouch: boolean): string | null => {
      disclosedLink = null;
      moveXtermPointerTo(clientX, clientY);
      const url = disclosedLinkAt(clientX, clientY) ?? terminalUrlAtPoint(clientX, clientY);
      // The probe drove xterm's hover, which paints the disclosure popup over
      // the pane. Take it down for touch, which never fires xterm's leave, so
      // nothing else would: the popup accepts pointer events, so one left up
      // sits over the pane and swallows later taps. Take it down in a
      // mouse-tracking pane too, where it discloses nothing that is about to
      // happen because pointer click-to-open is disabled there. Both callers
      // disclose the target themselves — the tap's confirmation, and the
      // menu's Copy link. What is left is a mouse in a pane it can click
      // through, where the popup is that click's own disclosure and the
      // pointer leaving takes it down.
      if (fromTouch || !canResolveTerminalLink()) {
        linkHoverTarget.leave();
      }
      return url;
    };
    // Touch-tap opener, for every pane. The synthetic click sequence runs first
    // when the pane does not own the mouse, and whatever it activates never
    // reaches here. What it fails to activate does, and a text scan at the
    // tapped cell is not enough to catch it: an OSC 8 label like "#398" holds
    // no URL text at all, and a continuation cell of a wrapped URL holds no URL
    // start. Both are reachable only through xterm's own resolution, so the tap
    // resolves through the pointer probe in either tracking mode. Opening asks
    // for a target-disclosing confirmation first: touch has no hover, and
    // implicit links can be heuristically joined across hard-wrap junctions.
    const openTerminalLinkAtPoint = (clientX: number, clientY: number): boolean => {
      const url = linkUrlAtPoint(clientX, clientY, true);
      if (!url) {
        return false;
      }
      if (!confirmTerminalLinkOpen(url)) {
        // The tap resolved a link and the user declined: consume the tap so it
        // cannot fall through into focus/keyboard side effects.
        return true;
      }
      void openExternalTerminalUrl(url);
      return true;
    };
    const activateXtermLinkAtPoint = (clientX: number, clientY: number): boolean => {
      if (!term.element || !canResolveTerminalLink()) {
        return false;
      }
      touchLinkActivationHandled = false;
      touchLinkActivationInProgress = true;
      try {
        moveXtermPointerTo(clientX, clientY);
        // These may bubble: the guard above restricts this sequence to panes
        // with no mouse tracking, so there is no reporter to forward them, and
        // xterm's selection service (on `term.element`) expects to see the
        // press that goes with the linkifier's click.
        dispatchXtermMouse("mousedown", clientX, clientY, true);
        dispatchXtermMouse("mouseup", clientX, clientY, true);
        // The move above painted xterm's hover popup. When this sequence does
        // activate the link, the tap ends here and nothing further re-probes,
        // so this is the only chance to take it down — and a finger will not,
        // because touch never fires xterm's leave.
        linkHoverTarget.leave();
      } finally {
        touchLinkActivationInProgress = false;
      }
      return touchLinkActivationHandled;
    };
    const selectWordAtPoint = (clientX: number, clientY: number) => {
      const cell = terminalCellFromPoint(term, clientX, clientY);
      if (!cell) {
        return;
      }
      const line = term.buffer.active.getLine(cell.row);
      if (!line) {
        return;
      }
      const cells: TerminalCell[] = [];
      for (let x = 0; x < term.cols; x += 1) {
        const bufferCell = line.getCell(x);
        cells.push({ chars: bufferCell?.getChars() ?? "", width: bufferCell?.getWidth() ?? 1 });
      }
      const range = wordCellRange(cells, cell.col);
      term.select(range.start, cell.row, range.length);
      wordSelStart = cell.row * term.cols + range.start;
      wordSelEnd = wordSelStart + range.length - 1;
    };
    const extendSelectionToPoint = (clientX: number, clientY: number) => {
      const cell = terminalCellFromPoint(term, clientX, clientY);
      if (!cell) {
        return;
      }
      const current = cell.row * term.cols + cell.col;
      const range = selectionRangeFromWordDrag(wordSelStart, wordSelEnd, current);
      term.select(range.start % term.cols, Math.floor(range.start / term.cols), range.length);
    };
    const releaseTouchMousePress = (clientX: number, clientY: number) => {
      term.element?.ownerDocument?.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX, clientY }),
      );
      if (term.hasSelection()) {
        term.clearSelection();
      }
    };
    let terminalBufferGeneration = 0;
    const warmTerminalBuffer = () => {
      const generation = terminalBufferGeneration;
      return (deps.agent === "shell" ? Promise.resolve("") : fetchSessionBuffer(deps.machine, deps.id)).then((text) => {
        if (deps.mountedRef.current && generation === terminalBufferGeneration && text) {
          deps.terminalBufferRef.current = text;
        }
        return text;
      });
    };
    // Defaults to touch: the ref this is published through is only reached from
    // the selection-handle drag, which is a finger. The context menu passes what
    // it detected instead, because a real right-click gets to keep the hover.
    const showTouchMenuAt = (clientX: number, clientY: number, fromTouch = true) => {
      const pane = deps.paneRef.current;
      if (!pane) {
        return;
      }
      const copyText = resolveTerminalCopyText({
        currentSelection: readTerminalSelection(term),
        capturedSelection: deps.capturedSelectionRef.current.text,
        capturedAgeMs: Date.now() - deps.capturedSelectionRef.current.at,
      });
      const linkUrl = linkUrlAtPoint(clientX, clientY, fromTouch);
      const links = linkRegistry.list();
      // Copy link is modelled as an alternative total and Links as an additive
      // delta; Retitle is deliberately unbudgeted because this scope cannot see
      // whether the pane was given an onRetitle handler. A new optional button
      // should follow the additive form.
      const menuWidth =
        (linkUrl ? TERMINAL_TOUCH_MENU_LINK_WIDTH_PX : TERMINAL_TOUCH_MENU_WIDTH_PX) +
        TERMINAL_TOUCH_MENU_ONE_LINE_BUTTON_PX +
        (links.length > 0 ? TERMINAL_TOUCH_MENU_LINKS_BUTTON_PX : 0);
      deps.setTerminalTouchMenu({
        key: deps.terminalInstanceKey,
        ...terminalTouchMenuPosition(clientX, clientY, pane.getBoundingClientRect(), {
          width: menuWidth,
          height: terminalTouchMenuHeight(pane),
        }),
        width: menuWidth,
        // The tmux paste-buffer cache is only trusted after a drag on this
        // pane (cleared on drag-start, filled on drag-end): warming it here
        // would resurrect whatever old selection the tmux server still holds
        // and make Copy paste stale content instead of reporting nothing.
        hasSelection: copyText.length > 0 || deps.terminalBufferRef.current.length > 0,
        linkUrl,
        links,
        revision: Date.now(),
      });
    };
    deps.showTouchMenuAtRef.current = showTouchMenuAt;

    // xterm 6 rounds its pixel scroll position to a buffer row before painting.
    // A temporary layer translation supplies the missing sub-row touch motion.
    // Land whole-row steps synchronously; the next render absorbs those rows.
    // A mouse-tracking TUI or alt buffer first gets a pixel-precise compositor
    // preview, then returns false so the bridge still sends the required discrete
    // wheel notch (a direct scrollLines there is a no-op).
    const scrollViewportPixels = (dyPixels: number): boolean => {
      if (term.modes.mouseTrackingMode !== "none" || term.buffer.active.type !== "normal") {
        if (scrollbackTouchVisualActive) {
          settleScrollbackTouchVisual(true);
        }
        // A transform over the rendered rows, not a scroll: it moves no buffer
        // row, so the gesture can still end as a tap.
        previewTuiTouchPixels(dyPixels);
        return false;
      }
      if (tuiTouchVisualActive || tuiTouchCleanupTimer !== undefined) {
        settleTuiTouchVisual(true);
      }
      tuiTouchBlockedDirection = 0;
      tuiTouchRowsAtBoundary = null;
      tuiTouchBlockedWheelRows = 0;
      const cellPx = terminalCellHeightPx();
      if (cellPx <= 0) {
        return false;
      }
      const buffer = term.buffer.active;
      if ((dyPixels < 0 && buffer.viewportY >= buffer.baseY) || (dyPixels > 0 && buffer.viewportY <= 0)) {
        // A sub-row drag can remain below the next scrollLines threshold for
        // many frames. Reject it at the edge before translating the layer.
        scrollAccumLines = 0;
        if (scrollbackTouchPendingRows === 0 && scrollbackTouchVisualActive) {
          settleScrollbackTouchVisual(true);
        }
        return true;
      }
      if (!scrollbackTouchVisualActive) {
        scrollbackTouchVisualActive = true;
        scrollbackTouchSmoothDuration = term.options.smoothScrollDuration;
        if (scrollbackTouchSmoothDuration !== 0) {
          term.options.smoothScrollDuration = 0;
        }
        for (const layer of currentTuiTouchLayers()) {
          layer.style.transition = "none";
          layer.style.willChange = "transform";
        }
      }
      scrollbackTouchSettling = false;
      scrollbackTouchVisualOffsetPx += dyPixels * TOUCH_SCROLL_GAIN;
      applyScrollbackTouchVisualOffset();
      // Finger-down (dyPixels > 0) reveals earlier lines -> scroll up (negative).
      scrollAccumLines += (-dyPixels * TOUCH_SCROLL_GAIN) / cellPx;
      const wholeLines = Math.trunc(scrollAccumLines);
      if (wholeLines !== 0) {
        scrollAccumLines -= wholeLines;
        const previousViewportY = term.buffer.active.viewportY;
        term.scrollLines(wholeLines);
        const actualRows = term.buffer.active.viewportY - previousViewportY;
        scrollbackTouchPendingRows += actualRows;
        if (
          actualRows !== wholeLines ||
          (wholeLines > 0 && buffer.viewportY >= buffer.baseY) ||
          (wholeLines < 0 && buffer.viewportY <= 0)
        ) {
          // A row step may be clamped, or land exactly at an edge. Keep the visual
          // translation equal to rows still awaiting paint, so the next render
          // lands at zero instead of bouncing through empty space.
          scrollbackTouchVisualOffsetPx = -scrollbackTouchPendingRows * cellPx;
          scrollAccumLines = 0;
          applyScrollbackTouchVisualOffset();
        }
      }
      if (!tuiTouchGestureActive) {
        scheduleScrollbackTouchSettle();
      }
      return true;
    };
    const isHorizontalSwipeEnabled = () => deps.onSessionSwipeRef.current !== undefined;
    const touchBridge = createTerminalTouchBridge({
      emitWheel,
      scrollViewportPixels,
      wheelStepPx: terminalCellHeightPx,
      now: () => performance.now(),
      showActivity: showTerminalScrollbar,
      clearMenu: () => deps.setTerminalTouchMenu(null),
      openMenu: showTouchMenuAt,
      beginSelection: selectWordAtPoint,
      extendSelection: extendSelectionToPoint,
      releaseTouchMousePress,
      suppressSynthMouse: synthMouse.arm,
      onHorizontalSwipe: (direction) => deps.onSessionSwipeRef.current?.(direction),
      isHorizontalSwipeEnabled,
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });

    const onTouchStart = (event: TouchEvent) => {
      // xterm derives actionable mouse coordinates from the fixed screen grid,
      // not from our translated row layer. Realign before this touch can become
      // a tap, long press, or forwarded TUI press.
      if (tuiTouchVisualActive || tuiTouchCleanupTimer !== undefined) {
        if (tuiTouchVisualActive) {
          blockUnacknowledgedTuiWheel();
        }
        settleTuiTouchVisual(true);
      }
      if (scrollbackTouchVisualActive) {
        settleScrollbackTouchVisual(true);
      }
      refreshTuiTouchGeometry();
      tuiTouchGestureActive = true;
      rememberTouchContextMenuCandidate(event);
      synthMouse.disarm();
      if (isHorizontalSwipeEnabled()) {
        // Own compatibility mouse input before xterm can translate touchstart
        // into a TUI press. A clean tap disarms this in touchend capture before
        // xterm handles the release; navigation keeps it armed throughout.
        synthMouse.arm();
      }
      touchBridge.onTouchStart(event);
    };
    const onTouchMove = (event: TouchEvent) => touchBridge.onTouchMove(event);
    const onTouchEnd = (event: TouchEvent) => {
      const t0 = event.changedTouches[0];
      // Pass the release point so a fast horizontal flick is measured to where
      // the finger actually lifted, not to the last (possibly stale) touchmove.
      const endKind = touchBridge.endTouch(t0);
      tuiTouchGestureActive = false;
      if (endKind === "tap") {
        // Links and compatibility clicks resolve against xterm's fixed input
        // grid. A sub-row wobble must be realigned before either hit test.
        if (tuiTouchVisualActive || tuiTouchCleanupTimer !== undefined) {
          settleTuiTouchVisual(true);
        }
        if (scrollbackTouchVisualActive) {
          settleScrollbackTouchVisual(true);
        }
      } else {
        if (tuiTouchVisualActive) {
          scheduleTuiTouchSettle();
        }
        if (scrollbackTouchVisualActive) {
          scheduleScrollbackTouchSettle();
        }
      }
      if (endKind !== "tap") {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      synthMouse.disarm();
      if (t0 && activateXtermLinkAtPoint(t0.clientX, t0.clientY)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        synthMouse.arm();
        return;
      }
      if (t0 && openTerminalLinkAtPoint(t0.clientX, t0.clientY)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        synthMouse.arm();
      }
    };
    const onTouchCancel = () => {
      tuiTouchGestureActive = false;
      touchBridge.cancelTouch();
      settleTuiTouchVisual(true);
      settleScrollbackTouchVisual(true);
    };
    const onWheel = (event: WheelEvent) => {
      if (dispatchingSyntheticWheel) {
        return;
      }
      showTerminalScrollbar();
      if (term.modes.mouseTrackingMode === "none") {
        return;
      }
      const steps = mouseWheelForwardedNotchLines(event);
      if (steps === 0) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const deltaY = steps < 0 ? -1 : 1;
      for (let i = 0; i < Math.abs(steps); i += 1) {
        emitWheel({ deltaY, clientX: event.clientX, clientY: event.clientY });
      }
    };
    const onViewportScroll = () => {
      updateBottomPinIntentFromBuffer();
      showTerminalScrollbar();
    };

    const onContextMenu = (event: Event) => {
      const eventWithPoint = event as Event & { clientX?: number; clientY?: number };
      event.preventDefault();
      event.stopPropagation();
      const fromTouch = isCurrentTouchOriginContextMenu(event);
      if (fromTouch) {
        touchBridge.cancelLongPress();
      }
      showTouchMenuAt(eventWithPoint.clientX ?? 0, eventWithPoint.clientY ?? 0, fromTouch);
    };

    const touchStartListenerOptions = { capture: true, passive: true } as const;
    const touchMoveListenerOptions = { capture: true, passive: false } as const;
    const contextMenuListenerOptions = { capture: true } as const;
    const bufferWarmer = createTerminalBufferWarmOnMouseDrag({
      warmBuffer: warmTerminalBuffer,
      clearBuffer: () => {
        terminalBufferGeneration += 1;
        deps.terminalBufferRef.current = "";
      },
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
    });
    const consumeTerminalBuffer = () => {
      terminalBufferGeneration += 1;
      bufferWarmer.clearTimers();
      deps.terminalBufferRef.current = "";
    };
    deps.consumeTerminalBufferRef.current = consumeTerminalBuffer;

    hostEl.addEventListener("touchstart", onTouchStart, touchMoveListenerOptions);
    hostEl.addEventListener("touchmove", onTouchMove, touchMoveListenerOptions);
    hostEl.addEventListener("touchend", onTouchEnd, touchMoveListenerOptions);
    hostEl.addEventListener("touchcancel", onTouchCancel, touchStartListenerOptions);
    hostEl.addEventListener("contextmenu", onContextMenu, contextMenuListenerOptions);
    hostEl.addEventListener("wheel", onWheel, { capture: true, passive: false });
    hostEl.addEventListener("mousedown", linkActivationGuard.onMouseDown, { capture: true });
    hostEl.addEventListener("mousemove", linkActivationGuard.onMouseMove, { capture: true });
    hostEl.addEventListener("mouseup", linkActivationGuard.onMouseUp, { capture: true });
    hostEl.addEventListener("mousedown", synthMouse.handleCapture, { capture: true });
    hostEl.addEventListener("mousemove", synthMouse.handleCapture, { capture: true });
    hostEl.addEventListener("mouseup", synthMouse.handleCapture, { capture: true });
    hostEl.addEventListener("click", synthMouse.handleCapture, { capture: true });
    hostEl.addEventListener("mousedown", bufferWarmer.onMouseDown, { capture: true });
    hostEl.addEventListener("mouseup", bufferWarmer.onMouseUp, { capture: true });
    viewport?.addEventListener("scroll", onViewportScroll, { passive: true });

    const ro = new ResizeObserver(() => requestTerminalLayoutSync());
    ro.observe(hostEl);
    window.addEventListener("resize", requestTerminalLayoutSync);

    teardown = () => {
      window.removeEventListener("resize", requestTerminalLayoutSync);
      hostEl.removeEventListener("touchstart", onTouchStart, touchMoveListenerOptions);
      hostEl.removeEventListener("touchmove", onTouchMove, touchMoveListenerOptions);
      hostEl.removeEventListener("touchend", onTouchEnd, touchMoveListenerOptions);
      hostEl.removeEventListener("touchcancel", onTouchCancel, touchStartListenerOptions);
      hostEl.removeEventListener("contextmenu", onContextMenu, contextMenuListenerOptions);
      hostEl.removeEventListener("wheel", onWheel, { capture: true });
      hostEl.removeEventListener("mousedown", linkActivationGuard.onMouseDown, { capture: true });
      hostEl.removeEventListener("mousemove", linkActivationGuard.onMouseMove, { capture: true });
      hostEl.removeEventListener("mouseup", linkActivationGuard.onMouseUp, { capture: true });
      hostEl.removeEventListener("mousedown", synthMouse.handleCapture, { capture: true });
      hostEl.removeEventListener("mousemove", synthMouse.handleCapture, { capture: true });
      hostEl.removeEventListener("mouseup", synthMouse.handleCapture, { capture: true });
      hostEl.removeEventListener("click", synthMouse.handleCapture, { capture: true });
      hostEl.removeEventListener("mousedown", bufferWarmer.onMouseDown, { capture: true });
      hostEl.removeEventListener("mouseup", bufferWarmer.onMouseUp, { capture: true });
      viewport?.removeEventListener("scroll", onViewportScroll);
      helperTextarea?.removeEventListener("focus", onPromptFocus);
      compositionGuard.dispose();
      if (deps.compositionGuardRef.current === compositionGuard) {
        deps.compositionGuardRef.current = null;
      }
      touchBridge.dispose();
      settleTuiTouchVisual(true);
      settleScrollbackTouchVisual(true);
      deps.setTerminalTouchMenu(null);
      consumeTerminalBuffer();
      deps.capturedSelectionRef.current = { text: "", at: 0 };
      linkProviderSub.dispose();
      linkRegistry.clear();
      disclosingLinkHoverTarget.dispose();
      term.options.linkHandler = null;
      if (scrollbarTimer !== undefined) {
        window.clearTimeout(scrollbarTimer);
      }
      bottomPin.dispose();
      layoutSync.dispose();
      if (deps.requestTerminalLayoutSyncRef.current === forceTerminalLayoutSync) {
        deps.requestTerminalLayoutSyncRef.current = null;
      }
      if (deps.syncSelectionHandlesRef.current === syncSelectionHandles) {
        deps.syncSelectionHandlesRef.current = null;
      }
      if (deps.showTouchMenuAtRef.current === showTouchMenuAt) {
        deps.showTouchMenuAtRef.current = null;
      }
      if (deps.consumeTerminalBufferRef.current === consumeTerminalBuffer) {
        deps.consumeTerminalBufferRef.current = null;
      }
      if (deps.flushTerminalOutputRef.current === flushTerminalOutput) {
        deps.flushTerminalOutputRef.current = null;
      }
      deps.setSelectionHandles(null);
      hideTerminalScrollbar();
      ro.disconnect();
      dataSub.dispose();
      selectionSub.dispose();
      scrollSub.dispose();
      writeParsedSub.dispose();
      renderSub.dispose();
      transport?.dispose();
      window.removeEventListener("offline", noteOffline);
      window.removeEventListener("online", wakeDisconnectedTransport);
      if (onlineWakeTimer !== null) clearTimeout(onlineWakeTimer);
      outputBatcher.dispose();
      unregisterPerformancePane();
      if (deps.transportRef.current === transport) {
        deps.transportRef.current = null;
      }
      themeSub();
      term.dispose();
      if (deps.termRef.current === term) {
        deps.termRef.current = null;
      }
    };
    void transport.connect();
  };

  void document.fonts.load(`${deps.fontSizeRef.current}px "BlexMono Nerd Font Mono"`).then(start, start);

  return () => {
    disposed = true;
    teardown?.();
  };
}

export { BASE_TERMINAL_FONT_SIZE };
