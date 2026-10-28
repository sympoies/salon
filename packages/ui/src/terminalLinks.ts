import type { IBufferRange, ILink, ILinkHandler, ILinkProvider } from "@xterm/xterm";
import { isTauri } from "./runtime.ts";

const URL_START_RE = /\b(?:https?:\/\/|www\.)/gi;
const TRAILING_PUNCTUATION_RE = /[,.;:!?]+$/;
const HARD_URL_BOUNDARY_RE = /[\s<>"'`，。；：！？、（）［］｛｝【】〈〉《》「」『』〔〕〖〗〘〙〚〛…—＂＇｀＜＞]/u;
const OPENING_DELIMITERS: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}",
};
const CLOSING_DELIMITERS = new Set(Object.values(OPENING_DELIMITERS));
const MAX_URL_LENGTH = 2048;
export const DEFAULT_MAX_LINK_SCAN_CODE_UNITS = 4096;
const DEFAULT_MAX_LINK_SCAN_ROWS = 128;
const DEFAULT_MAX_LINKS_PER_LOGICAL_LINE = 64;

export interface TerminalUrlOpeners {
  readonly isTauri: () => boolean;
  readonly openNativeUrl: (url: string) => Promise<void>;
  readonly openBrowserUrl: (
    url: string,
    target: string,
    features: string,
  ) => Window | null | undefined;
}

interface TerminalLinkBufferCell {
  getChars(): string;
  getWidth(): number;
}

export interface TerminalLinkBufferLine {
  readonly isWrapped: boolean;
  readonly length?: number;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  getCell?(column: number): TerminalLinkBufferCell | undefined;
}

export interface TerminalLinkBuffer {
  getLine(row: number): TerminalLinkBufferLine | undefined;
}

interface TerminalLinkProviderTerminal {
  readonly buffer: { readonly active: TerminalLinkBuffer };
}

interface TerminalLinkHoverTarget {
  // `range` carries the resolved link's buffer cells so a caller can scope a
  // disclosure to the hovered link; the visual popup itself ignores it.
  hover(event: MouseEvent, text: string, range?: IBufferRange): void;
  leave(): void;
  dispose(): void;
}

interface TerminalLinkProviderStats {
  readonly providerCalls: number;
  readonly logicalLineScans: number;
  readonly cacheHits: number;
  readonly truncatedScans: number;
  readonly scannedRows: number;
  readonly scannedCodeUnits: number;
  readonly maxScannedCodeUnits: number;
}

interface InstrumentedTerminalLinkProvider extends ILinkProvider {
  stats(): TerminalLinkProviderStats;
}

type TerminalUrlOpener = (url: string) => boolean | Promise<boolean>;

interface TerminalTextLink {
  readonly start: number;
  readonly end: number;
  readonly url: string;
}

interface TerminalLinkActivationGuard {
  onMouseDown(event: MouseEvent): void;
  onMouseMove(event: MouseEvent): void;
  onMouseUp(event: MouseEvent): void;
  canActivate(event: MouseEvent): boolean;
}

interface LogicalLineSegment {
  readonly row: number;
  readonly text: string;
  readonly textStart: number;
  readonly line: TerminalLinkBufferLine;
}

interface LogicalLineWindow {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly text: string;
  readonly segments: readonly LogicalLineSegment[];
  readonly scannedRows: number;
  readonly truncated: boolean;
}

function scanTerminalUrlCandidate(lineText: string, start: number): string {
  const expectedClosers: string[] = [];
  let end = start;

  while (end < lineText.length) {
    const codePoint = lineText.codePointAt(end);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    if (HARD_URL_BOUNDARY_RE.test(character)) {
      break;
    }

    const closer = OPENING_DELIMITERS[character];
    if (closer) {
      expectedClosers.push(closer);
    } else if (CLOSING_DELIMITERS.has(character)) {
      if (expectedClosers.at(-1) !== character) {
        break;
      }
      expectedClosers.pop();
    }
    end += character.length;
  }

  return lineText.slice(start, end);
}

