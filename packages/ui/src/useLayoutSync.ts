import { resourceEvents, RESOURCE_RECONCILE_MS } from "./resourceEvents.ts";
import { createAsyncPoller, type AsyncPoller } from "./useAsyncPoll.ts";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fetchLayoutOrder, putLayoutOrder } from "./api.ts";
import {
  completeLayoutOrder,
  layoutOrderChanged,
  mergeLayoutOrderWithReachability,
  seedSlotsFromOrder,
} from "./layoutOrder.ts";
import { createLayoutPersistQueue, type LayoutStoreSnapshot, type LayoutPersistIntent } from "./layoutPersistence.ts";
import { sessionKey, slotsEqual, type SlotKey } from "./layout.ts";
import type { TimerHandle } from "./scheduler.ts";
import type { Session } from "./types.ts";

const LAYOUT_PUT_DEBOUNCE_MS = 800;
const LAYOUT_REFRESH_INTERVAL_MS = 5_000;

interface PersistLayoutOptions {
  readonly localOrderPlacement?: boolean;
  readonly keepalive?: boolean;
  readonly urgent?: boolean;
  readonly removedKeys?: ReadonlySet<string>;
}

interface PendingLayoutApplication {
  readonly order: readonly string[];
  readonly reason: string;
  readonly generation: number;
  inFlight: boolean;
  settledSnapshot: LayoutStoreSnapshot | null;
}

interface UseLayoutSyncOptions {
  // No slot input by design: the shared ranking must not depend on this device's
  // grid shape, so the hook reads the session list and the store, never `slots`.
  readonly sessions: readonly Session[];
  readonly visible: readonly Session[];
  readonly slotCount: number;
  readonly reachableMachineNames: ReadonlySet<string>;
  readonly getKnownMachineNames: () => ReadonlySet<string>;
  readonly setSlots: Dispatch<SetStateAction<SlotKey[]>>;
}

export interface UseLayoutSyncResult {
  readonly orderedSessionKeys: readonly string[];
  readonly applyLayoutLocalOrder: (
    localOrder: readonly string[],
    reason: string,
  ) => Promise<void> | undefined;
  readonly persistLayoutLocalOrder: (
    localOrder: readonly string[],
    liveKeys: ReadonlySet<string>,
    reachableMachines: ReadonlySet<string>,
    reason: string,
    options?: PersistLayoutOptions,
  ) => Promise<void> | undefined;
  readonly cancelPendingLayoutDebounce: () => void;
}

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(key => right.has(key));
}

function snapshotIsNewer(candidate: LayoutStoreSnapshot, current: LayoutStoreSnapshot | null): boolean {
  if (current === null) {
    return true;
  }
  if (candidate.revision !== null && current.revision !== null) {
    return candidate.revision > current.revision;
  }
  if (candidate.revision !== null) {
    return true;
  }
  if (current.revision !== null) {
    return false;
  }
  return layoutOrderChanged(candidate.order, current.order);
}

function snapshotIsNotOlder(candidate: LayoutStoreSnapshot, current: LayoutStoreSnapshot | null): boolean {
  if (current === null) {
    return true;
  }
  if (candidate.revision !== null && current.revision !== null) {
    return candidate.revision >= current.revision;
  }
  if (candidate.revision !== null) {
    return true;
  }
  return current.revision === null;
}

