import { useEffect, useRef, useState } from "react";
import type { ResourceSubscription, ResourceEvent } from "@agent-console/shared/resources";
import { resourceEvents } from "./resourceEvents.ts";

export function useResourceEvents(subscription: ResourceSubscription | null, onChanged: (event?: ResourceEvent) => void): boolean {
  const [healthy, setHealthy] = useState(false);
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const key = JSON.stringify(subscription);
  useEffect(() => {
    setHealthy(false);
    if (!subscription) return;
    return resourceEvents.subscribe(subscription, (event) => callback.current(event), setHealthy);
  // Equivalent objects share one subscription despite render-time allocation.
  }, [key]);
  return healthy;
}