function trimTerminalUrlCandidate(value: string): string {
  const withoutTrailingPunctuation = value.replace(TRAILING_PUNCTUATION_RE, "");
  return scanTerminalUrlCandidate(withoutTrailingPunctuation, 0);
}

// Validate a terminal-advertised URL WITHOUT prose trimming. Explicit OSC 8
// targets are terminal-controlled and must open exactly as advertised, so they
// pass only the constant-time size gate, the `www.` scheme completion, and the
// http(s) protocol allowlist — never the trailing-punctuation / unmatched-
// delimiter trimming, which is appropriate only for text-scanned implicit links.
export function validateTerminalUrl(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return null;
  }
  const normalized = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

function normalizeTerminalUrl(raw: string): string | null {
  // Implicit links are scanned out of prose, so oversized candidates are
  // rejected before delimiter scanning or string copies, then trailing
  // punctuation and unmatched delimiters are trimmed before validation.
  if (raw.length > MAX_URL_LENGTH) {
    return null;
  }
  return validateTerminalUrl(trimTerminalUrlCandidate(raw));
}

const URL_ANCHOR_RE = /^(?:https?:\/\/|www\.)/i;

function findTerminalTextLinks(
  lineText: string,
  maxLinks = DEFAULT_MAX_LINKS_PER_LOGICAL_LINE,
  junctionOffsets: readonly number[] = [],
): TerminalTextLink[] {
  const links: TerminalTextLink[] = [];
  const matcher = new RegExp(URL_START_RE.source, URL_START_RE.flags);
  // Rows joined by the hard-wrap heuristic can place a URL start directly
  // after a word character (`…hashahttps://`), where `\b` never matches, so
  // row junctions are URL start anchors of their own. Without them, joining
  // could suppress a link that per-row scanning would have found.
  const anchors = [...new Set(junctionOffsets)]
    .filter(
      (offset) =>
        offset > 0 && offset < lineText.length && URL_ANCHOR_RE.test(lineText.slice(offset, offset + 8)),
    )
    .sort((left, right) => left - right);
  let anchorIndex = 0;
  let cursor = 0;
  while (links.length < maxLinks) {
    matcher.lastIndex = cursor;
    const match = matcher.exec(lineText);
    while (anchorIndex < anchors.length && (anchors[anchorIndex] as number) < cursor) {
      anchorIndex += 1;
    }
    const candidateStarts = [match?.index, anchors[anchorIndex]].filter(
      (value): value is number => value !== undefined,
    );
    if (candidateStarts.length === 0) {
      break;
    }
    const start = Math.min(...candidateStarts);
    const raw = scanTerminalUrlCandidate(lineText, start);
    const trimmed = trimTerminalUrlCandidate(raw);
    // Whether valid or not, everything scanned before the next hard boundary
    // belongs to this candidate. Skipping it prevents nested invalid prefixes
    // from restarting the bounded scanner at every character position, and a
    // strictly increasing cursor keeps discovery single-pass.
    const matchedLength = match && match.index === start ? match[0].length : 1;
    cursor = Math.max(cursor + 1, start + Math.max(raw.length, matchedLength));
    const url = normalizeTerminalUrl(trimmed);
    if (!url) {
      continue;
    }
    links.push({ start, end: start + trimmed.length, url });
    // A valid URL may itself contain text that looks like another URL prefix.
    // Advancing beyond the accepted candidate prevents overlapping ranges from
    // multiplying range-mapping work.
    cursor = Math.max(cursor, start + trimmed.length);
  }
  return links;
}

