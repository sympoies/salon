import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { createElement, type ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Plugin } from "vite";
import type { TerminalPaneProps } from "../src/TerminalPane.tsx";
import { assertNoElement } from "./support/domAssert.ts";
import { createUiSsrHarness, type UiSsrHarness } from "./support/ssr.ts";

type Rect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
};

type FakeSubscription = { dispose(): void };

type FakeTerminal = {
  readonly options: Record<string, unknown>;
  readonly writes: Array<string | Uint8Array>;
  readonly pastes: string[];
  readonly resizeFrames: Array<{ cols: number; rows: number }>;
  readonly loadedAddons: unknown[];
  readonly linkProviders: Array<{
    provideLinks(line: number, callback: (links: unknown[] | undefined) => void): void;
  }>;
  readonly parser: { registerCsiHandler(): boolean };
  readonly modes: { mouseTrackingMode: string };
  readonly buffer: {
    readonly active: {
      type: "normal" | "alternate";
      baseY: number;
      viewportY: number;
      length: number;
      getLine(row: number): unknown;
    };
  };
  cols: number;
  rows: number;
  element: HTMLElement | null;
  disposed: boolean;
  focused: number;
  blurred: number;
  bufferLineReads: number;
  bufferLineTranslations: number;
  refreshed: Array<{ start: number; end: number }>;
  scrollLinesCalls: number[];
  visibleRows: string[];
  scrollBottomCalls: number;
  linkProviderDisposals: number;
  oscTouchTarget: string | null;
  oscTouchActivates: boolean;
  oscTouchCells: string[];
  oscTouchRange: { start: { x: number; y: number }; end: { x: number; y: number } };
  selection: string;
  openHost: HTMLElement | null;
  loadAddon(addon: unknown): void;
  registerLinkProvider(provider: FakeTerminal["linkProviders"][number]): FakeSubscription;
  open(host: HTMLElement): void;
  focus(): void;
  blur(): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  paste(text: string): void;
  resize(cols: number, rows: number): void;
  refresh(start: number, end: number): void;
  scrollLines(lines: number): void;
  scrollToBottom(): void;
  hasSelection(): boolean;
  getSelection(): string;
  getSelectionPosition(): null;
  clearSelection(): void;
  select(start: number, row: number, length: number): void;
  dispose(): void;
  onData(callback: (data: string) => void): FakeSubscription;
  onSelectionChange(callback: () => void): FakeSubscription;
  onScroll(callback: (position: number) => void): FakeSubscription;
  onWriteParsed(callback: () => void): FakeSubscription;
  onRender(callback: (event: { start: number; end: number }) => void): FakeSubscription;
  emitData(data: string): void;
  emitRender(start?: number, end?: number): void;
  setVisibleRows(rows: string[]): void;
  emitSelectionChange(): void;
};

type FakeTransport = {
  readonly sentInputs: unknown[];
  readonly resizeFrames: Array<{ cols: number; rows: number }>;
  readonly options: {
    shouldReconnect(): boolean;
    reconnectDelayOffsetMs(): number;
    setStatus(status: string): void;
    onOpen?: () => void;
    onOutputActivity?: () => void;
    onMessageData?: (data: string | Uint8Array) => void;
    onProviderPromptCapability?: (capability: "pending" | "supported" | "fallback") => void;
    onProviderPromptEvent?: (event: {
      kind: "prompt_submitted";
      eventId: string;
      provider: "codex" | "claude";
      submittedAt: string;
      text: string;
      truncated: boolean;
    }) => void;
    onInputRejected?: (rejection: {
      code?: string;
      message?: string;
      retryable: boolean;
      outcomeUnknown?: boolean;
    }) => void;
  };
  connectCalls: number;
  wakeCalls: number;
  disposed: boolean;
  connect(): Promise<void>;
  dispose(): void;
  sendInput(body: unknown): Promise<void>;
  sendResize(cols: number, rows: number): void;
  currentWebSocket(): null;
  emitOpen(): void;
  emitMessage(data: string | Uint8Array): void;
  emitProviderPromptCapability(capability: "pending" | "supported" | "fallback"): void;
  emitProviderPromptEvent(event: {
    kind: "prompt_submitted";
    eventId: string;
    provider: "codex" | "claude";
    submittedAt: string;
    text: string;
    truncated: boolean;
  }): void;
  emitInputRejected(rejection: {
    code?: string;
    message?: string;
    retryable: boolean;
    outcomeUnknown?: boolean;
  }): void;
};

type HarnessState = {
  terminals: FakeTerminal[];
  transports: FakeTransport[];
  performanceFrames: Array<{ readonly mode: string; readonly focused: boolean; readonly unitCount: number }>;
  performanceWrites: Array<{ readonly mode: string; readonly reason: string; readonly frameCount: number }>;
  protocolChecks: number;
  fallbackInputs: unknown[];
  uploadedFiles: unknown[];
  uploadResponses: Array<{ ok: boolean; path?: string; error?: string; delayMs?: number }>;
  clipboardModelResponses: Array<{
    result: { kind: "none" } | { kind: "shell" | "url" | "path"; text: string; assessment: "complete" | "needs_review" } | null;
    reason?: string;
  }>;
  clipboardModelRequests: Array<{ machine: string; selection: string }>;
  sessionBuffer: string;
  sessionBufferResponses: Array<{ text: string; delayMs?: number }>;
};

type ClipboardState = {
  writes: string[];
  readTextValue: string;
  readTextError?: Error;
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
};

type MountedPane = {
  readonly container: HTMLElement;
  readonly harness: HarnessState;
  readonly clipboard: ClipboardState;
  readonly ssr: UiSsrHarness;
  readonly root: Root;
  readonly window: Window;
  rerender(props: Partial<TerminalPaneProps>): Promise<void>;
  unmount(): Promise<void>;
};

const cleanupStack: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupStack.length > 0) {
    await cleanupStack.pop()?.();
  }
});

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function setGlobal(name: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, name, previous);
      return;
    }
    delete (globalThis as Record<string, unknown>)[name];
  };
}

function createClipboard(): ClipboardState {
  return {
    writes: [],
    readTextValue: "",
    async writeText(text: string) {
      this.writes.push(text);
    },
    async readText() {
      if (this.readTextError) {
        throw this.readTextError;
      }
      return this.readTextValue;
    },
  };
}

function installDom(): { window: Window; clipboard: ClipboardState; cleanup(): Promise<void> } {
  const window = new Window({ url: "http://localhost", width: 900, height: 600 });
  const document = window.document;
  const clipboard = createClipboard();
  const restoreGlobals = [
    setGlobal("window", window),
    setGlobal("document", document),
    setGlobal("navigator", window.navigator),
    setGlobal("Element", window.Element),
    setGlobal("HTMLElement", window.HTMLElement),
    setGlobal("MouseEvent", window.MouseEvent),
    setGlobal("WheelEvent", window.WheelEvent),
    setGlobal("Event", window.Event),
    setGlobal("File", window.File),
    setGlobal("DataTransfer", window.DataTransfer),
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true),
  ];

  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: async () => [] },
  });
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });

  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    observed: Element[] = [];
    disconnected = false;
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      FakeResizeObserver.instances.push(this);
    }
    observe(target: Element) {
      this.observed.push(target);
    }
    unobserve(target: Element) {
      this.observed = this.observed.filter((entry) => entry !== target);
    }
    disconnect() {
      this.disconnected = true;
      this.observed = [];
    }
  }

  Object.defineProperty(window, "ResizeObserver", { configurable: true, value: FakeResizeObserver });
  restoreGlobals.push(setGlobal("ResizeObserver", FakeResizeObserver));

  const getBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function getTestRect() {
    if (this.classList.contains("terminal-pane")) {
      return rect(0, 0, 820, 520) as DOMRect;
    }
    if (this.classList.contains("term-host")) {
      return rect(0, 0, 800, 480) as DOMRect;
    }
    if (this.classList.contains("xterm-screen")) {
      return rect(10, 20, 800, 400) as DOMRect;
    }
    return getBoundingClientRect.call(this);
  };

  return {
    window,
    clipboard,
    async cleanup() {
      window.HTMLElement.prototype.getBoundingClientRect = getBoundingClientRect;
      for (const restore of restoreGlobals.reverse()) {
        restore();
      }
      await window.happyDOM.close();
    },
  };
}

function createHarnessState(): HarnessState {
  return {
    terminals: [],
    transports: [],
    performanceFrames: [],
    performanceWrites: [],
    protocolChecks: 0,
    fallbackInputs: [],
    uploadedFiles: [],
    uploadResponses: [],
    clipboardModelResponses: [],
    clipboardModelRequests: [],
    sessionBuffer: "",
    sessionBufferResponses: [],
  };
}

