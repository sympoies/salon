import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { isAndroidTauri, isMacTauri } from "./runtime.ts";
import { shellQuotePathForTerminal } from "./shellQuote.ts";

export interface TerminalOneLineOutcome {
  readonly text: string;
}

export type TerminalClipboardAction =
  | { readonly kind: "copy-selection"; readonly text: string }
  | {
      readonly kind: "copy-one-line-selection";
      readonly text: string;
    }
  | { readonly kind: "paste-text"; readonly text: string }
  | { readonly kind: "read-client-text" }
  | { readonly kind: "upload-files"; readonly files: readonly File[] }
  | { readonly kind: "read-native-files" }
  | { readonly kind: "native" }
  | { readonly kind: "ignore" };

export interface TerminalKeyboardClipboardInput {
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly macTauri: boolean;
  readonly hasNativeClipboardTarget: boolean;
  readonly selection: string;
  readonly canWriteClipboard: boolean;
}

export interface TerminalTouchClipboardInput {
  readonly request: "copy" | "paste";
  readonly selection: string;
  readonly canReadClipboard: boolean;
  readonly canWriteClipboard: boolean;
  readonly canPasteTerminal: boolean;
}

export interface TerminalPasteEventActionInput {
  readonly files: readonly File[];
  readonly text: string;
  readonly canPasteTerminal: boolean;
  readonly canReadNativeFiles: boolean;
  readonly hasNativeFileCandidate: boolean;
}

interface TerminalClipboardCapabilities {
  readonly canReadClipboard: boolean;
  readonly canWriteClipboard: boolean;
  readonly canPasteTerminal: boolean;
}

export interface TerminalClipboardTextReadInput {
  readonly androidTauri: boolean;
  readonly readNativeText: () => Promise<string>;
  readonly readWebText: (() => Promise<string>) | undefined;
}

export interface TerminalClipboardTextWriteInput {
  readonly macTauri: boolean;
  readonly writeNativeText: (text: string) => Promise<void>;
  readonly writeWebText: ((text: string) => Promise<void>) | undefined;
  readonly writeFallbackText: (text: string) => void;
}

export interface TerminalClipboardActionHandlers {
  readonly writeClientText: (text: string) => Promise<void> | void;
  readonly readClientText: () => Promise<string> | string;
  readonly readNativeFiles: () => Promise<readonly File[]> | readonly File[];
  readonly pasteText: (text: string) => void;
  readonly uploadFiles: (files: readonly File[]) => Promise<void> | void;
}

interface TerminalClipboardDataTransferItem {
  readonly kind: string;
  getAsFile(): File | null;
}

interface TerminalClipboardDataTransferLike {
  readonly files?: Iterable<File> | ArrayLike<File>;
  readonly items?: Iterable<TerminalClipboardDataTransferItem> | ArrayLike<TerminalClipboardDataTransferItem>;
}

export function terminalKeyboardClipboardAction({
  key,
  metaKey,
  shiftKey,
  ctrlKey,
  altKey,
  macTauri,
  hasNativeClipboardTarget,
  selection,
  canWriteClipboard,
}: TerminalKeyboardClipboardInput): TerminalClipboardAction {
  if (!metaKey || ctrlKey || altKey) {
    return { kind: "ignore" };
  }
  const normalizedKey = key.toLowerCase();
  if (normalizedKey !== "c" && normalizedKey !== "v") {
    return { kind: "ignore" };
  }
  if (hasNativeClipboardTarget) {
    return { kind: "native" };
  }
  if (normalizedKey === "v") {
    // Let the browser/WebView produce the paste event so file payloads keep
    // their richer DataTransfer shape. TerminalPane captures that event first.
    return { kind: "native" };
  }
  if (shiftKey) {
    if (!macTauri) {
      return { kind: "ignore" };
    }
    const unwrapped = copyTerminalAsOneLine(selection);
    return { kind: "copy-one-line-selection", ...unwrapped };
  }
  if (!selection || !canWriteClipboard) {
    return { kind: "native" };
  }
  return { kind: "copy-selection", text: selection };
}