export function resolveTerminalUrlAtCell(
  lineText: string,
  cellColumn: number,
  junctionOffsets: readonly number[] = [],
): string | null {
  if (!Number.isInteger(cellColumn) || cellColumn < 0) {
    return null;
  }
  return (
    findTerminalTextLinks(lineText, DEFAULT_MAX_LINKS_PER_LOGICAL_LINE, junctionOffsets).find(
      (link) => cellColumn >= link.start && cellColumn < link.end,
    )?.url ?? null
  );
}

function rowWidth(line: TerminalLinkBufferLine): number {
  return line.length ?? line.translateToString(false).length;
}

// The tmux transport defeats xterm's soft-wrap flag: attach replay arrives as
// hard capture-pane rows and live repaints as cursor-addressed row rewrites, so
// a visually wrapped URL sits on rows with `isWrapped === false`. A row filled
// to its final column may therefore be a hard-wrapped continuation; joining it
// with the next row lets URL detection span the break, while the tokenizer's
// boundary rules still separate ordinary prose junctions.
function rowFlowsIntoNextRow(line: TerminalLinkBufferLine | undefined): boolean {
  if (!line) {
    return false;
  }
  const width = rowWidth(line);
  return width > 0 && line.translateToString(true).length >= width;
}

function logicalLineBounds(
  buffer: TerminalLinkBuffer,
  row: number,
  maxRows: number,
  maxCodeUnits: number,
): { firstRow: number; lastRow: number } | null {
  const anchor = buffer.getLine(row);
  if (!anchor) {
    return null;
  }
  // Phase 1: xterm's own soft-wrap chain, with the original fail-closed row
  // bound. Its window — including a possible code-unit truncation in the
  // window read — matches the pre-heuristic behavior exactly.
  let firstRow = row;
  let lastRow = row;
  let visited = 1;
  while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) {
    firstRow -= 1;
    visited += 1;
    if (visited > maxRows) {
      return null;
    }
  }
  while (buffer.getLine(lastRow + 1)?.isWrapped) {
    lastRow += 1;
    visited += 1;
    if (visited > maxRows) {
      return null;
    }
  }
  // Phase 2: heuristic hard-wrap joins. Every row joined here — including a
  // soft-wrap chain reached through a heuristic junction — is budgeted against
  // the remaining row and code-unit headroom, so heuristic joining can never
  // newly push the window into the truncation fail-close; walls of full rows
  // keep their per-row links instead. Per direction the reach is additionally
  // capped at MAX_URL_LENGTH because a longer candidate cannot be a valid URL.
  let totalUnits = 0;
  for (let currentRow = firstRow; currentRow <= lastRow; currentRow += 1) {
    const line = buffer.getLine(currentRow);
    totalUnits += line ? rowWidth(line) : 0;
  }
  let unitsAbove = 0;
  while (firstRow > 0) {
    const previous = buffer.getLine(firstRow - 1);
    if (!previous) {
      break;
    }
    if (!(buffer.getLine(firstRow)?.isWrapped || rowFlowsIntoNextRow(previous))) {
      break;
    }
    const width = rowWidth(previous);
    if (visited + 1 > maxRows || unitsAbove + width > MAX_URL_LENGTH || totalUnits + width > maxCodeUnits) {
      break;
    }
    firstRow -= 1;
    visited += 1;
    unitsAbove += width;
    totalUnits += width;
  }
  let unitsBelow = 0;
  while (true) {
    const next = buffer.getLine(lastRow + 1);
    if (!next) {
      break;
    }
    if (!(next.isWrapped || rowFlowsIntoNextRow(buffer.getLine(lastRow)))) {
      break;
    }
    const width = rowWidth(next);
    if (visited + 1 > maxRows || unitsBelow + width > MAX_URL_LENGTH || totalUnits + width > maxCodeUnits) {
      break;
    }
    lastRow += 1;
    visited += 1;
    unitsBelow += width;
    totalUnits += width;
  }
  return { firstRow, lastRow };
}