function terminalPaneHarnessPlugin(): Plugin {
  const xtermId = "\0terminal-pane-xterm";
  const fitId = "\0terminal-pane-fit-addon";
  const xtermCssId = "\0terminal-pane-xterm-css";
  const transportId = "\0terminal-pane-transport";
  const apiId = "\0terminal-pane-api";
  const performanceId = "\0terminal-pane-performance";
  const protocolId = "\0terminal-pane-protocol";

  return {
    name: "terminal-pane-behavioral-harness",
    enforce: "pre",
    resolveId(source, importer) {
      const isTerminalInstanceImport =
        importer?.includes("/src/TerminalPane.tsx") ||
        importer?.includes("/src/terminalInstance.ts") ||
        importer?.includes("/src/useTerminalClipboard.ts");
      if (source === "@xterm/xterm") return xtermId;
      if (source === "@xterm/addon-fit") return fitId;
      if (source === "@xterm/xterm/css/xterm.css") return xtermCssId;
      if (source.endsWith("terminalTransport.ts") && isTerminalInstanceImport) return transportId;
      if (source.endsWith("api.ts") && isTerminalInstanceImport) return apiId;
      if (source.endsWith("terminalPerformance.ts") && importer?.includes("/src/terminalInstance.ts")) return performanceId;
      if (source.endsWith("terminalProtocol.ts") && importer?.includes("/src/terminalInstance.ts")) return protocolId;
      return null;
    },
    load(id) {
      if (id === xtermCssId) return "export default undefined;";
      if (id === fitId) {
        return `
          export class FitAddon {
            fitCalls = 0;
            terminal = null;
            fit() {
              this.fitCalls += 1;
              if (this.terminal) {
                this.terminal.cols = 100;
                this.terminal.rows = 30;
              }
            }
          }
        `;
      }
      if (id === xtermId) {
        return `
          const harness = () => globalThis.__terminalPaneHarness;
          function subscription(list, callback) {
            list.push(callback);
            return { dispose: () => {
              const index = list.indexOf(callback);
              if (index >= 0) list.splice(index, 1);
            } };
          }
          export class Terminal {
            constructor(options) {
              this.options = options;
              this.cols = 80;
              this.rows = 24;
              this.element = null;
              this.disposed = false;
              this.focused = 0;
              this.blurred = 0;
              this.bufferLineReads = 0;
              this.bufferLineTranslations = 0;
              this.writes = [];
              this.pastes = [];
              this.resizeFrames = [];
              this.loadedAddons = [];
              this.linkProviders = [];
              this.refreshed = [];
              this.scrollLinesCalls = [];
              this.visibleRows = Array.from({ length: this.rows }, (_, index) => "row-" + index);
              this.scrollBottomCalls = 0;
              this.linkProviderDisposals = 0;
              this.oscTouchTarget = null;
              this.oscTouchActivates = true;
              // Cells xterm's own resolution covers. A real link range spans
              // every cell of the hyperlink, including continuation rows and
              // label characters that are not URL text. The range it reports
              // is independent of them: a wrapped link spans rows, and a
              // lagging resolution can report a range the pressed cell is
              // outside of.
              this.oscTouchCells = ["100:100"];
              this.oscTouchRange = { start: { x: 1, y: 7 }, end: { x: 80, y: 7 } };
              this.oscLastMoveCell = null;
              this.oscCurrentLink = false;
              this.selection = "";
              this.openHost = null;
              this.dataHandlers = [];
              this.selectionHandlers = [];
              this.scrollHandlers = [];
              this.writeParsedHandlers = [];
              this.renderHandlers = [];
              this.parser = { registerCsiHandler: () => true };
              this.modes = { mouseTrackingMode: "none" };
              this.buffer = {
                active: {
                  type: "normal",
                  baseY: 0,
                  viewportY: 0,
                  length: this.rows,
                  getLine: (row) => {
                    this.bufferLineReads += 1;
                    const text = this.visibleRows[row] ?? "";
                    return {
                      isWrapped: false,
                      length: text.length,
                      translateToString: () => {
                        this.bufferLineTranslations += 1;
                        return text;
                      },
                      getCell: (col) => ({ getChars: () => text[col] ?? "", getWidth: () => 1 }),
                    };
                  },
                },
              };
              harness().terminals.push(this);
            }
            loadAddon(addon) {
              this.loadedAddons.push(addon);
              addon.terminal = this;
            }
            registerLinkProvider(provider) {
              this.linkProviders.push(provider);
              return { dispose: () => { this.linkProviderDisposals += 1; } };
            }
            open(host) {
              this.openHost = host;
              const element = document.createElement("div");
              element.className = "xterm";
              const textarea = document.createElement("textarea");
              textarea.className = "xterm-helper-textarea";
              const viewport = document.createElement("div");
              viewport.className = "xterm-viewport";
              const screen = document.createElement("div");
              screen.className = "xterm-screen";
              const rows = document.createElement("div");
              rows.className = "xterm-rows";
              screen.append(rows);
              element.append(textarea, viewport, screen);
              // Mirror xterm 6's wiring exactly: the Linkifier that fires the
              // link handler's hover/leave/activate listens on the
              // .xterm-screen DESCENDANT, never on .xterm itself - events
              // dispatched at the ancestor must not reach these handlers.
              screen.addEventListener("mousemove", (event) => {
                const cell = event.clientX + ":" + event.clientY;
                if (cell === this.oscLastMoveCell) return;
                this.oscLastMoveCell = cell;
                const overLink = Boolean(this.oscTouchTarget) && this.oscTouchCells.includes(cell);
                const range = this.oscTouchRange;
                if (overLink && !this.oscCurrentLink) {
                  this.options.linkHandler?.hover?.(event, this.oscTouchTarget, range);
                } else if (!overLink && this.oscCurrentLink) {
                  this.options.linkHandler?.leave?.(event, this.oscTouchTarget, range);
                }
                this.oscCurrentLink = overLink;
              });
              screen.addEventListener("mouseleave", (event) => {
                if (this.oscCurrentLink && this.oscTouchTarget) {
                  this.options.linkHandler?.leave?.(event, this.oscTouchTarget, this.oscTouchRange);
                }
                this.oscCurrentLink = false;
              });
              screen.addEventListener("mouseup", (event) => {
                // oscTouchActivates models the half of xterm's behaviour the
                // synthetic click cannot be relied on for: hover resolves the
                // target, but the press never activates the link. That is what
                // a device tap looks like, and the reason a pane with no mouse
                // tracking cannot lean on this path alone.
                if (!this.oscTouchActivates) {
                  return;
                }
                if (this.oscCurrentLink && this.oscTouchTarget && this.options.linkHandler) {
                  this.options.linkHandler.activate(event, this.oscTouchTarget, {
                    start: { x: 1, y: 1 },
                    end: { x: 10, y: 1 },
                  });
                }
              });
              host.appendChild(element);
              this.element = element;
            }
            focus() { this.focused += 1; }
            blur() { this.blurred += 1; }
            write(data, callback) {
              this.writes.push(data);
              callback?.();
            }
            paste(text) {
              this.pastes.push(text);
              this.emitData(text);
            }
            resize(cols, rows) {
              this.cols = cols;
              this.rows = rows;
              this.resizeFrames.push({ cols, rows });
            }
            refresh(start, end) { this.refreshed.push({ start, end }); }
            scrollLines(lines) { this.scrollLinesCalls.push(lines); }
            scrollToBottom() { this.scrollBottomCalls += 1; }
            hasSelection() { return this.selection.length > 0; }
            getSelection() { return this.selection; }
            getSelectionPosition() { return null; }
            clearSelection() { this.selection = ""; }
            select(_start, _row, length) { this.selection = "x".repeat(length); }
            dispose() { this.disposed = true; }
            onData(callback) { return subscription(this.dataHandlers, callback); }
            onSelectionChange(callback) { return subscription(this.selectionHandlers, callback); }
            onScroll(callback) { return subscription(this.scrollHandlers, callback); }
            onWriteParsed(callback) { return subscription(this.writeParsedHandlers, callback); }
            onRender(callback) { return subscription(this.renderHandlers, callback); }
            emitData(data) { for (const callback of [...this.dataHandlers]) callback(data); }
            emitRender(start = 0, end = this.rows - 1) {
              for (const callback of [...this.renderHandlers]) callback({ start, end });
            }
            setVisibleRows(rows) {
              this.visibleRows.splice(0, this.visibleRows.length, ...rows);
              this.buffer.active.length = this.visibleRows.length;
            }
            emitSelectionChange() { for (const callback of [...this.selectionHandlers]) callback(); }
          }
        `;
      }
      if (id === transportId) {
        return `
          const harness = () => globalThis.__terminalPaneHarness;
          export function backgroundReconnectOffsetMs() { return 1_500; }
          export function createTerminalTransportController(options) {
            const controller = {
              options,
              connectCalls: 0,
              disposed: false,
              sentInputs: [],
              resizeFrames: [],
              wakeCalls: 0,
              async connect() { this.connectCalls += 1; },
              wake() { this.wakeCalls += 1; },
              dispose() { this.disposed = true; },
              async sendInput(body) { this.sentInputs.push(body); },
              sendResize(cols, rows) { this.resizeFrames.push({ cols, rows }); },
              currentWebSocket() { return null; },
              emitOpen() {
                options.setStatus("open");
                options.onOpen?.();
              },
              emitMessage(data) {
                options.onMessageData?.(data);
              },
              emitProviderPromptCapability(capability) {
                options.onProviderPromptCapability?.(capability);
              },
              emitProviderPromptEvent(event) {
                options.onProviderPromptEvent?.(event);
              },
              emitInputRejected(rejection) {
                options.onInputRejected?.(rejection);
              },
            };
            harness().transports.push(controller);
            return controller;
          }
        `;
      }
      if (id === performanceId) {
        return `
          const harness = () => globalThis.__terminalPaneHarness;
          export function registerTerminalPerformancePane() { return () => undefined; }
          export function recordTerminalPerformanceFrame(frame) { harness().performanceFrames.push(frame); }
          export function recordTerminalPerformanceWrite(write) { harness().performanceWrites.push(write); }
        `;
      }
      if (id === protocolId) {
        return `
          const harness = () => globalThis.__terminalPaneHarness;
          export function createTerminalProtocolGuard() {
            return { requiresImmediateWrite(data) {
              harness().protocolChecks += 1;
              const text = typeof data === "string" ? data : String.fromCharCode(...data);
              return text.includes("\\u001b[6n");
            } };
          }
        `;
      }
      if (id === apiId) {
        return `
          const harness = () => globalThis.__terminalPaneHarness;
          export async function attachTarget(machine, id) {
            return { url: "ws://example.invalid/" + machine + "/" + id, protocols: undefined };
          }
          export async function shellAttachTarget(machine, id) { return { url:"ws://example.invalid/shells/" + machine + "/" + id }; }
          export async function fetchSessionBuffer() {
            const response = harness().sessionBufferResponses.shift() ?? { text: harness().sessionBuffer };
            if (response.delayMs) {
              await new Promise((resolve) => setTimeout(resolve, response.delayMs));
            }
            return response.text;
          }
          export async function sendSessionInput(machine, id, body) {
            harness().fallbackInputs.push({ machine, id, body });
            return { ok: true };
          }
          export async function uploadAttachment(machine, id, file) {
            harness().uploadedFiles.push({ machine, id, name: file.name });
            const response = harness().uploadResponses.shift() ?? { ok: true, path: "/tmp/" + file.name };
            if (response.delayMs) {
              await new Promise((resolve) => setTimeout(resolve, response.delayMs));
            }
            return response;
          }
          export async function unwrapClipboardWithModel(machine, selection) {
            harness().clipboardModelRequests.push({ machine, selection });
            return harness().clipboardModelResponses.shift() ?? { result: null, reason: "unknown" };
          }
        `;
      }
      return null;
    },
  };
}

async function flushAsync(ms = 0): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.resolve();
}

async function mountTerminalPane(
  props: Partial<TerminalPaneProps> = {},
  configureWindow?: (window: Window) => void,
): Promise<MountedPane> {
  const dom = installDom();
  cleanupStack.push(dom.cleanup);
  configureWindow?.(dom.window);
  const harness = createHarnessState();
  (globalThis as unknown as { __terminalPaneHarness: HarnessState }).__terminalPaneHarness = harness;
  cleanupStack.push(() => {
    delete (globalThis as unknown as { __terminalPaneHarness?: HarnessState }).__terminalPaneHarness;
  });

  const ssr = createUiSsrHarness({
    plugins: [terminalPaneHarnessPlugin()],
    ssr: { noExternal: ["@xterm/xterm", "@xterm/addon-fit"] },
  });
  cleanupStack.push(() => ssr.close());
  const module = await ssr.loadModule<{ TerminalPane: ComponentType<TerminalPaneProps> }>("/src/TerminalPane.tsx");
  const rootEl = document.createElement("div");
  document.body.appendChild(rootEl);
  const root = createRoot(rootEl);

  let currentProps: TerminalPaneProps = {
    machine: "summit",
    id: "hs-1",
    autoFocus: true,
    scrollback: 123,
    onTurnOutput: () => undefined,
    ...props,
  };
  const renderCurrent = async (settleMs = 0) => {
    await act(async () => {
      root.render(createElement(module.TerminalPane, currentProps));
      await flushAsync(settleMs);
    });
  };
  await renderCurrent();

  const mounted: MountedPane = {
    container: rootEl,
    harness,
    clipboard: dom.clipboard,
    ssr,
    root,
    window: dom.window,
    async rerender(next: Partial<TerminalPaneProps>) {
      currentProps = { ...currentProps, ...next };
      // Give the bottom-pin settle timers time to run so scroll effects land.
      await renderCurrent(80);
    },
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushAsync();
      });
    },
  };
  cleanupStack.push(() => mounted.unmount());
  return mounted;
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((entry) => entry.textContent === name);
  assert.ok(button, `missing ${name} button`);
  return button as HTMLButtonElement;
}

function fileTransfer(files: readonly File[]) {
  return {
    files,
    items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
    types: ["Files"],
    getData: () => "",
  };
}

function dispatchFilePaste(mounted: MountedPane, files: readonly File[]): Event {
  const pane = mounted.container.querySelector(".terminal-pane");
  assert.ok(pane, "terminal pane was rendered");
  const event = new mounted.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { configurable: true, value: fileTransfer(files) });
  pane.dispatchEvent(event);
  return event;
}

function dispatchFileDrop(mounted: MountedPane, files: readonly File[]): Event {
  const pane = mounted.container.querySelector(".terminal-pane");
  assert.ok(pane, "terminal pane was rendered");
  const event = new mounted.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { configurable: true, value: fileTransfer(files) });
  pane.dispatchEvent(event);
  return event;
}

function enableMacTauri(mounted: MountedPane): void {
  Object.defineProperty(mounted.window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args: { text?: string }) => {
        assert.equal(command, "write_macos_clipboard_text");
        await mounted.window.navigator.clipboard.writeText(args.text ?? "");
      },
    },
  });
  Object.defineProperty(mounted.window.navigator, "platform", { configurable: true, value: "MacIntel" });
}