type ShellQuote = "single" | "double" | null;

interface QuotedTokenState {
  readonly quote: ShellQuote;
  readonly prefix: string | null;
  readonly kind: "url" | "path" | null;
}

function quotedTokenStateAfter(text: string, initial: QuotedTokenState): QuotedTokenState {
  let { quote, prefix, kind } = initial;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\" && quote !== "single") {
      index += 1;
      prefix = null;
      continue;
    }
    if ((char === "'" && quote !== "double") || (char === '"' && quote !== "single")) {
      quote = quote === null ? char === "'" ? "single" : "double" : null;
      prefix = quote === null ? null : "";
      kind = null;
    } else if (quote !== null && prefix !== null && kind === null) {
      prefix += char;
      if (/^https?:\/\//.test(prefix)) kind = "url";
      else if (/^(?:\/|\.{1,2}\/|~\/)/.test(prefix)) kind = "path";
      else if (!["http://", "https://", "/", "./", "../", "~/"].some(root => root.startsWith(prefix!))) prefix = null;
    }
  }
  return { quote, prefix, kind };
}

// An explicit operation on a user-selected single command or URL. Soft wraps
// have already been removed by readTerminalSelection/xterm. Hard TUI rows have
// no historical geometry: do not guess wrap points from current term.cols.
export function copyTerminalAsOneLine(text: string): TerminalOneLineOutcome {
  const rows = text.split(/\r\n|[\r\n]/).flatMap((row) => {
    // Only paired Unicode rails and complete border rows are display chrome.
    // ASCII pipes remain shell operators, and punctuation in URLs is untouched.
    if (/^\s*[┌┐└┘╭╮╰╯├┤┬┴┼─━═╔╗╚╝╠╣╦╩╬]+\s*$/u.test(row)) return [];
    const rail = row.match(/^\s*([│┃║])(.*)\1\s*$/u);
    const content = rail ? (rail[2] ?? "").replace(/^ /, "").replace(/ $/, "") : row;
    const value = content.trimEnd();
    return value.trim() ? [value] : [];
  });
  if (!rows.length) return { text: "" };
  rows[0] = rows[0]!.trimStart()
    .replace(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^$#]*[$#] +/, "")
    .replace(/^(?:[$%❯] )/, "");
  const first = rows[0]!;
  // A user-selected standalone URL is one token, including query punctuation.
  // Executable paths are commands too: never classify /bin/tool or ./script as
  // standalone paths and accidentally absorb their following arguments.
  if (/^https?:\/\//.test(first) && rows.every(row => !/\s/.test(row.trim()))) {
    return { text: rows.map(row => row.trim()).join("") };
  }

  const chunks = [first];
  let state = quotedTokenStateAfter(first, { quote: null, prefix: null, kind: null });
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!.trimStart();
    const next = rows[index]!.trimStart();
    // An odd final backslash escapes the newline outside single quotes. Keep
    // double-quoted indentation and unquoted argument boundaries.
    const slashes = previous.match(/\\+$/)?.[0].length ?? 0;
    if (slashes % 2 === 1 && state.quote !== "single") {
      const last = chunks.length - 1;
      chunks[last] = chunks[last]!.slice(0, -1);
      const indentation = rows[index]!.match(/^[ \t]*/)?.[0] ?? "";
      const prefix = state.quote === "double" ? indentation : indentation && !/\s$/.test(chunks[last]!) ? " " : "";
      chunks.push(prefix + next);
      state = quotedTokenStateAfter(prefix + next, state);
      continue;
    }
    // A quoted URL/path continues through arbitrary bytes, including '-' and
    // nested URLs in a query. Unquoted hard boundaries stay word boundaries:
    // /tmp/source/<LF>destination can be one path OR two positional arguments.
    const tokenContinuation = state.quote !== null && state.kind !== null;
    chunks.push((tokenContinuation ? "" : " ") + next);
    state = quotedTokenStateAfter((tokenContinuation ? "" : " ") + next, state);
  }
  return { text: chunks.join("") };
}

