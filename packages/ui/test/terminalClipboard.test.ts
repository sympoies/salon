import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Terminal } from "@xterm/xterm";
import {
  filesFromTerminalClipboardData,
  isTerminalClipboardActionHandled,
  readTerminalClipboardText,
  readTerminalSelection,
  resolveTerminalCopyText,
  runTerminalClipboardAction,
  terminalClipboardActionErrorMessage,
  terminalKeyboardClipboardAction,
  terminalPasteEventAction,
  terminalTouchClipboardAction,
  terminalUploadedFilePasteText,
  TERMINAL_CAPTURED_SELECTION_MAX_AGE_MS,
  copyTerminalAsOneLine,
  writeTerminalClipboardText,
  type TerminalClipboardActionHandlers,
} from "../src/terminalClipboard.ts";

function file(name: string, body = "x", type = "text/plain"): File {
  return new File([body], name, { type, lastModified: 1 });
}

function fakeSelectionTerminal(
  rows: readonly { readonly text: string; readonly isWrapped: boolean }[],
  selection: { start: { x: number; y: number }; end: { x: number; y: number } },
): Terminal {
  return {
    getSelection: () => "",
    getSelectionPosition: () => selection,
    element: null,
    buffer: {
      active: {
        getLine: (y: number) => {
          const row = rows[y];
          return row
            ? {
                isWrapped: row.isWrapped,
                length: row.text.length,
                translateToString(trimRight = false, startColumn = 0, endColumn = row.text.length) {
                  const value = row.text.slice(startColumn, endColumn);
                  return trimRight ? value.trimEnd() : value;
                },
              }
            : undefined;
        },
      },
    },
  } as unknown as Terminal;
}

test("readTerminalSelection keeps soft-wrapped rows unbroken in the buffer-range fallback", () => {
  const term = fakeSelectionTerminal(
    [
      { text: "https://example.test/very-lo", isWrapped: false },
      { text: "ng/path done", isWrapped: true },
      { text: "next line", isWrapped: false },
    ],
    { start: { x: 0, y: 0 }, end: { x: 9, y: 2 } },
  );

  assert.equal(readTerminalSelection(term), "https://example.test/very-long/path done\nnext line");
});

test("readTerminalSelection still separates hard rows with newlines in the fallback", () => {
  const term = fakeSelectionTerminal(
    [
      { text: "first row   ", isWrapped: false },
      { text: "second row", isWrapped: false },
    ],
    { start: { x: 0, y: 0 }, end: { x: 10, y: 1 } },
  );

  assert.equal(readTerminalSelection(term), "first row\nsecond row");
});

test("Android Tauri paste reads text from the native clipboard bridge", async () => {
  const calls: string[] = [];
  const text = await readTerminalClipboardText({
    androidTauri: true,
    readNativeText: async () => {
      calls.push("native");
      return "copied on Android";
    },
    readWebText: async () => {
      calls.push("web");
      return "wrong reader";
    },
  });

  assert.equal(text, "copied on Android");
  assert.deepEqual(calls, ["native"]);
});

test("terminal clipboard text reading preserves native failures and the Web Clipboard fallback", async () => {
  const nativeFailure = new Error("native clipboard denied");
  await assert.rejects(
    readTerminalClipboardText({
      androidTauri: true,
      readNativeText: async () => {
        throw nativeFailure;
      },
      readWebText: async () => "must not fall back after a native failure",
    }),
    nativeFailure,
  );

  const calls: string[] = [];
  const webText = await readTerminalClipboardText({
    androidTauri: false,
    readNativeText: async () => {
      calls.push("native");
      return "wrong reader";
    },
    readWebText: async () => {
      calls.push("web");
      return "copied in a browser";
    },
  });
  assert.equal(webText, "copied in a browser");
  assert.deepEqual(calls, ["web"]);
});

test("Tauri clipboard writes use the native bridge instead of the Web Clipboard API", async () => {
  const calls: string[] = [];
  await writeTerminalClipboardText("unwrapped command", {
    macTauri: true,
    writeNativeText: async (text) => calls.push(`native:${text}`),
    writeWebText: async (text) => calls.push(`web:${text}`),
    writeFallbackText: () => calls.push("fallback"),
  });

  assert.deepEqual(calls, ["native:unwrapped command"]);
});