function readLogicalLineWindow(
  buffer: TerminalLinkBuffer,
  row: number,
  {
    maxCodeUnits = DEFAULT_MAX_LINK_SCAN_CODE_UNITS,
    maxRows = DEFAULT_MAX_LINK_SCAN_ROWS,
    trimRight = true,
  }: { readonly maxCodeUnits?: number; readonly maxRows?: number; readonly trimRight?: boolean } = {},
): LogicalLineWindow | null {
  const bounds = logicalLineBounds(buffer, row, maxRows, maxCodeUnits);
  if (!bounds) {
    return null;
  }
  const segments: LogicalLineSegment[] = [];
  let text = "";
  for (let currentRow = bounds.firstRow; currentRow <= bounds.lastRow; currentRow += 1) {
    const line = buffer.getLine(currentRow);
    if (!line) {
      return null;
    }
    // Wrapped rows must retain their full cell width so a trailing space stays
    // a URL boundary and string offsets still map 1:1 to the following row.
    // Only the final logical row may safely drop unused right-side cells.
    const currentText = line.translateToString(trimRight && currentRow === bounds.lastRow);
    if (text.length + currentText.length > maxCodeUnits) {
      return {
        firstRow: bounds.firstRow,
        lastRow: bounds.lastRow,
        text: text.slice(0, maxCodeUnits),
        segments,
        scannedRows: segments.length + 1,
        truncated: true,
      };
    }
    segments.push({ row: currentRow, text: currentText, textStart: text.length, line });
    text += currentText;
  }
  return {
    firstRow: bounds.firstRow,
    lastRow: bounds.lastRow,
    text,
    segments,
    scannedRows: segments.length,
    truncated: false,
  };
}

// xterm stores a soft-wrapped line as consecutive buffer rows. A URL can span
// those rows on a narrow phone screen, so resolve it from the complete logical
// line rather than opening the fragment from the tapped row.
export function resolveTerminalUrlAtBufferCell(
  buffer: TerminalLinkBuffer,
  row: number,
  column: number,
): string | null {
  const tappedLine = buffer.getLine(row);
  if (!tappedLine || !Number.isInteger(column) || column < 0) {
    return null;
  }
  const logicalLine = readLogicalLineWindow(buffer, row, { trimRight: false });
  if (!logicalLine || logicalLine.truncated) {
    return null;
  }
  const tappedSegment = logicalLine.segments.find((segment) => segment.row === row);
  if (!tappedSegment) {
    return null;
  }
  const cellOffset =
    tappedSegment.textStart + Math.max(0, tappedLine.translateToString(false, 0, column + 1).length - 1);
  return resolveTerminalUrlAtCell(logicalLine.text, cellOffset, heuristicJunctionOffsets(logicalLine.segments));
}

// URL start anchors apply only at heuristic hard-wrap junctions. A genuine
// isWrapped boundary proves the rows are one logical word, so a scheme that
// happens to start at the wrap column must stay plain text there.
function heuristicJunctionOffsets(segments: readonly LogicalLineSegment[]): number[] {
  return segments
    .slice(1)
    .filter((segment) => !segment.line.isWrapped)
    .map((segment) => segment.textStart);
}

function cellRangesForLine(
  line: TerminalLinkBufferLine,
  textLength: number,
): readonly { readonly start: number; readonly end: number }[] {
  if (!line.getCell || line.length === undefined) {
    return Array.from({ length: textLength }, (_, index) => ({ start: index + 1, end: index + 1 }));
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell) {
      continue;
    }
    const width = cell.getWidth();
    if (width === 0) {
      continue;
    }
    const codeUnits = cell.getChars().length || 1;
    for (let index = 0; index < codeUnits && ranges.length < textLength; index += 1) {
      ranges.push({ start: column + 1, end: column + Math.max(1, width) });
    }
  }
  const end = Math.max(1, line.length);
  while (ranges.length < textLength) {
    ranges.push({ start: end, end });
  }
  return ranges;
}

