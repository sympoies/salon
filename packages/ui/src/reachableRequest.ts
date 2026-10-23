// Read-only recovery for Usage and account snapshots. Keep
// writes outside this helper: an uncertain write must never be replayed here.
interface ReachableResponse {
  readonly status: number;
  readonly body: unknown;
  readonly malformed?: boolean;
}

interface ReadRecoveryOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly retryDelaysMs?: readonly number[];
}

class ReadFailure extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

// Race the full request (including its body) so even a native transport that
// fails to settle after abort cannot leave Refresh or the poller stuck.
async function readAttempt<T>(request: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Read timed out", "TimeoutError")), timeoutMs);
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    return await Promise.race([request(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function readReachableWithRecovery<T extends ReachableResponse>(
  request: (signal: AbortSignal) => Promise<T>,
  { signal = new AbortController().signal, timeoutMs = 10_000, retryDelaysMs = [500, 1500] }: ReadRecoveryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await readAttempt(request, signal, timeoutMs);
      signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) {
        throw new ReadFailure("Authentication is required. Check the console connection settings or sign in again.", false);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ReadFailure(`Console server returned HTTP ${response.status}.`,
          response.status === 408 || response.status === 429 || response.status >= 500);
      }
      if (response.malformed) throw new ReadFailure("Console server returned an invalid response.", false);
      const data = (response.body as { data?: { reachable?: boolean; error?: string } } | null)?.data;
      if (data?.reachable === false && data.error) {
        throw new ReadFailure(`The console server could not read the host service: ${data.error}`, true);
      }
      return response;
    } catch (error) {
      signal.throwIfAborted();
      const failure = error instanceof ReadFailure ? error : new ReadFailure(
        error instanceof DOMException && error.name === "TimeoutError"
          ? "The console server request timed out."
          : "Cannot reach the console server. Check your connection; automatic refresh will continue.",
        true,
      );
      const delay = retryDelaysMs[attempt];
      if (!failure.retryable || delay === undefined) throw failure;
      await waitForRetry(delay, signal);
    }
  }
}
