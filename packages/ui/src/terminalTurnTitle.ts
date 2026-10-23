import type { SpecialKey } from "./frames.ts";
import { promptTitleSuffix } from "./autoTitle.ts";
import { defaultScheduler, type TimeoutScheduler, type TimerHandle as DefaultTimerHandle } from "./scheduler.ts";

const MAX_CAPTURED_PROMPT_CHARS = 2000;
const CAPTURE_TRIM_BATCH_CHARS = 256;
const MAX_CAPTURED_ESCAPE_CHARS = 64;

export interface TerminalPromptCapture {
  acceptKey(key: SpecialKey): string[];
  acceptText(text: string): string[];
  invalidate(): void;
  reset(): void;
}

export type ProviderPromptTitleCapability = "pending" | "supported" | "fallback";

export interface ProviderPromptTitleSource {
  acceptLocal(prompts: readonly string[]): void;
  acceptProvider(event: { readonly eventId: string; readonly text: string; readonly submittedAt?: string }): void;
  resetConnection(): void;
  setCapability(capability: ProviderPromptTitleCapability): void;
}

export interface ProviderPromptTitleSourceOptions<Timer> extends Partial<TimeoutScheduler<Timer>> {
  readonly onPrompt: (prompt: string, eventId?: string, submittedAt?: string) => void;
  readonly maxPendingFallbacks?: number;
  readonly providerEventFallbackMs?: number;
}

interface PendingProviderPromptFallback<Timer> {
  readonly prompt: string;
  timer: Timer | null;
  emitted: boolean;
}

export const PROVIDER_PROMPT_EVENT_FALLBACK_MS = 2_000;

export function createProviderPromptTitleSource<Timer = DefaultTimerHandle>(
  options: ProviderPromptTitleSourceOptions<Timer>,
): ProviderPromptTitleSource {
  const { onPrompt, maxPendingFallbacks = 8 } = options;
  const pendingLimit = Math.max(1, Math.floor(maxPendingFallbacks));
  const providerEventFallbackMs = Math.max(
    0,
    Math.floor(options.providerEventFallbackMs ?? PROVIDER_PROMPT_EVENT_FALLBACK_MS),
  );
  const setTimer = options.setTimeout
    ?? (defaultScheduler.setTimeout as TimeoutScheduler<Timer>["setTimeout"]);
  const clearTimer = options.clearTimeout
    ?? (defaultScheduler.clearTimeout as TimeoutScheduler<Timer>["clearTimeout"]);
  let capability: ProviderPromptTitleCapability = "pending";
  let pendingFallbacks: Array<PendingProviderPromptFallback<Timer>> = [];
  const consumedProviderEventIds = new Set<string>();
  const consumedProviderEventIdOrder: string[] = [];

  const cancelFallback = (entry: PendingProviderPromptFallback<Timer>) => {
    if (entry.timer !== null) {
      clearTimer(entry.timer);
      entry.timer = null;
    }
  };
  const clearPending = () => {
    for (const entry of pendingFallbacks) {
      cancelFallback(entry);
    }
    pendingFallbacks = [];
  };
  const removePending = (entry: PendingProviderPromptFallback<Timer>): boolean => {
    const index = pendingFallbacks.indexOf(entry);
    if (index < 0) {
      return false;
    }
    pendingFallbacks.splice(index, 1);
    return true;
  };
  const clearConsumedProviderEventIds = () => {
    consumedProviderEventIds.clear();
    consumedProviderEventIdOrder.length = 0;
  };
  const rememberConsumedProviderEventId = (eventId: string) => {
    if (consumedProviderEventIds.has(eventId)) {
      return;
    }
    consumedProviderEventIds.add(eventId);
    consumedProviderEventIdOrder.push(eventId);
    while (consumedProviderEventIdOrder.length > pendingLimit) {
      const expiredEventId = consumedProviderEventIdOrder.shift();
      if (expiredEventId) {
        consumedProviderEventIds.delete(expiredEventId);
      }
    }
  };
  const emitFallback = (entry: PendingProviderPromptFallback<Timer>) => {
    if (entry.emitted) {
      return;
    }
    entry.emitted = true;
    onPrompt(entry.prompt);
  };
  const armCorrelationExpiry = (entry: PendingProviderPromptFallback<Timer>) => {
    if (entry.timer !== null || !entry.emitted || !pendingFallbacks.includes(entry)) {
      return;
    }
    let firedBeforeAssignment = false;
    let assigned = false;
    const nextTimer = setTimer(() => {
      if (!assigned) {
        firedBeforeAssignment = true;
      }
      entry.timer = null;
      removePending(entry);
    }, providerEventFallbackMs);
    assigned = true;
    entry.timer = firedBeforeAssignment || !pendingFallbacks.includes(entry) ? null : nextTimer;
  };
  const armFallback = (entry: PendingProviderPromptFallback<Timer>) => {
    if (entry.timer !== null || entry.emitted) {
      return;
    }
    let firedBeforeAssignment = false;
    let assigned = false;
    const nextTimer = setTimer(() => {
      if (!assigned) {
        firedBeforeAssignment = true;
      }
      entry.timer = null;
      if (pendingFallbacks.includes(entry)) {
        emitFallback(entry);
        armCorrelationExpiry(entry);
      }
    }, providerEventFallbackMs);
    assigned = true;
    entry.timer = firedBeforeAssignment ? null : nextTimer;
  };
  const queueFallback = (prompt: string, arm: boolean) => {
    const entry: PendingProviderPromptFallback<Timer> = { prompt, timer: null, emitted: false };
    pendingFallbacks.push(entry);
    while (pendingFallbacks.length > pendingLimit) {
      const dropped = pendingFallbacks.shift();
      if (dropped) {
        cancelFallback(dropped);
      }
    }
    if (arm && pendingFallbacks.includes(entry)) {
      armFallback(entry);
    }
    return entry;
  };
  const flushPending = () => {
    for (const entry of [...pendingFallbacks]) {
      if (entry.emitted) {
        continue;
      }
      cancelFallback(entry);
      emitFallback(entry);
      armCorrelationExpiry(entry);
    }
  };

  return {
    acceptLocal(prompts) {
      for (const value of prompts) {
        const prompt = trimCapturedPrompt(value);
        if (!prompt) {
          continue;
        }
        const entry = queueFallback(prompt, capability === "supported");
        if (capability === "fallback") {
          emitFallback(entry);
          armCorrelationExpiry(entry);
        }
      }
    },
    acceptProvider(event) {
      const eventId = event.eventId.trim();
      const prompt = trimCapturedPrompt(event.text);
      if (capability === "supported" && eventId && prompt) {
        if (consumedProviderEventIds.has(eventId)) {
          return;
        }
        const matchingFallback = pendingFallbacks.find((entry) => entry.prompt === prompt);
        if (matchingFallback) {
          cancelFallback(matchingFallback);
          removePending(matchingFallback);
          if (matchingFallback.emitted) {
            rememberConsumedProviderEventId(eventId);
            return;
          }
        }
        if (event.submittedAt) {
          onPrompt(prompt, eventId, event.submittedAt);
        } else {
          onPrompt(prompt, eventId);
        }
      }
    },
    resetConnection() {
      capability = "pending";
      clearPending();
      clearConsumedProviderEventIds();
    },
    setCapability(nextCapability) {
      const previousCapability = capability;
      capability = nextCapability;
      if (nextCapability === "supported") {
        for (const entry of pendingFallbacks) {
          armFallback(entry);
        }
        return;
      }
      if (nextCapability === "pending") {
        if (previousCapability !== "pending") {
          clearPending();
          clearConsumedProviderEventIds();
        }
        return;
      }
      flushPending();
    },
  };
}