function bufferRangeForTextLink(
  segments: readonly LogicalLineSegment[],
  link: TerminalTextLink,
  cellRanges: ReadonlyMap<LogicalLineSegment, readonly { readonly start: number; readonly end: number }[]>,
): IBufferRange | null {
  const startSegment = segments.find(
    (segment) => link.start >= segment.textStart && link.start < segment.textStart + segment.text.length,
  );
  const lastCodeUnit = link.end - 1;
  const endSegment = segments.find(
    (segment) => lastCodeUnit >= segment.textStart && lastCodeUnit < segment.textStart + segment.text.length,
  );
  if (!startSegment || !endSegment) {
    return null;
  }
  const startCell = cellRanges.get(startSegment)?.[link.start - startSegment.textStart];
  const endCell = cellRanges.get(endSegment)?.[lastCodeUnit - endSegment.textStart];
  if (!startCell || !endCell) {
    return null;
  }
  return {
    start: { x: startCell.start, y: startSegment.row + 1 },
    end: { x: endCell.end, y: endSegment.row + 1 },
  };
}

function activateTerminalUrl(
  event: MouseEvent,
  rawUrl: string,
  openUrl: TerminalUrlOpener,
  canActivate: (event: MouseEvent) => boolean,
  requiresConfirmation: (event: MouseEvent) => boolean,
  confirmUrl: (url: string) => boolean,
  onActivationAttempt: (() => void) | undefined,
): void {
  if (!canActivate(event)) {
    return;
  }
  onActivationAttempt?.();
  const safeUrl = normalizeTerminalUrl(rawUrl);
  if (!safeUrl) {
    return;
  }
  // Disclose the normalized target, which is what actually opens. An implicit
  // link is joined across wrapped rows, so the tapped row can show only its
  // head while the rest sits below the viewport.
  if (requiresConfirmation(event) && !confirmUrl(safeUrl)) {
    return;
  }
  void Promise.resolve(openUrl(safeUrl));
}

export function createTerminalLinkActivationGuard({
  moveThresholdPx = 3,
}: {
  readonly moveThresholdPx?: number;
} = {}): TerminalLinkActivationGuard {
  let pointerDown: { readonly x: number; readonly y: number; dragged: boolean } | null = null;
  let lastMouseUp: { readonly event: MouseEvent; readonly allowed: boolean } | null = null;
  return {
    onMouseDown(event) {
      lastMouseUp = null;
      pointerDown = event.button === 0
        ? { x: event.clientX, y: event.clientY, dragged: false }
        : null;
    },
    onMouseMove(event) {
      if (!pointerDown) {
        return;
      }
      if (
        Math.abs(event.clientX - pointerDown.x) > moveThresholdPx ||
        Math.abs(event.clientY - pointerDown.y) > moveThresholdPx
      ) {
        pointerDown.dragged = true;
      }
    },
    onMouseUp(event) {
      const active = pointerDown;
      pointerDown = null;
      lastMouseUp = {
        event,
        allowed:
          event.button === 0 &&
          active !== null &&
          !active.dragged &&
          Math.abs(event.clientX - active.x) <= moveThresholdPx &&
          Math.abs(event.clientY - active.y) <= moveThresholdPx,
      };
    },
    canActivate(event) {
      return lastMouseUp?.event === event && lastMouseUp.allowed;
    },
  };
}

// One disclosure prompt for every path that opens a terminal-supplied URL
// without a hover to show it first. Terminal output chooses both the target and
// whatever text sits next to it, so the target has to be shown by something the
// output does not control before anything is opened.
export function confirmTerminalLinkOpen(url: string): boolean {
  return window.confirm(`Open this terminal link?\n\n${url}`);
}

