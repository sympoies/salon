// Native HTTP transports can remain pending after abort. Race the complete
// response read against a deadline so a stalled request never freezes a poll.
export class RequestCapacityError extends DOMException {
  constructor(message: string) {
    super(message, "TimeoutError");
  }
}

export async function withRequestDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(
      controller.signal.reason ?? new DOMException("Request aborted", "AbortError"),
    ), { once: true });
  });
  const timer = setTimeout(() => controller.abort(
    new DOMException("Request timed out", "TimeoutError"),
  ), timeoutMs);
  try {
    return await Promise.race([request(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