function trimCapturedPrompt(value: string): string | null {
  return promptTitleSuffix(value.trim());
}

function isTerminalCursorPositionReport(value: string): boolean {
  // xterm answers a TUI's device-status query on the same onData stream as
  // keyboard input. This report describes the terminal cursor; it is not a
  // user edit and must not discard an otherwise clean legacy/DSH prompt.
  return /^\x1b\[\d{1,6};\d{1,6}R$/.test(value);
}

export function createTerminalPromptCapture(): TerminalPromptCapture {
  let buffer: string[] = [];
  let escapeMode: "none" | "esc" | "csi" | "osc" = "none";
  let escapeSequence = "";
  let invalidated = false;

  const resetState = () => {
    buffer = [];
    escapeMode = "none";
    escapeSequence = "";
    invalidated = false;
  };

  const invalidate = () => {
    buffer = [];
    invalidated = true;
  };

  const append = (char: string) => {
    buffer.push(char);
    if (buffer.length > MAX_CAPTURED_PROMPT_CHARS + CAPTURE_TRIM_BATCH_CHARS) {
      buffer = buffer.slice(buffer.length - MAX_CAPTURED_PROMPT_CHARS);
    }
  };

  const appendEscape = (char: string) => {
    if (escapeSequence.length >= MAX_CAPTURED_ESCAPE_CHARS) {
      escapeSequence = "";
      invalidate();
      return;
    }
    escapeSequence += char;
  };

  const finishEscape = (preservePrompt: boolean) => {
    escapeMode = "none";
    escapeSequence = "";
    if (!preservePrompt) {
      invalidate();
    }
  };

  const consumeEscape = (char: string): boolean => {
    if (escapeMode === "none") {
      return false;
    }
    if (escapeMode === "esc") {
      appendEscape(char);
      if (char === "[") {
        escapeMode = "csi";
      } else if (char === "]") {
        escapeMode = "osc";
        invalidate();
      } else {
        finishEscape(false);
      }
      return true;
    }
    if (escapeMode === "csi") {
      appendEscape(char);
      if (/[@-~]/.test(char)) {
        finishEscape(isTerminalCursorPositionReport(escapeSequence));
      }
      return true;
    }
    if (char === "\x07") {
      finishEscape(false);
    } else if (char === "\x1b") {
      escapeMode = "esc";
      escapeSequence = "\x1b";
    }
    return true;
  };

  const submit = (): string[] => {
    const prompt = invalidated || escapeMode !== "none" ? null : trimCapturedPrompt(buffer.join(""));
    resetState();
    return prompt ? [prompt] : [];
  };

  return {
    acceptText(text: string): string[] {
      const prompts: string[] = [];
      for (const char of text) {
        if (consumeEscape(char)) {
          continue;
        }
        if (char === "\x1b") {
          escapeMode = "esc";
          escapeSequence = "\x1b";
          continue;
        }
        if (char === "\r" || char === "\n") {
          prompts.push(...submit());
          continue;
        }
        if (char === "\x7f" || char === "\b") {
          buffer.pop();
          continue;
        }
        if (char === "\t") {
          append(" ");
          continue;
        }
        if (char >= " ") {
          append(char);
        } else {
          invalidate();
        }
      }
      return prompts;
    },
    acceptKey(key: SpecialKey): string[] {
      if (key === "enter") {
        return submit();
      }
      if (key === "backspace") {
        buffer.pop();
        return [];
      }
      if (key === "up" || key === "down" || key === "left" || key === "right" || key === "tab") {
        invalidate();
        return [];
      }
      if (key === "c-c" || key === "escape") {
        resetState();
      }
      return [];
    },
    invalidate,
    reset() {
      resetState();
    },
  };
}