export function createTerminalLinkHoverTarget(host: HTMLElement): TerminalLinkHoverTarget {
  let popup: HTMLElement | null = null;
  const leave = () => {
    popup?.remove();
    popup = null;
  };
  return {
    hover(_event, text) {
      leave();
      // The hover target discloses the exact URL that will be opened. Implicit
      // links arrive already trimmed; explicit OSC 8 targets must be shown
      // verbatim, so validate without re-trimming in either case.
      const safeText = validateTerminalUrl(text);
      if (!safeText) {
        return;
      }
      const target = host.ownerDocument.createElement("div");
      target.className = "terminal-link-hover xterm-hover";
      target.dataset.terminalLinkHover = "";
      target.setAttribute("role", "status");
      target.setAttribute("aria-live", "polite");
      target.textContent = safeText;
      target.title = safeText;
      Object.assign(target.style, {
        position: "absolute",
        zIndex: "6",
        right: "8px",
        bottom: "8px",
        maxWidth: "calc(100% - 16px)",
        overflow: "hidden",
        padding: "4px 7px",
        border: "1px solid color-mix(in srgb, var(--cyan) 55%, transparent)",
        borderRadius: "6px",
        background: "var(--terminal-popup-bg)",
        color: "var(--fg)",
        fontSize: "11px",
        lineHeight: "1.3",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        pointerEvents: "auto",
      });
      host.appendChild(target);
      popup = target;
    },
    leave,
    dispose: leave,
  };
}

export function createTerminalLinkProvider(
  terminal: TerminalLinkProviderTerminal,
  {
    openUrl = openExternalTerminalUrl,
    canActivate = (event) => event.button === 0,
    hoverTarget,
    requiresConfirmation = () => false,
    confirmUrl = () => false,
    onActivationAttempt,
    maxCodeUnits = DEFAULT_MAX_LINK_SCAN_CODE_UNITS,
    maxLinks = DEFAULT_MAX_LINKS_PER_LOGICAL_LINE,
  }: {
    readonly openUrl?: TerminalUrlOpener;
    readonly canActivate?: (event: MouseEvent) => boolean;
    readonly hoverTarget?: TerminalLinkHoverTarget;
    readonly requiresConfirmation?: (event: MouseEvent) => boolean;
    readonly confirmUrl?: (url: string) => boolean;
    readonly onActivationAttempt?: () => void;
    readonly maxCodeUnits?: number;
    readonly maxLinks?: number;
  } = {},
): InstrumentedTerminalLinkProvider {
  const counters = {
    providerCalls: 0,
    logicalLineScans: 0,
    cacheHits: 0,
    truncatedScans: 0,
    scannedRows: 0,
    scannedCodeUnits: 0,
    maxScannedCodeUnits: 0,
  };
  let cache:
    | {
        readonly key: string;
        readonly ranges: readonly { readonly text: string; readonly range: IBufferRange }[];
      }
    | undefined;

  const provider: InstrumentedTerminalLinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      counters.providerCalls += 1;
      const requestedRow = bufferLineNumber - 1;
      const logicalLine = readLogicalLineWindow(terminal.buffer.active, requestedRow, { maxCodeUnits });
      if (!logicalLine) {
        callback(undefined);
        return;
      }
      counters.scannedRows += logicalLine.scannedRows;
      const observedCodeUnits = logicalLine.truncated
        ? maxCodeUnits
        : Math.min(logicalLine.text.length, maxCodeUnits);
      counters.scannedCodeUnits += observedCodeUnits;
      counters.maxScannedCodeUnits = Math.max(counters.maxScannedCodeUnits, observedCodeUnits);
      if (logicalLine.truncated) {
        counters.truncatedScans += 1;
        callback(undefined);
        return;
      }

      const segmentShape = logicalLine.segments
        .map((segment) => `${segment.text.length}/${segment.line.length ?? segment.text.length}`)
        .join(",");
      const key = `${logicalLine.firstRow}:${logicalLine.lastRow}:${segmentShape}:${logicalLine.text}`;
      let ranges = cache?.key === key ? cache.ranges : undefined;
      if (ranges) {
        counters.cacheHits += 1;
      } else {
        counters.logicalLineScans += 1;
        const textLinks = findTerminalTextLinks(
          logicalLine.text,
          maxLinks,
          heuristicJunctionOffsets(logicalLine.segments),
        );
        const cellRanges = new Map(
          textLinks.length === 0
            ? []
            : logicalLine.segments.map((segment) => [
                segment,
                cellRangesForLine(segment.line, segment.text.length),
              ] as const),
        );
        ranges = textLinks.flatMap((link) => {
          const range = bufferRangeForTextLink(logicalLine.segments, link, cellRanges);
          return range ? [{ text: link.url, range }] : [];
        });
        cache = { key, ranges };
      }

      const links: ILink[] = ranges
        .filter((link) => link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber)
        .map((link) => ({
          range: link.range,
          text: link.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (event, text) =>
            activateTerminalUrl(
              event,
              text,
              openUrl,
              canActivate,
              requiresConfirmation,
              confirmUrl,
              onActivationAttempt,
            ),
          hover: hoverTarget ? (event, text) => hoverTarget.hover(event, text, link.range) : undefined,
          leave: hoverTarget ? () => hoverTarget.leave() : undefined,
        }));
      callback(links.length > 0 ? links : undefined);
    },
    stats: () => ({ ...counters }),
  };
  return provider;
}