export function terminalTouchClipboardAction({
  request,
  selection,
  canReadClipboard,
  canWriteClipboard,
  canPasteTerminal,
}: TerminalTouchClipboardInput): TerminalClipboardAction {
  if (request === "copy") {
    return selection && canWriteClipboard ? { kind: "copy-selection", text: selection } : { kind: "ignore" };
  }
  return canReadClipboard && canPasteTerminal ? { kind: "read-client-text" } : { kind: "ignore" };
}

export function terminalPasteEventAction({
  files,
  text,
  canPasteTerminal,
  canReadNativeFiles,
  hasNativeFileCandidate,
}: TerminalPasteEventActionInput): TerminalClipboardAction {
  if (files.length > 0) {
    return { kind: "upload-files", files };
  }
  if (hasNativeFileCandidate) {
    return canReadNativeFiles ? { kind: "read-native-files" } : { kind: "ignore" };
  }
  if (text && canPasteTerminal) {
    return { kind: "paste-text", text };
  }
  return canReadNativeFiles ? { kind: "read-native-files" } : { kind: "native" };
}

export function isTerminalClipboardActionHandled(action: TerminalClipboardAction): boolean {
  return action.kind !== "native" && action.kind !== "ignore";
}

export function terminalClipboardActionErrorMessage(action: TerminalClipboardAction): string {
  switch (action.kind) {
    case "copy-selection":
    case "copy-one-line-selection":
      return "Clipboard copy unavailable";
    case "read-native-files":
      return "Clipboard file paste unavailable";
    case "upload-files":
      return "File upload unavailable";
    default:
      return "Clipboard paste unavailable";
  }
}

export async function runTerminalClipboardAction(
  action: TerminalClipboardAction,
  handlers: TerminalClipboardActionHandlers,
): Promise<void> {
  switch (action.kind) {
    case "copy-selection":
      await handlers.writeClientText(action.text);
      return;
    case "copy-one-line-selection":
      if (action.text) {
        await handlers.writeClientText(action.text);
      }
      return;
    case "paste-text":
      handlers.pasteText(action.text);
      return;
    case "read-client-text": {
      const text = await handlers.readClientText();
      if (text) {
        handlers.pasteText(text);
      }
      return;
    }
    case "upload-files":
      await handlers.uploadFiles(action.files);
      return;
    case "read-native-files": {
      const files = await handlers.readNativeFiles();
      if (files.length > 0) {
        await handlers.uploadFiles(files);
      }
      return;
    }
    case "native":
    case "ignore":
      return;
  }
}

export function filesFromTerminalClipboardData(data: TerminalClipboardDataTransferLike | null): File[] {
  if (!data) {
    return [];
  }
  const files = Array.from(data.files ?? []);
  // Chromium lists one pasted image in both `files` and `items` as separate File
  // objects with different lastModified values, so the items only stand in when
  // `files` is empty.
  if (files.length === 0) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== "file") {
        continue;
      }
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
  }
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function terminalUploadedFilePasteText(paths: readonly string[]): string {
  if (paths.length === 0) {
    return "";
  }
  return `${paths.map(shellQuotePathForTerminal).join(" ")} `;
}

export function terminalClipboardCapabilities(term: Terminal | null): TerminalClipboardCapabilities {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  return {
    canReadClipboard: isAndroidTauri() || typeof clipboard?.readText === "function",
    canWriteClipboard: isMacTauri() || typeof clipboard?.writeText === "function",
    canPasteTerminal: Boolean(term),
  };
}

export async function readTerminalClipboardText(input?: TerminalClipboardTextReadInput): Promise<string> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const readers = input ?? {
    androidTauri: isAndroidTauri(),
    readNativeText: async () => {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return readText();
    },
    readWebText:
      typeof clipboard?.readText === "function"
        ? () => clipboard.readText()
        : undefined,
  };
  const readText = readers.androidTauri ? readers.readNativeText : readers.readWebText;
  if (!readText) {
    throw new Error("clipboard text read is unavailable");
  }
  return readText();
}