function dispatchTerminalCopyShortcut(mounted: MountedPane, shiftKey: boolean): KeyboardEvent {
  const textarea = mounted.container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  assert.ok(textarea, "xterm helper textarea was rendered");
  const event = new mounted.window.KeyboardEvent("keydown", {
    key: "c",
    metaKey: true,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  textarea.dispatchEvent(event);
  return event as unknown as KeyboardEvent;
}

test("TerminalPane lifecycle creates one terminal, routes input/output, resizes, and tears down", async () => {
  const outputEvents: string[] = [];
  const mounted = await mountTerminalPane({ onTurnOutput: () => outputEvents.push("output") });
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");

  assert.equal(terminal.options.scrollback, 123);
  assert.equal(terminal.openHost?.className, "term-host");
  assert.equal(terminal.loadedAddons.length, 1);
  assert.equal(terminal.linkProviders.length, 1);
  assert.equal(typeof terminal.options.linkHandler, "object");
  assert.equal(terminal.focused, 1);
  assert.equal(transport.connectCalls, 1);

  terminal.emitData("pwd\n");
  assert.deepEqual(transport.sentInputs, [{ text: "pwd\n" }]);

  transport.options.onOutputActivity?.();
  assert.deepEqual(outputEvents, ["output"]);

  await act(async () => {
    transport.emitMessage("hello");
    await flushAsync();
  });
  assert.deepEqual(terminal.writes, ["hello"]);
  assert.ok(terminal.refreshed.length > 0, "fit/write refreshed visible rows");

  await act(async () => {
    transport.emitOpen();
    await flushAsync(80);
  });
  assert.deepEqual(transport.resizeFrames.at(-1), { cols: 100, rows: 30 });

  await mounted.unmount();
  assert.equal(terminal.linkProviderDisposals, 1);
  assert.equal(transport.disposed, true);
  assert.equal(terminal.disposed, true);
});

test("a focused TerminalPane wakes its transport as soon as its machine is reachable again", async () => {
  const mounted = await mountTerminalPane({ machineReachable: true });
  const transport = mounted.harness.transports[0];
  assert.ok(transport, "transport was created");

  await mounted.rerender({ machineReachable: false });
  assert.equal(transport.wakeCalls, 0, "an outage itself does not wake the pane");

  await mounted.rerender({ machineReachable: true });
  await flushAsync(20); // the zero-delay wake is queued by the effect that closes the render
  assert.equal(transport.wakeCalls, 1);

  await mounted.rerender({ machineReachable: true });
  await flushAsync(20);
  assert.equal(transport.wakeCalls, 1, "staying reachable does not wake again");
  assert.equal(mounted.harness.transports.length, 1, "recovery keeps the same transport");
});

test("an unfocused TerminalPane wakes after its stable offset, and not after a new outage", async () => {
  const mounted = await mountTerminalPane({ autoFocus: false, machineReachable: false });
  const transport = mounted.harness.transports[0];
  assert.ok(transport, "transport was created");

  // Recovered, then unavailable again before the 1.5 s offset elapsed.
  await mounted.rerender({ machineReachable: true });
  await mounted.rerender({ machineReachable: false });
  await flushAsync(1_600);
  assert.equal(transport.wakeCalls, 0, "a recovery that did not last must not wake the pane");

  await mounted.rerender({ machineReachable: true });
  assert.equal(transport.wakeCalls, 0, "unfocused panes keep their offset");
  await flushAsync(1_600);
  assert.equal(transport.wakeCalls, 1);
});

test("TerminalPane batches background output and flushes it when the pane becomes focused", async () => {
  const mounted = await mountTerminalPane({
    autoFocus: false,
    renderMode: "focus-aware-balanced",
  });
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");
  assert.equal(transport.options.shouldReconnect(), true, "a mounted background pane remains reconnectable");
  assert.equal(transport.options.reconnectDelayOffsetMs(), 1_500);

  transport.emitMessage("one");
  transport.emitMessage("two");
  assert.deepEqual(terminal.writes, [], "background frames wait for the batch window");

  await mounted.rerender({ autoFocus: true });
  assert.deepEqual(terminal.writes, ["onetwo"], "focusing flushes pending output in one write");
  assert.equal(mounted.harness.terminals.length, 1, "render mode and focus changes keep the terminal instance");
  assert.equal(mounted.harness.transports.length, 1, "render mode and focus changes keep the websocket transport");
});

test("TerminalPane flushes a selected grid pane to realtime without focusing or reconnecting it", async () => {
  const mounted = await mountTerminalPane({
    autoFocus: false,
    realtimeOutput: false,
    renderMode: "focus-aware-efficient",
  });
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");

  transport.emitMessage("one");
  transport.emitMessage("two");
  assert.deepEqual(terminal.writes, []);

  await mounted.rerender({ realtimeOutput: true });
  assert.deepEqual(terminal.writes, ["onetwo"]);
  assert.equal(terminal.focused, 0, "grid selection does not move keyboard focus");

  transport.emitMessage("three");
  assert.deepEqual(terminal.writes, ["onetwo", "three"]);
  assert.equal(mounted.harness.terminals.length, 1);
  assert.equal(mounted.harness.transports.length, 1);
});

test("TerminalPane flushes the old batch before applying a different focus-aware profile", async () => {
  const mounted = await mountTerminalPane({
    autoFocus: false,
    realtimeOutput: false,
    renderMode: "focus-aware-efficient",
  });
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal);
  assert.ok(transport);

  transport.emitMessage("old-profile");
  assert.deepEqual(terminal.writes, []);
  assert.equal(mounted.harness.performanceFrames.at(-1)?.mode, "focus-aware-efficient");

  await mounted.rerender({ renderMode: "focus-aware-smooth" });
  assert.deepEqual(terminal.writes, ["old-profile"]);
  assert.deepEqual(
    mounted.harness.performanceWrites.map(({ mode, reason, frameCount }) => ({ mode, reason, frameCount })),
    [{ mode: "focus-aware-efficient", reason: "focus", frameCount: 1 }],
  );
  assert.equal(mounted.harness.terminals.length, 1);
  assert.equal(mounted.harness.transports.length, 1);
});

test("TerminalPane writes protocol queries immediately while printable background output stays batched", async () => {
  const mounted = await mountTerminalPane({
    autoFocus: false,
    realtimeOutput: false,
    renderMode: "focus-aware-efficient",
  });
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal);
  assert.ok(transport);

  transport.emitMessage("printable");
  assert.deepEqual(terminal.writes, []);

  transport.emitMessage("\u001b[6n");
  assert.deepEqual(terminal.writes, ["printable", "\u001b[6n"]);
});

test("TerminalPane skips protocol inspection when output is already realtime", async () => {
  const mounted = await mountTerminalPane({
    autoFocus: true,
    renderMode: "realtime",
  });
  const transport = mounted.harness.transports[0];
  assert.ok(transport);

  transport.emitMessage("realtime");
  assert.equal(mounted.harness.protocolChecks, 0);

  await mounted.rerender({
    autoFocus: false,
    realtimeOutput: false,
    renderMode: "focus-aware-balanced",
  });
  transport.emitMessage("background");
  assert.equal(mounted.harness.protocolChecks, 1);
});

test("TerminalPane routes exact xterm controls through named keys without rewriting text", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");

  terminal.emitData("\x7f");
  terminal.emitData("\x1b[A");
  terminal.emitData("\x1bOD");
  terminal.emitData("\r");
  terminal.emitData("中文輸入");
  terminal.emitData("a\x7f");
  terminal.emitData("\x1b[2;1R");

  assert.deepEqual(transport.sentInputs, [
    { keys: ["backspace"] },
    { keys: ["up"] },
    { keys: ["left"] },
    { keys: ["enter"] },
    { text: "中文輸入" },
    { text: "a\x7f" },
    { text: "\x1b[2;1R" },
  ]);
});

test("terminal redraws do not invoke the custom link provider until xterm requests a hovered row", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");
  const provider = terminal.linkProviders[0];
  assert.ok(provider, "link provider was registered");
  const originalProvideLinks = provider.provideLinks.bind(provider);
  let providerCalls = 0;
  provider.provideLinks = (line, callback) => {
    providerCalls += 1;
    originalProvideLinks(line, callback);
  };

  for (let index = 0; index < 100; index += 1) {
    transport.emitMessage(`redraw-${index}`);
  }
  assert.equal(providerCalls, 0, "PTY redraws alone never scan for links");

  provider.provideLinks(1, () => undefined);
  assert.equal(providerCalls, 1, "xterm hover lookup owns provider invocation");
});

test("terminal touch links open once for a clean tap and never for scroll or mouse tracking", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const url = "https://example.test/touch";
  // Keep trailing blank cells like a real row: a row filled to its last column
  // reads as a hard-wrap continuation and would join with the (identical) fake
  // row this stub returns for every index.
  const rowText = `${url}          `;
  terminal.buffer.active.getLine = () => ({
    isWrapped: false,
    length: rowText.length,
    translateToString: (trimRight?: boolean, startColumn = 0, endColumn = rowText.length) => {
      const value = rowText.slice(startColumn, endColumn);
      return trimRight ? value.trimEnd() : value;
    },
    getCell: (column: number) =>
      column < rowText.length
        ? { getChars: () => rowText[column] ?? "", getWidth: () => 1 }
        : undefined,
  });
  const host = terminal.openHost;
  assert.ok(host, "terminal host was mounted");
  let opens = 0;
  Object.defineProperty(mounted.window, "open", {
    configurable: true,
    value: () => {
      opens += 1;
      return {};
    },
  });
  const dispatchTouch = (type: string, x: number, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: x, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
    return event;
  };

  // Every touch open discloses its target first, in either mouse-tracking
  // mode: touch has no hover, and an implicit link is joined across hard-wrap
  // junctions, so the tapped row can show only the head of what will open.
  const confirmations: string[] = [];
  let confirmAnswer = true;
  Object.defineProperty(mounted.window, "confirm", {
    configurable: true,
    value: (message: string) => {
      confirmations.push(message);
      return confirmAnswer;
    },
  });

  dispatchTouch("touchstart", 100, 100);
  const cleanEnd = dispatchTouch("touchend", 100, 100);
  await flushAsync();
  assert.equal(confirmations.length, 1, "a tap discloses the target before opening");
  assert.match(confirmations[0] ?? "", /https:\/\/example\.test\/touch/);
  assert.equal(opens, 1, "a clean tap opens exactly once");
  assert.equal(cleanEnd.defaultPrevented, true);

  confirmAnswer = false;
  dispatchTouch("touchstart", 100, 100);
  const declinedCleanEnd = dispatchTouch("touchend", 100, 100);
  await flushAsync();
  assert.equal(confirmations.length, 2, "a declined tap still asked");
  assert.equal(opens, 1, "a declined tap opens nothing");
  assert.equal(declinedCleanEnd.defaultPrevented, true, "a declined tap is still consumed");

  // A mouse-tracking pane resolves through the read-only text-scan path
  // instead, and discloses the same way.
  terminal.modes.mouseTrackingMode = "any";
  dispatchTouch("touchstart", 100, 100);
  const declinedEnd = dispatchTouch("touchend", 100, 100);
  await flushAsync();
  assert.equal(confirmations.length, 3, "tracking-pane tap open asks for confirmation");
  assert.match(confirmations[2] ?? "", /https:\/\/example\.test\/touch/);
  assert.equal(opens, 1, "declined confirmation must not open");
  assert.equal(declinedEnd.defaultPrevented, true, "a declined confirmation still consumes the tap");

  confirmAnswer = true;
  dispatchTouch("touchstart", 100, 100);
  dispatchTouch("touchend", 100, 100);
  await flushAsync();
  assert.equal(confirmations.length, 4, "each tracking-pane tap open discloses the target");
  assert.equal(opens, 2, "confirmed tracking-pane tap opens the link");

  terminal.modes.mouseTrackingMode = "none";
  dispatchTouch("touchstart", 100, 160);
  dispatchTouch("touchmove", 100, 100);
  const scrollEnd = dispatchTouch("touchend", 100, 100);
  await flushAsync();
  assert.equal(opens, 2, "touch-scroll never falls through to link activation");
  assert.equal(confirmations.length, 4, "touch-scroll never prompts a confirmation");
  assert.equal(scrollEnd.defaultPrevented, true);
});

test("terminal touch taps a mouse-tracking pane link through xterm's own resolution", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = terminal.openHost;
  assert.ok(host, "terminal host was mounted");
  // The pane an agent TUI owns. Text scanning at the tapped cell cannot reach
  // either target here: an OSC 8 hyperlink whose visible label is not a URL
  // ("#398"), and the continuation rows of a link whose label wrapped. Only
  // the resolution xterm itself performs covers both, and it must be driven
  // without forwarding a mouse report to the attached app.
  terminal.modes.mouseTrackingMode = "any";
  const fullTarget = "https://example.test/agent-console/issues/398";
  terminal.oscTouchTarget = fullTarget;
  // A link that starts late on row 7 and runs to row 9: (605, 105) is its
  // first cell (row 7, column 60) and (65, 118) is a continuation cell (row 8,
  // column 6) that sits BEFORE the start column, so accepting it requires the
  // range's interior rows, not a column test.
  terminal.oscTouchRange = { start: { x: 60, y: 7 }, end: { x: 20, y: 9 } };
  terminal.oscTouchCells = ["605:105", "65:118", "100:250"];
  let forwardedMoves = 0;
  terminal.element?.addEventListener("mousemove", () => {
    forwardedMoves += 1;
  });
  const opened: string[] = [];
  Object.defineProperty(mounted.window, "open", {
    configurable: true,
    value: (url: string) => {
      opened.push(url);
      return {};
    },
  });
  const confirmations: string[] = [];
  Object.defineProperty(mounted.window, "confirm", {
    configurable: true,
    value: (message: string) => {
      confirmations.push(message);
      return true;
    },
  });
  const dispatchTouch = (type: string, x: number, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: x, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
    return event;
  };

  dispatchTouch("touchstart", 605, 105);
  const labelEnd = dispatchTouch("touchend", 605, 105);
  await flushAsync();
  assert.deepEqual(opened, [fullTarget], "a tap on the label opens the OSC 8 target, not its visible text");
  assert.equal(labelEnd.defaultPrevented, true);
  assert.match(confirmations[0] ?? "", /issues\/398/, "the confirmation discloses the resolved target");

  // A continuation row of the same link: no URL text under the cell, and its
  // column is before the link's start column. This returned nothing before.
  dispatchTouch("touchstart", 65, 118);
  dispatchTouch("touchend", 65, 118);
  await flushAsync();
  assert.deepEqual(opened, [fullTarget, fullTarget], "a tap on a continuation row opens the same target");

  // The negative half of the same contract: xterm resolved a link, but the
  // range it reported does not contain the pressed cell (row 18 here), so the
  // tap must fall through to text scanning and open nothing.
  dispatchTouch("touchstart", 100, 250);
  dispatchTouch("touchend", 100, 250);
  await flushAsync();
  assert.deepEqual(opened, [fullTarget, fullTarget], "a disclosure outside the pressed cell must not open");
  assert.equal(confirmations.length, 2, "an out-of-range disclosure is never even confirmed");
  assert.equal(forwardedMoves, 0, "the probe forwards no mouse report to the attached TUI");
  // The probe drives xterm's hover, which paints the disclosure popup. Touch
  // never fires xterm's leave, and the popup takes pointer events, so leaving
  // one up would swallow later taps meant for the TUI.
  assert.equal(
    host.querySelectorAll(".terminal-link-hover").length,
    0,
    "a tracking-pane tap leaves no hover popup over the terminal",
  );
});