export function createOsc8LinkHandler({
  openUrl = openExternalTerminalUrl,
  canActivate = (event) => event.button === 0,
  hoverTarget,
  requiresConfirmation = () => false,
  confirmUrl = () => false,
  onActivationAttempt,
}: {
  readonly openUrl?: TerminalUrlOpener;
  readonly canActivate?: (event: MouseEvent) => boolean;
  readonly hoverTarget?: TerminalLinkHoverTarget;
  readonly requiresConfirmation?: (event: MouseEvent) => boolean;
  readonly confirmUrl?: (url: string) => boolean;
  readonly onActivationAttempt?: () => void;
} = {}): ILinkHandler {
  return {
    activate: (event, text) => {
      if (!canActivate(event)) {
        return;
      }
      onActivationAttempt?.();
      // Explicit OSC 8 targets must open exactly as the terminal advertised them,
      // so validate without the prose trimming applied to implicit links.
      const safeUrl = validateTerminalUrl(text);
      if (!safeUrl || (requiresConfirmation(event) && !confirmUrl(safeUrl))) {
        return;
      }
      void Promise.resolve(openUrl(safeUrl));
    },
    hover: hoverTarget ? (event, text, range) => hoverTarget.hover(event, text, range) : undefined,
    leave: hoverTarget ? () => hoverTarget.leave() : undefined,
    allowNonHttpProtocols: false,
  };
}

async function defaultNativeOpenUrl(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

function defaultBrowserOpenUrl(
  url: string,
  target: string,
  features: string,
): Window | null | undefined {
  if (typeof window === "undefined") {
    return null;
  }
  return window.open(url, target, features);
}

const defaultOpeners: TerminalUrlOpeners = {
  isTauri,
  openNativeUrl: defaultNativeOpenUrl,
  openBrowserUrl: defaultBrowserOpenUrl,
};

export async function openExternalTerminalUrl(
  url: string,
  openers: TerminalUrlOpeners = defaultOpeners,
): Promise<boolean> {
  // This is the final open gate. Every caller already passes a URL that was
  // trimmed (implicit links) or validated verbatim (explicit OSC 8 targets and
  // resolved repo links), so re-validate without trimming to avoid mangling an
  // explicit target at the last step.
  const safeUrl = validateTerminalUrl(url);
  if (!safeUrl) {
    return false;
  }

  if (openers.isTauri()) {
    try {
      await openers.openNativeUrl(safeUrl);
      return true;
    } catch {
      return false;
    }
  }
  return Boolean(openers.openBrowserUrl(safeUrl, "_blank", "noopener,noreferrer"));
}