test("resolveTerminalCopyText prefers the live selection, else a fresh capture", () => {
  // Live selection present -> use it (capture is ignored even if also present).
  assert.equal(
    resolveTerminalCopyText({ currentSelection: "live", capturedSelection: "old", capturedAgeMs: 0 }),
    "live",
  );
  // No live selection but a fresh capture -> fall back to the capture.
  assert.equal(
    resolveTerminalCopyText({ currentSelection: "", capturedSelection: "captured", capturedAgeMs: 500 }),
    "captured",
  );
  // Capture too old -> nothing to copy.
  assert.equal(
    resolveTerminalCopyText({
      currentSelection: "",
      capturedSelection: "stale",
      capturedAgeMs: TERMINAL_CAPTURED_SELECTION_MAX_AGE_MS + 1,
    }),
    "",
  );
  // Boundary: exactly at the max age is still usable.
  assert.equal(
    resolveTerminalCopyText({
      currentSelection: "",
      capturedSelection: "edge",
      capturedAgeMs: TERMINAL_CAPTURED_SELECTION_MAX_AGE_MS,
    }),
    "edge",
  );
  // No selection anywhere -> empty. A negative age (clock skew) is not trusted.
  assert.equal(resolveTerminalCopyText({ currentSelection: "", capturedSelection: "", capturedAgeMs: 0 }), "");
  assert.equal(
    resolveTerminalCopyText({ currentSelection: "", capturedSelection: "skew", capturedAgeMs: -5 }),
    "",
  );
});

test("keyboard clipboard actions keep Cmd+C/Cmd+V on the client clipboard surface", () => {
  const base = {
    key: "c",
    metaKey: true,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    macTauri: true,
    hasNativeClipboardTarget: false,
    selection: "selected text",
    canWriteClipboard: true,
  };

  assert.deepEqual(terminalKeyboardClipboardAction(base), {
    kind: "copy-selection",
    text: "selected text",
  });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, selection: "" }), { kind: "native" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, canWriteClipboard: false }), { kind: "native" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, key: "v" }), { kind: "native" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, ctrlKey: true }), { kind: "ignore" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, key: "x" }), { kind: "ignore" });
});

test("Cmd+Shift+C copies as one line while Cmd+C stays literal", () => {
  const selection = "$ git -C ~/repo\n  status --short\n";
  const base = {
    key: "c", metaKey: true, shiftKey: false, ctrlKey: false, altKey: false,
    macTauri: true, hasNativeClipboardTarget: false, selection, canWriteClipboard: true,
  };
  assert.deepEqual(terminalKeyboardClipboardAction(base), { kind: "copy-selection", text: selection });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, shiftKey: true }), {
    kind: "copy-one-line-selection", ...copyTerminalAsOneLine(selection),
  });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, shiftKey: true, selection: "" }), {
    kind: "copy-one-line-selection", text: "",
  });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, shiftKey: true, macTauri: false }), { kind: "ignore" });
  assert.deepEqual(terminalKeyboardClipboardAction({ ...base, shiftKey: true, hasNativeClipboardTarget: true }), { kind: "native" });
});

test("paste event actions prefer files, preserve macOS native file paste, then paste text", () => {
  const dropped = file("drop.txt");
  assert.deepEqual(
    terminalPasteEventAction({
      files: [dropped],
      text: "",
      canPasteTerminal: true,
      canReadNativeFiles: false,
      hasNativeFileCandidate: false,
    }),
    { kind: "upload-files", files: [dropped] },
  );

  assert.deepEqual(
    terminalPasteEventAction({
      files: [],
      text: "file:///Users/Shared/Downloads/a.txt",
      canPasteTerminal: true,
      canReadNativeFiles: true,
      hasNativeFileCandidate: true,
    }),
    { kind: "read-native-files" },
  );

  assert.deepEqual(
    terminalPasteEventAction({
      files: [],
      text: "hello",
      canPasteTerminal: true,
      canReadNativeFiles: true,
      hasNativeFileCandidate: false,
    }),
    { kind: "paste-text", text: "hello" },
  );

  assert.deepEqual(
    terminalPasteEventAction({
      files: [],
      text: "",
      canPasteTerminal: true,
      canReadNativeFiles: true,
      hasNativeFileCandidate: false,
    }),
    { kind: "read-native-files" },
  );
});

test("touch clipboard actions use the same executable action contract", () => {
  assert.deepEqual(
    terminalTouchClipboardAction({
      request: "copy",
      selection: "touch selection",
      canReadClipboard: true,
      canWriteClipboard: true,
      canPasteTerminal: true,
    }),
    { kind: "copy-selection", text: "touch selection" },
  );
  assert.deepEqual(
    terminalTouchClipboardAction({
      request: "paste",
      selection: "",
      canReadClipboard: true,
      canWriteClipboard: true,
      canPasteTerminal: true,
    }),
    { kind: "read-client-text" },
  );
});

