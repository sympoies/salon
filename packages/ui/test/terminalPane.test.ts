import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isNativeClipboardTarget, terminalKeyboardClipboardAction } from "../src/terminalClipboard.ts";
import {
  createTerminalLayoutSync,
  shouldRequestFirstPayloadSync,
} from "../src/terminalLayoutSync.ts";
import {
  TERMINAL_TOUCH_MENU_WIDTH_PX,
  createTerminalTouchBridge,
  hasMovedBeyondLongPressThreshold,
  selectionHandlePoints,
  selectionRangeFromWordDrag,
  terminalTouchMenuPosition,
  terminalViewportColFromPoint,
  terminalViewportRowFromPoint,
  wheelDeltasFromTouchAccum,
  wordCellRange,
  type TerminalCell,
} from "../src/terminalTouch.ts";

// Build a cell row from a plain ASCII string (each char is a width-1 cell).
function asciiCells(text: string): TerminalCell[] {
  return Array.from(text, (ch) => ({ chars: ch, width: 1 }));
}
import {
  UPLOAD_OK_STATUS_MS,
  beginUploadAttempt,
  isCurrentUploadAttempt,
  scheduleUploadStatusClear,
  type UploadAttemptState,
} from "../src/terminalUploadStatus.ts";
import { makeCssRuleLookup, uiSource, uiStyles, xtermSource } from "./support/source.ts";

const terminalPaneSource = uiSource("TerminalPane.tsx");
const terminalInstanceSource = uiSource("terminalInstance.ts");
const terminalMouseSource = uiSource("terminalMouse.ts");
const terminalPointerSource = uiSource("terminalPointer.ts");
const terminalClipboardSource = uiSource("terminalClipboard.ts");
const terminalLinksSource = uiSource("terminalLinks.ts");
const terminalTouchSource = uiSource("terminalTouch.ts");
const useTerminalClipboardSource = uiSource("useTerminalClipboard.ts");
const xtermViewportSource = xtermSource("src/browser/Viewport.ts");
const xtermVerticalScrollbarSource = xtermSource(
  "src/vs/base/browser/ui/scrollbar/verticalScrollbar.ts",
);
const source = terminalPaneSource;
const transportSource = uiSource("terminalTransport.ts");
const sessionSlotSource = uiSource("SessionSlot.tsx");
const css = uiStyles();
const cssRuleFor = makeCssRuleLookup(css);

test("TerminalPane wires visualViewport changes into the key bar inset", () => {
  assert.match(source, /const visualViewport = window\.visualViewport;/);
  assert.match(source, /visualViewport\?\.addEventListener\("resize", applyKeyboardInset\);/);
  assert.match(source, /visualViewport\?\.addEventListener\("scroll", applyKeyboardInset\);/);
  assert.match(source, /setKeyboardInsetStyle\(pane, geometry\);/);
});

test("TerminalPane blurs the terminal when the on-screen keyboard is dismissed", () => {
  // Without this, xterm keeps its textarea focused after dismiss, so Android
  // re-raises the keyboard on the next touch — including a scroll/swipe, which
  // bypasses the tap focus-gate. Drop focus on dismissal (coarse pointer only).
  assert.match(source, /keyboardWasDismissed\(previousInset, inset, KEYBOARD_DISMISS_INSET_PX\)/);
  assert.match(source, /hasCoarsePrimaryPointer\(\) &&/);
  // Through blurTerminal, never a bare term.blur(): dropping focus while an IME
  // composition is live is what wedges Android typing.
  assert.match(source, /keyboardWasDismissed\([^)]*\)\s*\)\s*\{\s*blurTerminal\(\);/);
});

test("TerminalPane finalizes the IME composition on every path that drops terminal focus", () => {
  // xterm leaves CompositionHelper._isComposing set when a composition never
  // receives its compositionend, and Chrome on Android reports keyCode 229 for
  // every soft-keyboard character — so the terminal swallows all later typing
  // until the page reloads. Space (keyCode 32) is the only accidental escape.
  assert.match(source, /const blurTerminal = \(\) => \{\s*compositionGuardRef\.current\?\.finalize\(\);\s*termRef\.current\?\.blur\(\);\s*\};/);
  assert.match(source, /const compositionGuardRef = useRef<TerminalCompositionGuard \| null>\(null\);/);
  assert.match(source, /compositionGuardRef,/, "the guard ref must reach createTerminalInstance");
  assert.equal(
    source.match(/termRef\.current\?\.blur\(\)/g)?.length,
    1,
    "terminal focus must only be dropped through blurTerminal",
  );

  // The upload chooser is a separate Android Activity; close the composition
  // and drop focus deliberately rather than relying on the viewport heuristic.
  assert.match(source, /blurTerminal\(\);\s*fileInputRef\.current\?\.click\(\);/);

  // Recovery net: a composition stranded while the WebView was backgrounded is
  // finalized the next time the helper textarea regains focus.
  assert.match(
    terminalInstanceSource,
    /const compositionGuard = createTerminalCompositionGuard\(helperTextarea\);/,
  );
  assert.match(terminalInstanceSource, /compositionGuard\.finalize\(\);\s*deps\.onPromptFocusRef\.current\?\.\(\);/);
  assert.match(terminalInstanceSource, /compositionGuard\.dispose\(\);/);
});

test("TerminalPane key bar buttons prevent focus stealing on pointer activation", () => {
  assert.match(source, /onMouseDown=\{preventKeyBarMouseFocus\}/);
});

test("TerminalPane marks key-bar panes for upload status positioning", () => {
  assert.match(source, /showKeyBar \? "with-key-bar" : ""/);
});

