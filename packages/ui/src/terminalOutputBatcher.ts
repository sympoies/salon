import type { TimeoutScheduler } from "./scheduler.ts";

export type TerminalOutputData = string | Uint8Array;
export type TerminalOutputWriteReason =
  | "realtime"
  | "protocol"
  | "timer"
  | "focus"
  | "capacity"
  | "type-change"
  | "protocol-boundary";

export interface TerminalOutputDelivery {
  readonly reason: TerminalOutputWriteReason;
  readonly frameCount: number;
  readonly unitCount: number;
}

export interface TerminalOutputWrite extends TerminalOutputDelivery {
  readonly data: TerminalOutputData;
}

export interface TerminalOutputBatcher<Timer> {
  push(data: TerminalOutputData): void;
  pushImmediate(data: TerminalOutputData): void;
  flush(reason?: Exclude<TerminalOutputWriteReason, "realtime" | "protocol">): void;
  dispose(): void;
}

interface TerminalOutputBatcherOptions<Timer> extends TimeoutScheduler<Timer> {
  readonly shouldBatch: () => boolean;
  readonly write: (data: TerminalOutputData, delivery: TerminalOutputDelivery) => void;
  readonly delayMs?: number | (() => number);
  readonly maxPendingUnits?: number;
}

const DEFAULT_BATCH_DELAY_MS = 250;
const DEFAULT_MAX_PENDING_UNITS = 256 * 1024;

function dataUnits(data: TerminalOutputData): number {
  return typeof data === "string" ? data.length : data.byteLength;
}

function joinBinary(parts: readonly Uint8Array[], unitCount: number): Uint8Array {
  if (parts.length === 1) {
    return parts[0]!;
  }
  const joined = new Uint8Array(unitCount);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

export function createTerminalOutputBatcher<Timer>(
  options: TerminalOutputBatcherOptions<Timer>,
): TerminalOutputBatcher<Timer> {
  const delayMs = () => typeof options.delayMs === "function"
    ? options.delayMs()
    : options.delayMs ?? DEFAULT_BATCH_DELAY_MS;
  const maxPendingUnits = options.maxPendingUnits ?? DEFAULT_MAX_PENDING_UNITS;
  let pendingKind: "string" | "binary" | null = null;
  let stringParts: string[] = [];
  let binaryParts: Uint8Array[] = [];
  let pendingFrames = 0;
  let pendingUnits = 0;
  let timer: Timer | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      options.clearTimeout(timer);
      timer = null;
    }
  };

  const resetPending = () => {
    pendingKind = null;
    stringParts = [];
    binaryParts = [];
    pendingFrames = 0;
    pendingUnits = 0;
  };

  const flush = (reason: Exclude<TerminalOutputWriteReason, "realtime" | "protocol"> = "focus") => {
    clearTimer();
    if (disposed || pendingKind === null) {
      return;
    }
    const data = pendingKind === "string"
      ? stringParts.join("")
      : joinBinary(binaryParts, pendingUnits);
    const delivery = { reason, frameCount: pendingFrames, unitCount: pendingUnits } as const;
    resetPending();
    options.write(data, delivery);
  };

  const schedule = () => {
    if (timer !== null) {
      return;
    }
    timer = options.setTimeout(() => {
      timer = null;
      flush("timer");
    }, delayMs());
  };

  const push = (data: TerminalOutputData) => {
    if (disposed) {
      return;
    }
    const unitCount = dataUnits(data);
    if (!options.shouldBatch()) {
      flush("focus");
      options.write(data, { reason: "realtime", frameCount: 1, unitCount });
      return;
    }

    const kind = typeof data === "string" ? "string" : "binary";
    if (pendingKind !== null && pendingKind !== kind) {
      flush("type-change");
    }
    if (pendingUnits > 0 && pendingUnits + unitCount > maxPendingUnits) {
      flush("capacity");
    }
    if (unitCount >= maxPendingUnits) {
      options.write(data, { reason: "capacity", frameCount: 1, unitCount });
      return;
    }

    pendingKind = kind;
    pendingFrames += 1;
    pendingUnits += unitCount;
    if (kind === "string") {
      stringParts.push(data as string);
    } else {
      binaryParts.push(data as Uint8Array);
    }
    schedule();
  };

  return {
    push,
    pushImmediate(data) {
      if (disposed) {
        return;
      }
      const unitCount = dataUnits(data);
      flush("protocol-boundary");
      options.write(data, { reason: "protocol", frameCount: 1, unitCount });
    },
    flush,
    dispose() {
      if (disposed) {
        return;
      }
      clearTimer();
      resetPending();
      disposed = true;
    },
  };
}