test("terminal touch taps an OSC 8 link in a pane that does not own the mouse", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = terminal.openHost;
  assert.ok(host, "terminal host was mounted");
  // A quiet pane. An idle agent session leaves mouse tracking off, and this is
  // where a tap used to die: the synthetic click does not activate xterm's
  // link, and the fallback text scan at the tapped cell sees the label "#398",
  // which is not a URL, so nothing opened and nothing was ever disclosed.
  terminal.modes.mouseTrackingMode = "none";
  // xterm resolves the hover but the synthetic press does not activate the
  // link, which is what a device tap does. The old fallback then text-scanned
  // the tapped cell, saw the label "#398", and gave up.
  terminal.oscTouchActivates = false;
  const fullTarget = "https://example.test/agent-console/issues/398";
  terminal.oscTouchTarget = fullTarget;
  terminal.oscTouchRange = { start: { x: 60, y: 7 }, end: { x: 20, y: 9 } };
  terminal.oscTouchCells = ["605:105", "65:118"];
  const opened: string[] = [];
  Object.defineProperty(mounted.window, "open", {
    configurable: true,
    value: (url: string) => {
      opened.push(url);
      return {};
    },
  });
  const confirmations: string[] = [];
  Object.defineProperty(mounted.window, "confirm", {
    configurable: true,
    value: (message: string) => {
      confirmations.push(message);
      return true;
    },
  });
  const dispatchTouch = (type: string, x: number, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: x, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
    return event;
  };

  dispatchTouch("touchstart", 605, 105);
  const labelEnd = dispatchTouch("touchend", 605, 105);
  await flushAsync();
  assert.deepEqual(opened, [fullTarget], "a tap on the label opens the OSC 8 target, not its visible text");
  assert.match(confirmations[0] ?? "", /issues\/398/, "the confirmation discloses the resolved target");
  assert.equal(confirmations.length, 1, "the tap asks exactly once");
  assert.equal(labelEnd.defaultPrevented, true);

  // The continuation row of the same link, which no text scan can reach.
  dispatchTouch("touchstart", 65, 118);
  dispatchTouch("touchend", 65, 118);
  await flushAsync();
  assert.deepEqual(opened, [fullTarget, fullTarget], "a tap on a continuation row opens the same target");

  // The probe paints xterm's hover popup here too, and touch still never fires
  // xterm's leave. A popup left up takes pointer events and sits over the pane.
  assert.equal(
    host.querySelectorAll(".terminal-link-hover").length,
    0,
    "a tap leaves no hover popup pinned over the terminal",
  );
});

test("terminal touch leaves no hover popup when the synthetic press does activate", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = terminal.openHost;
  assert.ok(host, "terminal host was mounted");
  // The other half of the quiet pane: here xterm's own activation fires, so the
  // tap ends inside the synthetic sequence and never re-probes. That is the one
  // path with no later chance to take the popup down.
  terminal.modes.mouseTrackingMode = "none";
  terminal.oscTouchActivates = true;
  const fullTarget = "https://example.test/agent-console/issues/398";
  terminal.oscTouchTarget = fullTarget;
  terminal.oscTouchRange = { start: { x: 60, y: 7 }, end: { x: 20, y: 9 } };
  terminal.oscTouchCells = ["605:105"];
  const opened: string[] = [];
  Object.defineProperty(mounted.window, "open", {
    configurable: true,
    value: (url: string) => {
      opened.push(url);
      return {};
    },
  });
  const dispatchTouch = (type: string, x: number, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: x, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
    return event;
  };

  dispatchTouch("touchstart", 605, 105);
  dispatchTouch("touchend", 605, 105);
  await flushAsync();
  assert.deepEqual(opened, [fullTarget], "xterm's own activation still owns the open");
  assert.equal(
    host.querySelectorAll(".terminal-link-hover").length,
    0,
    "the activating tap leaves no hover popup pinned over the terminal",
  );
});

test("terminal touch never forwards a probe when xterm's screen element is missing", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = terminal.openHost;
  assert.ok(host, "terminal host was mounted");
  terminal.modes.mouseTrackingMode = "any";
  let forwardedMoves = 0;
  terminal.element?.addEventListener("mousemove", () => {
    forwardedMoves += 1;
  });
  // Without .xterm-screen there is no descendant to dispatch at, and
  // retargeting to term.element would fire the any-motion reporter in the
  // target phase whatever bubbles says. The probe must fail closed.
  terminal.element?.querySelector(".xterm-screen")?.remove();

  const dispatchTouch = (type: string, x: number, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: x, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
    return event;
  };
  dispatchTouch("touchstart", 100, 100);
  dispatchTouch("touchend", 100, 100);
  await flushAsync();

  assert.equal(forwardedMoves, 0, "a missing screen element must not retarget the probe onto term.element");
});

test("normal-buffer touch scroll follows sub-row finger motion and rebases after a rendered row", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const screen = terminal?.element?.querySelector(".xterm-screen");
  const rows = screen?.querySelector<HTMLElement>(".xterm-rows");
  assert.ok(terminal && host && screen && rows);
  terminal.buffer.active.baseY = 80;
  terminal.buffer.active.viewportY = 40;
  const cellHeight = screen.getBoundingClientRect().height / terminal.rows;
  const fingerStep = cellHeight / 4;
  terminal.scrollLines = (lines) => {
    assert.equal(terminal.options.smoothScrollDuration, 0, "touch row steps must land synchronously");
    terminal.scrollLinesCalls.push(lines);
    terminal.buffer.active.viewportY += lines;
  };
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };
  const visualOffset = () => Number.parseFloat(rows.style.transform.match(/,\s*(-?[\d.]+)px/)?.[1] ?? "NaN");

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 300 - fingerStep);
  assert.ok(Math.abs(visualOffset() + fingerStep * 1.8) < 0.02, "pixels move before a full row is crossed");
  assert.deepEqual(terminal.scrollLinesCalls, []);

  dispatchTouch("touchmove", 300 - fingerStep * 2);
  dispatchTouch("touchmove", 300 - fingerStep * 3);
  assert.deepEqual(terminal.scrollLinesCalls, [1]);
  const beforePartialRender = visualOffset();
  terminal.emitRender(5, 5);
  assert.equal(visualOffset(), beforePartialRender, "an unrelated partial render cannot absorb the row");
  terminal.emitRender();
  assert.ok(
    Math.abs(visualOffset() - (cellHeight - fingerStep * 3 * 1.8)) < 0.02,
    "the rendered row absorbs one cell without jumping under the finger",
  );
  assert.equal(terminal.options.smoothScrollDuration, 0, "touch row steps remain synchronous for the gesture");

  dispatchTouch("touchcancel", 300 - fingerStep * 3);
  assert.equal(rows.style.transform, "", "cancelling touch clears the visual offset");
  assert.equal(terminal.options.smoothScrollDuration, 120, "ordinary xterm scrolling regains smoothing afterward");
});

async function mountTerminalPaneWithSettleTimer() {
  let settle: (() => void) | undefined;
  const mounted = await mountTerminalPane({}, (window) => {
    // Own only the settle timer; advance it explicitly instead of relying on
    // wall-clock scheduling. Other mount/gesture timers keep their real owner.
    const setTimeout = window.setTimeout.bind(window);
    const clearTimeout = window.clearTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 120 && typeof callback === "function") {
        settle = () => callback(...args);
        return -1;
      }
      return setTimeout(callback, delay, ...args);
    };
    window.clearTimeout = (timer) => {
      if (timer === -1) settle = undefined;
      else clearTimeout(timer);
    };
  });
  return { mounted, runSettle() {
    assert.ok(settle, "touchend arms the local settle timer");
    settle();
  } };
}

for (const direction of [-1, 1]) {
  for (const paintBeforeRelease of [false, true]) {
    for (const nearEdge of [false, true]) {
      test(`normal-buffer settle continues direction ${direction} with ${paintBeforeRelease ? "painted" : "pending"} rows ${nearEdge ? "at the edge" : "in scrollback"} and no server frames`, async () => {
        const { mounted, runSettle } = await mountTerminalPaneWithSettleTimer();
        const terminal = mounted.harness.terminals[0];
        const transport = mounted.harness.transports[0];
        const host = terminal?.openHost;
        const screen = terminal?.element?.querySelector(".xterm-screen");
        const rows = screen?.querySelector<HTMLElement>(".xterm-rows");
        assert.ok(terminal && transport && host && screen && rows);
        terminal.buffer.active.baseY = 80;
        const initialViewportY = nearEdge ? (direction < 0 ? 79 : 1) : 40;
        terminal.buffer.active.viewportY = initialViewportY;
        const cellHeight = screen.getBoundingClientRect().height / terminal.rows;
        let paintedViewportY = initialViewportY;
        const paint = () => {
          paintedViewportY = terminal.buffer.active.viewportY;
          terminal.emitRender();
        };
        terminal.scrollLines = (lines) => {
          assert.equal(terminal.options.smoothScrollDuration, 0);
          terminal.scrollLinesCalls.push(lines);
          terminal.buffer.active.viewportY = Math.max(0, Math.min(80, terminal.buffer.active.viewportY + lines));
        };
        const dispatchTouch = (type: string, y: number) => {
          const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
          const points = [{ clientX: 100, clientY: y }];
          Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : points });
          Object.defineProperty(event, "changedTouches", { value: points });
          host.dispatchEvent(event);
        };
        const offset = () => Number.parseFloat(rows.style.transform.match(/,\s*(-?[\d.]+)px/)?.[1] ?? "0");
        const position = () => -(paintedViewportY - initialViewportY) * cellHeight + offset();
        const writesBefore = terminal.writes.length;
        const inputsBefore = transport.sentInputs.length;
        dispatchTouch("touchstart", 300);
        // One move crosses 1.8 rows but cannot start momentum (no velocity sample).
        dispatchTouch("touchmove", 300 + direction * cellHeight);
        if (paintBeforeRelease) paint();
        const releasedPosition = position();
        if (nearEdge) {
          assert.ok(Math.abs(releasedPosition - direction * cellHeight) < 0.01, "landing exactly at the edge clamps the fractional preview");
        }
        dispatchTouch("touchend", 300 + direction * cellHeight);
        runSettle();
        assert.equal(position(), releasedPosition, "settle preserves compensation until the row paint");
        terminal.emitRender(5, 5);
        assert.equal(position(), releasedPosition, "an unrelated partial paint cannot drop compensation");
        paint();
        const settledPosition = position();
        assert.ok(direction * (settledPosition - releasedPosition) >= -0.01, "settle must not reverse the finger motion");
        assert.ok(Math.abs(settledPosition - releasedPosition) < cellHeight, "settle advances by less than one row");
        assert.equal(terminal.buffer.active.viewportY, initialViewportY - direction * (nearEdge ? 1 : 2), "settle commits the fraction only where a row is available");
        assert.equal(rows.style.transform, "");
        assert.equal(rows.style.transition, "");
        assert.equal(terminal.options.smoothScrollDuration, 120);
        assert.equal(terminal.writes.length, writesBefore, "no incoming attach output is needed to exercise settle");
        assert.equal(transport.sentInputs.length, inputsBefore, "local scrollback sends no scroll/end message upstream");
      });
    }
  }
}



for (const nextMode of ["mouse", "alternate"] as const) {
  test(`normal-buffer settle yields when attach output changes to ${nextMode} mode after release`, async () => {
    const { mounted, runSettle } = await mountTerminalPaneWithSettleTimer();
    const terminal = mounted.harness.terminals[0];
    const host = terminal?.openHost;
    const rows = terminal?.element?.querySelector<HTMLElement>(".xterm-rows");
    assert.ok(terminal && host && rows);
    terminal.buffer.active.baseY = 80;
    terminal.buffer.active.viewportY = 40;
    terminal.scrollLines = (lines) => {
      terminal.scrollLinesCalls.push(lines);
      terminal.buffer.active.viewportY += lines;
    };
    const dispatchTouch = (type: string, y: number) => {
      const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
      const points = [{ clientX: 100, clientY: y }];
      Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : points });
      Object.defineProperty(event, "changedTouches", { value: points });
      host.dispatchEvent(event);
    };
    dispatchTouch("touchstart", 300);
    dispatchTouch("touchmove", 280);
    dispatchTouch("touchend", 280);
    const callsBeforeSettle = [...terminal.scrollLinesCalls];
    if (nextMode === "mouse") terminal.modes.mouseTrackingMode = "any";
    else terminal.buffer.active.type = "alternate";
    runSettle();
    assert.deepEqual(terminal.scrollLinesCalls, callsBeforeSettle, "settle cannot commit a local row after scroll ownership changes");
    assert.equal(rows.style.transform, "");
    assert.equal(terminal.options.smoothScrollDuration, 120);
  });
}

test("normal-buffer touch does not preview empty space beyond either scroll edge", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const rows = terminal?.element?.querySelector<HTMLElement>(".xterm-rows");
  assert.ok(terminal && host && rows);
  terminal.buffer.active.baseY = 80;
  terminal.buffer.active.viewportY = 80;
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 295);
  assert.equal(rows.style.transform, "", "a sub-row drag past the bottom cannot expose empty space");
  dispatchTouch("touchcancel", 295);

  terminal.buffer.active.viewportY = 0;
  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 305);
  assert.equal(rows.style.transform, "", "a sub-row drag past the top cannot expose empty space");
  dispatchTouch("touchcancel", 305);

  terminal.buffer.active.viewportY = 40;
  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 295);
  assert.notEqual(rows.style.transform, "", "a scrollable viewport still previews sub-row motion");
  dispatchTouch("touchcancel", 295);

  terminal.buffer.active.viewportY = 79;
  terminal.scrollLines = (lines) => {
    terminal.scrollLinesCalls.push(lines);
    terminal.buffer.active.viewportY = Math.min(terminal.buffer.active.baseY, terminal.buffer.active.viewportY + lines);
  };
  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 270);
  assert.equal(terminal.buffer.active.viewportY, 80);
  terminal.emitRender();
  assert.equal(rows.style.transform, "translate3d(0, 0px, 0)", "landing on the last row absorbs only the row that moved");
  dispatchTouch("touchcancel", 270);
});

