import { useEffect, useId, useRef } from "react";
import { isTauri } from "./runtime.ts";

interface BackWindowState {
  readonly entries: string[];
  readonly labels: Map<string, string>;
  readonly retired: Set<string>;
  pendingCleanupPops: number;
}

const backWindowStates = new WeakMap<Window, BackWindowState>();
const internalCleanupEvents = new WeakSet<PopStateEvent>();
const eventEntryStacks = new WeakMap<PopStateEvent, readonly string[]>();

function backWindowState(targetWindow: Window): BackWindowState {
  const current = backWindowStates.get(targetWindow);
  if (current) return current;
  const created: BackWindowState = { entries: [], labels: new Map(), retired: new Set(), pendingCleanupPops: 0 };
  backWindowStates.set(targetWindow, created);
  // Keep retirement handling alive after a conditional dialog unmounts.
  targetWindow.addEventListener("popstate", (event) => {
    captureEntryStack(targetWindow, event);
    isInternalCleanupPop(targetWindow, event);
    const revealed = stateEntry(targetWindow, event.state);
    if (!revealed || !created.retired.has(revealed)) return;
    targetWindow.queueMicrotask(() => {
      if (!created.retired.has(revealed) || stateEntry(targetWindow, targetWindow.history.state) !== revealed) return;
      created.retired.delete(revealed);
      markEntryRemoved(targetWindow, revealed);
      created.labels.delete(revealed);
      beginCleanupPop(targetWindow);
      targetWindow.history.back();
    });
  });
  return created;
}

function markEntryPushed(targetWindow: Window, entry: string, label: string): void {
  const state = backWindowState(targetWindow);
  state.labels.set(entry, label);
  state.entries.push(entry);
}

function markEntryRemoved(targetWindow: Window, entry: string): void {
  const entries = backWindowState(targetWindow).entries;
  const index = entries.lastIndexOf(entry);
  if (index >= 0) entries.splice(index, 1);
}

function beginCleanupPop(targetWindow: Window): void {
  backWindowState(targetWindow).pendingCleanupPops += 1;
}

function isInternalCleanupPop(targetWindow: Window, event: PopStateEvent): boolean {
  if (internalCleanupEvents.has(event)) {
    return true;
  }
  const state = backWindowState(targetWindow);
  if (state.pendingCleanupPops === 0) {
    return false;
  }
  state.pendingCleanupPops -= 1;
  internalCleanupEvents.add(event);
  return true;
}

function stateEntry(targetWindow: Window, state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("agentConsoleBack" in state)) return null;
  const instance = (state as { readonly agentConsoleBackId?: unknown }).agentConsoleBackId;
  if (typeof instance === "string") return instance;
  const label = (state as { readonly agentConsoleBack?: unknown }).agentConsoleBack;
  // Legacy history states have only a label; new states always bind an instance.
  return [...backWindowState(targetWindow).labels].reverse().find(([, value]) => value === label)?.[0] ?? null;
}

function captureEntryStack(targetWindow: Window, event: PopStateEvent): readonly string[] {
  let stack = eventEntryStacks.get(event);
  if (!stack) {
    stack = [...backWindowState(targetWindow).entries];
    eventEntryStacks.set(event, stack);
  }
  return stack;
}

function entryWasPopped(targetWindow: Window, event: PopStateEvent, entry: string): boolean {
  const stack = captureEntryStack(targetWindow, event);
  const ownIndex = stack.lastIndexOf(entry);
  const target = stateEntry(targetWindow, event.state);
  const targetIndex = target === null ? -1 : stack.lastIndexOf(target);
  return ownIndex < 0 || targetIndex < ownIndex;
}

function isAndroidBackState(targetWindow: Window, state: unknown, entry: string): boolean {
  return stateEntry(targetWindow, state) === entry;
}

