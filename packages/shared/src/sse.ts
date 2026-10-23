interface PendingSseEvent {
  event?: string;
  data: string[];
}

const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

interface Utf8PartLength {
  readonly bytes: number;
  readonly trailingHighSurrogate: boolean;
}

function utf8ByteLengthUpTo(
  value: string,
  limit: number,
  leadingHighSurrogate: boolean,
): Utf8PartLength | null {
  let bytes = 0;
  let index = 0;
  if (leadingHighSurrogate) {
    if (value.length === 0) return { bytes, trailingHighSurrogate: true };
    const firstCodeUnit = value.charCodeAt(0);
    if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) {
      bytes = 4;
      index = 1;
    } else {
      bytes = 3;
    }
    if (bytes > limit) return null;
  }
  for (; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 && codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 === value.length) {
      return { bytes, trailingHighSurrogate: true };
    } else {
      // TextEncoder replaces unpaired surrogates with U+FFFD (three UTF-8 bytes).
      bytes += 3;
    }
    if (bytes > limit) return null;
  }
  return { bytes, trailingHighSurrogate: false };
}

type SseEventNormalizer<Event> = (value: unknown) => Event | null;

export class NormalizedSseDecoder<Event extends { readonly type: string }> {
  #chunks: string[] = [];
  #chunkIndex = 0;
  #chunkOffset = 0;
  #lineParts: string[] = [];
  #lineRawLength = 0;
  #lineCanBeBlank = true;
  #pending: PendingSseEvent = { data: [] };
  #frameBytes = 0;
  #trailingHighSurrogate = false;
  #discardingFrame = false;
  readonly #normalize: SseEventNormalizer<Event>;

  constructor(normalize: SseEventNormalizer<Event>) {
    this.#normalize = normalize;
  }

  push(chunk: string): Event[] {
    this.#chunks.push(chunk);
    const out: Event[] = [];
    while (this.#chunkIndex < this.#chunks.length) {
      const current = this.#chunks[this.#chunkIndex]!;
      const newline = current.indexOf("\n", this.#chunkOffset);
      if (newline < 0) {
        this.#appendLinePart(current.slice(this.#chunkOffset));
        this.#chunkIndex += 1;
        this.#chunkOffset = 0;
        continue;
      }
      this.#appendLinePart(current.slice(this.#chunkOffset, newline));
      this.#consumeNewline(out);
      this.#chunkOffset = newline + 1;
      if (this.#chunkOffset >= current.length) {
        this.#chunkIndex += 1;
        this.#chunkOffset = 0;
      }
    }
    this.#chunks = [];
    this.#chunkIndex = 0;
    this.#chunkOffset = 0;
    return out;
  }

  finish(): Event[] {
    const out: Event[] = [];
    if (this.#discardingFrame) {
      this.#reset();
      return out;
    }
    if (this.#trailingHighSurrogate) {
      if (this.#frameBytes > MAX_SSE_BUFFER_BYTES - 3) {
        this.#reset();
        return out;
      }
      this.#frameBytes += 3;
      this.#trailingHighSurrogate = false;
    }
    if (this.#lineRawLength > 0) this.#consumeLine(this.#takeLine(), out);
    this.#consumeLine("", out);
    this.#frameBytes = 0;
    return out;
  }

  #appendLinePart(part: string): void {
    if (part.length === 0) return;
    if (this.#lineRawLength !== 0 || part !== "\r") this.#lineCanBeBlank = false;
    this.#lineRawLength += part.length;
    if (this.#discardingFrame) return;
    const remainingBytes = MAX_SSE_BUFFER_BYTES - this.#frameBytes;
    const partLength = utf8ByteLengthUpTo(part, remainingBytes, this.#trailingHighSurrogate);
    if (!partLength) {
      this.#startDiscardingFrame();
      return;
    }
    this.#lineParts.push(part);
    this.#frameBytes += partLength.bytes;
    this.#trailingHighSurrogate = partLength.trailingHighSurrogate;
  }

  #consumeNewline(out: Event[]): void {
    const lineIsBlank = this.#lineCanBeBlank;
    if (!this.#discardingFrame) {
      const boundaryBytes = 1 + (this.#trailingHighSurrogate ? 3 : 0);
      if (this.#frameBytes > MAX_SSE_BUFFER_BYTES - boundaryBytes) {
        this.#startDiscardingFrame();
      } else {
        this.#frameBytes += boundaryBytes;
        this.#trailingHighSurrogate = false;
      }
    }
    if (this.#discardingFrame) {
      this.#resetLine();
      if (lineIsBlank) this.#resetFrame();
      return;
    }
    this.#consumeLine(this.#takeLine(), out);
    if (lineIsBlank) this.#frameBytes = 0;
  }

  #takeLine(): string {
    const rawLine = this.#lineParts.length === 1 ? this.#lineParts[0]! : this.#lineParts.join("");
    this.#resetLine();
    return rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  }

  #resetLine(): void {
    this.#lineParts = [];
    this.#lineRawLength = 0;
    this.#lineCanBeBlank = true;
  }

  #startDiscardingFrame(): void {
    this.#discardingFrame = true;
    this.#lineParts = [];
    this.#pending = { data: [] };
    this.#trailingHighSurrogate = false;
  }

  #resetFrame(): void {
    this.#pending = { data: [] };
    this.#frameBytes = 0;
    this.#trailingHighSurrogate = false;
    this.#discardingFrame = false;
  }

  #reset(): void {
    this.#chunks = [];
    this.#chunkIndex = 0;
    this.#chunkOffset = 0;
    this.#resetLine();
    this.#resetFrame();
  }

  #consumeLine(line: string, out: Event[]): void {
    if (line === "") {
      if (this.#pending.data.length > 0) {
        try {
          const event = this.#normalize(JSON.parse(this.#pending.data.join("\n")));
          if (event && (!this.#pending.event || this.#pending.event === event.type)) out.push(event);
        } catch {
          // Malformed frames are ignored; the next valid sequence gap forces a poll.
        }
      }
      this.#pending = { data: [] };
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.#pending.event = value;
    if (field === "data") {
      this.#pending.data.push(value);
    }
  }
}