test("normal-buffer touch changes xterm smoothing only at gesture boundaries", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  assert.ok(terminal && host);
  terminal.buffer.active.baseY = 80;
  terminal.buffer.active.viewportY = 40;
  const changes: number[] = [];
  let smoothDuration = Number(terminal.options.smoothScrollDuration);
  Object.defineProperty(terminal.options, "smoothScrollDuration", {
    configurable: true,
    get: () => smoothDuration,
    set: (value: number) => {
      changes.push(value);
      smoothDuration = value;
    },
  });
  terminal.scrollLines = (lines) => {
    terminal.scrollLinesCalls.push(lines);
    terminal.buffer.active.viewportY += lines;
  };
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 280);
  dispatchTouch("touchmove", 260);
  assert.ok(terminal.scrollLinesCalls.length >= 2, "the gesture crosses multiple rows");
  assert.deepEqual(changes, [0], "xterm options are changed once while the finger is moving");
  dispatchTouch("touchcancel", 260);
  assert.deepEqual(changes, [0, 120], "smoothing is restored once when the gesture ends");
});

test("a wobbling tap realigns the terminal rows before link hit testing", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const rows = terminal?.element?.querySelector<HTMLElement>(".xterm-rows");
  assert.ok(terminal && host && rows);
  terminal.buffer.active.baseY = 80;
  terminal.buffer.active.viewportY = 40;
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
    return event;
  };

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 296);
  assert.notEqual(rows.style.transform, "", "sub-row motion previews even a small wobble");
  const tapEnd = dispatchTouch("touchend", 296);
  assert.equal(tapEnd.defaultPrevented, false, "the gesture remains a tap");
  assert.equal(rows.style.transform, "", "hit testing and compatibility click see aligned rows");
  assert.equal(terminal.options.smoothScrollDuration, 120);
});

test("separate normal-buffer drags do not inherit a hidden row remainder", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const screen = terminal?.element?.querySelector(".xterm-screen");
  const rows = screen?.querySelector<HTMLElement>(".xterm-rows");
  assert.ok(terminal && host && screen && rows);
  terminal.buffer.active.baseY = 80;
  terminal.buffer.active.viewportY = 40;
  const cellHeight = screen.getBoundingClientRect().height / terminal.rows;
  terminal.scrollLines = (lines) => {
    terminal.scrollLinesCalls.push(lines);
    terminal.buffer.active.viewportY += lines;
  };
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 300 - cellHeight);
  dispatchTouch("touchend", 300 - cellHeight);
  assert.deepEqual(terminal.scrollLinesCalls, [1]);

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 300 - cellHeight / 6);
  assert.deepEqual(terminal.scrollLinesCalls, [1], "a new short drag must not scroll with the previous drag's remainder");
  const visualOffset = Number.parseFloat(rows.style.transform.match(/,\s*(-?[\d.]+)px/)?.[1] ?? "NaN");
  assert.ok(visualOffset < 0, "the new drag still moves in the finger's direction");
  dispatchTouch("touchcancel", 300 - cellHeight / 6);
});

test("mouse-tracking TUI touch scroll follows pixels and reconciles only after a matching row shift", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const screen = terminal?.element?.querySelector(".xterm-screen");
  const rows = screen?.querySelector<HTMLElement>(".xterm-rows");
  assert.ok(terminal, "terminal was created");
  assert.ok(host, "terminal host was mounted");
  assert.ok(screen, "terminal screen was mounted");
  assert.ok(rows, "terminal row layer was mounted");
  terminal.modes.mouseTrackingMode = "any";
  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `row-${index}`));
  const originalScreenRect = screen.getBoundingClientRect.bind(screen);
  let screenRectReads = 0;
  screen.getBoundingClientRect = () => {
    screenRectReads += 1;
    return originalScreenRect();
  };
  let wheels = 0;
  screen.addEventListener("wheel", () => {
    wheels += 1;
  });
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };
  const visualOffset = () => Number.parseFloat(rows.style.transform.match(/,\s*(-?[\d.]+)px/)?.[1] ?? "NaN");

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 290);
  assert.equal(visualOffset(), -10, "a sub-cell drag is visible before any semantic wheel row is emitted");
  assert.equal(wheels, 0, "sub-cell visual motion does not invent a wheel row");

  dispatchTouch("touchmove", 280);
  assert.equal(visualOffset(), -20, "the visual layer continues tracking the finger across the row threshold");
  assert.equal(wheels, 1, "crossing one rendered cell emits exactly one semantic wheel row");
  assert.equal(screenRectReads, 1, "gesture geometry is measured once instead of on every sample and wheel row");

  const beforeUnrelatedRender = visualOffset();
  const translationsBeforePartialRender = terminal.bufferLineTranslations;
  terminal.emitRender(5, 5);
  assert.equal(
    terminal.bufferLineTranslations,
    translationsBeforePartialRender,
    "a partial dirty range is rejected without scanning visible buffer rows",
  );

  const translationsBeforeFullRender = terminal.bufferLineTranslations;
  terminal.emitRender();
  assert.ok(
    terminal.bufferLineTranslations - translationsBeforeFullRender <= 8,
    "a full candidate render compares a bounded row sample",
  );
  assert.equal(
    visualOffset(),
    beforeUnrelatedRender,
    "an unrelated render does not acknowledge a pending semantic wheel row",
  );

  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `row-${index + 1}`));
  const translationsBeforeShift = terminal.bufferLineTranslations;
  terminal.emitRender();
  assert.ok(
    terminal.bufferLineTranslations - translationsBeforeShift <= 8,
    "a matching shift also uses the bounded row sample",
  );
  const cellHeight = originalScreenRect().height / terminal.rows;
  assert.ok(
    Math.abs(visualOffset() - (-20 + cellHeight)) < 0.02,
    "the matching TUI row shift absorbs the emitted row without a visible position jump",
  );

  const repeatedRows = Array.from({ length: terminal.rows }, (_, index) =>
    index === 5 ? "anchor-a" : index === 21 ? "anchor-b" : "~",
  );
  terminal.setVisibleRows(repeatedRows);
  dispatchTouch("touchmove", 260);
  const beforeRepeatedUnrelatedRender = visualOffset();
  terminal.emitRender();
  assert.equal(
    visualOffset(),
    beforeRepeatedUnrelatedRender,
    "an unchanged repeated-row viewport is not mistaken for the pending wheel shift",
  );

  terminal.setVisibleRows([...repeatedRows.slice(1), "~"]);
  terminal.emitRender();
  assert.ok(
    Math.abs(visualOffset() - (beforeRepeatedUnrelatedRender + cellHeight)) < 0.02,
    "a genuine shifted viewport still reconciles when most rows are repeated",
  );

  const scrollRegionRows = Array.from({ length: terminal.rows }, (_, index) =>
    index < terminal.rows - 4 ? `content-${index}` : `footer-${index}`,
  );
  terminal.setVisibleRows(scrollRegionRows);
  terminal.emitRender();
  const translationsBeforeScrollRegionWheel = terminal.bufferLineTranslations;
  const wheelsBeforeScrollRegion = wheels;
  dispatchTouch("touchmove", 259);
  assert.equal(terminal.bufferLineTranslations - translationsBeforeScrollRegionWheel, terminal.rows);
  assert.equal(wheels - wheelsBeforeScrollRegion, 1);
  const beforeScrollRegionRender = visualOffset();
  terminal.setVisibleRows([
    ...scrollRegionRows.slice(1, terminal.rows - 4),
    "content-new",
    ...scrollRegionRows.slice(terminal.rows - 4),
  ]);
  terminal.emitRender(0, terminal.rows - 5);
  assert.ok(
    Math.abs(visualOffset() - (beforeScrollRegionRender + cellHeight)) < 0.02,
    "a TUI scroll region can reconcile without repainting its fixed footer",
  );

  dispatchTouch("touchcancel", 259);
  assert.equal(rows.style.transform, "", "cancelling the gesture removes the compositor offset");

  const shiftedScrollRegionRows = [
    ...scrollRegionRows.slice(1, terminal.rows - 4),
    "content-new",
    ...scrollRegionRows.slice(terminal.rows - 4),
  ];
  terminal.setVisibleRows(shiftedScrollRegionRows);
  dispatchTouch("touchstart", 200);
  dispatchTouch("touchmove", 220);
  const beforeReverseRender = visualOffset();
  terminal.setVisibleRows([
    "content-before",
    ...shiftedScrollRegionRows.slice(0, terminal.rows - 5),
    ...shiftedScrollRegionRows.slice(terminal.rows - 4),
  ]);
  terminal.emitRender(0, terminal.rows - 5);
  assert.ok(
    Math.abs(visualOffset() - (beforeReverseRender - cellHeight)) < 0.02,
    "a reverse swipe also reconciles within a TUI scroll region",
  );
  dispatchTouch("touchcancel", 220);
});

test("mouse-tracking TUI settles ordinary touchend and aligns the input grid before a new tap", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const rows = terminal?.element?.querySelector<HTMLElement>(".xterm-rows");
  assert.ok(terminal, "terminal was created");
  assert.ok(host, "terminal host was mounted");
  assert.ok(rows, "terminal row layer was mounted");
  terminal.modes.mouseTrackingMode = "any";
  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `row-${index}`));

  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 280);
  dispatchTouch("touchend", 280);
  assert.notEqual(rows.style.transform, "", "the released sub-row offset remains visible during settle");
  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `row-${index + 1}`));
  terminal.emitRender();

  dispatchTouch("touchstart", 280);
  assert.equal(rows.style.transform, "", "a new actionable touch first realigns xterm's visual and input grids");
  dispatchTouch("touchend", 280);

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 280);
  dispatchTouch("touchend", 280);
  await flushAsync(140);
  assert.equal(rows.style.transform, "translate3d(0, 0px, 0)", "ordinary touchend eases the residual offset to zero");
  assert.equal(rows.style.transition, "transform 90ms ease-out");
  await flushAsync(100);
  assert.equal(rows.style.transform, "", "settle cleanup removes the transform");
  assert.equal(rows.style.transition, "", "settle cleanup removes the transition");
  assert.equal(rows.style.willChange, "", "settle cleanup removes the compositor hint");
});

test("mouse-tracking TUI stops previewing repeated outward drags when wheel rows do not move", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const rows = terminal?.element?.querySelector<HTMLElement>(".xterm-rows");
  const screen = terminal?.element?.querySelector(".xterm-screen");
  assert.ok(terminal && host && rows && screen);
  terminal.modes.mouseTrackingMode = "any";
  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `row-${index}`));
  let wheels = 0;
  screen.addEventListener("wheel", () => { wheels += 1; });
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 270);
  dispatchTouch("touchend", 270);
  assert.ok(wheels > 0, "the first drag forwards semantic wheel input");
  await flushAsync(240);
  assert.equal(rows.style.transform, "", "unacknowledged preview settles");

  const forwarded = wheels;
  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 270);
  assert.equal(rows.style.transform, "", "another outward drag cannot expose and snap back blank rows");
  assert.ok(wheels > forwarded, "semantic wheel input still reaches a TUI that may become scrollable");
  dispatchTouch("touchcancel", 270);

  dispatchTouch("touchstart", 270);
  dispatchTouch("touchmove", 300);
  assert.notEqual(rows.style.transform, "", "reversing direction restores pixel preview");
  dispatchTouch("touchcancel", 300);
});

test("mouse-tracking TUI preserves an unacknowledged edge wheel across a quick retouch", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const rows = terminal?.element?.querySelector<HTMLElement>(".xterm-rows");
  const screen = terminal?.element?.querySelector(".xterm-screen");
  assert.ok(terminal && host && rows && screen);
  terminal.modes.mouseTrackingMode = "any";
  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `row-${index}`));
  let wheels = 0;
  screen.addEventListener("wheel", () => { wheels += 1; });
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 270);
  dispatchTouch("touchend", 270);
  const forwarded = wheels;
  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 270);
  assert.equal(rows.style.transform, "", "a rapid retouch cannot restart empty-space preview");
  assert.ok(wheels > forwarded, "the second drag still forwards wheel input");
  dispatchTouch("touchcancel", 270);
});

test("mouse-tracking TUI stops an unacknowledged preview during a continuing drag", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const rows = terminal?.element?.querySelector<HTMLElement>(".xterm-rows");
  assert.ok(terminal && host && rows);
  terminal.modes.mouseTrackingMode = "any";
  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `row-${index}`));
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 270);
  assert.notEqual(rows.style.transform, "");
  await flushAsync(240);
  assert.equal(rows.style.transform, "", "a held drag cannot keep previewing an unacknowledged wheel");
  dispatchTouch("touchmove", 240);
  assert.equal(rows.style.transform, "", "further outward movement stays aligned");
  dispatchTouch("touchcancel", 240);
});

test("mouse-tracking TUI restores preview after blocked wheels move multiple rows in one repaint", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const rows = terminal?.element?.querySelector<HTMLElement>(".xterm-rows");
  assert.ok(terminal && host && rows);
  terminal.modes.mouseTrackingMode = "any";
  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `row-${index}`));
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 270);
  dispatchTouch("touchend", 270);
  await flushAsync(240);

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 240);
  assert.equal(rows.style.transform, "", "retry wheels keep the viewport aligned until the TUI responds");
  dispatchTouch("touchcancel", 240);

  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `row-${index + 2}`));
  terminal.emitRender();
  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 295);
  assert.notEqual(rows.style.transform, "", "a late matching row shift unlocks visual scrolling");
  dispatchTouch("touchcancel", 295);
});