test("terminal clipboard action runner centralizes copy, text paste, and upload execution", async () => {
  const calls: string[] = [];
  const uploaded = file("paste.txt");
  const handlers: TerminalClipboardActionHandlers = {
    writeClientText: async (text) => calls.push(`copy:${text}`),
    readClientText: async () => "client text",
    readNativeFiles: async () => [uploaded],
    pasteText: (text) => calls.push(`paste:${text}`),
    uploadFiles: async (files) => calls.push(`upload:${files.map((entry) => entry.name).join(",")}`),
  };

  await runTerminalClipboardAction({ kind: "copy-selection", text: "abc" }, handlers);
  await runTerminalClipboardAction(
    { kind: "copy-one-line-selection", text: "unwrapped" },
    handlers,
  );
  await runTerminalClipboardAction(
    { kind: "copy-one-line-selection", text: "" },
    handlers,
  );
  await runTerminalClipboardAction({ kind: "paste-text", text: "direct paste" }, handlers);
  await runTerminalClipboardAction({ kind: "upload-files", files: [file("drop.txt")] }, handlers);
  await runTerminalClipboardAction({ kind: "read-client-text" }, handlers);
  await runTerminalClipboardAction({ kind: "read-native-files" }, handlers);

  assert.deepEqual(calls, [
    "copy:abc",
    "copy:unwrapped",
    "paste:direct paste",
    "upload:drop.txt",
    "paste:client text",
    "upload:paste.txt",
  ]);
  assert.equal(isTerminalClipboardActionHandled({ kind: "paste-text", text: "x" }), true);
  assert.equal(isTerminalClipboardActionHandled({ kind: "native" }), false);
  assert.equal(terminalClipboardActionErrorMessage({ kind: "copy-selection", text: "x" }), "Clipboard copy unavailable");
  assert.equal(terminalClipboardActionErrorMessage({ kind: "copy-one-line-selection", text: "x" }), "Clipboard copy unavailable");
  assert.equal(terminalClipboardActionErrorMessage({ kind: "read-native-files" }), "Clipboard file paste unavailable");
});

test("terminal clipboard data extraction deduplicates files from files and items", () => {
  const pasted = file("same.txt");
  const other = file("other.txt");
  const data = {
    files: [pasted, other],
    items: [
      { kind: "file", getAsFile: () => pasted },
      { kind: "string", getAsFile: () => null },
    ],
  };

  assert.deepEqual(filesFromTerminalClipboardData(data), [pasted, other]);
});

// #1067: Chromium hands one pasted image over twice, as `files` and as a file item, and the two
// File objects carry different lastModified values.
test("terminal clipboard data extraction takes one image that Chromium lists in files and in items", () => {
  const inFiles = new File(["png"], "image.png", { type: "image/png", lastModified: 1_000 });
  const inItems = new File(["png"], "image.png", { type: "image/png", lastModified: 2_000 });
  const data = {
    files: [inFiles],
    items: [
      { kind: "file", getAsFile: () => inItems },
      { kind: "string", getAsFile: () => null },
    ],
  };

  assert.deepEqual(filesFromTerminalClipboardData(data), [inFiles]);
  assert.deepEqual(
    terminalPasteEventAction({
      files: filesFromTerminalClipboardData(data),
      text: "",
      canPasteTerminal: true,
      canReadNativeFiles: false,
      hasNativeFileCandidate: false,
    }),
    { kind: "upload-files", files: [inFiles] },
  );
});

test("terminal clipboard data extraction keeps distinct files that share a name and size", () => {
  const first = new File(["aaa"], "image.png", { type: "image/png", lastModified: 1_000 });
  const second = new File(["bbb"], "image.png", { type: "image/png", lastModified: 2_000 });
  const data = {
    files: [first, second],
    items: [
      { kind: "file", getAsFile: () => new File(["aaa"], "image.png", { type: "image/png", lastModified: 3_000 }) },
      { kind: "file", getAsFile: () => new File(["bbb"], "image.png", { type: "image/png", lastModified: 4_000 }) },
    ],
  };

  assert.deepEqual(filesFromTerminalClipboardData(data), [first, second]);
});

test("terminal clipboard data extraction falls back to file items when files is empty", () => {
  const pasted = file("item.png", "png", "image/png");
  const data = {
    files: [],
    items: [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => pasted },
      { kind: "file", getAsFile: () => null },
    ],
  };

  assert.deepEqual(filesFromTerminalClipboardData(data), [pasted]);
  assert.deepEqual(filesFromTerminalClipboardData({ items: data.items }), [pasted]);
  assert.deepEqual(filesFromTerminalClipboardData({ files: [], items: [] }), []);
  assert.deepEqual(filesFromTerminalClipboardData(null), []);
});

test("uploaded file paste text quotes remote paths and keeps a trailing space", () => {
  assert.equal(
    terminalUploadedFilePasteText(["/tmp/plain.txt", "/tmp/Project agent/file's name.txt"]),
    "'/tmp/plain.txt' '/tmp/Project agent/file'\\''s name.txt' ",
  );
  assert.equal(terminalUploadedFilePasteText([]), "");
});
