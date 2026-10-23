interface Consumer {
  readonly queue: string[];
  bytes: number;
  ended: boolean;
  error?: Error;
  readonly onFailure?: () => void;
  wake: () => void;
}
interface Source {
  readonly controller: AbortController;
  readonly consumers: Set<Consumer>;
}

// Shared producer, bounded independent subscriber queues. A slow subscriber is
// disconnected instead of blocking the producer or retaining another user's
// events indefinitely. No snapshot cache crosses runtime incarnations.
export class SharedStreamRegistry {
  readonly #sources = new Map<string, Source>();
  async *subscribe(key: string, start: (signal: AbortSignal, emit: (chunk: string) => void) => Promise<void>,
    signal: AbortSignal, onFailure?: () => void): AsyncGenerator<string> {
    if (signal.aborted) return;
    let source = this.#sources.get(key);
    if (!source) {
      source = { controller: new AbortController(), consumers: new Set() };
      this.#sources.set(key, source);
      const captured = source;
      void Promise.resolve().then(() => start(captured.controller.signal, (chunk) => {
        const bytes = Buffer.byteLength(chunk);
        for (const consumer of captured.consumers) {
          if (consumer.ended) continue;
          if (consumer.queue.length >= 64 || consumer.bytes + bytes > 8 * 1024 * 1024) {
            consumer.ended = true;
            consumer.error = new Error("activity subscriber capacity reached");
            consumer.queue.length = 0;
            consumer.bytes = 0;
            consumer.onFailure?.();
          } else { consumer.queue.push(chunk); consumer.bytes += bytes; }
          consumer.wake();
        }
      })).catch(() => {
        for (const consumer of captured.consumers) {
          consumer.error = new Error("shared activity producer failed");
          consumer.onFailure?.();
        }
      }).finally(() => {
        for (const consumer of captured.consumers) { consumer.ended = true; consumer.wake(); }
      });
    }
    const captured = source;
    const consumer: Consumer = { queue: [], bytes: 0, ended: false, wake: () => {}, onFailure };
    const abort = () => { consumer.ended = true; consumer.wake(); };
    signal.addEventListener("abort", abort, { once: true });
    captured.consumers.add(consumer);
    try {
      while (!consumer.ended) {
        if (consumer.queue.length === 0) {
          await new Promise<void>((resolve) => { consumer.wake = resolve; });
          continue;
        }
        const chunk = consumer.queue.shift()!;
        consumer.bytes -= Buffer.byteLength(chunk);
        yield chunk;
      }
      if (consumer.error) throw consumer.error;
    } finally {
      signal.removeEventListener("abort", abort);
      captured.consumers.delete(consumer);
      if (captured.consumers.size === 0) {
        captured.controller.abort();
        if (this.#sources.get(key) === captured) this.#sources.delete(key);
      }
    }
  }
  close(): void {
    for (const source of this.#sources.values()) {
      source.controller.abort();
      for (const consumer of source.consumers) { consumer.ended = true; consumer.wake(); }
    }
    this.#sources.clear();
  }
}