test("mouse-tracking TUI refreshes its blocked baseline after a wholesale repaint", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  const rows = terminal?.element?.querySelector<HTMLElement>(".xterm-rows");
  assert.ok(terminal && host && rows);
  terminal.modes.mouseTrackingMode = "any";
  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `old-${index}`));
  const dispatchTouch = (type: string, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };

  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 270);
  dispatchTouch("touchend", 270);
  await flushAsync(240);

  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `fresh-${index}`));
  terminal.emitRender();
  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 270);
  assert.equal(rows.style.transform, "", "replacement alone does not preview past the edge");
  dispatchTouch("touchcancel", 270);

  terminal.setVisibleRows(Array.from({ length: terminal.rows }, (_, index) => `fresh-${index + 1}`));
  terminal.emitRender();
  dispatchTouch("touchstart", 300);
  dispatchTouch("touchmove", 295);
  assert.notEqual(rows.style.transform, "", "a new row shift is matched against the refreshed baseline");
  dispatchTouch("touchcancel", 295);
});

test("TerminalPane forwards one committed horizontal swipe and ignores vertical scroll", async () => {
  const swipes: string[] = [];
  const mounted = await mountTerminalPane({
    onSessionSwipe: (direction) => swipes.push(direction),
  });
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  assert.ok(host, "terminal host was mounted");
  const dispatchTouch = (type: string, x: number, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: x, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
    return event;
  };

  dispatchTouch("touchstart", 220, 300);
  dispatchTouch("touchmove", 130, 302);
  const swipeEnd = dispatchTouch("touchend", 130, 302);
  await flushAsync();
  assert.deepEqual(swipes, ["next"]);
  assert.equal(swipeEnd.defaultPrevented, true);

  dispatchTouch("touchstart", 200, 300);
  dispatchTouch("touchmove", 196, 220);
  dispatchTouch("touchend", 196, 220);
  await flushAsync();
  assert.deepEqual(swipes, ["next"], "vertical terminal scroll never changes session");
});

test("TerminalPane keeps disabled session swipes on the terminal scroll path across rerenders", async () => {
  const swipes: string[] = [];
  const mounted = await mountTerminalPane({ onSessionSwipe: undefined });
  const terminal = mounted.harness.terminals[0];
  const host = terminal?.openHost;
  assert.ok(terminal, "terminal was created");
  assert.ok(host, "terminal host was mounted");
  terminal.buffer.active.baseY = 80;
  terminal.buffer.active.viewportY = 40;
  const dispatchTouch = (type: string, x: number, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: x, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };
  const drag = () => {
    dispatchTouch("touchstart", 220, 300);
    dispatchTouch("touchmove", 140, 270);
    dispatchTouch("touchend", 140, 270);
  };

  drag();
  assert.ok(terminal.scrollLinesCalls.length > 0, "callback-absent diagonal drag retains normal-buffer scrolling");
  assert.deepEqual(swipes, []);

  terminal.scrollLinesCalls.length = 0;
  await mounted.rerender({ onSessionSwipe: (direction) => swipes.push(direction) });
  assert.equal(mounted.harness.terminals.length, 1, "eligibility changes do not recreate the terminal");
  drag();
  assert.equal(terminal.scrollLinesCalls.length, 0, "enabled swipe owns the horizontal gesture");
  assert.deepEqual(swipes, ["next"]);

  terminal.scrollLinesCalls.length = 0;
  await mounted.rerender({ onSessionSwipe: undefined });
  assert.equal(mounted.harness.terminals.length, 1, "disabling swipes keeps the same terminal");
  drag();
  assert.ok(terminal.scrollLinesCalls.length > 0, "live disable restores normal-buffer scrolling");
  assert.deepEqual(swipes, ["next"]);
});

test("TerminalPane session swipes suppress mouse-tracking input without completing a click", async () => {
  const swipes: string[] = [];
  const mounted = await mountTerminalPane({
    onSessionSwipe: (direction) => swipes.push(direction),
  });
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  const host = terminal?.openHost;
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");
  assert.ok(host, "terminal host was mounted");
  terminal.modes.mouseTrackingMode = "any";
  const forwardedMouseEvents: string[] = [];
  host.addEventListener("mousedown", () => forwardedMouseEvents.push("down"));
  host.addEventListener("mouseup", () => forwardedMouseEvents.push("up"));
  const dispatchTouch = (type: string, x: number, y: number) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: x, clientY: y }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
  };
  const dispatchCompatMouse = (type: "mousedown" | "mouseup") => {
    const event = new mounted.window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 220,
      clientY: 300,
    });
    terminal.element?.dispatchEvent(event);
    return event;
  };

  dispatchTouch("touchstart", 220, 300);
  const down = dispatchCompatMouse("mousedown");
  dispatchTouch("touchmove", 120, 302);
  const up = dispatchCompatMouse("mouseup");
  dispatchTouch("touchend", 120, 302);

  assert.equal(down.defaultPrevented, true, "swipe ownership blocks the TUI press at touch start");
  assert.equal(up.defaultPrevented, true, "swipe ownership blocks the TUI release");
  assert.deepEqual(forwardedMouseEvents, [], "no compatibility mouse event reaches xterm");
  assert.deepEqual(transport.sentInputs, [], "no terminal input frame is emitted");
  assert.deepEqual(swipes, ["next"], "the same gesture navigates once");
});

test("terminal provider activation rejects right-click and drag gestures before opening", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const url = "https://example.test/a-long-link-target";
  // Trailing blank cells keep this every-row stub from reading as a wall of
  // hard-wrapped full rows (see the touch-link test above).
  const rowText = `${url}          `;
  terminal.buffer.active.getLine = () => ({
    isWrapped: false,
    length: rowText.length,
    translateToString: (trimRight?: boolean, startColumn = 0, endColumn = rowText.length) => {
      const value = rowText.slice(startColumn, endColumn);
      return trimRight ? value.trimEnd() : value;
    },
    getCell: (column: number) =>
      column < rowText.length ? { getChars: () => rowText[column] ?? "", getWidth: () => 1 } : undefined,
  });
  const provider = terminal.linkProviders[0];
  const host = terminal.openHost;
  assert.ok(provider, "link provider was registered");
  assert.ok(host, "terminal host was mounted");
  let link: { activate(event: MouseEvent, text: string): void; text: string } | undefined;
  provider.provideLinks(1, (links) => {
    link = links?.[0] as typeof link;
  });
  assert.ok(link, "link was provided");
  let opens = 0;
  Object.defineProperty(mounted.window, "open", {
    configurable: true,
    value: () => {
      opens += 1;
      return {};
    },
  });
  const dispatchMouse = (type: string, init: MouseEventInit) => {
    const event = new mounted.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    host.dispatchEvent(event);
    return event as unknown as MouseEvent;
  };

  dispatchMouse("mousedown", { button: 2, clientX: 20, clientY: 30 });
  const rightUp = dispatchMouse("mouseup", { button: 2, clientX: 20, clientY: 30 });
  link.activate(rightUp, link.text);

  dispatchMouse("mousedown", { button: 0, clientX: 20, clientY: 30 });
  dispatchMouse("mousemove", { button: 0, clientX: 30, clientY: 30 });
  const dragUp = dispatchMouse("mouseup", { button: 0, clientX: 30, clientY: 30 });
  link.activate(dragUp, link.text);
  assert.equal(opens, 0);

  dispatchMouse("mousedown", { button: 0, clientX: 20, clientY: 30 });
  const clickUp = dispatchMouse("mouseup", { button: 0, clientX: 21, clientY: 30 });
  link.activate(clickUp, link.text);
  await flushAsync();
  assert.equal(opens, 1);
});

test("terminal touch prefers an OSC 8 target over a URL-shaped visible label on hybrid devices", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const labelUrl = "https://label.example/path";
  const targetUrl = "https://target.example/path";
  terminal.oscTouchTarget = targetUrl;
  terminal.buffer.active.getLine = () => ({
    isWrapped: false,
    length: labelUrl.length,
    translateToString: (_trimRight?: boolean, startColumn = 0, endColumn = labelUrl.length) =>
      labelUrl.slice(startColumn, endColumn),
    getCell: (column: number) =>
      column < labelUrl.length ? { getChars: () => labelUrl[column] ?? "", getWidth: () => 1 } : undefined,
  });
  const host = terminal.openHost;
  const xtermElement = terminal.element;
  assert.ok(host, "terminal host was mounted");
  assert.ok(xtermElement, "xterm element was mounted");
  Object.defineProperty(mounted.window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(any-pointer: coarse)",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  const confirmations: string[] = [];
  Object.defineProperty(mounted.window, "confirm", {
    configurable: true,
    value: (message: string) => {
      confirmations.push(message);
      return true;
    },
  });
  const opened: string[] = [];
  Object.defineProperty(mounted.window, "open", {
    configurable: true,
    value: (url: string) => {
      opened.push(url);
      return {};
    },
  });
  const dispatchTouch = (type: string) => {
    const event = new mounted.window.Event(type, { bubbles: true, cancelable: true });
    const points = [{ clientX: 100, clientY: 100 }];
    Object.defineProperty(event, "touches", { configurable: true, value: type === "touchend" ? [] : points });
    Object.defineProperty(event, "changedTouches", { configurable: true, value: points });
    host.dispatchEvent(event);
    return event;
  };

  // Match xterm 5.5's stale-cell edge: mouseleave clears the current link but
  // retains the last buffer cell, so one same-cell move does not query again.
  xtermElement.dispatchEvent(new mounted.window.MouseEvent("mousemove", {
    bubbles: true,
    clientX: 100,
    clientY: 100,
  }));
  xtermElement.dispatchEvent(new mounted.window.MouseEvent("mouseleave", { bubbles: false }));

  dispatchTouch("touchstart");
  const touchEnd = dispatchTouch("touchend");
  await flushAsync();

  assert.deepEqual(opened, [targetUrl]);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0] ?? "", /https:\/\/target\.example\/path/);
  assert.equal(touchEnd.defaultPrevented, true);
});

test("TerminalPane routes provider capability events through the public turn callback", async () => {
  const prompts: Array<{ prompt: string; eventId?: string }> = [];
  const mounted = await mountTerminalPane({
    onTurnPromptSubmit: (prompt, eventId) => prompts.push({ prompt, eventId }),
  });
  const transport = mounted.harness.transports[0];
  assert.ok(transport, "transport was created");

  transport.emitProviderPromptCapability("supported");
  transport.emitProviderPromptEvent({
    kind: "prompt_submitted",
    eventId: "pp-integration",
    provider: "codex",
    submittedAt: "2026-07-10T00:00:00Z",
    text: "provider integration prompt",
    truncated: false,
  });

  assert.deepEqual(prompts, [{ prompt: "provider integration prompt", eventId: "pp-integration" }]);
});

test("TerminalPane shows input rejection without presenting a reconnect", async () => {
  const mounted = await mountTerminalPane();
  const transport = mounted.harness.transports[0];
  assert.ok(transport, "transport was created");

  await act(async () => {
    transport.emitOpen();
    transport.emitInputRejected({
      code: "codex-account-next-pending",
      retryable: true,
      outcomeUnknown: false,
    });
    await flushAsync();
  });

  const message = mounted.container.querySelector(".upload-status.error");
  assert.equal(
    message?.textContent,
    "Applying the selected Codex account. Your prompt was not sent; retry shortly.",
  );
  assertNoElement(mounted.container, ".terminal-reconnect");

  await act(async () => {
    transport.emitInputRejected({
      message: "request failed (503)",
      retryable: false,
      outcomeUnknown: true,
    });
    await flushAsync();
  });
  assert.equal(
    mounted.container.querySelector(".upload-status.error")?.textContent,
    "Terminal input may have been sent. Check the session before retrying.",
  );
  assertNoElement(mounted.container, ".terminal-reconnect");

  await act(async () => {
    transport.options.setStatus("closed");
    await flushAsync();
  });
  assert.equal(
    mounted.container.querySelector(".terminal-reconnect")?.textContent,
    "Reconnect",
  );
});

test("TerminalPane preserves terminal CPRs but rejects the same bytes from modified F3", async () => {
  const prompts: Array<{ prompt: string; eventId?: string }> = [];
  const mounted = await mountTerminalPane({
    onTurnPromptSubmit: (prompt, eventId) => prompts.push({ prompt, eventId }),
  });
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");
  transport.emitProviderPromptCapability("fallback");

  terminal.emitData("terminal report prompt");
  terminal.emitData("\x1b[2;1R");
  terminal.emitData("\r");
  assert.deepEqual(prompts, [{ prompt: "terminal report prompt", eventId: undefined }]);

  terminal.emitData("modified function key prompt");
  const pane = mounted.container.querySelector(".terminal-pane");
  assert.ok(pane, "terminal pane was rendered");
  pane.dispatchEvent(new mounted.window.KeyboardEvent("keydown", {
    key: "F3",
    shiftKey: true,
    bubbles: true,
  }));
  terminal.emitData("\x1b[1;2R");
  terminal.emitData("\r");
  assert.deepEqual(prompts, [{ prompt: "terminal report prompt", eventId: undefined }]);
});