test("TerminalPane renders inert previews when interaction is disabled", () => {
  assert.match(source, /readonly interactive\?: boolean;/);
  assert.match(source, /interactive = true,/);
  assert.match(source, /!interactive \? "is-preview-inert" : ""/);
  assert.match(source, /if \(!interactive\) \{\s*blurTerminal\(\);\s*setTerminalTouchMenu\(null\);/);
  const previewRule = cssRuleFor(".terminal-pane.is-preview-inert");
  assert.match(previewRule, /pointer-events: none;/);
  assert.match(previewRule, /user-select: none;/);
});

test("TerminalPane CSS auto-hides both success and error upload status as a visual fallback", () => {
  assert.match(css, /\.upload-status\.ok \{/);
  assert.match(css, /animation: upload-status-hide 0\.2s ease-out 1\.4s forwards;/);
  // Errors fade too (later than success) so a fail banner never sticks.
  assert.match(css, /\.upload-status\.error \{[\s\S]*?animation: upload-status-hide 0\.2s ease-out 4\.8s forwards;/);
  assert.match(css, /@keyframes upload-status-hide \{/);
  assert.match(css, /to \{\s*opacity: 0;/);
});

test("TerminalPane routes every upload status through one auto-clearing controller", () => {
  // A single controller owns the busy/ok/error lifecycle so error banners clear
  // like success and a superseded result can't paint over a newer state.
  assert.match(source, /const statusControllerRef = useRef<TerminalStatusController \| null>\(null\);/);
  assert.match(source, /import \{ defaultScheduler \} from "\.\/scheduler\.ts";/);
  assert.match(source, /statusControllerRef\.current = createTerminalStatusController\(\{/);
  assert.match(source, /setTimeout: defaultScheduler\.setTimeout,/);
  assert.match(useTerminalClipboardSource, /const attempt = statusController\.begin\(/);
  assert.match(useTerminalClipboardSource, /statusController\.succeed\(/);
  assert.match(useTerminalClipboardSource, /statusController\.fail\(attempt,/);
  // The standalone (clipboard) error path is auto-clearing too, not a raw setter.
  assert.match(useTerminalClipboardSource, /statusController\.failStandalone\(message\);/);
  // Async continuations stay attempt-guarded.
  assert.match(useTerminalClipboardSource, /if \(!statusController\.isCurrent\(attempt\)\) \{/);
  // Teardown disposes the controller (cancels any pending clear).
  assert.match(source, /statusControllerRef\.current\?\.dispose\(\);/);
});

test("upload status helper ignores stale completion timers", () => {
  type Timer = { id: number; callback: () => void };
  const state: UploadAttemptState<Timer> = { current: 0, timer: null };
  const cleared: number[] = [];
  const statuses: Array<string | null> = [];
  let nextTimerId = 0;
  const scheduler = {
    setTimeout: (callback: () => void, delayMs: number): Timer => {
      assert.equal(delayMs, UPLOAD_OK_STATUS_MS);
      return { id: ++nextTimerId, callback };
    },
    clearTimeout: (timer: Timer) => {
      cleared.push(timer.id);
    },
  };

  const first = beginUploadAttempt(state, scheduler.clearTimeout);
  scheduleUploadStatusClear(state, first, scheduler, (status: string | null) => statuses.push(status));
  const firstTimer = state.timer;
  assert.ok(firstTimer);

  const second = beginUploadAttempt(state, scheduler.clearTimeout);
  assert.equal(isCurrentUploadAttempt(state, first), false);
  assert.equal(isCurrentUploadAttempt(state, second), true);
  assert.deepEqual(cleared, [firstTimer.id]);

  firstTimer.callback();
  assert.deepEqual(statuses, []);

  scheduleUploadStatusClear(state, second, scheduler, (status: string | null) => statuses.push(status));
  const secondTimer = state.timer;
  assert.ok(secondTimer);
  secondTimer.callback();
  assert.deepEqual(statuses, [null]);
  assert.equal(state.timer, null);
});

test("TerminalPane centralizes fit and bottom scroll after attach and layout changes", () => {
  assert.match(source, /readonly layoutSyncKey\?: string;/);
  assert.match(source, /const requestTerminalLayoutSyncRef = useRef<\(\(\) => void\) \| null>\(null\);/);
  assert.match(terminalInstanceSource, /const scheduler = createWindowScheduler\(window\);/);
  assert.match(terminalInstanceSource, /const layoutSync = createTerminalLayoutSync\(/);
  assert.match(terminalInstanceSource, /const bottomPin = createTerminalBottomPin\(bottomPinTarget, scheduler\);/);
  assert.match(terminalInstanceSource, /bottomPin\.request\(\);/);
  assert.match(terminalInstanceSource, /const forceTerminalLayoutSync = \(\) => \{/);
  assert.match(terminalInstanceSource, /onOpen: forceTerminalLayoutSync,/);
  assert.match(
    transportSource,
    /ws\.onopen = \(\) => \{[\s\S]*?reconnect\.resetAttempts\(\);\s*phase = "open";\s*clearConnectTimer\(\);\s*setStatus\("open"\);[\s\S]*?onOpen\?\.\(\);\s*\};/,
  );
  assert.match(terminalInstanceSource, /term\.write\(data, \(\) => \{/);
  assert.match(terminalInstanceSource, /shouldRequestFirstPayloadSync\(firstPayloadSync, true\)/);
  assert.match(terminalInstanceSource, /term\.onScroll\(\(\) => \{/);
  assert.match(terminalInstanceSource, /term\.onWriteParsed\(\(\) => \{/);
  assert.match(
    terminalInstanceSource,
    /term\.onRender\(\(\{ start, end \}\) => \{\s*bottomPin\.flush\(\);\s*reconcileTuiTouchVisual\(start, end\);\s*reconcileScrollbackTouchVisual\(start, end\);\s*\}\)/,
  );
  assert.match(terminalInstanceSource, /new ResizeObserver\(\(\) => requestTerminalLayoutSync\(\)\)/);
  assert.match(terminalInstanceSource, /window\.addEventListener\("resize", requestTerminalLayoutSync\);/);
  assert.match(source, /useEffect\(\(\) => \{\s*requestTerminalLayoutSyncRef\.current\?\.\(\);\s*\}, \[layoutSyncKey\]\);/);
});

test("TerminalPane skips fitting an unmeasured host to avoid caching 0x0 grid dimensions", () => {
  assert.match(
    terminalInstanceSource,
    /import \{[\s\S]*?\bBASE_TERMINAL_FONT_SIZE\b[\s\S]*?\bfitReadableTerminal\b[\s\S]*?\bisFittableTerminalHost\b[\s\S]*?\bshouldRecomputeTerminalColumns\b[\s\S]*?\} from "\.\/terminalFit\.ts";/,
  );
  // fitTerminal measures the host and bails before fit() when it has no box yet.
  assert.match(terminalInstanceSource, /const rect = host\.getBoundingClientRect\(\);/);
  assert.match(terminalInstanceSource, /if \(!isFittableTerminalHost\(\{ width: rect\.width, height: rect\.height \}\)\) \{\s*return false;/);
});

test("TerminalPane repaints the viewport after a fit so buffered grid output surfaces", () => {
  assert.match(terminalInstanceSource, /term\.refresh\(0, Math\.max\(0, term\.rows - 1\)\);/);
});

test("TerminalPane pins the column count across a keyboard (height-only) re-fit", () => {
  // The soft keyboard changes host HEIGHT only; recomputing columns on that
  // re-fit reflows full-width TUI status blocks into two rows. fitTerminal must
  // gate the column recompute (forced sync / real width change) and otherwise
  // pin cols to the last width-derived value while still taking the new rows.
  assert.match(terminalInstanceSource, /const fitTerminal = \(forceColumns: boolean\): boolean => \{/);
  assert.match(terminalInstanceSource, /shouldRecomputeTerminalColumns\(/);
  assert.match(terminalInstanceSource, /forceNextColumnRefit = true;/);
  assert.match(terminalInstanceSource, /term\.resize\(lastCols, term\.rows\);/);
});

test("TerminalPane keeps one terminal instance across font-size / readable-fit / focus / render-profile / priority changes", () => {
  // Instance identity and the creation effect must not fold in fontSize/readableFit/autoFocus,
  // otherwise opening a session tears down and reconnects the terminal (WS churn, lost scrollback).
  assert.doesNotMatch(source, /const terminalInstanceKey = [^;]*\$\{fontSize\}/);
  assert.doesNotMatch(source, /const terminalInstanceKey = [^;]*\$\{readableFit\}/);
  assert.match(source, /const fontSizeRef = useRef\(fontSize\);/);
  assert.match(source, /const readableFitRef = useRef\(readableFit\);/);
  assert.match(source, /const autoFocusRef = useRef\(autoFocus\);/);
  assert.match(source, /const renderModeRef = useRef\(renderMode\);/);
  assert.match(source, /const realtimeOutputRef = useRef\(resolvedRealtimeOutput\);/);
  assert.doesNotMatch(source, /const terminalInstanceKey = [^;]*\$\{renderMode\}/);
  assert.doesNotMatch(source, /const terminalInstanceKey = [^;]*\$\{realtimeOutput\}/);
  assert.doesNotMatch(source, /\}, \[autoFocus, fontSize, id, localReconnect, machine, readableFit,/);
});

test("TerminalPane re-fits on font-size / readable-fit change and focuses on autoFocus change without remounting", () => {
  assert.match(source, /\}, \[fontSize, readableFit\]\);/);
  assert.match(source, /\}, \[autoFocus\]\);/);
  assert.match(source, /\}, \[resolvedRealtimeOutput\]\);/);
});

test("SessionSlot gives the selected grid pane realtime output only when the preference is enabled", () => {
  assert.match(
    sessionSlotSource,
    /realtimeOutput=\{focused \|\| \(terminalSelectedPaneRealtime && cmdFocusTarget\)\}/,
  );
});

test("TerminalPane status emission is not tied to onStatusChange callback identity", () => {
  assert.match(source, /const onStatusChangeRef = useRef\(onStatusChange\);/);
  assert.match(source, /onStatusChangeRef\.current = onStatusChange;/);
  assert.match(source, /onStatusChangeRef\.current\?\.\(status\);/);
  assert.doesNotMatch(source, /\}, \[onStatusChange, status\]\);/);
});

test("TerminalPane pauses bottom auto-scroll while the user has a text selection", () => {
  assert.match(
    terminalInstanceSource,
    /import \{[\s\S]*?\bcreateTerminalBottomPin\b[\s\S]*?\bcreateTerminalBottomPinTarget\b[\s\S]*?\bshouldAutoPinBottom\b[\s\S]*?\} from "\.\/terminalBottomPin\.ts";/,
  );
  // All three auto-scroll decisions must route through the selection-aware predicate.
  const sites = terminalInstanceSource.match(/shouldAutoPinBottom\(\{/g) ?? [];
  assert.ok(sites.length >= 3, `expected >=3 shouldAutoPinBottom call sites, got ${sites.length}`);
  assert.match(terminalInstanceSource, /hasSelection: term\.hasSelection\(\),/);
  // The old unconditional pin expressions must be gone from the write/fit paths.
  assert.doesNotMatch(terminalInstanceSource, /const shouldPinAfterFit = forceNextBottomPin \|\| keepBottomPinned/);
});

test("TerminalPane selects the bottom pin target from the session agent", () => {
  assert.match(source, /readonly agent\?: string;/);
  assert.match(source, /agent,/);
  assert.match(
    terminalInstanceSource,
    /const bottomPinTarget = createTerminalBottomPinTarget\(term, deps\.agent\);/,
  );
  assert.match(terminalInstanceSource, /const bottomPin = createTerminalBottomPin\(bottomPinTarget, scheduler\);/);
});

// Cheap tripwire only. The behavior these lines carry is owned by
// terminalBottomPin.test.ts (nextBottomPinIntent and the streaming simulation);
// this asserts the wiring delegates to those units instead of asking xterm
// directly, which is what froze content-aware panes.
test("TerminalPane reads at-bottom only through the bottom pin target", () => {
  // A content-aware target parks the viewport above xterm's baseY, so any
  // remaining plain `viewportY >= baseY` read would flip keepBottomPinned off on
  // the pin's own scroll event and freeze the follow for the rest of the session.
  assert.doesNotMatch(terminalInstanceSource, /isTerminalAtBottom\(/);
  assert.doesNotMatch(terminalInstanceSource, /term\.buffer\.active\.baseY/);
  // One owner for the intent, reached from both the xterm and scrollbar paths.
  const intentOwners = terminalInstanceSource.match(/keepBottomPinned = nextBottomPinIntent\(\{/g) ?? [];
  assert.equal(intentOwners.length, 1);
  const intentCalls = terminalInstanceSource.match(/updateBottomPinIntentFromBuffer\(\)/g) ?? [];
  assert.equal(intentCalls.length, 2);
  assert.match(terminalInstanceSource, /hasSelection: term\.hasSelection\(\),\s*isAtBottom: bottomPinTarget\.isAtBottom\(\),\s*keepPinned: keepBottomPinned,/);
  assert.match(
    terminalInstanceSource,
    /const scrollSub = term\.onScroll\(\(\) => \{[\s\S]*?if \(!keepBottomPinned && bottomPinTarget\.programmaticScrollIsSynchronous\) \{[\s\S]*?bottomPin\.cancel\(\);/,
  );
});

test("TerminalPane catches a content-aware pane up when a selection clears", () => {
  // The pause leaves the viewport behind the tail; without this the pane waits
  // for a write that may never arrive once the turn ended mid-selection.
  assert.match(
    terminalInstanceSource,
    /const selectionSub = term\.onSelectionChange\(\(\) => \{[\s\S]*?\} else if \(keepBottomPinned\) \{[\s\S]*?bottomPin\.request\(\);/,
  );
});

test("SessionSlot passes the session agent into TerminalPane", () => {
  assert.match(sessionSlotSource, /<TerminalPane[\s\S]*?agent=\{s\.agent\}/);
});

test("SessionSlot enables terminal swipe navigation only for a focused mobile session", () => {
  assert.match(sessionSlotSource, /onSessionSwipe=\{focused && viewport\.mobile && sessionCount > 1/);
  assert.match(sessionSlotSource, /direction === "previous" \? onFocusPrevious\(\) : onFocusNext\(\)/);
});

test("TerminalPane resolves an attach target before opening the WebSocket", () => {
  assert.match(terminalInstanceSource, /import \{ attachTarget, shellAttachTarget, fetchSessionBuffer, sendSessionInput \} from "\.\/api\.ts";/);
  assert.match(useTerminalClipboardSource, /import \{ uploadAttachment \} from "\.\/api\.ts";/);
  assert.match(terminalInstanceSource, /createTerminalTransportController\(\{/);
  assert.match(terminalInstanceSource, /deps\.agent === "shell" \? shellAttachTarget : attachTarget/);
  assert.match(terminalInstanceSource, /createWebSocket: \(url, protocols\) => new WebSocket\(url, protocols \? \[\.\.\.protocols\] : undefined\),/);
  assert.match(transportSource, /const target = await attachTarget\(machine, id, recovery\);/);
  assert.match(transportSource, /createWebSocket\(target\.url, target\.protocols\)/);
});

test("TerminalPane falls back to the send route when the attach WebSocket is not open", () => {
  assert.match(source, /const transportRef = useRef<TerminalTransportController \| null>\(null\);/);
  assert.match(source, /void transport\.sendInput\(body\);/);
  assert.match(transportSource, /function createOrderedSessionInputSender/);
  assert.match(transportSource, /sendSessionInputViaWebSocket\(ws, body\);/);
  assert.match(
    transportSource,
    /const result = await sendFallback\(body\)\.catch\(\(\) => \(\{\s*ok: false,\s*error: "Terminal input failed\.",\s*outcomeUnknown: false,\s*\}\)\);/,
  );
  assert.match(transportSource, /if \(!result\.ok && isMounted\(\)\) \{\s*onInputRejected\?\.\(\{/);
  assert.match(transportSource, /pendingSends === 0 && ws\?\.readyState === openState/);
  assert.match(source, /const sendTextFrame = \(text: string\) => \{\s*const refusal = contextCommandGuardRef\.current\.acceptText\(text\);\s*if \(refusal\) \{ setContextCommandRefusal\(refusal\); return; \}[\s\S]*?submitCapturedTurnPrompts\(promptCaptureRef\.current\.acceptText\(text\)\);\s*sendTransportInput\(\{ text \}\);\s*\};/);
  assert.match(source, /const sendKeyFrame = \(key: SpecialKey\) => \{\s*const refusal = contextCommandGuardRef\.current\.acceptKey\(key\);\s*if \(refusal\) \{ setContextCommandRefusal\(refusal\); return; \}[\s\S]*?submitCapturedTurnPrompts\(promptCaptureRef\.current\.acceptKey\(key\)\);\s*sendTransportInput\(\{ keys: \[key\] \}\);\s*\};/);
  assert.match(source, /const sendKey = \(key: SpecialKey\) => \{/);
  assert.doesNotMatch(source, /term\.onData\(\(d\) => \{\s*if \(activeWs\?\.readyState === WebSocket\.OPEN\) \{\s*activeWs\.send\(textFrame\(d\)\);\s*\}\s*\}\);/);
});

test("terminal layout sync helper fits immediately and after layout settles", () => {
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  const timerCallbacks = new Map<number, () => void>();
  const canceledFrames: number[] = [];
  const clearedTimers: number[] = [];
  const calls: string[] = [];
  let nextFrame = 0;
  let nextTimer = 0;
  const sync = createTerminalLayoutSync(
    {
      requestAnimationFrame: (callback) => {
        const id = ++nextFrame;
        frameCallbacks.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id) => {
        canceledFrames.push(id);
        frameCallbacks.delete(id);
      },
      setTimeout: (callback, delayMs) => {
        assert.equal(delayMs, 50);
        const id = ++nextTimer;
        timerCallbacks.set(id, callback);
        return id;
      },
      clearTimeout: (id) => {
        clearedTimers.push(id);
        timerCallbacks.delete(id);
      },
    },
    () => calls.push("sync"),
  );

  sync.request();
  sync.request();
  assert.deepEqual(canceledFrames, [1]);
  frameCallbacks.get(2)?.(0);
  assert.deepEqual(calls, ["sync"]);
  timerCallbacks.get(1)?.();
  assert.deepEqual(calls, ["sync", "sync"]);

  sync.request();
  frameCallbacks.get(3)?.(0);
  sync.dispose();
  assert.deepEqual(clearedTimers, [2]);
});

test("first terminal payload requests bottom sync only once", () => {
  const state = { pending: true };
  assert.equal(shouldRequestFirstPayloadSync(state, false), false);
  assert.equal(shouldRequestFirstPayloadSync(state, true), true);
  assert.equal(shouldRequestFirstPayloadSync(state, true), false);
});

test("TerminalPane handles macOS clipboard shortcuts without stealing Ctrl-C", () => {
  assert.match(useTerminalClipboardSource, /const handleTerminalKeyDownCapture = \(event: KeyboardEvent<HTMLDivElement>\) => \{/);
  assert.match(useTerminalClipboardSource, /terminalKeyboardClipboardAction\(\{/);
  assert.match(useTerminalClipboardSource, /isNativeClipboardTarget\(event\.target\)/);
  assert.match(useTerminalClipboardSource, /runTerminalClipboardAction\(action, \{/);
  assert.match(useTerminalClipboardSource, /writeClientText: writeTerminalClipboardText,/);
  assert.match(useTerminalClipboardSource, /readClientText: readTerminalClipboardText,/);
  assert.match(useTerminalClipboardSource, /readNativeFiles: readMacosClipboardFiles,/);
  assert.match(useTerminalClipboardSource, /terminalClipboardActionErrorMessage\(action\)/);
  assert.match(source, /onKeyDownCapture=\{handleTerminalPromptKeyDownCapture\}/);
  assert.match(source, /handleTerminalKeyDownCapture\(event\);/);
});

test("one-line copy uses the shared deterministic clipboard controller", () => {
  assert.match(source, /onClick=\{handleTouchMenuCopyOneLine\}/);
  assert.match(useTerminalClipboardSource, /copyTerminalAsOneLine\(selectedTerminalText\(\)\)/);
  assert.doesNotMatch(useTerminalClipboardSource, /unwrapClipboardWithModel|loadClipboardModelEnabled|modelCopyAbortRef/);
});

test("TerminalPane captures paste before xterm can stop propagation", () => {
  const pasteBody = useTerminalClipboardSource.match(/const handlePaste = \(event: ClipboardEvent<HTMLDivElement>\) => \{[\s\S]*?\n  \};/);

  assert.ok(pasteBody, "handlePaste block should be present");
  assert.match(source, /onPasteCapture=\{handlePaste\}/);
  assert.doesNotMatch(source, /onPaste=\{handlePaste\}/);
  assert.match(pasteBody[0], /filesFromTerminalClipboardData\(event\.clipboardData\)/);
  assert.match(pasteBody[0], /terminalPasteEventAction\(\{/);
  assert.match(pasteBody[0], /hasNativeFileCandidate: canReadNativeFiles && isMacosFilePasteCandidate\(types, text\),/);
  assert.match(pasteBody[0], /if \(runClipboardAction\(action\)\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
});

test("terminal clipboard shortcut helper preserves native fallback and Ctrl-C", () => {
  const base = {
    key: "v",
    metaKey: true,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    macTauri: true,
    hasNativeClipboardTarget: false,
    selection: "selected text",
    canWriteClipboard: true,
  };

  assert.deepEqual(terminalKeyboardClipboardAction(base), { kind: "native" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, hasNativeClipboardTarget: true }), { kind: "native" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, ctrlKey: true }), { kind: "ignore" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, altKey: true }), { kind: "ignore" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, key: "c" }), {
    kind: "copy-selection",
    text: "selected text",
  });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, key: "c", selection: "" }), { kind: "native" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, key: "c", canWriteClipboard: false }), { kind: "native" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, key: "x" }), { kind: "ignore" });
});

test("terminal clipboard target helper lets xterm textarea shortcuts use the terminal handler", () => {
  const elementOwner = globalThis as typeof globalThis & { Element?: unknown };
  const originalElement = elementOwner.Element;

  class FakeElement {
    private readonly matches: readonly string[];

    constructor(matches: readonly string[]) {
      this.matches = matches;
    }

    closest(selector: string): FakeElement | null {
      const selectors = selector.split(",").map((entry) => entry.trim());
      return selectors.some((entry) => this.matches.includes(entry)) ? this : null;
    }
  }

  Object.defineProperty(elementOwner, "Element", { configurable: true, value: FakeElement });
  try {
    const terminalTextarea = new FakeElement([".xterm", "textarea"]);
    const regularInput = new FakeElement(["input"]);

    assert.equal(isNativeClipboardTarget(terminalTextarea as unknown as EventTarget), false);
    assert.equal(isNativeClipboardTarget(regularInput as unknown as EventTarget), true);
  } finally {
    if (originalElement === undefined) {
      delete elementOwner.Element;
    } else {
      Object.defineProperty(elementOwner, "Element", { configurable: true, value: originalElement });
    }
  }
});

test("TerminalPane sendKey does not refocus xterm after special-key taps", () => {
  const sendKeyBody = source.match(/const sendKey = \(key: SpecialKey\) => \{[\s\S]*?\n  \};/);

  assert.ok(sendKeyBody, "sendKey block should be present");
  assert.doesNotMatch(sendKeyBody[0], /termRef\.current\?\.focus\(\)/);
});

test("TerminalPane gates touch keyboard focus to the terminal bottom third", () => {
  assert.match(source, /!shouldGateTerminalFocus\(hasCoarsePrimaryPointer\(\)\)/);
  // The band is measured against the keyboard-independent height: fold the
  // `--keyboard-inset` padding back so an open keyboard cannot drift the band up.
  assert.match(source, /getComputedStyle\(pane\)\.paddingBottom/);
  assert.match(source, /keyboardActivationRect\(host\.getBoundingClientRect\(\), keyboardInset\)/);
  assert.match(source, /isKeyboardActivationArea\(clientY, rect\)/);
  assert.match(source, /onMouseDownCapture=\{handleTerminalMouseDownCapture\}/);
});

test("TerminalPane captures touch scroll before the xterm text layer can consume it", () => {
  assert.match(terminalInstanceSource, /const touchMoveListenerOptions = \{ capture: true, passive: false \} as const;/);
  // touchstart shares the non-passive options with touchmove (which preventDefaults).
  assert.match(terminalInstanceSource, /hostEl\.addEventListener\("touchstart", onTouchStart, touchMoveListenerOptions\);/);
  assert.match(terminalInstanceSource, /hostEl\.addEventListener\("touchmove", onTouchMove, touchMoveListenerOptions\);/);
  assert.match(terminalInstanceSource, /hostEl\.removeEventListener\("touchmove", onTouchMove, touchMoveListenerOptions\);/);
});

test("TerminalPane owns synthesized mouse only while session swipe is eligible and preserves taps", () => {
  // An eligible session gesture owns compatibility mouse events before xterm
  // can translate touchstart into a TUI press. A clean tap disarms ownership in
  // touchend capture so its synthesized click still focuses xterm.
  assert.match(
    terminalInstanceSource,
    /synthMouse\.disarm\(\);\s*if \(isHorizontalSwipeEnabled\(\)\) \{[\s\S]*?synthMouse\.arm\(\);\s*\}\s*touchBridge\.onTouchStart\(event\);/,
  );
  assert.match(terminalInstanceSource, /if \(endKind !== "tap"\) \{[\s\S]*?return;\s*\}\s*synthMouse\.disarm\(\);/);
  assert.doesNotMatch(source, /if \(e\.touches\.length === 1\) \{\s*e\.stopPropagation\(\);\s*e\.preventDefault\(\);/);
  // The bridge re-arms suppression for scroll/selection gestures.
  assert.match(terminalInstanceSource, /suppressSynthMouse: synthMouse\.arm,/);
  // While armed, the compatibility mouse events are eaten in the capture phase.
  assert.match(terminalMouseSource, /handleCapture\(event\) \{/);
  assert.match(terminalMouseSource, /event\.stopImmediatePropagation\(\);/);
  assert.match(terminalInstanceSource, /hostEl\.addEventListener\("mousedown", synthMouse\.handleCapture, \{ capture: true \}\);/);
  // mousemove is suppressed too, so a compat mousemove cannot extend an xterm
  // selection drag that stalls the scroll over text.
  assert.match(terminalInstanceSource, /hostEl\.addEventListener\("mousemove", synthMouse\.handleCapture, \{ capture: true \}\);/);
});

test("TerminalPane releases the forwarded touch press at the press cell so scroll over text is not stalled", () => {
  // The compat mousedown at touch-start is forwarded to a mouse-mode TUI as a
  // press; a scroll then leaves the app mid-drag (drag-select) unless the press is
  // released at the SAME cell it landed. Dispatch a mouseup carrying the press
  // coordinates so the app sees a click, not a drag.
  assert.match(
    terminalInstanceSource,
    /new MouseEvent\("mouseup", \{ bubbles: true, cancelable: true, clientX, clientY \}\)/,
  );
  assert.match(terminalInstanceSource, /const releaseTouchMousePress = \(clientX: number, clientY: number\) => \{/);
  assert.match(terminalInstanceSource, /releaseTouchMousePress,/);
});

test("TerminalPane bridges touch scroll from text even without mouse tracking", () => {
  // The touch bridge is created and wired unconditionally (an early bug gated
  // touch scroll behind mouse tracking, disabling it inside codex/claude). The
  // only mouseTrackingMode check lives in the mouse-wheel handler, not here.
  assert.match(terminalInstanceSource, /createTerminalTouchBridge\(\{/);
  assert.match(terminalInstanceSource, /const onTouchMove = \(event: TouchEvent\) => touchBridge\.onTouchMove\(event\);/);
  assert.match(terminalInstanceSource, /const wheelTarget = term\.element\?\.querySelector<HTMLElement>\("\.xterm-screen"\) \?\? term\.element \?\? hostEl;/);
  assert.match(terminalInstanceSource, /const emitWheel = \(\{ deltaY, clientX, clientY \}: TerminalTouchWheel\) => \{/);
  assert.match(terminalInstanceSource, /new WheelEvent\("wheel", \{\s*deltaY,\s*clientX,\s*clientY,/);
  // Our own synthetic wheels (touch + notch amplification) skip the capture handler.
  assert.match(terminalInstanceSource, /if \(dispatchingSyntheticWheel\) \{/);
});

test("TerminalPane amplifies a discrete mouse-wheel notch in a mouse-tracking TUI", () => {
  // xterm forwards exactly one escape per DOM wheel event in mouse-tracking mode,
  // so one mouse notch barely moves. Forward several notch escapes; the local
  // scrollback path (no mouse tracking, where xterm honors scrollSensitivity) is
  // left untouched.
  assert.match(terminalInstanceSource, /if \(term\.modes\.mouseTrackingMode === "none"\) \{\s*return;\s*\}/);
  assert.match(terminalInstanceSource, /const steps = mouseWheelForwardedNotchLines\(event\);/);
  // The original event's single escape is suppressed so we don't double up.
  assert.match(terminalInstanceSource, /event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);/);
  assert.match(terminalInstanceSource, /emitWheel\(\{ deltaY, clientX: event\.clientX, clientY: event\.clientY \}\);/);
});

test("touch helper maps finger movement into terminal wheel steps", () => {
  assert.deepEqual(wheelDeltasFromTouchAccum(50), { deltas: [-1, -1], remaining: 2 });
  assert.deepEqual(wheelDeltasFromTouchAccum(-50), { deltas: [1, 1], remaining: -2 });
  assert.deepEqual(wheelDeltasFromTouchAccum(12), { deltas: [], remaining: 12 });
});

test("terminal touch bridge dispatches wheel steps with touch coordinates and cancels long press on scroll", () => {
  const wheels: Array<{ deltaY: number; clientX: number; clientY: number }> = [];
  const clearedTimers: number[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let activity = 0;
  let clearMenu = 0;
  let opened = 0;
  let prevented = 0;
  let stopped = 0;
  const bridge = createTerminalTouchBridge({
    emitWheel: (wheel) => wheels.push(wheel),
    showActivity: () => {
      activity += 1;
    },
    clearMenu: () => {
      clearMenu += 1;
    },
    openMenu: () => {
      opened += 1;
    },
    setTimeout: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (timer) => {
      clearedTimers.push(timer as number);
      timers.delete(timer as number);
    },
  });

  bridge.onTouchStart({ touches: [{ clientX: 20, clientY: 100 }] });
  bridge.onTouchMove({
    touches: [{ clientX: 20, clientY: 50 }],
    preventDefault: () => {
      prevented += 1;
    },
    stopPropagation: () => {
      stopped += 1;
    },
  });

  assert.deepEqual(wheels, [
    { deltaY: 1, clientX: 20, clientY: 50 },
    { deltaY: 1, clientX: 20, clientY: 50 },
  ]);
  assert.deepEqual(clearedTimers, [1]);
  assert.equal(timers.has(1), false);
  assert.equal(activity, 2);
  assert.equal(clearMenu, 2);
  assert.equal(opened, 0);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test("terminal touch bridge long-presses to word-select, drags to extend, releases to open the menu", () => {
  const timers = new Map<number, () => void>();
  const began: Array<{ x: number; y: number }> = [];
  const extended: Array<{ x: number; y: number }> = [];
  const opened: Array<{ x: number; y: number }> = [];
  const wheels: unknown[] = [];
  let nextTimer = 0;
  const bridge = createTerminalTouchBridge({
    emitWheel: (w) => wheels.push(w),
    showActivity: () => undefined,
    clearMenu: () => undefined,
    openMenu: (x, y) => opened.push({ x, y }),
    beginSelection: (x, y) => began.push({ x, y }),
    extendSelection: (x, y) => extended.push({ x, y }),
    setTimeout: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as number);
    },
  });

  bridge.onTouchStart({ touches: [{ clientX: 42, clientY: 88 }] });
  timers.get(1)?.(); // long-press fires -> word select, enters selection mode
  assert.deepEqual(began, [{ x: 42, y: 88 }]);

  // A move while selecting extends the selection and must NOT scroll.
  bridge.onTouchMove({ touches: [{ clientX: 42, clientY: 160 }], preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(extended, [{ x: 42, y: 160 }]);
  assert.equal(wheels.length, 0);
  assert.equal(opened.length, 0);

  // Release shows the copy menu at the last touch point and reports it was a
  // selection gesture so the caller can suppress the synthesized click.
  const endKind = bridge.endTouch();
  assert.equal(endKind, "selection");
  assert.deepEqual(opened, [{ x: 42, y: 160 }]);
});

test("terminal touch bridge releases the forwarded press once, at the touch-start cell", () => {
  const timers = new Map<number, () => void>();
  const releases: Array<{ x: number; y: number }> = [];
  const wheels: unknown[] = [];
  let nextTimer = 0;
  const bridge = createTerminalTouchBridge({
    emitWheel: (w) => wheels.push(w),
    showActivity: () => undefined,
    clearMenu: () => undefined,
    openMenu: () => undefined,
    releaseTouchMousePress: (x, y) => {
      releases.push({ x, y });
    },
    setTimeout: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as number);
    },
  });

  bridge.onTouchStart({ touches: [{ clientX: 20, clientY: 200 }] });
  bridge.onTouchMove({ touches: [{ clientX: 20, clientY: 150 }], preventDefault() {}, stopPropagation() {} });
  bridge.onTouchMove({ touches: [{ clientX: 20, clientY: 100 }], preventDefault() {}, stopPropagation() {} });

  // Released exactly once, at the press cell (touch-start), so the app sees a
  // click rather than a drag from the press cell to wherever the scroll ended.
  assert.deepEqual(releases, [{ x: 20, y: 200 }]);
  assert.ok(wheels.length > 0); // still scrolls
  assert.equal(bridge.endTouch(), "scroll");
});

test("terminal touch bridge suppresses synth mouse for scroll and selection but not a clean tap", () => {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let suppressed = 0;
  const make = () =>
    createTerminalTouchBridge({
      emitWheel: () => undefined,
      showActivity: () => undefined,
      clearMenu: () => undefined,
      openMenu: () => undefined,
      beginSelection: () => undefined,
      suppressSynthMouse: () => {
        suppressed += 1;
      },
      setTimeout: (callback) => {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (timer) => timers.delete(timer as number),
    });

  // A clean tap (down then up, no move, no long-press) leaves synth mouse alone
  // so its synthesized click still focuses the terminal / raises the keyboard.
  suppressed = 0;
  const tapBridge = make();
  tapBridge.onTouchStart({ touches: [{ clientX: 30, clientY: 44 }] });
  tapBridge.endTouch();
  assert.equal(suppressed, 0);

  // A scroll re-arms suppression on every move (the compat mousedown can land
  // late and restart xterm's selection drag, and the 700ms window can lapse on a
  // long scroll), so two moves suppress twice.
  suppressed = 0;
  const scrollBridge = make();
  scrollBridge.onTouchStart({ touches: [{ clientX: 30, clientY: 200 }] });
  scrollBridge.onTouchMove({ touches: [{ clientX: 30, clientY: 120 }], preventDefault() {}, stopPropagation() {} });
  scrollBridge.onTouchMove({ touches: [{ clientX: 30, clientY: 60 }], preventDefault() {}, stopPropagation() {} });
  assert.equal(suppressed, 2); // once per move of a confirmed drag

  // A long-press selection suppresses synth mouse (so the fresh selection is not cleared).
  suppressed = 0;
  const selBridge = make();
  selBridge.onTouchStart({ touches: [{ clientX: 30, clientY: 44 }] });
  timers.get(nextTimer)?.(); // long-press fires
  assert.equal(suppressed, 1);
});

test("wordCellRange selects the whitespace-delimited word under an ASCII column", () => {
  // "mac book": cells 0-2 = mac, 3 = space, 4-7 = book.
  assert.deepEqual(wordCellRange(asciiCells("mac book"), 1), { start: 0, length: 3 });
  assert.deepEqual(wordCellRange(asciiCells("mac book"), 5), { start: 4, length: 4 });
  assert.deepEqual(wordCellRange(asciiCells("mac book"), 3), { start: 3, length: 1 }); // on the space
  // A path has no interior spaces, so the whole token is one word.
  assert.deepEqual(wordCellRange(asciiCells("/home/runner/x"), 6), { start: 0, length: 14 });
});

test("wordCellRange spans full-width (CJK) glyphs by cell, not by character", () => {
  // Row "中文 x": each CJK glyph is one char but two cells (width 2 then a width-0
  // trailing half). Cells: 0=中(w2) 1=(w0) 2=文(w2) 3=(w0) 4=space 5=x.
  const cells: TerminalCell[] = [
    { chars: "中", width: 2 },
    { chars: "", width: 0 },
    { chars: "文", width: 2 },
    { chars: "", width: 0 },
    { chars: " ", width: 1 },
    { chars: "x", width: 1 },
  ];
  // Tapping either cell of either glyph selects the whole "中文" run: cells 0..3.
  assert.deepEqual(wordCellRange(cells, 0), { start: 0, length: 4 });
  assert.deepEqual(wordCellRange(cells, 1), { start: 0, length: 4 }); // trailing half of 中
  assert.deepEqual(wordCellRange(cells, 2), { start: 0, length: 4 });
  // Whitespace between runs selects a single cell; the ASCII word is separate.
  assert.deepEqual(wordCellRange(cells, 4), { start: 4, length: 1 });
  assert.deepEqual(wordCellRange(cells, 5), { start: 5, length: 1 });
  // A CJK run touching an ASCII token with no space is one word: "中x".
  assert.deepEqual(
    wordCellRange([{ chars: "中", width: 2 }, { chars: "", width: 0 }, { chars: "x", width: 1 }], 2),
    { start: 0, length: 3 },
  );
});

test("terminalViewportColFromPoint maps x within the row to a clamped column", () => {
  const rect = { left: 0, top: 0, width: 800, height: 400 };
  assert.equal(terminalViewportColFromPoint(0, rect, 80), 0);
  assert.equal(terminalViewportColFromPoint(400, rect, 80), 40);
  assert.equal(terminalViewportColFromPoint(10000, rect, 80), 79); // clamped
  assert.equal(terminalViewportColFromPoint(50, { left: 0, top: 0, width: 0, height: 400 }, 80), null);
});

test("selectionRangeFromWordDrag anchors the word and extends in the drag direction", () => {
  // word occupies offsets 4..7 (e.g. "book").
  assert.deepEqual(selectionRangeFromWordDrag(4, 7, 10), { start: 4, length: 7 }); // drag right
  assert.deepEqual(selectionRangeFromWordDrag(4, 7, 1), { start: 1, length: 7 }); // drag left
  assert.deepEqual(selectionRangeFromWordDrag(4, 7, 6), { start: 4, length: 4 }); // within word -> keep
});

test("selectionHandlePoints places handles at cell corners and hides off-screen endpoints", () => {
  const geo = { screenLeft: 4, screenTop: 8, cellWidth: 10, cellHeight: 20, rows: 24, viewportY: 100 };
  const pts = selectionHandlePoints(2, 101, 5, 103, geo);
  // start: viewportRow 1 -> x = 4 + 2*10 = 24, y = 8 + (1+1)*20 = 48
  assert.deepEqual(pts.start, { x: 24, y: 48, visible: true });
  // end: viewportRow 3 -> x = 4 + 5*10 = 54, y = 8 + (3+1)*20 = 88
  assert.deepEqual(pts.end, { x: 54, y: 88, visible: true });
  // endpoint above the viewport (buffer row 90 -> viewportRow -10) is hidden
  assert.equal(selectionHandlePoints(2, 90, 5, 103, geo).start.visible, false);
  // endpoint at/below the last visible row (row 124 -> viewportRow 24 >= rows) is hidden
  assert.equal(selectionHandlePoints(2, 101, 5, 124, geo).end.visible, false);
});

test("TerminalPane renders draggable selection handles synced to the selection", () => {
  // Selection changes both snapshot the selected text (so Copy survives a redraw)
  // and re-sync the drag handles.
  assert.match(terminalInstanceSource, /const selectionSub = term\.onSelectionChange\(\(\) => \{/);
  assert.match(terminalInstanceSource, /capturedSelectionRef\.current = \{ text: selected, at: Date\.now\(\) \};/);
  assert.match(terminalInstanceSource, /syncSelectionHandles\(\);\s*\}\);/);
  assert.match(source, /className="term-sel-handle start"/);
  assert.match(source, /className="term-sel-handle end"/);
  assert.match(source, /onTouchStart=\{beginSelectionHandleDrag\("start"\)\}/);
  assert.match(source, /term\.select\(range\.start % term\.cols, Math\.floor\(range\.start \/ term\.cols\), range\.length\)/);
  assert.match(css, /\.term-sel-handle \{/);
  assert.match(css, /touch-action: none;/);
});

test("TerminalPane wires touch word-selection, drag-extend, and press-release into the bridge", () => {
  assert.match(terminalInstanceSource, /openMenu: showTouchMenuAt,/);
  assert.match(terminalInstanceSource, /beginSelection: selectWordAtPoint,/);
  assert.match(terminalInstanceSource, /extendSelection: extendSelectionToPoint,/);
  assert.match(terminalInstanceSource, /releaseTouchMousePress,/);
  assert.match(terminalInstanceSource, /term\.select\(range\.start, cell\.row, range\.length\);/);
  // whole-line touch selection is replaced by word/char selection
  assert.doesNotMatch(terminalInstanceSource, /term\.selectLines\(term\.buffer\.active\.viewportY/);
  // touchend suppresses the synthesized click so the selection is not cleared
  assert.match(
    terminalInstanceSource,
    /const endKind = touchBridge\.endTouch\(t0\);\s*tuiTouchGestureActive = false;[\s\S]*?if \(endKind !== "tap"\) \{\s*event\.preventDefault\(\);/,
  );
  assert.match(
    terminalInstanceSource,
    /const onTouchCancel = \(\) => \{[\s\S]*?touchBridge\.cancelTouch\(\);[\s\S]*?settleTuiTouchVisual\(true\);\s*settleScrollbackTouchVisual\(true\);\s*\};/,
  );
  assert.match(terminalInstanceSource, /teardown = \(\) => \{[\s\S]*?touchBridge\.dispose\(\);/);
  assert.match(terminalInstanceSource, /hostEl\.addEventListener\("touchend", onTouchEnd, touchMoveListenerOptions\);/);
});

test("touch helper cancels long press after a scroll gesture", () => {
  assert.equal(hasMovedBeyondLongPressThreshold(20, 20, 24, 24), false);
  assert.equal(hasMovedBeyondLongPressThreshold(20, 20, 20, 31), true);
});

test("touch helper keeps the rendered mobile toolbar inside the pane", () => {
  const menu = { width: TERMINAL_TOUCH_MENU_WIDTH_PX, height: 62 };
  const pane = { left: 10, top: 20, width: 320, height: 200 };
  const edgePositions = [
    terminalTouchMenuPosition(390, 4, pane, menu),
    terminalTouchMenuPosition(10, 260, pane, menu),
    terminalTouchMenuPosition(170, 120, pane, menu),
  ];

  for (const position of edgePositions) {
    assert.ok(position.x >= 8, `x should be inside left edge: ${position.x}`);
    assert.ok(position.y >= 8, `y should be inside top edge: ${position.y}`);
    assert.ok(position.x + menu.width <= pane.width - 8, `menu should fit inside right edge: ${position.x}`);
    assert.ok(position.y + menu.height <= pane.height - 8, `menu should fit inside bottom edge: ${position.y}`);
  }
});

test("touch helper maps long press points to visible terminal rows", () => {
  const rect = { left: 0, top: 10, width: 320, height: 240 };
  assert.equal(terminalViewportRowFromPoint(10, rect, 24), 0);
  assert.equal(terminalViewportRowFromPoint(130, rect, 24), 12);
  assert.equal(terminalViewportRowFromPoint(999, rect, 24), 23);
  assert.equal(terminalViewportRowFromPoint(130, rect, 0), null);
});

test("TerminalPane shows an Android-safe touch clipboard toolbar", () => {
  assert.match(source, /const \[terminalTouchMenu, setTerminalTouchMenu\]/);
  assert.match(terminalInstanceSource, /querySelector<HTMLTextAreaElement>\("\.xterm-helper-textarea"\)/);
  assert.match(terminalInstanceSource, /helperTextarea\?\.setAttribute\("autocomplete", "off"\);/);
  assert.match(terminalInstanceSource, /helperTextarea\?\.setAttribute\("autocorrect", "off"\);/);
  assert.match(terminalInstanceSource, /helperTextarea\?\.setAttribute\("autocapitalize", "none"\);/);
  assert.match(terminalInstanceSource, /createTerminalTouchBridge\(\{/);
  assert.match(terminalTouchSource, /terminalViewportRowFromPoint\(clientY, rect, term\.rows\)/);
  assert.match(terminalInstanceSource, /hostEl\.addEventListener\("contextmenu", onContextMenu, contextMenuListenerOptions\);/);
  assert.match(source, /className="terminal-touch-menu"/);
  assert.match(terminalInstanceSource, /height: terminalTouchMenuHeight\(pane\)/);
  assert.doesNotMatch(source, /height:.*TERMINAL_TOUCH_MENU_HEIGHT/);
  // Select all was retired; the menu is Copy · Copy link · Paste · Retitle · Done.
  assert.doesNotMatch(source, />\s*Select all\s*<\/button>/);
  assert.match(source, />\s*Copy\s*<\/button>/);
  assert.match(source, />\s*Paste\s*<\/button>/);
  assert.match(source, /readonly onRetitle\?: \(\) => void;/);
  assert.match(source, /onRetitle\(\);\s*setTerminalTouchMenu\(null\);/);
  assert.match(source, />\s*Retitle\s*<\/button>/);
});

test("TerminalPane offers Copy link when the toolbar opens on a detected URL", () => {
  // The URL under the long-press/right-click point is resolved once, when the
  // menu opens, and copying it never depends on drag-selecting the wrapped text.
  assert.match(terminalInstanceSource, /readonly linkUrl: string \| null;/);
  // The menu prefers the link xterm's own resolution disclosed (OSC 8 targets
  // survive label wrapping); implicit text scanning is the fallback.
  assert.match(terminalInstanceSource, /const linkUrl = linkUrlAtPoint\(clientX, clientY, fromTouch\);/);
  // The disclosure is scoped to the hovered link's cells and only used when
  // the pressed point falls inside; text scanning is the final fallback.
  assert.match(terminalInstanceSource, /const disclosedLinkAt = \(clientX: number, clientY: number\): string \| null => \{/);
  assert.match(
    terminalInstanceSource,
    /const url = disclosedLinkAt\(clientX, clientY\) \?\? terminalUrlAtPoint\(clientX, clientY\);/,
  );
  // The probe runs in every pane, including a mode-1003 TUI, and the stale
  // disclosure is dropped before it, so a trim-drifted range cannot serve.
  assert.match(
    terminalInstanceSource,
    /const linkUrlAtPoint = \(clientX: number, clientY: number, fromTouch: boolean\): string \| null => \{\s*disclosedLink = null;\s*moveXtermPointerTo\(clientX, clientY\);/,
  );
  // It stays local by not bubbling: the linkifier owns .xterm-screen (the
  // dispatch target) while the any-motion reporter owns term.element. Not
  // bubbling is the DEFAULT, so a dispatch written without the flag is safe;
  // only the activation sequence, gated to non-tracking panes, opts in.
  assert.match(terminalInstanceSource, /^ {6}bubbles = false,$/m);
  assert.match(terminalInstanceSource, /dispatchXtermMouse\("mousedown", clientX, clientY, true\);/);
  // A missing .xterm-screen must not retarget onto term.element, where the
  // target phase would fire the reporter whatever bubbles says.
  assert.match(terminalInstanceSource, /if \(!screen && !bubbles\) \{\s*(?:\/\/[^\n]*\n\s*)*return false;/);
  // The width is computed once, next to the position clamp, and rides on the
  // menu state so clamp math and rendered CSS width cannot drift apart.
  assert.match(
    terminalInstanceSource,
    /\(linkUrl \? TERMINAL_TOUCH_MENU_LINK_WIDTH_PX : TERMINAL_TOUCH_MENU_WIDTH_PX\) \+/,
  );
  // The Links button widens the same computed width, so the clamp math and the
  // rendered CSS width still cannot drift apart.
  assert.match(terminalInstanceSource, /links\.length > 0 \? TERMINAL_TOUCH_MENU_LINKS_BUTTON_PX : 0/);
  assert.match(source, /width: `\$\{visibleTouchMenu\.width\}px`,/);
  // The picker: its button, the gate that hides it when nothing was harvested,
  // the panel, and — the part that matters — that a row opens through the same
  // disclosure every other coarse-pointer path uses, never directly.
  assert.match(source, /\{visibleTouchMenu\.links\.length > 0 \? \(/);
  assert.match(source, />\s*Links\s*<\/button>/);
  assert.match(source, /className="terminal-link-picker"/);
  assert.match(source, /if \(confirmTerminalLinkOpen\(entry\.url\)\) \{\s*void openExternalTerminalUrl\(entry\.url\);/);
  // The picker joins the overlay lifecycle: cleared on instance swap, and
  // dismissed by Escape or an outside click like the toolbar beside it.
  assert.match(source, /setTerminalTouchMenu\(null\);\s*(?:\/\/[^\n]*\n\s*)*setTerminalLinkPicker\(null\);/);
  assert.match(source, /target\.closest\("\.terminal-link-picker"\)/);
  assert.match(source, /\{visibleTouchMenu\.linkUrl \? \(/);
  assert.match(source, />\s*Copy link\s*<\/button>/);
  assert.match(useTerminalClipboardSource, /const handleTouchMenuCopyLink = \(\) => \{/);
  assert.match(useTerminalClipboardSource, /const url = visibleTouchMenu\?\.linkUrl;/);
  assert.match(useTerminalClipboardSource, /statusController\.succeed\(attempt, "Copied link"\)/);
});

test("TerminalPane tracks helper-textarea focus and services focus requests on the existing terminal", () => {
  assert.match(source, /readonly focusRequestToken\?: number;/);
  assert.match(source, /readonly onPromptFocus\?: \(\) => void;/);
  assert.match(source, /handledFocusRequestTokenRef\.current = focusRequestToken;\s*terminal\.focus\(\);/);
  assert.match(terminalInstanceSource, /helperTextarea\?\.addEventListener\("focus", onPromptFocus\);/);
  assert.match(terminalInstanceSource, /helperTextarea\?\.removeEventListener\("focus", onPromptFocus\);/);
  assert.doesNotMatch(
    source,
    /const terminalInstanceKey = `[^`]*focusRequestToken/,
    "focus requests must not recreate the xterm instance or reconnect its transport",
  );
});

test("TerminalPane opens the clipboard toolbar on touch long-press and desktop right-click", () => {
  const contextBody = terminalInstanceSource.match(/const onContextMenu = \(event: Event\) => \{[\s\S]*?\n    \};/);

  assert.ok(contextBody, "onContextMenu block should be present");
  assert.match(terminalPointerSource, /function hasAnyCoarsePointer\(\): boolean \{/);
  assert.match(terminalMouseSource, /function isTouchOriginContextMenu\(/);
  assert.match(terminalMouseSource, /return pointerType === "touch";/);
  assert.match(terminalInstanceSource, /recentTouchContextMenuUntil/);
  assert.match(terminalInstanceSource, /rememberTouchContextMenuCandidate\(event\);/);
  assert.match(terminalInstanceSource, /touchBridge\.onTouchStart\(event\);/);
  // The native menu is always suppressed and our toolbar opened — for a desktop
  // mouse right-click as well as a touch long-press (no early return for mouse).
  assert.doesNotMatch(contextBody[0], /if \(!isTouchOriginContextMenu\(e\)\) \{\s*return;\s*\}/);
  assert.match(contextBody[0], /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  // Only a touch long-press cancels the pending long-press timer, and the same
  // detection decides whether the hover disclosure survives the menu: a finger
  // never fires xterm's leave, so its popup has to be taken down here.
  assert.match(
    contextBody[0],
    /const fromTouch = isCurrentTouchOriginContextMenu\(event\);\s*if \(fromTouch\) \{\s*touchBridge\.cancelLongPress\(\);\s*\}/,
  );
  assert.match(
    contextBody[0],
    /showTouchMenuAt\(eventWithPoint\.clientX \?\? 0, eventWithPoint\.clientY \?\? 0, fromTouch\);/,
  );
  assert.doesNotMatch(source, /shouldUseTerminalTouchMenu/);
});

test("TerminalPane keeps the selection on right-click so Copy can act on it", () => {
  // The button-2 mousedown/up must be stopped before xterm's screen handler clears
  // the selection; the contextmenu event still fires and opens the toolbar.
  assert.match(terminalMouseSource, /\(event as globalThis\.MouseEvent\)\.button === 2 &&/);
  assert.match(terminalMouseSource, /event\.type === "mousedown" \|\| event\.type === "mouseup"/);
  assert.match(terminalMouseSource, /event\.stopImmediatePropagation\(\);\s*return;/);
});

test("TerminalPane Copy is always clickable and reports the copy outcome", () => {
  // Copy is no longer gated by the menu's captured hasSelection; it resolves the
  // best text at click time and reports success/empty so the user gets feedback.
  assert.doesNotMatch(source, /disabled=\{!canCopyTerminalSelection\}/);
  assert.match(terminalClipboardSource, /async function writeTerminalClipboardText\(/);
  // Plain empty-state message — no shipped debug counters.
  assert.match(useTerminalClipboardSource, /"Nothing to copy — select some terminal text first"/);
  assert.doesNotMatch(source, /`Nothing to copy \(sel=/);
  assert.match(useTerminalClipboardSource, /statusController\.succeed\(attempt, `Copied \$\{text\.length\} characters`\)/);
});

test("TerminalPane copies a live-TUI selection via the session's tmux paste buffer", () => {
  // A live mouse-reporting TUI (Claude Code) never exposes its on-screen selection
  // to the DOM but copies it into the tmux buffer; Copy pulls that via the edge.
  assert.match(terminalInstanceSource, /import \{ attachTarget, shellAttachTarget, fetchSessionBuffer, sendSessionInput \} from "\.\/api\.ts";/);
  assert.match(useTerminalClipboardSource, /import \{ uploadAttachment \} from "\.\/api\.ts";/);
  assert.match(source, /const terminalBufferRef = useRef<string>\(""\);/);
  assert.match(source, /const consumeTerminalBufferRef = useRef<\(\(\) => void\) \| null>\(null\);/);
  // One warmer fetches + caches the buffer; used by drag-end only — a menu-open
  // warm would resurrect stale tmux-server selections as copyable content.
  assert.match(terminalInstanceSource, /const warmTerminalBuffer = \(\) =>/);
  assert.match(terminalInstanceSource, /fetchSessionBuffer\(deps\.machine, deps\.id\)\)\.then\(\(text\) => \{/);
  assert.match(terminalInstanceSource, /deps\.terminalBufferRef\.current = text;/);
  assert.match(terminalInstanceSource, /generation === terminalBufferGeneration/);
  assert.match(terminalInstanceSource, /deps\.capturedSelectionRef\.current = \{ text: "", at: 0 \};/);
  // Drag-end warms the buffer (real drag, not a click) so a bare ⌘/Ctrl+C works
  // without first opening the right-click menu.
  assert.match(terminalInstanceSource, /createTerminalBufferWarmOnMouseDrag/);
  assert.match(terminalInstanceSource, /hostEl\.addEventListener\("mouseup", bufferWarmer\.onMouseUp, \{ capture: true \}\);/);
  assert.match(terminalInstanceSource, /hostEl\.removeEventListener\("mouseup", bufferWarmer\.onMouseUp, \{ capture: true \}\);/);
  // The TUI writes the buffer a round-trip AFTER mouseup, so drag-end re-fetches
  // over ~1s (not a single racing fetch) and clears the stale cache on drag-start
  // so a fast ⌘C never copies the previous (smaller) selection.
  assert.match(terminalMouseSource, /const scheduleBufferSettle = \(\) => \{/);
  assert.match(terminalMouseSource, /timers\.push\(setTimeout\(\(\) => void warmBuffer\(\), delay\)\);/);
  assert.match(terminalMouseSource, /scheduleBufferSettle\(\);/);
  assert.match(terminalInstanceSource, /bufferWarmer\.clearTimers\(\);/);
  // Right-click Copy and ⌘/Ctrl+C both fall back to the buffer when there is no
  // local xterm selection, and clear it after a successful copy / on drag-start.
  const fallbacks = useTerminalClipboardSource.match(/\}\) \|\| terminalBufferRef\.current;/g) ?? [];
  assert.ok(fallbacks.length >= 1, `expected shared buffer fallback, got ${fallbacks.length}`);
  const selectedTextCallSites = useTerminalClipboardSource.match(/selectedTerminalText\(\)/g) ?? [];
  assert.ok(selectedTextCallSites.length >= 2, `expected shared fallback used by copy and keyboard paths`);
  assert.match(useTerminalClipboardSource, /consumeTerminalBufferRef\.current\?\.\(\);/);
});

test("TerminalPane reads the selection with a buffer-position fallback", () => {
  // getSelection() can be empty for a still-highlighted selection over a live TUI;
  // reconstruct from getSelectionPosition() + the buffer in that case.
  assert.match(terminalClipboardSource, /function readTerminalSelection\(term: Terminal\): string \{/);
  assert.match(terminalClipboardSource, /const pos = term\.getSelectionPosition\(\);/);
  // Soft-wrapped rows stay unbroken (no "\n", no right trim) so a URL crossing
  // the wrap survives the copy; hard rows keep their newline separators.
  assert.match(
    terminalClipboardSource,
    /const wrapsIntoNext = y < pos\.end\.y && buffer\.getLine\(y \+ 1\)\?\.isWrapped === true;/,
  );
  assert.match(terminalClipboardSource, /line\.translateToString\(!wrapsIntoNext, startX, endX\)/);
  // Final fallback: a native DOM selection scoped to the terminal element.
  assert.match(terminalClipboardSource, /function readNativeSelectionWithin\(root: HTMLElement \| null\): string \{/);
  assert.match(terminalClipboardSource, /root\.contains\(anchor\)\) \|\| \(focus && root\.contains\(focus\)\)/);
  assert.match(terminalClipboardSource, /return readNativeSelectionWithin\(term\.element \?\? null\);/);
  // The click-time copy resolves through the buffer-aware reader.
  assert.match(useTerminalClipboardSource, /currentSelection: termRef\.current \? readTerminalSelection\(termRef\.current\) : "",/);
});

test("TerminalPane opens terminal URLs on left-click and touch tap", () => {
  assert.match(terminalInstanceSource, /import \{[\s\S]*?\bcreateOsc8LinkHandler\b[\s\S]*?\bcreateTerminalLinkProvider\b[\s\S]*?\bresolveTerminalUrlAtBufferCell\b[\s\S]*?\} from "\.\/terminalLinks\.ts";/);
  assert.match(terminalInstanceSource, /const openTerminalLinkAtPoint = \(clientX: number, clientY: number\): boolean => \{/);
  assert.match(terminalInstanceSource, /resolveTerminalUrlAtBufferCell\(term\.buffer\.active, cell\.row, cell\.col\)/);
  assert.match(terminalInstanceSource, /void openExternalTerminalUrl\(url\)/);
  assert.doesNotMatch(terminalMouseSource, /createTerminalLinkMouseHandler/);
  assert.match(terminalInstanceSource, /term\.registerLinkProvider\(linkProvider\)/);
  assert.match(terminalInstanceSource, /term\.options\.linkHandler = createOsc8LinkHandler/);
  assert.match(terminalInstanceSource, /const linkActivationGuard = createTerminalLinkActivationGuard\(\);/);
  assert.match(terminalInstanceSource, /const canResolveTerminalLink = \(\) => term\.modes\.mouseTrackingMode === "none";/);
  assert.match(terminalInstanceSource, /linkActivationGuard\.canActivate\(event\)/);
  assert.match(terminalInstanceSource, /canActivate: canActivateTerminalLink,/);
  // One disclosure rule covers both link kinds. An implicit link needs it as
  // much as an OSC 8 one: the provider joins a URL across wrapped rows, so a
  // tap can open a target whose tail was never on screen.
  assert.match(terminalInstanceSource, /const linkOpenNeedsDisclosure = \(event: MouseEvent\) =>/);
  assert.equal(
    terminalInstanceSource.match(/requiresConfirmation: linkOpenNeedsDisclosure,/g)?.length,
    2,
    "both the implicit link provider and the OSC 8 handler must share the disclosure rule",
  );
  assert.match(terminalInstanceSource, /hasAnyCoarsePointer\(\)/);
  // The disclosure prompt lives with the URL-semantics owner so every
  // confirm-before-open path shares one wording.
  assert.match(terminalLinksSource, /window\.confirm\(`Open this terminal link\?/);
  assert.match(terminalInstanceSource, /confirmTerminalLinkOpen,/);
  // A tap resolves through xterm's own resolution in EITHER tracking mode, not
  // a text scan at the tapped cell, and discloses the target before opening.
  // A text scan cannot see an OSC 8 label that is not a URL, nor a
  // continuation cell of a wrapped one, so a quiet pane needs the probe too.
  assert.match(
    terminalInstanceSource,
    /const url = linkUrlAtPoint\(clientX, clientY, true\);[\s\S]*?if \(!confirmTerminalLinkOpen\(url\)\) \{/,
  );
  assert.doesNotMatch(
    terminalInstanceSource,
    /if \(canResolveTerminalLink\(\)\) \{\s*\/\/[\s\S]{0,400}?const url = terminalUrlAtPoint\(clientX, clientY\);/,
    "the tap opener must not keep a text-scan-only branch for panes with no mouse tracking",
  );
  assert.match(terminalInstanceSource, /const onTouchEnd = \(event: TouchEvent\) => \{\s*const t0 = event\.changedTouches\[0\];[\s\S]*?const endKind = touchBridge\.endTouch\(t0\);[\s\S]*?if \(endKind !== "tap"\)/);
  assert.match(terminalInstanceSource, /openTerminalLinkAtPoint\(t0\.clientX, t0\.clientY\)/);
  assert.match(terminalInstanceSource, /event\.stopImmediatePropagation\(\);\s*synthMouse\.arm\(\);/);
});

test("TerminalPane dismisses the desktop clipboard toolbar on outside click or Escape", () => {
  assert.match(source, /document\.addEventListener\("mousedown", closeOnOutsideMouseDown, true\);/);
  assert.match(source, /document\.addEventListener\("keydown", closeOnEscape, true\);/);
  assert.match(source, /closest\("\.terminal-touch-menu"\)/);
  assert.match(source, /key\?: string \}\)\.key === "Escape"/);
  assert.match(source, /document\.removeEventListener\("mousedown", closeOnOutsideMouseDown, true\);/);
  assert.match(source, /document\.removeEventListener\("keydown", closeOnEscape, true\);/);
});

test("TerminalPane binds the touch toolbar to the active terminal instance", () => {
  assert.match(terminalInstanceSource, /readonly key: string;/);
  assert.match(source, /const terminalInstanceKey = `\$\{machine\}\\u0000\$\{id\}\\u0000/);
  assert.match(
    source,
    /setTerminalTouchMenu\(null\);[\s\S]{0,400}?promptCaptureRef\.current\.reset\(\);\s*promptTitleSourceRef\.current\?\.resetConnection\(\);/,
  );
  assert.match(source, /return \(\) => \{\s*promptTitleSourceRef\.current\?\.resetConnection\(\);\s*\};\s*\}, \[terminalInstanceKey\]\);/);
  assert.match(terminalInstanceSource, /key: deps\.terminalInstanceKey,/);
  assert.match(useTerminalClipboardSource, /const visibleTouchMenu = terminalTouchMenu\?\.key === terminalInstanceKey \? terminalTouchMenu : null;/);
});

test("TerminalPane does not read full terminal selection during touch toolbar render", () => {
  assert.doesNotMatch(source, /const terminalSelection = terminalTouchMenu \? termRef\.current\?\.getSelection\(\)/);
  assert.match(useTerminalClipboardSource, /const canCopyTerminalSelection = isTerminalClipboardActionHandled\(/);
  assert.match(useTerminalClipboardSource, /selection: visibleTouchMenu\?\.hasSelection \? "selection" : "",/);
  // Copy resolves the live selection with a captured-snapshot + tmux-buffer
  // fallback (at click time, not during render).
  assert.match(useTerminalClipboardSource, /const selectedTerminalText = \(\) =>\s*resolveTerminalCopyText\(\{/);
  assert.match(useTerminalClipboardSource, /currentSelection: termRef\.current \? readTerminalSelection\(termRef\.current\) : "",/);
});

test("TerminalPane auto-hides the terminal scrollbar three seconds after scroll activity", () => {
  assert.match(terminalInstanceSource, /const SCROLLBAR_VISIBLE_MS = 3000;/);
  assert.match(terminalInstanceSource, /paneRef\.current\?\.classList\.add\("is-scrolling"\);/);
  assert.match(terminalInstanceSource, /window\.setTimeout\(hideTerminalScrollbar, SCROLLBAR_VISIBLE_MS\)/);
  assert.match(terminalInstanceSource, /const onViewportScroll = \(\) => \{/);
  assert.match(terminalInstanceSource, /updateBottomPinIntentFromBuffer\(\);\s*showTerminalScrollbar\(\);/);
  assert.match(terminalInstanceSource, /viewport\?\.addEventListener\("scroll", onViewportScroll, \{ passive: true \}\);/);
  assert.match(terminalInstanceSource, /hostEl\.addEventListener\("wheel", onWheel, \{ capture: true, passive: false \}\);/);
});

test("TerminalPane CSS hides only the xterm viewport scrollbar until activity", () => {
  assert.match(css, /\.terminal-pane \.xterm \.xterm-viewport \{/);
  assert.match(css, /scrollbar-color: transparent transparent;/);
  assert.match(css, /\.terminal-pane\.is-scrolling \.xterm \.xterm-viewport \{/);
  assert.match(css, /\.terminal-pane \.xterm \.xterm-viewport::-webkit-scrollbar-thumb \{/);
  assert.match(css, /\.terminal-pane\.is-scrolling \.xterm \.xterm-viewport::-webkit-scrollbar-thumb \{/);
  assert.match(css, /\.terminal-pane \.xterm \.xterm-scrollable-element > \.scrollbar\.vertical > \.slider \{\s*background: transparent !important;\s*border-radius: 999px;\s*\}/);
  assert.match(css, /\.terminal-pane \.xterm \.xterm-scrollable-element > \.scrollbar\.vertical > \.slider::before \{\s*content: "";\s*position: absolute;\s*inset: 0 4px;\s*border-radius: 999px;\s*background: rgba\(95, 126, 151, 0\.5\);\s*\}/);
});

test("TerminalPane scrollbar styling follows the installed xterm viewport contract", () => {
  assert.match(
    xtermViewportSource,
    /new SmoothScrollableElement\(screenElement, \{[\s\S]*?vertical: ScrollbarVisibility\.Auto,/,
  );
  assert.match(
    xtermViewportSource,
    /`\.xterm \.xterm-scrollable-element > \.scrollbar > \.slider \{`/,
  );
  assert.match(xtermVerticalScrollbarSource, /extraScrollbarClassName: 'vertical'/);
  assert.match(
    css,
    /\.terminal-pane \.xterm \.xterm-scrollable-element > \.scrollbar\.vertical > \.slider/,
  );
});

test("TerminalPane CSS disables native Android text callouts in the xterm text layer", () => {
  assert.match(css, /\.term-host \.xterm/);
  assert.match(css, /touch-action: none;/);
  assert.match(css, /-webkit-touch-callout: none;/);
  assert.match(css, /user-select: none;/);
  assert.match(css, /\.term-host \.xterm-screen\s*\{[^}]*overflow: hidden;/s);
});

test("TerminalPane renders the key bar from the shared key-bar layout", () => {
  // The bar's contents are agent-dependent, so the model lives in a pure module
  // the tests can enumerate; the pane only renders it.
  assert.match(source, /import \{ terminalKeyBarLayout \} from "\.\/terminalKeyBar\.ts";/);
  assert.match(source, /const keyBarLayout = terminalKeyBarLayout\(agent\);/);
  // No second, drifting copy of the list inside the component.
  assert.doesNotMatch(source, /const KEY_BAR:/);
});

test("TerminalPane keeps Upload leading the primary row", () => {
  assert.match(
    source,
    /className="key-bar" aria-label="Special keys"[\s\S]*?className="[^"]*key upload-key"[\s\S]*?keyBarLayout\.primary\.map/,
  );
});

test("TerminalPane sends a primary entry as a special key", () => {
  assert.match(
    source,
    /keyBarLayout\.primary\.map\([\s\S]*?onClick=\{\(\) => \{[\s\S]*?sendKey\(entry\.key\)/,
  );
});

test("TerminalPane sends overflow text or key sequences and collapses the row", () => {
  // Slash commands are prompt-line text; the Codex question action is a key
  // sequence. Both use the literal-input transport, without an extra Enter.
  assert.match(
    source,
    /keyBarLayout\.overflow\.map\([\s\S]*?entry\.kind === "text"[\s\S]*?sendTerminalText\(entry\.text\);[\s\S]*?sendTerminalSequence\(entry\.sequence\);[\s\S]*?setKeyBarOverflowOpen\(false\);/,
  );
  assert.match(source, /const sendTerminalSequence = \(sequence: string\) => \{[\s\S]*?promptCaptureRef\.current\.invalidate\(\);\s*contextCommandGuardRef\.current\.noteNavigation\(\);\s*sendTransportInput\(\{ text: sequence \}\);/);
});

test("TerminalPane only offers the overflow toggle when the agent has commands", () => {
  assert.match(source, /keyBarLayout\.overflow\.length > 0 \? \([\s\S]*?className="[^"]*key key-bar-more"/);
  assert.match(source, /aria-expanded=\{keyBarOverflowOpen\}/);
  assert.match(source, /aria-controls=\{keyBarOverflowId\}/);
  // The controlled row stays mounted and hidden so aria-controls always resolves.
  assert.match(source, /className="key-bar key-bar-overflow"[\s\S]*?hidden=\{!keyBarOverflowOpen\}/);
});

test("TerminalPane collapses the overflow row when it stops applying", () => {
  // Swapping the focused pane from claude to DSH empties the row; leaving it
  // open would show an empty second bar over the terminal.
  assert.match(
    source,
    /if \(keyBarLayout\.overflow\.length === 0\) \{\s*setKeyBarOverflowOpen\(false\);/,
  );
});

test("TerminalPane collapses the overflow row when the desktop key bar auto-hides", () => {
  // The overflow row is absolutely positioned above the primary row, so it is
  // outside the group's translated height. Resetting the open state on leave
  // prevents that extra row from remaining visible after the group hides.
  assert.match(
    source,
    /className="key-bar-group"\s+onMouseLeave=\{\(\) => setKeyBarOverflowOpen\(false\)\}/,
  );
});

test("TerminalPane collapses the overflow row before opening the file chooser", () => {
  // The upload toast is positioned for a single-row bar, so the second row must
  // be gone before an upload can raise it.
  assert.match(
    source,
    /className="[^"]*key upload-key"[\s\S]*?onClick=\{\(\) => \{[\s\S]*?setKeyBarOverflowOpen\(false\);[\s\S]*?fileInputRef\.current\?\.click\(\);/,
  );
});

test("the key bar rows share one group so the desktop reveal moves them together", () => {
  assert.match(source, /className="key-bar-group"/);
  const group = cssRuleFor(".key-bar-group");
  assert.match(group, /flex-direction: column;/);
  // The desktop hover overlay is keyed on the group, not the primary row, so an
  // open overflow row rides along instead of being left behind off-screen.
  assert.match(css, /\.terminal-pane\.with-key-bar \.key-bar-group \{[\s\S]*?transform: translateY\(100%\);/);
  assert.match(css, /\.terminal-pane\.with-key-bar \.key-bar-hotzone:hover ~ \.key-bar-group,/);
  assert.doesNotMatch(css, /\.terminal-pane\.with-key-bar \.key-bar \{\s*position: absolute;/);
});

test("the overflow row does not repeat the primary row's bottom safe-area padding", () => {
  // It sits above the pinned primary row, which still owns the screen edge.
  const overflow = cssRuleFor(".key-bar-overflow");
  assert.doesNotMatch(overflow, /--ac-safe-area-bottom/);
});

test("the collapsed overflow row is actually hidden", () => {
  // .key-bar sets display:flex from the author sheet, which outranks the UA
  // [hidden] rule — the attribute alone leaves the row on screen.
  assert.match(cssRuleFor(".key-bar-overflow[hidden]"), /display: none;/);
});

test("the overflow row overlays the terminal instead of shrinking it", () => {
  // .term-host carries a ResizeObserver that re-fits and resizes the remote pty,
  // so a row that took flow height would redraw the TUI on both open and close.
  const overflow = cssRuleFor(".key-bar-overflow");
  assert.match(overflow, /position: absolute;/);
  assert.match(overflow, /bottom: 100%;/);
  // Positioned against the group, so it rides the desktop reveal transform.
  assert.match(cssRuleFor(".key-bar-group"), /position: relative;/);
});
