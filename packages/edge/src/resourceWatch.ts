import { normalizeConversationSnapshot, type ConversationSnapshot } from "@agent-console/shared/resources";
import { createHash } from "node:crypto";

// Keep only a digest. Callers select semantic fields before observation.
export function resourceFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}
export interface ResourceObservation { readonly changed: boolean; readonly revision: number; readonly available: boolean; readonly value?: ConversationSnapshot }
interface Watch {
  readonly listeners: Map<(event: ResourceObservation) => void, boolean>;
  readonly controller: AbortController;
  timer?: NodeJS.Timeout;
  digest?: string;
  revision: number;
  latest?: ResourceObservation;
}

// One source read at a time, shared by equivalent subscriptions. A bounded
// conversation page is delivered with its observation, never cached for replay.
// Late subscribers reconcile through HTTP; last subscriber owns teardown.
export class ResourceWatchRegistry {
  readonly #watches = new Map<string, Watch>();
  readonly schedule: typeof setTimeout;
  readonly cancel: typeof clearTimeout;
  constructor(schedule: typeof setTimeout = setTimeout, cancel: typeof clearTimeout = clearTimeout) {
    this.schedule = schedule;
    this.cancel = cancel;
  }
  hasCapacity(keys: readonly string[]): boolean {
    return this.#watches.size + [...new Set(keys)].filter((key) => !this.#watches.has(key)).length <= 256;
  }
  subscribe(key: string, load: (signal: AbortSignal) => Promise<unknown>, delayMs: number,
    listener: (event: ResourceObservation) => void, includeConversation = false): () => void {
    let watch = this.#watches.get(key);
    if (!watch) {
      if (this.#watches.size >= 256) throw new Error("resource watch capacity reached");
      watch = { listeners: new Map(), controller: new AbortController(), revision: 0 };
      this.#watches.set(key, watch);
      const captured = watch;
      const run = async () => {
        let available = true;
        let changed = false;
        let snapshot: ConversationSnapshot | undefined;
        try {
          const value = await load(captured.controller.signal);
          const digest = resourceFingerprint(value);
          changed = digest !== captured.digest || captured.latest?.available === false;
          if (changed) {
            captured.digest = digest; captured.revision += 1;
            if ([...captured.listeners.values()].some(Boolean)) snapshot = normalizeConversationSnapshot(value);
          }
        } catch { available = false; }
        if (captured.controller.signal.aborted) return;
        captured.latest = { available, changed, revision: captured.revision };
        const observation = { ...captured.latest, ...(available && changed && snapshot ? { value: snapshot } : {}) };
        for (const [notify, wantsSnapshot] of captured.listeners) notify(wantsSnapshot ? observation : captured.latest);
        captured.timer = this.schedule(() => void run(), delayMs);
        captured.timer.unref();
      };
      // Let the initiating subscriber register before the first observation.
      void Promise.resolve().then(run);
    }
    const captured = watch;
    captured.listeners.set(listener, includeConversation);
    // A cached page could predate the new reader's initial HTTP result.
    if (captured.latest) listener({ ...captured.latest, changed: captured.latest.available });
    return () => {
      captured.listeners.delete(listener);
      if (captured.listeners.size !== 0) return;
      captured.controller.abort();
      this.cancel(captured.timer);
      if (this.#watches.get(key) === captured) this.#watches.delete(key);
    };
  }
  close(): void {
    for (const watch of this.#watches.values()) { watch.controller.abort(); this.cancel(watch.timer); }
    this.#watches.clear();
  }
}