// On Android, the native shell routes hardware / gesture Back through WebView
// history. Each dismissible in-app layer pushes a keyed entry; when Back pops
// that entry, popstate runs the matching close action. Desktop-browser Back
// semantics stay untouched because this is gated to the Tauri app shell.
export function useAndroidBackEntry(label: string, active: boolean, onBack: () => boolean | void): void {
  const instanceId = useId();
  const entry = `${label}:${instanceId}`;
  const lifecycleRef = useRef(0);
  const pushedRef = useRef(false);
  const skipPopRef = useRef(false);
  const activeRef = useRef(active);
  const onBackRef = useRef(onBack);
  activeRef.current = active;
  onBackRef.current = onBack;

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const targetWindow = window;
    const lifecycle = ++lifecycleRef.current;
    backWindowState(targetWindow);
    const scheduleRevealedEntryCleanup = () => {
      pushedRef.current = false;
      markEntryRemoved(targetWindow, entry);
      skipPopRef.current = true;
      targetWindow.queueMicrotask(() => {
        if (!skipPopRef.current) return;
        if (activeRef.current) {
          skipPopRef.current = false;
          if (!pushedRef.current) {
            pushedRef.current = true;
            markEntryPushed(targetWindow, entry, label);
          }
          return;
        }
        beginCleanupPop(targetWindow);
        targetWindow.history.back();
      });
    };
    const onPop = (event: PopStateEvent) => {
      captureEntryStack(targetWindow, event);
      const internalCleanup = isInternalCleanupPop(targetWindow, event);
      if (internalCleanup) {
        let repairedOwnEntry = false;
        // Every layer ignores an in-app cleanup traversal. The owning layer
        // additionally repairs its entry if it reopened before popstate.
        if (skipPopRef.current) {
          skipPopRef.current = false;
          if (activeRef.current) {
            if (!isAndroidBackState(targetWindow, event.state, entry)) {
              targetWindow.history.pushState({ agentConsoleBack: label, agentConsoleBackId: entry }, "");
              repairedOwnEntry = true;
            }
            pushedRef.current = true;
          }
        }
        // A navigation can replace one layer with another in the same React
        // commit (for example, More menu -> Usage). The old layer's pending
        // cleanup traversal may then land below the newly pushed top entry.
        // Restore only that currently active top entry so the next Android Back
        // is still handled in-app instead of exiting the WebView.
        const topEntry = backWindowState(targetWindow).entries.at(-1);
        if (
          activeRef.current &&
          pushedRef.current &&
          !repairedOwnEntry &&
          topEntry === entry &&
          !isAndroidBackState(targetWindow, event.state, entry)
        ) {
          targetWindow.history.pushState({ agentConsoleBack: label, agentConsoleBackId: entry }, "");
        }
      }
      if (pushedRef.current && isAndroidBackState(targetWindow, event.state, entry)) {
        if (!activeRef.current) {
          scheduleRevealedEntryCleanup();
        }
        return;
      }
      if (internalCleanup || !pushedRef.current) {
        return;
      }
      if (activeRef.current && entryWasPopped(targetWindow, event, entry)) {
        pushedRef.current = false;
        markEntryRemoved(targetWindow, entry);
        if (onBackRef.current() === false) {
          // A busy layer can refuse dismissal; restore its Back target above
          // the underlying session so another Back cannot close that session.
          pushedRef.current = true;
          markEntryPushed(targetWindow, entry, label);
          targetWindow.history.pushState({ agentConsoleBack: label, agentConsoleBackId: entry }, "");
        }
      }
    };
    targetWindow.addEventListener("popstate", onPop);
    return () => {
      targetWindow.removeEventListener("popstate", onPop);
      // StrictMode replays effects. A new setup cancels this retirement.
      targetWindow.queueMicrotask(() => {
        if (lifecycleRef.current !== lifecycle) return;
        const state = backWindowState(targetWindow);
        if (!pushedRef.current) {
          state.labels.delete(entry);
          return;
        }
        pushedRef.current = false;
        if (isAndroidBackState(targetWindow, targetWindow.history.state, entry)) {
          markEntryRemoved(targetWindow, entry);
          state.labels.delete(entry);
          beginCleanupPop(targetWindow);
          targetWindow.history.back();
        } else {
          state.retired.add(entry);
        }
      });
    };
  }, [entry, label]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    if (active && !pushedRef.current) {
      pushedRef.current = true;
      markEntryPushed(window, entry, label);
      window.history.pushState({ agentConsoleBack: label, agentConsoleBackId: entry }, "");
    } else if (!active && pushedRef.current && isAndroidBackState(window, window.history.state, entry)) {
      // Closed in-app (not via Back): consume the entry we pushed.
      pushedRef.current = false;
      markEntryRemoved(window, entry);
      skipPopRef.current = true;
      beginCleanupPop(window);
      window.history.back();
    }
  }, [active, entry, label]);
}
