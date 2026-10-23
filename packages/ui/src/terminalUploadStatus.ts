import type { TimeoutScheduler } from "./scheduler.ts";

export const UPLOAD_OK_STATUS_MS = 1600;
// Errors linger longer than success so they stay readable, but they STILL
// auto-dismiss — the whole point of routing every state through one controller.
export const UPLOAD_ERROR_STATUS_MS = 5000;

// The single terminal upload/clipboard status shape (busy while uploading, ok on
// success, error on failure; null when nothing is shown).
export type TerminalUploadStatus =
  | { readonly kind: "busy" | "ok" | "error"; readonly message: string }
  | null;

export interface UploadAttemptState<TimerHandle> {
  current: number;
  timer: TimerHandle | null;
}

export type UploadStatusTimerScheduler<TimerHandle> = TimeoutScheduler<TimerHandle>;

export function beginUploadAttempt<TimerHandle>(
  state: UploadAttemptState<TimerHandle>,
  clearTimeoutFn: (handle: TimerHandle) => void,
): number {
  state.current += 1;
  clearUploadStatusTimer(state, clearTimeoutFn);
  return state.current;
}

function clearUploadStatusTimer<TimerHandle>(
  state: UploadAttemptState<TimerHandle>,
  clearTimeoutFn: (handle: TimerHandle) => void,
): void {
  if (state.timer !== null) {
    clearTimeoutFn(state.timer);
    state.timer = null;
  }
}

function invalidateUploadAttempts<TimerHandle>(
  state: UploadAttemptState<TimerHandle>,
  clearTimeoutFn: (handle: TimerHandle) => void,
): void {
  state.current += 1;
  clearUploadStatusTimer(state, clearTimeoutFn);
}

export function isCurrentUploadAttempt<TimerHandle>(
  state: UploadAttemptState<TimerHandle>,
  attempt: number,
): boolean {
  return state.current === attempt;
}

export function scheduleUploadStatusClear<TimerHandle, Status>(
  state: UploadAttemptState<TimerHandle>,
  attempt: number,
  scheduler: UploadStatusTimerScheduler<TimerHandle>,
  setStatus: (status: Status | null) => void,
  delayMs = UPLOAD_OK_STATUS_MS,
): void {
  clearUploadStatusTimer(state, scheduler.clearTimeout);
  const timer = scheduler.setTimeout(() => {
    if (isCurrentUploadAttempt(state, attempt)) {
      setStatus(null);
    }
    if (state.timer === timer) {
      state.timer = null;
    }
  }, delayMs);
  state.timer = timer;
}

export interface TerminalStatusControllerOptions<TimerHandle> extends TimeoutScheduler<TimerHandle> {
  readonly setStatus: (status: TerminalUploadStatus) => void;
  // Auto-dismiss delays; default to the module constants.
  readonly okDelayMs?: number;
  readonly errorDelayMs?: number;
}

// The one interface every terminal upload/clipboard status transition goes
// through. It owns the attempt counter + the auto-dismiss timer so busy/ok/error
// all share the SAME lifecycle: each transition is attempt-versioned (a stale or
// superseded result can never paint over a newer state) and ok AND error both
// auto-clear. Previously only the success path cleared itself, so error banners
// stuck forever and a late/rejected upload could stomp a fresh status.
export interface TerminalStatusController {
  // Start a new attempt (supersedes any in-flight one), show a busy message, and
  // return the attempt id to pass back to succeed/fail.
  begin: (message: string) => number;
  // Mark `attempt` succeeded (no-op if superseded); auto-clears after okDelayMs.
  succeed: (attempt: number, message: string) => void;
  // Mark `attempt` failed (no-op if superseded); auto-clears after errorDelayMs.
  fail: (attempt: number, message: string) => void;
  // Show an error not tied to a tracked attempt (e.g. a clipboard copy/paste
  // failure). Supersedes any in-flight attempt so its later completion is
  // ignored, and auto-clears after errorDelayMs.
  failStandalone: (message: string) => void;
  // Whether `attempt` is still the latest — callers guard async continuations.
  isCurrent: (attempt: number) => boolean;
  // Cancel any pending auto-clear and invalidate attempts (on unmount/teardown).
  dispose: () => void;
}

export function createTerminalStatusController<TimerHandle>(
  options: TerminalStatusControllerOptions<TimerHandle>,
): TerminalStatusController {
  const state: UploadAttemptState<TimerHandle> = { current: 0, timer: null };
  const scheduler: UploadStatusTimerScheduler<TimerHandle> = {
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
  };
  const okDelayMs = options.okDelayMs ?? UPLOAD_OK_STATUS_MS;
  const errorDelayMs = options.errorDelayMs ?? UPLOAD_ERROR_STATUS_MS;

  const complete = (attempt: number, kind: "ok" | "error", message: string, delayMs: number): void => {
    if (!isCurrentUploadAttempt(state, attempt)) {
      return;
    }
    options.setStatus({ kind, message });
    scheduleUploadStatusClear(state, attempt, scheduler, options.setStatus, delayMs);
  };

  return {
    begin(message) {
      const attempt = beginUploadAttempt(state, options.clearTimeout);
      options.setStatus({ kind: "busy", message });
      return attempt;
    },
    succeed(attempt, message) {
      complete(attempt, "ok", message, okDelayMs);
    },
    fail(attempt, message) {
      complete(attempt, "error", message, errorDelayMs);
    },
    failStandalone(message) {
      const attempt = beginUploadAttempt(state, options.clearTimeout);
      options.setStatus({ kind: "error", message });
      scheduleUploadStatusClear(state, attempt, scheduler, options.setStatus, errorDelayMs);
    },
    isCurrent(attempt) {
      return isCurrentUploadAttempt(state, attempt);
    },
    dispose() {
      invalidateUploadAttempts(state, options.clearTimeout);
    },
  };
}
