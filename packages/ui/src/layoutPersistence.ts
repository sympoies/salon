import type { LayoutOrderResult, PutLayoutOrderOptions } from "./api.ts";
import {
  layoutOrderChanged,
  mergeLayoutOrderPreservingRemote,
  mergeLayoutOrderWithLocalPrefix,
  mergeLayoutOrderWithReachability,
} from "./layoutOrder.ts";

export interface LayoutStoreSnapshot {
  readonly order: string[];
  readonly revision: number | null;
}

export interface LayoutPersistIntent {
  readonly localOrder: readonly string[];
  readonly liveKeys: ReadonlySet<string>;
  readonly reachableMachines: ReadonlySet<string>;
  readonly reason: string;
  readonly localOrderPlacement?: boolean;
  readonly keepalive?: boolean;
  readonly urgent?: boolean;
  readonly removedKeys?: ReadonlySet<string>;
}

export type LayoutOrderWriter = (
  order: readonly string[],
  options?: PutLayoutOrderOptions,
) => Promise<LayoutOrderResult>;

export interface LayoutPersistResult {
  readonly reachable: boolean;
  readonly snapshot?: LayoutStoreSnapshot;
  readonly conflict?: boolean;
}

const MAX_CONFLICT_RETRIES = 2;

function mergeLayoutForIntent(
  previous: readonly string[],
  intent: LayoutPersistIntent,
  knownMachines: ReadonlySet<string>,
): string[] {
  // A successful session-list response can still briefly omit a live session.
  // Only an explicit close proves removal from the shared ranking.
  const retained = intent.removedKeys?.size
    ? previous.filter((key) => !intent.removedKeys!.has(key))
    : previous;
  const hasTemporarilyMissingKey = retained.some((key) => !intent.liveKeys.has(key));
  const merge = intent.localOrderPlacement
    ? intent.reason === "create" || !hasTemporarilyMissingKey
      ? mergeLayoutOrderWithLocalPrefix
      : mergeLayoutOrderWithReachability
    : mergeLayoutOrderPreservingRemote;
  const order = merge(retained, intent.localOrder, intent.liveKeys, new Set(), undefined, knownMachines);
  if (intent.reason !== "create" || !intent.localOrderPlacement || !hasTemporarilyMissingKey) {
    return order;
  }
  // A slot create replaces one visible slot, so its local order omits that
  // displaced session. Preserve the chosen slot, then restore absent ranked
  // keys before their next surviving neighbor instead of sending them to tail.
  const missing = retained.filter((key) => !intent.liveKeys.has(key) && order.includes(key));
  const result = order.filter((key) => !missing.includes(key));
  for (const key of missing) {
    const index = retained.indexOf(key);
    const next = retained.slice(index + 1).find((candidate) => result.includes(candidate));
    const insertion = next ? result.indexOf(next) : result.length;
    result.splice(insertion, 0, key);
  }
  return result;
}

export async function persistLayoutIntent(args: {
  readonly previous: LayoutStoreSnapshot;
  readonly intent: LayoutPersistIntent;
  readonly knownMachines: ReadonlySet<string>;
  readonly putLayoutOrder: LayoutOrderWriter;
  readonly shouldRetry?: () => boolean;
}): Promise<LayoutPersistResult> {
  let snapshot = args.previous;
  let order = mergeLayoutForIntent(snapshot.order, args.intent, args.knownMachines);
  if (!layoutOrderChanged(order, snapshot.order)) {
    return { reachable: true, snapshot: args.previous };
  }

  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    const result = await args.putLayoutOrder(order, {
      baseRevision: snapshot.revision,
      reason: attempt === 0 ? args.intent.reason : `${args.intent.reason}:retry`,
      keepalive: args.intent.keepalive,
    });
    if (!result.reachable) {
      return { reachable: false };
    }
    const nextSnapshot = { order: result.order, revision: result.revision };
    if (!result.conflict) {
      return { reachable: true, snapshot: nextSnapshot };
    }
    snapshot = nextSnapshot;
    if (args.shouldRetry && !args.shouldRetry()) {
      return { reachable: true, snapshot, conflict: true };
    }
    order = mergeLayoutForIntent(snapshot.order, args.intent, args.knownMachines);
    if (!layoutOrderChanged(order, snapshot.order)) {
      return { reachable: true, snapshot };
    }
  }
  return { reachable: true, snapshot, conflict: true };
}

export function createLayoutPersistQueue(args: {
  readonly isReachable: () => boolean;
  readonly setUnreachable: () => void;
  readonly getSnapshot: () => LayoutStoreSnapshot | null;
  readonly setSnapshot: (
    snapshot: LayoutStoreSnapshot,
    intent: LayoutPersistIntent,
    confirmed: boolean,
    knownMachines: ReadonlySet<string>,
  ) => void;
  readonly getKnownMachines: () => ReadonlySet<string>;
  readonly putLayoutOrder: LayoutOrderWriter;
}): { persist: (intent: LayoutPersistIntent) => Promise<void> } {
  let generation = 0;
  let queue = Promise.resolve();
  let completedSnapshot: LayoutStoreSnapshot | null = null;
  const persist = (intent: LayoutPersistIntent): Promise<void> => {
    const serial = ++generation;
    const frozenIntent: LayoutPersistIntent = {
      localOrder: [...intent.localOrder],
      liveKeys: new Set(intent.liveKeys),
      reachableMachines: new Set(intent.reachableMachines),
      reason: intent.reason,
      localOrderPlacement: intent.localOrderPlacement,
      keepalive: intent.keepalive,
      urgent: intent.urgent,
      removedKeys: intent.removedKeys ? new Set(intent.removedKeys) : undefined,
    };
    const run = async () => {
      if (serial !== generation) {
        return;
      }
      if (!args.isReachable()) {
        return;
      }
      // Capture when this intent runs, keeping one registry throughout its awaits.
      const knownMachines = new Set(args.getKnownMachines());
      const current = args.getSnapshot();
      const previous = completedSnapshot?.revision != null && (current?.revision ?? -1) < completedSnapshot.revision
        ? completedSnapshot : current;
      const result = await persistLayoutIntent({
        previous: previous ?? { order: [], revision: null },
        intent: frozenIntent,
        knownMachines,
        putLayoutOrder: args.putLayoutOrder,
        shouldRetry: () => serial === generation,
      });
      if (result.reachable && result.snapshot) completedSnapshot = result.snapshot;
      if (serial !== generation) {
        return;
      }
      if (!result.reachable) {
        args.setUnreachable();
        return;
      }
      if (result.snapshot) {
        args.setSnapshot(result.snapshot, frozenIntent, result.conflict !== true, knownMachines);
      }
    };
    const revisionedSnapshot = (args.getSnapshot()?.revision ?? null) !== null;
    if (frozenIntent.urgent && frozenIntent.reason === "flush" && revisionedSnapshot) {
      const next = run();
      queue = queue.catch(() => undefined).then(() => next).catch(() => undefined);
      return next;
    }
    const next = queue.catch(() => undefined).then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  return { persist };
}
