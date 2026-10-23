import { appFetch } from "./runtime.ts";
export type SseConnectionState = "disabled" | "connecting" | "connected" | "reconnecting";
export interface SseStreamOptions<Event> {
  readonly path: string;
  readonly signal: AbortSignal;
  readonly createDecoder: () => { push(chunk: string): Event[]; finish(): Event[] };
  readonly onEvent: (event: Event) => void;
  readonly onState: (state: SseConnectionState) => void;
  readonly fetchImpl?: typeof appFetch;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}
function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // A rejected response must not retain its connection while this loop retries.
  }
}

async function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      resolve();
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runSseStream<Event>(options: SseStreamOptions<Event>): Promise<void> {
  const fetchImpl = options.fetchImpl ?? appFetch;
  const sleep = options.sleep ?? defaultSleep;
  let delayMs = 500;
  let first = true;
  while (!options.signal.aborted) {
    options.onState(first ? "connecting" : "reconnecting");
    first = false;
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort(options.signal.reason);
    options.signal.addEventListener("abort", abortAttempt, { once: true });
    if (options.signal.aborted) abortAttempt();
    let response: Response | undefined;
    let responseDisposed = false;
    try {
      const connectTimer = globalThis.setTimeout(() => attemptController.abort(), 10_000);
      try {
        response = await fetchImpl(options.path, {
          headers: { accept: "text/event-stream" },
          signal: attemptController.signal,
        });
      } finally { globalThis.clearTimeout(connectTimer); }
      if (!response.ok) {
        await cancelResponseBody(response);
        responseDisposed = true;
        throw new Error(`event stream status ${response.status}`);
      }
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        await cancelResponseBody(response);
        responseDisposed = true;
        throw new Error("event stream returned a non-SSE response");
      }
      if (!response.body) throw new Error("event stream has no response body");
      const reader = response.body.getReader();
      const text = new TextDecoder();
      const sse = options.createDecoder();
      try {
        for (;;) {
          const idleTimer = globalThis.setTimeout(() => attemptController.abort(), 30_000);
          let result: ReadableStreamReadResult<Uint8Array>;
          try { result = await reader.read(); } finally { globalThis.clearTimeout(idleTimer); }
          const { done, value } = result;
          if (done) break;
          for (const event of sse.push(text.decode(value, { stream: true }))) {
            delayMs = 500;
            options.onState("connected");
            options.onEvent(event);
          }
        }
        for (const event of sse.push(text.decode())) {
          delayMs = 500;
          options.onState("connected");
          options.onEvent(event);
        }
        for (const event of sse.finish()) {
          delayMs = 500;
          options.onState("connected");
          options.onEvent(event);
        }
        responseDisposed = true;
      } finally {
        if (!responseDisposed) {
          try {
            await reader.cancel();
          } catch {
            // The transport may have already closed the discarded response.
          }
          responseDisposed = true;
        }
        reader.releaseLock();
      }
    } catch (error) {
      if (aborted(options.signal)) return;
    } finally {
      options.signal.removeEventListener("abort", abortAttempt);
      attemptController.abort();
      if (response && !responseDisposed) {
        await cancelResponseBody(response);
        responseDisposed = true;
      }
    }
    if (options.signal.aborted) return;
    await sleep(delayMs, options.signal);
    delayMs = Math.min(delayMs * 2, 10_000);
  }
}