// Read the current terminal selection as text. `term.getSelection()` can return
// empty for a selection that is still visually highlighted over a live TUI, so
// fall back to reconstructing the text from the selection's buffer range via
// `getSelectionPosition()` — which stays valid in that case.
export function readTerminalSelection(term: Terminal): string {
  const live = term.getSelection();
  if (live) {
    return live;
  }
  const pos = term.getSelectionPosition();
  if (pos) {
    const buffer = term.buffer.active;
    let extracted = "";
    for (let y = pos.start.y; y <= pos.end.y; y += 1) {
      const line = buffer.getLine(y);
      if (!line) {
        continue;
      }
      const startX = y === pos.start.y ? pos.start.x : 0;
      const endX = y === pos.end.y ? pos.end.x : line.length;
      // A soft-wrapped row continues on the next buffer row: keep it unbroken
      // and untrimmed so a URL or word crossing the wrap survives the copy,
      // matching xterm's own getSelection() semantics.
      const wrapsIntoNext = y < pos.end.y && buffer.getLine(y + 1)?.isWrapped === true;
      extracted += line.translateToString(!wrapsIntoNext, startX, endX);
      if (!wrapsIntoNext && y < pos.end.y) {
        extracted += "\n";
      }
    }
    if (extracted) {
      return extracted;
    }
  }
  // Final fallback: a native DOM selection inside the terminal. Some setups end
  // up selecting the rendered text natively rather than through xterm's model, so
  // xterm's own APIs report nothing.
  return readNativeSelectionWithin(term.element ?? null);
}

function readNativeSelectionWithin(root: HTMLElement | null): string {
  if (typeof window === "undefined" || !root) {
    return "";
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if ((anchor && root.contains(anchor)) || (focus && root.contains(focus))) {
    return selection.toString();
  }
  return "";
}

export async function writeTerminalClipboardText(
  text: string,
  input?: TerminalClipboardTextWriteInput,
): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const writers = input ?? {
    macTauri: isMacTauri(),
    writeNativeText: (value: string) => invoke<void>("write_macos_clipboard_text", { text: value }),
    writeWebText:
      typeof clipboard?.writeText === "function"
        ? (value: string) => clipboard.writeText(value)
        : undefined,
    writeFallbackText: writeTerminalClipboardTextFallback,
  };
  if (writers.macTauri) {
    await writers.writeNativeText(text);
    return;
  }
  if (writers.writeWebText) {
    await writers.writeWebText(text);
    return;
  }
  writers.writeFallbackText(text);
}

function writeTerminalClipboardTextFallback(text: string): void {
  // Fallback for contexts without the async clipboard API.
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!ok) {
    throw new Error("copy command rejected");
  }
}

// Over a live, mouse-reporting TUI (codex/claude) an xterm selection is fragile:
// a redraw or a mouse-release forwarded to the app can clear it between the drag
// and the Copy click, so `getSelection()` at click time is often empty. We snapshot
// the text the moment a selection is made and let Copy fall back to that snapshot
// while it is still fresh, so "select then Copy" works even if the highlight
// vanished first.
export const TERMINAL_CAPTURED_SELECTION_MAX_AGE_MS = 120_000;

export function resolveTerminalCopyText(input: {
  readonly currentSelection: string;
  readonly capturedSelection: string;
  readonly capturedAgeMs: number;
  readonly maxCapturedAgeMs?: number;
}): string {
  if (input.currentSelection) {
    return input.currentSelection;
  }
  const maxAge = input.maxCapturedAgeMs ?? TERMINAL_CAPTURED_SELECTION_MAX_AGE_MS;
  if (input.capturedSelection && input.capturedAgeMs >= 0 && input.capturedAgeMs <= maxAge) {
    return input.capturedSelection;
  }
  return "";
}

export function isNativeClipboardTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  if (target.closest(".xterm")) {
    return false;
  }
  return Boolean(target.closest("textarea, input, [contenteditable=true]"));
}
