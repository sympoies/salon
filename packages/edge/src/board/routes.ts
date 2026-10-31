import { publicCoordinatorTree, publicDispatchedBy, type AccessStore, type SessionGrant } from "../accessStore.ts";
import { isRootPrincipal, type EdgeConfig, type PrincipalConfig } from "../config.ts";
import { buildBoardView, parseBoardQuery, type BoardView } from "./query.ts";
import type { BoardRecord } from "./record.ts";
import type { BoardService } from "./service.ts";

/**
 * The board view for one request, shared by the daemon relay route and the
 * console UI route. Throws `BoardQueryError` for invalid filters.
 *
 * In multi-user mode the view is scoped to `reader`, the principal the caller
 * acts for: the console's authenticated principal, or the principal that owns
 * a relay caller's session. It applies the console session list's rules:
 *
 * - only machines in the principal's `machines` allowlist, in the availability
 *   list and in the records; any other machine is not mentioned at all;
 * - only records whose session the access store grants to the principal, by
 *   the same `(machine, session_id)` grant `visibleSessions` in server.ts starts
 *   from. Ownership of a session id never moves between principals, so the
 *   board does not also match the incarnation, and it keeps the principal's
 *   closed sessions, which the live console list cannot show. A session with
 *   no grant cannot be attributed to anyone and is hidden on every machine,
 *   shared or not, just as the console list never shows it.
 *
 * The separate root principal sees all configured machines and all records,
 * including unowned sessions; it never changes the owner grants.
 *
 * Single-user mode has one operator and keeps the unscoped deployment view.
 */
export function boardViewForRequest(
  board: BoardService,
  config: EdgeConfig,
  accessStore: AccessStore | null,
  reader: PrincipalConfig | null,
  params: URLSearchParams,
  extraKeys: readonly string[] = [],
  includeAncestorContext = true,
  disabledMachines: ReadonlySet<string> = new Set(),
  viewerAccess: ((machine: string, sessionId: string) => boolean) | null = null,
  only: ((sessionId: string) => boolean) | null = null,
): BoardView {
  // Fail closed: a multi-user request must never fall back to the whole board.
  if (config.multiUser && (!reader || !accessStore)) throw new Error("board reader is required in multi-user mode");
  const query = parseBoardQuery(params, extraKeys);
  // Same registration as `/api/coordination/peers/v1`: only machines the edge
  // can relay to may report a session as able to receive a remote message.
  const messagingMachines = new Set(
    config.multiUser && accessStore ? (config.coordinationRelays ?? []).map((relay) => relay.machine) : [],
  );
  // One grant lookup per record serves the scope, the owner label, and the
  // dispatcher mark.
  const grants = new Map<string, SessionGrant | undefined>();
  const grantOf = (machine: string, sessionId: string): SessionGrant | undefined => {
    const key = JSON.stringify([machine, sessionId]);
    if (!grants.has(key)) grants.set(key, accessStore?.sessionGrant(machine, sessionId));
    return grants.get(key);
  };
  const ownerOf = accessStore
    ? (machine: string, sessionId: string) => grantOf(machine, sessionId)?.principalId ?? null
    : undefined;
  const machines = config.machines.filter(machine => machine.active !== false && !disabledMachines.has(machine.name)).map((machine) => machine.name);
  // The guard above makes reader and ownerOf present in multi-user mode; the
  // extra checks only narrow their types. Root is the explicit global reader.
  const scoped = config.multiUser && reader && ownerOf && !isRootPrincipal(reader)
    ? {
      machines: machines.filter((name) => reader.machines.includes(name)),
      include: (record: Pick<BoardRecord, "machine" | "session_id">) =>
        (only?.(record.session_id) ?? true)
        && (ownerOf(record.machine, record.session_id) === reader.id || viewerAccess?.(record.machine, record.session_id) === true),
    }
    : { machines };
  const view = buildBoardView({
    store: board.store,
    retention: board.retention,
    ...scoped,
    messagingMachines,
    ...(ownerOf ? { ownerOf } : {}),
    ...(accessStore
      ? {
        launcherOf: (machine: string, sessionId: string) => publicDispatchedBy(grantOf(machine, sessionId)?.launcher),
        dispatcherOf: (machine: string, sessionId: string) => publicDispatchedBy(grantOf(machine, sessionId)?.dispatcher),
        coordinatorTreeOf: (machine: string, sessionId: string, repoName: string | null) =>
          publicCoordinatorTree(accessStore.coordinatorTreeDepth(machine, sessionId, repoName, 0, grantOf)),
      }
      : {}),
    nowMs: board.now(),
    includeAncestorContext,
  }, query);
  return view;
}
