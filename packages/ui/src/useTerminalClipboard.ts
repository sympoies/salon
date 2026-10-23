import type { Terminal } from "@xterm/xterm";
import type { ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import { uploadAttachment } from "./api.ts";
import { isMacTauri } from "./runtime.ts";
import {
  filesFromTerminalClipboardData,
  isNativeClipboardTarget,
  isTerminalClipboardActionHandled,
  readTerminalClipboardText,
  readTerminalSelection,
  resolveTerminalCopyText,
  runTerminalClipboardAction,
  terminalClipboardActionErrorMessage,
  terminalClipboardCapabilities,
  copyTerminalAsOneLine,
  terminalKeyboardClipboardAction,
  terminalPasteEventAction,
  terminalTouchClipboardAction,
  terminalUploadedFilePasteText,
  writeTerminalClipboardText,
  type TerminalClipboardAction,
} from "./terminalClipboard.ts";
import { isMacosFilePasteCandidate, readMacosClipboardFiles } from "./terminalNativeClipboard.ts";
import type { TerminalStatusController } from "./terminalUploadStatus.ts";
import type { TerminalTouchMenu } from "./terminalInstance.ts";

type MutableRef<T> = { current: T };
type StateSetter<T> = (value: T | ((current: T) => T)) => void;

interface CapturedTerminalSelection {
  readonly text: string;
  readonly at: number;
}

interface TerminalClipboardController {
  readonly visibleTouchMenu: Exclude<TerminalTouchMenu, null> | null;
  readonly canCopyTerminalSelection: boolean;
  readonly canPasteTerminalClipboard: boolean;
  readonly handleTouchMenuCopy: () => void;
  readonly handleTouchMenuCopyOneLine: () => void;
  readonly handleTouchMenuCopyLink: () => void;
  readonly handleTouchMenuPaste: () => void;
  readonly handleTerminalKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly handlePaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly handleDragOver: (event: DragEvent<HTMLDivElement>) => void;
  readonly handleDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly handleFiles: (files: readonly File[]) => Promise<void>;
}

export function useTerminalClipboard({
  allowFiles = true,
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
}: {
  readonly allowFiles?: boolean;
  readonly machine: string;
  readonly id: string;
  readonly terminalInstanceKey: string;
  readonly termRef: MutableRef<Terminal | null>;
  readonly terminalPasteInputRef: MutableRef<boolean>;
  readonly capturedSelectionRef: MutableRef<CapturedTerminalSelection>;
  readonly terminalBufferRef: MutableRef<string>;
  readonly consumeTerminalBufferRef: MutableRef<(() => void) | null>;
  readonly terminalTouchMenu: TerminalTouchMenu;
  readonly setTerminalTouchMenu: StateSetter<TerminalTouchMenu>;
  readonly statusController: TerminalStatusController;
  readonly sendTerminalText: (text: string) => void;
}): TerminalClipboardController {
  const visibleTouchMenu = terminalTouchMenu?.key === terminalInstanceKey ? terminalTouchMenu : null;
  const clipboardCapabilities = terminalClipboardCapabilities(termRef.current);
  const canCopyTerminalSelection = isTerminalClipboardActionHandled(
    terminalTouchClipboardAction({
      request: "copy",
      selection: visibleTouchMenu?.hasSelection ? "selection" : "",
      ...clipboardCapabilities,
    }),
  );
  const canPasteTerminalClipboard = isTerminalClipboardActionHandled(
    terminalTouchClipboardAction({
      request: "paste",
      selection: "",
      ...clipboardCapabilities,
    }),
  );

  const showClipboardError = (message: string) => {
    statusController.failStandalone(message);
  };

  const pasteTerminalText = (text: string) => {
    if (!text) {
      return;
    }
    // xterm synchronously normalizes paste data through onData. Preserve that
    // source context so control-looking clipboard text is not treated as a key.
    terminalPasteInputRef.current = true;
    try {
      termRef.current?.paste(text);
    } finally {
      terminalPasteInputRef.current = false;
    }
  };

  const handleFiles = async (files: readonly File[]) => {
    if (!allowFiles) { statusController.failStandalone("File upload is unavailable in Shell."); return; }
    if (files.length === 0) {
      return;
    }
    const attempt = statusController.begin(
      files.length === 1 ? "Uploading file" : `Uploading ${files.length} files`,
    );
    const paths: string[] = [];
    try {
      for (const file of files) {
        const result = await uploadAttachment(machine, id, file);
        if (!statusController.isCurrent(attempt)) {
          return;
        }
        if (!result.ok || !result.path) {
          statusController.fail(attempt, result.error ?? `Upload failed: ${file.name}`);
          return;
        }
        paths.push(result.path);
      }
    } catch {
      statusController.fail(attempt, files.length === 1 ? "Upload failed" : "Some uploads failed");
      return;
    }
    if (!statusController.isCurrent(attempt)) {
      return;
    }
    sendTerminalText(terminalUploadedFilePasteText(paths));
    statusController.succeed(
      attempt,
      files.length === 1 ? "Uploaded file" : `Uploaded ${files.length} files`,
    );
  };

  const runClipboardAction = (action: TerminalClipboardAction, onSuccess?: () => void): boolean => {
    if (!isTerminalClipboardActionHandled(action)) {
      return false;
    }
    void runTerminalClipboardAction(action, {
      writeClientText: writeTerminalClipboardText,
      readClientText: readTerminalClipboardText,
      readNativeFiles: readMacosClipboardFiles,
      pasteText: pasteTerminalText,
      uploadFiles: handleFiles,
    })
      .then(() => onSuccess?.())
      .catch(() => showClipboardError(terminalClipboardActionErrorMessage(action)));
    return true;
  };

  const selectedTerminalText = () =>
    resolveTerminalCopyText({
      currentSelection: termRef.current ? readTerminalSelection(termRef.current) : "",
      capturedSelection: capturedSelectionRef.current.text,
      capturedAgeMs: Date.now() - capturedSelectionRef.current.at,
    }) || terminalBufferRef.current;

  const handleTouchMenuCopy = () => {
    const text = selectedTerminalText();
    setTerminalTouchMenu(null);
    if (!text) {
      statusController.failStandalone("Nothing to copy — select some terminal text first");
      return;
    }
    const attempt = statusController.begin("Copying selection");
    void writeTerminalClipboardText(text)
      .then(() => statusController.succeed(attempt, `Copied ${text.length} characters`))
      .catch(() => statusController.failStandalone(terminalClipboardActionErrorMessage({ kind: "copy-selection", text })));
    capturedSelectionRef.current = { text: "", at: 0 };
    consumeTerminalBufferRef.current?.();
  };

  const handleTouchMenuCopyOneLine = () => {
    const action: TerminalClipboardAction = { kind: "copy-one-line-selection", ...copyTerminalAsOneLine(selectedTerminalText()) };
    setTerminalTouchMenu(null);
    copyOneLine(action);
  };

  const copyOneLine = (action: Extract<TerminalClipboardAction, { kind: "copy-one-line-selection" }>) => {
    capturedSelectionRef.current = { text: "", at: 0 };
    consumeTerminalBufferRef.current?.();
    if (!action.text) {
      statusController.failStandalone("Nothing to copy — select some terminal text first");
      return;
    }
    const attempt = statusController.begin("Copying as one line");
    runClipboardAction(action, () => statusController.succeed(attempt, "Copied as one line"));
  };

  const handleTouchMenuCopyLink = () => {
    // The resolved URL was captured when the menu opened, so copying works even
    // where click-to-open is disabled (mouse-tracking TUIs) and regardless of
    // how the link wraps across terminal rows.
    const url = visibleTouchMenu?.linkUrl;
    setTerminalTouchMenu(null);
    if (!url) {
      return;
    }
    const attempt = statusController.begin("Copying link");
    void writeTerminalClipboardText(url)
      .then(() => statusController.succeed(attempt, "Copied link"))
      .catch(() => statusController.failStandalone(terminalClipboardActionErrorMessage({ kind: "copy-selection", text: url })));
  };

  const handleTouchMenuPaste = () => {
    runClipboardAction(
      terminalTouchClipboardAction({
        request: "paste",
        selection: "",
        ...terminalClipboardCapabilities(termRef.current),
      }),
    );
    setTerminalTouchMenu(null);
  };

  const handleTerminalKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const selection = selectedTerminalText();
    const action = terminalKeyboardClipboardAction({
      key: event.key,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      macTauri: isMacTauri(),
      hasNativeClipboardTarget: isNativeClipboardTarget(event.target),
      selection,
      canWriteClipboard: terminalClipboardCapabilities(termRef.current).canWriteClipboard,
    });
    if (!isTerminalClipboardActionHandled(action)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (action.kind === "copy-one-line-selection") {
      copyOneLine(action);
    } else if (action.kind === "copy-selection") {
      const attempt = statusController.begin("Copying selection");
      runClipboardAction(action, () => statusController.succeed(attempt, "Copied selection"));
    } else {
      runClipboardAction(action);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = filesFromTerminalClipboardData(event.clipboardData);
    const types = Array.from(event.clipboardData.types);
    const text = event.clipboardData.getData("text");
    const canReadNativeFiles = isMacTauri();
    const action = terminalPasteEventAction({
      files,
      text,
      canPasteTerminal: Boolean(termRef.current),
      canReadNativeFiles,
      hasNativeFileCandidate: canReadNativeFiles && isMacosFilePasteCandidate(types, text),
    });
    if (runClipboardAction(action)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = filesFromTerminalClipboardData(event.dataTransfer);
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    void handleFiles(files);
  };

  return {
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
  };
}
