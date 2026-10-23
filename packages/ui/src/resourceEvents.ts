import { resourceKey, ResourceSseDecoder, type ResourceSubscription } from "@agent-console/shared/resources";
import { runSseStream, type SseStreamOptions } from "./sseStream.ts";
import type { ResourceEvent } from "@agent-console/shared/resources";

interface Listener {
  readonly subscription: ResourceSubscription;
  readonly onChanged: (event?: ResourceEvent) => void;
  readonly onHealth: (healthy: boolean) => void;
  healthy: boolean;
}

// One multiplex per UI runtime. Adding/removing a panel replaces its generation;
// stale frames cannot update subscriptions or their reconciliation callbacks.
export function createResourceEvents(run: (options: SseStreamOptions<ResourceEvent>) => Promise<void> = runSseStream) {
  const listeners = new Set<Listener>();
  let controller: AbortController | undefined;
  const setHealth = (listener: Listener, healthy: boolean) => {
    if (listener.healthy === healthy) return;
    listener.healthy = healthy;
    listener.onHealth(healthy);
  };
  const restart = () => {
    controller?.abort();
    for (const listener of listeners) setHealth(listener, false);
    if (listeners.size === 0 || (typeof document !== "undefined" && document.visibilityState === "hidden")
      || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    const next = new AbortController();
    controller = next;
    const resources = new Set<string>();
    const machines = new Set<string>();
    const conversations = new Map<string, { machine: string; id: string }>();
    for (const { subscription } of listeners) {
      if (subscription.resource === "conversation") {
        conversations.set(resourceKey(subscription), { machine: subscription.machine, id: subscription.id });
      } else {
        resources.add(subscription.resource);
        if (subscription.resource === "sessions") for (const machine of subscription.machines) machines.add(machine);
      }
    }
    const query = new URLSearchParams({ resources: [...resources].sort().join(","),
      machines: [...machines].sort().join(","), conversations: JSON.stringify([...conversations.values()]), conversation_snapshots: "1" });
    void run({ path: `/api/resources/events?${query}`, signal: next.signal, createDecoder: () => new ResourceSseDecoder(),
      onState: (state) => {
        if (next.signal.aborted || state === "connected") return;
        for (const listener of listeners) setHealth(listener, false);
      },
      onEvent: (event) => {
        if (next.signal.aborted) return;
        for (const listener of listeners) {
          if (resourceKey(listener.subscription) !== event.resource) continue;
          const previouslyHealthy = listener.healthy;
          setHealth(listener, event.type !== "unavailable");
          if (event.type === "changed" || (previouslyHealthy && event.type === "unavailable")) listener.onChanged(event);
        }
      },
    }).catch(() => {
      if (!next.signal.aborted) for (const listener of listeners) setHealth(listener, false);
    });
  };
  const wake = () => restart();
  return {
    subscribe(subscription: ResourceSubscription, onChanged: (event?: ResourceEvent) => void, onHealth: (healthy: boolean) => void): () => void {
      const listener = { subscription, onChanged, onHealth, healthy: false };
      if (listeners.size === 0 && typeof window !== "undefined") {
        window.addEventListener("online", wake);
        window.addEventListener("offline", wake);
        document.addEventListener("visibilitychange", wake);
      }
      listeners.add(listener);
      onHealth(false);
      restart();
      return () => {
        listeners.delete(listener);
        restart();
        if (listeners.size === 0 && typeof window !== "undefined") {
          window.removeEventListener("online", wake);
          window.removeEventListener("offline", wake);
          document.removeEventListener("visibilitychange", wake);
        }
      };
    },
  };
}
export const resourceEvents = createResourceEvents();
export const RESOURCE_RECONCILE_MS = 30_000;