test("TerminalPane context menu copies a selection and pastes clipboard text into xterm", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");
  const host = mounted.container.querySelector(".term-host");
  assert.ok(host, "host was rendered");

  await act(async () => {
    terminal.selection = "selected text";
    terminal.emitSelectionChange();
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 42, clientY: 44 }));
    await flushAsync();
  });

  assert.match(mounted.container.innerHTML, /terminal-touch-menu/);
  await act(async () => {
    buttonNamed(mounted.container, "Copy").click();
    await flushAsync();
  });
  assert.deepEqual(mounted.clipboard.writes, ["selected text"]);

  mounted.clipboard.readTextValue = "paste me";
  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 52 }));
    await flushAsync();
  });
  await act(async () => {
    buttonNamed(mounted.container, "Paste").click();
    await flushAsync();
  });
  assert.deepEqual(terminal.pastes, ["paste me"]);
});

test("TerminalPane handles Cmd+Shift+C as one-shot Copy unwrapped without forwarding it", async () => {
  const mounted = await mountTerminalPane();
  enableMacTauri(mounted);
  const terminal = mounted.harness.terminals[0];
  const host = mounted.container.querySelector(".term-host");
  const textarea = mounted.container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  assert.ok(terminal, "terminal was created");
  assert.ok(host, "host was rendered");
  assert.ok(textarea, "xterm helper textarea was rendered");

  const wrapped = [
    'semantic-commit commit --type fix --scope ui --subject "Preserve the complete selected',
    '  command when Codex renders it across terminal rows" --repo "/home/runner/Project/',
    '  exampleOrg/agent-console"',
  ].join("\n");
  let forwardedKeydowns = 0;
  textarea.addEventListener("keydown", () => {
    forwardedKeydowns += 1;
  });

  terminal.selection = wrapped;
  const literalEvent = dispatchTerminalCopyShortcut(mounted, false);
  await flushAsync();
  assert.equal(literalEvent.defaultPrevented, true);
  assert.deepEqual(mounted.clipboard.writes, [wrapped]);

  terminal.selection = "";
  mounted.harness.sessionBuffer = wrapped;
  mounted.harness.sessionBufferResponses.push(
    { text: wrapped },
    { text: wrapped, delayMs: 500 },
  );
  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 40 }));
    host.dispatchEvent(new mounted.window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, clientX: 160, clientY: 90 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushAsync();
  });

  const unwrappedEvent = dispatchTerminalCopyShortcut(mounted, true);
  await flushAsync();
  assert.equal(unwrappedEvent.defaultPrevented, true);
  assert.equal(forwardedKeydowns, 0, "client clipboard shortcuts never reach xterm");
  assert.deepEqual(mounted.clipboard.writes, [
    wrapped,
    'semantic-commit commit --type fix --scope ui --subject "Preserve the complete selected command when Codex renders it across terminal rows" --repo "/home/runner/Project/exampleOrg/agent-console"',
  ]);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const emptyEvent = dispatchTerminalCopyShortcut(mounted, true);
  await flushAsync();
  assert.equal(emptyEvent.defaultPrevented, true, "an empty Copy unwrapped shortcut is still client-consumed");
  assert.deepEqual(mounted.clipboard.writes, [
    wrapped,
    'semantic-commit commit --type fix --scope ui --subject "Preserve the complete selected command when Codex renders it across terminal rows" --repo "/home/runner/Project/exampleOrg/agent-console"',
  ]);
});

test("one-line shortcut is deterministic even with a saved AI opt-in", async () => {
  const mounted = await mountTerminalPane();
  enableMacTauri(mounted);
  mounted.window.localStorage.setItem("ac.clipboardModelEnabled", "true");
  const terminal = mounted.harness.terminals[0];
  terminal.selection = "$ git -C ~/repo\n  status --short\n";
  await act(async () => {
    dispatchTerminalCopyShortcut(mounted, true);
    await flushAsync();
  });
  assert.deepEqual(mounted.clipboard.writes, ["git -C ~/repo status --short"]);
  assert.deepEqual(mounted.harness.clipboardModelRequests, []);
  assert.match(mounted.container.textContent ?? "", /Copied as one line/);
});

for (const android of [false, true]) {
  test(`one-line toolbar action is available in ${android ? 'Android' : 'web'} and keeps normal Copy literal`, async () => {
    const mounted = await mountTerminalPane();
    if (android) {
      Object.defineProperty(mounted.window, '__TAURI_INTERNALS__', { value: { invoke: async () => undefined }, configurable: true });
      Object.defineProperty(mounted.window.navigator, 'userAgent', { value: 'Android', configurable: true });
    }
    const terminal = mounted.harness.terminals[0];
    const host = mounted.container.querySelector('.term-host');
    assert.ok(host);
    const selection = '$ curl --fail \\\n  --location https://example.test/data?x=1&y=%2Fhome\n';
    const openMenu = async () => {
      terminal.selection = selection;
      await act(async () => {
        host.dispatchEvent(new mounted.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }));
        await flushAsync();
      });
    };
    await openMenu();
    const menu = mounted.container.querySelector<HTMLElement>('.terminal-touch-menu');
    assert.ok(menu);
    assert.ok(parseFloat(menu.style.width) >= 406, 'one-line action has an additive toolbar width budget');
    const oneLineButton = buttonNamed(mounted.container, 'Copy as one line');
    assert.equal(oneLineButton.style.flex, '2 1 0px');
    assert.equal(oneLineButton.style.whiteSpace, 'normal', 'narrow panes can wrap the label within the button');
    await act(async () => { buttonNamed(mounted.container, 'Copy').click(); await flushAsync(); });
    await openMenu();
    await act(async () => { buttonNamed(mounted.container, 'Copy as one line').click(); await flushAsync(); });
    assert.deepEqual(mounted.clipboard.writes, [selection, 'curl --fail --location https://example.test/data?x=1&y=%2Fhome']);
    assert.equal(mounted.harness.clipboardModelRequests.length, 0);
    assert.equal(mounted.harness.sessionBufferResponses.length, 0, 'copy does not fetch a new server buffer');
  });
}

test("TerminalPane drops captured clipboard content when the terminal instance changes", async () => {
  const mounted = await mountTerminalPane({ reconnectToken: 0 });
  enableMacTauri(mounted);
  const firstTerminal = mounted.harness.terminals[0];
  assert.ok(firstTerminal, "first terminal was created");

  firstTerminal.selection = "private selection from the previous terminal instance";
  firstTerminal.emitSelectionChange();
  await mounted.rerender({ reconnectToken: 1 });
  assert.equal(mounted.harness.terminals.length, 2, "reconnect creates a replacement terminal instance");

  const event = dispatchTerminalCopyShortcut(mounted, true);
  await flushAsync();
  assert.equal(event.defaultPrevented, true, "the empty shortcut remains client-consumed");
  assert.deepEqual(mounted.clipboard.writes, [], "the replacement instance cannot copy prior selection text");
});

test("TerminalPane context menu offers Copy link only when opened on a URL", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = mounted.container.querySelector(".term-host");
  assert.ok(host, "host was rendered");
  const url = "https://example.test/menu-link";
  const rowText = `${url}${" ".repeat(50)}`;
  terminal.buffer.active.getLine = () => ({
    isWrapped: false,
    length: rowText.length,
    translateToString: (trimRight?: boolean, startColumn = 0, endColumn = rowText.length) => {
      const value = rowText.slice(startColumn, endColumn);
      return trimRight ? value.trimEnd() : value;
    },
    getCell: (column: number) =>
      column < rowText.length ? { getChars: () => rowText[column] ?? "", getWidth: () => 1 } : undefined,
  });

  // Right-click over the URL cells: the resolved link rides on the menu payload.
  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 42, clientY: 44 }));
    await flushAsync();
  });
  const copyLink = buttonNamed(mounted.container, "Copy link");
  assert.ok(copyLink, "Copy link button was rendered");
  assert.match(copyLink.title, /https:\/\/example\.test\/menu-link/);
  await act(async () => {
    copyLink.click();
    await flushAsync();
  });
  assert.deepEqual(mounted.clipboard.writes, [url]);
  assertNoElement(mounted.container, ".terminal-touch-menu");

  // Right-click over trailing blank cells: no link, no Copy link button.
  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 780, clientY: 44 }));
    await flushAsync();
  });
  assert.match(mounted.container.innerHTML, /terminal-touch-menu/);
  const buttons = Array.from(mounted.container.querySelectorAll(".terminal-touch-menu button"));
  assert.ok(buttons.length > 0, "toolbar rendered buttons");
  assert.ok(
    buttons.every((button) => button.textContent !== "Copy link"),
    "no Copy link button off-URL",
  );
});

test("TerminalPane Copy link prefers the disclosed OSC 8 target over visible text", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = mounted.container.querySelector(".term-host");
  assert.ok(host, "host was rendered");
  // The visible label is hard-wrapped by the inner TUI below the terminal
  // width, so text-scan resolution can only ever see this truncated fragment.
  const fullTarget = "https://example.test/download?artifact=agent-console&channel=stable&format=json";
  const truncatedLabel = "https://example.test/download?artifact=agent-console&chann";
  terminal.oscTouchTarget = fullTarget;
  const rowText = `${truncatedLabel}${" ".repeat(30)}`;
  terminal.buffer.active.getLine = () => ({
    isWrapped: false,
    length: rowText.length,
    translateToString: (trimRight?: boolean, startColumn = 0, endColumn = rowText.length) => {
      const value = rowText.slice(startColumn, endColumn);
      return trimRight ? value.trimEnd() : value;
    },
    getCell: (column: number) =>
      column < rowText.length ? { getChars: () => rowText[column] ?? "", getWidth: () => 1 } : undefined,
  });

  // A real hover precedes a desktop right-click: the OSC 8 handler discloses
  // the exact target, and the menu must copy that, not the truncated text.
  await act(async () => {
    terminal.element?.querySelector(".xterm-screen")?.dispatchEvent(
      new mounted.window.MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
    );
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    await flushAsync();
  });
  const copyLink = buttonNamed(mounted.container, "Copy link");
  assert.match(copyLink.title, /channel=stable&format=json/);
  // The probe dismisses its hover popup only where pointer click-to-open is
  // disabled. Here the popup is the desktop click's own disclosure, so it must
  // survive the menu.
  assert.equal(
    host.querySelectorAll(".terminal-link-hover").length,
    1,
    "a non-tracking pane keeps the hover disclosure a click is about to act on",
  );
  await act(async () => {
    copyLink.click();
    await flushAsync();
  });
  assert.deepEqual(mounted.clipboard.writes, [fullTarget]);

  // After the pointer leaves the link, the menu falls back to text resolution.
  await act(async () => {
    terminal.element?.querySelector(".xterm-screen")?.dispatchEvent(
      new mounted.window.MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }),
    );
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 42, clientY: 44 }));
    await flushAsync();
  });
  const fallbackCopyLink = buttonNamed(mounted.container, "Copy link");
  assert.match(fallbackCopyLink.title, /chann(?!el)/);
});

test("TerminalPane long-press probe discloses the OSC 8 target without a prior hover", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = mounted.container.querySelector(".term-host");
  assert.ok(host, "host was rendered");
  const fullTarget = "https://example.test/download?artifact=agent-console&channel=stable&format=json";
  terminal.oscTouchTarget = fullTarget;
  const rowText = `https://example.test/download?artifact=agent-console&chann${" ".repeat(30)}`;
  terminal.buffer.active.getLine = () => ({
    isWrapped: false,
    length: rowText.length,
    translateToString: (trimRight?: boolean, startColumn = 0, endColumn = rowText.length) => {
      const value = rowText.slice(startColumn, endColumn);
      return trimRight ? value.trimEnd() : value;
    },
    getCell: (column: number) =>
      column < rowText.length ? { getChars: () => rowText[column] ?? "", getWidth: () => 1 } : undefined,
  });

  // The touch shape: no hover ever happened; the menu's synthetic pointer
  // probe alone must produce the disclosure.
  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    await flushAsync();
  });
  const copyLink = buttonNamed(mounted.container, "Copy link");
  assert.match(copyLink.title, /channel=stable&format=json/);
  await act(async () => {
    copyLink.click();
    await flushAsync();
  });
  assert.deepEqual(mounted.clipboard.writes, [fullTarget]);
});

test("TerminalPane copies the drag-warmed tmux buffer from the menu", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = mounted.container.querySelector(".term-host");
  assert.ok(host, "host was rendered");
  mounted.harness.sessionBuffer = "tmux buffered selection";

  // A real drag (down, move past the threshold, up) schedules the settle
  // fetches that fill the buffer cache; the menu then treats it as copyable.
  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 40, clientY: 40 }));
    host.dispatchEvent(new mounted.window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, clientX: 160, clientY: 90 }));
    await new Promise((resolve) => setTimeout(resolve, 140));
    await flushAsync();
  });
  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 160, clientY: 90 }));
    await flushAsync();
  });
  await act(async () => {
    buttonNamed(mounted.container, "Copy").click();
    await flushAsync();
  });

  assert.deepEqual(mounted.clipboard.writes, ["tmux buffered selection"]);
});

