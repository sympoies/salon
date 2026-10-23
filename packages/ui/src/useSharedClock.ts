import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const idleSubscribe = () => () => {};
let currentNowMs = Date.now();
let intervalId: number | null = null;

function tick(): void {
  currentNowMs = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    currentNowMs = Date.now();
    intervalId = window.setInterval(tick, 1_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function snapshot(): number {
  return currentNowMs;
}

export function useSharedClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idleSubscribe, snapshot, snapshot);
}
