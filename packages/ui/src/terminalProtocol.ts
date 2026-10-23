import type { TerminalOutputData } from "./terminalOutputBatcher.ts";

export interface TerminalProtocolGuard {
  requiresImmediateWrite(data: TerminalOutputData): boolean;
}

const PROTOCOL_TAIL_UNITS = 1_024;
const PRIVATE_INPUT_MODES = new Set([
  "1", // application cursor keys
  "9", // X10 mouse reporting
  "66", // application keypad
  "67", // backarrow key mode
  "1000", "1001", "1002", "1003", "1004", "1005", "1006", "1007", "1015", "1016",
  "1034", "1035", "1036", "1039", // meta/Alt input encodings
  "2004", "2005", "2006", // paste input modes
]);
const STANDARD_INPUT_MODES = new Set(["2", "20"]); // keyboard action and linefeed/newline modes

function hasProtocolIntroducer(data: TerminalOutputData): boolean {
  if (typeof data === "string") {
    for (let index = 0; index < data.length; index += 1) {
      const code = data.charCodeAt(index);
      if (code === 0x1b || code === 0x90 || code === 0x9b || code === 0x9d) {
        return true;
      }
    }
    return false;
  }
  for (const byte of data) {
    if (byte === 0x1b || byte === 0x90 || byte === 0x9b || byte === 0x9d) {
      return true;
    }
  }
  return false;
}

function binaryProtocolText(data: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < data.byteLength; offset += 8_192) {
    text += String.fromCharCode(...data.subarray(offset, offset + 8_192));
  }
  return text;
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function isSensitiveMode(parameters: string): boolean {
  const privateMode = parameters.startsWith("?");
  const values = (privateMode ? parameters.slice(1) : parameters).split(";");
  const supported = privateMode ? PRIVATE_INPUT_MODES : STANDARD_INPUT_MODES;
  return values.some((value) => supported.has(value));
}

function isSensitiveCsi(body: string, final: string): boolean {
  let intermediateStart = body.length;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (code >= 0x20 && code <= 0x2f) {
      intermediateStart = index;
      break;
    }
  }
  const parameters = body.slice(0, intermediateStart);
  const intermediates = body.slice(intermediateStart);
  if (final === "n" || final === "c" || final === "t") {
    return true;
  }
  if ((final === "h" || final === "l") && isSensitiveMode(parameters)) {
    return true;
  }
  if (final === "p" && intermediates.includes("$")) {
    return true;
  }
  return (final === "m" || final === "u") && (parameters.startsWith(">") || parameters.startsWith("<"));
}

function isSensitiveOsc(body: string): boolean {
  const parts = body.split(";");
  const command = parts[0] ?? "";
  if (command === "4") {
    for (let index = 2; index < parts.length; index += 2) {
      if (parts[index] === "?") {
        return true;
      }
    }
    return false;
  }
  if (command === "10" || command === "11" || command === "12" || command === "52") {
    return parts.slice(1).includes("?");
  }
  return false;
}

interface StringControlEnd {
  readonly bodyEnd: number;
  readonly end: number;
}

function findStringControlEnd(text: string, start: number, allowBell: boolean): StringControlEnd | null {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (allowBell && code === 0x07) {
      return { bodyEnd: index, end: index + 1 };
    }
    if (code === 0x9c) {
      return { bodyEnd: index, end: index + 1 };
    }
    if (code === 0x1b && text[index + 1] === "\\") {
      return { bodyEnd: index, end: index + 2 };
    }
  }
  return null;
}

interface ProtocolScan {
  readonly immediate: boolean;
  readonly tail: string;
}

function scanProtocol(text: string, previousUnits: number): ProtocolScan {
  let immediate = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    let kind: "csi" | "osc" | "dcs" | "escape" | null = null;
    let bodyStart = index + 1;

    if (code === 0x1b) {
      const next = text[index + 1];
      if (next === undefined) {
        return { immediate, tail: text.slice(-PROTOCOL_TAIL_UNITS) };
      }
      if (next === "[") kind = "csi";
      else if (next === "]") kind = "osc";
      else if (next === "P") kind = "dcs";
      else kind = "escape";
      bodyStart = index + 2;
    } else if (code === 0x9b) {
      kind = "csi";
    } else if (code === 0x9d) {
      kind = "osc";
    } else if (code === 0x90) {
      kind = "dcs";
    }

    if (kind === null) {
      continue;
    }
    if (kind === "escape") {
      const end = index + 2;
      if (end > previousUnits && (text[index + 1] === "Z" || text[index + 1] === "=" || text[index + 1] === ">" || text[index + 1] === "c")) {
        immediate = true;
      }
      index = end - 1;
      continue;
    }
    if (kind === "csi") {
      let finalIndex = bodyStart;
      while (finalIndex < text.length && !isCsiFinal(text.charCodeAt(finalIndex))) {
        finalIndex += 1;
      }
      if (finalIndex === text.length) {
        return { immediate, tail: text.slice(index, index + PROTOCOL_TAIL_UNITS) };
      }
      const end = finalIndex + 1;
      if (end > previousUnits && isSensitiveCsi(text.slice(bodyStart, finalIndex), text[finalIndex]!)) {
        immediate = true;
      }
      index = finalIndex;
      continue;
    }

    const controlEnd = findStringControlEnd(text, bodyStart, kind === "osc");
    if (controlEnd === null) {
      return { immediate, tail: text.slice(index, index + PROTOCOL_TAIL_UNITS) };
    }
    if (controlEnd.end > previousUnits) {
      const body = text.slice(bodyStart, controlEnd.bodyEnd);
      if ((kind === "osc" && isSensitiveOsc(body)) || (kind === "dcs" && body.startsWith("$q"))) {
        immediate = true;
      }
    }
    index = controlEnd.end - 1;
  }
  return { immediate, tail: "" };
}

// xterm parses terminal protocol while term.write() runs. Ordinary printable
// output may wait for a render batch, but response queries and input-mode
// changes must reach xterm as soon as the completing websocket frame arrives.
export function createTerminalProtocolGuard(): TerminalProtocolGuard {
  let tail = "";
  return {
    requiresImmediateWrite(data) {
      if (tail === "" && !hasProtocolIntroducer(data)) {
        return false;
      }
      const current = typeof data === "string" ? data : binaryProtocolText(data);
      const result = scanProtocol(tail + current, tail.length);
      tail = result.tail;
      return result.immediate;
    },
  };
}
