// Reserve two seconds of the eight-second device acceptance window for React
// to commit and paint the connection recovery screen.
export const ANDROID_STARTUP_RECOVERY_DEADLINE_MS = 6_000;

export interface StartupAuthStatus {
  readonly startupFailure?: "timeout" | "transport";
}

export interface StartupAuthCheckOptions<T extends StartupAuthStatus> {
  readonly initialStartup: boolean;
  readonly deadlineMs?: number;
  readonly elapsedMs: number;
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly cancel: (handle: unknown) => void;
  readonly read: () => Promise<T>;
  readonly onTimeout: () => void;
}

/**
 * Owns the App-level initial-auth race. Its callback can render recovery while
 * native HTTP is still pending; a late initial response is then discarded.
 * Retry checks omit this Activity-relative timer and consume their own API
 * request deadline instead.
 */
export async function runStartupAuthCheck<T extends StartupAuthStatus>(
  options: StartupAuthCheckOptions<T>,
): Promise<T | null> {
  let timedOut = false;
  const fireTimeout = () => {
    if (timedOut) return;
    timedOut = true;
    options.onTimeout();
  };
  const shouldSchedule = options.initialStartup && options.deadlineMs !== undefined;
  const handle = shouldSchedule
    ? options.schedule(fireTimeout, Math.max(0, options.deadlineMs! - options.elapsedMs))
    : undefined;
  let status: T;
  try {
    status = await options.read();
  } catch (error) {
    if (shouldSchedule) options.cancel(handle);
    throw error;
  }
  if (shouldSchedule) options.cancel(handle);
  if (timedOut) return null;
  if (shouldSchedule && status.startupFailure === "timeout") {
    fireTimeout();
    return null;
  }
  return status;
}