export function useLayoutSync({
  sessions,
  visible,
  slotCount,
  reachableMachineNames,
  getKnownMachineNames,
  setSlots,
}: UseLayoutSyncOptions): UseLayoutSyncResult {
  const [serverLayoutOrder, setServerLayoutOrder] = useState<LayoutStoreSnapshot | null>(null);
  const [lastSentLayoutOrder, setLastSentLayoutOrder] = useState<LayoutStoreSnapshot | null>(null);
  const [optimisticLayoutOrder, setOptimisticLayoutOrder] = useState<readonly string[] | null>(null);
  const [layoutSyncArmed, setLayoutSyncArmed] = useState(false);
  const [layoutReachable, setLayoutReachable] = useState(false);
  const [layoutRetryVersion, setLayoutRetryVersion] = useState(0);
  const layoutReachableRef = useRef(false);
  const layoutSyncArmedRef = useRef(false);
  const optimisticLayoutOrderRef = useRef<readonly string[] | null>(null);
  const lastSentLayoutOrderRef = useRef<LayoutStoreSnapshot | null>(null);
  const layoutPutTimerRef = useRef<TimerHandle | null>(null);
  const sessionsRef = useRef(sessions);
  const visibleRef = useRef(visible);
  const slotCountRef = useRef(slotCount);
  const reachableMachineNamesRef = useRef(reachableMachineNames);
  const getKnownMachineNamesRef = useRef(getKnownMachineNames);
  const layoutPersistQueueRef = useRef<ReturnType<typeof createLayoutPersistQueue> | null>(null);
  const pendingLayoutApplicationRef = useRef<PendingLayoutApplication | null>(null);
  const passiveConflictRef = useRef<{
    snapshot: LayoutStoreSnapshot;
    intent: LayoutPersistIntent;
    knownMachines: ReadonlySet<string>;
  } | null>(null);
  const layoutApplicationGenerationRef = useRef(0);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    slotCountRef.current = slotCount;
  }, [slotCount]);

  useEffect(() => {
    reachableMachineNamesRef.current = reachableMachineNames;
  }, [reachableMachineNames]);

  useEffect(() => {
    getKnownMachineNamesRef.current = getKnownMachineNames;
  }, [getKnownMachineNames]);

  const acceptLayoutSnapshot = useCallback((
    snapshot: LayoutStoreSnapshot,
    source: "remote-refresh" | "passive-write" | "explicit-write",
  ) => {
    const current = lastSentLayoutOrderRef.current;
    const accepted = source === "remote-refresh"
      ? snapshotIsNewer(snapshot, current)
      : snapshotIsNotOlder(snapshot, current);
    const explicitWriteConfirmed = source === "explicit-write";
    if (!accepted && !explicitWriteConfirmed) return false;
    // A successful older write finishes its intent; retain newer observed state.
    if (!accepted) snapshot = current!;
    const mayReseed = explicitWriteConfirmed || optimisticLayoutOrderRef.current === null;
    lastSentLayoutOrderRef.current = snapshot;
    setLastSentLayoutOrder(snapshot);
    setServerLayoutOrder(snapshot);
    if (explicitWriteConfirmed) {
      pendingLayoutApplicationRef.current = null;
      optimisticLayoutOrderRef.current = null;
      setOptimisticLayoutOrder(null);
    }
    if (layoutSyncArmedRef.current && mayReseed) {
      const complete = completeLayoutOrder(snapshot.order, visibleRef.current.map(sessionKey));
      setSlots((currentSlots) => {
        const seeded = seedSlotsFromOrder(complete, visibleRef.current, slotCountRef.current);
        return slotsEqual(currentSlots, seeded) ? currentSlots : seeded;
      });
    }
    return accepted;
  }, [setSlots]);

  if (layoutPersistQueueRef.current === null) {
    layoutPersistQueueRef.current = createLayoutPersistQueue({
      isReachable: () => layoutReachableRef.current,
      setUnreachable: () => {
        passiveConflictRef.current = null;
        layoutReachableRef.current = false;
        setLayoutReachable(false);
      },
      getSnapshot: () => lastSentLayoutOrderRef.current,
      setSnapshot: (snapshot, intent, confirmed, knownMachines) => {
        const pending = pendingLayoutApplicationRef.current;
        if (intent.localOrderPlacement && pending?.inFlight) pending.settledSnapshot = snapshot;
        if (confirmed) passiveConflictRef.current = null;
        else if (!intent.localOrderPlacement) {
          passiveConflictRef.current = {snapshot, intent, knownMachines};
        }
        const source = intent.localOrderPlacement && confirmed
          ? "explicit-write"
          : "passive-write";
        acceptLayoutSnapshot(snapshot, source);
      },
      getKnownMachines: () => getKnownMachineNamesRef.current(),
      putLayoutOrder,
    });
  }

  useEffect(() => {
    let cancelled = false;
    let refreshInFlight = false;
    let refreshPending = false;
    const refreshLayoutOrder = async () => {
      if (refreshInFlight) {
        refreshPending = true;
        return;
      }
      refreshInFlight = true;
      try {
        do {
          refreshPending = false;
          const result = await fetchLayoutOrder().catch(() => null);
          if (cancelled) {
            return;
          }
          if (result === null) {
            continue;
          }
          if (!result.reachable) {
            passiveConflictRef.current = null;
            layoutReachableRef.current = false;
            setLayoutReachable(false);
            continue;
          }
          const snapshot = { order: result.order, revision: result.revision };
          layoutReachableRef.current = true;
          setLayoutReachable(true);
          const progressed = acceptLayoutSnapshot(snapshot, "remote-refresh");
          const pending = pendingLayoutApplicationRef.current;
          if (progressed && pending !== null && !pending.inFlight) {
            setLayoutRetryVersion((version) => version + 1);
          }
        } while (refreshPending);
      } finally {
        refreshInFlight = false;
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") {
        void refreshLayoutOrder();
      }
    };

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    let resourceHealthy = false;
    let poller: AsyncPoller | undefined;
    const stopEvents = resourceEvents.subscribe({ resource: "layout" }, refreshWhenVisible, (healthy) => {
      const disconnected = resourceHealthy && !healthy;
      resourceHealthy = healthy;
      if (disconnected) { poller?.stop(); poller?.start(); }
    });
    poller = createAsyncPoller({ delayMs: () => resourceHealthy ? RESOURCE_RECONCILE_MS : LAYOUT_REFRESH_INTERVAL_MS,
      task: async () => { if (document.visibilityState !== "hidden") await refreshLayoutOrder(); },
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      clearTimeout: (timer) => window.clearTimeout(timer) });
    poller.start();
    return () => {
      cancelled = true;
      stopEvents();
      poller?.stop();
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [acceptLayoutSnapshot]);

  // The ranking this device currently believes in, and the complete order that
  // ranking implies once the sessions it does not cover are appended in the
  // default order. Every device derives the same complete order from the same
  // (ranking, session list) pair — the local grid never contributes to it.
  const currentRanking = useMemo(
    () => optimisticLayoutOrder ?? lastSentLayoutOrder?.order ?? serverLayoutOrder?.order ?? [],
    [lastSentLayoutOrder, optimisticLayoutOrder, serverLayoutOrder],
  );
  const completeOrder = useMemo(
    () => completeLayoutOrder(currentRanking, visible.map(sessionKey)),
    [currentRanking, visible],
  );
  const completeOrderRef = useRef(completeOrder);

  useEffect(() => {
    completeOrderRef.current = completeOrder;
  }, [completeOrder]);

  useEffect(() => {
    if (serverLayoutOrder === null || layoutSyncArmed || visible.length === 0) {
      return;
    }
    const seedOrder = completeOrder;
    if (seedOrder.length > 0) {
      setSlots((prev) => {
        const seeded = seedSlotsFromOrder(seedOrder, visible, slotCount);
        return slotsEqual(prev, seeded) ? prev : seeded;
      });
    }
    layoutSyncArmedRef.current = true;
    setLayoutSyncArmed(true);
  }, [serverLayoutOrder, visible, slotCount, completeOrder, layoutSyncArmed, setSlots]);

  const persistLayoutLocalOrder = useCallback(
    (
      localOrder: readonly string[],
      liveKeys: ReadonlySet<string>,
      reachableMachines: ReadonlySet<string>,
      reason: string,
      options: PersistLayoutOptions = {},
    ) => {
      if (!layoutReachableRef.current) {
        return;
      }
      return layoutPersistQueueRef.current?.persist({
        localOrder,
        liveKeys,
        reachableMachines,
        reason,
        localOrderPlacement: options.localOrderPlacement,
        keepalive: options.keepalive,
        urgent: options.urgent,
        removedKeys: options.removedKeys,
      });
    },
    [],
  );

  const cancelPendingLayoutDebounce = useCallback(() => {
    if (layoutPutTimerRef.current) {
      clearTimeout(layoutPutTimerRef.current);
      layoutPutTimerRef.current = null;
    }
  }, []);

  const persistPendingLayoutApplication = useCallback((pending: PendingLayoutApplication) => {
    if (
      pendingLayoutApplicationRef.current?.generation !== pending.generation
      || pending.inFlight
      || !layoutReachableRef.current
    ) {
      return;
    }
    pending.settledSnapshot = lastSentLayoutOrderRef.current;
    pending.inFlight = true;
    const persistence = persistLayoutLocalOrder(
      pending.order,
      new Set(sessionsRef.current.map(sessionKey)),
      reachableMachineNamesRef.current,
      pending.reason,
      { localOrderPlacement: true },
    );
    if (persistence === undefined) {
      pending.inFlight = false;
      return;
    }
    return persistence.finally(() => {
      if (pendingLayoutApplicationRef.current?.generation === pending.generation) {
        pending.inFlight = false;
        const current = lastSentLayoutOrderRef.current;
        if (current && snapshotIsNewer(current, pending.settledSnapshot)) {
          setLayoutRetryVersion(version => version + 1);
        }
      }
    });
  }, [persistLayoutLocalOrder]);

  const applyLayoutLocalOrder = useCallback(
    (localOrder: readonly string[], reason: string) => {
      const nextOrder = [...localOrder];
      optimisticLayoutOrderRef.current = nextOrder;
      setOptimisticLayoutOrder(nextOrder);
      setSlots(seedSlotsFromOrder(nextOrder, visibleRef.current, slotCountRef.current));
      const pending: PendingLayoutApplication = {
        order: nextOrder,
        reason,
        generation: ++layoutApplicationGenerationRef.current,
        inFlight: false,
        settledSnapshot: lastSentLayoutOrderRef.current,
      };
      pendingLayoutApplicationRef.current = pending;
      return persistPendingLayoutApplication(pending);
    },
    [persistPendingLayoutApplication, setSlots],
  );

  useEffect(() => {
    if (!layoutSyncArmed || !layoutReachableRef.current) {
      return;
    }
    const pending = pendingLayoutApplicationRef.current;
    if (pending === null) {
      return;
    }
    void persistPendingLayoutApplication(pending);
  }, [layoutReachable, layoutRetryVersion, layoutSyncArmed, persistPendingLayoutApplication]);

  const persistLayoutPlacement = useCallback(
    (
      nextSessions: readonly Session[],
      reason: string,
      options?: Pick<PersistLayoutOptions, "keepalive" | "urgent">,
    ) => {
      const liveKeys = new Set(nextSessions.map(sessionKey));
      return persistLayoutLocalOrder(
        completeOrderRef.current,
        liveKeys,
        reachableMachineNamesRef.current,
        reason,
        options,
      );
    },
    [persistLayoutLocalOrder],
  );

  useEffect(() => {
    if (!layoutReachableRef.current || !layoutSyncArmed) {
      return;
    }
    if (pendingLayoutApplicationRef.current !== null) {
      if (layoutPutTimerRef.current) {
        clearTimeout(layoutPutTimerRef.current);
        layoutPutTimerRef.current = null;
      }
      return;
    }
    const previous = lastSentLayoutOrderRef.current;
    const liveKeys = new Set(sessions.map(sessionKey));
    const conflict = passiveConflictRef.current;
    // An identical snapshot or a parent re-render is not a new reconciliation.
    // Keep the exhausted intent until its store/input context actually changes.
    if (conflict && previous
      && conflict.snapshot.revision === previous.revision
      && !layoutOrderChanged(conflict.snapshot.order, previous.order)
      && !layoutOrderChanged(conflict.intent.localOrder, completeOrder)
      && sameKeys(conflict.intent.liveKeys, liveKeys)
      && sameKeys(conflict.intent.reachableMachines, reachableMachineNames)
      && sameKeys(conflict.knownMachines, getKnownMachineNamesRef.current())) {
      cancelPendingLayoutDebounce();
      return;
    }
    passiveConflictRef.current = null;
    // Missing sessions are hidden from the grid, but an ordinary poll must not
    // publish their removal. The ranking itself keeps them until explicit close.
    if (previous && !layoutOrderChanged(completeOrder, previous.order)) {
      return;
    }
    if (layoutPutTimerRef.current) {
      clearTimeout(layoutPutTimerRef.current);
    }
    layoutPutTimerRef.current = setTimeout(() => {
      layoutPutTimerRef.current = null;
      void persistLayoutLocalOrder(
        completeOrder,
        liveKeys,
        reachableMachineNames,
        "reorder",
      );
    }, LAYOUT_PUT_DEBOUNCE_MS);
  }, [completeOrder, sessions, reachableMachineNames, layoutReachable, layoutSyncArmed, persistLayoutLocalOrder, cancelPendingLayoutDebounce]);

  useEffect(() => {
    const flushPendingLayout = () => {
      if (layoutPutTimerRef.current) {
        clearTimeout(layoutPutTimerRef.current);
        layoutPutTimerRef.current = null;
        void persistLayoutPlacement(sessionsRef.current, "flush", {
          keepalive: true,
          urgent: true,
        });
      }
    };
    window.addEventListener("pagehide", flushPendingLayout);
    document.addEventListener("visibilitychange", flushPendingLayout);
    return () => {
      window.removeEventListener("pagehide", flushPendingLayout);
      document.removeEventListener("visibilitychange", flushPendingLayout);
      flushPendingLayout();
    };
  }, [persistLayoutPlacement]);

  const orderedSessionKeys = useMemo(
    () => mergeLayoutOrderWithReachability(
      currentRanking,
      completeOrder,
      new Set(sessions.map(sessionKey)),
      reachableMachineNames,
      undefined,
      getKnownMachineNamesRef.current(),
    ),
    [completeOrder, currentRanking, reachableMachineNames, sessions],
  );

  return {
    orderedSessionKeys,
    applyLayoutLocalOrder,
    persistLayoutLocalOrder,
    cancelPendingLayoutDebounce,
  };
}