test("TerminalPane menu re-resolves the link at the pressed point instead of reusing a stale disclosure", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = mounted.container.querySelector(".term-host");
  assert.ok(host, "host was rendered");
  terminal.oscTouchTarget = "https://example.test/stale-target";

  // Disclose the link, then open the menu at a different, link-free point
  // without any real pointer movement in between (the touch shape: nothing
  // ever fires xterm's leave). The menu must not offer the stale target.
  await act(async () => {
    terminal.element?.querySelector(".xterm-screen")?.dispatchEvent(
      new mounted.window.MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
    );
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    await flushAsync();
  });
  assert.match(mounted.container.innerHTML, /terminal-touch-menu/);
  const buttons = Array.from(mounted.container.querySelectorAll(".terminal-touch-menu button"));
  assert.ok(
    buttons.every((button) => button.textContent !== "Copy link"),
    "stale disclosure must not surface as Copy link at an unrelated point",
  );
});

test("TerminalPane never donates a resting hover's URL to a long-press elsewhere", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = mounted.container.querySelector(".term-host");
  assert.ok(host, "host was rendered");
  // Hybrid device shape: the mouse rests on an OSC 8 link (disclosure live,
  // leave never fires) while a touch long-press opens the menu elsewhere in a
  // mode-1003 pane. The disclosure is invalidated and re-probed at the pressed
  // point — and the re-probe is not enough on its own: xterm resolves links
  // through a callback, so it can still answer with the link it was already
  // holding, whose range does not contain the pressed cell. Only the range
  // scoping refuses that, so the menu must not offer the resting URL.
  terminal.modes.mouseTrackingMode = "any";
  terminal.oscTouchTarget = "https://example.test/resting-hover-target";
  terminal.oscTouchCells = ["100:100", "400:300"];
  terminal.oscTouchRange = { start: { x: 1, y: 1 }, end: { x: 80, y: 1 } };
  await act(async () => {
    terminal.element?.querySelector(".xterm-screen")?.dispatchEvent(
      new mounted.window.MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }),
    );
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    await flushAsync();
  });
  assert.match(mounted.container.innerHTML, /terminal-touch-menu/);
  const buttons = Array.from(mounted.container.querySelectorAll(".terminal-touch-menu button"));
  assert.ok(
    buttons.every((button) => button.textContent !== "Copy link"),
    "a resting hover's URL must not attach to an unrelated long-press",
  );
});

test("TerminalPane menu probe resolves in an any-motion TUI without forwarding motion", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = mounted.container.querySelector(".term-host");
  assert.ok(host, "host was rendered");
  // The probe runs in every pane — a mode-1003 TUI is exactly where agent
  // output lives — and stays local by not bubbling: xterm's linkifier listens
  // on .xterm-screen (the dispatch target) while its any-motion reporter
  // listens on term.element, which a non-bubbling event never reaches.
  terminal.modes.mouseTrackingMode = "any";
  terminal.oscTouchTarget = "https://example.test/tracked/probe-target";
  let forwardedMoves = 0;
  terminal.element?.addEventListener("mousemove", () => {
    forwardedMoves += 1;
  });
  let linkifierMoves = 0;
  terminal.element?.querySelector(".xterm-screen")?.addEventListener("mousemove", () => {
    linkifierMoves += 1;
  });

  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    await flushAsync();
  });

  assert.match(mounted.container.innerHTML, /terminal-touch-menu/);
  assert.match(buttonNamed(mounted.container, "Copy link").title, /probe-target/);
  assert.equal(linkifierMoves, 2, "the probe reaches xterm's linkifier on the screen element");
  assert.equal(forwardedMoves, 0, "mode-1003 panes must not receive probe mousemoves");
  assert.equal(
    host.querySelectorAll(".terminal-link-hover").length,
    0,
    "the menu discloses through Copy link, not a popup touch can never dismiss",
  );
});

test("TerminalPane menu never treats a stale tmux buffer as a selection", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const host = mounted.container.querySelector(".term-host");
  assert.ok(host, "host was rendered");
  // The tmux server can hold an old selection from long ago; with no local
  // selection and no recent drag, Copy must report nothing instead of copying it.
  mounted.harness.sessionBuffer = "ancient buffer text from another day";

  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 52 }));
    await flushAsync();
  });
  await act(async () => {
    buttonNamed(mounted.container, "Copy").click();
    await flushAsync();
  });

  assert.deepEqual(mounted.clipboard.writes, []);
  assert.match(mounted.container.innerHTML, /Nothing to copy/);
});

test("TerminalPane preserves control-looking clipboard text as text input", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  const host = mounted.container.querySelector(".term-host");
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");
  assert.ok(host, "host was rendered");
  mounted.clipboard.readTextValue = "\x1b[A";

  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 52,
    }));
    await flushAsync();
  });
  await act(async () => {
    buttonNamed(mounted.container, "Paste").click();
    await flushAsync();
  });

  assert.deepEqual(terminal.pastes, ["\x1b[A"]);
  assert.deepEqual(transport.sentInputs, [{ text: "\x1b[A" }]);
});

test("TerminalPane reports clipboard read failures without pasting terminal text", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const host = mounted.container.querySelector(".term-host");
  assert.ok(terminal, "terminal was created");
  assert.ok(host, "host was rendered");
  mounted.clipboard.readTextError = new Error("clipboard denied");

  await act(async () => {
    host.dispatchEvent(new mounted.window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 52,
    }));
    await flushAsync();
  });
  await act(async () => {
    buttonNamed(mounted.container, "Paste").click();
    await flushAsync();
  });

  assert.deepEqual(terminal.pastes, []);
  assert.match(mounted.container.innerHTML, /Clipboard paste unavailable/);
});

test("TerminalPane uploads pasted files and ignores stale upload completions", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");

  mounted.harness.uploadResponses.push(
    { ok: true, path: "/tmp/first.txt", delayMs: 25 },
    { ok: true, path: "/tmp/second.txt" },
  );
  const first = new mounted.window.File(["one"], "first.txt", { type: "text/plain" });
  const second = new mounted.window.File(["two"], "second.txt", { type: "text/plain" });

  await act(async () => {
    const firstEvent = dispatchFilePaste(mounted, [first]);
    const secondEvent = dispatchFilePaste(mounted, [second]);
    assert.equal(firstEvent.defaultPrevented, true);
    assert.equal(secondEvent.defaultPrevented, true);
    await flushAsync(40);
  });

  assert.deepEqual(mounted.harness.uploadedFiles, [
    { machine: "summit", id: "hs-1", name: "first.txt" },
    { machine: "summit", id: "hs-1", name: "second.txt" },
  ]);
  assert.deepEqual(terminal.pastes, []);
  assert.deepEqual(transport.sentInputs, [{ text: "'/tmp/second.txt' " }]);
  assert.match(mounted.container.textContent ?? "", /Uploaded file/);
});

test("TerminalPane re-pins to the bottom when it becomes the active focused session", async () => {
  // A background pane in focused mode (e.g. session B while viewing session A):
  // focused mode is already on so readableFit stays true throughout, but this
  // pane is not the one currently shown, so autoFocus starts false.
  const mounted = await mountTerminalPane({ readableFit: true, autoFocus: false });
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const baseline = terminal.scrollBottomCalls;

  // Switch TO this session ("exit A, enter B"): readableFit does not change, so
  // the readable-fit effect never fires; only autoFocus flips false -> true.
  // The newly shown session must still scroll to the latest output.
  await mounted.rerender({ autoFocus: true });
  assert.ok(
    terminal.scrollBottomCalls > baseline,
    "switching to a session in focused mode should scroll it to the bottom",
  );
});

test("TerminalPane does not re-pin when it stops being the active focused session", async () => {
  // The forced re-pin is directional: only a pane BECOMING active should scroll.
  // Switching AWAY (autoFocus true -> false) must not steal scroll position from
  // the session the user is leaving.
  const mounted = await mountTerminalPane({ readableFit: true, autoFocus: true });
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const baseline = terminal.scrollBottomCalls;

  await mounted.rerender({ autoFocus: false });
  assert.equal(
    terminal.scrollBottomCalls,
    baseline,
    "leaving a focused session should not force a scroll to bottom",
  );
});

test("TerminalPane keeps an active selection when it becomes the active focused session", async () => {
  // Becoming active forces a bottom-pin, but an in-progress text selection must
  // still win (scrolling to bottom mid-drag reflows the selection and Cmd+C then
  // copies the wrong range — see terminalBottomPin.shouldAutoPinBottom).
  const mounted = await mountTerminalPane({ readableFit: true, autoFocus: false });
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  terminal.selection = "selected text";
  const baseline = terminal.scrollBottomCalls;

  await mounted.rerender({ autoFocus: true });
  assert.equal(
    terminal.scrollBottomCalls,
    baseline,
    "an active selection should suppress the forced bottom-pin on switch-in",
  );
});

test("TerminalPane reports failed dropped file uploads without pasting a path", async () => {
  const mounted = await mountTerminalPane();
  const terminal = mounted.harness.terminals[0];
  const transport = mounted.harness.transports[0];
  assert.ok(terminal, "terminal was created");
  assert.ok(transport, "transport was created");
  mounted.harness.uploadResponses.push({ ok: false, error: "Upload denied" });
  const file = new mounted.window.File(["blocked"], "blocked.txt", { type: "text/plain" });

  await act(async () => {
    const event = dispatchFileDrop(mounted, [file]);
    assert.equal(event.defaultPrevented, true);
    await flushAsync();
  });

  assert.deepEqual(mounted.harness.uploadedFiles, [
    { machine: "summit", id: "hs-1", name: "blocked.txt" },
  ]);
  assert.deepEqual(terminal.pastes, []);
  assert.deepEqual(transport.sentInputs, []);
  assert.match(mounted.container.querySelector(".upload-status.error")?.textContent ?? "", /Upload denied/);
});

// xterm never clears CompositionHelper._isComposing on blur, and Chrome on
// Android reports keyCode 229 for every soft-keyboard character. A composition
// left in flight when the pane drops terminal focus therefore swallows all
// later typing until the page is reloaded. See terminalComposition.ts.
function helperTextarea(mounted: MountedPane): HTMLTextAreaElement {
  const textarea = mounted.container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  assert.ok(textarea, "xterm helper textarea was rendered");
  return textarea;
}

function watchCompositionEnds(textarea: HTMLTextAreaElement): string[] {
  const seen: string[] = [];
  textarea.addEventListener("compositionend", () => seen.push("compositionend"));
  return seen;
}

function startComposition(mounted: MountedPane, textarea: HTMLTextAreaElement): void {
  textarea.dispatchEvent(
    new mounted.window.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event,
  );
}

test("Upload closes an in-flight IME composition before the file chooser takes the WebView", async () => {
  const mounted = await mountTerminalPane({ showKeyBar: true });
  const terminal = mounted.harness.terminals[0];
  assert.ok(terminal, "terminal was created");
  const textarea = helperTextarea(mounted);
  const ends = watchCompositionEnds(textarea);
  const blurredBefore = terminal.blurred;

  startComposition(mounted, textarea);
  await act(async () => {
    buttonNamed(mounted.container, "Upload").click();
    await flushAsync();
  });

  assert.deepEqual(ends, ["compositionend"], "xterm must be finalized before the Activity switch");
  assert.ok(terminal.blurred > blurredBefore, "terminal focus is dropped deterministically, not by a viewport guess");
});

test("Upload does not replay a finished composition into the terminal", async () => {
  const mounted = await mountTerminalPane({ showKeyBar: true });
  const textarea = helperTextarea(mounted);
  const ends = watchCompositionEnds(textarea);

  startComposition(mounted, textarea);
  textarea.dispatchEvent(
    new mounted.window.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event,
  );
  await act(async () => {
    buttonNamed(mounted.container, "Upload").click();
    await flushAsync();
  });

  assert.equal(ends.length, 1, "a real compositionend must not be followed by a synthetic one");
});

test("refocusing the terminal recovers a composition stranded by the file chooser", async () => {
  const mounted = await mountTerminalPane({ showKeyBar: true });
  const textarea = helperTextarea(mounted);
  const ends = watchCompositionEnds(textarea);

  // The Activity switch can drop the IME connection without delivering the
  // matching compositionend; the next focus is the app's chance to recover.
  startComposition(mounted, textarea);
  await act(async () => {
    textarea.dispatchEvent(new mounted.window.Event("focus", { bubbles: false }) as unknown as Event);
    await flushAsync();
  });

  assert.deepEqual(ends, ["compositionend"]);
});


test("Shell terminal uses shell attach and local clipboard without agent fallback or model processing", async () => {
  const mounted = await mountTerminalPane({agent:"shell",id:"shell-one"}); enableMacTauri(mounted);
  const terminal = mounted.harness.terminals[0]; const transport = mounted.harness.transports[0];
  const options = transport.options as unknown as { attachTarget(machine:string,id:string):Promise<{url:string}>; sendFallback(machine:string,id:string,body:unknown):Promise<unknown> };
  assert.match((await options.attachTarget("a","shell-one")).url,/\/shells\/a\/shell-one$/);
  const fallback = await options.sendFallback("a","shell-one",{text:"pwd"}) as {ok:boolean};
  assert.equal(fallback.ok,false); assert.equal(mounted.harness.fallbackInputs.length,0);
  assert.equal([...mounted.container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Upload"),false);
  mounted.window.localStorage.setItem("ac.clipboardModelEnabled","true");
  terminal.selection = "private\n  shell text";
  await act(async () => { dispatchTerminalCopyShortcut(mounted,true); await flushAsync(); });
  assert.equal(mounted.harness.clipboardModelRequests.length,0);
  assert.equal(mounted.clipboard.writes.length,1);
  await mounted.unmount(); assert.equal(transport.disposed,true);
});
